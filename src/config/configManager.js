'use strict';

const fs = require('fs');
const path = require('path');
const ConfigValidator = require('./configValidator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep-merge `sources` into `target` (left to right, later wins).
 * Arrays are replaced, not concatenated.
 */
function deepMerge(target, ...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of Object.keys(source)) {
      const srcVal = source[key];
      const tgtVal = target[key];
      if (
        srcVal &&
        typeof srcVal === 'object' &&
        !Array.isArray(srcVal) &&
        tgtVal &&
        typeof tgtVal === 'object' &&
        !Array.isArray(tgtVal)
      ) {
        target[key] = deepMerge({ ...tgtVal }, srcVal);
      } else {
        target[key] = srcVal;
      }
    }
  }
  return target;
}

/**
 * Get a value from `obj` using a dot-notation `path`.
 * Returns `defaultValue` when any segment is missing.
 */
function getByPath(obj, dotPath, defaultValue) {
  const segments = dotPath.split('.');
  let current = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== 'object') return defaultValue;
    current = current[seg];
  }
  return current === undefined ? defaultValue : current;
}

/**
 * Set a value on `obj` at the given dot-notation `path`,
 * creating intermediate objects as needed.
 */
function setByPath(obj, dotPath, value) {
  const segments = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (current[seg] == null || typeof current[seg] !== 'object') {
      current[seg] = {};
    }
    current = current[seg];
  }
  current[segments[segments.length - 1]] = value;
}

/**
 * Map from flat ENV var names to config dot-paths.
 * Values coming from the environment are coerced to the correct type based on
 * the default value at the corresponding path.
 */
const ENV_MAP = {
  // server
  GATEWAY_HOST:                      'server.host',
  GATEWAY_PORT:                      'server.port',
  GATEWAY_TLS_ENABLE:                'server.tls.enable',
  GATEWAY_TLS_CERT:                  'server.tls.cert',
  GATEWAY_TLS_KEY:                   'server.tls.key',
  // gateway
  GATEWAY_MAX_RETRIES:               'gateway.maxRetries',
  GATEWAY_MAX_RETRY_INTERVAL:        'gateway.maxRetryInterval',
  GATEWAY_ROUTING_STRATEGY:          'gateway.routingStrategy',
  GATEWAY_PROXY_URL:                 'gateway.proxyUrl',
  GATEWAY_PASSTHROUGH_HEADERS:       'gateway.passthroughHeaders',
  GATEWAY_NON_STREAM_KEEPALIVE:      'gateway.nonStreamKeepalive',
  GATEWAY_STREAMING_KEEPALIVE:       'gateway.streaming.keepaliveSeconds',
  GATEWAY_STREAMING_BOOTSTRAP_RETRIES: 'gateway.streaming.bootstrapRetries',
  GATEWAY_WS_AUTH:                   'gateway.wsAuth',
  // pool
  POOL_HEALTH_CHECK_INTERVAL:        'pool.healthCheckInterval',
  POOL_BUFFER_SIZE:                  'pool.bufferSize',
  POOL_AUTO_RECOVERY:                'pool.autoRecovery',
  // quota
  QUOTA_AUTO_SWITCH:                 'quota.autoSwitch',
  QUOTA_WARNING_THRESHOLD:           'quota.warningThreshold',
  QUOTA_SWITCH_PREVIEW_MODEL:        'quota.switchPreviewModel',
  // security
  SECURITY_CLOAKING_ENABLED:         'security.cloaking.enabled',
  SECURITY_RATE_LIMIT:               'security.rateLimitPerMinute',
  SECURITY_AUDIT_LOG:                'security.auditLog',
  // statistics
  STATISTICS_ENABLED:                'statistics.enabled',
  // logging
  LOGGING_TO_FILE:                   'logging.toFile',
  LOGGING_LEVEL:                     'logging.level',
  // auth (pass-through, no coercion needed)
  WORKER_SECRET_KEY:                 'auth.workerSecretKey',
  FIREBASE_API_KEY:                  'auth.firebaseApiKey',
};

/**
 * Coerce a string value from the environment into the correct JS type by
 * inspecting the existing default at the same path.
 */
