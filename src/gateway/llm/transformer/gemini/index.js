'use strict';

const { InboundTransformer, OutboundTransformer } = require('../interfaces');

class GeminiInbound extends InboundTransformer {
  getModel(body) { return body._gemini_model || body.model; }
  isStream(body) { return !!body.stream; }

  buildRequest(body) {
    return {
      contents: body.contents,
      generationConfig: body.generationConfig,
      safetySettings: body.safetySettings,
      tools: body.tools,
      systemInstruction: body.systemInstruction,
    };
  }

  parseResponse(data) { return data; }
  parseStreamChunk(data) { return data; }

  extractUsage(data) {
    if (data.usageMetadata) {
      return {
        prompt_tokens: data.usageMetadata.promptTokenCount || 0,
        completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
        total_tokens: data.usageMetadata.totalTokenCount || 0,
      };
    }
    return null;
  }
}

class GeminiOutbound extends OutboundTransformer {
  getRequestUrl(model) {
    const base = this.baseUrl || 'https://generativelanguage.googleapis.com';
    return `${base.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
  }

  getStreamUrl(model) {
    const base = this.baseUrl || 'https://generativelanguage.googleapis.com';
    return `${base.replace(/\/$/, '')}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  }

  getHeaders() {
    const apiKey = this.credentials.api_key || this.credentials.apiKey || '';
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    };
  }

  transformRequest(inReq, model) {
    const req = { ...inReq };
    Object.keys(req).forEach(k => { if (req[k] === undefined || req[k] === null) delete req[k]; });
    return req;
  }

  transformResponse(data) { return data; }
  transformStreamChunk(data) { return data; }

  extractUsage(data) {
    if (data.usageMetadata) {
      return {
        prompt_tokens: data.usageMetadata.promptTokenCount || 0,
        completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
        total_tokens: data.usageMetadata.totalTokenCount || 0,
      };
    }
    return null;
  }
}

class OpenAIToGeminiOutbound extends OutboundTransformer {
  getRequestUrl(model) {
    const base = this.baseUrl || 'https://generativelanguage.googleapis.com';
    return `${base.replace(/\/$/, '')}/v1beta/openai/chat/completions`;
  }

  getHeaders() {
    const apiKey = this.credentials.api_key || this.credentials.apiKey || '';
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
  }

  transformRequest(inReq, model) {
    return { ...inReq, model };
  }

  transformResponse(data) { return data; }
  transformStreamChunk(data) { return data; }
  extractUsage(data) { return data.usage || null; }
}

module.exports = { GeminiInbound, GeminiOutbound, OpenAIToGeminiOutbound };
