'use strict';

class GatewayDataService {
  /**
   * @param {function} getDb - Function that returns the SQLite database instance
   */
  constructor(getDb) {
    this._getDb = getDb;
  }

  getDb() {
    return this._getDb();
  }

  query(sql, params = []) {
    const db = this.getDb();
    return db.prepare(sql).run(...params);
  }

  all(sql, params = []) {
    const db = this.getDb();
    return db.prepare(sql).all(...params);
  }

  get(sql, params = []) {
    const db = this.getDb();
    return db.prepare(sql).get(...params);
  }
}

module.exports = GatewayDataService;
