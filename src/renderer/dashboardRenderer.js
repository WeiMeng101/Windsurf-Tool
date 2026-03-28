'use strict';

class DashboardManager {
  constructor() {
    this.poolStats = this._createEmptyPoolStats();
    this.gatewayStats = this._createEmptyGatewayStats();
  }

  init() {
    this.render();
  }

  async render() {
    await Promise.allSettled([this._fetchPoolStats(), this._fetchGatewayStatus()]);
    this._renderContent();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  _createEmptyPoolStats() {
    return {
      total: 0,
      available: 0,
      inUse: 0,
      error: 0,
      cooldown: 0,
      disabled: 0,
      avgHealth: 100,
      errorAccounts: [],
    };
  }

  _createEmptyGatewayStats() {
    return {
      port: null,
      running: false,
      channelCount: 0,
      enabledChannels: 0,
    };
  }

  async _fetchPoolStats() {
    try {
      const r = await window.ipcRenderer.invoke('pool-get-accounts', {});
      if (r.success) {
        const accounts = Array.isArray(r.data) ? r.data : [];
        const errorAccounts = accounts
          .filter(a => a.status === 'error' || a.status === 'cooldown')
          .sort((a, b) => new Date(b.updated_at || b.last_used_at || 0) - new Date(a.updated_at || a.last_used_at || 0))
          .slice(0, 8);
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
          errorAccounts,
        };
      } else {
        this.poolStats = this._createEmptyPoolStats();
      }
    } catch (e) {
      console.error('Dashboard pool fetch failed:', e);
      this.poolStats = this._createEmptyPoolStats();
    }
  }

  async _fetchGatewayStatus() {
    const gatewayStats = this._createEmptyGatewayStats();
    try {
      const port = await window.ipcRenderer.invoke('get-gateway-port');
      gatewayStats.port = port || null;

      if (port) {
        const baseUrl = `http://127.0.0.1:${port}`;
        const health = await this._fetchJson(`${baseUrl}/health`);
        gatewayStats.running = health?.status === 'ok';

        if (gatewayStats.running) {
          const channels = await this._fetchJson(`${baseUrl}/api/admin/channels`);
          const channelList = Array.isArray(channels?.data) ? channels.data : [];
          gatewayStats.channelCount = channelList.length;
          gatewayStats.enabledChannels = channelList.filter(ch => ch.status === 'enabled').length;
        }
      }
    } catch (e) { console.error('Dashboard gateway fetch failed:', e); }
    this.gatewayStats = gatewayStats;
  }

  async _fetchJson(url) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  _renderContent() {
    const el = document.getElementById('dashboard-content');
    if (!el) return;

    const s = this.poolStats || this._createEmptyPoolStats();
    const g = this.gatewayStats || this._createEmptyGatewayStats();
    const gatewayBadgeClass = g.running ? 'running' : 'stopped';
    const gatewayBadgeText = g.running ? '运行中' : '已停止';

    el.innerHTML = `
      <div class="dash-section">
        <div class="section-heading tight">
          <div>
            <h2>账号池概览</h2>
            <p>来自 <code>pool-get-accounts</code> 的聚合视图，先判断规模和健康度，再进入具体工作区。</p>
          </div>
          <span class="section-tag">平均健康 ${s.avgHealth}</span>
        </div>
        <div class="dash-grid">
          ${this._statCard('总计', s.total, '#38bdf8')}
          ${this._statCard('可用', s.available, '#22c55e')}
          ${this._statCard('使用中', s.inUse, '#3b82f6')}
          ${this._statCard('异常', s.error, '#ef4444')}
          ${this._statCard('冷却中', s.cooldown, '#f59e0b')}
          ${this._statCard('已禁用', s.disabled, '#64748b')}
        </div>
        <div class="dash-health">
          平均健康度:
          <span class="dash-health-value ${s.avgHealth > 70 ? 'good' : s.avgHealth > 40 ? 'warn' : 'bad'}">${s.avgHealth}</span>
        </div>
      </div>

      <div class="dash-section">
        <div class="section-heading tight">
          <div>
            <h2>网关状态</h2>
            <p>通过 <code>get-gateway-port</code>、<code>/health</code> 和 <code>/api/admin/channels</code> 确认本地网关是否可用。</p>
          </div>
          <span class="dash-status-badge ${gatewayBadgeClass}">${gatewayBadgeText}</span>
        </div>
        <div class="dash-grid dash-grid-gateway">
          ${this._statCard('端口', g.port || '--', g.running ? '#22c55e' : '#64748b')}
          ${this._statCard('渠道总数', g.channelCount, '#38bdf8')}
          ${this._statCard('启用渠道', g.enabledChannels, '#22c55e')}
          ${this._statCard('健康检查', g.running ? 'OK' : '未响应', g.running ? '#22c55e' : '#ef4444')}
        </div>
      </div>

      <div class="dash-section">
        <div class="section-heading tight">
          <div>
            <h2>最近异常</h2>
            <p>聚合最近处于异常或冷却状态的账号，方便先处理最影响工作的账号。</p>
          </div>
          <span class="section-tag">${s.errorAccounts.length} 项</span>
        </div>
        <div class="dash-error-list">
          ${s.errorAccounts.length > 0
            ? s.errorAccounts.map(a => `
              <div class="dash-error-item">
                <div class="dash-error-head">
                  <div class="dash-error-name">${this._esc(a.display_name || a.email || `#${a.id}`)}</div>
                  <span class="badge ${a.status === 'error' ? 'badge-danger' : 'badge-warning'}">${a.status === 'error' ? '异常' : '冷却中'}</span>
                </div>
                <div class="dash-error-detail">${this._esc(a.last_error || '无错误信息')}</div>
                <div class="dash-error-meta">更新时间 ${this._formatTime(a.updated_at || a.last_used_at)}</div>
              </div>
            `).join('')
            : '<div class="dash-empty-state">当前没有异常或冷却中的账号，账号池处于正常状态。</div>'}
        </div>
      </div>
    `;
  }

  _statCard(label, value, color) {
    return `<div class="dash-stat-card"><div class="dash-stat-value" style="color:${color}">${value}</div><div class="dash-stat-label">${label}</div></div>`;
  }

  _formatTime(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
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
