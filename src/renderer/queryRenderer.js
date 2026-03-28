// queryRenderer.js - 账号查询模块（订阅类型和积分）
// 从 js/accountQuery.js 迁移，使用 require() 替代 window.* 访问

const axios = require('axios');
const CONSTANTS = require('./constants');
const { FirebaseAuthService } = require('../services/firebaseAuth');

// 常量配置
const CONFIG = {
  get REQUEST_TIMEOUT() {
    return CONSTANTS.REQUEST_TIMEOUT;
  },
  QUERY_DELAY: 500,              // 查询延迟500ms
  AUTO_QUERY_INTERVAL: 5 * 60 * 1000,  // 默认5分钟
  MIN_INTERVAL: 5,               // 最小间隔5分钟
  MAX_INTERVAL: 1440             // 最大间隔1440分钟(24小时)
};

/**
 * 账号查询管理器
 */
const AccountQuery = {
  /**
   * 使用 refresh_token 获取 access_token
   * @param {string} refreshToken - 刷新令牌
   * @param {string} email - 可选
   * @param {string} password - 可选
   */
  async getAccessToken(refreshToken, email = null, password = null) {
    try {
      const tokens = await FirebaseAuthService.refreshToken(refreshToken, { email, password });
      return {
        accessToken: tokens.idToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn
      };
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
        throw new Error('无法连接到中转服务器，请检查网络连接或开启代理');
      }
      throw new Error(`获取 access_token 失败: ${error.message}`);
    }
  },

  /**
   * 查询账号使用情况（订阅类型和积分）
   * 使用简化方式：直接用 JSON 格式请求
   */
  async getUsageInfo(accessToken) {
    try {
      const response = await axios.post(
        'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus',
        {
          auth_token: accessToken
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Token': accessToken,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'x-client-version': 'Chrome/JsCore/11.0.0/FirebaseCore-web'
          },
          timeout: CONFIG.REQUEST_TIMEOUT
        }
      );

      // 解析响应
      console.log('[积分调试] API原始响应:', JSON.stringify(response.data, null, 2));
      const planStatus = response.data.planStatus || response.data;
      console.log('[积分调试] planStatus:', JSON.stringify(planStatus, null, 2));
      console.log('[积分调试] planStatus所有字段:', Object.keys(planStatus));

      // 提取到期时间（Pro账号有planEnd，Free账号没有）
      const expiresAt = planStatus.planEnd || planStatus.expiresAt || null;

      const promptCredits = Math.round((planStatus.availablePromptCredits || 0) / 100);
      const flowCredits = Math.round((planStatus.availableFlowCredits || 0) / 100);
      const flexCredits = Math.round((planStatus.availableFlexCredits || 0) / 100);
      const totalCredits = promptCredits + flowCredits + flexCredits;

      const usedPromptCredits = Math.round((planStatus.usedPromptCredits || 0) / 100);
      const monthlyFlowCredits = planStatus.planInfo?.monthlyFlowCredits || 0;
      const usedFlowCredits = Math.round(Math.max(0, monthlyFlowCredits - (planStatus.availableFlowCredits || 0)) / 100);
      const usedFlexCredits = Math.round((planStatus.usedFlexCredits || 0) / 100);
      const usedUsageCredits = Math.round((planStatus.usedUsageCredits || 0) / 100);
      const usedCredits = usedPromptCredits + usedFlowCredits + usedFlexCredits + usedUsageCredits;

      console.log('[积分调试] 解析结果:', { promptCredits, flowCredits, flexCredits, totalCredits, usedPromptCredits, usedFlowCredits, usedFlexCredits, usedUsageCredits, usedCredits });

      return {
        planName: planStatus.planInfo?.planName || 'Free',
        usedCredits: usedCredits,
        totalCredits: totalCredits,
        usagePercentage: 0,
        expiresAt: expiresAt,
        planStart: planStatus.planStart || null,
        planInfo: planStatus.planInfo || null
      };
    } catch (error) {
      // 查询失败，返回错误状态而不是假数据
      console.warn('查询使用情况失败:', error.message);
      throw new Error(`查询使用情况失败: ${error.message}`);
    }
  },

  /**
   * 查询单个账号的完整信息
   */
  async queryAccount(account) {
    try {
      // 检查是否有 refreshToken
      if (!account.refreshToken) {
        return {
          success: false,
          error: '账号缺少 refreshToken',
          planName: 'Unknown',
          usedCredits: 0,
          totalCredits: 0
        };
      }

      let accessToken;
      let newTokenData = null;
      let needReLogin = false; // 标记是否需要重新登录

      // 优化: 如果本地有 idToken 且未过期,直接使用,避免每次都刷新
      const now = Date.now();
      const tokenExpired = !account.idToken || !account.idTokenExpiresAt || now >= account.idTokenExpiresAt;

      if (tokenExpired) {
        // Token 不存在或已过期,需要刷新
        try {
          console.log(`[Token刷新] 账号 ${account.email} 的Token已过期，正在刷新...`);
          const tokenData = await this.getAccessToken(account.refreshToken, account.email, account.password);

          if (!tokenData || !tokenData.accessToken) {
            throw new Error('刷新Token失败：返回的Token为空');
          }

          accessToken = tokenData.accessToken;
          // 保存新 Token 信息,用于后续更新到本地
          newTokenData = {
            idToken: tokenData.accessToken,
            idTokenExpiresAt: now + (tokenData.expiresIn * 1000),
            refreshToken: tokenData.refreshToken
          };
          console.log(`[Token刷新] 账号 ${account.email} Token刷新成功`);
        } catch (error) {
          console.error(`[Token刷新] 账号 ${account.email} Token刷新失败:`, error);

          // refreshToken 过期或失效，标记需要重新登录
          if (error.message.includes('TOKEN_EXPIRED') ||
              error.message.includes('INVALID_REFRESH_TOKEN') ||
              error.message.includes('获取 access_token 失败')) {
            console.log(`[Token刷新] RefreshToken已过期，尝试使用邮箱密码重新获取...`);
            needReLogin = true;
          } else {
            // 其他错误（网络错误、超时等）
            throw new Error(`刷新Token失败: ${error.message}`);
          }
        }
      } else {
        // Token 未过期,直接使用本地的
        accessToken = account.idToken;
        console.log(`[Token使用] 账号 ${account.email} 使用本地Token（${Math.round((account.idTokenExpiresAt - now) / 1000 / 60)}分钟后过期）`);
      }

      // 如果需要重新登录（RefreshToken过期）
      if (needReLogin) {
        if (!account.email || !account.password) {
          const errorMsg = 'RefreshToken已过期，但账号缺少邮箱或密码，无法自动重新获取Token';
          console.error(`[重新登录] ${errorMsg}`);
          throw new Error(errorMsg);
        }

        try {
          console.log(`[重新登录] 使用邮箱密码重新获取Token: ${account.email}`);
          console.log(`[重新登录] 邮箱: ${account.email}, 密码长度: ${account.password?.length || 0}`);

          // 使用IPC调用主进程获取Token（渲染进程不能直接require主进程模块）
          console.log(`[重新登录] 通过IPC调用主进程获取Token...`);
          const loginResult = await getIpcRenderer().invoke('get-account-token', {
            email: account.email,
            password: account.password
          });

          console.log(`[重新登录] IPC返回结果:`, loginResult?.success ? '成功' : '失败');

          if (!loginResult || !loginResult.success) {
            const errorDetail = loginResult?.error || '重新登录失败：IPC调用失败';
            console.error(`[重新登录] IPC返回错误:`, errorDetail);
            console.error(`[重新登录] 完整响应:`, loginResult);
            throw new Error(errorDetail);
          }

          if (!loginResult.account || !loginResult.account.idToken) {
            throw new Error('重新登录失败：返回的Token为空');
          }

          accessToken = loginResult.account.idToken;
          newTokenData = {
            idToken: loginResult.account.idToken,
            idTokenExpiresAt: loginResult.account.idTokenExpiresAt,
            refreshToken: loginResult.account.refreshToken,
            apiKey: loginResult.account.apiKey,
            name: loginResult.account.name,
            apiServerUrl: loginResult.account.apiServerUrl
          };

          console.log(`[重新登录] 账号 ${account.email} 重新获取Token成功`);
          console.log(`[重新登录] 新Token信息:`, {
            hasIdToken: !!newTokenData.idToken,
            hasRefreshToken: !!newTokenData.refreshToken,
            hasApiKey: !!newTokenData.apiKey
          });
        } catch (error) {
          console.error(`[重新登录] 账号 ${account.email} 重新获取Token失败:`, error);
          console.error(`[重新登录] 错误详情:`, {
            message: error.message,
            stack: error.stack
          });
          throw new Error(`重新获取Token失败: ${error.message}`);
        }
      }

      // 验证Token是否有效
      if (!accessToken) {
        throw new Error('Token无效：accessToken为空');
      }

      // 2. 查询使用情况
      try {
        const usageInfo = await this.getUsageInfo(accessToken);

        // 计算使用百分比
        if (usageInfo.totalCredits > 0) {
          usageInfo.usagePercentage = Math.round((usageInfo.usedCredits / usageInfo.totalCredits) * 100);
        }

        return {
          success: true,
          ...usageInfo,
          // 如果刷新了 Token,返回新的 Token 信息
          ...(newTokenData && { newTokenData })
        };
      } catch (error) {
        // 如果是401错误，可能是Token刷新后仍然无效，尝试重新登录
        if ((error.message.includes('401') || error.message.includes('Unauthorized')) && !needReLogin) {
          console.log(`[401错误] Token验证失败，尝试重新登录: ${account.email}`);
          console.log(`[401错误] 当前使用的Token长度: ${accessToken?.length || 0}`);

          if (!account.email || !account.password) {
            console.error(`[401错误] 账号缺少邮箱或密码，无法重新登录`);
            throw new Error('Token验证失败（401），账号缺少邮箱或密码，无法自动重新获取Token');
          }

          try {
            console.log(`[401重试] 开始重新登录: ${account.email}`);

            // 使用IPC调用主进程获取Token（渲染进程不能直接require主进程模块）
            console.log(`[401重试] 通过IPC调用主进程获取Token...`);
            const loginResult = await getIpcRenderer().invoke('get-account-token', {
              email: account.email,
              password: account.password
            });

            console.log(`[401重试] IPC返回结果:`, loginResult?.success ? '成功' : '失败');

            if (!loginResult || !loginResult.success) {
              const errorDetail = loginResult?.error || '重新登录失败：IPC调用失败';
              console.error(`[401重试] IPC返回错误:`, errorDetail);
              console.error(`[401重试] 完整响应:`, loginResult);
              throw new Error(errorDetail);
            }

            if (!loginResult.account || !loginResult.account.idToken) {
              throw new Error('重新登录失败：返回的Token为空');
            }

            console.log(`[401重试] 使用新Token重试查询...`);
            // 使用新Token重试
            const retryUsageInfo = await this.getUsageInfo(loginResult.account.idToken);
            console.log(`[401重试] 查询成功`);

            if (retryUsageInfo.totalCredits > 0) {
              retryUsageInfo.usagePercentage = Math.round((retryUsageInfo.usedCredits / retryUsageInfo.totalCredits) * 100);
            }

            return {
              success: true,
              ...retryUsageInfo,
              newTokenData: {
                idToken: loginResult.account.idToken,
                idTokenExpiresAt: loginResult.account.idTokenExpiresAt,
                refreshToken: loginResult.account.refreshToken,
                apiKey: loginResult.account.apiKey,
                name: loginResult.account.name,
                apiServerUrl: loginResult.account.apiServerUrl
              }
            };
          } catch (retryError) {
            console.error(`[401重试] 重新登录失败:`, retryError);
            console.error(`[401重试] 错误详情:`, {
              message: retryError.message,
              stack: retryError.stack
            });
            throw new Error(`Token验证失败（401），自动重新获取Token失败: ${retryError.message}`);
          }
        }
        throw error;
      }
    } catch (error) {
      console.error(`查询账号 ${account.email} 失败:`, error);
      return {
        success: false,
        error: error.message,
        planName: 'Error',
        usedCredits: 0,
        totalCredits: 0,
        usagePercentage: 0
      };
    }
  },

  /**
   * 批量查询所有账号
   * @param {Array} accounts - 账号列表
   * @param {Function} progressCallback - 进度回调函数 (current, total)
   */
  async queryAllAccounts(accounts, progressCallback) {
    const results = [];

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];

      // 调用进度回调
      if (progressCallback) {
        progressCallback(i + 1, accounts.length);
      }

      try {
        const result = await this.queryAccount(account);
        results.push({
          email: account.email,
          ...result
        });

        if (!result.success) {
          console.error(`[账号查询] ${account.email} - ${result.error}`);
        }
      } catch (error) {
        console.error(`[账号查询] ${account.email} - ${error.message}`);
        results.push({
          email: account.email,
          success: false,
          error: error.message,
          planName: 'Error',
          usedCredits: 0,
          totalCredits: 0,
          usagePercentage: 0
        });
      }

      // 避免请求过快，延迟（最后一个不延迟）
      if (i < accounts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.QUERY_DELAY));
      }
    }

    return results;
  }
};

// ==================== Query state management ====================

const QueryState = {
  isQuerying: false,
  timer: null
};

function getRendererWindow() {
  return typeof window !== 'undefined' ? window : globalThis.window || null;
}

function getIpcRenderer() {
  const rendererWindow = getRendererWindow();
  if (!rendererWindow?.ipcRenderer) {
    throw new Error('渲染进程 IPC 不可用');
  }
  return rendererWindow.ipcRenderer;
}

/**
 * 查询并更新账号列表的订阅和积分信息
 */
async function updateAccountsUsage() {
  // 防止重复查询
  if (QueryState.isQuerying) {
    console.warn('[自动查询] 查询正在进行中，跳过本次');
    return;
  }

  QueryState.isQuerying = true;

  try {
    const rendererWindow = getRendererWindow();
    if (!rendererWindow?.ipcRenderer) {
      return;
    }

    // 获取所有账号
    const result = await rendererWindow.ipcRenderer.invoke('get-accounts');

    if (!result || !result.success || !result.accounts) {
      return;
    }

    const accounts = result.accounts;

    // 批量查询
    const results = await AccountQuery.queryAllAccounts(accounts);

    // 先更新JSON文件（持久化数据）
    let updateCount = 0;
    for (const res of results) {
      if (res.success) {
        try {
          // 查找对应的账号
          const account = accounts.find(acc => acc.email === res.email);
          if (account) {
            // 准备更新数据
            const updateData = {
              id: account.id,
              type: res.planName,
              credits: res.totalCredits,
              usedCredits: res.usedCredits,
              totalCredits: res.totalCredits,
              usage: res.usagePercentage,
              queryUpdatedAt: new Date().toISOString()
            };

            // 如果刷新了 Token,保存新的 Token 信息
            if (res.newTokenData) {
              updateData.idToken = res.newTokenData.idToken;
              updateData.idTokenExpiresAt = res.newTokenData.idTokenExpiresAt;
              updateData.refreshToken = res.newTokenData.refreshToken;
            }

            // 只有当expiresAt有值时才更新
            if (res.expiresAt) {
              updateData.expiresAt = res.expiresAt;
            }

            // 更新账号信息到JSON文件
            await rendererWindow.ipcRenderer.invoke('update-account', updateData);
            updateCount++;
          }
        } catch (error) {
          console.error(`[自动查询] 更新 ${res.email} 失败:`, error);
        }
      }
    }

    // 重新加载账号列表以刷新UI
    const activeWindow = getRendererWindow();
    if (activeWindow === rendererWindow && typeof activeWindow.loadAccounts === 'function') {
      await activeWindow.loadAccounts();
    }
  } catch (error) {
    console.error('[自动查询] 查询失败:', error);
  } finally {
    QueryState.isQuerying = false;
  }
}

