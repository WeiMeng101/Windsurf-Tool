/**
 * Pool IPC Handlers
 * Handles: Pool account CRUD, status transitions, health scores, enable/disable
 */
const { ipcMain } = require('electron');

function registerHandlers(mainWindow, deps) {
  const { poolService } = deps;

  // Get all pool accounts with optional filters
  ipcMain.handle('pool-get-accounts', async (event, filters) => {
    try {
      const accounts = poolService.getAll(filters || {});
      return { success: true, data: accounts };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Get a single pool account by ID
  ipcMain.handle('pool-get-account', async (event, id) => {
    try {
      const account = poolService.getById(id);
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Add a new pool account
  ipcMain.handle('pool-add-account', async (event, data) => {
    try {
      const account = poolService.add(data);
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Update a pool account
  ipcMain.handle('pool-update-account', async (event, id, updates) => {
    try {
      const account = poolService.update(id, updates);
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Soft-delete a pool account
  ipcMain.handle('pool-delete-account', async (event, id) => {
    try {
      const result = poolService.deleteAccount(id);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Transition account status
  ipcMain.handle('pool-transition-status', async (event, accountId, newStatus, reason, triggeredBy) => {
    try {
      const account = poolService.transitionStatus(accountId, newStatus, reason, triggeredBy);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pool-status-changed', {
          accountId,
          fromStatus: null, // caller can look up old status if needed
          toStatus: newStatus,
          reason,
          triggeredBy,
        });
      }
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Calculate health score for an account
  ipcMain.handle('pool-calculate-health', async (event, account) => {
    try {
      const score = poolService.calculateHealthScore(account);
      return { success: true, data: { score } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Add an API key as a pool account
  ipcMain.handle('pool-add-api-key', async (event, providerType, apiKey, baseUrl, displayName) => {
    try {
      const account = poolService.addApiKey(providerType, apiKey, baseUrl, displayName);
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Enable a disabled account
  ipcMain.handle('pool-enable-account', async (event, id) => {
    try {
      const account = poolService.enableAccount(id);
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Disable an active account
  ipcMain.handle('pool-disable-account', async (event, id) => {
    try {
      const account = poolService.disableAccount(id);
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Update account tags (e.g., after card binding)
  ipcMain.handle('pool-update-tags', async (event, { accountId, tags }) => {
    try {
      const account = poolService.getById(accountId);
      if (!account) return { success: false, error: 'Account not found' };
      const merged = [...new Set([...(account.tags || []), ...tags])];
      const updated = poolService.update(accountId, { tags: merged });
      return { success: true, data: updated };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Sync pool accounts to gateway channels
  ipcMain.handle('pool-sync-channels', async (event) => {
    try {
      const { poolService, getDb } = deps;
      if (!getDb) return { success: false, error: 'Gateway DB not available' };
      const PoolChannelBridge = require('../../services/poolChannelBridge');
      const bridge = new PoolChannelBridge(getDb);
      const accounts = poolService.getAll();
      const activeIds = accounts.filter(a => !a.deleted_at).map(a => a.id);
      const result = bridge.sync(accounts.filter(a => a.status === 'available' && a.credentials));
      const removed = bridge.removeOrphaned(activeIds);
      return { success: true, data: { ...result, removed } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Recover error/cooldown accounts
  ipcMain.handle('pool-recover-accounts', async (event) => {
    try {
      const { poolService } = deps;
      const ErrorRecoveryService = require('../../services/errorRecoveryService');
      const recovery = new ErrorRecoveryService();
      const result = recovery.scanAndRecover(poolService);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerHandlers };
