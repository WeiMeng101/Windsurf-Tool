'use strict';

const { OutboundTransformer } = require('../interfaces');

class OpenRouterOutbound extends OutboundTransformer {
  getRequestUrl() {
    const base = this.baseUrl || 'https://openrouter.ai/api';
    return `${base.replace(/\/$/, '')}/v1/chat/completions`;
  }

  getHeaders() {
    const apiKey = this.credentials.api_key || this.credentials.apiKey || '';
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://windsurf-tool.local',
      'X-Title': 'Windsurf Gateway',
    };
  }

  transformRequest(inReq, model) {
    const req = { ...inReq, model };
    Object.keys(req).forEach(k => { if (req[k] === undefined || req[k] === null) delete req[k]; });
    return req;
  }

  transformResponse(data) { return data; }
  transformStreamChunk(data) { return data; }
  extractUsage(data) { return data.usage || null; }
}

module.exports = { OpenRouterOutbound };
