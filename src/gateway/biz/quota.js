'use strict';

const Decimal = require('decimal.js');
const { getDb } = require('../db');
const logger = require('../logger');

// Lazy reference -- set by pipeline.js via setModelRegistry() to avoid
// circular-dependency issues at require time.
let _modelRegistry = null;

class QuotaService {
  constructor() {
    /** @type {Map<number, {level: number, ts: number}>} */
    this._warningState = new Map();
  }

  /**
   * Inject the model registry so quota auto-switch can walk fallback chains.
   * Called once from pipeline.js during initialisation.
   */
  static setModelRegistry(reg) {
    _modelRegistry = reg;
  }

  // ---------------------------------------------------------------
  // Existing quota check (unchanged)
  // ---------------------------------------------------------------

  checkAPIKeyQuota(apiKeyId, quota) {
    if (!quota) return { allowed: true };

    const db = getDb();
    const window = this.getQuotaWindow(quota.period);

    const usage = db.prepare(`
      SELECT COUNT(*) as request_count,
             COALESCE(SUM(total_tokens), 0) as total_tokens,
             COALESCE(SUM(CAST(cost AS REAL)), 0) as total_cost
      FROM usage_logs
      WHERE api_key_id = ? AND created_at >= ? AND created_at < ?
    `).get(apiKeyId, window.start, window.end);

    if (quota.max_requests && usage.request_count >= quota.max_requests) {
      return { allowed: false, message: `Request quota exceeded: ${usage.request_count}/${quota.max_requests}`, window };
    }
    if (quota.max_tokens && usage.total_tokens >= quota.max_tokens) {
      return { allowed: false, message: `Token quota exceeded: ${usage.total_tokens}/${quota.max_tokens}`, window };
    }
    if (quota.max_cost) {
      const cost = new Decimal(usage.total_cost);
      const maxCost = new Decimal(quota.max_cost);
      if (cost.gte(maxCost)) {
        return { allowed: false, message: `Cost quota exceeded: $${cost.toFixed(4)}/$${maxCost.toFixed(4)}`, window };
      }
    }

    return { allowed: true, window, usage: { request_count: usage.request_count, total_tokens: usage.total_tokens, total_cost: usage.total_cost } };
  }

  // ---------------------------------------------------------------
  // Quota auto-switch
  // ---------------------------------------------------------------

  /**
   * When quota is exceeded on `channel` for `model`, attempt to find an
   * alternative channel or fall back to a different model via the registry's
   * fallback chain.
   *
   * @param {object}  channel   - The channel that hit its quota limit
   * @param {string}  model     - The requested model name
   * @param {object}  quotaInfo - Result from checkAPIKeyQuota (has .message)
   * @returns {{ channel: object, model: string } | null}
   */
  handleQuotaExceeded(channel, model, quotaInfo) {
    const db = getDb();

    // 1. Try other channels that serve the same model
    const candidates = this._findAlternativeChannels(db, model, channel.id);
    for (const alt of candidates) {
      const altStatus = this.getQuotaStatus(alt.id);
      if (altStatus && altStatus.usagePercent < 100) {
        logger.info('[Quota Auto-Switch] switching channel', {
          from: channel.name, to: alt.name, model, reason: quotaInfo.message,
        });
        return { channel: alt, model };
      }
    }

    // 2. Walk the model fallback chain (if registry available)
    if (_modelRegistry) {
      const fallbacks = _modelRegistry.getFallbackChain(model);
      for (const fbModel of fallbacks) {
        const fbChannels = this._findAlternativeChannels(db, fbModel, null);
        for (const fbCh of fbChannels) {
          const fbStatus = this.getQuotaStatus(fbCh.id);
          if (!fbStatus || fbStatus.usagePercent < 100) {
            logger.info('[Quota Auto-Switch] switching model+channel via fallback', {
              fromModel: model, toModel: fbModel,
              fromChannel: channel.name, toChannel: fbCh.name,
              reason: quotaInfo.message,
            });
            return { channel: fbCh, model: fbModel };
          }
        }
      }
    }

    logger.warn('[Quota Auto-Switch] no alternative found', {
      channel: channel.name, model, reason: quotaInfo.message,
    });
    return null;
  }

  // ---------------------------------------------------------------
  // Channel quota status
  // ---------------------------------------------------------------

