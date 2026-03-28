'use strict';

const axios = require('axios');
const { getDb } = require('../db');
const { cacheManager } = require('../cache');
const logger = require('../logger');
const { setupSSEHeaders, writeSSE, endSSE, UsageAccumulator } = require('./streams');
const { modelRegistry } = require('./transformer/registry');
const { registry } = require('./transformer/interfaces');
const { isTokenExpired } = require('../../services/tokenUtils');
const { CODEX_BASE_URL } = require('./transformer/codex/index');
const tokenRefreshService = require('../../services/tokenRefreshService');
const { quotaService, QuotaService } = require('../biz/quota');
const { computeUsageCost } = require('../biz/costCalc');
const { loadBalancer, circuitBreaker } = require('../biz/loadBalancer');

// Wire the model registry into the quota service so auto-switch can walk
// fallback chains without creating a circular dependency at require time.
QuotaService.setModelRegistry(modelRegistry);

let traceService = null;
try {
  traceService = require('../biz/trace').traceService;
} catch (_e) {
  // trace module optional
}

let requestCloakingService = null;
try {
  requestCloakingService = require('../biz/requestCloaking').requestCloakingService;
} catch (_e) {
  // cloaking module optional
}

class Pipeline {
  constructor() {
    this.maxChannelRetries = 3;
    this.maxSameChannelRetries = 1;
    this.retryDelay = 500;

    /** @type {import('../../services/poolService')|null} */
    this._poolService = null;
    /** @type {import('../../services/poolChannelBridge')|null} */
    this._poolBridge = null;
  }

  /**
   * Attach pool service + bridge for dynamic per-request allocation.
   * When set, execute() will attempt pool-based routing before falling
   * back to the static channels table.
   *
   * @param {import('../../services/poolService')} poolService
   * @param {import('../../services/poolChannelBridge')} poolBridge
   */
  setPoolService(poolService, poolBridge) {
    this._poolService = poolService;
    this._poolBridge = poolBridge;
    logger.info('Pipeline: pool-based routing enabled');
  }