/**
 * 更新单个账号的 UI 显示（已废弃，现在通过重新加载列表更新）
 */
function updateAccountUI(email, usageInfo) {
  const row = document.querySelector(`.account-item[data-email="${email}"]`);

  if (!row) {
    console.warn(`[UI更新] 未找到邮箱为 ${email} 的账号行`);
    return false;
  }

  try {
    const typeElement = row.querySelector('.acc-col-type');
    if (typeElement) {
      typeElement.textContent = usageInfo.planName || 'Free';
      if (usageInfo.planName === 'Pro') {
        typeElement.style.color = '#007aff';
      } else if (usageInfo.planName === 'Free') {
        typeElement.style.color = '#86868b';
      } else {
        typeElement.style.color = '#ff3b30';
      }
    }

    const creditsElement = row.querySelector('.acc-col-credits');
    if (creditsElement) {
      if (usageInfo.success) {
        creditsElement.textContent = `${usageInfo.usedCredits}/${usageInfo.totalCredits}`;
        if (usageInfo.usagePercentage >= 80) {
          creditsElement.style.color = '#ff3b30';
        } else if (usageInfo.usagePercentage >= 50) {
          creditsElement.style.color = '#ff9500';
        } else {
          creditsElement.style.color = '#34c759';
        }
      } else {
        creditsElement.textContent = '查询失败';
        creditsElement.style.color = '#ff3b30';
      }
    }

    const usageElement = row.querySelector('.acc-col-usage');
    if (usageElement) {
      if (usageInfo.success) {
        usageElement.textContent = `${usageInfo.usagePercentage}%`;
        if (usageInfo.usagePercentage >= 80) {
          usageElement.style.color = '#ff3b30';
        } else if (usageInfo.usagePercentage >= 50) {
          usageElement.style.color = '#ff9500';
        } else {
          usageElement.style.color = '#34c759';
        }
      } else {
        usageElement.textContent = '-';
        usageElement.style.color = '#86868b';
      }
    }

    console.log(`[UI更新] 已更新 ${email} 的显示`);
    return true;
  } catch (error) {
    console.error(`[UI更新] 更新 ${email} 失败:`, error);
    return false;
  }
}

