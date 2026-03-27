'use strict';

const { getDb } = require('../db');
const logger = require('../logger');

class PromptProtectionService {
  checkRequest(messages) {
    const db = getDb();
    const rules = db.prepare("SELECT * FROM prompt_protection_rules WHERE status = 'enabled' AND deleted_at IS NULL ORDER BY ordering ASC").all();

    if (rules.length === 0) return { allowed: true };

    for (const rule of rules) {
      for (const msg of messages || []) {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const violation = this.checkRule(rule, content);
        if (violation) {
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
}

const promptProtectionService = new PromptProtectionService();

module.exports = { PromptProtectionService, promptProtectionService };
