'use strict';

const Decimal = require('decimal.js');
const { getDb } = require('../db');

class QuotaService {
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
