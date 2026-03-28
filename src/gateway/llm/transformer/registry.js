'use strict';

const { registry } = require('./interfaces');
const { OpenAIChatInbound, OpenAIResponsesInbound, OpenAIChatOutbound, OpenAIResponsesOutbound } = require('./openai');
const { AnthropicInbound, AnthropicOutbound, OpenAIToAnthropicOutbound } = require('./anthropic');
const { GeminiInbound, GeminiOutbound, OpenAIToGeminiOutbound } = require('./gemini');
const { CodexOutbound } = require('./codex');
const { DeepSeekOutbound } = require('./deepseek');
const { MoonshotOutbound } = require('./moonshot');
const { DoubaoOutbound } = require('./doubao');
const { ZhipuOutbound } = require('./zhipu');
const { OpenRouterOutbound } = require('./openrouter');
const { XAIOutbound } = require('./xai');

// ---------------------------------------------------------------
// Model aliasing, wildcard exclusions, and fallback chains
// ---------------------------------------------------------------

class ModelRegistry {
  constructor() {
    /** @type {Map<string, string>} alias -> targetModel */
    this._aliases = new Map();
    /** @type {string[]} wildcard exclusion patterns (raw strings) */
    this._exclusions = [];
    /** @type {Map<string, string>} model -> fallbackModel (single hop) */
    this._fallbacks = new Map();
  }

  // --------------- Aliases ---------------

  /**
   * Map a client-facing alias to an upstream model name.
   * e.g. registerAlias('gpt-latest', 'gpt-4-turbo')
   *
   * @param {string} alias
   * @param {string} targetModel
   */
  registerAlias(alias, targetModel) {
    this._aliases.set(alias, targetModel);
  }

  /**
   * Remove a previously registered alias.
   * @param {string} alias
   */
  removeAlias(alias) {
    this._aliases.delete(alias);
  }

  /**
   * Return a shallow copy of all registered aliases.
   * @returns {Record<string, string>}
   */
  getAliases() {
    return Object.fromEntries(this._aliases);
  }

  // --------------- Exclusions ---------------

  /**
   * Block models matching a wildcard pattern.
   * Supported forms:
   *   "gpt-5*"    - prefix match
   *   "*-mini"    - suffix match
   *   "*codex*"   - substring match
   *   "exact-name" - exact match
   *
   * @param {string} pattern
   */
  registerExclusion(pattern) {
    if (!this._exclusions.includes(pattern)) {
      this._exclusions.push(pattern);
    }
  }

  /**
   * Remove a previously registered exclusion pattern.
   * @param {string} pattern
   */
  removeExclusion(pattern) {
    this._exclusions = this._exclusions.filter(p => p !== pattern);
  }

  /**
   * Return the current exclusion pattern list.
   * @returns {string[]}
   */
  getExclusions() {
    return [...this._exclusions];
  }

  /**
   * Check whether `modelName` matches any registered exclusion pattern.
   *
   * @param {string} modelName
   * @returns {boolean}
   */
  isModelExcluded(modelName) {
    for (const pattern of this._exclusions) {
      if (this._matchWildcard(pattern, modelName)) return true;
    }
    return false;
  }

  /**
   * Match a simple wildcard pattern against a value.
   * @param {string} pattern
   * @param {string} value
   * @returns {boolean}
   */
  _matchWildcard(pattern, value) {
    // No wildcard at all -> exact match
    if (!pattern.includes('*')) {
      return pattern === value;
    }

    const startsW = pattern.startsWith('*');
    const endsW = pattern.endsWith('*');

    if (startsW && endsW) {
      // "*codex*" -> substring
      const inner = pattern.slice(1, -1);
      return inner.length === 0 || value.includes(inner);
    }
    if (endsW) {
      // "gpt-5*" -> prefix
      const prefix = pattern.slice(0, -1);
      return value.startsWith(prefix);
    }
    if (startsW) {
      // "*-mini" -> suffix
      const suffix = pattern.slice(1);
      return value.endsWith(suffix);
    }

    // General case: split on '*' and match segments in order
    const parts = pattern.split('*');
    let idx = 0;
    for (const part of parts) {
      if (part === '') continue;
      const found = value.indexOf(part, idx);
      if (found === -1) return false;
      idx = found + part.length;
    }
    return true;
  }

  // --------------- Fallbacks ---------------

  /**
   * Register a fallback: when `model` is unavailable, try `fallbackModel`.
   * Multiple hops are supported by chaining registrations.
   *
   * @param {string} model
   * @param {string} fallbackModel
   */
  registerFallback(model, fallbackModel) {
    this._fallbacks.set(model, fallbackModel);
  }