function coerceEnvValue(stringValue, configPath, defaults) {
  const defaultVal = getByPath(defaults, configPath);
  if (typeof defaultVal === 'number')  return Number(stringValue);
  if (typeof defaultVal === 'boolean') return stringValue === 'true' || stringValue === '1';
  return stringValue; // keep as string
}

// ---------------------------------------------------------------------------
// ConfigManager
// ---------------------------------------------------------------------------

class ConfigManager {
  constructor() {
    /** @type {object} Merged configuration */
    this.config = {};
    /** @type {fs.FSWatcher[]} Active file watchers */
    this._watchers = [];
    /** @type {Map<string, Set<Function>>} key -> callback set */
    this._listeners = new Map();
    /** @type {ConfigValidator} */
    this._validator = new ConfigValidator();
    /** @type {string|null} Path to the loaded config file */
    this._configFilePath = null;
  }

  // ---- Defaults ----

  getDefaults() {
    return {
      server: {
        host: '127.0.0.1',
        port: 18371,
        tls: { enable: false, cert: '', key: '' },
      },
      gateway: {
        maxRetries: 3,
        maxRetryInterval: 30,
        routingStrategy: 'health-first',
        proxyUrl: '',
        passthroughHeaders: false,
        nonStreamKeepalive: 0,
        streaming: { keepaliveSeconds: 15, bootstrapRetries: 1 },
        wsAuth: false,
      },
      pool: {
        healthCheckInterval: 300000,
        bufferSize: 10,
        autoRecovery: true,
      },
      quota: {
        autoSwitch: true,
        warningThreshold: 0.8,
        switchPreviewModel: true,
      },
      security: {
        cloaking: { enabled: false },
        rateLimitPerMinute: 60,
        auditLog: true,
      },
      statistics: { enabled: true },
      logging: { toFile: false, level: 'info' },
      auth: { workerSecretKey: '', firebaseApiKey: '' },
    };
  }

  // ---- Load ----

  /**
   * Load configuration from multiple sources with priority:
   *   env vars  >  config file  >  built-in defaults
   *
   * @param {string} [configPath] - Optional path to a JSON config file.
   * @returns {object} The merged config.
   */
  load(configPath) {
    const defaults = this.getDefaults();
    const fileConfig = this._loadFromFile(configPath);
    const envConfig = this._loadFromEnv(defaults);
    this.config = deepMerge({}, defaults, fileConfig, envConfig);

    if (configPath) {
      this._configFilePath = path.resolve(configPath);
    }

    this.validate();
    return this.config;
  }

