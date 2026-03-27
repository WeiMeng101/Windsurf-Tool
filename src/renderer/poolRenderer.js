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
  }

  init() {
    this.render();
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
    el.innerHTML = [
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
    }.bind(this));
  }

  _renderFilterBar() {
    const el = document.getElementById('pool-filter-bar');
    if (!el) return;
    const buttons = FILTERS.map(f =>
      `<button class="pool-filter-btn${f.key === this.currentFilter ? ' active' : ''}" data-filter="${f.key}">${f.label}</button>`
    ).join('');
    const addBtn = '<button class="pool-action-btn btn-add" id="poolAddApiKeyBtn"><i data-lucide="plus" style="width:14px;height:14px;margin-right:4px;"></i>添加 API Key</button>';
    const syncBtn = '<button class="pool-action-btn btn-add" id="poolSyncBtn"><i data-lucide="refresh-cw" style="width:14px;height:14px;margin-right:4px;"></i>同步到网关</button>';
    el.innerHTML = buttons + '<div style="flex:1"></div>' + addBtn + syncBtn;
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
    const bindBtn = (account.provider_type === 'windsurf' && (account.status === 'available' || account.status === 'error'))
      ? `<button class="pool-action-btn btn-bind" data-action="bind" data-id="${account.id}" data-email="${this._esc(account.email || '')}">绑卡</button>`
      : '';
    return `
      <div class="pool-card">
        <div class="pool-card-header">
          <div>
            <div class="pool-card-name">${this._esc(name)}</div>
            ${email ? `<div class="pool-card-email">${this._esc(email)}</div>` : ''}
          </div>
          <span class="badge ${sc.cls}">${sc.text}</span>${sourceBadge}
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
          <button class="pool-action-btn btn-delete" data-action="delete" data-id="${account.id}">删除</button>
        </div>
      </div>`;
  }

  _bindCardActions(container) {
    container.querySelectorAll('.pool-action-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const id = parseInt(btn.dataset.id, 10);
        if (action === 'enable') await this.toggleAccountStatus(id, 'disabled');
        else if (action === 'disable') await this.toggleAccountStatus(id, 'active');
        else if (action === 'delete') await this.deleteAccount(id);
        else if (action === 'bind') {
          const email = btn.dataset.email;
          if (email && window.switchView) { window.switchView('autoBindCard'); if (window.AutoBindCard?.onViewSwitch) window.AutoBindCard.onViewSwitch(); }
        }
      });
    });
  }

  // ---- Actions ----

  async toggleAccountStatus(accountId, currentStatus) {
    const channel = currentStatus === 'disabled' ? 'pool-enable-account' : 'pool-disable-account';
    const r = await window.ipcRenderer.invoke(channel, { accountId });
    if (r.success) this.render();
    else if (window.showCustomAlert) window.showCustomAlert(r.error || '操作失败', 'error');
  }

  async deleteAccount(accountId) {
    if (!confirm('确认删除此账号？')) return;
    const r = await window.ipcRenderer.invoke('pool-delete-account', { accountId });
    if (r.success) this.render();
    else if (window.showCustomAlert) window.showCustomAlert(r.error || '删除失败', 'error');
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
    const r = await window.ipcRenderer.invoke('pool-add-api-key', { providerType, apiKey, baseUrl, displayName });
    if (r.success) {
      this._closeModal();
      this.render();
    } else if (window.showCustomAlert) {
      window.showCustomAlert(r.error || '添加失败', 'error');
    }
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
