'use strict';

const { OutboundTransformer } = require('../interfaces');

const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex#';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const USER_AGENT = 'codex_cli_rs/0.116.0 (Mac OS 15.6.1; arm64) iTerm.app/3.6.6';

const DEFAULT_MODELS = [
  'gpt-5', 'gpt-5-codex', 'gpt-5-codex-mini',
  'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1-codex-max',
  'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.3-codex', 'gpt-5.4',
];

const CODEX_HEADERS = [
  ['Accept', 'text/event-stream'],
  ['Connection', 'Keep-Alive'],
  ['Openai-Beta', 'responses=experimental'],
  ['Originator', 'codex_cli_rs'],
];

class CodexOutbound extends OutboundTransformer {
  constructor(channel) {
    super(channel);
    this.tokenProvider = null;
  }

  getRequestUrl() {
    const base = this.baseUrl;
    if (!base || base === 'https://api.openai.com/v1') {
      return CODEX_API_URL;
    }
    return `${base.replace(/\/$/, '').replace(/#$/, '')}/responses`;
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    };
    CODEX_HEADERS.forEach(([k, v]) => { headers[k] = v; });

    if (this.tokenProvider) {
      const token = this.tokenProvider.getCurrentToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    } else if (this.credentials.access_token) {
      headers['Authorization'] = `Bearer ${this.credentials.access_token}`;
    } else if (this.credentials.api_key) {
      headers['Authorization'] = `Bearer ${this.credentials.api_key}`;
    }

    return headers;
  }

  transformRequest(inReq, model) {
    const isResponsesFormat = inReq.input !== undefined;

    if (isResponsesFormat) {
      const req = {
        model,
        input: inReq.input,
        stream: true,
      };
      if (inReq.instructions) req.instructions = inReq.instructions;
      if (inReq.tools) req.tools = inReq.tools;
      if (inReq.temperature !== undefined) req.temperature = inReq.temperature;
      if (inReq.max_output_tokens) req.max_output_tokens = inReq.max_output_tokens;
      if (inReq.previous_response_id) req.previous_response_id = inReq.previous_response_id;
      if (inReq.reasoning) req.reasoning = inReq.reasoning;
      return req;
    }

    const messages = inReq.messages || [];
    const input = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue;
      input.push({
        type: 'message',
        role: msg.role,
        content: typeof msg.content === 'string'
          ? [{ type: 'input_text', text: msg.content }]
          : msg.content,
      });
    }

    const systemMsg = messages.find(m => m.role === 'system');
    const req = {
      model,
      input,
      stream: true,
    };
    if (systemMsg) {
      req.instructions = typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content);
    }
    if (inReq.tools) req.tools = inReq.tools;
    if (inReq.temperature !== undefined) req.temperature = inReq.temperature;
    if (inReq.max_tokens || inReq.max_completion_tokens) {
      req.max_output_tokens = inReq.max_tokens || inReq.max_completion_tokens;
    }
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
      };
    }
    return null;
  }

  setTokenProvider(provider) {
    this.tokenProvider = provider;
  }

  static getDefaultModels() {
    return DEFAULT_MODELS;
  }

  static getOAuthConfig() {
    return {
      authorizeUrl: AUTHORIZE_URL,
      tokenUrl: TOKEN_URL,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scopes: 'openid profile email offline_access',
    };
  }
}

module.exports = { CodexOutbound, DEFAULT_MODELS, CODEX_API_URL, CODEX_BASE_URL };
