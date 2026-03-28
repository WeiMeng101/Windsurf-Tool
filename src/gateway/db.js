'use strict';

const path = require('path');
const { app } = require('electron');

let Database;
let databaseLoadError = null;
try {
  Database = require('better-sqlite3');
} catch (e) {
  databaseLoadError = e;
  console.error('Failed to load better-sqlite3:', e.message);
}

let db = null;

function getDbPath() {
  const userDataPath = app ? app.getPath('userData') : path.join(__dirname, '..', '..');
  return path.join(userDataPath, 'gateway.db');
}

function getDb() {
  if (db) return db;
  if (!Database) {
    const error = new Error(
      `better-sqlite3 未能按当前 Electron 运行时加载，请执行 "npm run rebuild:native" ` +
      `(内部会调用 "electron-builder install-app-deps") 后重新启动应用。` +
      (databaseLoadError?.message ? ` 原始错误: ${databaseLoadError.message}` : '')
    );
    error.cause = databaseLoadError;
    throw error;
  }

  const dbPath = getDbPath();
  db = new Database(dbPath, { verbose: null });

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function runMigrations(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    database.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
  );

  for (const migration of migrations) {
    if (!applied.has(migration.version)) {
      database.transaction(() => {
        database.exec(migration.sql);
        database.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
      })();
      console.log(`[Gateway DB] Applied migration v${migration.version}: ${migration.name}`);
    }
  }
}

