'use strict';

const ERROR_PATTERNS = [
  { pattern: /quota|exhausted|rate.?limit|429/i, type: 'cooldown', cooldownMs: 3600000, label: '额度耗尽' },
  { pattern: /401|unauthorized|token.*expir/i, type: 'auth_error', cooldownMs: 0, label: 'Token过期' },
  { pattern: /403|forbidden|banned|suspended/i, type: 'banned', cooldownMs: 0, label: '账号封禁' },
  { pattern: /timeout|ETIMEDOUT|ECONNR/i, type: 'timeout', cooldownMs: 300000, label: '网络超时' },
];

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
   * @returns {{ type: string, cooldownMs: number, label: string }}
   */
  classifyError(errorMessage) {
    if (!errorMessage) return { type: 'unknown', cooldownMs: 300000, label: '未知错误' };
    for (const rule of ERROR_PATTERNS) {
      if (rule.pattern.test(errorMessage)) {
        return { type: rule.type, cooldownMs: rule.cooldownMs, label: rule.label };
      }
    }
    return { type: 'unknown', cooldownMs: 300000, label: '未知错误' };
  }

  /**
   * Scan for recoverable accounts and apply recovery.
   * @returns {{ recovered: Array, disabled: Array, skipped: Array }}
   */
  scanAndRecover(poolService) {
    const recovered = [];
    const disabled = [];
    const skipped = [];

    const errorAccounts = poolService.getAll({ status: 'error' });
    const cooldownAccounts = poolService.getAll({ status: 'cooldown' });

    const now = Date.now();

    for (const account of [...errorAccounts, ...cooldownAccounts]) {
      const classification = this.classifyError(account.last_error);

      // Check if cooldown period has passed
      if (account.cooldown_until) {
        const cooldownEnd = new Date(account.cooldown_until).getTime();
        if (cooldownEnd > now) {
          skipped.push({ id: account.id, reason: '冷却中', until: account.cooldown_until });
          continue;
        }
      }

      try {
        switch (classification.type) {
          case 'cooldown':
            poolService.transitionStatus(account.id, 'available', 'cooldown expired', 'system');
            recovered.push({ id: account.id, label: classification.label });
            break;
          case 'auth_error':
            poolService.transitionStatus(account.id, 'available', 'auto-recovery: auth error', 'system');
            recovered.push({ id: account.id, label: classification.label });
            break;
          case 'timeout':
            poolService.transitionStatus(account.id, 'available', 'auto-recovery: timeout', 'system');
            recovered.push({ id: account.id, label: classification.label });
            break;
          case 'banned':
            poolService.transitionStatus(account.id, 'disabled', classification.label, 'system');
            disabled.push({ id: account.id, label: classification.label });
            break;
          default:
            // Unknown errors: try recovering after cooldown
            poolService.transitionStatus(account.id, 'available', 'auto-recovery: unknown', 'system');
            recovered.push({ id: account.id, label: classification.label });
        }
      } catch (err) {
        skipped.push({ id: account.id, reason: err.message });
      }
    }

    return { recovered, disabled, skipped };
  }
}

module.exports = ErrorRecoveryService;
