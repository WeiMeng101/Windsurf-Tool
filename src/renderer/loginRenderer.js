// loginRenderer.js - 账号登录获取 Token 模块
// 从 js/accountLogin.js 迁移

const axios = require('axios');
const CONSTANTS = require('./constants');
const { FirebaseAuthService } = require('../services/firebaseAuth');

class AccountLogin {
  constructor() {
    this.logCallback = null;
  }

  /**
   * 输出日志
   */
  log(message) {
    console.log(message);
    const callback = (
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
        console.error('[账号日志回调执行失败]', callbackError?.message || callbackError);
      }
    }
  }

  /**
   * 直接使用邮箱密码登录获取 Firebase Token（无需浏览器）
   * @param {string} email - 邮箱
   * @param {string} password - 密码
   * @returns {Promise<Object>} - 返回 { idToken, refreshToken, email, expiresIn }
   */
  async loginWithEmailPassword(email, password) {
    this.log(`尝试登录...`);
    try {
      const result = await FirebaseAuthService.signInWithEmailPassword(email, password);
      this.log(`登录成功`);
      return result;
    } catch (error) {
      this.log(`Firebase 登录失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 使用邮箱密码直接获取完整的账号信息（无需浏览器）
   * @param {string} email - 邮箱
   * @param {string} password - 密码
   * @returns {Promise<Object>} - 返回完整的账号信息
   */
  async getAccountInfoByPassword(email, password) {
    try {
      const firebaseTokens = await this.loginWithEmailPassword(email, password);
      const apiKeyInfo = await this.getApiKey(firebaseTokens.idToken);

      const accountInfo = {
        email: email,
        password: password,
        refreshToken: firebaseTokens.refreshToken,
        idToken: firebaseTokens.idToken,
        idTokenExpiresAt: Date.now() + (firebaseTokens.expiresIn * 1000),
        apiKey: apiKeyInfo.apiKey,
        name: apiKeyInfo.name,
        apiServerUrl: apiKeyInfo.apiServerUrl,
        createdAt: new Date().toISOString()
      };

      return accountInfo;
    } catch (error) {
      this.log(`获取账号信息失败`);
      this.log(`   错误: ${error.message}`);
      throw error;
    }
  }

  /**
   * 使用 access_token 获取 API Key
   */
  async getApiKey(accessToken) {
    try {
      const response = await axios.post(
        'https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser',
        {
          firebase_id_token: accessToken
        },
        {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      return {
        apiKey: response.data.api_key,
        name: response.data.name,
        apiServerUrl: response.data.api_server_url
      };
    } catch (error) {
      // 尝试打印代理环境变量
      const proxyEnv = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
      if (proxyEnv) {
        this.log(`   当前环境变量代理: ${proxyEnv}`);
      } else {
        this.log(`   提示: 未检测到 Node.js 代理环境变量 (HTTPS_PROXY/HTTP_PROXY)`);
      }

      // 判断是否为网络连接问题
      if (error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
        this.log('无法连接到服务器');
        this.log('   错误: 网络连接失败');
        this.log('   建议: 请检查网络连接');
        throw new Error('无法连接到 Windsurf 服务器，请检查网络连接');
      }

      const errorMessage = error.response?.data?.error?.message || error.message;
      this.log(`获取 API Key 失败: ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }

  /**
   * 登录账号并获取完整 Token（兼容旧接口）
   * @param {Object} account - 账号信息 { email, password }
   * @param {Function} logCallback - 日志回调函数
   * @returns {Object} - 包含完整 Token 信息的账号对象
   */
  async loginAndGetTokens(account, logCallback) {
    this.logCallback = logCallback;

    try {
      this.log('========== 开始登录获取 Token ==========');
      this.log(`账号: ${account.email}`);
      this.log('');

      // 使用中转服务登录
      const accountInfo = await this.getAccountInfoByPassword(account.email, account.password);

      this.log('');
      this.log('========== 登录完成 ==========');
      this.log('');

      // 返回更新后的账号信息
      return {
        success: true,
        account: {
          ...account,
          name: accountInfo.name,
          apiKey: accountInfo.apiKey,
          apiServerUrl: accountInfo.apiServerUrl,
          refreshToken: accountInfo.refreshToken,
          idToken: accountInfo.idToken,
          idTokenExpiresAt: accountInfo.idTokenExpiresAt,
          updatedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      this.log('');
      this.log('========== 登录失败 ==========');
      this.log(`错误: ${error.message}`);
      this.log('');

      return {
        success: false,
        error: error.message,
        account: account
      };
    }
  }
}

// ==================== Module exports ====================

module.exports = {
  AccountLogin,
  windowExports: {
    AccountLogin,
  },
};
