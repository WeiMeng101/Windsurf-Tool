'use strict';

const PROVIDER_LABELS = {
  windsurf: 'Windsurf', codex: 'Codex',
  openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini',
  deepseek: 'DeepSeek', moonshot: '月之暗面', doubao: '字节豆包',
  zhipu: '智谱AI', openrouter: 'OpenRouter', xai: 'xAI (Grok)',
  siliconflow: '硅基流动', ppio: 'PP算力', claudecode: 'Claude Code',
  other: '其他',
};

const STATUS_CONFIG = {
  available: { text: '可用', cls: 'badge-success' },
  in_use:    { text: '使用中', cls: 'badge-info' },
  error:     { text: '异常', cls: 'badge-danger' },
  cooldown:  { text: '冷却中', cls: 'badge-warning' },
  disabled:  { text: '已禁用', cls: 'badge-muted' },
};

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'windsurf', label: 'Windsurf' },
  { key: 'codex', label: 'Codex' },
  { key: 'api_keys', label: 'API Keys' },
];

class PoolManager {
  constructor() {
    this.currentFilter = 'all';
    this.poolAccounts = [];
    /** @type {Set<number>} Selected account IDs for batch operations */
    this.selectedAccounts = new Set();
    this.batchBindInProgress = false;
  }

  init() {
    this._setupEventListeners();
    this.render();
  }

  // ---- Real-time event listeners from main process ----

  _setupEventListeners() {
    // Pool status changed — refresh UI when accounts transition state
    window.ipcRenderer.on('pool-status-changed', (_event, data) => {
      console.log('[Pool] Status changed:', data);
      this.render();
    });

    // Token refreshed — refresh UI to show updated credentials
    window.ipcRenderer.on('pool-token-refreshed', (_event, data) => {
      console.log('[Pool] Token refreshed:', data);
      this.render();
    });

    // Pool sync complete — refresh UI after bulk sync
    window.ipcRenderer.on('pool-sync-complete', (_event, data) => {
      console.log('[Pool] Sync complete:', data);
      this.render();
    });

    // Auto-bind card trigger from main process (fallback for IPC-based binding)
    window.ipcRenderer.on('trigger-auto-bind-card', (_event, data) => {
      if (data && data.email) {
        if (typeof window.startAutoBindCardForEmail === 'function') {
          window.startAutoBindCardForEmail(data.email);
        } else if (window.AutoBindCard && typeof window.AutoBindCard.startAutoBindCardForEmail === 'function') {
          window.AutoBindCard.startAutoBindCardForEmail(data.email);
        } else {
          console.warn('[Pool] No auto-bind-card handler available for email:', data.email);
        }
      }
    });
  }

  // ---- Data fetching ----

  async _fetchAccounts() {
    const filter = this.currentFilter === 'all' || this.currentFilter === 'api_keys'
      ? undefined
      : this.currentFilter;
    const r = await window.ipcRenderer.invoke('pool-get-accounts', { provider_type: filter });
    if (!r.success) { console.error('pool-get-accounts failed:', r.error); return []; }
    let accounts = r.data || [];
    if (this.currentFilter === 'api_keys') {
      accounts = accounts.filter(a => a.provider_type !== 'windsurf' && a.provider_type !== 'codex');
    }
    return accounts;
  }

  // ---- Rendering ----

