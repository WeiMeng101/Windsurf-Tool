/**
 * Codex IPC Handlers
 * Handles: Codex registration, account pool management, token rotation
 */
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs').promises;

// Module-local state
let currentCodexRegistrar = null;
let codexAccountPool = null;

function isOperationAllowed(operation, state) {
  if (state.isForceUpdateActive || state.isMaintenanceModeActive || state.isApiUnavailable) {
    const allowedOperations = ['check-for-updates', 'open-download-url', 'get-file-paths'];
    if (!allowedOperations.includes(operation)) {
      console.log(`操作被阻止: ${operation} (状态: 强制更新=${state.isForceUpdateActive}, 维护=${state.isMaintenanceModeActive}, API不可用=${state.isApiUnavailable})`);
      return false;
    }
  }
  return true;
}

// 获取或创建 CodexAccountPool 实例
function getCodexPool(appRoot, userDataPath) {
  if (!codexAccountPool) {
    const { CodexAccountPool } = require(path.join(appRoot, 'js', 'codexAccountSwitcher'));
    const poolFilePath = path.join(userDataPath, 'codex_accounts.json');
    codexAccountPool = new CodexAccountPool({ poolFilePath });
  }
  return codexAccountPool;
}

function registerHandlers(mainWindow, deps) {
  const { appRoot, userDataPath, state } = deps;

  // Codex 批量注册
  ipcMain.handle('codex-batch-register', async (event, config) => {
    if (!isOperationAllowed('codex-batch-register', state)) {
      return { success: false, error: '当前状态下无法执行此操作' };
    }

    try {
      const codexRegistrationBotPath = path.join(appRoot, 'src', 'codexRegistrationBot');
      delete require.cache[require.resolve(codexRegistrationBotPath)];
      const { CodexBatchRegistrar } = require(codexRegistrationBotPath);
      const outputDir = path.join(userDataPath, 'codex_output');
      await fs.mkdir(outputDir, { recursive: true });

      const logCallback = (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('codex-register-log', msg);
        }
      };

      const progressCallback = (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('codex-register-progress', progress);
        }
      };

      const registrar = new CodexBatchRegistrar({
        emailConfig: config.emailConfig || null,
        emailDomains: config.emailDomains || [],
        proxy: config.proxy || '',
        enableOAuth: config.enableOAuth !== false,
        logCallback,
        progressCallback,
      });

      currentCodexRegistrar = registrar;

      const result = await registrar.runBatch(config.count || 1, outputDir);

      // 自动导入到账号池
      if (result.results && result.results.length > 0) {
        try {
          const pool = getCodexPool(appRoot, userDataPath);
          await pool.load();
          const imported = await pool.importFromRegistrationResults(result.results);
          logCallback(`已自动导入 ${imported} 个账号到 Codex 账号池`);
        } catch (importErr) {
          logCallback(`导入到账号池失败: ${importErr.message}`);
        }
      }

      return { success: true, ...result };
    } catch (error) {
      console.error('Codex 批量注册失败:', error);
      return { success: false, error: error.message };
    } finally {
      currentCodexRegistrar = null;
    }
  });

  // 取消 Codex 批量注册
  ipcMain.handle('cancel-codex-register', async () => {
    try {
      if (currentCodexRegistrar) {
        currentCodexRegistrar.cancel();
        currentCodexRegistrar = null;
      }
      return { success: true, message: 'Codex 注册已取消' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 获取 Codex 账号池列表
  ipcMain.handle('codex-get-accounts', async () => {
    try {
      const pool = getCodexPool(appRoot, userDataPath);
      await pool.load();
      return { success: true, accounts: pool.getAll(), status: pool.getStatus() };
    } catch (error) {
      console.error('获取 Codex 账号列表失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 添加 Codex 账号
  ipcMain.handle('codex-add-account', async (event, accountData) => {
    try {
      const pool = getCodexPool(appRoot, userDataPath);
      await pool.load();
      await pool.addAccount(accountData);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 删除 Codex 账号
  ipcMain.handle('codex-remove-account', async (event, emailOrId) => {
    try {
      const pool = getCodexPool(appRoot, userDataPath);
      await pool.load();
      const removed = await pool.removeAccount(emailOrId);
      return { success: removed };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 清空 Codex 账号池
  ipcMain.handle('codex-remove-all-accounts', async () => {
    try {
      const pool = getCodexPool(appRoot, userDataPath);
      await pool.load();
      await pool.removeAllAccounts();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 获取当前活跃的 Codex Token（无感切号核心）
  ipcMain.handle('codex-get-active-token', async () => {
    try {
      const pool = getCodexPool(appRoot, userDataPath);
      const result = await pool.getActiveToken();
      if (!result) {
        return { success: false, error: '无可用 Codex 账号' };
      }
      return {
        success: true,
        email: result.account.email,
        access_token: result.access_token,
        switched: result.switched,
      };
    } catch (error) {
      console.error('获取 Codex Token 失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 手动切换到下一个 Codex 账号
  ipcMain.handle('codex-switch-next', async () => {
    try {
      const pool = getCodexPool(appRoot, userDataPath);
      await pool.load();
      const result = await pool.switchToNext();
      if (!result) {
        return { success: false, error: '无可用 Codex 账号' };
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('codex-account-switched', {
          email: result.account.email,
        });
      }
      return {
        success: true,
        email: result.account.email,
        access_token: result.access_token,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 标记当前 Codex 账号已用尽
  ipcMain.handle('codex-mark-exhausted', async (event, reason) => {
    try {
      const pool = getCodexPool(appRoot, userDataPath);
      await pool.load();
      const result = await pool.markCurrentExhausted(reason || '');
      if (!result) {
        return { success: false, error: '无更多可用账号' };
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('codex-account-switched', {
          email: result.account.email,
        });
      }
      return { success: true, email: result.account.email };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 重置所有 Codex 账号状态
  ipcMain.handle('codex-reset-all-status', async () => {
    try {
      const pool = getCodexPool(appRoot, userDataPath);
      await pool.load();
      await pool.resetAllStatus();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 手动刷新指定 Codex 账号 Token
  ipcMain.handle('codex-refresh-token', async (event, email) => {
    try {
      const pool = getCodexPool(appRoot, userDataPath);
      await pool.load();
      const accounts = pool.getAll();
      const account = accounts.find(a => a.email === email);
      if (!account) {
        return { success: false, error: `账号 ${email} 不存在` };
      }
      const tokens = await pool.refreshToken(account);
      // 更新到池中
      await pool.addAccount({ ...account, access_token: tokens.access_token, refresh_token: tokens.refresh_token || account.refresh_token });
      return { success: true, email };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerHandlers };
