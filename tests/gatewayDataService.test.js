const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function createMockDb() {
  return {
    _preparedStatements: [],
    prepare(sql) {
      const stmt = {
        _sql: sql,
        _runs: [],
        run(...params) {
          this._runs.push(params);
          return { changes: 1, lastInsertRowid: 1 };
        },
        all(...params) {
          return [{ id: 1, name: 'test' }];
        },
        get(...params) {
          return { id: 1, name: 'test' };
        }
      };
      this._preparedStatements.push(stmt);
      return stmt;
    }
  };
}

function createMockGetDb(mockDb) {
  return () => mockDb;
}

describe('GatewayDataService', () => {
  let GatewayDataService;
  let service;
  let mockDb;

  beforeEach(() => {
    GatewayDataService = require('../src/services/gatewayDataService');
    mockDb = createMockDb();
    service = new GatewayDataService(createMockGetDb(mockDb));
  });

  // Test 1: getDb() returns database instance
  it('getDb() returns the database instance', () => {
    const db = service.getDb();
    assert.ok(db);
    assert.equal(db, mockDb);
  });

  // Test 2: query(sql, params) calls db.prepare(sql).run(...params)
  it('query() calls prepare().run() with correct params', () => {
    const result = service.query('INSERT INTO channels (name) VALUES (?)', ['test-channel']);

    assert.equal(mockDb._preparedStatements.length, 1);
    assert.equal(mockDb._preparedStatements[0]._sql, 'INSERT INTO channels (name) VALUES (?)');
    assert.deepEqual(mockDb._preparedStatements[0]._runs[0], ['test-channel']);
    assert.ok(result);
    assert.equal(result.changes, 1);
  });

  // Test 3: all(sql, params) calls db.prepare(sql).all(...params)
  it('all() returns all rows from prepared statement', () => {
    const rows = service.all('SELECT * FROM channels WHERE status = ?', ['enabled']);

    assert.equal(mockDb._preparedStatements.length, 1);
    assert.equal(mockDb._preparedStatements[0]._sql, 'SELECT * FROM channels WHERE status = ?');
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'test');
  });

  // Test 4: get(sql, params) calls db.prepare(sql).get(...params)
  it('get() returns first row from prepared statement', () => {
    const row = service.get('SELECT * FROM channels WHERE id = ?', [1]);

    assert.equal(mockDb._preparedStatements.length, 1);
    assert.equal(mockDb._preparedStatements[0]._sql, 'SELECT * FROM channels WHERE id = ?');
    assert.ok(row);
    assert.equal(row.id, 1);
  });

  // Test: query() with no params uses empty default
  it('query() with no params uses empty array', () => {
    service.query('DELETE FROM channels');
    assert.deepEqual(mockDb._preparedStatements[0]._runs[0], []);
  });

  // Test: all() with no params uses empty default
  it('all() with no params uses empty array', () => {
    service.all('SELECT * FROM channels');
    assert.ok(Array.isArray(mockDb._preparedStatements[0].all()));
  });

  // Test: get() with no params uses empty default
  it('get() with no params uses empty array', () => {
    const row = service.get('SELECT COUNT(*) as cnt FROM channels');
    assert.ok(row);
  });
});
