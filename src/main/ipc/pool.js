/**
 * Pool IPC Handlers
 * Handles: Pool account CRUD, status transitions, health scores, enable/disable
 */
const { ipcMain } = require('electron');
const retryQueueService = require('../../services/retryQueueService');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getObjectArg(value) {
  return isPlainObject(value) ? value : {};
}

function getIdArg(value) {
  const payload = getObjectArg(value);
  return payload.id ?? payload.accountId ?? payload.account_id ?? payload.poolAccountId;
}

function getUpdatePayload(firstArg, secondArg) {
  if (secondArg !== undefined) {
    return getObjectArg(secondArg);
  }

  const payload = getObjectArg(firstArg);
  if (payload.updates && isPlainObject(payload.updates)) return payload.updates;
  if (payload.data && isPlainObject(payload.data)) return payload.data;
  if (payload.payload && isPlainObject(payload.payload)) return payload.payload;

  const {
    id,
    accountId,
    account_id,
    poolAccountId,
    updates,
    data,
    payload: nestedPayload,
    ...rest
  } = payload;
  return rest;
}

function getAddApiKeyArgs(providerType, apiKey, baseUrl, displayName) {
  if (isPlainObject(providerType)) {
    const payload = providerType;
    return [
      payload.providerType ?? payload.provider_type,
      payload.apiKey ?? payload.api_key,
      payload.baseUrl ?? payload.base_url,
      payload.displayName ?? payload.display_name,
    ];
  }
  return [providerType, apiKey, baseUrl, displayName];
}

function getPoolFilters(filters) {
  const payload = { ...getObjectArg(filters) };
  if (payload.provider_type === undefined && payload.providerType !== undefined) {
    payload.provider_type = payload.providerType;
  }
  return payload;
}

function getTransitionArgs(accountId, newStatus, reason, triggeredBy) {
  if (isPlainObject(accountId)) {
    const payload = accountId;
    return {
      accountId: payload.accountId ?? payload.id ?? payload.account_id ?? payload.poolAccountId,
      newStatus: payload.newStatus ?? payload.status,
      reason: payload.reason ?? '',
      triggeredBy: payload.triggeredBy ?? payload.triggered_by ?? 'manual',
    };
  }

  return {
    accountId,
    newStatus,
    reason,
    triggeredBy,
  };
}

function registerHandlers(mainWindow, deps) {
  const { poolService } = deps;

  // Get all pool accounts with optional filters
  ipcMain.handle('pool-get-accounts', async (event, filters) => {
    try {
      const accounts = poolService.getAll(getPoolFilters(filters));
      return { success: true, data: accounts };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Get a single pool account by ID
  ipcMain.handle('pool-get-account', async (event, id) => {
    try {
      const account = poolService.getById(getIdArg(id));
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Add a new pool account
  ipcMain.handle('pool-add-account', async (event, data) => {
    try {
      const account = poolService.add(getObjectArg(data));
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Update a pool account
  ipcMain.handle('pool-update-account', async (event, id, updates) => {
    try {
      const accountId = getIdArg(id);
      const updateData = getUpdatePayload(id, updates);
      const account = poolService.update(accountId, updateData);
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Soft-delete a pool account
  ipcMain.handle('pool-delete-account', async (event, id) => {
    try {
      const result = poolService.deleteAccount(getIdArg(id));
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Transition account status
  ipcMain.handle('pool-transition-status', async (event, accountId, newStatus, reason, triggeredBy) => {
    try {
      const args = getTransitionArgs(accountId, newStatus, reason, triggeredBy);
      const account = poolService.transitionStatus(args.accountId, args.newStatus, args.reason, args.triggeredBy);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pool-status-changed', {
          accountId: args.accountId,
          fromStatus: null, // caller can look up old status if needed
          toStatus: args.newStatus,
          reason: args.reason,
          triggeredBy: args.triggeredBy,
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
      const payload = getObjectArg(account);
      const score = poolService.calculateHealthScore(payload.account ?? payload.data ?? payload.payload ?? payload);
      return { success: true, data: { score } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Add an API key as a pool account
  ipcMain.handle('pool-add-api-key', async (event, providerType, apiKey, baseUrl, displayName) => {
    try {
      const [normalizedProviderType, normalizedApiKey, normalizedBaseUrl, normalizedDisplayName] =
        getAddApiKeyArgs(providerType, apiKey, baseUrl, displayName);
      const account = poolService.addApiKey(
        normalizedProviderType,
        normalizedApiKey,
        normalizedBaseUrl,
        normalizedDisplayName,
      );
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Enable a disabled account
  ipcMain.handle('pool-enable-account', async (event, id) => {
    try {
      const account = poolService.enableAccount(getIdArg(id));
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Disable an active account
  ipcMain.handle('pool-disable-account', async (event, id) => {
    try {
      const account = poolService.disableAccount(getIdArg(id));
      return { success: true, data: account };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Update account tags (e.g., after card binding)
  ipcMain.handle('pool-update-tags', async (event, payload) => {
    try {
      const { accountId, tags } = getObjectArg(payload);
      const account = poolService.getById(accountId);
      if (!account) return { success: false, error: 'Account not found' };
      const merged = [...new Set([...(account.tags || []), ...(Array.isArray(tags) ? tags : [])])];
      const updated = poolService.update(accountId, { tags: merged });
      return { success: true, data: updated };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // CARD-02 fix: Properly transition account status after successful card binding
  // This handler updates both tags AND status (not just tags like pool-update-tags)
  ipcMain.handle('pool-after-card-bind', async (event, payload) => {
    try {
      const { accountId, tags } = getObjectArg(payload);
      const account = poolService.getById(accountId);
      if (!account) return { success: false, error: 'Account not found' };

      // Merge tags (add card-bound marker)
      const bindTags = Array.isArray(tags) ? tags : ['card-bound'];
      const mergedTags = [...new Set([...(account.tags || []), ...bindTags])];

      // Update tags first
      poolService.update(accountId, { tags: mergedTags });

      // Properly transition status to 'available' to confirm the account is active after binding
      let transitioned = account;
      if (account.status !== 'available' && account.status !== 'in_use') {
        try {
          transitioned = poolService.transitionStatus(accountId, 'available', 'card binding completed', 'card-bind');
        } catch (transErr) {
          // If transition fails (e.g., already available), just update status directly
          console.warn(`[pool-after-card-bind] Status transition failed for ${accountId}: ${transErr.message}, forcing update`);
          transitioned = poolService.update(accountId, { status: 'available' });
        }
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pool-status-changed', {
          accountId,
          fromStatus: account.status,
          toStatus: 'available',
          reason: 'card binding completed',
          triggeredBy: 'card-bind',
        });
      }

      return { success: true, data: transitioned };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // CARD-03: Get card binding retry queue
  ipcMain.handle('card-binding-retry-queue', async () => {
    try {
      const pending = retryQueueService.getQueue('cardBinding');
      const failed = retryQueueService.getFailedList('cardBinding');
      const stats = retryQueueService.getStats();
      return { success: true, data: { pending, failed, stats: stats.cardBinding || { pending: 0, failed: 0 } } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // CARD-03: Enqueue a failed card binding to the retry queue (called from renderer)
  ipcMain.handle('card-binding-retry-enqueue', async (event, payload) => {
    try {
      const account = getObjectArg(payload);
      if (!account.email && !account.id) {
        return { success: false, error: 'Account must have email or id' };
      }
      retryQueueService.enqueue('cardBinding', account, account.maxRetries || 3);
      console.log(`[重试队列] 绑卡失败账号已加入队列: ${account.email || account.id}`);
      return { success: true, data: { queued: true } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // CARD-03: Remove from card binding retry queue (after manual success)
  ipcMain.handle('card-binding-retry-remove', async (event, payload) => {
    try {
      const { accountId } = getObjectArg(payload);
      const removed = retryQueueService.removeFromQueue('cardBinding', accountId);
      return { success: true, data: { removed } };
    } catch (error) {
      return { success: false, error: error.message };
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
      const activeIds = accounts.map(a => a.id).filter(id => id !== undefined && id !== null && id !== '');
      const result = bridge.sync(accounts);
      const removed = bridge.removeOrphaned(activeIds);
      return { success: true, data: { ...result, removed, disabled: removed } };
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

  // Shared recovery service instance for periodic scanning
  let periodicRecovery = null;

  // Start periodic recovery scanning
  ipcMain.handle('pool-start-periodic-recovery', async (event, options) => {
    try {
      const { poolService } = deps;
      const opts = getObjectArg(options);
      const intervalMs = opts.intervalMs ?? opts.interval ?? 300000;

      const ErrorRecoveryService = require('../../services/errorRecoveryService');
      if (periodicRecovery) {
        periodicRecovery.stopPeriodicScan();
      }
      periodicRecovery = new ErrorRecoveryService();
      periodicRecovery.startPeriodicScan(poolService, intervalMs);
      return { success: true, data: { message: 'Periodic recovery started', intervalMs } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Stop periodic recovery scanning
  ipcMain.handle('pool-stop-periodic-recovery', async (event) => {
    try {
      if (periodicRecovery) {
        periodicRecovery.stopPeriodicScan();
        periodicRecovery = null;
      }
      return { success: true, data: { message: 'Periodic recovery stopped' } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerHandlers };
