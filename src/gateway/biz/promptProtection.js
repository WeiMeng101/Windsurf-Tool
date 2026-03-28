'use strict';

const { getDb } = require('../db');
const logger = require('../logger');

class PromptProtectionService {
  constructor() {
    /**
     * Runtime-only rules that exist alongside the DB-persisted rules.
     * Each entry: { id, name, type, pattern, action, replacement, status, ordering, created_at }
     */
    this._runtimeRules = [];
    this._nextRuntimeId = 1;

    /** Block statistics keyed by rule identifier (db id or runtime id string). */
    this._stats = {};
  }

  checkRequest(messages) {
    const db = getDb();
    const dbRules = db.prepare("SELECT * FROM prompt_protection_rules WHERE status = 'enabled' AND deleted_at IS NULL ORDER BY ordering ASC").all();

    // Merge DB rules and runtime rules, sorted by ordering
    const allRules = [
      ...dbRules,
      ...this._runtimeRules.filter(r => r.status === 'enabled'),
    ].sort((a, b) => (a.ordering || 0) - (b.ordering || 0));

    if (allRules.length === 0) return { allowed: true };

    for (const rule of allRules) {
      const ruleKey = this._ruleKey(rule);

      for (const msg of messages || []) {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const violation = this.checkRule(rule, content);
        if (violation) {
          // Track statistics
          this._stats[ruleKey] = (this._stats[ruleKey] || 0) + 1;

          logger.warn(`Prompt protection triggered: ${rule.name}`, { rule_id: rule.id, action: rule.action });
          switch (rule.action) {
            case 'block':
              return { allowed: false, rule: rule.name, message: `Request blocked by protection rule: ${rule.name}` };
            case 'warn':
              return { allowed: true, warning: `Prompt protection warning: ${rule.name}` };
            case 'replace':
              msg.content = content.replace(violation.match, rule.replacement || '[REDACTED]');
              break;
          }
        }
      }
    }

    return { allowed: true };
  }

  checkRule(rule, content) {
    if (!content) return null;

    switch (rule.type) {
      case 'keyword': {
        const keywords = rule.pattern.split(',').map(k => k.trim().toLowerCase());
        const lower = content.toLowerCase();
        for (const keyword of keywords) {
          if (keyword && lower.includes(keyword)) {
            return { match: keyword };
          }
        }
        return null;
      }
      case 'regex': {
        try {
          const regex = new RegExp(rule.pattern, 'gi');
          const match = regex.exec(content);
          return match ? { match: match[0] } : null;
        } catch {
          return null;
        }
      }
      case 'semantic':
        return null;
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Runtime rule management
  // ---------------------------------------------------------------------------

  /**
   * Add a new blocking rule at runtime (not persisted to DB).
   * rule: { name, type, pattern, action, replacement?, ordering? }
   * Returns the created rule (with generated id).
   */
  addRule(rule) {
    const id = `runtime-${this._nextRuntimeId++}`;
    const newRule = {
      id,
      name: rule.name || id,
      type: rule.type || 'keyword',
      pattern: rule.pattern || '',
      action: rule.action || 'block',
      replacement: rule.replacement || null,
      status: 'enabled',
      ordering: rule.ordering != null ? rule.ordering : 100,
      created_at: new Date().toISOString(),
    };
    this._runtimeRules.push(newRule);
    this._stats[id] = 0;
    logger.info(`Runtime rule added: ${newRule.name} (${id})`);
    return newRule;
  }

  /**
   * Remove a runtime rule by its id.
   * Returns true if the rule was found and removed.
   */
  removeRule(ruleId) {
    const idx = this._runtimeRules.findIndex(r => r.id === ruleId);
    if (idx === -1) return false;
    this._runtimeRules.splice(idx, 1);
    delete this._stats[ruleId];
    logger.info(`Runtime rule removed: ${ruleId}`);
    return true;
  }

  /**
   * List all active rules (DB + runtime) with metadata.
   */
  listRules() {
    const db = getDb();
    const dbRules = db.prepare("SELECT * FROM prompt_protection_rules WHERE deleted_at IS NULL ORDER BY ordering ASC").all();

    const enriched = dbRules.map(r => ({
      ...r,
      source: 'database',
      blockCount: this._stats[this._ruleKey(r)] || 0,
    }));

    const runtimeEnriched = this._runtimeRules.map(r => ({
      ...r,
      source: 'runtime',
      blockCount: this._stats[r.id] || 0,
    }));

    return [...enriched, ...runtimeEnriched];
  }

  /**
   * Test a rule against sample input without activating it.
   * Returns { matched: boolean, violation: object|null }.
   */
  testRule(rule, input) {
    const pseudoRule = {
      type: rule.type || 'keyword',
      pattern: rule.pattern || '',
    };
    const violation = this.checkRule(pseudoRule, input);
    return {
      matched: Boolean(violation),
      violation,
    };
  }

  /**
   * Return block counts per rule.
   */
  getStats() {
    return { ...this._stats };
  }

  /** Internal helper to build a stats key for a rule. */
  _ruleKey(rule) {
    // Runtime rules use their string id; DB rules use numeric id prefixed
    if (typeof rule.id === 'string' && rule.id.startsWith('runtime-')) return rule.id;
    return `db-${rule.id}`;
  }
}

const promptProtectionService = new PromptProtectionService();

module.exports = { PromptProtectionService, promptProtectionService };
