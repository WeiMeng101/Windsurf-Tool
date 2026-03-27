'use strict';

/**
 * SSE stream utilities for handling streaming LLM responses.
 * Mirrors AxonHub's llm/streams and llm/pipeline/stream.go
 */

function writeSSE(res, data) {
  if (typeof data === 'string') {
    res.write(`data: ${data}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function endSSE(res) {
  res.write('data: [DONE]\n\n');
  res.end();
}

function setupSSEHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

async function* parseSSEStream(response) {
  const reader = response.body;
  let buffer = '';

  for await (const chunk of reader) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          yield { done: true, data: '[DONE]' };
          return;
        }
        try {
          yield { done: false, data: JSON.parse(data) };
        } catch {
          yield { done: false, data, raw: true };
        }
      }
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data: ')) {
      const data = trimmed.slice(6);
      if (data !== '[DONE]') {
        try {
          yield { done: false, data: JSON.parse(data) };
        } catch {
          yield { done: false, data, raw: true };
        }
      }
    }
  }
}

class UsageAccumulator {
  constructor() {
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.totalTokens = 0;
    this.cachedTokens = 0;
    this.promptTokensDetails = null;
  }

  update(usage) {
    if (!usage) return;
    if (usage.prompt_tokens) this.promptTokens = usage.prompt_tokens;
    if (usage.completion_tokens) this.completionTokens = usage.completion_tokens;
    if (usage.total_tokens) this.totalTokens = usage.total_tokens;
    if (usage.prompt_tokens_details) {
      this.promptTokensDetails = usage.prompt_tokens_details;
      if (usage.prompt_tokens_details.cached_tokens) {
        this.cachedTokens = usage.prompt_tokens_details.cached_tokens;
      }
    }
  }

  toJSON() {
    return {
      prompt_tokens: this.promptTokens,
      completion_tokens: this.completionTokens,
      total_tokens: this.totalTokens || (this.promptTokens + this.completionTokens),
      cached_tokens: this.cachedTokens,
      prompt_tokens_details: this.promptTokensDetails,
    };
  }
}

module.exports = { writeSSE, endSSE, setupSSEHeaders, parseSSEStream, UsageAccumulator };