  /**
   * Remove a fallback registration.
   * @param {string} model
   */
  removeFallback(model) {
    this._fallbacks.delete(model);
  }

  /**
   * Get the ordered fallback chain starting from `model`.
   * Follows single-hop links, guarding against cycles.
   *
   * @param {string} model
   * @returns {string[]} list of fallback models (does NOT include the input model)
   */
  getFallbackChain(model) {
    const chain = [];
    const visited = new Set();
    visited.add(model);

    let current = model;
    while (this._fallbacks.has(current)) {
      const next = this._fallbacks.get(current);
      if (visited.has(next)) break; // cycle guard
      visited.add(next);
      chain.push(next);
      current = next;
    }
    return chain;
  }

  // --------------- Unified resolution ---------------

  /**
   * Resolve the requested model name:
   *   1. Follow alias chain (guarding against cycles).
   *   2. Check exclusion rules -- throw if excluded.
   *
   * @param {string} requestedModel
   * @returns {string} the resolved upstream model name
   * @throws {Error} if the resolved model is excluded
   */
  resolveModel(requestedModel) {
    // Follow aliases (with cycle guard)
    let resolved = requestedModel;
    const visited = new Set();
    while (this._aliases.has(resolved)) {
      if (visited.has(resolved)) break; // cycle guard
      visited.add(resolved);
      resolved = this._aliases.get(resolved);
    }

    // Check exclusions
    if (this.isModelExcluded(resolved)) {
      const err = new Error(`Model "${resolved}" is excluded by policy`);
      err.code = 'MODEL_EXCLUDED';
      throw err;
    }

    return resolved;
  }
}

const modelRegistry = new ModelRegistry();

// ---------------------------------------------------------------
// Transformer registrations (unchanged)
// ---------------------------------------------------------------

// Inbound transformers (client request format -> internal)
registry.registerInbound('openai/chat_completions', OpenAIChatInbound);
registry.registerInbound('openai/responses', OpenAIResponsesInbound);
registry.registerInbound('anthropic/messages', AnthropicInbound);
registry.registerInbound('gemini/generateContent', GeminiInbound);
registry.registerInbound('gemini/streamGenerateContent', GeminiInbound);
registry.registerInbound('openai/embeddings', OpenAIChatInbound);
registry.registerInbound('openai/images', OpenAIChatInbound);

// Outbound transformers (internal -> provider)
registry.registerOutbound('openai', OpenAIChatOutbound);
registry.registerOutbound('openai_responses', OpenAIResponsesOutbound);
registry.registerOutbound('codex', CodexOutbound);
registry.registerOutbound('anthropic', OpenAIToAnthropicOutbound);
registry.registerOutbound('anthropic_aws', OpenAIToAnthropicOutbound);
registry.registerOutbound('anthropic_gcp', OpenAIToAnthropicOutbound);
registry.registerOutbound('gemini', GeminiOutbound);
registry.registerOutbound('gemini_openai', OpenAIToGeminiOutbound);
registry.registerOutbound('gemini_vertex', GeminiOutbound);
registry.registerOutbound('deepseek', DeepSeekOutbound);
registry.registerOutbound('deepseek_anthropic', DeepSeekOutbound);
registry.registerOutbound('moonshot', MoonshotOutbound);
registry.registerOutbound('moonshot_anthropic', MoonshotOutbound);
registry.registerOutbound('doubao', DoubaoOutbound);
registry.registerOutbound('doubao_anthropic', DoubaoOutbound);
registry.registerOutbound('zhipu', ZhipuOutbound);
registry.registerOutbound('zhipu_anthropic', ZhipuOutbound);
registry.registerOutbound('openrouter', OpenRouterOutbound);
registry.registerOutbound('xai', XAIOutbound);

// OpenAI-compatible providers (reuse OpenAI outbound)
const oaiCompatible = [
  'siliconflow', 'ppio', 'deepinfra', 'cerebras', 'minimax',
  'minimax_anthropic', 'aihubmix', 'burncloud', 'volcengine',
  'github', 'longcat', 'longcat_anthropic', 'modelscope', 'bailian',
  'nanogpt', 'antigravity', 'vercel',
];
oaiCompatible.forEach(type => {
  registry.registerOutbound(type, OpenAIChatOutbound);
});

// GitHub Copilot uses OpenAI format
registry.registerOutbound('github_copilot', OpenAIChatOutbound);
registry.registerOutbound('claudecode', OpenAIToAnthropicOutbound);

module.exports = { registry, ModelRegistry, modelRegistry };
