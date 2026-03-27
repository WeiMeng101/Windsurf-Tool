'use strict';

const axios = require('axios');
const { getDb } = require('../db');
const { cacheManager } = require('../cache');
const logger = require('../logger');
const { setupSSEHeaders, writeSSE, endSSE, UsageAccumulator } = require('./streams');
require('./transformer/registry');
const { registry } = require('./transformer/interfaces');

class Pipeline {
  constructor() {
    this.maxChannelRetries = 3;
    this.maxSameChannelRetries = 1;
    this.retryDelay = 500;
  }

  async execute(req, res, format) {
    const db = getDb();
    const inbound = registry.getInbound(format);
    const model = inbound.getModel(req.body);
    const isStream = inbound.isStream(req.body);

    if (!model) {
      return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request' } });
    }

    const inboundRequest = inbound.buildRequest(req.body);
    const channels = this.findChannelsForModel(db, model);

    if (channels.length === 0) {
      return res.status(404).json({
        error: { message: `No available channel for model: ${model}`, type: 'model_not_found', code: 'no_channel' }
      });
    }

    const requestRecord = this.createRequestRecord(db, req, model, format, isStream);

    let lastError = null;
    for (let attempt = 0; attempt < Math.min(this.maxChannelRetries, channels.length); attempt++) {
      const channel = channels[attempt];
      try {
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

        this.updateRequestStatus(db, requestRecord.id, 'completed', channel.id, Date.now() - startTime);
        return;
      } catch (err) {
        lastError = err;
        logger.warn(`Channel ${channel.name} failed for model ${model}`, { error: err.message, attempt: attempt + 1 });
        this.recordExecution(db, requestRecord.id, channel.id, attempt + 1, 'failed', err.response?.status, err.message);
        this.recordChannelError(db, channel.id, err.response?.status);
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

  async executeStream(req, res, outbound, providerRequest, requestUrl, headers, requestRecord, channel, db, startTime) {
    const response = await axios({
      method: 'POST',
      url: requestUrl,
      headers,
      data: providerRequest,
      responseType: 'stream',
      timeout: 600000,
      validateStatus: (status) => status < 500,
    });

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
    this.recordExecution(db, requestRecord.id, channel.id, 1, 'success', response.status);

    const usageAccumulator = new UsageAccumulator();
    let firstChunk = true;
    let buffer = '';

    response.data.on('data', (chunk) => {
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
            const ftLatency = Date.now() - startTime;
            db.prepare('UPDATE requests SET metrics_first_token_latency_ms = ? WHERE id = ?').run(ftLatency, requestRecord.id);
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
    });

    return new Promise((resolve, reject) => {
      response.data.on('end', () => {
        if (!res.writableEnded) {
          endSSE(res);
        }
        const latency = Date.now() - startTime;
        this.saveUsageLog(db, requestRecord, channel, usageAccumulator.toJSON(), latency);
        resolve();
      });
      response.data.on('error', reject);
      req.on('close', () => {
        response.data.destroy();
        resolve();
      });
    });
  }

  async executeNonStream(req, res, outbound, inbound, providerRequest, requestUrl, headers, requestRecord, channel, db, startTime) {
    const response = await axios({
      method: 'POST',
      url: requestUrl,
      headers,
      data: providerRequest,
      timeout: 600000,
      validateStatus: (status) => status < 500,
    });

    if (response.status >= 400) {
      const err = new Error(`Upstream error: ${response.status}`);
      err.response = { status: response.status, data: response.data };
      throw err;
    }

    this.recordExecution(db, requestRecord.id, channel.id, 1, 'success', response.status);

    const transformed = outbound.transformResponse(response.data);
    const usage = outbound.extractUsage(response.data);
    const latency = Date.now() - startTime;

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
      db.prepare(`
        INSERT INTO usage_logs (request_id, api_key_id, project_id, channel_id, model_id, prompt_tokens, completion_tokens, total_tokens, cached_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestRecord.id, null, 1, channel.id, requestRecord.model,
        usage.prompt_tokens || 0, usage.completion_tokens || 0,
        usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        usage.cached_tokens || 0
      );
    } catch (err) {
      logger.error('Failed to save usage log', { error: err.message });
    }
  }

  shutdown() {
    logger.info('Pipeline shutting down');
  }
}

module.exports = { Pipeline };
