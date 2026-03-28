/**
 * Gateway IPC Handlers
 */
const { ipcMain } = require('electron');

function registerHandlers(mainWindow, deps) {
  const { state } = deps;

  ipcMain.handle('get-gateway-port', () => state.gatewayPort);

  // ---- Load Balancer Routing Strategy ----

  ipcMain.handle('lb-get-strategy', () => {
    const { loadBalancer, VALID_STRATEGIES } = require('../../gateway/biz/loadBalancer');
    return {
      strategy: loadBalancer.getStrategy(),
      available: [...VALID_STRATEGIES],
    };
  });

  ipcMain.handle('lb-set-strategy', (event, strategy) => {
    const { loadBalancer, VALID_STRATEGIES } = require('../../gateway/biz/loadBalancer');
    if (!strategy || !VALID_STRATEGIES.has(strategy)) {
      return { success: false, error: `Invalid strategy. Valid: ${[...VALID_STRATEGIES].join(', ')}` };
    }
    loadBalancer.setStrategy(strategy);

    // Persist to systems table
    try {
      const { getDb } = require('../../gateway/db');
      const db = getDb();
      db.prepare(
        "INSERT INTO systems (key, value, updated_at) VALUES ('lb_routing_strategy', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).run(strategy);
    } catch (_err) {
      // DB may not be ready; strategy is set in memory regardless
    }

    return { success: true, strategy };
  });

  ipcMain.handle('lb-get-stats', () => {
    const { loadBalancer, circuitBreaker } = require('../../gateway/biz/loadBalancer');
    return {
      metrics: loadBalancer.getAllStats(),
      strategy: loadBalancer.getStrategy(),
      circuitBreakers: circuitBreaker.getAllStats(),
    };
  });

  ipcMain.handle('lb-reset-circuit-breaker', (event, key) => {
    const { circuitBreaker } = require('../../gateway/biz/loadBalancer');
    circuitBreaker.reset(key || undefined);
    return { success: true };
  });
}

module.exports = { registerHandlers };
