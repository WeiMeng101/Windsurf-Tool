/**
 * Pool IPC Handlers
 * Handles: Pool account CRUD, status transitions, health scores, enable/disable, bulk import
 */
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const retryQueueService = require('../../services/retryQueueService');
const tokenRefreshService = require('../../services/tokenRefreshService');

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

  // Auto bind card for a pool account (fallback when renderer-side bindCard unavailable)
  // Delegates to the renderer's card binding UI via mainWindow webContents
  ipcMain.handle('auto-bind-card', async (event, payload) => {
    try {
      const { email } = getObjectArg(payload);
      if (!email) return { success: false, error: 'Email is required' };
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: 'Main window not available' };
      }
      // Trigger the card binding flow in the renderer process
      mainWindow.webContents.send('trigger-auto-bind-card', { email });
      return { success: true, data: { triggered: true, email } };
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
      const result = await recovery.scanAndRecover(poolService);
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

  // Refresh a single account's token via the real OAuth endpoint
  ipcMain.handle('pool-refresh-account-token', async (event, payload) => {
    try {
      const accountId = getIdArg(payload);
      if (!accountId) {
        return { success: false, error: 'Account ID is required' };
      }

      const account = poolService.getById(accountId);
      if (!account) {
        return { success: false, error: `Pool account ${accountId} not found` };
      }

      const tokens = await tokenRefreshService.refreshToken(account);

      // Update credentials with fresh tokens
      const updatedCredentials = { ...(account.credentials || {}), access_token: tokens.access_token };
      if (tokens.refresh_token) {
        updatedCredentials.refresh_token = tokens.refresh_token;
      }

      const updated = poolService.update(accountId, {
        credentials: updatedCredentials,
        cooldown_until: null,
        last_error: '',
      });

      // If account was in error state, transition back to available
      if (account.status === 'error' || account.status === 'cooldown') {
        try {
          poolService.transitionStatus(accountId, 'available', 'token refreshed via API', 'system');
        } catch (transErr) {
          // Transition may fail if status doesn't allow it; log but don't fail the request
          console.warn(`[pool-refresh-account-token] Status transition failed for ${accountId}: ${transErr.message}`);
        }
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pool-token-refreshed', {
          accountId,
          provider_type: account.provider_type,
          hasNewRefreshToken: !!tokens.refresh_token,
        });
      }

      return {
        success: true,
        data: {
          accountId,
          access_token_preview: tokens.access_token ? tokens.access_token.substring(0, 20) + '...' : null,
          refresh_token_rotated: !!tokens.refresh_token,
          expires_in: tokens.expires_in,
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ---- Pool Sync Service (legacy bridge + file watching) ----

  const PoolSyncService = require('../../services/poolSyncService');
  let poolSyncService = null;

  function getPoolSyncService() {
    if (!poolSyncService) {
      poolSyncService = new PoolSyncService(poolService);
    }
    return poolSyncService;
  }

  // Sync legacy CodexAccountPool → unified pool
  ipcMain.handle('pool-sync-legacy-codex', async (event) => {
    try {
      const { appRoot, userDataPath } = deps;
      if (!appRoot || !userDataPath) {
        return { success: false, error: 'appRoot or userDataPath not available' };
      }

      // Load the legacy CodexAccountPool
      const { CodexAccountPool } = require(path.join(appRoot, 'js', 'codexAccountSwitcher'));
      const poolFilePath = path.join(userDataPath, 'codex_accounts.json');

      if (!fs.existsSync(poolFilePath)) {
        return { success: false, error: '旧池文件不存在: codex_accounts.json' };
      }

      const codexPool = new CodexAccountPool({ poolFilePath });
      await codexPool.load();

      const sync = getPoolSyncService();
      const result = sync.syncFromLegacyPool(codexPool);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pool-sync-complete', {
          source: 'legacy-codex',
          ...result,
        });
      }

      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Start watching a directory for new account JSON files
  ipcMain.handle('pool-start-file-watcher', async (event, payload) => {
    try {
      const opts = getObjectArg(payload);
      const directory = opts.directory || path.join(process.cwd(), '账号管理', 'codex');
      const providerType = opts.providerType || opts.provider_type || 'codex';

      if (!fs.existsSync(directory)) {
        return { success: false, error: `目录不存在: ${directory}` };
      }

      const sync = getPoolSyncService();

      // Optionally do an initial bulk import before watching
      if (opts.importExisting !== false) {
        const importResult = await sync.importDirectory(directory, providerType);
        console.log(`[pool-start-file-watcher] Initial import: ${JSON.stringify(importResult)}`);
      }

      const watcher = sync.watchDirectory(directory, providerType);
      if (!watcher) {
        return { success: false, error: '无法启动文件监控' };
      }

      return {
        success: true,
        data: {
          message: `正在监控目录: ${directory}`,
          directory,
          providerType,
          activeWatchers: sync.getWatcherCount(),
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Stop all file watchers
  ipcMain.handle('pool-stop-file-watcher', async (event) => {
    try {
      const sync = getPoolSyncService();
      const count = sync.getWatcherCount();
      sync.stopAll();
      return { success: true, data: { message: '所有文件监控已停止', stopped: count } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ---- Bulk Import Handlers ----

  /**
   * Build a set of existing emails per provider type for fast duplicate checks.
   * Called once before a bulk import loop to avoid N+1 queries.
   * @returns {Map<string, Set<string>>} providerType -> Set of emails
   */
  function _buildExistingEmailIndex(poolService) {
    const all = poolService.getAll();
    const index = new Map();
    for (const account of all) {
      const key = account.provider_type || 'other';
      if (!index.has(key)) index.set(key, new Set());
      if (account.email) index.get(key).add(account.email);
    }
    return index;
  }

  /**
   * Import a single account JSON object into the pool.
   * @param {object} poolService
   * @param {object} account - parsed JSON from file
   * @param {string} providerType
   * @param {Set<string>} existingEmails - emails already in pool for this provider (mutated on success)
   * @returns {{ result: 'imported'|'skipped'|'failed', error?: string }}
   */
  function _importAccountToPool(poolService, account, providerType, existingEmails) {
    try {
      const email = (account.email || '').trim();
      if (!email) return { result: 'failed', error: 'missing email' };

      // Duplicate check using pre-built index
      if (existingEmails.has(email)) return { result: 'skipped' };

      // Determine status from expired field
      let status = 'available';
      if (account.expired) {
        const expiredDate = new Date(account.expired);
        if (expiredDate < new Date()) {
          status = 'cooldown';
        }
      }

      // Build credentials with expiry tracking
      const credentials = {
        access_token: account.access_token || '',
        refresh_token: account.refresh_token || '',
        id_token: account.id_token || '',
        account_id: account.account_id || '',
        expired: account.expired || '',
      };

      // Build tags object
      const tags = {
        expired: account.expired || '',
        last_refresh: account.last_refresh || '',
      };

      poolService.add({
        provider_type: providerType,
        email: email,
        display_name: email,
        status: status,
        credentials: credentials,
        tags: tags,
        source: 'bulk-import',
        source_ref: `import-${new Date().toISOString().slice(0, 10)}`,
      });

      // Track newly imported email to prevent duplicates within the same batch
      existingEmails.add(email);

      return { result: 'imported' };
    } catch (err) {
      return { result: 'failed', error: err.message };
    }
  }

  // Bulk import Codex account files from a directory
  ipcMain.handle('pool-bulk-import-codex', async (event, payload) => {
    try {
      const opts = getObjectArg(payload);
      const directory = opts.directory || path.join(process.cwd(), '账号管理', 'codex');

      if (!fs.existsSync(directory)) {
        return { success: false, error: `目录不存在: ${directory}` };
      }

      const files = fs.readdirSync(directory).filter(f => f.endsWith('.json'));
      const counts = { imported: 0, skipped: 0, failed: 0, total: files.length, errors: [] };

      // Build email index once before the loop
      const emailIndex = _buildExistingEmailIndex(poolService);
      const codexEmails = emailIndex.get('codex') || new Set();

      for (const file of files) {
        try {
          const filePath = path.join(directory, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const account = JSON.parse(content);

          const { result, error } = _importAccountToPool(poolService, account, 'codex', codexEmails);
          counts[result]++;
          if (error) counts.errors.push({ file, error });
        } catch (err) {
          counts.failed++;
          counts.errors.push({ file, error: err.message });
        }
      }

      // Trim errors to avoid oversized response
      if (counts.errors.length > 20) {
        counts.errors = counts.errors.slice(0, 20);
        counts.errors.push({ file: '...', error: `还有更多错误未显示` });
      }

      return { success: true, data: counts };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Generic bulk import: auto-detect provider type from file content
  ipcMain.handle('pool-bulk-import-directory', async (event, payload) => {
    try {
      const opts = getObjectArg(payload);
      const directory = opts.directory;

      if (!directory || !fs.existsSync(directory)) {
        return { success: false, error: `目录不存在: ${directory || '(未指定)'}` };
      }

      const files = fs.readdirSync(directory).filter(f => f.endsWith('.json'));
      const counts = { imported: 0, skipped: 0, failed: 0, total: files.length, errors: [] };

      // Build email index once before the loop
      const emailIndex = _buildExistingEmailIndex(poolService);

      for (const file of files) {
        try {
          const filePath = path.join(directory, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const account = JSON.parse(content);

          // Auto-detect provider type
          let providerType = 'other';
          if (account.type === 'codex') providerType = 'codex';
          else if (account.type === 'windsurf') providerType = 'windsurf';

          // Get or create the email set for this provider
          if (!emailIndex.has(providerType)) emailIndex.set(providerType, new Set());
          const providerEmails = emailIndex.get(providerType);

          const { result, error } = _importAccountToPool(poolService, account, providerType, providerEmails);
          counts[result]++;
          if (error) counts.errors.push({ file, error });
        } catch (err) {
          counts.failed++;
          counts.errors.push({ file, error: err.message });
        }
      }

      if (counts.errors.length > 20) {
        counts.errors = counts.errors.slice(0, 20);
        counts.errors.push({ file: '...', error: `还有更多错误未显示` });
      }

      return { success: true, data: counts };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerHandlers };
