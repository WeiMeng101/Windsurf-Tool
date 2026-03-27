'use strict';

const { InboundTransformer, OutboundTransformer } = require('../interfaces');

class AnthropicInbound extends InboundTransformer {
  getModel(body) { return body.model; }
  isStream(body) { return !!body.stream; }

  buildRequest(body) {
    return {
      model: body.model,
      messages: body.messages,
      system: body.system,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      stream: body.stream,
      stop_sequences: body.stop_sequences,
      tools: body.tools,
      tool_choice: body.tool_choice,
      metadata: body.metadata,
    };
  }

  parseResponse(data) { return data; }
  parseStreamChunk(data) { return data; }

  extractUsage(data) {
    if (data.usage) {
      return {
        prompt_tokens: data.usage.input_tokens || 0,
        completion_tokens: data.usage.output_tokens || 0,
        total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        cached_tokens: data.usage.cache_read_input_tokens || 0,
      };
    }
    return null;
  }
}

class AnthropicOutbound extends OutboundTransformer {
  getRequestUrl() {
    const base = this.baseUrl || 'https://api.anthropic.com';
    return `${base.replace(/\/$/, '')}/v1/messages`;
  }

  getHeaders() {
    const apiKey = this.credentials.api_key || this.credentials.apiKey || '';
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  transformRequest(inReq, model) {
    const req = { ...inReq };
    req.model = model;
    Object.keys(req).forEach(k => { if (req[k] === undefined || req[k] === null) delete req[k]; });
    return req;
  }

  transformResponse(data) { return data; }
  transformStreamChunk(data) { return data; }

  extractUsage(data) {
    if (data.usage) {
      return {
        prompt_tokens: data.usage.input_tokens || 0,
        completion_tokens: data.usage.output_tokens || 0,
        total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        cached_tokens: data.usage.cache_read_input_tokens || 0,
      };
    }
    return null;
  }
}

class OpenAIToAnthropicOutbound extends OutboundTransformer {
  getRequestUrl() {
    const base = this.baseUrl || 'https://api.anthropic.com';
    return `${base.replace(/\/$/, '')}/v1/messages`;
  }

  getHeaders() {
    const apiKey = this.credentials.api_key || this.credentials.apiKey || '';
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  transformRequest(inReq, model) {
    const messages = inReq.messages || [];
    let systemContent = '';
    const convertedMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemContent += (systemContent ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
      } else {
        convertedMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        });
      }
    }

    const req = {
      model,
      messages: convertedMessages,
      max_tokens: inReq.max_tokens || inReq.max_completion_tokens || 4096,
      stream: inReq.stream || false,
    };

    if (systemContent) req.system = systemContent;
    if (inReq.temperature !== undefined) req.temperature = inReq.temperature;
    if (inReq.top_p !== undefined) req.top_p = inReq.top_p;
    if (inReq.stop) req.stop_sequences = Array.isArray(inReq.stop) ? inReq.stop : [inReq.stop];

    return req;
  }

  transformResponse(data) {
    if (data.type === 'message') {
      const content = data.content?.map(c => c.text || '').join('') || '';
      return {
        id: data.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: data.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason,
        }],
        usage: data.usage ? {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        } : undefined,
      };
    }
    return data;
  }

  transformStreamChunk(event) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        choices: [{
          index: 0,
          delta: { content: event.delta.text },
          finish_reason: null,
        }],
      };
    }
    if (event.type === 'message_delta' && event.delta?.stop_reason) {
      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        choices: [{
          index: 0,
          delta: {},
          finish_reason: event.delta.stop_reason === 'end_turn' ? 'stop' : event.delta.stop_reason,
        }],
        usage: event.usage ? {
          prompt_tokens: event.usage.input_tokens,
          completion_tokens: event.usage.output_tokens,
          total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
        } : undefined,
      };
    }
    return null;
  }

  extractUsage(data) {
    if (data.usage) {
      return {
        prompt_tokens: data.usage.input_tokens || data.usage.prompt_tokens || 0,
        completion_tokens: data.usage.output_tokens || data.usage.completion_tokens || 0,
        total_tokens: (data.usage.input_tokens || data.usage.prompt_tokens || 0) + (data.usage.output_tokens || data.usage.completion_tokens || 0),
      };
    }
    return null;
  }
}

module.exports = { AnthropicInbound, AnthropicOutbound, OpenAIToAnthropicOutbound };
