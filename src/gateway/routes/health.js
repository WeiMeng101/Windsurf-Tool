'use strict';

const { Router } = require('express');
const router = Router();

const startedAt = Date.now();
let totalRequestsServed = 0;
let activeConnections = 0;

// Track requests globally for /health/deep
router.use((req, res, next) => {
  totalRequestsServed++;
  activeConnections++;
  res.on('finish', () => { activeConnections--; });
  next();
});

// Quick liveness check (existing, fast)
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'windsurf-gateway', timestamp: new Date().toISOString() });
});

router.get('/version', (req, res) => {
  const { getDb } = require('../db');
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM systems WHERE key = 'system_version'").get();
    res.json({ version: row ? row.value : '1.0.0' });
  } catch {
    res.json({ version: '1.0.0' });
  }
});

// Readiness probe
router.get('/health/ready', (req, res) => {
  const checks = { database: false, channels_configured: false };
  let ready = true;

  try {
    const { getDb } = require('../db');
    const db = getDb();
    // Simple connectivity test
    const row = db.prepare('SELECT 1 AS ok').get();
    checks.database = row && row.ok === 1;
  } catch {
    checks.database = false;
  }

  if (!checks.database) {
    ready = false;
  }

  try {
    const { getDb } = require('../db');
    const db = getDb();
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM channels WHERE status = 'enabled' AND deleted_at IS NULL").get();
    checks.channels_configured = count && count.cnt > 0;
  } catch {
    checks.channels_configured = false;
  }

  if (!checks.channels_configured) {
    ready = false;
  }

  const statusCode = ready ? 200 : 503;
  res.status(statusCode).json({
    status: ready ? 'ready' : 'not_ready',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// Comprehensive deep health check
router.get('/health/deep', (req, res) => {
  const components = {};

  // --- Database ---
  const dbStatus = { status: 'down', connectivity: false, migration_version: null, tables: {} };
  try {
    const { getDb } = require('../db');
    const db = getDb();

    // Connectivity
    const row = db.prepare('SELECT 1 AS ok').get();
    dbStatus.connectivity = row && row.ok === 1;

    // Migration version
    try {
      const migRow = db.prepare('SELECT MAX(version) AS ver FROM schema_migrations').get();
      dbStatus.migration_version = migRow ? migRow.ver : null;
    } catch { /* table may not exist */ }

    // Table counts for key tables
    const tables = ['channels', 'models', 'api_keys', 'requests', 'usage_logs', 'pool_accounts', 'audit_logs'];
    for (const table of tables) {
      try {
        const cnt = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get();
        dbStatus.tables[table] = cnt.cnt;
      } catch {
        dbStatus.tables[table] = null; // table does not exist
      }
    }

    dbStatus.status = dbStatus.connectivity ? 'ok' : 'degraded';
  } catch (err) {
    dbStatus.status = 'down';
    dbStatus.error = err.message;
  }
  components.database = dbStatus;

  // --- Providers ---
  const providersStatus = { status: 'ok', transformers: {} };
  try {
    const { getDb } = require('../db');
    const db = getDb();
    const channels = db.prepare("SELECT id, type, name FROM channels WHERE status = 'enabled' AND deleted_at IS NULL").all();
    const { registry } = require('../llm/transformer/registry');

    const typeSet = new Set(channels.map(ch => ch.type));
    for (const type of typeSet) {
      const hasTransformer = !!registry.outboundMap[type];
      providersStatus.transformers[type] = {
        has_transformer: hasTransformer,
        channel_count: channels.filter(ch => ch.type === type).length,
      };
      if (!hasTransformer) {
        providersStatus.status = 'degraded';
      }
    }
  } catch (err) {
    providersStatus.status = 'degraded';
    providersStatus.error = err.message;
  }
  components.providers = providersStatus;

  // --- Pool ---
  const poolStatus = { status: 'ok', available: false };
  try {
    const { getDb } = require('../db');
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM pool_accounts WHERE deleted_at IS NULL').get();
    const available = db.prepare("SELECT COUNT(*) AS cnt FROM pool_accounts WHERE status = 'available' AND deleted_at IS NULL").get();
    const errCount = db.prepare("SELECT COUNT(*) AS cnt FROM pool_accounts WHERE status = 'error' AND deleted_at IS NULL").get();

    poolStatus.available = true;
    poolStatus.total = total.cnt;
    poolStatus.available_count = available.cnt;
    poolStatus.error_count = errCount.cnt;
    poolStatus.status = errCount.cnt > total.cnt * 0.5 ? 'degraded' : 'ok';
  } catch {
    poolStatus.available = false;
    poolStatus.status = 'ok'; // pool is optional
  }
  components.pool = poolStatus;

  // --- Gateway ---
  const uptimeMs = Date.now() - startedAt;
  components.gateway = {
    status: 'ok',
    uptime_seconds: Math.floor(uptimeMs / 1000),
    total_requests_served: totalRequestsServed,
    active_connections: activeConnections,
  };

  // --- Memory ---
  const mem = process.memoryUsage();
  components.memory = {
    status: 'ok',
    rss_mb: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
    heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
    heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
    external_mb: Math.round(mem.external / 1024 / 1024 * 100) / 100,
  };
  // Flag if heap usage is over 90% of total
  if (mem.heapUsed / mem.heapTotal > 0.9) {
    components.memory.status = 'degraded';
  }

  // --- Overall status ---
  const statuses = Object.values(components).map(c => c.status);
  let overall = 'ok';
  if (statuses.includes('down')) overall = 'down';
  else if (statuses.includes('degraded')) overall = 'degraded';

  res.json({
    status: overall,
    components,
    timestamp: new Date().toISOString(),
  });
});

// Provider-specific health
router.get('/health/providers', (req, res) => {
  const providers = {};

  try {
    const { getDb } = require('../db');
    const db = getDb();
    const channels = db.prepare("SELECT id, type, name, status FROM channels WHERE deleted_at IS NULL").all();

    // Group by type
    const byType = {};
    for (const ch of channels) {
      if (!byType[ch.type]) byType[ch.type] = { channels: [], enabled: 0, total: 0 };
      byType[ch.type].channels.push({ id: ch.id, name: ch.name, status: ch.status });
      byType[ch.type].total++;
      if (ch.status === 'enabled') byType[ch.type].enabled++;
    }

    // Get load balancer stats
    let lbStats = {};
    let cbCircuits = {};
    try {
      const { loadBalancer, circuitBreaker } = require('../biz/loadBalancer');
      lbStats = loadBalancer.getAllStats();
      cbCircuits = circuitBreaker.circuits || new Map();
    } catch { /* loadBalancer may not be available */ }

    for (const [type, info] of Object.entries(byType)) {
      // Compute per-provider error rate from LB stats
      let totalRequests = 0;
      let totalFailures = 0;
      const channelDetails = [];

      for (const ch of info.channels) {
        const stats = lbStats[ch.id];
        const cbState = cbCircuits instanceof Map ? cbCircuits.get(`channel:${ch.id}`) : null;

        const detail = {
          id: ch.id,
          name: ch.name,
          status: ch.status,
        };

        if (stats) {
          detail.total_requests = stats.totalRequests;
          detail.success_count = stats.successCount;
          detail.failure_count = stats.failureCount;
          detail.avg_latency_ms = stats.avgLatencyMs ? Math.round(stats.avgLatencyMs) : null;
          detail.error_rate = stats.totalRequests > 0
            ? Math.round(stats.failureCount / stats.totalRequests * 10000) / 100
            : 0;
          totalRequests += stats.totalRequests;
          totalFailures += stats.failureCount;
        }

        if (cbState) {
          detail.circuit_breaker = {
            state: cbState.state,
            failure_count: cbState.failureCount,
            opened_at: cbState.openedAt ? new Date(cbState.openedAt).toISOString() : null,
          };
        }

        channelDetails.push(detail);
      }

      providers[type] = {
        channel_count: info.total,
        enabled_count: info.enabled,
        total_requests: totalRequests,
        error_rate: totalRequests > 0
          ? Math.round(totalFailures / totalRequests * 10000) / 100
          : 0,
        channels: channelDetails,
      };
    }
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }

  res.json({
    data: providers,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
