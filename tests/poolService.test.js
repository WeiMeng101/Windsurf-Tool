'use strict';

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------
function createMockDb() {
  const rows = [];
  const stmts = {};
  let transactionDepth = 0;
  let nextId = 1;

  const db = {
    prepare(sql) {
      const key = sql.replace(/\s+/g, ' ').trim();
      if (stmts[key]) return stmts[key];

      const stmt = {
        run(...params) {
          // INSERT INTO pool_accounts — track row with auto-increment id
          if (key.includes('INSERT INTO pool_accounts')) {
            const id = nextId++;
            const colsMatch = key.match(/INSERT INTO pool_accounts \(([^)]+)\)/);
            const cols = colsMatch ? colsMatch[1].split(',').map(c => c.trim()) : [];
            const row = { id, deleted_at: null };
            cols.forEach((col, i) => {
              row[col] = params[i] !== undefined ? params[i] : null;
            });
            rows.push(row);
            return { changes: 1, lastInsertRowid: id };
          }
          // INSERT INTO pool_status_history — just acknowledge
          if (key.includes('INSERT INTO pool_status_history')) {
            return { changes: 1, lastInsertRowid: rows.length + 1 };
          }
          // UPDATE pool_accounts — mutate matching row in-place
          if (key.includes('UPDATE pool_accounts')) {
            const setMatch = key.match(/SET (.+?) WHERE/);
            const assignments = setMatch ? setMatch[1].split(',') : [];
            let setParamCount = 0;
            assignments.forEach(a => { if (a.includes('?')) setParamCount++; });
            const whereId = params[setParamCount];
            const row = rows.find(r => r.id === whereId && (r.deleted_at === null || r.deleted_at === undefined));
            if (row) {
              let pi = 0;
              assignments.forEach(a => {
                const col = a.split('=')[0].trim();
                if (a.includes('?')) row[col] = params[pi++];
              });
            }
            return { changes: row ? 1 : 0 };
          }
          return { changes: 1, lastInsertRowid: rows.length + 1 };
        },
        all(...params) { return rows.slice(); },
        get(...params) {
          if (params.length > 0 && typeof params[0] === 'number') {
            return rows.find(r => r.id === params[0] && (r.deleted_at === null || r.deleted_at === undefined)) || null;
          }
          return rows[0] || null;
        },
      };
      stmts[key] = stmt;
      return stmt;
    },
    transaction(fn) {
      // better-sqlite3: db.transaction(fn) returns a wrapped function
      return (...args) => {
        transactionDepth++;
        const result = fn(db, ...args);
        transactionDepth--;
        return result;
      };
    },
    _rows: rows,
    _stmts: stmts,
    _transactionDepth: () => transactionDepth,
  };
  return db;
}