  /**
   * Read a JSON config file. Returns `{}` when the file does not exist or is
   * unparseable (a warning is logged instead of throwing).
   */
  _loadFromFile(configPath) {
    if (!configPath) return {};
    try {
      const resolved = path.resolve(configPath);
      const raw = fs.readFileSync(resolved, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[ConfigManager] Failed to read config file: ${err.message}`);
      }
      return {};
    }
  }

  /**
   * Build a partial config object from environment variables using the
   * ENV_MAP lookup table.
   */
  _loadFromEnv(defaults) {
    const envConfig = {};
    for (const [envKey, configPath] of Object.entries(ENV_MAP)) {
      const envVal = process.env[envKey];
      if (envVal !== undefined && envVal !== '') {
        setByPath(envConfig, configPath, coerceEnvValue(envVal, configPath, defaults));
      }
    }
    return envConfig;
  }

  // ---- Accessors ----

  /**
   * Get a config value by dot-notation path.
   * @param {string} dotPath  e.g. 'gateway.port' or 'server.tls.enable'
   * @param {*} [defaultValue]
   * @returns {*}
   */
  get(dotPath, defaultValue) {
    return getByPath(this.config, dotPath, defaultValue);
  }

  /**
   * Set a config value by dot-notation path.
   * Notifies all registered listeners whose key is a prefix of the changed path.
   * @param {string} dotPath
   * @param {*} value
   */
  set(dotPath, value) {
    const oldValue = this.get(dotPath);
    setByPath(this.config, dotPath, value);
    if (oldValue !== value) {
      this._notifyListeners(dotPath, value, oldValue);
    }
  }

  // ---- Watchers (hot-reload) ----

  /**
   * Start watching a config file for changes.  On change the file is re-read,
   * merged onto the current config, validated, and listeners are notified.
   *
   * @param {string} [configPath] Falls back to the path used in `load()`.
   */
  watch(configPath) {
    const target = configPath
      ? path.resolve(configPath)
      : this._configFilePath;

    if (!target) {
      console.warn('[ConfigManager] No config file path to watch');
      return;
    }

    // Avoid watching the same path twice
    if (this._watchers.some(w => w._cfgPath === target)) return;

    let debounce = null;
    try {
      const watcher = fs.watch(target, { persistent: false }, (eventType) => {
        if (eventType !== 'change') return;
        // Debounce rapid writes (editors often do atomic-save = delete + create)
        clearTimeout(debounce);
        debounce = setTimeout(() => this._onFileChange(target), 250);
      });
      watcher._cfgPath = target;
      this._watchers.push(watcher);
    } catch (err) {
      console.warn(`[ConfigManager] Could not watch ${target}: ${err.message}`);
    }
  }

  /**
   * Internal handler invoked when the watched file changes on disk.
   */
  _onFileChange(filePath) {
    try {
      const freshFile = this._loadFromFile(filePath);
      const defaults = this.getDefaults();
      const envConfig = this._loadFromEnv(defaults);
      const oldConfig = this.config;
      this.config = deepMerge({}, defaults, freshFile, envConfig);

      const result = this.validate();
      if (!result.valid) {
        console.warn('[ConfigManager] Hot-reload validation warnings:', result.errors);
      }

      // Diff top-level keys and notify
      this._diffAndNotify(oldConfig, this.config, '');
      console.log(`[ConfigManager] Config hot-reloaded from ${filePath}`);
    } catch (err) {
      console.error(`[ConfigManager] Hot-reload failed: ${err.message}`);
    }
  }

  /**
   * Walk two config trees and fire listeners for every changed leaf.
   */
  _diffAndNotify(oldObj, newObj, prefix) {
    const allKeys = new Set([
      ...Object.keys(oldObj || {}),
      ...Object.keys(newObj || {}),
    ]);
    for (const key of allKeys) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      const oldVal = oldObj ? oldObj[key] : undefined;
      const newVal = newObj ? newObj[key] : undefined;
      if (
        newVal &&
        typeof newVal === 'object' &&
        !Array.isArray(newVal)
      ) {
        this._diffAndNotify(oldVal || {}, newVal, fullPath);
      } else if (oldVal !== newVal) {
        this._notifyListeners(fullPath, newVal, oldVal);
      }
    }
  }

  /**
   * Stop all file watchers.
   */
  unwatch() {
    for (const w of this._watchers) {
      try { w.close(); } catch (_) { /* ignore */ }
    }
    this._watchers = [];
  }

  // ---- Listeners ----

  /**
   * Register a callback to be invoked when a config key (or any descendant)
   * changes.
   *
   * @param {string} key   Dot-notation prefix, e.g. 'gateway' or 'server.port'
   * @param {Function} callback  `(newValue, oldValue, path) => void`
   * @returns {Function} An unsubscribe function.
   */
  onChange(key, callback) {
    if (!this._listeners.has(key)) {
      this._listeners.set(key, new Set());
    }
    this._listeners.get(key).add(callback);
    return () => {
      const set = this._listeners.get(key);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this._listeners.delete(key);
      }
    };
  }

  /**
   * Notify listeners whose registered key is a prefix of (or equal to) the
   * changed path.
   */
  _notifyListeners(changedPath, newValue, oldValue) {
    for (const [key, callbacks] of this._listeners) {
      if (changedPath === key || changedPath.startsWith(key + '.')) {
        for (const cb of callbacks) {
          try {
            cb(newValue, oldValue, changedPath);
          } catch (err) {
            console.error(`[ConfigManager] Listener error for "${key}":`, err);
          }
        }
      }
    }
  }

  // ---- Validation ----

  /**
   * Validate the current config.
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate() {
    return this._validator.validate(this.config);
  }

  // ---- Lifecycle ----

  /**
   * Convenience: tear down watchers and listeners.
   */
  destroy() {
    this.unwatch();
    this._listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------
const instance = new ConfigManager();

module.exports = instance;
module.exports.ConfigManager = ConfigManager;