const migrations = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      -- System settings (key-value store)
      CREATE TABLE IF NOT EXISTS systems (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Users
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL DEFAULT '',
        first_name TEXT DEFAULT '',
        last_name TEXT DEFAULT '',
        avatar TEXT DEFAULT '',
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('owner','admin','user')),
        status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled','archived')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT
      );

      -- Roles
      CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        scopes TEXT DEFAULT '[]',
        is_system INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT,
        UNIQUE(name, deleted_at)
      );

      -- Projects
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled','archived')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT,
        UNIQUE(name, deleted_at)
      );

      -- Channels (AI provider connections)
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('enabled','disabled','archived')),
        credentials TEXT DEFAULT '{}',
        supported_models TEXT DEFAULT '[]',
        manual_models TEXT DEFAULT '[]',
        auto_sync_supported_models INTEGER DEFAULT 0,
        auto_sync_model_pattern TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        default_test_model TEXT DEFAULT '',
        policies TEXT DEFAULT '{}',
        settings TEXT DEFAULT '{}',
        ordering_weight INTEGER DEFAULT 0,
        error_message TEXT,
        remark TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT,
        UNIQUE(name, deleted_at)
      );

      -- Models
      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        developer TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'chat' CHECK(type IN ('chat','embedding','rerank','image_generation','video_generation')),
        name TEXT NOT NULL DEFAULT '',
        icon TEXT DEFAULT '',
        model_group TEXT DEFAULT '',
        model_card TEXT DEFAULT '{}',
        settings TEXT DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('enabled','disabled','archived')),
        remark TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT,
        UNIQUE(model_id, deleted_at)
      );

      -- API Keys
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 1,
        project_id INTEGER NOT NULL DEFAULT 1,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'user' CHECK(type IN ('user','service_account','noauth')),
        status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled','archived')),
        scopes TEXT DEFAULT '["read_channels","write_requests"]',
        profiles TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      -- Traces
      CREATE TABLE IF NOT EXISTS traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL DEFAULT 1,
        thread_id INTEGER,
        external_trace_id TEXT DEFAULT '',
        name TEXT DEFAULT '',
        metadata TEXT DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS idx_traces_project ON traces(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_traces_thread ON traces(thread_id);
      CREATE INDEX IF NOT EXISTS idx_traces_external ON traces(external_trace_id);

      -- Threads
      CREATE TABLE IF NOT EXISTS threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL DEFAULT 1,
        external_thread_id TEXT DEFAULT '',
        name TEXT DEFAULT '',
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_threads_external ON threads(external_thread_id);

      -- Requests
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key_id INTEGER,
        project_id INTEGER NOT NULL DEFAULT 1,
        trace_id INTEGER,
        channel_id INTEGER,
        source TEXT NOT NULL DEFAULT 'api' CHECK(source IN ('api','playground','test')),
        model_id TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL DEFAULT 'openai/chat_completions',
        request_headers TEXT DEFAULT '{}',
        request_body TEXT DEFAULT '{}',
        response_body TEXT,
        response_chunks TEXT,
        external_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed','canceled')),
        stream INTEGER DEFAULT 0,
        client_ip TEXT DEFAULT '',
        metrics_latency_ms INTEGER,
        metrics_first_token_latency_ms INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (api_key_id) REFERENCES api_keys(id),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (trace_id) REFERENCES traces(id),
        FOREIGN KEY (channel_id) REFERENCES channels(id)
      );
      CREATE INDEX IF NOT EXISTS idx_requests_apikey ON requests(api_key_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_requests_project ON requests(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_requests_channel ON requests(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_requests_trace ON requests(trace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at);

      -- Request Executions (individual attempts for retry tracking)
      CREATE TABLE IF NOT EXISTS request_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        attempt_number INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed')),
        response_status_code INTEGER,
        error_message TEXT,
        latency_ms INTEGER,
        first_token_latency_ms INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (request_id) REFERENCES requests(id),
        FOREIGN KEY (channel_id) REFERENCES channels(id)
      );
      CREATE INDEX IF NOT EXISTS idx_executions_request ON request_executions(request_id);
      CREATE INDEX IF NOT EXISTS idx_executions_channel ON request_executions(channel_id, created_at);

      -- Usage Logs
      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER,
        api_key_id INTEGER,
        project_id INTEGER NOT NULL DEFAULT 1,
        channel_id INTEGER,
        model_id TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0,
        cost TEXT DEFAULT '0',
        cost_items TEXT DEFAULT '[]',
        currency TEXT DEFAULT 'USD',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (request_id) REFERENCES requests(id),
        FOREIGN KEY (api_key_id) REFERENCES api_keys(id),
        FOREIGN KEY (channel_id) REFERENCES channels(id)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_apikey ON usage_logs(api_key_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_logs(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_channel ON usage_logs(channel_id, created_at);

      -- Channel Model Prices
      CREATE TABLE IF NOT EXISTS channel_model_prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL,
        model_id TEXT NOT NULL DEFAULT '',
        price TEXT DEFAULT '{}',
        source TEXT DEFAULT 'manual' CHECK(source IN ('manual','auto','reference')),
        reference_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (channel_id) REFERENCES channels(id),
        UNIQUE(channel_id, model_id)
      );

      -- Channel Probes (health check results)
      CREATE TABLE IF NOT EXISTS channel_probes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL,
        model_id TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed')),
        latency_ms INTEGER,
        error_message TEXT,
        response_body TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (channel_id) REFERENCES channels(id)
      );
      CREATE INDEX IF NOT EXISTS idx_probes_channel ON channel_probes(channel_id, created_at);

      -- Channel Override Templates
      CREATE TABLE IF NOT EXISTS channel_override_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        operations TEXT DEFAULT '[]',
        headers TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Provider Quota Status
      CREATE TABLE IF NOT EXISTS provider_quota_statuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER NOT NULL UNIQUE,
        quota_data TEXT DEFAULT '{}',
        checked_at TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (channel_id) REFERENCES channels(id)
      );

      -- Prompts
      CREATE TABLE IF NOT EXISTS prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL DEFAULT 1,
        name TEXT NOT NULL,
        content TEXT DEFAULT '',
        type TEXT NOT NULL DEFAULT 'system' CHECK(type IN ('system','user','assistant')),
        model_pattern TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled')),
        ordering INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      -- Prompt Protection Rules
      CREATE TABLE IF NOT EXISTS prompt_protection_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        type TEXT NOT NULL DEFAULT 'keyword' CHECK(type IN ('keyword','regex','semantic')),
        pattern TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT 'block' CHECK(action IN ('block','warn','replace')),
        replacement TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled')),
        ordering INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT
      );

      -- Data Storages (external storage config)
      CREATE TABLE IF NOT EXISTS data_storages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'local' CHECK(type IN ('local','s3','gcs','azure')),
        config TEXT DEFAULT '{}',
        is_primary INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT,
        UNIQUE(name, deleted_at)
      );

      -- User-Project associations
      CREATE TABLE IF NOT EXISTS user_projects (
        user_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        role TEXT DEFAULT 'member',
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, project_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );

      -- User-Role associations
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id INTEGER NOT NULL,
        role_id INTEGER NOT NULL,
        project_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, role_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (role_id) REFERENCES roles(id)
      );

      -- Seed default data
      INSERT OR IGNORE INTO projects (id, name, description) VALUES (1, 'Default', 'Default project');
      INSERT OR IGNORE INTO users (id, email, role) VALUES (1, 'admin@localhost', 'owner');
      INSERT OR IGNORE INTO systems (key, value) VALUES ('system_initialized', 'true');
      INSERT OR IGNORE INTO systems (key, value) VALUES ('system_version', '1.0.0');
      INSERT OR IGNORE INTO systems (key, value) VALUES ('system_brand_name', 'Windsurf Gateway');

      -- Default roles
      INSERT OR IGNORE INTO roles (id, name, description, scopes, is_system) VALUES
        (1, 'admin', 'Full system access', '["*"]', 1),
        (2, 'operator', 'Manage channels and keys', '["read_channels","write_channels","read_api_keys","write_api_keys","read_requests","read_models","write_models"]', 1),
        (3, 'viewer', 'Read-only access', '["read_channels","read_requests","read_models","read_api_keys"]', 1);
    `
  },
  {
    version: 2,
    name: 'pool_accounts',
    sql: `
      CREATE TABLE IF NOT EXISTS pool_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_type TEXT NOT NULL DEFAULT 'windsurf'
          CHECK(provider_type IN ('windsurf','codex','openai','anthropic','gemini',
            'deepseek','moonshot','doubao','zhipu','openrouter','xai',
            'siliconflow','ppio','claudecode','other')),
        email TEXT DEFAULT '',
        display_name TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'available'
          CHECK(status IN ('available','in_use','error','cooldown','disabled')),
        credentials TEXT DEFAULT '{}',
        health_score REAL DEFAULT 100.0,
        success_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        total_requests INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_error TEXT DEFAULT '',
        cooldown_until TEXT,
        tags TEXT DEFAULT '[]',
        remark TEXT DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual'
          CHECK(source IN ('manual','registration','import','codex')),
        source_ref TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pool_status ON pool_accounts(status, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_pool_provider ON pool_accounts(provider_type, deleted_at);
      CREATE TABLE IF NOT EXISTS pool_status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_account_id INTEGER NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        reason TEXT DEFAULT '',
        triggered_by TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (pool_account_id) REFERENCES pool_accounts(id)
      );
      CREATE INDEX IF NOT EXISTS idx_status_history_account ON pool_status_history(pool_account_id, created_at);
    `
  }
];

module.exports = { getDb, closeDb, getDbPath };
