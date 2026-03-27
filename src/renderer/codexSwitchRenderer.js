/**
 * Codex 无感切号模块
 * 管理 Codex (OpenAI) 账号池，支持自动检测 Token 过期并无感切换
 *
 * 功能：
 * 1. Codex 账号池管理（加载/保存/增删）
 * 2. Token 刷新（refresh_token → access_token）
 * 3. 自动检测 Token 过期，无感切换到下一可用账号
 * 4. 账号状态追踪（活跃/已用尽/Token 过期）
 */

const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const crypto = require('crypto');

function getConstants() {
  return require('./constants');
}

// ================= JWT 辅助（统一引用 tokenUtils） =================
const { decodeJwtPayload, isTokenExpired } = require('../services/tokenUtils');

// ================= Codex 账号池管理 =================
class CodexAccountPool {
  constructor(options = {}) {
    this._logCallback = options.logCallback || null;
    this._poolFilePath = options.poolFilePath || null; // 由外部传入
    this._accounts = [];
    this._currentIndex = -1;
    this._loaded = false;
  }

  _log(msg) {
    const fullMsg = `[CodexPool] ${msg}`;
    console.log(fullMsg);
    if (this._logCallback) this._logCallback(fullMsg);
  }

  // ----------- 持久化 -----------

  _getPoolFilePath() {
    if (this._poolFilePath) return this._poolFilePath;
    throw new Error('CodexAccountPool: poolFilePath 未设置');
  }