  async execute(req, res, format) {
    const db = getDb();
    const inbound = registry.getInbound(format);
    const rawModel = inbound.getModel(req.body);
    const isStream = inbound.isStream(req.body);

    if (!rawModel) {
      return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request' } });
    }

    // --- Model resolution: aliases + exclusion check ---
    let model;
    try {
      model = modelRegistry.resolveModel(rawModel);
    } catch (err) {
      if (err.code === 'MODEL_EXCLUDED') {
        return res.status(403).json({
          error: { message: err.message, type: 'model_excluded', code: 'model_excluded' }
        });
      }
      throw err;
    }

    if (model !== rawModel) {
      logger.info('[Model Resolution] alias resolved', { from: rawModel, to: model });
    }

    // --- Quota enforcement ---
    if (req.apiKey) {
      const profiles = typeof req.apiKey.profiles === 'string'
        ? JSON.parse(req.apiKey.profiles || '{}')
        : (req.apiKey.profiles || {});
      const quota = profiles.quota;
      if (quota) {
        const check = quotaService.checkAPIKeyQuota(req.apiKey.id, quota);
        if (!check.allowed) {
          return res.status(429).json({
            error: { message: check.message, type: 'quota_exceeded', code: 'quota_exceeded' }
          });
        }
      }
    }

    const inboundRequest = inbound.buildRequest(req.body);

    // --- Pool-based dynamic allocation (GW-01 + GW-02 failover) ---
    // Try to allocate from the pool first; if all pool accounts fail,
    // fall through to static channel-based routing.
    const poolResult = this._tryPoolAllocation(model);
    if (poolResult) {
      const handled = await this._executeWithPoolAccount(
        poolResult, inboundRequest, model, isStream, format, req, res, db,
      );
      // If pool handled the request (success or already sent error), stop.
      if (handled) return;
      // Otherwise fall through to channel-based routing below.
      logger.info('[Pool Route] falling through to channel-based routing', { model });
    }

    // --- Fallback: static channel table routing ---
    let channels = this.findChannelsForModel(db, model);

    if (channels.length === 0) {
      // Before giving up, try fallback models from the registry
      const fallbacks = modelRegistry.getFallbackChain(model);
      for (const fbModel of fallbacks) {
        const fbChannels = this.findChannelsForModel(db, fbModel);
        if (fbChannels.length > 0) {
          logger.info('[Model Fallback] no channel for original model, using fallback', {
            from: model, to: fbModel,
          });
          channels = fbChannels;
          model = fbModel;
          break;
        }
      }
    }

    if (channels.length === 0) {
      return res.status(404).json({
        error: { message: `No available channel for model: ${model}`, type: 'model_not_found', code: 'no_channel' }
      });
    }

    // --- Filter out channels with open circuit breakers ---
    const availableChannels = channels.filter(ch => {
      const cbKey = `channel:${ch.id}`;
      if (circuitBreaker.isOpen(cbKey)) {
        logger.debug(`Skipping channel ${ch.name} (id=${ch.id}): circuit breaker open`);
        return false;
      }
      return true;
    });

    if (availableChannels.length === 0) {
      // All channels have tripped circuit breakers -- allow the original
      // list through so the request is not simply dropped.  The half-open
      // transition in CircuitBreaker will eventually let test requests pass.
      logger.warn('All channels have open circuit breakers, allowing original list', { model });
      availableChannels.push(...channels);
    }

    const requestRecord = this.createRequestRecord(db, req, model, format, isStream);

    // --- Strategy-based channel selection with retry ---
    const maxAttempts = Math.min(this.maxChannelRetries, availableChannels.length);
    const tried = new Set();
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Use loadBalancer strategy to pick the next channel, filtering
      // out already-tried channels so retries go to different ones.
      const candidates = availableChannels.filter(ch => !tried.has(ch.id));
      if (candidates.length === 0) break;

      const channel = loadBalancer.selectChannel(candidates, model);
      if (!channel) break;
      tried.add(channel.id);

      const cbKey = `channel:${channel.id}`;

      try {
        loadBalancer.trackConnectionStart(channel.id);

        const outbound = registry.getOutbound(channel);
        const actualModel = this.resolveModel(channel, model);
        const providerRequest = outbound.transformRequest(inboundRequest, actualModel);
        const requestUrl = outbound.getRequestUrl(actualModel);
        const headers = outbound.getHeaders();

        const startTime = Date.now();

        if (isStream) {
          await this.executeStream(req, res, outbound, providerRequest, requestUrl, headers, requestRecord, channel, db, startTime);
        } else {
          await this.executeNonStream(req, res, outbound, inbound, providerRequest, requestUrl, headers, requestRecord, channel, db, startTime);
        }

        const latencyMs = Date.now() - startTime;
        this.updateRequestStatus(db, requestRecord.id, 'completed', channel.id, latencyMs);

        // Record success in load balancer metrics and circuit breaker
        loadBalancer.recordSuccess(channel.id, latencyMs);
        circuitBreaker.recordSuccess(cbKey);
        loadBalancer.trackConnectionEnd(channel.id);
        return;
      } catch (err) {
        loadBalancer.trackConnectionEnd(channel.id);

        lastError = err;
        const statusCode = err.response?.status;
        logger.warn(`Channel ${channel.name} failed for model ${model}`, { error: err.message, attempt: attempt + 1 });
        this.recordExecution(db, requestRecord.id, channel.id, attempt + 1, 'failed', statusCode, err.message);
        this.recordChannelError(db, channel.id, statusCode);

        // Record failure in load balancer metrics and circuit breaker
        loadBalancer.recordFailure(channel.id, statusCode);
        circuitBreaker.recordFailure(cbKey);
      }
    }

