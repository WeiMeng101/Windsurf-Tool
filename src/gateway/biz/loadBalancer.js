'use strict';

const logger = require('../logger');

/**
 * Supported routing strategies.
 */
const RoutingStrategy = Object.freeze({
  ROUND_ROBIN: 'round-robin',
  FILL_FIRST: 'fill-first',
  LEAST_CONNECTIONS: 'least-connections',
  HEALTH_FIRST: 'health-first',
  COST_AWARE: 'cost-aware',
});

const VALID_STRATEGIES = new Set(Object.values(RoutingStrategy));

class LoadBalancer {
  constructor() {
    this.channelMetrics = new Map();
    this.channelErrors = new Map();
    this.apiKeyErrors = new Map();

    // Strategy state
    this._strategy = RoutingStrategy.HEALTH_FIRST;
    this._roundRobinIndex = new Map();  // keyed by model (or '*')
    this._activeConnections = new Map(); // channelId -> count
  }

  // ---- Strategy configuration ----

  /**
   * Get the current routing strategy.
   * @returns {string}
   */
  getStrategy() {
    return this._strategy;
  }

  /**
   * Set the active routing strategy.
   * @param {string} strategy - One of RoutingStrategy values
   * @throws {Error} if strategy is unknown
   */
  setStrategy(strategy) {
    if (!VALID_STRATEGIES.has(strategy)) {
      throw new Error(`Unknown routing strategy: "${strategy}". Valid: ${[...VALID_STRATEGIES].join(', ')}`);
    }
    logger.info(`LoadBalancer strategy changed: ${this._strategy} -> ${strategy}`);
    this._strategy = strategy;
  }

  // ---- Active connection tracking (for least-connections) ----

  /**
   * Increment active connection count for a channel.
   * Call when a request begins.
   */
  trackConnectionStart(channelId) {
    this._activeConnections.set(channelId, (this._activeConnections.get(channelId) || 0) + 1);
  }

  /**
   * Decrement active connection count for a channel.
   * Call when a request ends (success or failure).
   */
  trackConnectionEnd(channelId) {
    const current = this._activeConnections.get(channelId) || 0;
    this._activeConnections.set(channelId, Math.max(0, current - 1));
  }

  /**
   * Get current active connection count for a channel.
   */
  getActiveConnections(channelId) {
    return this._activeConnections.get(channelId) || 0;
  }

  // ---- Channel selection ----

  /**
   * Select the best channel from the given list based on the active strategy.
   *
   * @param {object[]} channels - Available channel objects
   * @param {string} model - The requested model name
   * @param {string} [strategyOverride] - Optional per-call strategy override
   * @returns {object|null} The selected channel, or null if none available
   */
  selectChannel(channels, model, strategyOverride) {
    if (!channels || channels.length === 0) return null;
    if (channels.length === 1) return channels[0];

    const strategy = strategyOverride || this._strategy;

    try {
      switch (strategy) {
        case RoutingStrategy.ROUND_ROBIN:
          return this._selectRoundRobin(channels, model);
        case RoutingStrategy.FILL_FIRST:
          return this._selectFillFirst(channels, model);
        case RoutingStrategy.LEAST_CONNECTIONS:
          return this._selectLeastConnections(channels);
        case RoutingStrategy.HEALTH_FIRST:
          return this._selectHealthFirst(channels);
        case RoutingStrategy.COST_AWARE:
          return this._selectCostAware(channels, model);
        default:
          logger.warn(`Unknown strategy "${strategy}", falling back to health-first`);
          return this._selectHealthFirst(channels);
      }
    } catch (err) {
      logger.warn(`Strategy "${strategy}" failed, falling back to health-first`, { error: err.message });
      return this._selectHealthFirst(channels);
    }
  }

  /**
   * Round-robin: cycle through channels sequentially per model.
   */
  _selectRoundRobin(channels, model) {
    const key = model || '*';
    const currentIndex = this._roundRobinIndex.get(key) || 0;
    const selected = channels[currentIndex % channels.length];
    this._roundRobinIndex.set(key, (currentIndex + 1) % channels.length);
    return selected;
  }

  /**
   * Fill-first: use the first channel (by ordering_weight) until it
   * accumulates recent errors or crosses a high-usage threshold, then
   * move to the next.
   */
  _selectFillFirst(channels, _model) {
    // Channels are already sorted by ordering_weight DESC from the DB query.
    // Pick the first one that has not accumulated too many recent errors.
    const errorThreshold = 3;
    for (const ch of channels) {
      const metrics = this.channelMetrics.get(ch.id);
      if (!metrics || metrics.recentErrorCount < errorThreshold) {
        return ch;
      }
    }
    // All channels have errors -- fall back to first regardless.
    return channels[0];
  }

  /**
   * Least-connections: pick the channel with fewest in-flight requests.
   * Ties are broken by ordering_weight (higher is better).
   */
  _selectLeastConnections(channels) {
    let best = channels[0];
    let bestCount = this.getActiveConnections(best.id);

    for (let i = 1; i < channels.length; i++) {
      const ch = channels[i];
      const count = this.getActiveConnections(ch.id);
      if (count < bestCount || (count === bestCount && (ch.ordering_weight || 0) > (best.ordering_weight || 0))) {
        best = ch;
        bestCount = count;
      }
    }
    return best;
  }

  /**
   * Health-first: score channels by success rate / latency / errors
   * and pick from the top tier with some randomness.
   */
  _selectHealthFirst(channels) {
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

  /**
   * Cost-aware: prefer the channel with the lowest configured cost.
   * Falls back to ordering_weight if no price data exists.
   *
   * Cost is read from channel.settings.cost_per_token (number) or
   * channel.settings.cost_tier (1=cheapest .. 5=most expensive).
   * Channels without cost info get a neutral tier of 3.
   */
  _selectCostAware(channels, _model) {
    const withCost = channels.map(ch => {
      const settings = ch.settings || {};
      // Prefer explicit cost_per_token, else tier, else neutral
      let costScore;
      if (settings.cost_per_token != null) {
        costScore = Number(settings.cost_per_token);
      } else if (settings.cost_tier != null) {
        costScore = Number(settings.cost_tier);
      } else {
        costScore = 3; // neutral
      }
      return { channel: ch, costScore };
    });

    withCost.sort((a, b) => a.costScore - b.costScore);
    return withCost[0].channel;
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
      result[id] = {
        ...metrics,
        activeConnections: this.getActiveConnections(id),
      };
    }
    return result;
  }

  reset(channelId) {
    if (channelId) {
      this.channelMetrics.delete(channelId);
      this.channelErrors.delete(channelId);
      this._activeConnections.delete(channelId);
    } else {
      this.channelMetrics.clear();
      this.channelErrors.clear();
      this._activeConnections.clear();
      this._roundRobinIndex.clear();
    }
  }
}

class CircuitBreaker {
  /**
   * @param {object} [options]
   * @param {number} [options.threshold=5]        Consecutive failures to trip
   * @param {number} [options.resetTimeout=60000] Cooldown before half-open (ms)
   */
  constructor(options = {}) {
    this.threshold = options.threshold || 5;
    this.resetTimeout = options.resetTimeout || 60000;
    this.circuits = new Map();
  }

  /**
   * Returns true when the circuit is OPEN (broken) and the channel should
   * NOT receive traffic.  Automatically transitions from open -> half-open
   * after the cooldown period so one test request is allowed through.
   */
  isOpen(key) {
    const circuit = this.circuits.get(key);
    if (!circuit) return false;
    if (circuit.state === 'open') {
      if (Date.now() - circuit.openedAt > this.resetTimeout) {
        circuit.state = 'half-open';
        logger.info(`Circuit breaker half-open for: ${key}`);
        return false; // allow one test request
      }
      return true;
    }
    return false;
  }

  /**
   * Get the current state of a circuit.
   * @param {string} key
   * @returns {'closed'|'open'|'half-open'} defaults to 'closed' for unknown keys
   */
  getState(key) {
    const circuit = this.circuits.get(key);
    if (!circuit) return 'closed';
    // Check for timed-out open -> half-open transition
    if (circuit.state === 'open' && Date.now() - circuit.openedAt > this.resetTimeout) {
      circuit.state = 'half-open';
    }
    return circuit.state;
  }

  recordSuccess(key) {
    const circuit = this.circuits.get(key);
    if (circuit) {
      circuit.failureCount = 0;
      circuit.state = 'closed';
      circuit.closedAt = Date.now();
    }
  }

  recordFailure(key) {
    if (!this.circuits.has(key)) {
      this.circuits.set(key, {
        failureCount: 0,
        state: 'closed',
        openedAt: null,
        closedAt: null,
      });
    }
    const circuit = this.circuits.get(key);
    circuit.failureCount++;
    if (circuit.failureCount >= this.threshold) {
      circuit.state = 'open';
      circuit.openedAt = Date.now();
      logger.warn(`Circuit breaker opened for: ${key} (consecutive failures: ${circuit.failureCount})`);
    }
  }

  /**
   * Get stats for all circuits.
   * @returns {Object<string, {state: string, failureCount: number, openedAt: number|null}>}
   */
  getAllStats() {
    const result = {};
    for (const [key, circuit] of this.circuits) {
      // Apply timed transition before reporting
      if (circuit.state === 'open' && Date.now() - circuit.openedAt > this.resetTimeout) {
        circuit.state = 'half-open';
      }
      result[key] = {
        state: circuit.state,
        failureCount: circuit.failureCount,
        openedAt: circuit.openedAt,
        closedAt: circuit.closedAt || null,
      };
    }
    return result;
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

module.exports = { LoadBalancer, CircuitBreaker, ModelMatcher, RoutingStrategy, VALID_STRATEGIES, loadBalancer, circuitBreaker };
