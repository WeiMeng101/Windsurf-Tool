'use strict';

const logger = require('../logger');

class LoadBalancer {
  constructor() {
    this.channelMetrics = new Map();
    this.channelErrors = new Map();
    this.apiKeyErrors = new Map();
  }

  selectChannel(channels, model) {
    if (!channels || channels.length === 0) return null;
    if (channels.length === 1) return channels[0];

    const scored = channels.map(ch => ({
      channel: ch,
      score: this.calculateScore(ch),
    }));

    scored.sort((a, b) => b.score - a.score);

    const topScore = scored[0].score;
    const topCandidates = scored.filter(s => s.score >= topScore * 0.9);

    const idx = Math.floor(Math.random() * topCandidates.length);
    return topCandidates[idx].channel;
  }

  sortChannels(channels) {
    return [...channels].sort((a, b) => {
      const scoreA = this.calculateScore(a);
      const scoreB = this.calculateScore(b);
      return scoreB - scoreA;
    });
  }

  calculateScore(channel) {
    let score = 100;

    score += (channel.ordering_weight || 0);

    const metrics = this.channelMetrics.get(channel.id);
    if (metrics) {
      const successRate = metrics.totalRequests > 0
        ? metrics.successCount / metrics.totalRequests
        : 1;
      score += successRate * 50;

      if (metrics.avgLatencyMs > 0) {
        score -= Math.min(metrics.avgLatencyMs / 100, 30);
      }

      if (metrics.recentErrorCount > 0) {
        score -= metrics.recentErrorCount * 10;
      }
    }

    return score;
  }

  recordSuccess(channelId, latencyMs) {
    const metrics = this.getOrCreateMetrics(channelId);
    metrics.totalRequests++;
    metrics.successCount++;
    metrics.totalLatencyMs += latencyMs;
    metrics.avgLatencyMs = metrics.totalLatencyMs / metrics.successCount;
    metrics.lastSuccessAt = Date.now();
    metrics.recentErrorCount = Math.max(0, metrics.recentErrorCount - 1);
  }

  recordFailure(channelId, statusCode) {
    const metrics = this.getOrCreateMetrics(channelId);
    metrics.totalRequests++;
    metrics.failureCount++;
    metrics.recentErrorCount++;
    metrics.lastFailureAt = Date.now();

    const errors = this.channelErrors.get(channelId) || {};
    errors[statusCode] = (errors[statusCode] || 0) + 1;
    this.channelErrors.set(channelId, errors);
  }

  getOrCreateMetrics(channelId) {
    if (!this.channelMetrics.has(channelId)) {
      this.channelMetrics.set(channelId, {
        totalRequests: 0,
        successCount: 0,
        failureCount: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
        recentErrorCount: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
      });
    }
    return this.channelMetrics.get(channelId);
  }

  shouldDisableChannel(channelId, policy) {
    const threshold = policy?.autoDisableThreshold || 5;
    const errors = this.channelErrors.get(channelId) || {};
    const unrecoverableCodes = [401, 403];
    for (const code of unrecoverableCodes) {
      if ((errors[code] || 0) >= threshold) return true;
    }
    const metrics = this.channelMetrics.get(channelId);
    if (metrics && metrics.recentErrorCount >= threshold * 2) return true;
    return false;
  }

  getChannelStats(channelId) {
    return this.channelMetrics.get(channelId) || null;
  }

  getAllStats() {
    const result = {};
    for (const [id, metrics] of this.channelMetrics) {
      result[id] = { ...metrics };
    }
    return result;
  }

  reset(channelId) {
    if (channelId) {
      this.channelMetrics.delete(channelId);
      this.channelErrors.delete(channelId);
    } else {
      this.channelMetrics.clear();
      this.channelErrors.clear();
    }
  }
}

class CircuitBreaker {
  constructor(options = {}) {
    this.threshold = options.threshold || 5;
    this.resetTimeout = options.resetTimeout || 60000;
    this.circuits = new Map();
  }

  isOpen(key) {
    const circuit = this.circuits.get(key);
    if (!circuit) return false;
    if (circuit.state === 'open') {
      if (Date.now() - circuit.openedAt > this.resetTimeout) {
        circuit.state = 'half-open';
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(key) {
    const circuit = this.circuits.get(key);
    if (circuit) {
      circuit.failureCount = 0;
      circuit.state = 'closed';
    }
  }

  recordFailure(key) {
    if (!this.circuits.has(key)) {
      this.circuits.set(key, { failureCount: 0, state: 'closed', openedAt: null });
    }
    const circuit = this.circuits.get(key);
    circuit.failureCount++;
    if (circuit.failureCount >= this.threshold) {
      circuit.state = 'open';
      circuit.openedAt = Date.now();
      logger.warn(`Circuit breaker opened for: ${key}`);
    }
  }

  reset(key) {
    if (key) {
      this.circuits.delete(key);
    } else {
      this.circuits.clear();
    }
  }
}

class ModelMatcher {
  static match(associations, channels) {
    const result = [];
    const seen = new Set();

    for (const assoc of associations) {
      if (assoc.disabled) continue;

      for (const channel of channels) {
        const models = ModelMatcher.matchAssociation(assoc, channel);
        for (const entry of models) {
          const key = `${channel.id}:${entry.requestModel}`;
          if (!seen.has(key)) {
            seen.add(key);
            result.push({ channel, model: entry, priority: assoc.priority || 0 });
          }
        }
      }
    }

    result.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return result;
  }

  static matchAssociation(assoc, channel) {
    const allModels = [
      ...(channel.supported_models || []),
      ...(channel.manual_models || []),
    ];

    switch (assoc.type) {
      case 'channel_model':
        if (assoc.channel_id === channel.id && allModels.includes(assoc.model_id)) {
          return [{ requestModel: assoc.model_id, actualModel: assoc.actual_model || assoc.model_id, source: 'channel_model' }];
        }
        return [];

      case 'model':
        if (allModels.includes(assoc.model_id)) {
          return [{ requestModel: assoc.model_id, actualModel: assoc.actual_model || assoc.model_id, source: 'model' }];
        }
        return [];

      case 'regex': {
        const matches = [];
        try {
          const regex = new RegExp(assoc.pattern);
          for (const m of allModels) {
            if (regex.test(m)) {
              matches.push({ requestModel: m, actualModel: m, source: 'regex' });
            }
          }
        } catch {}
        return matches;
      }

      case 'channel_regex': {
        if (assoc.channel_id !== channel.id) return [];
        const matches = [];
        try {
          const regex = new RegExp(assoc.pattern);
          for (const m of allModels) {
            if (regex.test(m)) {
              matches.push({ requestModel: m, actualModel: m, source: 'channel_regex' });
            }
          }
        } catch {}
        return matches;
      }

      case 'channel_tags_model': {
        const channelTags = channel.tags || [];
        const requiredTags = assoc.tags || [];
        const hasAllTags = requiredTags.every(t => channelTags.includes(t));
        if (hasAllTags && allModels.includes(assoc.model_id)) {
          return [{ requestModel: assoc.model_id, actualModel: assoc.actual_model || assoc.model_id, source: 'channel_tags_model' }];
        }
        return [];
      }

      default:
        return [];
    }
  }
}

const loadBalancer = new LoadBalancer();
const circuitBreaker = new CircuitBreaker();

module.exports = { LoadBalancer, CircuitBreaker, ModelMatcher, loadBalancer, circuitBreaker };
