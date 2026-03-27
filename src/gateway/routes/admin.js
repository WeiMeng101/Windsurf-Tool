'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { cacheManager } = require('../cache');
const logger = require('../logger');
const router = Router();

// ===== Channels CRUD =====
router.get('/channels', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM channels WHERE deleted_at IS NULL ORDER BY ordering_weight DESC, id ASC').all();
  const parsed = rows.map(r => ({
    ...r,
    credentials: JSON.parse(r.credentials || '{}'),
    supported_models: JSON.parse(r.supported_models || '[]'),
    manual_models: JSON.parse(r.manual_models || '[]'),
    tags: JSON.parse(r.tags || '[]'),
    policies: JSON.parse(r.policies || '{}'),
    settings: JSON.parse(r.settings || '{}'),
  }));
  res.json({ data: parsed, total: parsed.length });
});

router.get('/channels/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ error: { message: 'Channel not found' } });
  row.credentials = JSON.parse(row.credentials || '{}');
  row.supported_models = JSON.parse(row.supported_models || '[]');
  row.manual_models = JSON.parse(row.manual_models || '[]');
  row.tags = JSON.parse(row.tags || '[]');
  row.policies = JSON.parse(row.policies || '{}');
  row.settings = JSON.parse(row.settings || '{}');
  res.json({ data: row });
});

router.post('/channels', (req, res) => {
  const db = getDb();
  const { type, name, base_url, credentials, supported_models, manual_models, tags, default_test_model, policies, settings, ordering_weight, remark } = req.body;
  if (!type || !name) return res.status(400).json({ error: { message: 'type and name are required' } });

  try {
    const result = db.prepare(`
      INSERT INTO channels (type, name, base_url, status, credentials, supported_models, manual_models, tags, default_test_model, policies, settings, ordering_weight, remark)
      VALUES (?, ?, ?, 'enabled', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      type, name, base_url || '',
      JSON.stringify(credentials || {}),
      JSON.stringify(supported_models || []),
      JSON.stringify(manual_models || []),
      JSON.stringify(tags || []),
      default_test_model || '',
      JSON.stringify(policies || {}),
      JSON.stringify(settings || {}),
      ordering_weight || 0,
      remark || null
    );
    cacheManager.flush('channels');
    const created = db.prepare('SELECT * FROM channels WHERE id = ?').get(result.lastInsertRowid);
    logger.info(`Channel created: ${name} (${type})`);
    res.status(201).json({ data: created });
  } catch (err) {
    logger.error('Failed to create channel', { error: err.message });
    res.status(400).json({ error: { message: err.message } });
  }
});

router.patch('/channels/:id', (req, res) => {
  const db = getDb();
  const fields = [];
  const values = [];
  const allowed = ['name', 'base_url', 'status', 'credentials', 'supported_models', 'manual_models', 'tags', 'default_test_model', 'policies', 'settings', 'ordering_weight', 'error_message', 'remark', 'auto_sync_supported_models', 'auto_sync_model_pattern'];
  const jsonFields = new Set(['credentials', 'supported_models', 'manual_models', 'tags', 'policies', 'settings']);

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(jsonFields.has(key) ? JSON.stringify(req.body[key]) : req.body[key]);
    }
  }
  if (fields.length === 0) return res.status(400).json({ error: { message: 'No fields to update' } });

  fields.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE channels SET ${fields.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...values);
  cacheManager.flush('channels');
  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  res.json({ data: updated });
});

router.delete('/channels/:id', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE channels SET deleted_at = datetime('now'), status = 'archived' WHERE id = ?").run(req.params.id);
  cacheManager.flush('channels');
  res.json({ success: true });
});

// ===== Models CRUD =====
router.get('/models', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM models WHERE deleted_at IS NULL ORDER BY name ASC').all();
  res.json({ data: rows.map(r => ({ ...r, model_card: JSON.parse(r.model_card || '{}'), settings: JSON.parse(r.settings || '{}') })), total: rows.length });
});

router.post('/models', (req, res) => {
  const db = getDb();
  const { developer, model_id, type, name, icon, model_group, model_card, settings, remark } = req.body;
  if (!model_id || !name) return res.status(400).json({ error: { message: 'model_id and name are required' } });
  try {
    const result = db.prepare(`
      INSERT INTO models (developer, model_id, type, name, icon, model_group, model_card, settings, status, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?)
    `).run(developer || '', model_id, type || 'chat', name, icon || '', model_group || '', JSON.stringify(model_card || {}), JSON.stringify(settings || {}), remark || null);
    cacheManager.flush('models');
    res.status(201).json({ data: db.prepare('SELECT * FROM models WHERE id = ?').get(result.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

router.patch('/models/:id', (req, res) => {
  const db = getDb();
  const fields = [];
  const values = [];
  const allowed = ['developer', 'model_id', 'type', 'name', 'icon', 'model_group', 'model_card', 'settings', 'status', 'remark'];
  const jsonFields = new Set(['model_card', 'settings']);
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(jsonFields.has(key) ? JSON.stringify(req.body[key]) : req.body[key]);
    }
  }
  if (fields.length === 0) return res.status(400).json({ error: { message: 'No fields to update' } });
  fields.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE models SET ${fields.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...values);
  cacheManager.flush('models');
  res.json({ data: db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id) });
});

router.delete('/models/:id', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE models SET deleted_at = datetime('now'), status = 'archived' WHERE id = ?").run(req.params.id);
  cacheManager.flush('models');
  res.json({ success: true });
});

// ===== API Keys CRUD =====
router.get('/api-keys', (req, res) => {
  const db = getDb();
  const projectId = req.query.project_id || 1;
  const rows = db.prepare('SELECT id, user_id, project_id, key, name, type, status, scopes, profiles, created_at, updated_at FROM api_keys WHERE project_id = ? AND deleted_at IS NULL ORDER BY id DESC').all(projectId);
  res.json({ data: rows.map(r => ({ ...r, scopes: JSON.parse(r.scopes || '[]'), profiles: JSON.parse(r.profiles || '{}') })), total: rows.length });
});

router.post('/api-keys', (req, res) => {
  const db = getDb();
  const { name, type, project_id, scopes } = req.body;
  if (!name) return res.status(400).json({ error: { message: 'name is required' } });
  const { v4: uuidv4 } = require('uuid');
  const key = `sk-gw-${uuidv4().replace(/-/g, '')}`;
  try {
    const result = db.prepare(`
      INSERT INTO api_keys (user_id, project_id, key, name, type, scopes) VALUES (?, ?, ?, ?, ?, ?)
    `).run(1, project_id || 1, key, name, type || 'user', JSON.stringify(scopes || ['read_channels', 'write_requests']));
    res.status(201).json({ data: db.prepare('SELECT * FROM api_keys WHERE id = ?').get(result.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

router.delete('/api-keys/:id', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE api_keys SET deleted_at = datetime('now'), status = 'archived' WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ===== Requests / Traces / Threads (read-only for admin) =====
router.get('/requests', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const projectId = req.query.project_id || 1;
  const rows = db.prepare('SELECT * FROM requests WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(projectId, limit, offset);
  const total = db.prepare('SELECT COUNT(*) as count FROM requests WHERE project_id = ?').get(projectId);
  res.json({ data: rows, total: total.count, limit, offset });
});

router.get('/requests/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: { message: 'Request not found' } });
  row.request_body = JSON.parse(row.request_body || '{}');
  row.response_body = row.response_body ? JSON.parse(row.response_body) : null;
  const executions = db.prepare('SELECT * FROM request_executions WHERE request_id = ? ORDER BY attempt_number ASC').all(req.params.id);
  const usageLogs = db.prepare('SELECT * FROM usage_logs WHERE request_id = ?').all(req.params.id);
  res.json({ data: { ...row, executions, usage_logs: usageLogs } });
});

router.get('/traces', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const projectId = req.query.project_id || 1;
  const rows = db.prepare('SELECT * FROM traces WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(projectId, limit, offset);
  const total = db.prepare('SELECT COUNT(*) as count FROM traces WHERE project_id = ?').get(projectId);
  res.json({ data: rows, total: total.count });
});

router.get('/threads', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const projectId = req.query.project_id || 1;
  const rows = db.prepare('SELECT * FROM threads WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(projectId, limit, offset);
  const total = db.prepare('SELECT COUNT(*) as count FROM threads WHERE project_id = ?').get(projectId);
  res.json({ data: rows, total: total.count });
});

// ===== Dashboard stats =====
router.get('/dashboard/stats', (req, res) => {
  const db = getDb();
  const projectId = req.query.project_id || 1;
  const since = req.query.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const totalRequests = db.prepare('SELECT COUNT(*) as count FROM requests WHERE project_id = ? AND created_at >= ?').get(projectId, since);
  const successRequests = db.prepare("SELECT COUNT(*) as count FROM requests WHERE project_id = ? AND created_at >= ? AND status = 'completed'").get(projectId, since);
  const failedRequests = db.prepare("SELECT COUNT(*) as count FROM requests WHERE project_id = ? AND created_at >= ? AND status = 'failed'").get(projectId, since);
  const totalTokens = db.prepare('SELECT COALESCE(SUM(total_tokens), 0) as total FROM usage_logs WHERE project_id = ? AND created_at >= ?').get(projectId, since);
  const totalCost = db.prepare('SELECT COALESCE(SUM(CAST(cost AS REAL)), 0) as total FROM usage_logs WHERE project_id = ? AND created_at >= ?').get(projectId, since);
  const avgLatency = db.prepare('SELECT AVG(metrics_latency_ms) as avg FROM requests WHERE project_id = ? AND created_at >= ? AND metrics_latency_ms IS NOT NULL').get(projectId, since);
  const activeChannels = db.prepare("SELECT COUNT(*) as count FROM channels WHERE status = 'enabled' AND deleted_at IS NULL").get();
  const activeApiKeys = db.prepare("SELECT COUNT(*) as count FROM api_keys WHERE status = 'enabled' AND deleted_at IS NULL AND project_id = ?").get(projectId);

  res.json({
    data: {
      total_requests: totalRequests.count,
      success_requests: successRequests.count,
      failed_requests: failedRequests.count,
      success_rate: totalRequests.count > 0 ? (successRequests.count / totalRequests.count * 100).toFixed(1) : '0.0',
      total_tokens: totalTokens.total,
      total_cost: parseFloat(totalCost.total).toFixed(4),
      avg_latency_ms: avgLatency.avg ? Math.round(avgLatency.avg) : 0,
      active_channels: activeChannels.count,
      active_api_keys: activeApiKeys.count,
    }
  });
});

router.get('/dashboard/usage-trend', (req, res) => {
  const db = getDb();
  const projectId = req.query.project_id || 1;
  const days = parseInt(req.query.days) || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT DATE(created_at) as date,
           COUNT(*) as request_count,
           COALESCE(SUM(total_tokens), 0) as tokens,
           COALESCE(SUM(CAST(cost AS REAL)), 0) as cost
    FROM usage_logs
    WHERE project_id = ? AND created_at >= ?
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `).all(projectId, since);

  res.json({ data: rows });
});

// ===== System Settings =====
router.get('/system/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM systems').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json({ data: settings });
});

router.patch('/system/settings', (req, res) => {
  const db = getDb();
  const upsert = db.prepare("INSERT INTO systems (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  const transaction = db.transaction((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      upsert.run(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  });
  transaction(req.body);
  cacheManager.flush('system');
  res.json({ success: true });
});

// ===== Users CRUD =====
router.get('/users', (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT id, email, first_name, last_name, avatar, role, status, created_at, updated_at FROM users WHERE deleted_at IS NULL ORDER BY id ASC").all();
  res.json({ data: rows, total: rows.length });
});

// ===== Roles CRUD =====
router.get('/roles', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM roles WHERE deleted_at IS NULL ORDER BY id ASC').all();
  res.json({ data: rows.map(r => ({ ...r, scopes: JSON.parse(r.scopes || '[]') })), total: rows.length });
});

// ===== Usage Logs =====
router.get('/usage-logs', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const projectId = req.query.project_id || 1;
  const rows = db.prepare('SELECT * FROM usage_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(projectId, limit, offset);
  res.json({ data: rows, total: db.prepare('SELECT COUNT(*) as count FROM usage_logs WHERE project_id = ?').get(projectId).count });
});

// ===== Prompt Protection Rules =====
router.get('/prompt-protection-rules', (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM prompt_protection_rules WHERE deleted_at IS NULL ORDER BY ordering ASC").all();
  res.json({ data: rows, total: rows.length });
});

router.post('/prompt-protection-rules', (req, res) => {
  const db = getDb();
  const { name, description, type, pattern, action, replacement, ordering } = req.body;
  if (!name || !pattern) return res.status(400).json({ error: { message: 'name and pattern are required' } });
  const result = db.prepare(`
    INSERT INTO prompt_protection_rules (name, description, type, pattern, action, replacement, ordering)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, description || '', type || 'keyword', pattern, action || 'block', replacement || '', ordering || 0);
  res.status(201).json({ data: db.prepare('SELECT * FROM prompt_protection_rules WHERE id = ?').get(result.lastInsertRowid) });
});

// ===== Prompts =====
router.get('/prompts', (req, res) => {
  const db = getDb();
  const projectId = req.query.project_id || 1;
  const rows = db.prepare("SELECT * FROM prompts WHERE project_id = ? AND deleted_at IS NULL ORDER BY ordering ASC").all(projectId);
  res.json({ data: rows, total: rows.length });
});

// ===== Backup/Export =====
router.get('/backup/export', (req, res) => {
  const { backupService } = require('../biz/backup');
  const data = backupService.exportConfig();
  res.json({ data });
});

router.post('/backup/import', (req, res) => {
  try {
    const { backupService } = require('../biz/backup');
    backupService.importConfig(req.body);
    res.json({ success: true, message: 'Config imported successfully' });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

// ===== Account Integration =====
router.post('/accounts/sync', (req, res) => {
  try {
    const { accountIntegrationService } = require('../biz/accountIntegration');
    const result = accountIntegrationService.syncAccountsToChannels(req.body.accounts || []);
    res.json({ data: result });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

router.get('/accounts/auto-imported', (req, res) => {
  const { accountIntegrationService } = require('../biz/accountIntegration');
  const channels = accountIntegrationService.getAutoImportedChannels();
  res.json({ data: channels, total: channels.length });
});

// ===== Load Balancer Stats =====
router.get('/lb/stats', (req, res) => {
  const { loadBalancer } = require('../biz/loadBalancer');
  res.json({ data: loadBalancer.getAllStats() });
});

module.exports = router;
