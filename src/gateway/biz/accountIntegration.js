'use strict';

const { getDb } = require('../db');
const { cacheManager } = require('../cache');
const logger = require('../logger');

class AccountIntegrationService {
  syncAccountsToChannels(accounts) {
    const db = getDb();
    let created = 0;
    let updated = 0;
    let skipped = 0;

    const transaction = db.transaction(() => {
      for (const account of accounts) {
        if (!account.email) continue;

        // Validate credentials before syncing
        const validation = this.validateCredentials(account);
        if (!validation.valid) {
          logger.warn(`Skipping account ${account.email}: ${validation.reason}`);
          skipped++;
          continue;
        }

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

    logger.info(`Account sync complete: ${created} created, ${updated} updated, ${skipped} skipped`);
    return { created, updated, skipped, total: accounts.length };
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

  // ---------------------------------------------------------------------------
  // Credential validation helpers
  // ---------------------------------------------------------------------------

  /**
   * Quick validation of an account's credentials.
   * Checks that at least one usable credential exists and, if a JWT-style
   * access token is present, that it has not expired.
   */
  validateCredentials(account) {
    if (!account) {
      return { valid: false, reason: 'Account object is null or undefined' };
    }

    const hasAccessToken = Boolean(account.accessToken);
    const hasRefreshToken = Boolean(account.refreshToken);
    const hasApiKey = Boolean(account.token);

    if (!hasAccessToken && !hasRefreshToken && !hasApiKey) {
      return { valid: false, reason: 'No credentials present' };
    }

    // If an access token is present, check whether it looks expired
    if (hasAccessToken) {
      const expiry = this.checkExpiry(account);
      if (expiry.expired && !hasRefreshToken) {
        return { valid: false, reason: 'Access token expired and no refresh token available' };
      }
    }

    return { valid: true, reason: null };
  }

  /**
   * Decode the expiry from a JWT-style access token (without signature
   * verification -- we only care about the `exp` claim for a quick check).
   * Returns { expired: boolean, expiresAt: Date|null, remainingMs: number|null }.
   */
  checkExpiry(account) {
    const token = account.accessToken || account.token;
    if (!token) {
      return { expired: true, expiresAt: null, remainingMs: null };
    }

    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        // Not a JWT -- assume valid (opaque API key)
        return { expired: false, expiresAt: null, remainingMs: null };
      }

      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
      if (!payload.exp) {
        return { expired: false, expiresAt: null, remainingMs: null };
      }

      const expiresAt = new Date(payload.exp * 1000);
      const remainingMs = expiresAt.getTime() - Date.now();

      return {
        expired: remainingMs <= 0,
        expiresAt,
        remainingMs: Math.max(remainingMs, 0),
      };
    } catch {
      // If decoding fails, treat as not expired (opaque token)
      return { expired: false, expiresAt: null, remainingMs: null };
    }
  }

  /**
   * Scan all auto-imported channels and deactivate any whose tokens have
   * expired and have no refresh token fallback.
   * Returns the number of channels deactivated.
   */
  autoDeactivateExpired() {
    const channels = this.getAutoImportedChannels();
    const db = getDb();
    let deactivated = 0;

    for (const ch of channels) {
      if (ch.status === 'disabled' || ch.status === 'archived') continue;

      const creds = ch.credentials || {};
      const pseudoAccount = {
        accessToken: creds.access_token,
        refreshToken: creds.refresh_token,
        token: creds.api_key,
      };

      const validation = this.validateCredentials(pseudoAccount);
      if (!validation.valid) {
        db.prepare(`
          UPDATE channels SET status = 'disabled', updated_at = datetime('now')
          WHERE id = ?
        `).run(ch.id);
        deactivated++;
        logger.info(`Auto-deactivated channel ${ch.name}: ${validation.reason}`);
      }
    }

    if (deactivated > 0) {
      cacheManager.flush('channels');
    }

    logger.info(`Auto-deactivation scan complete: ${deactivated} channels deactivated`);
    return deactivated;
  }
}

const accountIntegrationService = new AccountIntegrationService();

module.exports = { AccountIntegrationService, accountIntegrationService };
