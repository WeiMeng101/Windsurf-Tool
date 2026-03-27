'use strict';

const { getDb } = require('../db');
const { cacheManager } = require('../cache');
const logger = require('../logger');

class AccountIntegrationService {
  syncAccountsToChannels(accounts) {
    const db = getDb();
    let created = 0;
    let updated = 0;

    const transaction = db.transaction(() => {
      for (const account of accounts) {
        if (!account.email) continue;

        const existing = db.prepare(
          "SELECT id FROM channels WHERE name = ? AND deleted_at IS NULL"
        ).get(`windsurf-${account.email}`);

        const credentials = {};
        if (account.accessToken) credentials.access_token = account.accessToken;
        if (account.refreshToken) credentials.refresh_token = account.refreshToken;
        if (account.token) credentials.api_key = account.token;

        const supportedModels = this.getModelsForAccountType(account);

        if (existing) {
          db.prepare(`
            UPDATE channels SET
              credentials = ?,
              supported_models = ?,
              status = ?,
              updated_at = datetime('now')
            WHERE id = ?
          `).run(
            JSON.stringify(credentials),
            JSON.stringify(supportedModels),
            account.status === 'active' ? 'enabled' : 'disabled',
            existing.id
          );
          updated++;
        } else {
          const channelType = this.getChannelType(account);
          db.prepare(`
            INSERT INTO channels (type, name, base_url, status, credentials, supported_models, tags, default_test_model, remark)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            channelType,
            `windsurf-${account.email}`,
            '',
            account.status === 'active' ? 'enabled' : 'disabled',
            JSON.stringify(credentials),
            JSON.stringify(supportedModels),
            JSON.stringify(['windsurf', 'auto-imported']),
            supportedModels[0] || '',
            `Auto-imported from Windsurf account: ${account.email}`
          );
          created++;
        }
      }
    });

    transaction();
    cacheManager.flush('channels');

    logger.info(`Account sync complete: ${created} created, ${updated} updated`);
    return { created, updated, total: accounts.length };
  }

  getChannelType(account) {
    if (account.plan === 'pro' || account.plan === 'codex') return 'codex';
    if (account.type === 'codex') return 'codex';
    return 'openai';
  }

  getModelsForAccountType(account) {
    if (account.plan === 'codex' || account.type === 'codex') {
      return [
        'gpt-5', 'gpt-5-codex', 'gpt-5-codex-mini',
        'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1-codex-max',
        'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.3-codex', 'gpt-5.4',
      ];
    }
    if (account.plan === 'pro') {
      return ['gpt-4', 'gpt-4o', 'gpt-5', 'claude-3-5-sonnet'];
    }
    return ['gpt-4', 'gpt-4o'];
  }

  getAutoImportedChannels() {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM channels WHERE tags LIKE '%auto-imported%' AND deleted_at IS NULL
      ORDER BY name ASC
    `).all().map(ch => ({
      ...ch,
      credentials: JSON.parse(ch.credentials || '{}'),
      supported_models: JSON.parse(ch.supported_models || '[]'),
      tags: JSON.parse(ch.tags || '[]'),
    }));
  }

  removeAutoImportedChannels() {
    const db = getDb();
    const result = db.prepare(`
      UPDATE channels SET deleted_at = datetime('now'), status = 'archived'
      WHERE tags LIKE '%auto-imported%' AND deleted_at IS NULL
    `).run();
    cacheManager.flush('channels');
    return result.changes;
  }
}

const accountIntegrationService = new AccountIntegrationService();

module.exports = { AccountIntegrationService, accountIntegrationService };