/**
 * 启动自动定时查询
 */
function startAutoQuery(interval = CONFIG.AUTO_QUERY_INTERVAL) {
  stopAutoQuery();
  updateAccountsUsage();
  QueryState.timer = setInterval(() => {
    updateAccountsUsage();
  }, interval);
  console.log(`[自动查询] 已启动，间隔: ${interval / 1000} 秒 (${interval / 60000} 分钟)`);
}

/**
 * 停止自动查询
 */
function stopAutoQuery() {
  if (QueryState.timer) {
    clearInterval(QueryState.timer);
    QueryState.timer = null;
    console.log('[自动查询] 已停止');
  }
}

/**
 * 重启自动查询（用于配置更改后）
 */
function restartAutoQuery(intervalMinutes) {
  console.log(`[自动查询] 重启查询，新间隔: ${intervalMinutes} 分钟`);
  stopAutoQuery();
  const intervalMs = intervalMinutes * 60 * 1000;
  startAutoQuery(intervalMs);
}

/**
 * 从配置中读取查询间隔
 */
function getQueryIntervalFromConfig() {
  try {
    const configStr = localStorage.getItem('windsurfConfig');
    if (configStr) {
      const config = JSON.parse(configStr);
      const interval = parseInt(config.queryInterval);
      if (!isNaN(interval) && interval >= CONFIG.MIN_INTERVAL && interval <= CONFIG.MAX_INTERVAL) {
        return interval * 60 * 1000; // 转换为毫秒
      }
    }
  } catch (error) {
    console.error('[自动查询] 读取配置失败:', error);
  }
  return CONFIG.AUTO_QUERY_INTERVAL;
}

/**
 * Setup DOMContentLoaded and beforeunload listeners
 */
function setupQueryListeners() {
  const interval = getQueryIntervalFromConfig();
  console.log(`[自动查询] 从配置读取间隔: ${interval / 60000} 分钟`);
  startAutoQuery(interval);

  const rendererWindow = getRendererWindow();
  rendererWindow?.addEventListener('beforeunload', () => {
    stopAutoQuery();
    console.log('[自动查询] 页面卸载，已清理定时器');
  });

  console.log('[AccountQuery] 模块已加载');
  console.log('[AccountQuery] 可用方法:', Object.keys(AccountQuery));
}

// ==================== Module exports ====================

module.exports = {
  setupQueryListeners,
  AccountQuery,
  windowExports: {
    AccountQuery,
    updateAccountsUsage,
    updateAccountUI,
    startAutoQuery,
    stopAutoQuery,
    restartAutoQuery,
    setupQueryListeners,
  },
};
