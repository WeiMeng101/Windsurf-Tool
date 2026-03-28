'use strict';

const { isTokenExpired } = require('./tokenUtils');

const POOL_TAG = '__pool__';

/**
 * Maps pool provider_type to gateway channel type.
 */
const PROVIDER_TYPE_MAP = {
  windsurf: 'codex',
  codex: 'codex',
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  deepseek: 'deepseek',
  moonshot: 'moonshot',
  doubao: 'doubao',
  zhipu: 'zhipu',
  openrouter: 'openrouter',
  xai: 'xai',
  siliconflow: 'siliconflow',
  ppio: 'ppio',
  claudecode: 'claudecode',
  other: 'openai',
};

/**
 * Models typically available per provider (for channel supported_models).
 */
const PROVIDER_DEFAULT_MODELS = {
  codex: ['codegeist-4', 'codegeist-3.5', 'claude-3.5-sonnet', 'gpt-4o', 'gpt-4o-mini'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1', 'o1-mini', 'o3-mini'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
  gemini: ['gemini-2.0-flash', 'gemini-2.5-pro-preview-05-06', 'gemini-2.5-flash-preview-05-20'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  doubao: ['doubao-pro-32k', 'doubao-pro-4k'],
  zhipu: ['glm-4-plus', 'glm-4-flash', 'glm-4-long'],
  openrouter: ['openrouter-auto'],
  xai: ['grok-3', 'grok-3-mini'],
  siliconflow: ['Qwen/Qwen2.5-72B-Instruct'],
  ppio: ['deepseek-ai/DeepSeek-V3'],
  claudecode: ['claude-sonnet-4-20250514'],
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getAccountId(account) {
  if (!isPlainObject(account)) return account;
  return account.id ?? account.accountId ?? account.account_id ?? account.poolAccountId;
}

function getProviderType(account) {
  if (!isPlainObject(account)) return 'openai';
  return account.provider_type ?? account.providerType ?? 'openai';
}

function getHealthScore(account) {
  if (!isPlainObject(account)) return 100;
  return account.health_score ?? account.healthScore ?? 100;
}

function getCredentials(account) {
  if (!isPlainObject(account) || !isPlainObject(account.credentials)) return {};
  return account.credentials;
}

function getCredentialValue(credentials, ...keys) {
  for (const key of keys) {
    const value = credentials[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return '';
}

class PoolChannelBridge {
  /**
   * @param {() => import('better-sqlite3').Database} getDb
   */
  constructor(getDb) {
    this._getDb = getDb;
    this._autoSyncTimer = null;
  }

  // ---- Dynamic per-request pool allocation (GW-01) ----

  /**
   * Allocate the best available pool account for a given provider type.
   *
   * 1. Queries poolService for available accounts matching providerType
   * 2. Selects the account with the highest health_score
   * 3. Transitions it to 'in_use'
   * 4. Returns { accountId, providerType, credentials, channelType, models } or null
   *
   * @param {import('./poolService')} poolService
   * @param {string} providerType - e.g. 'openai', 'anthropic', 'codex'
   * @returns {object|null}
   */
  allocateFromPool(poolService, providerType) {
    const available = poolService.getAll({
      provider_type: providerType,
      status: 'available',
    });

    if (!available || available.length === 0) return null;

    // Sort by health_score descending (highest first)
    available.sort((a, b) => getHealthScore(b) - getHealthScore(a));

    // Try each candidate in order; transition may fail if another request
    // grabbed it first (race), so fall through to the next.
    for (const account of available) {
      const accountId = getAccountId(account);
      if (accountId === undefined || accountId === null || accountId === '') continue;

      const credentials = getCredentials(account);
      const pType = getProviderType(account);
      const channelType = PROVIDER_TYPE_MAP[pType] || 'openai';
      const isCodex = channelType === 'codex';

      // For Codex accounts the bearer credential is access_token (JWT), not api_key.
      // For all others we require a non-empty api_key.
      const accessToken = getCredentialValue(credentials, 'access_token', 'accessToken');
      const apiKey = getCredentialValue(credentials, 'apiKey', 'api_key');
      const effectiveKey = isCodex ? (accessToken || apiKey) : apiKey;
      if (!effectiveKey || String(effectiveKey).trim() === '') continue;

      // Skip Codex accounts whose access_token JWT is expired.
      // The pipeline may still attempt a refresh, but allocating a known-expired
      // token wastes a round-trip.  Only skip when the refresh_token is also
      // missing -- otherwise the pipeline can refresh on-the-fly.
      if (isCodex && accessToken) {
        const refreshToken = getCredentialValue(credentials, 'refreshToken', 'refresh_token');
        if (isTokenExpired(accessToken) && !refreshToken) {
          continue;
        }
      }

      try {
        poolService.transitionStatus(accountId, 'in_use', 'allocated for request', 'gateway');
      } catch (_err) {
        // Transition failed (e.g. already claimed by another request) -- try next
        continue;
      }

      const models = PROVIDER_DEFAULT_MODELS[channelType] || [];
      const baseUrl = getCredentialValue(credentials, 'baseUrl', 'base_url', 'apiServerUrl', 'api_server_url');

      // Build credentials payload.  Codex accounts pass through the full JWT
      // credential set (access_token, refresh_token, id_token) so the pipeline
      // can use / refresh them.
      const credentialsPayload = isCodex
        ? {
            api_key: accessToken || apiKey,
            access_token: accessToken,
            refresh_token: getCredentialValue(credentials, 'refreshToken', 'refresh_token'),
            id_token: getCredentialValue(credentials, 'id_token', 'idToken'),
            account_id: getCredentialValue(credentials, 'account_id', 'accountId'),
          }
        : {
            api_key: apiKey,
            refresh_token: getCredentialValue(credentials, 'refreshToken', 'refresh_token'),
            apiServerUrl: getCredentialValue(credentials, 'apiServerUrl', 'api_server_url'),
          };

      return {
        accountId,
        providerType: pType,
        channelType,
        models,
        credentials: credentialsPayload,
        base_url: baseUrl,
        health_score: getHealthScore(account),
        email: account.email || '',
        display_name: account.display_name || '',
      };
    }

    return null;
  }

  /**
   * Release a pool account back after a request completes.
   *
   * - On success: transitions to 'available', increments success_count
   * - On failure:
   *   - 401/403 (auth): transitions to 'error', tags with needs_refresh
   *   - 429 (rate limit): transitions to 'cooldown' with cooldown duration
   *   - Other errors: transitions to 'error'
   *
   * Also bumps total_requests and recalculates health_score.
   *
   * @param {import('./poolService')} poolService
   * @param {number|string} accountId
   * @param {boolean} success
   * @param {string} [errorMessage]
   */
  releaseToPool(poolService, accountId, success, errorMessage) {
    const account = poolService.getById(accountId);
    if (!account) return;

    const updates = {
      total_requests: (account.total_requests || 0) + 1,
      last_used_at: new Date().toISOString(),
    };

    if (success) {
      updates.success_count = (account.success_count || 0) + 1;
    } else {
      updates.error_count = (account.error_count || 0) + 1;
      if (errorMessage) {
        updates.last_error = String(errorMessage).slice(0, 500);
      }
    }

    // Determine target status and extra metadata based on error type
    let targetStatus = success ? 'available' : 'error';
    let reason = success ? 'request completed' : `request failed: ${errorMessage || 'unknown'}`;

    if (!success && errorMessage) {
      const errStr = String(errorMessage);
      const httpStatus = this._extractHttpStatus(errStr);

      if (httpStatus === 401 || httpStatus === 403 || /unauthorized|token.*expir/i.test(errStr)) {
        // Auth failure -- mark for token refresh by the recovery service
        const existingTags = Array.isArray(account.tags) ? account.tags : [];
        if (!existingTags.includes('needs_refresh')) {
          updates.tags = [...existingTags, 'needs_refresh'];
        }
        reason = `auth failure (${httpStatus || 'token expired'}): needs token refresh`;
      } else if (httpStatus === 429 || /rate.?limit|quota|exhausted/i.test(errStr)) {
        // Rate limit -- put into cooldown for 1 hour
        targetStatus = 'cooldown';
        const cooldownMs = 3600000; // 1 hour
        updates.cooldown_until = new Date(Date.now() + cooldownMs).toISOString();
        reason = `rate limited (429): cooldown until ${updates.cooldown_until}`;
      }
    }

    poolService.update(accountId, updates);

    try {
      poolService.transitionStatus(accountId, targetStatus, reason, 'gateway');
    } catch (_err) {
      // If transition fails (e.g. already transitioned), ignore gracefully
    }

    // Recalculate health score with the updated counters
    const refreshed = poolService.getById(accountId);
    if (refreshed) {
      poolService.calculateHealthScore(refreshed);
    }
  }

  /**
   * Extract HTTP status code from an error message string.
   * Looks for patterns like "401", "Upstream error: 429", etc.
   * @param {string} errStr
   * @returns {number|null}
   */
  _extractHttpStatus(errStr) {
    const match = errStr.match(/\b(4\d{2}|5\d{2})\b/);
    return match ? parseInt(match[1], 10) : null;
  }

  // ---- Auto-Sync (background cache of pool -> channels table) ----

  /**
   * Start periodic background sync of pool accounts into the channels table.
   * This keeps the channels table as a cache/fallback while pool is the
   * source of truth for dynamic allocation.
   *
   * @param {import('./poolService')} poolService
   * @param {() => import('better-sqlite3').Database} gatewayGetDb
   * @param {number} [intervalMs=60000]
   * @returns {() => void} cleanup function to stop the timer
   */
  startAutoSync(poolService, gatewayGetDb, intervalMs = 60000) {
    // Stop any previous auto-sync
    this.stopAutoSync();

    const runSync = () => {
      try {
        const accounts = poolService.getAll();
        const activeIds = accounts
          .map(a => getAccountId(a))
          .filter(id => id !== undefined && id !== null && id !== '');
        this.sync(accounts);
        this.removeOrphaned(activeIds);
      } catch (_err) {
        // Auto-sync is best-effort; swallow errors to avoid crashing the timer
      }
    };

    // Run once immediately, then on interval
    runSync();
    this._autoSyncTimer = setInterval(runSync, intervalMs);

    const cleanup = () => this.stopAutoSync();
    return cleanup;
  }

  /**
   * Stop the auto-sync timer if running.
   */
  stopAutoSync() {
    if (this._autoSyncTimer) {
      clearInterval(this._autoSyncTimer);
      this._autoSyncTimer = null;
    }
  }

  /**
   * Sync pool accounts to channels table.
   * Creates/updates channels for each pool account with credentials.
   * @param {Array} poolAccounts - Array of pool account objects
   * @returns {{ created: number, updated: number }}
   */
  sync(poolAccounts) {
    const db = this._getDb();
    let created = 0;
    let updated = 0;

    for (const account of poolAccounts) {
      const accountId = getAccountId(account);
      if (accountId === undefined || accountId === null || accountId === '') continue;

      const credentials = getCredentials(account);
      const apiKey = getCredentialValue(credentials, 'apiKey', 'api_key');
      const hasApiKey = Boolean(String(apiKey).trim());

      const channelName = `${POOL_TAG}${accountId}`;
      const channelType = PROVIDER_TYPE_MAP[getProviderType(account)] || 'openai';
      const models = PROVIDER_DEFAULT_MODELS[channelType] || [];
      const baseUrl = getCredentialValue(credentials, 'baseUrl', 'base_url', 'apiServerUrl', 'api_server_url');
      const serializedCredentials = JSON.stringify({
        api_key: apiKey,
        refresh_token: getCredentialValue(credentials, 'refreshToken', 'refresh_token'),
        apiServerUrl: getCredentialValue(credentials, 'apiServerUrl', 'api_server_url'),
      });
      const weight = Math.round(getHealthScore(account) / 10);
      const status = account.status === 'available' && hasApiKey ? 'enabled' : 'disabled';
      const tags = JSON.stringify([...(Array.isArray(account.tags) ? account.tags : []), 'pool']);

      const existing = db.prepare(
        "SELECT id, deleted_at FROM channels WHERE name = ? ORDER BY deleted_at IS NULL DESC, updated_at DESC LIMIT 1"
      ).get(channelName);

      if (existing) {
        db.prepare(`
          UPDATE channels SET type = ?, base_url = ?, credentials = ?,
            supported_models = ?, status = ?, ordering_weight = ?, tags = ?,
            deleted_at = NULL,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(channelType, baseUrl, serializedCredentials, JSON.stringify(models), status, weight, tags, existing.id);
        updated++;
      } else if (hasApiKey) {
        db.prepare(`
          INSERT INTO channels (type, name, base_url, credentials, supported_models,
            status, ordering_weight, tags, remark, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          channelType,
          channelName,
          baseUrl,
          serializedCredentials,
          JSON.stringify(models),
          status,
          weight,
          tags,
          `Pool: ${account.email || account.display_name || channelName}`,
        );
        created++;
      }
    }

    return { created, updated };
  }

  /**
   * Remove pool channels that no longer exist in the pool.
   * @param {Array} activePoolIds - Array of active pool account IDs
   * @returns {number} Number of channels removed
   */
  removeOrphaned(activePoolIds) {
    const db = this._getDb();
    const idSet = new Set(
      activePoolIds
        .map(id => getAccountId(id))
        .filter(id => id !== undefined && id !== null && id !== '')
        .map(id => `${POOL_TAG}${id}`)
    );

    const orphaned = db.prepare(
      "SELECT id, name FROM channels WHERE name LIKE ? AND deleted_at IS NULL"
    ).all(`${POOL_TAG}%`);

    let disabled = 0;
    for (const row of orphaned) {
      if (!idSet.has(row.name)) {
        db.prepare(
          "UPDATE channels SET updated_at = datetime('now'), status = 'disabled' WHERE id = ? AND deleted_at IS NULL"
        ).run(row.id);
        disabled++;
      }
    }

    return disabled;
  }
}

/**
 * Given a model name, return the provider_type values whose default model
 * lists include that model (exact match or wildcard prefix).
 * Used by the pipeline to know which pool provider_type to query.
 *
 * @param {string} model
 * @returns {string[]} provider_type values that may serve this model
 */
PoolChannelBridge.resolveProviderTypesForModel = function resolveProviderTypesForModel(model) {
  const matches = [];
  for (const [channelType, models] of Object.entries(PROVIDER_DEFAULT_MODELS)) {
    for (const m of models) {
      if (m === model) {
        matches.push(channelType);
        break;
      }
      if (m.endsWith('*') && model.startsWith(m.slice(0, -1))) {
        matches.push(channelType);
        break;
      }
    }
  }

  // Map channel types back to provider_type values (reverse of PROVIDER_TYPE_MAP)
  const providerTypes = [];
  for (const [providerType, channelType] of Object.entries(PROVIDER_TYPE_MAP)) {
    if (matches.includes(channelType) && !providerTypes.includes(providerType)) {
      providerTypes.push(providerType);
    }
  }

  return providerTypes;
};

module.exports = PoolChannelBridge;
