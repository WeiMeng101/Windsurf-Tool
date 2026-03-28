'use strict';

/**
 * Schema-based configuration validator.
 *
 * Each rule describes a config path, expected type, and optional constraints
 * (range, enum, pattern). The validator walks the provided config object and
 * collects all violations so they can be reported in one pass.
 */

const RULES = [
  // ---- server ----
  { path: 'server.host', type: 'string', required: true },
  { path: 'server.port', type: 'number', required: true, min: 1, max: 65535 },
  { path: 'server.tls.enable', type: 'boolean' },
  { path: 'server.tls.cert', type: 'string' },
  { path: 'server.tls.key', type: 'string' },

  // ---- gateway ----
  { path: 'gateway.maxRetries', type: 'number', min: 0, max: 100 },
  { path: 'gateway.maxRetryInterval', type: 'number', min: 0 },
  { path: 'gateway.routingStrategy', type: 'string', enum: ['health-first', 'round-robin', 'random', 'least-latency'] },
  { path: 'gateway.proxyUrl', type: 'string' },
  { path: 'gateway.passthroughHeaders', type: 'boolean' },
  { path: 'gateway.nonStreamKeepalive', type: 'number', min: 0 },
  { path: 'gateway.streaming.keepaliveSeconds', type: 'number', min: 0 },
  { path: 'gateway.streaming.bootstrapRetries', type: 'number', min: 0 },
  { path: 'gateway.wsAuth', type: 'boolean' },

  // ---- pool ----
  { path: 'pool.healthCheckInterval', type: 'number', min: 1000 },
  { path: 'pool.bufferSize', type: 'number', min: 1 },
  { path: 'pool.autoRecovery', type: 'boolean' },

  // ---- quota ----
  { path: 'quota.autoSwitch', type: 'boolean' },
  { path: 'quota.warningThreshold', type: 'number', min: 0, max: 1 },
  { path: 'quota.switchPreviewModel', type: 'boolean' },

  // ---- security ----
  { path: 'security.cloaking.enabled', type: 'boolean' },
  { path: 'security.rateLimitPerMinute', type: 'number', min: 0 },
  { path: 'security.auditLog', type: 'boolean' },

  // ---- statistics ----
  { path: 'statistics.enabled', type: 'boolean' },

  // ---- logging ----
  { path: 'logging.toFile', type: 'boolean' },
  { path: 'logging.level', type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
];

/**
 * Resolve a dot-notation path against an object.
 * Returns `undefined` when any segment is missing.
 */
function resolvePath(obj, dotPath) {
  const segments = dotPath.split('.');
  let current = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[seg];
  }
  return current;
}

class ConfigValidator {
  constructor(extraRules) {
    this.rules = extraRules ? [...RULES, ...extraRules] : RULES;
  }

  /**
   * Validate a config object against the schema rules.
   * @param {object} config
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate(config) {
    const errors = [];

    for (const rule of this.rules) {
      const value = resolvePath(config, rule.path);

      // Required check
      if (rule.required && (value === undefined || value === null)) {
        errors.push(`Missing required config: ${rule.path}`);
        continue;
      }

      // Skip optional fields that are absent
      if (value === undefined || value === null) continue;

      // Type check
      if (rule.type && typeof value !== rule.type) {
        errors.push(
          `Invalid type for ${rule.path}: expected ${rule.type}, got ${typeof value}`
        );
        continue;
      }

      // Numeric range
      if (rule.type === 'number') {
        if (rule.min !== undefined && value < rule.min) {
          errors.push(`${rule.path} must be >= ${rule.min} (got ${value})`);
        }
        if (rule.max !== undefined && value > rule.max) {
          errors.push(`${rule.path} must be <= ${rule.max} (got ${value})`);
        }
      }

      // Enum check
      if (rule.enum && !rule.enum.includes(value)) {
        errors.push(
          `${rule.path} must be one of [${rule.enum.join(', ')}] (got "${value}")`
        );
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

module.exports = ConfigValidator;
