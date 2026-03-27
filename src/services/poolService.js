'use strict';

const VALID_TRANSITIONS = {
  available: ['in_use', 'error', 'cooldown', 'disabled'],
  in_use: ['available', 'error', 'cooldown', 'disabled'],
  error: ['available', 'cooldown', 'disabled'],
  cooldown: ['available', 'error', 'disabled'],
  disabled: ['available'],
};

class PoolService {
  /**
   * @param {() => import('better-sqlite3').Database} getDb
   */
  constructor(getDb) {
    this._getDb = getDb;
  }

  /**
   * Parse JSON fields (credentials, tags) from a raw DB row.
   * @param {object} row
   * @returns {object}
   */
  _parseRow(row) {
    if (!row) return null;
    return {
      ...row,
      credentials: typeof row.credentials === 'string'
        ? JSON.parse(row.credentials)
        : (row.credentials || {}),
      tags: typeof row.tags === 'string'
        ? JSON.parse(row.tags)
        : (row.tags || []),
    };
  }

  // ---- POOL-01: CRUD ----

  /**
   * Get all pool accounts, optionally filtered.
   * @param {{ provider_type?: string, status?: string }} [filters]
   * @returns {object[]}
   */
  getAll(filters = {}) {
    const db = this._getDb();
    const conditions = ['deleted_at IS NULL'];
    const params = [];

    if (filters.provider_type) {
      conditions.push('provider_type = ?');
      params.push(filters.provider_type);
    }
    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }

