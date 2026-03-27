/**
 * Firebase Auth 统一服务
 * 集中管理 Firebase 邮箱密码登录、Token 刷新等操作
 * 供 accountLogin / accountSwitcher / accountQuery 等模块共用
 */

const axios = require('axios');
const CONSTANTS = require('../../js/constants');

class FirebaseAuthService {
  /**
   * 使用邮箱密码登录 Firebase
   * 优先直连 Firebase，失败回退到 Cloudflare Workers 中转
   * @param {string} email
   * @param {string} password
   * @returns {Promise<{idToken: string, refreshToken: string, localId: string, email: string, expiresIn: number}>}
   */
  static async signInWithEmailPassword(email, password) {
    const FIREBASE_API_KEY = CONSTANTS.FIREBASE_API_KEY;
    const FIREBASE_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
    const WORKER_URL = `${CONSTANTS.WORKER_URL}/login`;

    const attempts = [
      { name: 'Firebase 直连', url: FIREBASE_URL, body: { email, password, returnSecureToken: true } },
      { name: '中转服务器', url: WORKER_URL, body: { email, password, api_key: FIREBASE_API_KEY } }
    ];

    let lastError = null;

    for (const attempt of attempts) {
      try {
        const response = await axios.post(attempt.url, attempt.body, {
          headers: { 'Content-Type': 'application/json' },
          timeout: CONSTANTS.REQUEST_TIMEOUT
        });

        return {
          idToken: response.data.idToken,
          refreshToken: response.data.refreshToken,
          email: response.data.email,
          expiresIn: parseInt(response.data.expiresIn || 3600),
          localId: response.data.localId
        };
      } catch (error) {
        const isNetworkError = error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED';
        if (isNetworkError) {
          lastError = error;
          continue;
        }

        const errorMessage = error.response?.data?.error?.message || error.message;
        const messageMap = {
          'EMAIL_NOT_FOUND': '邮箱不存在，请检查邮箱地址是否正确',
          'INVALID_PASSWORD': '密码错误，请检查密码是否正确',
          'INVALID_LOGIN_CREDENTIALS': '邮箱或密码错误，请检查登录凭据是否正确',
          'USER_DISABLED': '账号已被禁用',
          'TOO_MANY_ATTEMPTS_TRY_LATER': '尝试次数过多，请稍后再试',
          'INVALID_EMAIL': '邮箱格式不正确'
        };

        const friendlyMessage = Object.entries(messageMap).find(([k]) => errorMessage.includes(k))?.[1] || errorMessage;
        throw new Error(friendlyMessage);
      }
    }

    throw new Error('无法连接到 Firebase 服务器，请检查网络连接或开启代理');
  }

  /**
   * 使用 refresh_token 刷新 Firebase ID Token
   * 优先直连 Firebase securetoken，失败回退到 Cloudflare Workers 中转
   * @param {string} refreshToken
   * @param {Object} [options]
   * @param {string} [options.email] - 可选，用于中转服务器
   * @param {string} [options.password] - 可选，用于中转服务器
   * @returns {Promise<{idToken: string, accessToken: string, refreshToken: string, expiresIn: number}>}
   */
  static async refreshToken(refreshToken, options = {}) {
    const FIREBASE_API_KEY = CONSTANTS.FIREBASE_API_KEY;
    const WORKER_URL = CONSTANTS.WORKER_URL;
    const FIREBASE_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

    const workerBody = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      api_key: FIREBASE_API_KEY
    };
    if (options.email && options.password) {
      workerBody.email = options.email;
      workerBody.password = options.password;
    }

    const attempts = [
      {
        name: 'Firebase 直连',
        url: FIREBASE_URL,
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        parse: (data) => ({
          idToken: data.id_token,
          accessToken: data.access_token || data.id_token,
          refreshToken: data.refresh_token || refreshToken,
          expiresIn: parseInt(data.expires_in || 3600)
        })
      },
      {
        name: '中转服务器',
        url: WORKER_URL,
        body: workerBody,
        headers: { 'Content-Type': 'application/json' },
        parse: (data) => ({
          idToken: data.id_token,
          accessToken: data.access_token || data.id_token,
          refreshToken: data.refresh_token || refreshToken,
          expiresIn: parseInt(data.expires_in || 3600)
        })
      }
    ];

    let lastError = null;
    for (const attempt of attempts) {
      try {
        const response = await axios.post(attempt.url, attempt.body, {
          headers: attempt.headers,
          timeout: CONSTANTS.REQUEST_TIMEOUT
        });
        return attempt.parse(response.data);
      } catch (error) {
        const isNetworkError = error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED';
        if (isNetworkError) {
          lastError = error;
          continue;
        }
        if (error.response) {
          throw new Error(`Firebase token 刷新失败: ${JSON.stringify(error.response.data)}`);
        }
        throw error;
      }
    }

    throw new Error('无法连接到 Firebase 服务器，请检查网络连接或开启代理');
  }

  /**
   * 获取一个"新鲜"的 idToken —— 如果本地已有且未过期则直接返回，否则用 refreshToken 刷新
   * @param {Object} account - 账号对象 { idToken, idTokenExpiresAt, refreshToken, email?, password? }
   * @returns {Promise<{accessToken: string, newTokenData: Object|null}>}
   *   accessToken 可直接使用；newTokenData 非 null 时表示刷新过，调用方应持久化
   */
  static async getFreshToken(account) {
    const now = Date.now();
    const tokenExpired = !account.idToken || !account.idTokenExpiresAt || now >= account.idTokenExpiresAt;

    if (!tokenExpired) {
      return { accessToken: account.idToken, newTokenData: null };
    }

    if (!account.refreshToken) {
      throw new Error('账号缺少 refreshToken，无法刷新 Token');
    }

    const tokens = await this.refreshToken(account.refreshToken, {
      email: account.email,
      password: account.password
    });

    if (!tokens || !tokens.idToken) {
      throw new Error('刷新Token失败：返回的Token为空');
    }

    return {
      accessToken: tokens.idToken,
      newTokenData: {
        idToken: tokens.idToken,
        idTokenExpiresAt: now + (tokens.expiresIn * 1000),
        refreshToken: tokens.refreshToken
      }
    };
  }
}

module.exports = { FirebaseAuthService };
