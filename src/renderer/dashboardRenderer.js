'use strict';

class DashboardManager {
  constructor() {
    this.poolStats = null;
    this.gatewayPort = null;
  }

  init() {
    this.render();
  }

  async render() {
    await Promise.all([this._fetchPoolStats(), this._fetchGatewayStatus()]);
    this._renderContent();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  async _fetchPoolStats() {
    try {
      const r = await window.ipcRenderer.invoke('pool-get-accounts', {});
      if (r.success) {
        const accounts = r.data || [];
        this.poolStats = {
          total: accounts.length,
          available: accounts.filter(a => a.status === 'available').length,
          inUse: accounts.filter(a => a.status === 'in_use').length,
          error: accounts.filter(a => a.status === 'error').length,
          cooldown: accounts.filter(a => a.status === 'cooldown').length,
          disabled: accounts.filter(a => a.status === 'disabled').length,
          avgHealth: accounts.length
            ? Math.round(accounts.reduce((s, a) => s + (a.health_score ?? 100), 0) / accounts.length)
            : 100,
          errorAccounts: accounts.filter(a => a.status === 'error' || a.status === 'cooldown').slice(0, 10),
        };
      }
    } catch (e) { console.error('Dashboard pool fetch failed:', e); }
  }

  async _fetchGatewayStatus() {
    try {
      const r = await window.ipcRenderer.invoke('get-gateway-port');
      this.gatewayPort = r || null;
    } catch (e) { console.error('Dashboard gateway fetch failed:', e); }
  }

  _renderContent() {
    const el = document.getElementById('dashboard-content');
    if (!el) return;

    let html = '';

    // Pool overview
    if (this.poolStats) {
      const s = this.poolStats;
      html += `
        <div class="dash-section">
          <div class="dash-section-title"><i data-lucide="database" style="width:16px;height:16px;margin-right:6px;"></i>号池概览</div>
          <div class="dash-grid">
            ${this._statCard('总计', s.total, '#38bdf8')}
            ${this._statCard('可用', s.available, '#22c55e')}
            ${this._statCard('使用中', s.inUse, '#3b82f6')}
            ${this._statCard('异常', s.error, '#ef4444')}
            ${this._statCard('冷却中', s.cooldown, '#f59e0b')}
            ${this._statCard('已禁用', s.disabled, '#64748b')}
          </div>
          <div class="dash-health">平均健康度: <span class="dash-health-value ${s.avgHealth > 70 ? 'good' : s.avgHealth > 40 ? 'warn' : 'bad'}">${s.avgHealth}</span></div>
        </div>`;
    }

    // Gateway status
    html += `
      <div class="dash-section">
        <div class="dash-section-title"><i data-lucide="radio" style="width:16px;height:16px;margin-right:6px;"></i>网关状态</div>
        <div class="dash-grid">
          ${this._statCard('端口', this.gatewayPort || '未启动', this.gatewayPort ? '#22c55e' : '#64748b')}
        </div>
      </div>`;

    // Recent errors
    if (this.poolStats && this.poolStats.errorAccounts.length > 0) {
      html += `
        <div class="dash-section">
          <div class="dash-section-title"><i data-lucide="alert-triangle" style="width:16px;height:16px;margin-right:6px;"></i>异常账号</div>
          <div class="dash-error-list">
            ${this.poolStats.errorAccounts.map(a => `
              <div class="dash-error-item">
                <div class="dash-error-name">${this._esc(a.display_name || a.email || '#' + a.id)}</div>
                <span class="badge ${a.status === 'error' ? 'badge-danger' : 'badge-warning'}">${a.status === 'error' ? '异常' : '冷却中'}</span>
                <div class="dash-error-detail">${this._esc(a.last_error || '无错误信息')}</div>
              </div>
            `).join('')}
          </div>
        </div>`;
    }

    el.innerHTML = html;
  }

  _statCard(label, value, color) {
    return `<div class="dash-stat-card"><div class="dash-stat-value" style="color:${color}">${value}</div><div class="dash-stat-label">${label}</div></div>`;
  }

  _esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}

module.exports = {
  DashboardManager,
  windowExports: { DashboardManager },
};