  async render() {
    const accounts = await this._fetchAccounts();
    this.poolAccounts = accounts;
    const container = document.getElementById('pool');
    if (!container) return;

    this._renderStats(accounts);
    this._renderFilterBar();
    this._renderAccountGrid(accounts);
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  _renderStats(accounts) {
    const el = document.getElementById('pool-stats');
    if (!el) return;
    const counts = { total: accounts.length, available: 0, in_use: 0, error: 0, cooldown: 0, disabled: 0 };
    accounts.forEach(a => { if (counts[a.status] !== undefined) counts[a.status]++; });
    const statsHtml = [
      { label: '总计', count: counts.total },
      { label: '可用', count: counts.available },
      { label: '使用中', count: counts.in_use },
      { label: '异常', count: counts.error },
      { label: '冷却中', count: counts.cooldown },
      { label: '已禁用', count: counts.disabled },
    ].map(s => `<div class="pool-stat-chip"><span class="stat-count">${s.count}</span><span>${s.label}</span></div>`).join('');
    const recoverBtn = (counts.error + counts.cooldown > 0)
      ? '<button class="pool-action-btn btn-add" id="poolRecoverBtn" style="margin-left:auto;"><i data-lucide="heart-pulse" style="width:14px;height:14px;margin-right:4px;"></i>恢复检查</button>'
      : '';
    el.innerHTML = statsHtml + recoverBtn;
    const recoverEl = document.getElementById('poolRecoverBtn');
    if (recoverEl) recoverEl.addEventListener('click', async () => {
      recoverEl.disabled = true;
      recoverEl.textContent = '检查中...';
      try {
        const r = await window.ipcRenderer.invoke('pool-recover-accounts');
        if (r.success) {
          const d = r.data;
          const parts = [];
          if (d.recovered.length) parts.push(`恢复 ${d.recovered.length} 个`);
          if (d.disabled.length) parts.push(`禁用 ${d.disabled.length} 个`);
          if (d.skipped.length) parts.push(`跳过 ${d.skipped.length} 个`);
          if (window.showCustomAlert) window.showCustomAlert(parts.join(', ') || '无需恢复', 'success');
          this.render();
        }
      } finally {
        recoverEl.disabled = false;
        recoverEl.innerHTML = '<i data-lucide="heart-pulse" style="width:14px;height:14px;margin-right:4px;"></i>恢复检查';
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    });
  }

  _renderFilterBar() {
    const el = document.getElementById('pool-filter-bar');
    if (!el) return;
    const buttons = FILTERS.map(f =>
      `<button class="pool-filter-btn${f.key === this.currentFilter ? ' active' : ''}" data-filter="${f.key}">${f.label}</button>`
    ).join('');
    const batchBindBtn = '<button class="pool-action-btn btn-add" id="poolBatchBindBtn"><i data-lucide="credit-card" style="width:14px;height:14px;margin-right:4px;"></i>批量绑卡</button>';
    const selectAllBtn = '<button class="pool-action-btn btn-add" id="poolSelectAllBtn" style="font-size:12px;"><i data-lucide="check-square" style="width:14px;height:14px;margin-right:4px;"></i>全选可用</button>';
    const importBtn = '<button class="pool-action-btn btn-add" id="poolImportBtn"><i data-lucide="upload" style="width:14px;height:14px;margin-right:4px;"></i>导入账号</button>';
    const addBtn = '<button class="pool-action-btn btn-add" id="poolAddApiKeyBtn"><i data-lucide="plus" style="width:14px;height:14px;margin-right:4px;"></i>添加 API Key</button>';
    const syncBtn = '<button class="pool-action-btn btn-add" id="poolSyncBtn"><i data-lucide="refresh-cw" style="width:14px;height:14px;margin-right:4px;"></i>同步到网关</button>';
    const legacySyncBtn = '<button class="pool-action-btn btn-add" id="poolLegacySyncBtn"><i data-lucide="git-merge" style="width:14px;height:14px;margin-right:4px;"></i>同步旧池</button>';
    el.innerHTML = buttons + '<div style="flex:1"></div>' + selectAllBtn + batchBindBtn + importBtn + addBtn + legacySyncBtn + syncBtn;
    el.querySelectorAll('.pool-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentFilter = btn.dataset.filter;
        this.render();
      });
    });
    const addBtnEl = document.getElementById('poolAddApiKeyBtn');
    if (addBtnEl) addBtnEl.addEventListener('click', () => this.showAddApiKeyModal());
    const syncBtnEl = document.getElementById('poolSyncBtn');
    if (syncBtnEl) syncBtnEl.addEventListener('click', async () => {
      syncBtnEl.disabled = true;
      syncBtnEl.textContent = '同步中...';
      try {
        const r = await window.ipcRenderer.invoke('pool-sync-channels');
        if (r.success) {
          const d = r.data;
          if (window.showCustomAlert) window.showCustomAlert(`已同步: 新建 ${d.created}, 更新 ${d.updated}, 清理 ${d.removed}`, 'success');
        } else if (window.showCustomAlert) {
          window.showCustomAlert(r.error || '同步失败', 'error');
        }
      } catch (e) { console.error('Pool sync failed:', e); }
      finally {
        syncBtnEl.disabled = false;
        syncBtnEl.innerHTML = '<i data-lucide="refresh-cw" style="width:14px;height:14px;margin-right:4px;"></i>同步到网关';
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    });

    // Legacy pool sync button
    const legacySyncBtnEl = document.getElementById('poolLegacySyncBtn');
    if (legacySyncBtnEl) legacySyncBtnEl.addEventListener('click', async () => {
      legacySyncBtnEl.disabled = true;
      legacySyncBtnEl.textContent = '同步中...';
      try {
        const r = await window.ipcRenderer.invoke('pool-sync-legacy-codex');
        if (r.success) {
          const d = r.data;
          const msg = `旧池同步完成: 新增 ${d.synced}, 更新 ${d.updated}, 跳过 ${d.skipped} (共 ${d.total})`;
          if (window.showCustomAlert) window.showCustomAlert(msg, 'success');
          this.render();
        } else if (window.showCustomAlert) {
          window.showCustomAlert(r.error || '同步失败', 'error');
        }
      } catch (e) {
        console.error('Legacy pool sync failed:', e);
        if (window.showCustomAlert) window.showCustomAlert('同步旧池失败: ' + e.message, 'error');
      } finally {
        legacySyncBtnEl.disabled = false;
        legacySyncBtnEl.innerHTML = '<i data-lucide="git-merge" style="width:14px;height:14px;margin-right:4px;"></i>同步旧池';
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    });

    // Import accounts button
    const importBtnEl = document.getElementById('poolImportBtn');
    if (importBtnEl) importBtnEl.addEventListener('click', () => this.showImportModal());

    // Select all available windsurf accounts
    const selectAllEl = document.getElementById('poolSelectAllBtn');
    if (selectAllEl) selectAllEl.addEventListener('click', () => {
      const availableWindsurf = this.poolAccounts.filter(
        a => a.provider_type === 'windsurf' && a.status === 'available'
      );
      if (this.selectedAccounts.size === availableWindsurf.length && availableWindsurf.length > 0) {
        // Toggle off: deselect all
        this.selectedAccounts.clear();
      } else {
        // Select all available windsurf accounts
        this.selectedAccounts.clear();
        availableWindsurf.forEach(a => this.selectedAccounts.add(a.id));
      }
      this._renderAccountGrid(this.poolAccounts);
      if (typeof lucide !== 'undefined') lucide.createIcons();
    });

    // Batch card binding
    const batchBindEl = document.getElementById('poolBatchBindBtn');
    if (batchBindEl) batchBindEl.addEventListener('click', () => this._startBatchBind());
  }

  _renderAccountGrid(accounts) {
    const el = document.getElementById('pool-content');
    if (!el) return;
    if (accounts.length === 0) {
      el.innerHTML = '<div class="pool-empty">暂无账号</div>';
      return;
    }
    const grouped = new Map();
    accounts.forEach(a => {
      const key = a.provider_type || 'other';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(a);
    });
    let html = '';
    for (const [provider, items] of grouped) {
      html += `<div class="pool-group-heading">${PROVIDER_LABELS[provider] || provider}</div>`;
      items.forEach(a => { html += this._renderCard(a); });
    }
    el.innerHTML = html;
    this._bindCardActions(el);
  }

  /**
   * Decode a JWT payload without signature verification (browser-safe).
   * Returns the parsed payload object or {} on failure.
   */
  _decodeJwt(token) {
    if (!token) return {};
    try {
      const parts = token.split('.');
      if (parts.length < 2) return {};
      // atob works in browser context
      const raw = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(raw);
    } catch { return {}; }
  }

  /**
   * Build an HTML snippet showing the Codex token expiry state.
   * Color-coded: green (>24h), yellow (<24h), red (expired).
   * Returns empty string for non-Codex accounts or accounts without an access_token.
   */
  _renderTokenExpiry(account) {
    const isCodex = account.provider_type === 'codex' || account.provider_type === 'windsurf';
    if (!isCodex) return '';

    const creds = account.credentials || {};
    const accessToken = creds.access_token || creds.accessToken;
    if (!accessToken) return '';

    const payload = this._decodeJwt(accessToken);
    if (!payload.exp) return '';

    const expiresAt = payload.exp * 1000;
    const now = Date.now();
    const remainingMs = expiresAt - now;
    const remainingHours = remainingMs / 3600000;

    let colorCls, label;
    if (remainingMs <= 0) {
      colorCls = 'token-expired';
      label = 'Token 已过期';
    } else if (remainingHours < 24) {
      colorCls = 'token-expiring';
      const hrs = Math.floor(remainingHours);
      const mins = Math.floor((remainingMs % 3600000) / 60000);
      label = `Token ${hrs}h${mins}m`;
    } else {
      colorCls = 'token-valid';
      const days = Math.floor(remainingHours / 24);
      label = `Token ${days}d+`;
    }

    const expiryStr = new Date(expiresAt).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });

    return `<span class="badge ${colorCls}" title="过期: ${expiryStr}" style="font-size:10px;margin-left:4px;">${label}</span>`;
  }

  _renderCard(account) {
    const sc = STATUS_CONFIG[account.status] || STATUS_CONFIG.available;
    const name = account.display_name || account.email || `#${account.id}`;
    const email = account.display_name ? account.email : '';
    const health = account.health_score ?? 100;
    const healthCls = health > 70 ? 'health-good' : health > 40 ? 'health-warn' : 'health-bad';
    const lastUsed = account.last_used_at
      ? new Date(account.last_used_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '从未使用';
    const toggleBtn = account.status === 'disabled'
      ? `<button class="pool-action-btn btn-enable" data-action="enable" data-id="${account.id}">启用</button>`
      : `<button class="pool-action-btn btn-disable" data-action="disable" data-id="${account.id}">禁用</button>`;
    const sourceBadge = account.source === 'registration'
      ? '<span class="badge badge-muted" style="font-size:10px;margin-left:4px;">注册</span>'
      : '';
    const tokenExpiryBadge = this._renderTokenExpiry(account);
    const bindBtn = (account.provider_type === 'windsurf' && (account.status === 'available' || account.status === 'error'))
      ? `<button class="pool-action-btn btn-bind" data-action="bind" data-id="${account.id}" data-email="${this._esc(account.email || '')}">绑卡</button>`
      : '';
    // Refresh Token button for Codex accounts
    const isCodexLike = account.provider_type === 'codex' || account.provider_type === 'windsurf';
    const refreshBtn = isCodexLike
      ? `<button class="pool-action-btn btn-refresh-token" data-action="refresh-token" data-id="${account.id}">刷新Token</button>`
      : '';
    // Checkbox for batch selection (windsurf accounts only)
    const isWindsurf = account.provider_type === 'windsurf';
    const isChecked = this.selectedAccounts.has(account.id);
    const checkbox = isWindsurf
      ? `<input type="checkbox" class="pool-card-checkbox" data-select-id="${account.id}" ${isChecked ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer;margin-right:8px;flex-shrink:0;">`
      : '';
    return `
      <div class="pool-card${isChecked ? ' pool-card-selected' : ''}">
        <div class="pool-card-header">
          <div style="display:flex;align-items:center;">
            ${checkbox}
            <div>
              <div class="pool-card-name">${this._esc(name)}</div>
              ${email ? `<div class="pool-card-email">${this._esc(email)}</div>` : ''}
            </div>
          </div>
          <span class="badge ${sc.cls}">${sc.text}</span>${sourceBadge}${tokenExpiryBadge}
        </div>
        <div class="pool-health-label"><span>健康度</span><span>${health}</span></div>
        <div class="pool-health-bar"><div class="pool-health-fill ${healthCls}" style="width:${health}%"></div></div>
        <div class="pool-card-stats">
          <span>成功 ${account.success_count || 0}/${account.total_requests || 0}</span>
          <span>错误 ${account.error_count || 0}</span>
          <span>${lastUsed}</span>
        </div>
        <div class="pool-card-footer">
          ${toggleBtn}
          ${bindBtn}
          ${refreshBtn}
          <button class="pool-action-btn btn-delete" data-action="delete" data-id="${account.id}">删除</button>
        </div>
      </div>`;
  }

  _bindCardActions(container) {
    // Bind checkbox selection for batch operations
    container.querySelectorAll('.pool-card-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = parseInt(cb.dataset.selectId, 10);
        if (cb.checked) {
          this.selectedAccounts.add(id);
        } else {
          this.selectedAccounts.delete(id);
        }
        // Toggle selected style on the card
        const card = cb.closest('.pool-card');
        if (card) card.classList.toggle('pool-card-selected', cb.checked);
      });
    });

      container.querySelectorAll('.pool-action-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const id = parseInt(btn.dataset.id, 10);
        if (action === 'enable') await this.toggleAccountStatus(id, true);
        else if (action === 'disable') await this.toggleAccountStatus(id, false);
        else if (action === 'delete') await this.deleteAccount(id);
        else if (action === 'refresh-token') await this.refreshAccountToken(id, btn);
        else if (action === 'bind') {
          const email = btn.dataset.email;
          if (email && typeof window.startAutoBindCardForEmail === 'function') {
            await window.startAutoBindCardForEmail(email);
          } else if (email && window.switchView) {
            window.switchView('autoBindCard');
            if (window.AutoBindCard?.onViewSwitch) window.AutoBindCard.onViewSwitch();
          }
        }
      });
    });
  }

  // ---- Actions ----

  async toggleAccountStatus(accountId, enable) {
    const channel = enable ? 'pool-enable-account' : 'pool-disable-account';
    const r = await window.ipcRenderer.invoke(channel, accountId);
    if (r.success) this.render();
    else if (window.showCustomAlert) window.showCustomAlert(r.error || '操作失败', 'error');
  }

  async deleteAccount(accountId) {
    if (!confirm('确认删除此账号？')) return;
    const r = await window.ipcRenderer.invoke('pool-delete-account', accountId);
    if (r.success) this.render();
    else if (window.showCustomAlert) window.showCustomAlert(r.error || '删除失败', 'error');
  }

  async refreshAccountToken(accountId, btnEl) {
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = '刷新中...';
    }
    try {
      const r = await window.ipcRenderer.invoke('pool-refresh-account-token', accountId);
      if (r.success) {
        if (window.showCustomAlert) window.showCustomAlert('Token 刷新成功', 'success');
        this.render();
      } else {
        if (window.showCustomAlert) window.showCustomAlert(r.error || 'Token 刷新失败', 'error');
      }
    } catch (e) {
      console.error('Token refresh failed:', e);
      if (window.showCustomAlert) window.showCustomAlert('Token 刷新异常', 'error');
    } finally {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = '刷新Token';
      }
    }
  }

  async addApiKey(providerType, apiKey, baseUrl, displayName) {
    if (!apiKey || apiKey.trim() === '') {
      if (window.showCustomAlert) window.showCustomAlert('API Key 不能为空', 'warning');
      return;
    }
    if (!providerType) {
      if (window.showCustomAlert) window.showCustomAlert('请选择供应商', 'warning');
      return;
    }
    const r = await window.ipcRenderer.invoke('pool-add-api-key', providerType, apiKey, baseUrl, displayName);
    if (r.success) {
      this._closeModal();
      this.render();
    } else if (window.showCustomAlert) {
      window.showCustomAlert(r.error || '添加失败', 'error');
    }
  }

  // ---- Batch Card Binding (CARD-01) ----

  async _startBatchBind() {
    if (this.batchBindInProgress) {
      if (window.showCustomAlert) window.showCustomAlert('批量绑卡正在进行中，请等待完成', 'warning');
      return;
    }

    // Collect selected accounts that are windsurf + available
    const selected = this.poolAccounts.filter(
      a => this.selectedAccounts.has(a.id) && a.provider_type === 'windsurf' && a.status === 'available'
    );

    if (selected.length === 0) {
      if (window.showCustomAlert) window.showCustomAlert('请先勾选状态为"可用"的 Windsurf 账号', 'warning');
      return;
    }

    if (!confirm(`确认为 ${selected.length} 个账号批量绑卡？将依次处理每个账号。`)) return;

    this.batchBindInProgress = true;
    let successCount = 0;
    let failCount = 0;

    for (const account of selected) {
      try {
        if (window.showCustomAlert) {
          window.showCustomAlert(`正在绑卡: ${account.email} (${successCount + failCount + 1}/${selected.length})`, 'info');
        }

        // Trigger the card binding flow for this email
        let bindResult = { success: false };
        if (typeof window.startAutoBindCardForEmail === 'function') {
          bindResult = await window.startAutoBindCardForEmail(account.email);
        } else if (window.AutoBindCard && typeof window.AutoBindCard.startAutoBindCardForEmail === 'function') {
          bindResult = await window.AutoBindCard.startAutoBindCardForEmail(account.email);
        } else {
          // Fallback: invoke the IPC directly if available
          bindResult = await window.ipcRenderer.invoke('auto-bind-card', { email: account.email });
        }

        if (bindResult && bindResult.success !== false) {
          // CARD-02: Properly transition pool status after binding
          await window.ipcRenderer.invoke('pool-after-card-bind', {
            accountId: account.id,
            tags: ['card-bound'],
          });
          successCount++;
        } else {
          failCount++;
          // CARD-03: Enqueue failed binding to retry queue
          await window.ipcRenderer.invoke('card-binding-retry-enqueue', {
            id: account.id,
            email: account.email,
            error: (bindResult && bindResult.error) || 'Bind failed',
          });
        }
      } catch (err) {
        console.error(`[批量绑卡] ${account.email} 失败:`, err);
        failCount++;
        // CARD-03: Enqueue failed binding to retry queue
        try {
          await window.ipcRenderer.invoke('card-binding-retry-enqueue', {
            id: account.id,
            email: account.email,
            error: err.message || String(err),
          });
        } catch (enqueueErr) {
          console.error('[重试队列入队失败]', enqueueErr);
        }
      }
    }

    this.batchBindInProgress = false;
    this.selectedAccounts.clear();

    const msg = `批量绑卡完成: 成功 ${successCount}, 失败 ${failCount}`;
    if (window.showCustomAlert) {
      window.showCustomAlert(msg, failCount > 0 ? 'warning' : 'success');
    }

    // Refresh the pool view
    this.render();
  }

  // ---- Modal ----

  showAddApiKeyModal() {
    const overlay = document.createElement('div');
    overlay.className = 'pool-modal-overlay';
    overlay.id = 'poolModalOverlay';
    const providerOptions = Object.entries(PROVIDER_LABELS)
      .filter(([k]) => k !== 'windsurf' && k !== 'codex')
      .map(([k, v]) => `<option value="${k}">${v}</option>`)
      .join('');
    overlay.innerHTML = `
      <div class="pool-modal">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div class="pool-modal-title">添加 API Key</div>
          <button id="poolModalClose" style="background:none;border:none;color:var(--text-secondary,#94a3b8);cursor:pointer;padding:4px;">
            <i data-lucide="x" style="width:18px;height:18px;"></i>
          </button>
        </div>
        <div class="pool-modal-field">
          <label class="pool-modal-label">供应商 *</label>
          <select id="poolApiKeyProvider" class="pool-modal-input pool-modal-select">${providerOptions}</select>
        </div>
        <div class="pool-modal-field">
          <label class="pool-modal-label">API Key *</label>
          <input type="password" id="poolApiKeyInput" class="pool-modal-input" placeholder="sk-..." autocomplete="off">
        </div>
        <div class="pool-modal-field">
          <label class="pool-modal-label">Base URL (可选)</label>
          <input type="text" id="poolApiBaseUrl" class="pool-modal-input" placeholder="https://api.openai.com/v1">
        </div>
        <div class="pool-modal-field">
          <label class="pool-modal-label">显示名称 (可选)</label>
          <input type="text" id="poolApiDisplayName" class="pool-modal-input" placeholder="My API Key">
        </div>
        <div class="pool-modal-actions">
          <button id="poolModalCancel" class="pool-modal-btn pool-modal-btn-cancel">取消</button>
          <button id="poolModalSubmit" class="pool-modal-btn pool-modal-btn-primary">添加</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    if (typeof lucide !== 'undefined') lucide.createIcons();

    overlay.querySelector('#poolModalClose').addEventListener('click', () => this._closeModal());
    overlay.querySelector('#poolModalCancel').addEventListener('click', () => this._closeModal());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this._closeModal(); });
    overlay.querySelector('#poolModalSubmit').addEventListener('click', () => {
      this.addApiKey(
        document.getElementById('poolApiKeyProvider').value,
        document.getElementById('poolApiKeyInput').value,
        document.getElementById('poolApiBaseUrl').value,
        document.getElementById('poolApiDisplayName').value,
      );
    });
  }

  showImportModal() {
    const overlay = document.createElement('div');
    overlay.className = 'pool-modal-overlay';
    overlay.id = 'poolModalOverlay';
    overlay.innerHTML = `
      <div class="pool-modal">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div class="pool-modal-title">导入账号</div>
          <button id="poolModalClose" style="background:none;border:none;color:var(--text-secondary,#94a3b8);cursor:pointer;padding:4px;">
            <i data-lucide="x" style="width:18px;height:18px;"></i>
          </button>
        </div>
        <div class="pool-modal-field">
          <label class="pool-modal-label">导入目录</label>
          <input type="text" id="poolImportDir" class="pool-modal-input" value="账号管理/codex" placeholder="账号管理/codex">
          <div style="font-size:11px;color:var(--text-secondary,#94a3b8);margin-top:4px;">
            输入包含账号 JSON 文件的目录路径（相对于项目根目录或绝对路径）
          </div>
        </div>
        <div class="pool-modal-field">
          <label class="pool-modal-label">导入模式</label>
          <select id="poolImportMode" class="pool-modal-input pool-modal-select">
            <option value="codex">Codex 账号（固定 provider_type=codex）</option>
            <option value="auto">自动检测（根据文件内 type 字段判断）</option>
          </select>
        </div>
        <div id="poolImportResult" style="display:none;margin-top:12px;padding:10px;border-radius:6px;background:var(--bg-tertiary,#1e293b);font-size:12px;line-height:1.6;"></div>
        <div class="pool-modal-actions">
          <button id="poolModalCancel" class="pool-modal-btn pool-modal-btn-cancel">取消</button>
          <button id="poolImportSubmit" class="pool-modal-btn pool-modal-btn-primary">开始导入</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    if (typeof lucide !== 'undefined') lucide.createIcons();

    overlay.querySelector('#poolModalClose').addEventListener('click', () => this._closeModal());
    overlay.querySelector('#poolModalCancel').addEventListener('click', () => this._closeModal());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this._closeModal(); });

    overlay.querySelector('#poolImportSubmit').addEventListener('click', async () => {
      const dirInput = document.getElementById('poolImportDir');
      const modeSelect = document.getElementById('poolImportMode');
      const resultEl = document.getElementById('poolImportResult');
      const submitBtn = document.getElementById('poolImportSubmit');
      const directory = dirInput.value.trim();
      const mode = modeSelect.value;

      if (!directory) {
        if (window.showCustomAlert) window.showCustomAlert('请输入目录路径', 'warning');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '导入中...';
      resultEl.style.display = 'block';
      resultEl.textContent = '正在读取文件并导入，请稍候...';

      try {
        const channel = mode === 'codex' ? 'pool-bulk-import-codex' : 'pool-bulk-import-directory';
        const r = await window.ipcRenderer.invoke(channel, { directory });

        if (r.success) {
          const d = r.data;
          let html = `<div style="font-weight:600;margin-bottom:6px;">导入完成</div>`;
          html += `<div>总计: ${d.total} 个文件</div>`;
          html += `<div style="color:#22c55e;">已导入: ${d.imported}</div>`;
          html += `<div style="color:#f59e0b;">已跳过（重复）: ${d.skipped}</div>`;
          if (d.failed > 0) {
            html += `<div style="color:#ef4444;">失败: ${d.failed}</div>`;
          }
          resultEl.innerHTML = html;

          // Show toast
          const msg = `导入完成: 导入 ${d.imported}, 跳过 ${d.skipped}, 失败 ${d.failed}`;
          if (window.showCustomAlert) {
            window.showCustomAlert(msg, d.failed > 0 ? 'warning' : 'success');
          }

          // Refresh pool view
          this.render();
        } else {
          resultEl.innerHTML = `<div style="color:#ef4444;">导入失败: ${r.error}</div>`;
          if (window.showCustomAlert) window.showCustomAlert(r.error || '导入失败', 'error');
        }
      } catch (err) {
        resultEl.innerHTML = `<div style="color:#ef4444;">导入异常: ${err.message}</div>`;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '开始导入';
      }
    });
  }

  _closeModal() {
    const overlay = document.getElementById('poolModalOverlay');
    if (overlay) overlay.remove();
  }

  // ---- Helpers ----

  _esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}

module.exports = {
  PoolManager,
  windowExports: { PoolManager },
};
