'use strict';

const logger = require('../logger');

/**
 * RequestCloakingService -- obfuscates sensitive content in request bodies
 * before they are sent to upstream LLM providers.
 *
 * Default rules:
 *  - For Anthropic/Claude providers: cloak mentions of competing products
 *  - For OpenAI providers: cloak mentions of competing products
 *  - General: mask API keys, bearer tokens, and secrets found inside prompt text
 */
class RequestCloakingService {
  constructor() {
    /** @type {{ pattern: RegExp, replacement: string, providers: string[] }[]} */
    this.rules = [];

    this._loadDefaultRules();
  }

  // ---- Public API ----

  /**
   * Add a cloaking rule.
   *
   * @param {RegExp} pattern       - The pattern to match inside message content
   * @param {string} replacement   - The replacement string
   * @param {string[]} providers   - Provider types this rule applies to, or ['all']
   */
  addRule(pattern, replacement, providers = ['all']) {
    if (!(pattern instanceof RegExp)) {
      throw new TypeError('pattern must be a RegExp');
    }
    this.rules.push({ pattern, replacement, providers });
  }

  /**
   * Remove all rules (useful for testing or reconfiguration).
   */
  clearRules() {
    this.rules = [];
  }

  /**
   * Apply cloaking rules to a request body before sending upstream.
   *
   * Walks every message's content string and applies matching rules.
   * Returns a deep-ish clone so the original body is not mutated, plus a
   * replacementMap that can be fed to `uncloakResponse()`.
   *
   * @param {object} body          - The request body (OpenAI or Anthropic format)
   * @param {string} providerType  - e.g. 'anthropic', 'openai', 'codex', ...
   * @returns {{ cloakedBody: object, replacementMap: Map<string, string> }}
   */
  cloakRequest(body, providerType) {
    const replacementMap = new Map();
    const cloakedBody = this._deepClone(body);

    const applicableRules = this.rules.filter(r =>
      r.providers.includes('all') || r.providers.includes(providerType),
    );

    if (applicableRules.length === 0) {
      return { cloakedBody, replacementMap };
    }

    // Cloak top-level system string (Anthropic format)
    if (typeof cloakedBody.system === 'string') {
      cloakedBody.system = this._applyRules(cloakedBody.system, applicableRules, replacementMap);
    }

    // Cloak messages array
    if (Array.isArray(cloakedBody.messages)) {
      for (const msg of cloakedBody.messages) {
        if (typeof msg.content === 'string') {
          msg.content = this._applyRules(msg.content, applicableRules, replacementMap);
        } else if (Array.isArray(msg.content)) {
          // Multi-part content (Anthropic content blocks)
          for (const part of msg.content) {
            if (part && typeof part.text === 'string') {
              part.text = this._applyRules(part.text, applicableRules, replacementMap);
            }
          }
        }
      }
    }

    if (replacementMap.size > 0) {
      logger.debug('[Cloaking] Applied cloaking rules', {
        provider: providerType,
        replacements: replacementMap.size,
      });
    }

    return { cloakedBody, replacementMap };
  }

  /**
   * Reverse cloaking on a response body using the replacement map
   * generated during `cloakRequest()`.
   *
   * This is best-effort: it replaces cloaked tokens back to originals
   * wherever they appear in assistant message content.
   *
   * @param {object} body                    - The response body from the provider
   * @param {Map<string, string>} replacementMap - Map of original -> cloaked
   * @returns {object} The uncloaked response body (mutated in place)
   */
  uncloakResponse(body, replacementMap) {
    if (!replacementMap || replacementMap.size === 0) return body;

    // Build reverse map: cloaked -> original
    const reverseMap = new Map();
    for (const [original, cloaked] of replacementMap) {
      reverseMap.set(cloaked, original);
    }

    const uncloak = (text) => {
      let result = text;
      for (const [cloaked, original] of reverseMap) {
        // Global replace of the cloaked token
        result = result.split(cloaked).join(original);
      }
      return result;
    };

    // Uncloak choices (OpenAI format)
    if (Array.isArray(body.choices)) {
      for (const choice of body.choices) {
        if (choice.message && typeof choice.message.content === 'string') {
          choice.message.content = uncloak(choice.message.content);
        }
        if (choice.delta && typeof choice.delta.content === 'string') {
          choice.delta.content = uncloak(choice.delta.content);
        }
      }
    }

    // Uncloak content array (Anthropic format)
    if (Array.isArray(body.content)) {
      for (const block of body.content) {
        if (block && typeof block.text === 'string') {
          block.text = uncloak(block.text);
        }
      }
    }

    return body;
  }

  // ---- Internal helpers ----

  /**
   * Load the default set of cloaking rules.
   */
  _loadDefaultRules() {
    // --- Anthropic/Claude: cloak competitor mentions ---
    this.addRule(
      /\bOpenAI\b/gi,
      '[AI-Provider-A]',
      ['anthropic', 'claudecode'],
    );
    this.addRule(
      /\bGPT[-\s]?[34o][.\d]*\b/gi,
      '[Model-A]',
      ['anthropic', 'claudecode'],
    );
    this.addRule(
      /\bChatGPT\b/gi,
      '[Chatbot-A]',
      ['anthropic', 'claudecode'],
    );

    // --- OpenAI: cloak competitor mentions ---
    this.addRule(
      /\bAnthropic\b/gi,
      '[AI-Provider-B]',
      ['openai', 'codex'],
    );
    this.addRule(
      /\bClaude[-\s]?[\d.]*\b/gi,
      '[Model-B]',
      ['openai', 'codex'],
    );

    // --- General: mask API keys & tokens in prompt content ---
    // Bearer tokens
    this.addRule(
      /\b(Bearer\s+)[A-Za-z0-9_\-]{20,}\b/g,
      '$1[REDACTED_TOKEN]',
      ['all'],
    );
    // Generic API key patterns (sk-..., key-..., etc.)
    this.addRule(
      /\b(sk-|api[_-]?key[=:\s]+)[A-Za-z0-9_\-]{16,}\b/gi,
      '$1[REDACTED_KEY]',
      ['all'],
    );
    // AWS-style secret keys
    this.addRule(
      /(?<=\b(?:aws[_\s]?secret|secret[_\s]?key)[=:\s]*)[A-Za-z0-9/+=]{30,}/gi,
      '[REDACTED_SECRET]',
      ['all'],
    );
  }

  /**
   * Apply a list of rules to a text string, recording replacements.
   *
   * @param {string} text
   * @param {{ pattern: RegExp, replacement: string }[]} rules
   * @param {Map<string, string>} replacementMap
   * @returns {string}
   */
  _applyRules(text, rules, replacementMap) {
    let result = text;
    for (const rule of rules) {
      // Reset lastIndex for global regexes
      if (rule.pattern.global) {
        rule.pattern.lastIndex = 0;
      }

      result = result.replace(rule.pattern, (match, ...args) => {
        // Compute the replacement, supporting $1-style back-references
        const replaced = rule.replacement.replace(/\$(\d+)/g, (_, n) => {
          const idx = parseInt(n, 10) - 1;
          return idx < args.length - 2 ? (args[idx] || '') : _;
        });
        // Track original -> cloaked for potential uncloaking
        if (match !== replaced) {
          replacementMap.set(match, replaced);
        }
        return replaced;
      });
    }
    return result;
  }

  /**
   * Simple deep clone via JSON round-trip (sufficient for JSON request bodies).
   * @param {object} obj
   * @returns {object}
   */
  _deepClone(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return { ...obj };
    }
  }
}

const requestCloakingService = new RequestCloakingService();

module.exports = { RequestCloakingService, requestCloakingService };
