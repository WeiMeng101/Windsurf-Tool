'use strict';

/**
 * RetryQueueService
 * Generic retry queue with exponential backoff for failed operations.
 * Supports multiple queue types (e.g., 'registration', 'cardBinding').
 */

const BASE_DELAY = 30000;   // 30 seconds
const MAX_DELAY = 300000;   // 5 minutes
const DEFAULT_MAX_RETRIES = 3;

class RetryQueueService {
  constructor() {
    /** @type {Map<string, Array<{account: object, attempts: number, lastAttempt: number, maxRetries: number}>>} */
    this.queues = new Map();
    /** @type {Map<string, Array<{account: object, attempts: number, lastAttempt: number}>>} */
    this.failed = new Map();
  }

  /**
   * Add an account to the retry queue.
   * If the account already exists in the queue, its attempt counter is incremented.
   * If maxRetries is exceeded, the item is moved to the failed list.
   * @param {string} type - Queue type (e.g., 'registration', 'cardBinding')
   * @param {object} account - Account data (must have email or id)
   * @param {number} [maxRetries=3]
   */
  enqueue(type, account, maxRetries = DEFAULT_MAX_RETRIES) {
    if (!type || !account) return;

    if (!this.queues.has(type)) this.queues.set(type, []);
    if (!this.failed.has(type)) this.failed.set(type, []);

    const queue = this.queues.get(type);
    const accountKey = this._accountKey(account);

    // Check if already queued
    const existing = queue.find(item => this._accountKey(item.account) === accountKey);
    if (existing) {
      existing.attempts += 1;
      existing.lastAttempt = Date.now();
      // If max retries exceeded, move to failed list
      if (existing.attempts >= existing.maxRetries) {
        this._moveToFailed(type, existing);
      }
      return;
    }

    queue.push({
      account,
      attempts: 0,
      lastAttempt: Date.now(),
      maxRetries,
    });
  }

  /**
   * Get the next item ready for retry (respecting exponential backoff).
   * Returns null if nothing is ready.
   * @param {string} type
   * @returns {{account: object, attempts: number, lastAttempt: number, maxRetries: number}|null}
   */
  dequeue(type) {
    const queue = this.queues.get(type);
    if (!queue || queue.length === 0) return null;

    const now = Date.now();

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      const delay = this._calculateDelay(item.attempts);
      const readyAt = item.lastAttempt + delay;

      if (now >= readyAt) {
        // Increment attempts and record the dequeue time
        item.attempts += 1;
        item.lastAttempt = now;

        // If this attempt will exceed maxRetries, move to failed and return null for this item
        if (item.attempts >= item.maxRetries) {
          this._moveToFailed(type, item);
          // Try the next item
          continue;
        }

        return item;
      }
    }

    return null;
  }

  /**
   * Get all items in a queue (both pending and info about next ready time).
   * @param {string} type
   * @returns {Array<{account: object, attempts: number, lastAttempt: number, maxRetries: number, readyAt: number, isReady: boolean}>}
   */
  getQueue(type) {
    const queue = this.queues.get(type);
    if (!queue) return [];

    const now = Date.now();
    return queue.map(item => {
      const delay = this._calculateDelay(item.attempts);
      const readyAt = item.lastAttempt + delay;
      return {
        ...item,
        readyAt,
        isReady: now >= readyAt,
      };
    });
  }

  /**
   * Get the failed list for a queue type (items that exceeded maxRetries).
   * @param {string} type
   * @returns {Array<{account: object, attempts: number, lastAttempt: number}>}
   */
  getFailedList(type) {
    return this.failed.get(type) || [];
  }

  /**
   * Remove an item from the queue (e.g., after successful retry).
   * @param {string} type
   * @param {string|number} accountId - email or id of the account
   * @returns {boolean} true if removed
   */
  removeFromQueue(type, accountId) {
    const queue = this.queues.get(type);
    if (!queue) return false;

    const idx = queue.findIndex(item => this._accountKey(item.account) === String(accountId));
    if (idx !== -1) {
      queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Get aggregate stats across all queue types.
   * @returns {Object} e.g., { registration: { pending: N, failed: N }, cardBinding: { pending: N, failed: N } }
   */
  getStats() {
    const stats = {};
    const allTypes = new Set([...this.queues.keys(), ...this.failed.keys()]);

    for (const type of allTypes) {
      const queue = this.queues.get(type) || [];
      const failedList = this.failed.get(type) || [];
      stats[type] = {
        pending: queue.length,
        failed: failedList.length,
      };
    }

    return stats;
  }

  /**
   * Clear a specific queue type (both pending and failed).
   * @param {string} type
   */
  clear(type) {
    this.queues.delete(type);
    this.failed.delete(type);
  }

  /**
   * Clear all queues.
   */
  clearAll() {
    this.queues.clear();
    this.failed.clear();
  }

  // ---- Internal helpers ----

  /**
   * Calculate exponential backoff delay.
   * delay = min(baseDelay * 2^attempts, maxDelay)
   * @param {number} attempts
   * @returns {number} delay in ms
   */
  _calculateDelay(attempts) {
    return Math.min(BASE_DELAY * Math.pow(2, attempts), MAX_DELAY);
  }

  /**
   * Get a stable key for an account (email preferred, falling back to id).
   * @param {object} account
   * @returns {string}
   */
  _accountKey(account) {
    return String(account.email || account.id || '');
  }

  /**
   * Move an item from the pending queue to the failed list.
   * @param {string} type
   * @param {object} item
   */
  _moveToFailed(type, item) {
    const queue = this.queues.get(type);
    if (queue) {
      const idx = queue.indexOf(item);
      if (idx !== -1) queue.splice(idx, 1);
    }

    if (!this.failed.has(type)) this.failed.set(type, []);
    this.failed.get(type).push({
      account: item.account,
      attempts: item.attempts,
      lastAttempt: item.lastAttempt,
    });
  }
}

// Export singleton instance
const retryQueueService = new RetryQueueService();

module.exports = retryQueueService;
module.exports.RetryQueueService = RetryQueueService;
