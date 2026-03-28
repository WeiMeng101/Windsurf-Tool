'use strict';

class DashboardManager {
  constructor() {
    this.poolStats = this._createEmptyPoolStats();
    this.gatewayStats = this._createEmptyGatewayStats();
    this.gatewayMetrics = this._createEmptyGatewayMetrics();
    this.accounts = [];
    // REG-05: Registration status tracking
    this.registrationStatus = this._createEmptyRegistrationStatus();
    this._registrationListenersAttached = false;
  }

  init() {
    this._setupRegistrationListeners();
    this.render();
  }

  // REG-05: Create empty registration status state
  _createEmptyRegistrationStatus() {
    return {
      windsurf: { running: false, total: 0, current: 0, success: 0, failed: 0, lastTimestamp: null },
      codex: { running: false, total: 0, current: 0, success: 0, failed: 0, lastTimestamp: null },
    };
  }

  // REG-05: Set up IPC listeners for registration progress events
  _setupRegistrationListeners() {
    if (this._registrationListenersAttached) return;
    this._registrationListenersAttached = true;

    // Windsurf registration progress
    window.ipcRenderer.on('registration-progress', (_event, progress) => {
      if (!progress) return;
      const ws = this.registrationStatus.windsurf;
      ws.running = true;
      ws.total = progress.total || ws.total;
      ws.current = progress.current || ws.current;
      ws.success = progress.success || 0;
      ws.failed = progress.failed || 0;
      ws.lastTimestamp = new Date().toISOString();
      // Mark as finished when current reaches total
      if (ws.current >= ws.total && ws.total > 0) {
        ws.running = false;
      }
      this._rerenderRegistrationStatus();
    });

    // Codex registration progress
    window.ipcRenderer.on('codex-registration-progress', (_event, progress) => {
      if (!progress) return;
      const cx = this.registrationStatus.codex;
      cx.running = true;
      cx.total = progress.total || cx.total;
      cx.current = progress.current || cx.current;
      cx.success = progress.success || 0;
      cx.failed = progress.failed || 0;
      cx.lastTimestamp = new Date().toISOString();
      if (cx.current >= cx.total && cx.total > 0) {
        cx.running = false;
      }
      this._rerenderRegistrationStatus();
    });
  }