    this.updateRequestStatus(db, requestRecord.id, 'failed', null, null);
    if (!res.headersSent) {
      const status = lastError?.response?.status || 502;
      res.status(status).json({
        error: {
          message: lastError?.message || 'All channels failed',
          type: 'upstream_error',
          code: 'all_channels_failed',
        }
      });
    }
  }

  // ---- Pool allocation helpers (GW-01) ----

  /**
   * Attempt to allocate a pool account whose provider supports the requested
   * model. Returns the allocation result or null if pool is unavailable or
   * has no matching account.
   * @param {string} model
   * @returns {object|null} pool allocation result from bridge
   */
  _tryPoolAllocation(model) {
    if (!this._poolService || !this._poolBridge) return null;

    try {
      // Determine which provider type(s) serve this model by scanning the
      // PROVIDER_DEFAULT_MODELS map exposed on the bridge module.
      const PoolChannelBridge = require('../../services/poolChannelBridge');
      const providerTypes = PoolChannelBridge.resolveProviderTypesForModel
        ? PoolChannelBridge.resolveProviderTypesForModel(model)
        : this._guessProviderTypes(model);

      for (const providerType of providerTypes) {
        const allocation = this._poolBridge.allocateFromPool(this._poolService, providerType);
        if (allocation) {
          logger.info(`Pool allocation: account ${allocation.accountId} (${providerType}) for model ${model}`);
          return allocation;
        }
      }
    } catch (err) {
      logger.warn('Pool allocation failed, falling back to channels', { error: err.message });
    }

    return null;
  }

  /**
   * Guess which provider types might serve a model based on known model
   * prefixes. This is a best-effort heuristic used when the bridge does not
   * expose resolveProviderTypesForModel.
   * @param {string} model
   * @returns {string[]}
   */
  _guessProviderTypes(model) {
    const m = model.toLowerCase();
    const types = [];
    if (m.includes('claude')) types.push('anthropic', 'claudecode');
    if (m.includes('gpt') || m.startsWith('o1') || m.startsWith('o3')) types.push('openai');
    // gpt-5 family with codex suffix routes to Codex provider
    if (m.includes('codex') || m.includes('codegeist')) types.push('codex');
    if (m.includes('gemini')) types.push('gemini');
    if (m.includes('deepseek')) types.push('deepseek');
    if (m.includes('moonshot')) types.push('moonshot');
    if (m.includes('doubao')) types.push('doubao');
    if (m.includes('glm')) types.push('zhipu');
    if (m.includes('grok')) types.push('xai');
    if (m.includes('qwen')) types.push('siliconflow');
    // Always try codex/openai as catch-all last
    if (types.length === 0) types.push('openai', 'codex');
    return [...new Set(types)];
  }

  /**
   * Execute a request using a dynamically allocated pool account.
   * Supports up to maxPoolRetries attempts with different pool accounts (GW-02).
   * Each failed account is released back with error status before retrying.
   * If all pool accounts fail, returns false so the caller can fall through
   * to channel-based routing.
   *
   * @returns {boolean} true if the request was handled (success or error sent),
   *   false if all pool retries exhausted and caller should try channels.
   */
  async _executeWithPoolAccount(allocation, inboundRequest, model, isStream, format, req, res, db) {
    const maxPoolRetries = 3;
    const requestRecord = this.createRequestRecord(db, req, model, format, isStream);

    // Link to trace if tracing middleware set a traceId on the request
    this._attachTrace(db, req, requestRecord);

    let currentAllocation = allocation;
    let lastError = null;

    for (let attempt = 0; attempt < maxPoolRetries; attempt++) {
      if (!currentAllocation) break;

      // For Codex accounts, check token expiry and attempt refresh before use
      if (currentAllocation.channelType === 'codex') {
        currentAllocation = await this._ensureCodexTokenFresh(currentAllocation);
        if (!currentAllocation) break; // refresh failed and no account left
      }

      const accountId = currentAllocation.accountId;
      const providerType = currentAllocation.providerType;
      const syntheticChannel = this._buildSyntheticChannel(currentAllocation);

      const attemptStart = Date.now();
      let success = false;
      let errorMessage = null;

      try {
        const outbound = registry.getOutbound(syntheticChannel);
        const actualModel = this.resolveModel(syntheticChannel, model);
        let providerRequest = outbound.transformRequest(inboundRequest, actualModel);
        const requestUrl = outbound.getRequestUrl(actualModel);
        let headers = outbound.getHeaders();

        // --- Per-key custom headers (merged after transformer headers) ---
        if (syntheticChannel.custom_headers && typeof syntheticChannel.custom_headers === 'object') {
          headers = { ...headers, ...syntheticChannel.custom_headers };
        }

        // --- Request cloaking ---
        let replacementMap = null;
        if (requestCloakingService) {
          try {
            const cloakResult = requestCloakingService.cloakRequest(providerRequest, providerType);
            providerRequest = cloakResult.cloakedBody;
            replacementMap = cloakResult.replacementMap;
          } catch (cloakErr) {
            logger.warn('[Cloaking] Failed to cloak request, proceeding uncloaked', { error: cloakErr.message });
          }
        }

        // --- Per-key proxy URL ---
        const axiosExtra = {};
        if (syntheticChannel.proxy_url) {
          axiosExtra.proxy_url = syntheticChannel.proxy_url;
        }

        if (isStream) {
          await this.executeStream(req, res, outbound, providerRequest, requestUrl, headers, requestRecord, syntheticChannel, db, attemptStart, axiosExtra);
        } else {
          const inbound = registry.getInbound(format);
          await this.executeNonStream(req, res, outbound, inbound, providerRequest, requestUrl, headers, requestRecord, syntheticChannel, db, attemptStart, replacementMap, axiosExtra);
        }

        const latencyMs = Date.now() - attemptStart;
        this.updateRequestStatus(db, requestRecord.id, 'completed', null, latencyMs);
        success = true;

        logger.info('[Pool Route] success', {
          accountId, provider: providerType, model, attempt: attempt + 1,
          latencyMs, stream: isStream,
        });

        return true;
      } catch (err) {
        errorMessage = err.message;
        lastError = err;
        const latencyMs = Date.now() - attemptStart;

        logger.warn('[Pool Route] attempt failed', {
          accountId, provider: providerType, model, attempt: attempt + 1,
          latencyMs, status: err.response?.status, error: err.message,
        });

        this._safeRecordExecution(db, requestRecord.id, null, attempt + 1, 'failed', err.response?.status, err.message);
      } finally {
        // Always release current account back to pool
        this._releasePoolAccount(currentAllocation.accountId, success, errorMessage);
      }

      // If headers already sent (partial stream), we cannot retry or fall through
      if (res.headersSent) {
        this.updateRequestStatus(db, requestRecord.id, 'failed', null, null);
        return true;
      }

      // Try to allocate a NEW account for the next attempt
      if (attempt < maxPoolRetries - 1) {
        currentAllocation = this._tryPoolAllocation(model);
        if (currentAllocation) {
          logger.info('[Pool Route] retrying with new account', {
            newAccountId: currentAllocation.accountId,
            provider: currentAllocation.providerType,
            attempt: attempt + 2,
          });
          // Small backoff before retry
          if (this.retryDelay > 0) {
            await new Promise(r => setTimeout(r, this.retryDelay));
          }
        }
      }
    }

    // All pool retries exhausted -- signal caller to try channel-based routing
    logger.warn('[Pool Route] all pool retries exhausted, falling through to channels', {
      model, attempts: maxPoolRetries, lastError: lastError?.message,
    });
    return false;
  }

  /**
   * Build a synthetic channel object from a pool allocation for use with
   * outbound transformers.
   *
   * For Codex accounts the credentials carry JWT access_token / refresh_token
   * rather than a simple api_key, and the base_url must point to the Codex
   * backend (chatgpt.com/backend-api/codex#) so the CodexOutbound transformer
   * derives the correct request URL.
   */
  _buildSyntheticChannel(allocation) {
    const isCodex = allocation.channelType === 'codex';
    const credentials = { ...allocation.credentials };

    if (isCodex) {
      // Codex accounts use access_token as the bearer token.
      // Ensure it is also set as api_key so getHeaders() in the transformer
      // can find it via the standard credential fields.
      if (credentials.access_token && !credentials.api_key) {
        credentials.api_key = credentials.access_token;
      }
    }

    const channel = {
      id: null,
      type: allocation.channelType,
      name: `__pool__${allocation.accountId}`,
      base_url: isCodex ? (allocation.base_url || CODEX_BASE_URL) : (allocation.base_url || ''),
      credentials,
      supported_models: allocation.models,
      manual_models: [],
      tags: ['pool', 'dynamic'],
      policies: {},
      settings: {},
      ordering_weight: Math.round(allocation.health_score / 10),
    };

    // Per-key proxy URL override -- downstream HTTP calls will route through this proxy
    if (allocation.proxy_url) {
      channel.proxy_url = allocation.proxy_url;
    }

    // Per-key custom headers -- merged into outbound request headers
    if (allocation.custom_headers && typeof allocation.custom_headers === 'object') {
      channel.custom_headers = allocation.custom_headers;
    }

    return channel;
  }

  /**
   * Ensure a Codex allocation's access_token is still valid.
   * If the JWT is expired (or about to expire), attempt a refresh using the
   * refresh_token via tokenRefreshService.  On success the allocation's
   * credentials are updated in-place and the pool account is also patched.
   * On failure the account is released with an auth error and null is
   * returned so the caller can skip to the next allocation.
   *
   * @param {object} allocation - Pool allocation with credentials
   * @returns {object|null} The (possibly updated) allocation, or null on failure
   */
  async _ensureCodexTokenFresh(allocation) {
    const creds = allocation.credentials || {};
    const accessToken = creds.access_token || creds.api_key;

    // If the token is still valid, nothing to do
    if (accessToken && !isTokenExpired(accessToken)) {
      return allocation;
    }

    const refreshToken = creds.refresh_token;
    if (!refreshToken) {
      logger.warn('[Codex Token] No refresh_token available, cannot refresh', {
        accountId: allocation.accountId,
      });
      this._releasePoolAccount(allocation.accountId, false, 'Codex token expired, no refresh_token');
      return null;
    }

    logger.info('[Codex Token] access_token expired, attempting refresh', {
      accountId: allocation.accountId,
    });

    try {
      const tokens = await tokenRefreshService.refreshCodexToken(refreshToken);
      // Update the allocation credentials with fresh tokens
      allocation.credentials = {
        ...creds,
        access_token: tokens.access_token,
        api_key: tokens.access_token,
      };
      if (tokens.refresh_token) {
        allocation.credentials.refresh_token = tokens.refresh_token;
      }

      // Persist the refreshed credentials back to the pool so future
      // allocations already have a valid token.
      if (this._poolService) {
        try {
          this._poolService.update(allocation.accountId, {
            credentials: allocation.credentials,
          });
        } catch (updateErr) {
          logger.warn('[Codex Token] Failed to persist refreshed credentials', {
            accountId: allocation.accountId, error: updateErr.message,
          });
        }
      }

      logger.info('[Codex Token] Token refreshed successfully', {
        accountId: allocation.accountId,
      });
      return allocation;
    } catch (err) {
      logger.error('[Codex Token] Token refresh failed', {
        accountId: allocation.accountId, error: err.message,
      });
      this._releasePoolAccount(allocation.accountId, false, `Codex token refresh failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Safely release a pool account. Errors during release are logged but
   * never propagated.
   */
  _releasePoolAccount(accountId, success, errorMessage) {
    try {
      this._poolBridge.releaseToPool(
        this._poolService, accountId, success, errorMessage,
      );
    } catch (releaseErr) {
      logger.warn('Failed to release pool account', { accountId, error: releaseErr.message });
    }
  }

  /**
   * Attach trace/thread from the tracing middleware to the request record.
   * If the middleware set req.traceId / req.threadId, create or link
   * the corresponding trace/thread rows.
   */
  _attachTrace(db, req, requestRecord) {
    if (!traceService) return;
    try {
      const projectId = req.projectId || 1;
      const externalTraceId = req.traceId || null;
      const externalThreadId = req.threadId || null;

      if (!externalTraceId) return;

      const trace = traceService.findOrCreateTrace(projectId, externalTraceId, `pool-request-${requestRecord.model}`);
      if (trace && trace.id) {
        db.prepare('UPDATE requests SET trace_id = ? WHERE id = ?').run(trace.id, requestRecord.id);

        if (externalThreadId) {
          const thread = traceService.findOrCreateThread(projectId, externalThreadId, '');
          if (thread && thread.id) {
            traceService.linkTraceToThread(trace.id, thread.id);
          }
        }
      }
    } catch (err) {
      logger.warn('Failed to attach trace to pool request', { error: err.message });
    }
  }

  /**
   * Record an execution attempt, tolerating null channelId for pool-based
   * requests (the request_executions.channel_id column is NOT NULL in the
   * original schema, so we use 0 as a sentinel for pool routes).
   */
  _safeRecordExecution(db, requestId, channelId, attempt, status, responseStatusCode, errorMessage) {
    try {
      this.recordExecution(db, requestId, channelId ?? 0, attempt, status, responseStatusCode, errorMessage);
    } catch (err) {
      logger.warn('Failed to record pool execution', { requestId, error: err.message });
    }
  }

  async executeStream(req, res, outbound, providerRequest, requestUrl, headers, requestRecord, channel, db, startTime, axiosExtra = {}) {
    const axiosConfig = {
      method: 'POST',
      url: requestUrl,
      headers,
      data: providerRequest,
      responseType: 'stream',
      timeout: 600000,
      validateStatus: (status) => status < 500,
    };

    // Per-key proxy support
    if (axiosExtra.proxy_url) {
      try {
        const proxyUrl = new URL(axiosExtra.proxy_url);
        axiosConfig.proxy = {
          protocol: proxyUrl.protocol.replace(':', ''),
          host: proxyUrl.hostname,
          port: parseInt(proxyUrl.port, 10) || (proxyUrl.protocol === 'https:' ? 443 : 80),
        };
        if (proxyUrl.username) {
          axiosConfig.proxy.auth = { username: proxyUrl.username, password: proxyUrl.password || '' };
        }
      } catch (proxyErr) {
        logger.warn('[Proxy] Invalid proxy_url, ignoring', { proxy_url: axiosExtra.proxy_url, error: proxyErr.message });
      }
    }

    const response = await axios(axiosConfig);

    if (response.status >= 400) {
      let errorBody = '';
      for await (const chunk of response.data) {
        errorBody += chunk.toString();
      }
      const err = new Error(`Upstream error: ${response.status}`);
      err.response = { status: response.status, data: errorBody };
      throw err;
    }

    setupSSEHeaders(res);
    if (channel.id != null) {
      this.recordExecution(db, requestRecord.id, channel.id, 1, 'success', response.status);
    }

    const usageAccumulator = new UsageAccumulator();
    let firstChunk = true;
    let buffer = '';

    response.data.on('data', (chunk) => {
      try {
        const text = chunk.toString();
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);

          if (data === '[DONE]') {
            endSSE(res);
            return;
          }

          try {
            const parsed = JSON.parse(data);

            if (firstChunk) {
              firstChunk = false;
              try {
                const ftLatency = Date.now() - startTime;
                db.prepare('UPDATE requests SET metrics_first_token_latency_ms = ? WHERE id = ?').run(ftLatency, requestRecord.id);
              } catch (dbErr) {
                logger.warn('Failed to update first token latency', { error: dbErr.message });
              }
            }

            const transformed = outbound.transformStreamChunk(parsed);
            if (transformed) {
              const usage = outbound.extractUsage(parsed);
              usageAccumulator.update(usage);
              writeSSE(res, transformed);
            }
          } catch {
            writeSSE(res, data);
          }
        }
      } catch (outerErr) {
        logger.error('Error in stream data handler', { error: outerErr.message });
      }
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      response.data.on('end', () => {
        if (!res.writableEnded) {
          endSSE(res);
        }
        const latency = Date.now() - startTime;
        this.saveUsageLog(db, requestRecord, channel, usageAccumulator.toJSON(), latency);
        settle(resolve);
      });
      response.data.on('error', (err) => settle(reject, err));
      req.on('close', () => {
        response.data.removeAllListeners();
        response.data.destroy();
        settle(resolve);
      });
    });
  }

  async executeNonStream(req, res, outbound, inbound, providerRequest, requestUrl, headers, requestRecord, channel, db, startTime, replacementMap = null, axiosExtra = {}) {
    const axiosConfig = {
      method: 'POST',
      url: requestUrl,
      headers,
      data: providerRequest,
      timeout: 600000,
      validateStatus: (status) => status < 500,
    };

    // Per-key proxy support
    if (axiosExtra.proxy_url) {
      try {
        const proxyUrl = new URL(axiosExtra.proxy_url);
        axiosConfig.proxy = {
          protocol: proxyUrl.protocol.replace(':', ''),
          host: proxyUrl.hostname,
          port: parseInt(proxyUrl.port, 10) || (proxyUrl.protocol === 'https:' ? 443 : 80),
        };
        if (proxyUrl.username) {
          axiosConfig.proxy.auth = { username: proxyUrl.username, password: proxyUrl.password || '' };
        }
      } catch (proxyErr) {
        logger.warn('[Proxy] Invalid proxy_url, ignoring', { proxy_url: axiosExtra.proxy_url, error: proxyErr.message });
      }
    }

    const response = await axios(axiosConfig);

    if (response.status >= 400) {
      const err = new Error(`Upstream error: ${response.status}`);
      err.response = { status: response.status, data: response.data };
      throw err;
    }

    if (channel.id != null) {
      this.recordExecution(db, requestRecord.id, channel.id, 1, 'success', response.status);
    }

    let transformed = outbound.transformResponse(response.data);
    const usage = outbound.extractUsage(response.data);
    const latency = Date.now() - startTime;

    // --- Uncloak response if cloaking was applied ---
    if (replacementMap && replacementMap.size > 0 && requestCloakingService) {
      try {
        transformed = requestCloakingService.uncloakResponse(transformed, replacementMap);
      } catch (uncloakErr) {
        logger.warn('[Cloaking] Failed to uncloak response', { error: uncloakErr.message });
      }
    }

    db.prepare('UPDATE requests SET response_body = ?, metrics_latency_ms = ? WHERE id = ?')
      .run(JSON.stringify(transformed), latency, requestRecord.id);

    if (usage) {
      this.saveUsageLog(db, requestRecord, channel, usage, latency);
    }

    res.json(transformed);
  }

  findChannelsForModel(db, model) {
    const cached = cacheManager.get('channels', `model:${model}`);
    if (cached) return cached;

    const rows = db.prepare(`
      SELECT * FROM channels WHERE status = 'enabled' AND deleted_at IS NULL ORDER BY ordering_weight DESC, id ASC
    `).all();

    const matched = [];
    for (const row of rows) {
      const ch = this.parseChannel(row);
      const allModels = [...(ch.supported_models || []), ...(ch.manual_models || [])];

      const mappings = ch.settings?.model_mappings || ch.settings?.modelMappings || [];
      for (const mapping of mappings) {
        if (mapping.from === model || (mapping.pattern && new RegExp(mapping.pattern).test(model))) {
          matched.push(ch);
          break;
        }
      }

      if (!matched.includes(ch) && allModels.includes(model)) {
        matched.push(ch);
      }

      if (!matched.includes(ch)) {
        for (const m of allModels) {
          if (m.endsWith('*') && model.startsWith(m.slice(0, -1))) {
            matched.push(ch);
            break;
          }
        }
      }
    }

    cacheManager.set('channels', `model:${model}`, matched, 10);
    return matched;
  }

  resolveModel(channel, requestModel) {
    const mappings = channel.settings?.model_mappings || channel.settings?.modelMappings || [];
    for (const mapping of mappings) {
      if (mapping.from === requestModel) return mapping.to || requestModel;
      if (mapping.pattern && new RegExp(mapping.pattern).test(requestModel)) {
        return mapping.to || requestModel;
      }
    }
    return requestModel;
  }

  parseChannel(row) {
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

  createRequestRecord(db, req, model, format, isStream) {
    const result = db.prepare(`
      INSERT INTO requests (api_key_id, project_id, model_id, format, request_body, status, stream, client_ip)
      VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)
    `).run(
      req.apiKey?.id || null,
      req.projectId || 1,
      model,
      format,
      JSON.stringify(req.body),
      isStream ? 1 : 0,
      req.ip || ''
    );
    return { id: result.lastInsertRowid, model, format };
  }

  updateRequestStatus(db, requestId, status, channelId, latencyMs) {
    const updates = ["status = ?", "updated_at = datetime('now')"];
    const values = [status];
    if (channelId) { updates.push('channel_id = ?'); values.push(channelId); }
    if (latencyMs !== null && latencyMs !== undefined) { updates.push('metrics_latency_ms = ?'); values.push(latencyMs); }
    values.push(requestId);
    db.prepare(`UPDATE requests SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  recordExecution(db, requestId, channelId, attempt, status, responseStatusCode, errorMessage) {
    db.prepare(`
      INSERT INTO request_executions (request_id, channel_id, attempt_number, status, response_status_code, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(requestId, channelId, attempt, status, responseStatusCode || null, errorMessage || null);
  }

  recordChannelError(db, channelId, statusCode) {
    if ([401, 403, 429].includes(statusCode)) {
      logger.warn(`Channel ${channelId} received ${statusCode}, may need attention`);
    }
  }

  saveUsageLog(db, requestRecord, channel, usage, latencyMs) {
    if (!usage) return;
    try {
      // Calculate cost if channel has pricing configured
      let cost = '0';
      let costItems = '[]';
      if (channel.id != null) {
        try {
          const priceRow = db.prepare(
            'SELECT price FROM channel_model_prices WHERE channel_id = ? AND model_id = ?'
          ).get(channel.id, requestRecord.model);
          if (priceRow) {
            const price = JSON.parse(priceRow.price || '{}');
            const result = computeUsageCost(usage, price);
            cost = result.total;
            costItems = JSON.stringify(result.items);
          }
        } catch (costErr) {
          logger.warn('Failed to compute usage cost', { error: costErr.message });
        }
      }

      db.prepare(`
        INSERT INTO usage_logs (request_id, api_key_id, project_id, channel_id, model_id, prompt_tokens, completion_tokens, total_tokens, cached_tokens, cost, cost_items)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestRecord.id, null, 1, channel.id, requestRecord.model,
        usage.prompt_tokens || 0, usage.completion_tokens || 0,
        usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        usage.cached_tokens || 0,
        cost, costItems
      );
    } catch (err) {
      logger.error('Failed to save usage log', { error: err.message });
    }
  }

  shutdown() {
    logger.info('Pipeline shutting down');
    // Clean up pool bridge auto-sync timer if active
    if (this._poolBridge && typeof this._poolBridge.stopAutoSync === 'function') {
      this._poolBridge.stopAutoSync();
    }
  }
}

module.exports = { Pipeline, modelRegistry };