  /**
   * Return current usage vs limits for a channel, reading the
   * provider_quota_statuses table and comparing with live usage_logs.
   *
   * @param {number} channelId
   * @returns {{ channelId: number, quota: object|null, usage: object, usagePercent: number, warnings: string[] } | null}
   */
  getQuotaStatus(channelId) {
    const db = getDb();

    const quotaRow = db.prepare(
      `SELECT quota_data FROM provider_quota_statuses WHERE channel_id = ?`
    ).get(channelId);

    const quotaData = quotaRow ? JSON.parse(quotaRow.quota_data || '{}') : {};

    const window = this.getQuotaWindow(quotaData.period || 'daily');
    const usage = db.prepare(`
      SELECT COUNT(*) as request_count,
             COALESCE(SUM(total_tokens), 0) as total_tokens,
             COALESCE(SUM(CAST(cost AS REAL)), 0) as total_cost
      FROM usage_logs
      WHERE channel_id = ? AND created_at >= ? AND created_at < ?
    `).get(channelId, window.start, window.end);

    // Compute a single usage percentage based on whichever limit is set
    let usagePercent = 0;
    if (quotaData.max_requests && quotaData.max_requests > 0) {
      usagePercent = Math.max(usagePercent, (usage.request_count / quotaData.max_requests) * 100);
    }
    if (quotaData.max_tokens && quotaData.max_tokens > 0) {
      usagePercent = Math.max(usagePercent, (usage.total_tokens / quotaData.max_tokens) * 100);
    }
    if (quotaData.max_cost && Number(quotaData.max_cost) > 0) {
      const cost = new Decimal(usage.total_cost);
      const maxCost = new Decimal(quotaData.max_cost);
      usagePercent = Math.max(usagePercent, cost.div(maxCost).mul(100).toNumber());
    }

    // Emit threshold warnings (80% / 90%)
    const warnings = this._checkThresholdWarnings(channelId, usagePercent);

    return { channelId, quota: quotaData, usage, usagePercent, warnings };
  }

  // ---------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------

  /**
   * Emit log warnings when a channel crosses 80% or 90% of its quota.
   * Each threshold fires only once per quota window to avoid log spam.
   *
   * @param {number} channelId
   * @param {number} pct - current usage percentage
   * @returns {string[]} list of warning labels emitted this call
   */
  _checkThresholdWarnings(channelId, pct) {
    const prev = this._warningState.get(channelId) || { level: 0, ts: 0 };
    const warnings = [];

    if (pct >= 90 && prev.level < 90) {
      logger.warn(`[Quota Warning] channel ${channelId} reached 90% quota usage`);
      this._warningState.set(channelId, { level: 90, ts: Date.now() });
      warnings.push('90%');
    } else if (pct >= 80 && prev.level < 80) {
      logger.warn(`[Quota Warning] channel ${channelId} reached 80% quota usage`);
      this._warningState.set(channelId, { level: 80, ts: Date.now() });
      warnings.push('80%');
    }

    return warnings;
  }

  /**
   * Find enabled channels that support `model`, excluding a specific channel id.
   */
  _findAlternativeChannels(db, model, excludeChannelId) {
    const rows = db.prepare(`
      SELECT * FROM channels
      WHERE status = 'enabled' AND deleted_at IS NULL
      ORDER BY ordering_weight DESC, id ASC
    `).all();

    const results = [];
    for (const row of rows) {
      const ch = this._parseChannel(row);
      if (excludeChannelId != null && ch.id === excludeChannelId) continue;
      const allModels = [...(ch.supported_models || []), ...(ch.manual_models || [])];
      if (allModels.includes(model)) {
        results.push(ch);
        continue;
      }
      for (const m of allModels) {
        if (m.endsWith('*') && model.startsWith(m.slice(0, -1))) {
          results.push(ch);
          break;
        }
      }
    }
    return results;
  }

  _parseChannel(row) {
    return {
      ...row,
      credentials: JSON.parse(row.credentials || '{}'),
      supported_models: JSON.parse(row.supported_models || '[]'),
      manual_models: JSON.parse(row.manual_models || '[]'),
      tags: JSON.parse(row.tags || '[]'),
      policies: JSON.parse(row.policies || '{}'),
      settings: JSON.parse(row.settings || '{}'),
    };
  }

  getQuotaWindow(period) {
    const now = new Date();
    let start, end;

    switch (period) {
      case 'hourly':
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
        end = new Date(start.getTime() + 60 * 60 * 1000);
        break;
      case 'daily':
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
        break;
      case 'weekly': {
        const dayOfWeek = now.getDay();
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
        end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
        break;
      }
      case 'monthly':
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        break;
      default:
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    }

    return { start: start.toISOString(), end: end.toISOString() };
  }

  getAPIKeyUsage(apiKeyId, period) {
    const db = getDb();
    const window = this.getQuotaWindow(period || 'daily');

    const usage = db.prepare(`
      SELECT COUNT(*) as request_count,
             COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) as completion_tokens,
             COALESCE(SUM(total_tokens), 0) as total_tokens,
             COALESCE(SUM(CAST(cost AS REAL)), 0) as total_cost
      FROM usage_logs
      WHERE api_key_id = ? AND created_at >= ? AND created_at < ?
    `).get(apiKeyId, window.start, window.end);

    return { window, usage };
  }
}

const quotaService = new QuotaService();

module.exports = { QuotaService, quotaService };