  // REG-05: Re-render only the registration status section (lightweight update)
  _rerenderRegistrationStatus() {
    const el = document.getElementById('dash-registration-status');
    if (!el) return;
    el.innerHTML = this._renderRegistrationStatusContent();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  async render() {
    await Promise.allSettled([
      this._fetchPoolStats(),
      this._fetchGatewayStatus(),
    ]);
    // Gateway metrics depend on knowing the port/running state
    await this._loadGatewayMetrics();
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

  _createEmptyGatewayMetrics() {
    return {
      totalRequests: 0,
      successRate: '0.0',
      avgLatencyMs: 0,
      available: false,
    };
  }

  async _fetchPoolStats() {
    try {
      const r = await window.ipcRenderer.invoke('pool-get-accounts', {});
      if (r.success) {
        const accounts = Array.isArray(r.data) ? r.data : [];
        this.accounts = accounts;
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
        this.accounts = [];
      }
    } catch (e) {
      console.error('Dashboard pool fetch failed:', e);
      this.poolStats = this._createEmptyPoolStats();
      this.accounts = [];
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

  /** DASH-02: Load gateway traffic metrics from /api/admin/dashboard/stats */
  async _loadGatewayMetrics() {
    const metrics = this._createEmptyGatewayMetrics();
    try {
      const g = this.gatewayStats || this._createEmptyGatewayStats();
      if (!g.running || !g.port) {
        this.gatewayMetrics = metrics;
        return;
      }
      const baseUrl = `http://127.0.0.1:${g.port}`;
      const stats = await this._fetchJson(`${baseUrl}/api/admin/dashboard/stats`);
      if (stats && stats.data) {
        metrics.totalRequests = stats.data.total_requests ?? 0;
        metrics.successRate = stats.data.success_rate ?? '0.0';
        metrics.avgLatencyMs = stats.data.avg_latency_ms ?? 0;
        metrics.available = true;
      }
    } catch (e) {
      console.error('Dashboard gateway metrics fetch failed:', e);
    }
    this.gatewayMetrics = metrics;
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

  /** DASH-03: Render a CSS horizontal bar chart for status distribution */
  _renderStatusDistribution(accounts) {
    if (!accounts || accounts.length === 0) {
      return '<div class="dash-empty-state">暂无账号数据</div>';
    }

    const statusConfig = [
      { key: 'available', label: '可用',   color: '#22c55e' },
      { key: 'in_use',    label: '使用中', color: '#3b82f6' },
      { key: 'error',     label: '异常',   color: '#ef4444' },
      { key: 'cooldown',  label: '冷却中', color: '#f59e0b' },
      { key: 'disabled',  label: '已禁用', color: '#64748b' },
    ];

    const total = accounts.length;
    const counts = {};
    for (const cfg of statusConfig) {
      counts[cfg.key] = accounts.filter(a => a.status === cfg.key).length;
    }

    const segments = statusConfig
      .filter(cfg => counts[cfg.key] > 0)
      .map(cfg => {
        const pct = (counts[cfg.key] / total * 100).toFixed(1);
        return `<div class="status-segment" style="flex:${counts[cfg.key]};background:${cfg.color}" title="${cfg.label}: ${counts[cfg.key]} (${pct}%)"></div>`;
      })
      .join('');

    const legend = statusConfig
      .filter(cfg => counts[cfg.key] > 0)
      .map(cfg => {
        const pct = (counts[cfg.key] / total * 100).toFixed(1);
        return `<span class="status-legend-item"><span class="status-legend-dot" style="background:${cfg.color}"></span>${cfg.label} ${counts[cfg.key]} <span class="status-legend-pct">(${pct}%)</span></span>`;
      })
      .join('');

    return `
      <div class="status-bar">${segments}</div>
      <div class="status-legend">${legend}</div>
    `;
  }

  /** DASH-03: Render a CSS horizontal bar chart for provider distribution */
  _renderProviderDistribution(accounts) {
    if (!accounts || accounts.length === 0) {
      return '<div class="dash-empty-state">暂无账号数据</div>';
    }

    const providerColors = {
      windsurf:    '#38bdf8',
      codex:       '#a78bfa',
      openai:      '#10b981',
      anthropic:   '#f97316',
      gemini:      '#eab308',
      deepseek:    '#06b6d4',
      moonshot:    '#ec4899',
      doubao:      '#f43f5e',
      zhipu:       '#8b5cf6',
      openrouter:  '#14b8a6',
      xai:         '#6366f1',
      siliconflow: '#84cc16',
      ppio:        '#d946ef',
      claudecode:  '#fb923c',
      other:       '#94a3b8',
    };

    // Group by provider
    const grouped = {};
    for (const a of accounts) {
      const p = a.provider_type || 'other';
      grouped[p] = (grouped[p] || 0) + 1;
    }

    // Sort by count descending
    const sorted = Object.entries(grouped).sort((a, b) => b[1] - a[1]);
    const total = accounts.length;

    const bars = sorted.map(([provider, count]) => {
      const pct = (count / total * 100).toFixed(1);
      const color = providerColors[provider] || '#94a3b8';
      return `
        <div class="provider-chart-row">
          <span class="provider-chart-label">${this._esc(provider)}</span>
          <div class="provider-chart-track">
            <div class="provider-chart-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <span class="provider-chart-count">${count} <span class="provider-chart-pct">(${pct}%)</span></span>
        </div>
      `;
    }).join('');

    return `<div class="provider-chart">${bars}</div>`;
  }

  // REG-05: Render the registration status section HTML wrapper
  _renderRegistrationStatus() {
    return `
      <div class="dash-section">
        <div class="section-heading tight">
          <div>
            <h2>注册状态</h2>
            <p>Windsurf 和 Codex 批量注册任务的实时进度与统计。</p>
          </div>
        </div>
        <div id="dash-registration-status">
          ${this._renderRegistrationStatusContent()}
        </div>
      </div>
    `;
  }

  // REG-05: Render inner content of the registration status section
  _renderRegistrationStatusContent() {
    const ws = this.registrationStatus.windsurf;
    const cx = this.registrationStatus.codex;
    const anyRunning = ws.running || cx.running;
    const anyHasData = ws.lastTimestamp || cx.lastTimestamp;

    if (!anyRunning && !anyHasData) {
      return '<div class="dash-empty-state">无进行中的注册</div>';
    }

    const totalRunning = (ws.running ? 1 : 0) + (cx.running ? 1 : 0);
    const totalSuccess = ws.success + cx.success;
    const totalFailed = ws.failed + cx.failed;

    // Summary cards row
    const summaryCards = `
      <div class="dash-grid dash-grid-reg">
        ${this._statCard('进行中', totalRunning, anyRunning ? '#22c55e' : '#64748b')}
        ${this._statCard('成功', totalSuccess, totalSuccess > 0 ? '#22c55e' : '#64748b')}
        ${this._statCard('失败', totalFailed, totalFailed > 0 ? '#ef4444' : '#64748b')}
      </div>
    `;

    // Per-provider detail rows
    const providers = [
      { key: 'windsurf', label: 'Windsurf', data: ws, color: '#38bdf8' },
      { key: 'codex', label: 'Codex', data: cx, color: '#a78bfa' },
    ];

    const rows = providers
      .filter(p => p.data.running || p.data.lastTimestamp)
      .map(p => {
        const d = p.data;
        const pct = d.total > 0 ? Math.round((d.current / d.total) * 100) : 0;
        const statusBadge = d.running
          ? '<span class="dash-reg-badge dash-reg-badge-running">运行中</span>'
          : '<span class="dash-reg-badge dash-reg-badge-done">已完成</span>';
        const timeStr = d.lastTimestamp ? this._formatTime(d.lastTimestamp) : '--';

        return `
          <div class="dash-reg-row">
            <div class="dash-reg-row-header">
              <span class="dash-reg-provider" style="color:${p.color}">${p.label}</span>
              ${statusBadge}
            </div>
            <div class="dash-reg-progress-track">
              <div class="dash-reg-progress-fill" style="width:${pct}%;background:${p.color}"></div>
            </div>
            <div class="dash-reg-row-stats">
              <span>进度 ${d.current}/${d.total} (${pct}%)</span>
              <span>成功 ${d.success}</span>
              <span>失败 ${d.failed}</span>
              <span>更新 ${timeStr}</span>
            </div>
          </div>
        `;
      })
      .join('');

    return `${summaryCards}<div class="dash-reg-details">${rows}</div>`;
  }

  _renderContent() {
    const el = document.getElementById('dashboard-content');
    if (!el) return;

    const s = this.poolStats || this._createEmptyPoolStats();
    const g = this.gatewayStats || this._createEmptyGatewayStats();
    const m = this.gatewayMetrics || this._createEmptyGatewayMetrics();
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
            <h2>状态分布</h2>
            <p>账号池中各状态的比例分布，直观展示资源使用情况。</p>
          </div>
          <span class="section-tag">${s.total} 个账号</span>
        </div>
        ${this._renderStatusDistribution(this.accounts)}
      </div>

      <div class="dash-section">
        <div class="section-heading tight">
          <div>
            <h2>供应商分布</h2>
            <p>按供应商类型分组的账号数量，了解各平台的资源配置。</p>
          </div>
          <span class="section-tag">${Object.keys(this.accounts.reduce((m, a) => { m[a.provider_type || 'other'] = 1; return m; }, {})).length} 个供应商</span>
        </div>
        ${this._renderProviderDistribution(this.accounts)}
      </div>

      ${this._renderRegistrationStatus()}

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
        <div class="dash-subsection-heading">流量指标 (24h)</div>
        ${m.available
          ? `<div class="dash-grid dash-grid-gateway">
              ${this._statCard('请求总量', m.totalRequests, '#38bdf8')}
              ${this._statCard('成功率', m.successRate + '%', parseFloat(m.successRate) >= 90 ? '#22c55e' : parseFloat(m.successRate) >= 70 ? '#f59e0b' : '#ef4444')}
              ${this._statCard('平均延迟', m.avgLatencyMs + ' ms', m.avgLatencyMs <= 1000 ? '#22c55e' : m.avgLatencyMs <= 3000 ? '#f59e0b' : '#ef4444')}
            </div>`
          : '<div class="dash-empty-state">网关未运行或无数据</div>'}
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
