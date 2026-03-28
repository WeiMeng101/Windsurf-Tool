'use strict';

const path = require('path');
const fs = require('fs');
const { getDb } = require('../db');
const logger = require('../logger');

const BACKUP_VERSION = 2;
const MAX_BACKUPS = 7;

class BackupService {
  constructor() {
    this._scheduledTimer = null;
  }

  exportConfig() {
    const db = getDb();
    const channels = db.prepare('SELECT * FROM channels WHERE deleted_at IS NULL').all();
    const models = db.prepare('SELECT * FROM models WHERE deleted_at IS NULL').all();
    const apiKeys = db.prepare('SELECT * FROM api_keys WHERE deleted_at IS NULL').all();
    const roles = db.prepare('SELECT * FROM roles WHERE deleted_at IS NULL').all();
    const system = db.prepare('SELECT * FROM systems').all();
    const prompts = db.prepare('SELECT * FROM prompts WHERE deleted_at IS NULL').all();
    const rules = db.prepare('SELECT * FROM prompt_protection_rules WHERE deleted_at IS NULL').all();

    return {
      version: '1.0.0',
      backup_version: BACKUP_VERSION,
      exported_at: new Date().toISOString(),
      channels: channels.map(ch => ({
        ...ch,
        credentials: JSON.parse(ch.credentials || '{}'),
        supported_models: JSON.parse(ch.supported_models || '[]'),
        manual_models: JSON.parse(ch.manual_models || '[]'),
        tags: JSON.parse(ch.tags || '[]'),
        policies: JSON.parse(ch.policies || '{}'),
        settings: JSON.parse(ch.settings || '{}'),
      })),
      models: models.map(m => ({ ...m, model_card: JSON.parse(m.model_card || '{}'), settings: JSON.parse(m.settings || '{}') })),
      api_keys: apiKeys.map(k => ({ ...k, scopes: JSON.parse(k.scopes || '[]'), profiles: JSON.parse(k.profiles || '{}') })),
      roles: roles.map(r => ({ ...r, scopes: JSON.parse(r.scopes || '[]') })),
      system: Object.fromEntries(system.map(s => [s.key, s.value])),
      prompts,
      prompt_protection_rules: rules,
    };
  }

  importConfig(data) {
    const db = getDb();
    const transaction = db.transaction(() => {
      if (data.channels) {
        for (const ch of data.channels) {
          db.prepare(`
            INSERT OR REPLACE INTO channels (name, type, base_url, status, credentials, supported_models, manual_models, tags, default_test_model, policies, settings, ordering_weight, remark)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(ch.name, ch.type, ch.base_url || '', ch.status || 'enabled',
            JSON.stringify(ch.credentials || {}), JSON.stringify(ch.supported_models || []),
            JSON.stringify(ch.manual_models || []), JSON.stringify(ch.tags || []),
            ch.default_test_model || '', JSON.stringify(ch.policies || {}),
            JSON.stringify(ch.settings || {}), ch.ordering_weight || 0, ch.remark || null);
        }
      }

      if (data.models) {
        for (const m of data.models) {
          db.prepare(`
            INSERT OR IGNORE INTO models (model_id, developer, type, name, icon, model_group, model_card, settings, status, remark)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(m.model_id, m.developer || '', m.type || 'chat', m.name || m.model_id,
            m.icon || '', m.model_group || '', JSON.stringify(m.model_card || {}),
            JSON.stringify(m.settings || {}), m.status || 'enabled', m.remark || null);
        }
      }

      if (data.system) {
        for (const [key, value] of Object.entries(data.system)) {
          db.prepare("INSERT OR REPLACE INTO systems (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, String(value));
        }
      }
    });

    transaction();
    logger.info('Config imported successfully');
  }

  /**
   * Return the backups subdirectory path, creating it if needed.
   */
  _getBackupDir(basePath) {
    const dir = basePath || path.join(process.cwd(), 'backups');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  async saveToFile(filePath) {
    const data = this.exportConfig();
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, json, 'utf-8');
    logger.info(`Config exported to ${filePath}`);
    return filePath;
  }

  async loadFromFile(filePath) {
    const json = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(json);
    this.importConfig(data);
    return data;
  }

  /**
   * Schedule automatic backups at a given interval.
   * Defaults to every 24 hours (86400000 ms).
   * Each scheduled run saves to the backups/ subdirectory and prunes old files.
   */
  scheduleBackup(intervalMs = 86400000, backupDir) {
    this.stopScheduledBackup();

    const dir = this._getBackupDir(backupDir);

    const runBackup = async () => {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(dir, `backup-${timestamp}.json`);
        await this.saveToFile(filePath);
        this._pruneOldBackups(dir);
        logger.info(`Scheduled backup saved: ${filePath}`);
      } catch (err) {
        logger.error('Scheduled backup failed', { error: err.message });
      }
    };

    // Run an immediate backup, then repeat on interval
    runBackup();
    this._scheduledTimer = setInterval(runBackup, intervalMs);

    logger.info(`Backup schedule started: every ${intervalMs}ms`);
    return this._scheduledTimer;
  }

  /**
   * Stop the scheduled backup timer.
   */
  stopScheduledBackup() {
    if (this._scheduledTimer) {
      clearInterval(this._scheduledTimer);
      this._scheduledTimer = null;
    }
  }

  /**
   * List all available backup files in the backups/ directory,
   * sorted newest-first, with timestamps extracted from filenames.
   */
  listBackups(backupDir) {
    const dir = this._getBackupDir(backupDir);

    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
      .sort()
      .reverse();

    return files.map(filename => {
      const filePath = path.join(dir, filename);
      const stat = fs.statSync(filePath);
      // Extract timestamp portion from "backup-YYYY-MM-DDTHH-MM-SS-sssZ.json"
      const tsRaw = filename.replace('backup-', '').replace('.json', '');
      return {
        id: filename,
        filename,
        path: filePath,
        timestamp: tsRaw,
        size: stat.size,
        createdAt: stat.birthtime || stat.mtime,
      };
    });
  }

  /**
   * Return the current backup format version number.
   */
  getBackupVersion() {
    return BACKUP_VERSION;
  }

  /**
   * Restore the configuration from a specific backup identified by its id
   * (the filename returned by listBackups).
   */
  async restore(backupId, backupDir) {
    const dir = this._getBackupDir(backupDir);
    const filePath = path.join(dir, backupId);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    const data = await this.loadFromFile(filePath);
    logger.info(`Restored from backup: ${backupId}`);
    return data;
  }

  /**
   * Keep only the newest MAX_BACKUPS files, deleting older ones.
   */
  _pruneOldBackups(backupDir) {
    const dir = this._getBackupDir(backupDir);

    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length <= MAX_BACKUPS) return;

    const toDelete = files.slice(MAX_BACKUPS);
    for (const filename of toDelete) {
      const filePath = path.join(dir, filename);
      try {
        fs.unlinkSync(filePath);
        logger.info(`Pruned old backup: ${filename}`);
      } catch (err) {
        logger.error(`Failed to prune backup ${filename}`, { error: err.message });
      }
    }
  }
}

const backupService = new BackupService();

module.exports = { BackupService, backupService };
