'use strict';

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

/**
 * PoolSyncService
 * Bridges the legacy CodexAccountPool (JSON file) with the unified pool (SQLite)
 * and watches directories for new account JSON files.
 */
class PoolSyncService {
  /**
   * @param {import('./poolService')} poolService
   */
  constructor(poolService) {
    this.poolService = poolService;
    /** @type {fs.FSWatcher[]} */
    this.watchers = [];
  }

  // ---- Legacy CodexAccountPool -> Unified Pool sync ----

  /**
   * Sync all accounts from a legacy CodexAccountPool instance into the unified pool.
   * Existing accounts (matched by email) get credential updates if newer;
   * new accounts are inserted.
   *
   * @param {import('../renderer/codexSwitchRenderer').CodexAccountPool} codexPool
   * @returns {{ synced: number, updated: number, skipped: number, total: number }}
   */
  syncFromLegacyPool(codexPool) {
    const accounts = codexPool.getAll();
    let synced = 0;
    let updated = 0;
    let skipped = 0;

    for (const account of accounts) {
      if (!account.email) {
        skipped++;
        continue;
      }

      const emailLower = account.email.toLowerCase();
      const existing = this.poolService
        .getAll({ provider_type: 'codex' })
        .find(a => a.email && a.email.toLowerCase() === emailLower);

      if (existing) {
        // Update credentials if the legacy account has a more recent refresh
        if (account.access_token && account.last_refresh) {
          const existingCreds = existing.credentials || {};
          const existingRefresh = existingCreds._last_refresh || '';
          if (!existingRefresh || account.last_refresh > existingRefresh) {
            this.poolService.update(existing.id, {
              credentials: {
                ...existingCreds,
                access_token: account.access_token,
                refresh_token: account.refresh_token || existingCreds.refresh_token || '',
                id_token: account.id_token || existingCreds.id_token || '',
                account_id: account.id || existingCreds.account_id || '',
                _last_refresh: account.last_refresh,
              },
              status: this._mapLegacyStatus(account.status, existing.status),
            });
            updated++;
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
      } else {
        // Add new account to unified pool
        this.poolService.add({
          provider_type: 'codex',
          email: account.email,
          display_name: account.email,
          status: this._mapLegacyStatus(account.status),
          credentials: {
            access_token: account.access_token || '',
            refresh_token: account.refresh_token || '',
            id_token: account.id_token || '',
            account_id: account.id || '',
            _last_refresh: account.last_refresh || '',
          },
          source: 'legacy_sync',
          source_ref: account.id || '',
        });
        synced++;
      }
    }

    console.log(`[PoolSync] Legacy sync complete: ${synced} added, ${updated} updated, ${skipped} skipped (${accounts.length} total)`);
    return { synced, updated, skipped, total: accounts.length };
  }

  /**
   * Map legacy CodexAccountPool status strings to unified pool status.
   * Legacy uses: idle, active, expired, exhausted
   * Unified uses: available, in_use, error, cooldown, disabled
   *
   * @param {string} legacyStatus
   * @param {string} [currentUnifiedStatus] - preserve certain unified states
   * @returns {string}
   */
  _mapLegacyStatus(legacyStatus, currentUnifiedStatus) {
    // If the account is currently in_use in unified pool, don't override
    if (currentUnifiedStatus === 'in_use') return 'in_use';

    switch (legacyStatus) {
      case 'active':
      case 'idle':
        return 'available';
      case 'exhausted':
        return 'cooldown';
      case 'expired':
        return 'error';
      default:
        return 'available';
    }
  }

  // ---- Bulk import from a directory of account JSON files ----

  /**
   * Scan a directory and import all JSON account files into the unified pool.
   *
   * @param {string} dirPath - path to the directory containing account JSON files
   * @param {string} [providerType='codex']
   * @returns {Promise<{ imported: number, skipped: number, errors: number, total: number }>}
   */
  async importDirectory(dirPath, providerType = 'codex') {
    if (!fs.existsSync(dirPath)) {
      console.warn(`[PoolSync] Directory does not exist: ${dirPath}`);
      return { imported: 0, skipped: 0, errors: 0, total: 0 };
    }

    const files = (await fsPromises.readdir(dirPath)).filter(f => f.endsWith('.json'));
    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const filename of files) {
      try {
        const filePath = path.join(dirPath, filename);
        const data = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
        if (!data.email) {
          skipped++;
          continue;
        }

        const emailLower = data.email.toLowerCase();
        const existing = this.poolService
          .getAll({ provider_type: data.type || providerType })
          .find(a => a.email && a.email.toLowerCase() === emailLower);

        if (existing) {
          skipped++;
        } else {
          this.poolService.add({
            provider_type: data.type || providerType,
            email: data.email,
            display_name: data.email,
            status: 'available',
            credentials: {
              access_token: data.access_token || '',
              refresh_token: data.refresh_token || '',
              id_token: data.id_token || '',
              account_id: data.account_id || data.id || '',
            },
            source: 'file_import',
            source_ref: filename,
          });
          imported++;
        }
      } catch (err) {
        console.error(`[PoolSync] Failed to import ${filename}:`, err.message);
        errors++;
      }
    }

    console.log(`[PoolSync] Directory import complete: ${imported} imported, ${skipped} skipped, ${errors} errors (${files.length} files)`);
    return { imported, skipped, errors, total: files.length };
  }

  // ---- File watching ----

  /**
   * Watch a directory for new account JSON files and auto-import them.
   *
   * @param {string} dirPath
   * @param {string} [providerType='codex']
   * @returns {fs.FSWatcher|null}
   */
  watchDirectory(dirPath, providerType = 'codex') {
    if (!fs.existsSync(dirPath)) {
      console.warn(`[PoolSync] Cannot watch non-existent directory: ${dirPath}`);
      return null;
    }

    const watcher = fs.watch(dirPath, async (eventType, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      // Only handle rename (new file creation) events; change events are noisy
      if (eventType !== 'rename') return;

      const filePath = path.join(dirPath, filename);

      // Small delay to let the file finish writing
      await new Promise(resolve => setTimeout(resolve, 200));

      try {
        // Verify the file still exists (rename fires for both create and delete)
        await fsPromises.access(filePath);
      } catch (_) {
        return; // File was deleted, not created
      }

      try {
        const raw = await fsPromises.readFile(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (!data.email) return;

        const emailLower = data.email.toLowerCase();
        const existing = this.poolService
          .getAll({ provider_type: data.type || providerType })
          .find(a => a.email && a.email.toLowerCase() === emailLower);

        if (!existing) {
          this.poolService.add({
            provider_type: data.type || providerType,
            email: data.email,
            display_name: data.email,
            status: 'available',
            credentials: {
              access_token: data.access_token || '',
              refresh_token: data.refresh_token || '',
              id_token: data.id_token || '',
              account_id: data.account_id || data.id || '',
            },
            source: 'file_watch',
            source_ref: filename,
          });
          console.log(`[PoolSync] Auto-imported new account: ${data.email}`);
        }
      } catch (err) {
        console.error(`[PoolSync] Failed to process ${filename}:`, err.message);
      }
    });

    this.watchers.push(watcher);
    console.log(`[PoolSync] Watching directory: ${dirPath}`);
    return watcher;
  }

  /**
   * Stop all active file watchers.
   */
  stopAll() {
    for (const w of this.watchers) {
      try { w.close(); } catch (_) { /* ignore */ }
    }
    this.watchers = [];
    console.log('[PoolSync] All watchers stopped');
  }

  /**
   * Get the number of active watchers.
   * @returns {number}
   */
  getWatcherCount() {
    return this.watchers.length;
  }
}

module.exports = PoolSyncService;
