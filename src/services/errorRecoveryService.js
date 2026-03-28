'use strict';

const tokenRefreshService = require('./tokenRefreshService');

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
    this._periodicInterval = null;
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
   * Re-reads credentials from accountService when available, then calls the
   * real OpenAI token endpoint via tokenRefreshService to get a new access_token.
   *
   * @param {object} poolService
   * @param {object} account
   * @param {object} [accountService] - Optional AccountService instance for credential lookup
   * @returns {Promise<{ id: number, label: string, action: string }>}
   */
  async refreshTokens(poolService, account, accountService) {
    let credentials = account.credentials && typeof account.credentials === 'object'
      ? account.credentials
      : {};

    // If accountService is available, attempt to re-read fresh credentials
    if (accountService && typeof accountService.getById === 'function') {
      try {
        const freshAccount = await Promise.resolve(accountService.getById(account.id));
        if (freshAccount) {
          credentials = freshAccount.credentials && typeof freshAccount.credentials === 'object'
            ? freshAccount.credentials
            : credentials;
          console.log(`[ErrorRecovery] Re-read credentials from accountService for account ${account.id}`);
        }
      } catch (err) {
        console.log(`[ErrorRecovery] Failed to re-read credentials for account ${account.id}: ${err.message}`);
      }
    }

    const refreshToken = credentials.refresh_token || credentials.refreshToken;

    if (!refreshToken) {
      console.log(`[ErrorRecovery] Account ${account.id}: no refresh_token, keeping in error state`);
      throw new Error('缺少 refresh_token，无法刷新 Token');
    }

    console.log(`[ErrorRecovery] Account ${account.id}: refresh_token found, calling token endpoint...`);

    // Build a temporary account-like object for tokenRefreshService
    const accountForRefresh = {
      credentials,
      provider_type: account.provider_type || 'codex',
    };

    const tokens = await tokenRefreshService.refreshToken(accountForRefresh);

    // Update pool credentials with fresh tokens
    const updatedCredentials = { ...credentials, access_token: tokens.access_token };
    if (tokens.refresh_token) {
      updatedCredentials.refresh_token = tokens.refresh_token;
    }

    poolService.update(account.id, {
      credentials: updatedCredentials,
      cooldown_until: null,
      last_error: '',
    });
    poolService.transitionStatus(account.id, 'available', 'auto-recovery: token refreshed via API', 'system');

    console.log(`[ErrorRecovery] Account ${account.id}: token refresh succeeded, transitioned to available`);
    return { id: account.id, label: 'Token过期', action: 'refresh_success' };
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
   * Start periodic scanning for recoverable accounts.
   * @param {object} poolService
   * @param {number} [intervalMs=300000] - Interval between scans in milliseconds (default 5 minutes)
   * @param {object} [accountService] - Optional AccountService for credential lookup during refresh
   * @returns {function} Cleanup function to stop the interval
   */
  startPeriodicScan(poolService, intervalMs = 300000, accountService) {
    if (this._periodicInterval) {
      console.log('[ErrorRecovery] Periodic scan already running, stopping previous instance');
      this.stopPeriodicScan();
    }

    console.log(`[ErrorRecovery] Starting periodic scan every ${intervalMs}ms`);
    this._periodicInterval = setInterval(async () => {
      try {
        const result = await this.scanAndRecover(poolService, accountService);
        console.log(`[ErrorRecovery] Periodic scan complete: ${JSON.stringify(result.summary)}`);
      } catch (err) {
        console.error(`[ErrorRecovery] Periodic scan failed: ${err.message}`);
      }
    }, intervalMs);

    return () => this.stopPeriodicScan();
  }

  /**
   * Stop the periodic scan interval.
   */
  stopPeriodicScan() {
    if (this._periodicInterval) {
      clearInterval(this._periodicInterval);
      this._periodicInterval = null;
      console.log('[ErrorRecovery] Periodic scan stopped');
    }
  }

  /**
   * Scan for recoverable accounts and apply recovery.
   * @param {object} poolService
   * @param {object} [accountService] - Optional AccountService for credential lookup during refresh
   * @returns {Promise<{ recovered: Array, disabled: Array, cooldowns: Array, skipped: Array, summary: object }>}
   */
  async scanAndRecover(poolService, accountService) {
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
            recovered.push(await this.refreshTokens(poolService, account, accountService));
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
