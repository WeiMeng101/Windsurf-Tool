'use strict';

const { InboundTransformer, OutboundTransformer } = require('../interfaces');

class OpenAIChatInbound extends InboundTransformer {
  getModel(body) { return body.model; }
  isStream(body) { return !!body.stream; }

  buildRequest(body) {
    return {
      model: body.model,
      messages: body.messages,
      temperature: body.temperature,
      top_p: body.top_p,
      max_tokens: body.max_tokens,
      max_completion_tokens: body.max_completion_tokens,
      stream: body.stream,
      stream_options: body.stream_options,
      stop: body.stop,
      presence_penalty: body.presence_penalty,
      frequency_penalty: body.frequency_penalty,
      logit_bias: body.logit_bias,
      user: body.user,
      tools: body.tools,
      tool_choice: body.tool_choice,
      response_format: body.response_format,
      seed: body.seed,
      n: body.n,
    };
  }

  parseResponse(data) { return data; }
  parseStreamChunk(data) { return data; }
  extractUsage(data) { return data.usage || null; }
}

class OpenAIResponsesInbound extends InboundTransformer {
  getModel(body) { return body.model; }
  isStream(body) { return body.stream !== false; }

  buildRequest(body) {
    return {
      model: body.model,
      input: body.input,
      instructions: body.instructions,
      temperature: body.temperature,
      top_p: body.top_p,
      max_output_tokens: body.max_output_tokens,
      stream: body.stream !== false,
      tools: body.tools,
      tool_choice: body.tool_choice,
      previous_response_id: body.previous_response_id,
      reasoning: body.reasoning,
      metadata: body.metadata,
    };
  }

  parseResponse(data) { return data; }
  parseStreamChunk(data) { return data; }
  extractUsage(data) { return data.usage || null; }
}

class OpenAIChatOutbound extends OutboundTransformer {
  getRequestUrl(model) {
    const base = this.baseUrl || 'https://api.openai.com';
    return `${base.replace(/\/$/, '')}/v1/chat/completions`;
  }

  getHeaders() {
    const apiKey = this.credentials.api_key || this.credentials.apiKey || '';
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
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
        prompt_tokens: data.usage.prompt_tokens || 0,
        completion_tokens: data.usage.completion_tokens || 0,
        total_tokens: data.usage.total_tokens || 0,
        prompt_tokens_details: data.usage.prompt_tokens_details || null,
      };
    }
    return null;
  }
}

class OpenAIResponsesOutbound extends OutboundTransformer {
  getRequestUrl(model) {
    const base = this.baseUrl || 'https://api.openai.com';
    return `${base.replace(/\/$/, '')}/v1/responses`;
  }

  getHeaders() {
    const apiKey = this.credentials.api_key || this.credentials.apiKey || '';
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
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
  extractUsage(data) { return data.usage || null; }
}

module.exports = {
  OpenAIChatInbound,
  OpenAIResponsesInbound,
  OpenAIChatOutbound,
  OpenAIResponsesOutbound,
};
