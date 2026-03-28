/**
 * Registration IPC Handlers
 * Handles: batch registration, cancel registration, IMAP test
 */
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const retryQueueService = require('../../services/retryQueueService');

// Module-local state
let currentRegistrationBot = null;

function registerHandlers(mainWindow, deps) {
  const { ACCOUNTS_FILE, accountsFileLock, appRoot, poolService, accountService } = deps;

  // 批量注册账号
  ipcMain.handle('batch-register', async (event, config) => {
    // 使用 JavaScript 版本注册机器人
    const registrationBotPath = path.join(appRoot, 'src', 'registrationBot');
    const registrationBotResolvedPath = require.resolve(registrationBotPath);
    delete require.cache[registrationBotResolvedPath];
    const RegistrationBot = require(registrationBotPath);
    const safeLog = function(message, customLogCallback = null) {
      console.log(message);
      const callback = typeof customLogCallback === 'function'
        ? customLogCallback
        : (
            typeof this === 'object' &&
            this !== null &&
            typeof this.logCallback === 'function'
              ? this.logCallback
              : null
          );
      if (callback) {
        try {
          callback(message);
        } catch (callbackError) {
          console.error('[日志回调执行失败]', callbackError?.message || callbackError);
        }
      }
    };

    RegistrationBot.prototype.log = safeLog;

    if (!RegistrationBot.__registrationBotPatchedForBatch) {
      const originalRegisterAccount = RegistrationBot.prototype.registerAccount;
      RegistrationBot.prototype.registerAccount = async function(logCallback) {
        if (!this.log || typeof this.log !== 'function') {
          this.log = safeLog;
        }
        return originalRegisterAccount.call(this, logCallback);
      };
      RegistrationBot.__registrationBotPatchedForBatch = true;
    }

    console.log('[注册机器人] 日志补丁已注入');
    console.log('使用 JavaScript 版本注册机器人');
    
    // 创建保存账号的回调函数
    const saveAccountCallback = async (account) => {
      return await accountsFileLock.acquire(async () => {
        try {
          // 验证账号数据
          if (!account || !account.email || !account.password) {
            return { success: false, error: '账号数据不完整，缺少邮箱或密码' };
          }
          
          // 规范化路径（跨平台兼容）
          const accountsFilePath = path.normalize(ACCOUNTS_FILE);
          const accountsDir = path.dirname(accountsFilePath);
          
          // 确保目录存在
          await fs.mkdir(accountsDir, { recursive: true });
          
          let accounts = [];
          try {
            const data = await accountService.readFileRaw(accountsFilePath);
            accounts = JSON.parse(data);
            if (!Array.isArray(accounts)) {
              accounts = [];
            }
          } catch (error) {
            if (error.code !== 'ENOENT') {
              console.error('读取账号文件失败:', error.message);
            }
            accounts = [];
          }
          
          // 检查是否已存在相同邮箱
          const normalizedEmail = account.email.toLowerCase().trim();
          const existingAccount = accounts.find(acc => 
            acc.email && acc.email.toLowerCase().trim() === normalizedEmail
          );
          if (existingAccount) {
            return { success: false, error: `账号 ${account.email} 已存在` };
          }
          
          // 添加ID和创建时间
          account.id = Date.now().toString();
          account.createdAt = new Date().toISOString();
          accounts.push(account);
          
          // 先创建备份
          if (accounts.length > 0) {
            try {
              await accountService.writeFileRaw(
                accountsFilePath + '.backup',
                JSON.stringify(accounts, null, 2),
                { encoding: 'utf-8' }
              );
            } catch (backupError) {
              console.warn('创建备份失败:', backupError.message);
            }
          }
          
          // 保存文件
          await accountService.writeFileRaw(
            accountsFilePath,
            JSON.stringify(accounts, null, 2),
            { encoding: 'utf-8' }
          );
          console.log(`账号已添加: ${account.email} (总数: ${accounts.length})`);

          // Auto-add to pool
          try {
            if (poolService) {
              const poolExisting = poolService.getAll({ provider_type: 'windsurf' })
                .find(a => a.email && a.email.toLowerCase() === account.email.toLowerCase());
              if (!poolExisting) {
                poolService.add({
                  provider_type: 'windsurf',
                  email: account.email,
                  display_name: account.name || account.email,
                  status: 'available',
                  credentials: {
                    apiKey: account.apiKey || '',
                    refreshToken: account.refreshToken || '',
                    apiServerUrl: account.apiServerUrl || '',
                  },
                  source: 'registration',
                  source_ref: account.id || '',
                });
                console.log(`账号已加入号池: ${account.email}`);
              }
            }
          } catch (poolErr) {
            console.error('号池自动添加失败:', poolErr);
          }

          return { success: true, account };
        } catch (error) {
          console.error('添加账号失败:', error);
          return { success: false, error: `添加失败: ${error.message}` };
        }
      });
    };
    
    const bot = new RegistrationBot(config, saveAccountCallback);
    currentRegistrationBot = bot;
    
    try {
      const result = await bot.batchRegister(config.count, config.threads || 4, (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('registration-progress', progress);
        }
      }, (log) => {
        // 同时输出到控制台
        console.log(log);
        // 发送实时日志到前端
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('registration-log', { message: log, type: 'info' });
          }
        } catch (logError) {
          console.error('[批量注册日志回调发送失败]', logError?.message || logError);
        }
      });

      // REG-06: Enqueue failed (non-cancelled) accounts into the retry queue
      if (result && Array.isArray(result.results)) {
        result.results.forEach((r, idx) => {
          if (!r.success && !r.cancelled) {
            const failedAccount = {
              email: r.email || `batch-${Date.now()}-${idx}`,
              error: r.error || 'Unknown error',
              config: {
                ...config,
                count: 1, // retry one at a time
              },
            };
            retryQueueService.enqueue('registration', failedAccount, 3);
            console.log(`[重试队列] 注册失败账号已加入队列: ${failedAccount.email}`);
          }
        });
      }

      return result;
    } finally {
      currentRegistrationBot = null;
    }
  });

  // 取消批量注册（跨平台：mac / Windows / Linux）
  ipcMain.handle('cancel-batch-register', async () => {
    try {
      const logCallback = (log) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('registration-log', log);
        }
      };

      // 使用统一的 BrowserKiller 工具关闭浏览器进程
      const BrowserKiller = require(path.join(appRoot, 'src', 'registrationBotCancel'));
      await BrowserKiller.cancelBatchRegistration(currentRegistrationBot, logCallback);
      
      // 清空当前注册实例
      currentRegistrationBot = null;
      
      return {
        success: true,
        message: '批量注册已取消'
      };
    } catch (error) {
      console.error('取消批量注册失败:', error);
      return {
        success: false,
        message: error.message
      };
    }
  });

  // REG-06: Get the current registration retry queue
  ipcMain.handle('registration-retry-queue', async () => {
    try {
      const pending = retryQueueService.getQueue('registration');
      const failed = retryQueueService.getFailedList('registration');
      const stats = retryQueueService.getStats();
      return { success: true, data: { pending, failed, stats: stats.registration || { pending: 0, failed: 0 } } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // REG-06: Process next item in the registration retry queue
  ipcMain.handle('registration-retry-process', async () => {
    try {
      const item = retryQueueService.dequeue('registration');
      if (!item) {
        return { success: false, error: '队列中没有可重试的项目（可能在退避等待中或队列为空）' };
      }

      const account = item.account;
      const retryConfig = account.config || {};

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('registration-log', {
          message: `[重试队列] 正在重试注册: ${account.email} (第 ${item.attempts} 次尝试)`,
          type: 'info',
        });
      }

      // Perform single registration retry
      const registrationBotPath = path.join(appRoot, 'src', 'registrationBot');
      const registrationBotResolvedPath = require.resolve(registrationBotPath);
      delete require.cache[registrationBotResolvedPath];
      const RegistrationBot = require(registrationBotPath);

      const saveAccountCallback = async (newAccount) => {
        return await accountsFileLock.acquire(async () => {
          try {
            if (!newAccount || !newAccount.email || !newAccount.password) {
              return { success: false, error: '账号数据不完整' };
            }
            const accountsFilePath = path.normalize(ACCOUNTS_FILE);
            await fs.mkdir(path.dirname(accountsFilePath), { recursive: true });
            let accounts = [];
            try {
              const data = await accountService.readFileRaw(accountsFilePath);
              accounts = JSON.parse(data);
              if (!Array.isArray(accounts)) accounts = [];
            } catch (e) { if (e.code !== 'ENOENT') console.error(e.message); accounts = []; }

            const normalizedEmail = newAccount.email.toLowerCase().trim();
            if (accounts.find(a => a.email && a.email.toLowerCase().trim() === normalizedEmail)) {
              return { success: false, error: `账号 ${newAccount.email} 已存在` };
            }
            newAccount.id = Date.now().toString();
            newAccount.createdAt = new Date().toISOString();
            accounts.push(newAccount);
            await accountService.writeFileRaw(accountsFilePath, JSON.stringify(accounts, null, 2), { encoding: 'utf-8' });

            // Auto-add to pool
            try {
              if (poolService) {
                const poolExisting = poolService.getAll({ provider_type: 'windsurf' })
                  .find(a => a.email && a.email.toLowerCase() === newAccount.email.toLowerCase());
                if (!poolExisting) {
                  poolService.add({
                    provider_type: 'windsurf',
                    email: newAccount.email,
                    display_name: newAccount.name || newAccount.email,
                    status: 'available',
                    credentials: {
                      apiKey: newAccount.apiKey || '',
                      refreshToken: newAccount.refreshToken || '',
                      apiServerUrl: newAccount.apiServerUrl || '',
                    },
                    source: 'registration',
                    source_ref: newAccount.id || '',
                  });
                }
              }
            } catch (poolErr) { console.error('号池自动添加失败:', poolErr); }

            return { success: true, account: newAccount };
          } catch (error) {
            return { success: false, error: error.message };
          }
        });
      };

      const bot = new RegistrationBot(retryConfig, saveAccountCallback);
      const logCb = (log) => {
        console.log(log);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('registration-log', { message: log, type: 'info' });
        }
      };

      let result;
      try {
        result = await bot.registerAccount(logCb);
      } catch (err) {
        result = { success: false, error: err?.message || String(err) };
      }

      if (result.success) {
        // Remove from queue on success
        retryQueueService.removeFromQueue('registration', account.email || account.id);
        return { success: true, data: { message: `重试成功: ${result.email || account.email}`, result } };
      } else {
        // Item stays in queue (attempts already incremented by dequeue); it will auto-fail after maxRetries
        return { success: false, error: `重试失败: ${result.error}`, data: { attempts: item.attempts, maxRetries: item.maxRetries } };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 测试IMAP连接
  ipcMain.handle('test-imap', async (event, config) => {
    try {
      const EmailReceiver = require(path.join(appRoot, 'src', 'emailReceiver'));
      const receiver = new EmailReceiver(config);
      return await receiver.testConnection();
    } catch (error) {
      return { success: false, message: error.message };
    }
  });
}

module.exports = { registerHandlers };
