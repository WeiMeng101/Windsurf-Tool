'use strict';

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

class PoolChannelBridge {
  /**
   * @param {() => import('better-sqlite3').Database} getDb
   */
  constructor(getDb) {
    this._getDb = getDb;
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
      if (!account.credentials || (!account.credentials.apiKey && !account.credentials.api_key)) continue;

      const channelName = `${POOL_TAG}${account.id}`;
      const channelType = PROVIDER_TYPE_MAP[account.provider_type] || 'openai';
      const models = PROVIDER_DEFAULT_MODELS[channelType] || [];
      const baseUrl = account.credentials.base_url || account.credentials.apiServerUrl || '';
      const credentials = JSON.stringify({
        api_key: account.credentials.apiKey || account.credentials.api_key || '',
        refresh_token: account.credentials.refreshToken || '',
        apiServerUrl: account.credentials.apiServerUrl || '',
      });
      const weight = Math.round((account.health_score ?? 100) / 10);
      const status = account.status === 'available' ? 'enabled' : 'disabled';
      const tags = JSON.stringify([...(account.tags || []), 'pool']);

      const existing = db.prepare(
        "SELECT id FROM channels WHERE name = ? AND deleted_at IS NULL"
      ).get(channelName);

      if (existing) {
        db.prepare(`
          UPDATE channels SET type = ?, base_url = ?, credentials = ?,
            supported_models = ?, status = ?, ordering_weight = ?, tags = ?,
            updated_at = datetime('now')
          WHERE id = ? AND deleted_at IS NULL
        `).run(channelType, baseUrl, credentials, JSON.stringify(models), status, weight, tags, existing.id);
        updated++;
      } else {
        db.prepare(`
          INSERT INTO channels (type, name, base_url, credentials, supported_models,
            status, ordering_weight, tags, remark, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(channelType, channelName, baseUrl, credentials, JSON.stringify(models), status, weight, tags, `Pool: ${account.email || account.display_name}`);
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
    const idSet = new Set(activePoolIds.map(id => `${POOL_TAG}${id}`));

    const orphaned = db.prepare(
      "SELECT id FROM channels WHERE name LIKE ? AND deleted_at IS NULL"
    ).all(`${POOL_TAG}%`);

    let removed = 0;
    for (const row of orphaned) {
      if (!idSet.has(row.name)) {
        db.prepare(
          "UPDATE channels SET deleted_at = datetime('now'), updated_at = datetime('now'), status = 'disabled' WHERE id = ?"
        ).run(row.id);
        removed++;
      }
    }

    return removed;
  }
}

module.exports = PoolChannelBridge;
