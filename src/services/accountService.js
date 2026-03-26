'use strict';

const fs = require('fs').promises;
const accountsFileLock = require('../accountsFileLock');

class AccountService {
  /**
   * @param {string} accountsFilePath - Path to accounts.json
   * @param {object} [lock] - Optional lock instance (defaults to singleton)
   */
  constructor(accountsFilePath, lock) {
    this.accountsFilePath = accountsFilePath;
    this._lock = lock || accountsFileLock;
  }

  async getAll() {
    return this._lock.acquire(async () => {
      try {
        const raw = await fs.readFile(this.accountsFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        if (error.code === 'ENOENT') {
          return [];
        }
        throw error;
      }
    });
  }

  async save(accounts) {
    await this._lock.acquire(async () => {
      await fs.writeFile(
        this.accountsFilePath,
        JSON.stringify(accounts, null, 2),
        { encoding: 'utf-8' }
      );
    });
  }

  async add(account) {
    const accounts = await this.getAll();
    accounts.push(account);
    await this.save(accounts);
    return account;
  }

  async getById(id) {
    const accounts = await this.getAll();
    return accounts.find(a => a.id === id) || null;
  }

  async update(id, updates) {
    const accounts = await this.getAll();
    const index = accounts.findIndex(a => a.id === id);
    if (index === -1) return null;
    accounts[index] = { ...accounts[index], ...updates };
    await this.save(accounts);
    return accounts[index];
  }

  async delete(id) {
    const accounts = await this.getAll();
    const filtered = accounts.filter(a => a.id !== id);
    await this.save(filtered);
    return filtered.length < accounts.length;
  }

  async deleteAll() {
    await this.save([]);
  }

  async readFileRaw(filePath, encoding = 'utf-8') {
    return fs.readFile(filePath, encoding);
  }

  async writeFileRaw(filePath, data, options = {}) {
    await fs.writeFile(filePath, data, options);
  }
}

module.exports = AccountService;