  async load() {
    const filePath = this._getPoolFilePath();
    try {
      const data = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(data);
      this._accounts = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code === 'ENOENT') {
        this._accounts = [];
      } else {
        this._log(`加载池文件失败: ${err.message}`);
        this._accounts = [];
      }
    }
    this._loaded = true;
    // 恢复 currentIndex（找到第一个 active 的）
    this._currentIndex = this._accounts.findIndex(a => a.status === 'active');
    this._log(`已加载 ${this._accounts.length} 个账号, 当前索引: ${this._currentIndex}`);
  }

  async save() {
    const filePath = this._getPoolFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(this._accounts, null, 2), 'utf8');
  }

  // ----------- 账号操作 -----------

  getAll() {
    return [...this._accounts];
  }

  getCount() {
    return this._accounts.length;
  }

  getActiveCount() {
    return this._accounts.filter(a => a.status === 'active' || a.status === 'idle').length;
  }

  getCurrent() {
    if (this._currentIndex >= 0 && this._currentIndex < this._accounts.length) {
      return { ...this._accounts[this._currentIndex] };
    }
    return null;
  }

  /**
   * 添加账号到池
   * @param {object} accountData - { email, password, access_token, refresh_token, id_token, ... }
   */
  async addAccount(accountData) {
    if (!accountData || !accountData.email) {
      throw new Error('账号数据缺少 email');
    }

    // 检查重复
    const existing = this._accounts.find(a => a.email === accountData.email);
    if (existing) {
      // 更新 Token
      Object.assign(existing, {
        access_token: accountData.access_token || existing.access_token,
        refresh_token: accountData.refresh_token || existing.refresh_token,
        id_token: accountData.id_token || existing.id_token,
        password: accountData.password || existing.password,
        status: 'idle',
        last_refresh: new Date().toISOString(),
      });
      this._log(`更新已有账号: ${accountData.email}`);
    } else {
      this._accounts.push({
        id: crypto.randomBytes(8).toString('hex'),
        email: accountData.email,
        password: accountData.password || '',
        access_token: accountData.access_token || '',
        refresh_token: accountData.refresh_token || '',
        id_token: accountData.id_token || '',
        status: 'idle', // idle | active | expired | exhausted
        last_refresh: new Date().toISOString(),
        created_at: new Date().toISOString(),
        use_count: 0,
        error_count: 0,
        last_error: '',
      });
      this._log(`新增账号: ${accountData.email}`);
    }

    await this.save();
  }

  /**
   * 批量导入注册结果
   * @param {Array} results - CodexBatchRegistrar.runBatch() 的 results
   */
  async importFromRegistrationResults(results) {
    let imported = 0;
    let skippedNoToken = 0;
    let skippedFailed = 0;
    for (const result of results) {
      if (!result.success) {
        skippedFailed++;
        continue;
      }
      if (!result.tokens) {
        skippedNoToken++;
        this._log(`跳过 ${result.email || '未知邮箱'}: 注册成功但无 OAuth Token`);
        continue;
      }
      await this.addAccount({
        email: result.email,
        password: result.chatgptPassword,
        access_token: result.tokens.access_token,
        refresh_token: result.tokens.refresh_token,
        id_token: result.tokens.id_token || '',
      });
      imported++;
    }
    if (skippedNoToken > 0) {
      this._log(`${skippedNoToken} 个账号因缺少 Token 未导入（可尝试手动登录获取 Token）`);
    }
    this._log(`批量导入完成: ${imported}/${results.length}（跳过: ${skippedFailed} 失败, ${skippedNoToken} 无Token）`);
    return imported;
  }

  async removeAccount(emailOrId) {
    const idx = this._accounts.findIndex(a => a.email === emailOrId || a.id === emailOrId);
    if (idx < 0) return false;
    this._accounts.splice(idx, 1);
    // 修正 currentIndex
    if (this._currentIndex >= this._accounts.length) {
      this._currentIndex = this._accounts.length - 1;
    }
    await this.save();
    return true;
  }

  async removeAllAccounts() {
    this._accounts = [];
    this._currentIndex = -1;
    await this.save();
  }

  // ----------- Token 刷新 -----------

  async refreshToken(account) {
    if (!account.refresh_token) {
      throw new Error('无 refresh_token');
    }

    const CONSTANTS = getConstants();
    const resp = await axios.post(`${CONSTANTS.CODEX_OAUTH_ISSUER}/oauth/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: account.refresh_token,
        client_id: CONSTANTS.CODEX_OAUTH_CLIENT_ID,
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
        validateStatus: () => true,
      });

    if (resp.status !== 200 || !resp.data?.access_token) {
      throw new Error(`Token 刷新失败 (${resp.status}): ${JSON.stringify(resp.data).substring(0, 200)}`);
    }

    return resp.data;
  }

  /**
   * 确保指定账号的 access_token 有效，过期则刷新
   * @returns {object} - 更新后的账号数据
   */
  async ensureValidToken(account) {
    if (!isTokenExpired(account.access_token)) {
      return account;
    }

    this._log(`Token 已过期，刷新: ${account.email}`);

    const tokens = await this.refreshToken(account);

    // 在原数组中更新
    const poolAccount = this._accounts.find(a => a.email === account.email);
    if (poolAccount) {
      poolAccount.access_token = tokens.access_token;
      if (tokens.refresh_token) poolAccount.refresh_token = tokens.refresh_token;
      if (tokens.id_token) poolAccount.id_token = tokens.id_token;
      poolAccount.last_refresh = new Date().toISOString();
      poolAccount.status = 'active';
      await this.save();
    }

    return { ...account, ...tokens };
  }

  // ----------- 无感切号 -----------

  /**
   * 获取下一个可用账号（跳过 exhausted 和 expired 的）
   * 按循环顺序从 currentIndex+1 开始查找
   */
  _findNextAvailable(startFrom = -1) {
    if (this._accounts.length === 0) return -1;

    const start = (startFrom >= 0 ? startFrom : this._currentIndex) + 1;
    const total = this._accounts.length;

    for (let offset = 0; offset < total; offset++) {
      const idx = (start + offset) % total;
      const acc = this._accounts[idx];
      if (acc.status === 'idle' || acc.status === 'active') {
        return idx;
      }
    }
    return -1;
  }

  /**
   * 切换到下一个可用账号并返回有效 Token
   * 如果 Token 过期则自动刷新
   * @returns {{ account, access_token, switched }} 或 null
   */
  async switchToNext() {
    const nextIdx = this._findNextAvailable();
    if (nextIdx < 0) {
      this._log('无可用账号');
      return null;
    }

    // 标记旧账号
    if (this._currentIndex >= 0 && this._currentIndex < this._accounts.length) {
      const old = this._accounts[this._currentIndex];
      if (old.status === 'active') {
        old.status = 'idle';
      }
    }

    this._currentIndex = nextIdx;
    const account = this._accounts[nextIdx];
    account.status = 'active';
    account.use_count = (account.use_count || 0) + 1;

    try {
      const updated = await this.ensureValidToken(account);
      await this.save();
      this._log(`切换到: ${account.email} (index=${nextIdx})`);
      return {
        account: { ...updated },
        access_token: updated.access_token,
        switched: true,
      };
    } catch (err) {
      this._log(`Token 刷新失败: ${account.email} - ${err.message}`);
      account.status = 'expired';
      account.last_error = err.message;
      account.error_count = (account.error_count || 0) + 1;
      await this.save();
      // 递归尝试下一个
      return this.switchToNext();
    }
  }

  /**
   * 获取当前活跃账号的有效 Token
   * 如果 Token 过期 → 自动刷新
   * 如果刷新失败 → 自动切换到下一个
   * @returns {{ account, access_token, switched }} 或 null
   */
  async getActiveToken() {
    if (!this._loaded) {
      await this.load();
    }

    // 没有当前账号 → 切到首个可用
    if (this._currentIndex < 0 || this._currentIndex >= this._accounts.length) {
      return this.switchToNext();
    }

    const current = this._accounts[this._currentIndex];
    if (current.status === 'exhausted' || current.status === 'expired') {
      return this.switchToNext();
    }

    // 尝试确保 Token 有效
    try {
      const updated = await this.ensureValidToken(current);
      return {
        account: { ...updated },
        access_token: updated.access_token,
        switched: false,
      };
    } catch (err) {
      this._log(`当前账号 Token 失效: ${current.email} - ${err.message}`);
      current.status = 'expired';
      current.last_error = err.message;
      current.error_count = (current.error_count || 0) + 1;
      await this.save();
      return this.switchToNext();
    }
  }

  /**
   * 标记当前账号为已用尽（配额不足等）
   * 自动切换到下一个
   */
  async markCurrentExhausted(reason = '') {
    if (this._currentIndex >= 0 && this._currentIndex < this._accounts.length) {
      const acc = this._accounts[this._currentIndex];
      acc.status = 'exhausted';
      acc.last_error = reason || 'quota exhausted';
      this._log(`标记已用尽: ${acc.email}`);
      await this.save();
    }
    return this.switchToNext();
  }

  /**
   * 重置所有账号状态为 idle（用于新一轮使用）
   */
  async resetAllStatus() {
    for (const acc of this._accounts) {
      acc.status = 'idle';
      acc.error_count = 0;
      acc.last_error = '';
    }
    this._currentIndex = -1;
    await this.save();
    this._log('所有账号状态已重置');
  }

  /**
   * 获取账号池状态摘要
   */
  getStatus() {
    const total = this._accounts.length;
    const idle = this._accounts.filter(a => a.status === 'idle').length;
    const active = this._accounts.filter(a => a.status === 'active').length;
    const expired = this._accounts.filter(a => a.status === 'expired').length;
    const exhausted = this._accounts.filter(a => a.status === 'exhausted').length;
    const current = this.getCurrent();

    return {
      total,
      idle,
      active,
      expired,
      exhausted,
      available: idle + active,
      currentEmail: current ? current.email : null,
      currentIndex: this._currentIndex,
    };
  }
}

module.exports = {
  CodexAccountPool,
  isTokenExpired,
  decodeJwtPayload,
  windowExports: {
    CodexAccountPool,
  },
};