    const where = conditions.join(' AND ');
    const sql = `SELECT * FROM pool_accounts WHERE ${where} ORDER BY id`;
    const rows = db.prepare(sql).all(...params);
    return rows.map(r => this._parseRow(r));
  }

  /**
   * Get a single pool account by ID.
   * @param {number} id
   * @returns {object|null}
   */
  getById(id) {
    const db = this._getDb();
    const row = db.prepare(
      'SELECT * FROM pool_accounts WHERE id = ? AND deleted_at IS NULL'
    ).get(id);
    return this._parseRow(row);
  }

  /**
   * Add a new pool account.
   * @param {object} data
   * @returns {object} The created account row
   */
  add(data) {
    const db = this._getDb();
    const credentials = data.credentials
      ? JSON.stringify(data.credentials)
      : '{}';
    const tags = data.tags
      ? JSON.stringify(data.tags)
      : '[]';

    const stmt = db.prepare(`
      INSERT INTO pool_accounts (provider_type, email, display_name, status, credentials,
        health_score, success_count, error_count, total_requests, last_used_at,
        last_error, cooldown_until, tags, remark, source, source_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      data.provider_type || 'windsurf',
      data.email || '',
      data.display_name || '',
      data.status || 'available',
      credentials,
      data.health_score ?? 100.0,
      data.success_count ?? 0,
      data.error_count ?? 0,
      data.total_requests ?? 0,
      data.last_used_at || null,
      data.last_error || '',
      data.cooldown_until || null,
      tags,
      data.remark || '',
      data.source || 'manual',
      data.source_ref || ''
    );

    return this.getById(result.lastInsertRowid);
  }

  /**
   * Update an existing pool account (immutable merge).
   * @param {number} id
   * @param {object} updates
   * @returns {object|null}
   */
  update(id, updates) {
    const db = this._getDb();
    const existing = this.getById(id);
    if (!existing) return null;

    const merged = { ...existing, ...updates, updated_at: new Date().toISOString() };

    // Serialize JSON fields back
    const credentials = typeof merged.credentials === 'string'
      ? merged.credentials
      : JSON.stringify(merged.credentials || {});
    const tags = typeof merged.tags === 'string'
      ? merged.tags
      : JSON.stringify(merged.tags || []);

    db.prepare(`
      UPDATE pool_accounts SET
        provider_type = ?, email = ?, display_name = ?, status = ?,
        credentials = ?, health_score = ?, success_count = ?, error_count = ?,
        total_requests = ?, last_used_at = ?, last_error = ?, cooldown_until = ?,
        tags = ?, remark = ?, source = ?, source_ref = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(
      merged.provider_type,
      merged.email,
      merged.display_name,
      merged.status,
      credentials,
      merged.health_score,
      merged.success_count,
      merged.error_count,
      merged.total_requests,
      merged.last_used_at,
      merged.last_error,
      merged.cooldown_until,
      tags,
      merged.remark,
      merged.source,
      merged.source_ref,
      merged.updated_at,
      id
    );

    return this.getById(id);
  }

  /**
   * Soft-delete a pool account.
   * @param {number} id
   * @returns {{ changes: number }}
   */
  deleteAccount(id) {
    const db = this._getDb();
    return db.prepare(
      "UPDATE pool_accounts SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL"
    ).run(id);
  }

  // ---- POOL-02: Status transitions ----

  /**
   * Transition an account's status with validation and history recording.
   * @param {number} accountId
   * @param {string} newStatus
   * @param {string} reason
   * @param {string} triggeredBy
   * @returns {object|null} The updated account
   */
  transitionStatus(accountId, newStatus, reason = '', triggeredBy = 'manual') {
    const db = this._getDb();
    const account = this.getById(accountId);
    if (!account) {
      throw new Error(`Pool account ${accountId} not found`);
    }

    const allowed = VALID_TRANSITIONS[account.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(
        `Invalid status transition: ${account.status} -> ${newStatus}`
      );
    }

    const updatedAccount = db.transaction(() => {
      // Update status
      db.prepare(
        "UPDATE pool_accounts SET status = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newStatus, accountId);

      // Record history
      db.prepare(`
        INSERT INTO pool_status_history (pool_account_id, from_status, to_status, reason, triggered_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(accountId, account.status, newStatus, reason, triggeredBy);

      return this.getById(accountId);
    })();

    return updatedAccount;
  }

  // ---- POOL-03: Health score ----

  /**
   * Calculate and persist health score for an account.
   * Formula: 0.7 * successRate + 0.3 * quotaScore
   * @param {object} account
   * @returns {number} The health score (0-100)
   */
  calculateHealthScore(account) {
    if (!account.total_requests || account.total_requests === 0) {
      return 100;
    }

    const successRate = account.success_count / account.total_requests;
    const quotaScore = 1 - (account.error_count / account.total_requests);
    const score = (0.7 * successRate + 0.3 * quotaScore) * 100;

    // Persist the calculated score
    this.update(account.id, { health_score: Math.round(score * 100) / 100 });

    return Math.round(score);
  }

  // ---- POOL-05: API Key convenience ----

  /**
   * Add an API key as a pool account.
   * @param {string} providerType
   * @param {string} apiKey
   * @param {string} [baseUrl]
   * @param {string} [displayName]
   * @returns {object}
   */
  addApiKey(providerType, apiKey, baseUrl = '', displayName = '') {
    if (!apiKey || apiKey.trim() === '') {
      throw new Error('apiKey is required');
    }

    return this.add({
      provider_type: providerType,
      display_name: displayName,
      credentials: { apiKey, baseUrl },
      source: 'manual',
    });
  }

  // ---- POOL-06: Enable / Disable ----

  /**
   * Enable a disabled account (disabled -> available).
   * @param {number} id
   * @returns {object|null}
   */
  enableAccount(id) {
    const account = this.getById(id);
    if (!account) {
      throw new Error(`Pool account ${id} not found`);
    }
    if (account.status !== 'disabled') {
      throw new Error(`Cannot enable account: status is '${account.status}', not 'disabled'`);
    }
    return this.transitionStatus(id, 'available', 'manually enabled', 'manual');
  }

  /**
   * Disable any active account (any -> disabled).
   * @param {number} id
   * @returns {object|null}
   */
  disableAccount(id) {
    const account = this.getById(id);
    if (!account) {
      throw new Error(`Pool account ${id} not found`);
    }
    if (account.status === 'disabled') {
      return account; // already disabled
    }
    return this.transitionStatus(id, 'disabled', 'manually disabled', 'manual');
  }
}

module.exports = PoolService;
