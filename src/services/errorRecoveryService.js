'use strict';

const ERROR_PATTERNS = [
  { pattern: /quota|exhausted|rate.?limit|429/i, type: 'cooldown', cooldownMs: 3600000, label: '额度耗尽', strategy: 'cooldown' },
  { pattern: /401|unauthorized|token.*expir/i, type: 'auth_error', cooldownMs: 0, label: 'Token过期', strategy: 'refresh' },
  { pattern: /403|forbidden|banned|suspended/i, type: 'banned', cooldownMs: 0, label: '账号封禁', strategy: 'disable' },
  { pattern: /timeout|ETIMEDOUT|ECONNR/i, type: 'timeout', cooldownMs: 0, label: '网络超时', strategy: 'retry' },
];

const DEFAULT_UNKNOWN_COOLDOWN_MS = 300000;

class ErrorRecoveryService {
  /**
   * @param {() => import('better-sqlite3').Database} getDb
   */
  constructor(getDb) {
    this._getDb = getDb;
  }

  /**
   * Classify an error message.
   * @param {string} errorMessage
   * @returns {{ type: string, cooldownMs: number, label: string, strategy: string }}
   */
  classifyError(errorMessage) {
    if (!errorMessage) {
      return { type: 'unknown', cooldownMs: DEFAULT_UNKNOWN_COOLDOWN_MS, label: '未知错误', strategy: 'cooldown' };
    }
    for (const rule of ERROR_PATTERNS) {
      if (rule.pattern.test(errorMessage)) {
        return { type: rule.type, cooldownMs: rule.cooldownMs, label: rule.label, strategy: rule.strategy };
      }
    }
    return { type: 'unknown', cooldownMs: DEFAULT_UNKNOWN_COOLDOWN_MS, label: '未知错误', strategy: 'cooldown' };
  }

  /**
   * Build a cooldown deadline.
   * @param {number} cooldownMs
   * @param {number} [now]
   * @returns {string}
   */
  _cooldownUntil(cooldownMs, now = Date.now()) {
    return new Date(now + cooldownMs).toISOString();
  }

  /**
   * Clear the cooldown marker for an account.
   * @param {object} poolService
   * @param {number} accountId
   */
  _clearCooldown(poolService, accountId) {
    poolService.update(accountId, { cooldown_until: null });
  }

  /**
   * Return a cooldown account to available.
   * @param {object} poolService
   * @param {object} account
   * @param {string} reason
   * @returns {{ id: number, label: string, action: string }}
   */
  cooldownRelease(poolService, account, reason) {
    this._clearCooldown(poolService, account.id);
    poolService.transitionStatus(account.id, 'available', reason, 'system');
    return { id: account.id, label: reason, action: 'released' };
  }

  /**
   * Try to refresh tokens for an auth error.
   * @param {object} poolService
   * @param {object} account
   * @returns {{ id: number, label: string, action: string }}
   */
  refreshTokens(poolService, account) {
    const credentials = account.credentials && typeof account.credentials === 'object'
      ? account.credentials
      : {};
    const refreshToken = credentials.refresh_token || credentials.refreshToken;
    if (!refreshToken) {
      throw new Error('缺少 refresh_token，无法刷新 Token');
    }

    poolService.update(account.id, {
      cooldown_until: null,
      last_error: '',
    });
    poolService.transitionStatus(account.id, 'available', 'auto-recovery: auth refresh attempted', 'system');
    return { id: account.id, label: 'Token过期', action: 'refresh_attempted' };
  }

  /**
   * Move an account into cooldown.
   * @param {object} poolService
   * @param {object} account
   * @param {{ label: string, cooldownMs: number }} classification
   * @param {number} [now]
   * @returns {{ id: number, label: string, until: string, action: string }}
   */
  putOnCooldown(poolService, account, classification, now = Date.now()) {
    const until = this._cooldownUntil(classification.cooldownMs, now);
    poolService.transitionStatus(account.id, 'cooldown', `${classification.label} cooling down`, 'system');
    poolService.update(account.id, { cooldown_until: until });
    return { id: account.id, label: classification.label, until, action: 'cooldown' };
  }

  /**
   * Mark a timeout as immediately recoverable.
   * @param {object} poolService
   * @param {object} account
   * @returns {{ id: number, label: string, action: string }}
   */
  retryImmediately(poolService, account) {
    this._clearCooldown(poolService, account.id);
    poolService.transitionStatus(account.id, 'available', 'auto-recovery: timeout', 'system');
    return { id: account.id, label: '网络超时', action: 'retried' };
  }

  /**
   * Disable an unrecoverable account.
   * @param {object} poolService
   * @param {object} account
   * @param {string} reason
   * @returns {{ id: number, label: string, action: string }}
   */
  disableAccount(poolService, account, reason) {
    this._clearCooldown(poolService, account.id);
    poolService.transitionStatus(account.id, 'disabled', reason, 'system');
    return { id: account.id, label: reason, action: 'disabled' };
  }

  /**
   * Scan for recoverable accounts and apply recovery.
   * @returns {{ recovered: Array, disabled: Array, cooldowns: Array, skipped: Array, summary: object }}
   */
  scanAndRecover(poolService) {
    const recovered = [];
    const disabled = [];
    const cooldowns = [];
    const skipped = [];
    const seen = new Set();

    const errorAccounts = poolService.getAll({ status: 'error' });
    const cooldownAccounts = poolService.getAll({ status: 'cooldown' });

    const now = Date.now();

    for (const account of [...errorAccounts, ...cooldownAccounts]) {
      if (!account || seen.has(account.id)) continue;
      seen.add(account.id);

      const classification = this.classifyError(account.last_error);
      const cooldownEnd = account.cooldown_until ? new Date(account.cooldown_until).getTime() : null;

      // A cooldown account only becomes available after its timer elapses.
      if (account.status === 'cooldown') {
        if (cooldownEnd && cooldownEnd > now) {
          skipped.push({ id: account.id, reason: '冷却中', until: account.cooldown_until });
          continue;
        }
        recovered.push(this.cooldownRelease(poolService, account, 'cooldown expired'));
        continue;
      }

      try {
        if (cooldownEnd && cooldownEnd > now) {
          skipped.push({ id: account.id, reason: '冷却中', until: account.cooldown_until });
          continue;
        }

        switch (classification.strategy) {
          case 'cooldown':
            if (cooldownEnd && cooldownEnd <= now) {
              recovered.push(this.cooldownRelease(poolService, account, 'cooldown expired'));
            } else {
              cooldowns.push(this.putOnCooldown(poolService, account, classification, now));
            }
            break;
          case 'refresh':
            recovered.push(this.refreshTokens(poolService, account));
            break;
          case 'retry':
            recovered.push(this.retryImmediately(poolService, account));
            break;
          case 'disable':
            disabled.push(this.disableAccount(poolService, account, classification.label));
            break;
          default:
            cooldowns.push(this.putOnCooldown(poolService, account, classification, now));
        }
      } catch (err) {
        skipped.push({ id: account.id, reason: err.message });
      }
    }

    return {
      recovered,
      disabled,
      cooldowns,
      skipped,
      summary: {
        recovered: recovered.length,
        disabled: disabled.length,
        cooldowns: cooldowns.length,
        skipped: skipped.length,
      },
    };
  }
}

module.exports = ErrorRecoveryService;