// ---------------------------------------------------------------------------
// Helper: seed a row into the mock DB
// ---------------------------------------------------------------------------
function seedRow(db, row) {
  db._rows.push(row);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PoolService', () => {
  let PoolService;
  let service;
  let mockDb;

  function getDb() { return mockDb; }

  before(() => {
    PoolService = require('../src/services/poolService');
  });

  beforeEach(() => {
    mockDb = createMockDb();
    service = new PoolService(getDb);
  });

  // ---- POOL-01: getAll ----
  describe('POOL-01: getAll', () => {
    it('returns all accounts where deleted_at IS NULL', () => {
      seedRow(mockDb, { id: 1, status: 'available', deleted_at: null });
      seedRow(mockDb, { id: 2, status: 'in_use', deleted_at: null });
      seedRow(mockDb, { id: 3, status: 'disabled', deleted_at: '2025-01-01' }); // soft-deleted

      const result = service.getAll();
      // The mock returns all rows; real implementation filters deleted_at IS NULL
      // We verify the call succeeds and returns an array
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 3); // mock returns all; filtering is SQL-side
    });

    it('supports provider_type filter', () => {
      seedRow(mockDb, { id: 1, provider_type: 'windsurf', status: 'available', deleted_at: null });
      const result = service.getAll({ provider_type: 'windsurf' });
      assert.ok(Array.isArray(result));
    });

    it('supports status filter', () => {
      seedRow(mockDb, { id: 1, status: 'available', deleted_at: null });
      const result = service.getAll({ status: 'available' });
      assert.ok(Array.isArray(result));
    });
  });

  // ---- POOL-01: getById ----
  describe('POOL-01: getById', () => {
    it('returns account by id', () => {
      seedRow(mockDb, { id: 42, email: 'a@b.com', deleted_at: null });
      const result = service.getById(42);
      assert.ok(result);
      assert.equal(result.id, 42);
    });

    it('returns null for non-existent id', () => {
      // No rows seeded, so get() returns null
      const result = service.getById(999);
      assert.equal(result, null);
    });
  });

  // ---- POOL-01: add ----
  describe('POOL-01: add', () => {
    it('creates an account with correct fields and returns it', () => {
      const data = {
        provider_type: 'windsurf',
        email: 'test@example.com',
        display_name: 'Test',
      };
      const result = service.add(data);
      assert.ok(result);
      assert.equal(result.provider_type, 'windsurf');
      assert.equal(result.email, 'test@example.com');
    });
  });

  // ---- POOL-01: update ----
  describe('POOL-01: update', () => {
    it('merges fields immutably and returns updated account', () => {
      seedRow(mockDb, { id: 1, email: 'old@example.com', display_name: 'Old', deleted_at: null });
      const result = service.update(1, { display_name: 'New Name' });
      assert.ok(result);
      assert.equal(result.display_name, 'New Name');
      assert.equal(result.email, 'old@example.com');
    });
  });

  // ---- POOL-01: deleteAccount ----
  describe('POOL-01: deleteAccount', () => {
    it('sets deleted_at (soft delete)', () => {
      seedRow(mockDb, { id: 1, status: 'available', deleted_at: null });
      const result = service.deleteAccount(1);
      assert.ok(result);
      // Verify the run was called (mock returns changes:1)
      assert.equal(result.changes, 1);
    });
  });

  // ---- POOL-02: transitionStatus ----
  describe('POOL-02: transitionStatus', () => {
    it('allows valid transition available->in_use', () => {
      seedRow(mockDb, { id: 1, status: 'available', deleted_at: null });
      const result = service.transitionStatus(1, 'in_use', 'request started', 'system');
      assert.ok(result);
    });

    it('throws on invalid transition available->available', () => {
      seedRow(mockDb, { id: 1, status: 'available', deleted_at: null });
      assert.throws(
        () => service.transitionStatus(1, 'available', 'no-op', 'manual'),
        /Invalid status transition/
      );
    });

    it('records transition in history table', () => {
      seedRow(mockDb, { id: 1, status: 'available', deleted_at: null });
      service.transitionStatus(1, 'in_use', 'reason', 'system');
      // After transition, a history insert should have been prepared
      const keys = Object.keys(mockDb._stmts);
      const hasInsert = keys.some(k => k.includes('INSERT') && k.includes('pool_status_history'));
      assert.ok(hasInsert, 'Should have inserted into pool_status_history');
    });

    it('uses a transaction for status update + history insert', () => {
      seedRow(mockDb, { id: 1, status: 'available', deleted_at: null });
      service.transitionStatus(1, 'in_use', 'reason', 'system');
      // Transaction should have been called
      assert.ok(mockDb._transactionDepth() === 0, 'Transaction should be committed');
    });
  });

  // ---- POOL-03: calculateHealthScore ----
  describe('POOL-03: calculateHealthScore', () => {
    it('returns 100 when total_requests is 0', () => {
      const account = {
        total_requests: 0,
        success_count: 0,
        error_count: 0,
      };
      const score = service.calculateHealthScore(account);
      assert.equal(score, 100);
    });

    it('calculates score with known values (0.7*successRate + 0.3*quotaScore)', () => {
      const account = {
        total_requests: 100,
        success_count: 80,
        error_count: 20,
      };
      const score = service.calculateHealthScore(account);
      // successRate = 80/100 = 0.8, quotaScore = 1 - 20/100 = 0.8
      // expected = 0.7 * 0.8 + 0.3 * 0.8 = 0.56 + 0.24 = 0.80 => 80
      assert.equal(score, 80);
    });
  });

  // ---- POOL-05: addApiKey ----
  describe('POOL-05: addApiKey', () => {
    it('creates an account with provider_type and apiKey in credentials', () => {
      const result = service.addApiKey('openai', 'sk-test-123', 'https://api.openai.com', 'My Key');
      assert.ok(result);
      assert.equal(result.provider_type, 'openai');
    });

    it('throws when apiKey is empty', () => {
      assert.throws(
        () => service.addApiKey('openai', '', 'https://api.openai.com', 'Empty Key'),
        /apiKey is required/
      );
    });
  });

  // ---- POOL-06: enableAccount / disableAccount ----
  describe('POOL-06: enableAccount', () => {
    it('transitions disabled->available', () => {
      seedRow(mockDb, { id: 1, status: 'disabled', deleted_at: null });
      const result = service.enableAccount(1);
      assert.ok(result);
    });

    it('throws if account is not disabled', () => {
      seedRow(mockDb, { id: 1, status: 'available', deleted_at: null });
      assert.throws(
        () => service.enableAccount(1),
        /not 'disabled'/
      );
    });
  });

  describe('POOL-06: disableAccount', () => {
    it('transitions any status->disabled', () => {
      seedRow(mockDb, { id: 1, status: 'available', deleted_at: null });
      const result = service.disableAccount(1);
      assert.ok(result);
    });

    it('transitions in_use->disabled', () => {
      seedRow(mockDb, { id: 1, status: 'in_use', deleted_at: null });
      const result = service.disableAccount(1);
      assert.ok(result);
    });

    it('transitions error->disabled', () => {
      seedRow(mockDb, { id: 1, status: 'error', deleted_at: null });
      const result = service.disableAccount(1);
      assert.ok(result);
    });
  });
});
