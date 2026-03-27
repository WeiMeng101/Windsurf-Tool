// src/renderer/codexManager.js — Codex 账号池管理器
'use strict';

const showToast = (...args) => window.showToast(...args);

const CodexManager = {
  _initialized: false,

  async init() {
    if (!this._initialized) {
      this._setupIpcListeners();
      this._initialized = true;
    }
    await this.loadConfig();
    await this.refreshAccountList();
  },

  _setupIpcListeners() {
    window.ipcRenderer.on('codex-register-log', (_e, data) => {
      this._appendLog(data.message || data, data.type || 'info');
    });

    window.ipcRenderer.on('codex-register-progress', (_e, data) => {
      const progressEl = document.getElementById('codexRegisterProgress');
      if (progressEl) {
        progressEl.textContent = `${data.current || 0} / ${data.total || 0}`;
      }
    });

    window.ipcRenderer.on('codex-account-switched', (_e, data) => {
      if (data && data.email) {
        this._appendLog(`[切号] 切换到: ${data.email}`, 'success');
        showToast(`已切换到 ${data.email}`, 'success');
      }
      this.refreshAccountList();
    });
  },

  // ---------- 配置 ----------
  async loadConfig() {
    try {
      const result = await window.ipcRenderer.invoke('load-codex-config');
      const cfg = (result && result.config) ? result.config : result || {};
      const elProxy = document.getElementById('codexProxy');
      const elOAuth = document.getElementById('codexEnableOAuth');
      if (elProxy) elProxy.value = cfg.proxy || '';
      if (elOAuth) elOAuth.checked = cfg.enableOAuth !== false;
    } catch (e) {
      console.error('加载 Codex 配置失败:', e);
    }
  },

  async saveConfig() {
    const proxy = (document.getElementById('codexProxy')?.value || '').trim();
    const enableOAuth = document.getElementById('codexEnableOAuth')?.checked !== false;
    try {
      await window.ipcRenderer.invoke('save-codex-config', { proxy, enableOAuth });
      showToast('Codex 配置已保存', 'success');
    } catch (e) {
      showToast('保存失败: ' + e.message, 'error');
    }
  },

  // ---------- 批量注册 ----------
  async startBatchRegister() {
    const count = parseInt(document.getElementById('codexRegisterCount')?.value || '1', 10);
    const proxy = (document.getElementById('codexProxy')?.value || '').trim();
    const enableOAuth = document.getElementById('codexEnableOAuth')?.checked !== false;

    if (count < 1 || count > 100) {
      showToast('注册数量应在 1-100 之间', 'warning');
      return;
    }

    // 从系统配置读取邮箱域名和 IMAP 配置
    let emailConfig = null;
    let emailDomains = [];
    try {
      const sysConf = await window.ipcRenderer.invoke('load-windsurf-config');
      if (sysConf && sysConf.success && sysConf.config) {
        emailConfig = sysConf.config.emailConfig || null;
        emailDomains = sysConf.config.emailDomains || [];
      }
    } catch (e) {
      console.error('读取系统配置失败:', e);
    }

    if (!emailConfig || !emailConfig.user || !emailConfig.password) {
      showToast('请先在「系统设置」中配置 IMAP 邮箱', 'warning');
      return;
    }
    if (!emailDomains || emailDomains.length === 0 || (emailDomains.length === 1 && emailDomains[0] === 'example.com')) {
      showToast('请先在「系统设置」中添加邮箱域名', 'warning');
      return;
    }

    const startBtn = document.getElementById('codexStartRegisterBtn');
    const cancelBtn = document.getElementById('codexCancelRegisterBtn');
    if (startBtn) startBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = '';

    const logEl = document.getElementById('codexRegisterLog');
    if (logEl) logEl.innerHTML = '';
    const progressEl = document.getElementById('codexRegisterProgress');
    if (progressEl) progressEl.textContent = '';

    this._appendLog(`开始批量注册 ${count} 个 Codex 账号...`, 'info');

    try {
      const result = await window.ipcRenderer.invoke('codex-batch-register', {
        count, emailConfig, emailDomains, proxy, enableOAuth
      });
      this._appendLog('========== 注册完成 ==========', 'info');
      this._appendLog(`成功: ${result.successCount || 0} 个`, 'success');
      this._appendLog(`失败: ${result.failCount || 0} 个`, result.failCount ? 'error' : 'info');
      showToast(`注册完成！成功 ${result.successCount || 0}，失败 ${result.failCount || 0}`, 'success');
      await this.refreshAccountList();
    } catch (e) {
      this._appendLog(`注册出错: ${e.message}`, 'error');
      showToast('注册失败: ' + e.message, 'error');
    } finally {
      if (startBtn) startBtn.style.display = '';
      if (cancelBtn) cancelBtn.style.display = 'none';
    }
  },

  async cancelRegister() {
    try {
      await window.ipcRenderer.invoke('cancel-codex-register');
      this._appendLog('已发送取消请求...', 'warning');
    } catch (e) {
      showToast('取消失败: ' + e.message, 'error');
    }
  },

  // ---------- 账号池操作 ----------
  async refreshAccountList() {
    try {
      const data = await window.ipcRenderer.invoke('codex-get-accounts');
      this._renderAccountList(data.accounts || []);
      this._renderPoolSummary(data.status || {});
    } catch (e) {
      console.error('刷新 Codex 账号列表失败:', e);
    }
  },

  async addAccount() {
    const email = (document.getElementById('codexAddEmail')?.value || '').trim();
    const password = (document.getElementById('codexAddPassword')?.value || '').trim();
    const accessToken = (document.getElementById('codexAddAccessToken')?.value || '').trim();
    const refreshToken = (document.getElementById('codexAddRefreshToken')?.value || '').trim();
    if (!email) {
      showToast('请填写邮箱', 'warning');
      return;
    }
    try {
      await window.ipcRenderer.invoke('codex-add-account', {
        email, password, accessToken, refreshToken
      });
      showToast(`已添加: ${email}`, 'success');
      document.getElementById('codexAddEmail').value = '';
      document.getElementById('codexAddPassword').value = '';
      document.getElementById('codexAddAccessToken').value = '';
      document.getElementById('codexAddRefreshToken').value = '';
      await this.refreshAccountList();
    } catch (e) {
      showToast('添加失败: ' + e.message, 'error');
    }
  },

  async removeAccount(email) {
    if (!confirm(`确认删除账号 ${email}？`)) return;
    try {
      await window.ipcRenderer.invoke('codex-remove-account', email);
      showToast('已删除', 'success');
      await this.refreshAccountList();
    } catch (e) {
      showToast('删除失败: ' + e.message, 'error');
    }
  },

  async removeAllAccounts() {
    if (!confirm('确认清空所有 Codex 账号？此操作不可恢复！')) return;
    try {
      await window.ipcRenderer.invoke('codex-remove-all-accounts');
      showToast('已清空所有账号', 'success');
      await this.refreshAccountList();
    } catch (e) {
      showToast('清空失败: ' + e.message, 'error');
    }
  },

  async resetAllStatus() {
    try {
      await window.ipcRenderer.invoke('codex-reset-all-status');
      showToast('所有账号状态已重置', 'success');
      await this.refreshAccountList();
    } catch (e) {
      showToast('重置失败: ' + e.message, 'error');
    }
  },

  async switchNext() {
    try {
      const result = await window.ipcRenderer.invoke('codex-switch-next');
      if (result && result.email) {
        showToast(`已切换到: ${result.email}`, 'success');
      } else {
        showToast('无可用账号', 'warning');
      }
      await this.refreshAccountList();
    } catch (e) {
      showToast('切换失败: ' + e.message, 'error');
    }
  },

  async getActiveToken() {
    try {
      const result = await window.ipcRenderer.invoke('codex-get-active-token');
      const tokenDiv = document.getElementById('codexCurrentToken');
      const emailEl = document.getElementById('codexCurrentEmail');
      const tokenTextEl = document.getElementById('codexCurrentTokenText');
      if (result && result.accessToken) {
        if (tokenDiv) tokenDiv.style.display = '';
        if (emailEl) emailEl.textContent = result.email || '未知';
        if (tokenTextEl) tokenTextEl.value = result.accessToken;
      } else {
        showToast('无可用 Token，请添加账号或注册', 'warning');
        if (tokenDiv) tokenDiv.style.display = 'none';
      }
      await this.refreshAccountList();
    } catch (e) {
      showToast('获取失败: ' + e.message, 'error');
    }
  },

  async refreshSingleToken(email) {
    try {
      this._appendLog(`正在刷新 ${email} 的 Token...`, 'info');
      await window.ipcRenderer.invoke('codex-refresh-token', email);
      showToast(`${email} Token 已刷新`, 'success');
      await this.refreshAccountList();
    } catch (e) {
      showToast('刷新失败: ' + e.message, 'error');
    }
  },

  copyToken() {
    const text = document.getElementById('codexCurrentTokenText')?.value;
    if (text) {
      navigator.clipboard.writeText(text).then(() => showToast('已复制到剪贴板', 'success'));
    }
  },

  // ---------- UI 渲染 ----------
  _renderPoolSummary(status) {
    const el = document.getElementById('codexPoolSummary');
    if (!el) return;
    el.textContent = `总计${status.total || 0} | 空闲${status.idle || 0} | 活跃${status.active || 0} | 过期${status.expired || 0} | 耗尽${status.exhausted || 0}`;
  },

  _renderAccountList(accounts) {
    const container = document.getElementById('codexAccountList');
    if (!container) return;

    if (!accounts || accounts.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: #999; padding: 20px; font-size: 13px;">暂无账号</div>';
      return;
    }

    const statusColors = {
      idle: '#34c759', active: '#007aff', expired: '#ff9500', exhausted: '#ff3b30'
    };
    const statusLabels = {
      idle: '空闲', active: '活跃', expired: '过期', exhausted: '耗尽'
    };

    const rows = accounts.map(acc => {
      const sColor = statusColors[acc.status] || '#999';
      const sLabel = statusLabels[acc.status] || acc.status;
      const hasToken = acc.accessToken ? '✓' : '✗';
      const hasRefresh = acc.refreshToken ? '✓' : '✗';
      const email = this._escapeHtml(acc.email || '');
      const useCount = acc.use_count || 0;

      return `<div style="display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #f0f0f0; font-size: 12px;">
        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${sColor}; flex-shrink: 0;"></span>
        <span style="flex: 2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${email}">${email}</span>
        <span style="width: 50px; text-align: center; color: ${sColor}; font-weight: 500;">${sLabel}</span>
        <span style="width: 40px; text-align: center;" title="Access Token">${hasToken}</span>
        <span style="width: 40px; text-align: center;" title="Refresh Token">${hasRefresh}</span>
        <span style="width: 30px; text-align: center; color: #86868b;">${useCount}</span>
        <span style="display: flex; gap: 4px; flex-shrink: 0;">
          <button onclick="CodexManager.refreshSingleToken('${email}')" style="background: none; border: 1px solid #e0e0e0; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 11px;" title="刷新Token">🔄</button>
          <button onclick="CodexManager.removeAccount('${email}')" style="background: none; border: 1px solid #e0e0e0; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 11px; color: #ff3b30;" title="删除">✕</button>
        </span>
      </div>`;
    }).join('');

    container.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 2px solid #e0e0e0; font-size: 11px; color: #86868b; font-weight: 600;">
        <span style="width: 8px;"></span>
        <span style="flex: 2;">邮箱</span>
        <span style="width: 50px; text-align: center;">状态</span>
        <span style="width: 40px; text-align: center;">AT</span>
        <span style="width: 40px; text-align: center;">RT</span>
        <span style="width: 30px; text-align: center;">次数</span>
        <span style="width: 60px; text-align: center;">操作</span>
      </div>
      ${rows}
    `;
  },

  _appendLog(msg, type) {
    const logEl = document.getElementById('codexRegisterLog');
    if (!logEl) return;
    const colors = { info: '#a0a0a0', success: '#34c759', error: '#ff3b30', warning: '#ff9500' };
    const color = colors[type] || colors.info;
    const time = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.style.color = color;
    line.textContent = `[${time}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  },

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};

module.exports = CodexManager;
