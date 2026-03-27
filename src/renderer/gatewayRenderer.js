'use strict';

/**
 * 网关管理器 - 全中文 UI，与主应用样式统一
 */

const GATEWAY_DEFAULT_PORT = 8090;
let GATEWAY_BASE = `http://127.0.0.1:${GATEWAY_DEFAULT_PORT}`;

const CHANNEL_TYPE_LABELS = {
  openai: 'OpenAI', openai_responses: 'OpenAI Responses', codex: 'Codex',
  anthropic: 'Anthropic', anthropic_aws: 'Anthropic (AWS)', anthropic_gcp: 'Anthropic (GCP)',
  gemini: 'Gemini', gemini_openai: 'Gemini (OpenAI兼容)', gemini_vertex: 'Gemini (Vertex)',
  deepseek: 'DeepSeek', moonshot: '月之暗面', doubao: '字节豆包',
  zhipu: '智谱AI', openrouter: 'OpenRouter', xai: 'xAI (Grok)',
  siliconflow: '硅基流动', ppio: 'PP算力', github_copilot: 'GitHub Copilot',
  claudecode: 'Claude Code',
};

const STATUS_MAP = {
  enabled: { text: '运行中', cls: 'success' },
  disabled: { text: '已停用', cls: 'danger' },
  archived: { text: '已归档', cls: 'muted' },
  completed: { text: '成功', cls: 'success' },
  failed: { text: '失败', cls: 'danger' },
  pending: { text: '等待中', cls: 'warning' },
  processing: { text: '处理中', cls: 'warning' },
  canceled: { text: '已取消', cls: 'muted' },
  active: { text: '活跃', cls: 'success' },
};

class GatewayManager {
  constructor() {
    this.currentTab = 'dashboard';
    this.refreshTimer = null;
  }

  async init() {
    // 从主进程获取网关实际端口（端口回退后可能不是 8090）
    try {
      if (window.ipcRenderer) {
        const port = await window.ipcRenderer.invoke('get-gateway-port');
        if (port) GATEWAY_BASE = `http://127.0.0.1:${port}`;
      }
    } catch (_) { /* 回退到默认端口 */ }

    this.bindTabEvents();
    await this.switchTab('dashboard');
    this.refreshTimer = setInterval(() => {
      if (this.currentTab === 'dashboard') this.renderDashboard();
    }, 30000);
  }

  bindTabEvents() {
    document.querySelectorAll('[data-gateway-tab]').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.gatewayTab));
    });
  }

  async switchTab(tab) {
    this.currentTab = tab;
    document.querySelectorAll('[data-gateway-tab]').forEach(el => {
      el.classList.toggle('active', el.dataset.gatewayTab === tab);
    });
    const renderers = {
      dashboard: () => this.renderDashboard(),
      channels: () => this.renderChannels(),
      models: () => this.renderModels(),
      'api-keys': () => this.renderApiKeys(),
      requests: () => this.renderRequests(),
      traces: () => this.renderTraces(),
      threads: () => this.renderThreads(),
      settings: () => this.renderSettings(),
    };
    if (renderers[tab]) await renderers[tab]();
  }

  async api(endpoint, opts = {}) {
    try {
      const r = await fetch(`${GATEWAY_BASE}${endpoint}`, {
        headers: { 'Content-Type': 'application/json', ...opts.headers }, ...opts,
      });
      return await r.json();
    } catch (e) {
      console.error(`[网关] 请求失败: ${endpoint}`, e);
      return { error: { message: e.message } };
    }
  }

  statusBadge(status) {
    const s = STATUS_MAP[status] || { text: status, cls: 'muted' };
    const colors = {
      success: 'background:var(--success-light);color:var(--success)',
      danger: 'background:var(--danger-light);color:var(--danger)',
      warning: 'background:var(--warning-light);color:var(--warning)',
      muted: 'background:var(--bg-grouped);color:var(--text-muted)',
    };
    return `<span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600;${colors[s.cls]}">${s.text}</span>`;
  }

  fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  typeLabel(type) {
    return CHANNEL_TYPE_LABELS[type] || type;
  }

  $content() { return document.getElementById('gateway-content'); }

  reicons() {
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
      lucide.createIcons({ icons: window.lucideIcons });
    }
  }

  // ────────────────────── 总览 ──────────────────────
  async renderDashboard() {
    const el = this.$content(); if (!el) return;
    const [stats, trend] = await Promise.all([
      this.api('/api/admin/dashboard/stats'),
      this.api('/api/admin/dashboard/usage-trend?days=7'),
    ]);
    const d = stats.data || {};
    el.innerHTML = `
      <div class="section-card">
        <div class="section-heading tight">
          <div><h2>运行概览</h2><p>过去 24 小时网关核心指标</p></div>
          <span class="section-tag">实时</span>
        </div>
        <div class="summary-grid" style="grid-template-columns:repeat(4,1fr);margin-top:12px;">
          ${this._statTile('请求总量', this.fmtNum(d.total_requests || 0), 'activity')}
          ${this._statTile('成功率', `${d.success_rate || 0}%`, 'check-circle')}
          ${this._statTile('消耗 Token', this.fmtNum(d.total_tokens || 0), 'zap')}
          ${this._statTile('累计费用', `$${d.total_cost || '0.00'}`, 'dollar-sign')}
          ${this._statTile('平均延迟', `${d.avg_latency_ms || 0}ms`, 'clock')}
          ${this._statTile('活跃渠道', d.active_channels || 0, 'radio')}
          ${this._statTile('活跃密钥', d.active_api_keys || 0, 'key')}
          ${this._statTile('失败请求', d.failed_requests || 0, 'alert-triangle')}
        </div>
      </div>

      <div class="section-card" style="margin-top:12px;">
        <div class="section-heading tight">
          <div><h2>用量趋势</h2><p>近 7 日请求量、Token 消耗与费用</p></div>
          <span class="section-tag">趋势</span>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;">
          <thead><tr style="border-bottom:2px solid var(--border);">
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);font-weight:600;">日期</th>
            <th style="text-align:right;padding:8px 12px;color:var(--text-muted);font-weight:600;">请求数</th>
            <th style="text-align:right;padding:8px 12px;color:var(--text-muted);font-weight:600;">Token</th>
            <th style="text-align:right;padding:8px 12px;color:var(--text-muted);font-weight:600;">费用</th>
          </tr></thead>
          <tbody>
            ${(trend.data || []).length === 0 ? '<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--text-muted);">暂无用量数据</td></tr>' : ''}
            ${(trend.data || []).map(r => `
              <tr style="border-bottom:1px solid var(--border-light);">
                <td style="padding:8px 12px;">${r.date}</td>
                <td style="text-align:right;padding:8px 12px;font-weight:600;">${r.request_count}</td>
                <td style="text-align:right;padding:8px 12px;">${this.fmtNum(r.tokens)}</td>
                <td style="text-align:right;padding:8px 12px;font-family:var(--font-mono);font-size:12px;">$${parseFloat(r.cost).toFixed(4)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="section-card" style="margin-top:12px;">
        <div class="section-heading tight">
          <div><h2>接入方式</h2><p>在任意 SDK 中将 base_url 指向本地网关即可使用</p></div>
          <span class="section-tag">指引</span>
        </div>
        <div style="font-size:13px;line-height:1.8;margin-top:8px;">
          <div style="display:grid;grid-template-columns:120px 1fr;gap:4px 12px;align-items:center;">
            <span style="color:var(--text-muted);">OpenAI 格式</span>
            <code style="font-family:var(--font-mono);font-size:12px;background:var(--bg-grouped);padding:3px 8px;border-radius:var(--radius-sm);">${GATEWAY_BASE}/v1/chat/completions</code>
            <span style="color:var(--text-muted);">Anthropic 格式</span>
            <code style="font-family:var(--font-mono);font-size:12px;background:var(--bg-grouped);padding:3px 8px;border-radius:var(--radius-sm);">${GATEWAY_BASE}/v1/messages</code>
            <span style="color:var(--text-muted);">Responses 格式</span>
            <code style="font-family:var(--font-mono);font-size:12px;background:var(--bg-grouped);padding:3px 8px;border-radius:var(--radius-sm);">${GATEWAY_BASE}/v1/responses</code>
            <span style="color:var(--text-muted);">模型列表</span>
            <code style="font-family:var(--font-mono);font-size:12px;background:var(--bg-grouped);padding:3px 8px;border-radius:var(--radius-sm);">${GATEWAY_BASE}/v1/models</code>
          </div>
        </div>
      </div>
    `;
    this.reicons();
  }

  _statTile(label, value, icon) {
    return `
      <div class="stat-card">
        <div class="stat-card-label"><i data-lucide="${icon}" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px;"></i>${label}</div>
        <div class="stat-card-value">${value}</div>
      </div>
    `;
  }

  // ────────────────────── 渠道 ──────────────────────
  async renderChannels() {
    const el = this.$content(); if (!el) return;
    const res = await this.api('/api/admin/channels');
    const list = res.data || [];
    el.innerHTML = `
      <div class="section-card">
        <div class="section-heading tight">
          <div><h2>渠道管理</h2><p>每个渠道对应一个 AI 供应商连接，支持多渠道负载均衡和自动故障转移。</p></div>
          <button onclick="gatewayManager.showAddChannel()" class="compact-btn compact-btn-primary" style="white-space:nowrap;"><i data-lucide="plus" style="width:14px;height:14px;margin-right:4px;"></i>添加渠道</button>
        </div>
        ${list.length === 0
          ? '<div style="padding:32px;text-align:center;color:var(--text-muted);">还没有渠道，点击「添加渠道」接入你的第一个 AI 供应商</div>'
          : list.map(ch => this._channelRow(ch)).join('')}
      </div>
    `;
    this.reicons();
  }

  _channelRow(ch) {
    const models = (ch.supported_models || []);
    const modelStr = typeof models === 'string' ? JSON.parse(models) : models;
    const modelList = Array.isArray(modelStr) ? modelStr : [];
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border-light);">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;">
            <strong style="font-size:14px;">${ch.name}</strong>
            ${this.statusBadge(ch.status)}
            <span style="font-size:12px;color:var(--text-muted);background:var(--bg-grouped);padding:1px 8px;border-radius:10px;">${this.typeLabel(ch.type)}</span>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            模型: ${modelList.slice(0, 4).join(', ')}${modelList.length > 4 ? ` 等 ${modelList.length} 个` : modelList.length === 0 ? '未配置' : ''}
            ${ch.remark ? `  ·  ${ch.remark}` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;margin-left:12px;">
          <button onclick="gatewayManager.toggleChannel(${ch.id},'${ch.status === 'enabled' ? 'disabled' : 'enabled'}')" class="compact-btn compact-btn-ghost" style="font-size:12px;padding:4px 10px;">
            ${ch.status === 'enabled' ? '停用' : '启用'}
          </button>
          <button onclick="gatewayManager.deleteChannel(${ch.id})" class="compact-btn compact-btn-ghost" style="font-size:12px;padding:4px 10px;color:var(--danger);">删除</button>
        </div>
      </div>
    `;
  }

  showAddChannel() {
    const types = Object.entries(CHANNEL_TYPE_LABELS)
      .map(([v, l]) => `<option value="${v}">${l} (${v})</option>`).join('');
    const html = `
      <div style="background:var(--bg-card);border-radius:var(--radius-lg);padding:24px;width:480px;max-height:85vh;overflow-y:auto;">
        <div class="section-heading tight" style="margin-bottom:16px;">
          <div><h2>添加渠道</h2><p>填入供应商信息，创建后即可用于请求路由</p></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:14px;">
          <label style="font-size:13px;font-weight:600;">渠道名称
            <input id="ch-name" type="text" placeholder="例如：我的 OpenAI 主力号" style="width:100%;margin-top:4px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;">
          </label>
          <label style="font-size:13px;font-weight:600;">供应商类型
            <select id="ch-type" style="width:100%;margin-top:4px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;">${types}</select>
          </label>
          <label style="font-size:13px;font-weight:600;">Base URL <span style="font-weight:400;color:var(--text-muted);">（可选，留空使用默认）</span>
            <input id="ch-baseurl" type="text" placeholder="https://api.openai.com" style="width:100%;margin-top:4px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;">
          </label>
          <label style="font-size:13px;font-weight:600;">API Key
            <input id="ch-apikey" type="password" placeholder="sk-..." style="width:100%;margin-top:4px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;">
          </label>
          <label style="font-size:13px;font-weight:600;">支持的模型 <span style="font-weight:400;color:var(--text-muted);">（英文逗号分隔）</span>
            <input id="ch-models" type="text" placeholder="gpt-4o, gpt-5, claude-3-5-sonnet" style="width:100%;margin-top:4px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;">
          </label>
          <label style="font-size:13px;font-weight:600;">备注 <span style="font-weight:400;color:var(--text-muted);">（可选）</span>
            <input id="ch-remark" type="text" style="width:100%;margin-top:4px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;">
          </label>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
            <button onclick="this.closest('.gw-modal').remove()" class="compact-btn compact-btn-ghost">取消</button>
            <button onclick="gatewayManager.doCreateChannel()" class="compact-btn compact-btn-primary">创建渠道</button>
          </div>
        </div>
      </div>
    `;
    this._showModal(html);
  }

  async doCreateChannel() {
    const name = document.getElementById('ch-name')?.value;
    const type = document.getElementById('ch-type')?.value;
    if (!name) return this._toast('请填写渠道名称', 'warning');
    await this.api('/api/admin/channels', {
      method: 'POST',
      body: JSON.stringify({
        type, name,
        base_url: document.getElementById('ch-baseurl')?.value || '',
        credentials: { api_key: document.getElementById('ch-apikey')?.value || '' },
        supported_models: (document.getElementById('ch-models')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
        remark: document.getElementById('ch-remark')?.value || null,
      }),
    });
    document.querySelector('.gw-modal')?.remove();
    this._toast('渠道创建成功');
    await this.renderChannels();
  }

  async toggleChannel(id, status) {
    await this.api(`/api/admin/channels/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    this._toast(status === 'enabled' ? '渠道已启用' : '渠道已停用');
    await this.renderChannels();
  }

  async deleteChannel(id) {
    if (!confirm('确定要删除这个渠道吗？删除后不可恢复。')) return;
    await this.api(`/api/admin/channels/${id}`, { method: 'DELETE' });
    this._toast('渠道已删除');
    await this.renderChannels();
  }

  // ────────────────────── 模型 ──────────────────────
  async renderModels() {
    const el = this.$content(); if (!el) return;
    const res = await this.api('/api/admin/models');
    const list = res.data || [];
    el.innerHTML = `
      <div class="section-card">
        <div class="section-heading tight">
          <div><h2>模型管理</h2><p>注册模型后可配置价格和路由规则，未注册的模型也会通过渠道支持列表自动路由。</p></div>
          <button onclick="gatewayManager.showAddModel()" class="compact-btn compact-btn-primary" style="white-space:nowrap;"><i data-lucide="plus" style="width:14px;height:14px;margin-right:4px;"></i>添加模型</button>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:4px;">
          <thead><tr style="border-bottom:2px solid var(--border);">
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);font-weight:600;">模型 ID</th>
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);font-weight:600;">名称</th>
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);font-weight:600;">开发者</th>
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);font-weight:600;">类型</th>
            <th style="text-align:center;padding:8px 12px;color:var(--text-muted);font-weight:600;">状态</th>
            <th style="text-align:right;padding:8px 12px;color:var(--text-muted);font-weight:600;">操作</th>
          </tr></thead>
          <tbody>
            ${list.length === 0 ? '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-muted);">暂无已注册模型</td></tr>' : ''}
            ${list.map(m => `
              <tr style="border-bottom:1px solid var(--border-light);">
                <td style="padding:8px 12px;font-family:var(--font-mono);font-size:12px;">${m.model_id}</td>
                <td style="padding:8px 12px;">${m.name}</td>
                <td style="padding:8px 12px;">${m.developer || '-'}</td>
                <td style="padding:8px 12px;">${{ chat: '对话', embedding: '向量', rerank: '排序', image_generation: '图片', video_generation: '视频' }[m.type] || m.type}</td>
                <td style="padding:8px 12px;text-align:center;">${this.statusBadge(m.status)}</td>
                <td style="padding:8px 12px;text-align:right;">
                  <button onclick="gatewayManager.deleteModel(${m.id})" class="compact-btn compact-btn-ghost" style="font-size:11px;padding:2px 8px;color:var(--danger);">删除</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    this.reicons();
  }

  showAddModel() {
    const html = `
      <div style="background:var(--bg-card);border-radius:var(--radius-lg);padding:24px;width:420px;">
        <h3 style="margin-bottom:16px;">添加模型</h3>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <label style="font-size:13px;">模型 ID<input id="mdl-id" placeholder="如 gpt-5" style="width:100%;margin-top:4px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;"></label>
          <label style="font-size:13px;">显示名称<input id="mdl-name" placeholder="如 GPT-5" style="width:100%;margin-top:4px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;"></label>
          <label style="font-size:13px;">开发者<input id="mdl-dev" placeholder="如 OpenAI" style="width:100%;margin-top:4px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;"></label>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button onclick="this.closest('.gw-modal').remove()" class="compact-btn compact-btn-ghost">取消</button>
            <button onclick="gatewayManager.doCreateModel()" class="compact-btn compact-btn-primary">创建</button>
          </div>
        </div>
      </div>
    `;
    this._showModal(html);
  }

  async doCreateModel() {
    const model_id = document.getElementById('mdl-id')?.value;
    const name = document.getElementById('mdl-name')?.value;
    if (!model_id || !name) return this._toast('请填写模型 ID 和名称', 'warning');
    await this.api('/api/admin/models', { method: 'POST', body: JSON.stringify({ model_id, name, developer: document.getElementById('mdl-dev')?.value || '' }) });
    document.querySelector('.gw-modal')?.remove();
    this._toast('模型已创建');
    await this.renderModels();
  }

  async deleteModel(id) {
    if (!confirm('确定删除此模型？')) return;
    await this.api(`/api/admin/models/${id}`, { method: 'DELETE' });
    await this.renderModels();
  }

  // ────────────────────── 密钥 ──────────────────────
  async renderApiKeys() {
    const el = this.$content(); if (!el) return;
    const res = await this.api('/api/admin/api-keys');
    const list = res.data || [];
    el.innerHTML = `
      <div class="section-card">
        <div class="section-heading tight">
          <div><h2>API 密钥</h2><p>创建密钥后，在 SDK 中用 <code style="font-family:var(--font-mono);font-size:12px;">Authorization: Bearer sk-gw-xxx</code> 认证请求。</p></div>
          <button onclick="gatewayManager.doCreateApiKey()" class="compact-btn compact-btn-primary" style="white-space:nowrap;"><i data-lucide="plus" style="width:14px;height:14px;margin-right:4px;"></i>创建密钥</button>
        </div>
        ${list.length === 0
          ? '<div style="padding:32px;text-align:center;color:var(--text-muted);">还没有 API 密钥，点击「创建密钥」生成一个</div>'
          : list.map(k => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border-light);">
              <div>
                <strong>${k.name}</strong>
                <code style="margin-left:8px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted);background:var(--bg-grouped);padding:2px 6px;border-radius:4px;">${k.key?.substring(0, 24)}…</code>
                ${this.statusBadge(k.status)}
              </div>
              <button onclick="gatewayManager.deleteApiKey(${k.id})" class="compact-btn compact-btn-ghost" style="font-size:12px;color:var(--danger);">删除</button>
            </div>
          `).join('')}
      </div>
    `;
    this.reicons();
  }

  async doCreateApiKey() {
    const name = prompt('请输入密钥名称（方便识别用途）：');
    if (!name) return;
    const res = await this.api('/api/admin/api-keys', { method: 'POST', body: JSON.stringify({ name }) });
    if (res.data?.key) {
      const html = `
        <div style="background:var(--bg-card);border-radius:var(--radius-lg);padding:24px;width:480px;">
          <h3 style="margin-bottom:12px;">密钥已创建</h3>
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">请立即复制保存，此密钥不会再次显示。</p>
          <div style="background:var(--bg-grouped);padding:12px;border-radius:var(--radius-sm);font-family:var(--font-mono);font-size:13px;word-break:break-all;user-select:all;">${res.data.key}</div>
          <div style="display:flex;justify-content:flex-end;margin-top:16px;">
            <button onclick="navigator.clipboard.writeText('${res.data.key}');this.textContent='已复制';setTimeout(()=>this.closest('.gw-modal').remove(),800)" class="compact-btn compact-btn-primary">复制密钥</button>
          </div>
        </div>
      `;
      this._showModal(html);
    }
    await this.renderApiKeys();
  }

  async deleteApiKey(id) {
    if (!confirm('确定删除此密钥？使用该密钥的应用将立即失效。')) return;
    await this.api(`/api/admin/api-keys/${id}`, { method: 'DELETE' });
    await this.renderApiKeys();
  }

  // ────────────────────── 请求 ──────────────────────
  async renderRequests() {
    const el = this.$content(); if (!el) return;
    const res = await this.api('/api/admin/requests?limit=50');
    const list = res.data || [];
    el.innerHTML = `
      <div class="section-card">
        <div class="section-heading tight">
          <div><h2>请求记录</h2><p>所有经过网关的 API 请求记录，点击行查看详情。共 ${res.total || 0} 条记录。</p></div>
          <span class="section-tag">最近 50 条</span>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:4px;">
          <thead><tr style="border-bottom:2px solid var(--border);">
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);">ID</th>
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);">模型</th>
            <th style="text-align:center;padding:8px 12px;color:var(--text-muted);">状态</th>
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);">格式</th>
            <th style="text-align:right;padding:8px 12px;color:var(--text-muted);">延迟</th>
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);">时间</th>
          </tr></thead>
          <tbody>
            ${list.length === 0 ? '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-muted);">暂无请求记录</td></tr>' : ''}
            ${list.map(r => `
              <tr style="border-bottom:1px solid var(--border-light);cursor:pointer;" onclick="gatewayManager.showRequestDetail(${r.id})">
                <td style="padding:8px 12px;font-family:var(--font-mono);font-size:12px;">#${r.id}</td>
                <td style="padding:8px 12px;">${r.model_id}</td>
                <td style="padding:8px 12px;text-align:center;">${this.statusBadge(r.status)}</td>
                <td style="padding:8px 12px;font-size:12px;">${r.format}</td>
                <td style="text-align:right;padding:8px 12px;font-family:var(--font-mono);font-size:12px;">${r.metrics_latency_ms ? r.metrics_latency_ms + 'ms' : '-'}</td>
                <td style="padding:8px 12px;font-size:12px;color:var(--text-muted);">${new Date(r.created_at).toLocaleString('zh-CN')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  async showRequestDetail(id) {
    const res = await this.api(`/api/admin/requests/${id}`);
    if (!res.data) return;
    const r = res.data;
    const html = `
      <div style="background:var(--bg-card);border-radius:var(--radius-lg);padding:24px;width:640px;max-height:80vh;overflow-y:auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h3>请求 #${r.id} 详情</h3>
          <button onclick="this.closest('.gw-modal').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-muted);">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;font-size:13px;margin-bottom:16px;">
          <div><span style="color:var(--text-muted);">模型：</span>${r.model_id}</div>
          <div><span style="color:var(--text-muted);">状态：</span>${this.statusBadge(r.status)}</div>
          <div><span style="color:var(--text-muted);">格式：</span>${r.format}</div>
          <div><span style="color:var(--text-muted);">流式：</span>${r.stream ? '是' : '否'}</div>
          <div><span style="color:var(--text-muted);">总延迟：</span>${r.metrics_latency_ms || '-'}ms</div>
          <div><span style="color:var(--text-muted);">首 Token：</span>${r.metrics_first_token_latency_ms || '-'}ms</div>
        </div>
        ${(r.executions || []).length > 0 ? `
          <h4 style="margin-bottom:8px;">执行记录</h4>
          <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px;">
            <thead><tr style="border-bottom:1px solid var(--border);"><th style="padding:4px 8px;text-align:left;">次序</th><th style="padding:4px 8px;">渠道</th><th style="padding:4px 8px;">状态</th><th style="padding:4px 8px;">HTTP</th></tr></thead>
            <tbody>${r.executions.map(e => `<tr style="border-bottom:1px solid var(--border-light);"><td style="padding:4px 8px;">#${e.attempt_number}</td><td style="padding:4px 8px;">渠道 ${e.channel_id}</td><td style="padding:4px 8px;">${this.statusBadge(e.status)}</td><td style="padding:4px 8px;">${e.response_status_code || '-'}</td></tr>`).join('')}</tbody>
          </table>
        ` : ''}
        ${(r.usage_logs || []).length > 0 ? `
          <h4 style="margin-bottom:8px;">Token 用量</h4>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:16px;">
            ${r.usage_logs.map(u => `输入 ${u.prompt_tokens} · 输出 ${u.completion_tokens} · 总计 ${u.total_tokens} · 缓存 ${u.cached_tokens}`).join('<br>')}
          </div>
        ` : ''}
        <h4 style="margin-bottom:8px;">请求体</h4>
        <pre style="background:var(--bg-grouped);padding:12px;border-radius:var(--radius-sm);overflow-x:auto;font-size:11px;font-family:var(--font-mono);max-height:180px;line-height:1.5;">${JSON.stringify(r.request_body, null, 2)}</pre>
      </div>
    `;
    this._showModal(html);
  }

  // ────────────────────── 追踪 ──────────────────────
  async renderTraces() {
    const el = this.$content(); if (!el) return;
    const res = await this.api('/api/admin/traces?limit=50');
    const list = res.data || [];
    el.innerHTML = `
      <div class="section-card">
        <div class="section-heading tight">
          <div><h2>链路追踪</h2><p>每条 Trace 关联一次完整的请求链路，可串联多个请求和线程。共 ${res.total || 0} 条。</p></div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:4px;">
          <thead><tr style="border-bottom:2px solid var(--border);">
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);">ID</th>
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);">外部 ID</th>
            <th style="text-align:center;padding:8px 12px;color:var(--text-muted);">状态</th>
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);">关联线程</th>
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);">时间</th>
          </tr></thead>
          <tbody>
            ${list.length === 0 ? '<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--text-muted);">暂无追踪记录</td></tr>' : ''}
            ${list.map(t => `
              <tr style="border-bottom:1px solid var(--border-light);">
                <td style="padding:8px 12px;">#${t.id}</td>
                <td style="padding:8px 12px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${t.external_trace_id || '-'}</td>
                <td style="padding:8px 12px;text-align:center;">${this.statusBadge(t.status)}</td>
                <td style="padding:8px 12px;">${t.thread_id ? `#${t.thread_id}` : '-'}</td>
                <td style="padding:8px 12px;font-size:12px;color:var(--text-muted);">${new Date(t.created_at).toLocaleString('zh-CN')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // ────────────────────── 线程 ──────────────────────
  async renderThreads() {
    const el = this.$content(); if (!el) return;
    const res = await this.api('/api/admin/threads?limit=50');
    const list = res.data || [];
    el.innerHTML = `
      <div class="section-card">
        <div class="section-heading tight">
          <div><h2>会话线程</h2><p>Codex、Claude Code 等工具的会话线程自动归集。共 ${res.total || 0} 条。</p></div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:4px;">
          <thead><tr style="border-bottom:2px solid var(--border);">
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);">ID</th>
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);">外部 ID</th>
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);">名称</th>
            <th style="text-align:left;padding:8px 12px;color:var(--text-muted);">时间</th>
          </tr></thead>
          <tbody>
            ${list.length === 0 ? '<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--text-muted);">暂无线程记录</td></tr>' : ''}
            ${list.map(t => `
              <tr style="border-bottom:1px solid var(--border-light);">
                <td style="padding:8px 12px;">#${t.id}</td>
                <td style="padding:8px 12px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${t.external_thread_id || '-'}</td>
                <td style="padding:8px 12px;">${t.name || '-'}</td>
                <td style="padding:8px 12px;font-size:12px;color:var(--text-muted);">${new Date(t.created_at).toLocaleString('zh-CN')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // ────────────────────── 设置 ──────────────────────
  async renderSettings() {
    const el = this.$content(); if (!el) return;
    const res = await this.api('/api/admin/system/settings');
    const s = res.data || {};
    el.innerHTML = `
      <div class="section-card">
        <div class="section-heading tight">
          <div><h2>系统设置</h2><p>网关核心配置和运行信息</p></div>
          <span class="section-tag">设置</span>
        </div>
        <div style="margin-top:8px;">
          ${Object.entries(s).map(([k, v]) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-light);">
              <span style="font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);">${k}</span>
              <span style="font-size:13px;max-width:50%;text-align:right;word-break:break-all;">${v}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="section-card" style="margin-top:12px;">
        <div class="section-heading tight">
          <div><h2>数据管理</h2><p>导出或导入网关配置（渠道、模型、密钥等）</p></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button onclick="gatewayManager.exportConfig()" class="compact-btn compact-btn-ghost"><i data-lucide="download" style="width:14px;height:14px;margin-right:4px;"></i>导出配置</button>
          <button onclick="gatewayManager.importConfig()" class="compact-btn compact-btn-ghost"><i data-lucide="upload" style="width:14px;height:14px;margin-right:4px;"></i>导入配置</button>
          <button onclick="gatewayManager.syncAccounts()" class="compact-btn compact-btn-primary"><i data-lucide="refresh-cw" style="width:14px;height:14px;margin-right:4px;"></i>同步本地账号到渠道</button>
        </div>
      </div>
    `;
    this.reicons();
  }

  async exportConfig() {
    const res = await this.api('/api/admin/backup/export');
    if (res.data) {
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `gateway-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      this._toast('配置已导出');
    }
  }

  async importConfig() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        const data = JSON.parse(text);
        await this.api('/api/admin/backup/import', { method: 'POST', body: JSON.stringify(data) });
        this._toast('配置导入成功');
        await this.renderSettings();
      } catch (err) {
        this._toast('导入失败: ' + err.message, 'danger');
      }
    };
    input.click();
  }

  async syncAccounts() {
    this._toast('正在同步账号…', 'info');
    try {
      const accountsData = await window.ipcRenderer?.invoke('get-accounts');
      if (!accountsData || !Array.isArray(accountsData)) {
        return this._toast('未找到本地账号数据', 'warning');
      }
      const res = await this.api('/api/admin/accounts/sync', {
        method: 'POST',
        body: JSON.stringify({ accounts: accountsData }),
      });
      if (res.data) {
        this._toast(`同步完成：新增 ${res.data.created} 个、更新 ${res.data.updated} 个渠道`);
      }
    } catch (err) {
      this._toast('同步失败: ' + err.message, 'danger');
    }
  }

  // ────────────────────── 工具 ──────────────────────
  _showModal(contentHtml) {
    const wrap = document.createElement('div');
    wrap.className = 'gw-modal';
    wrap.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:10000;';
    wrap.innerHTML = contentHtml;
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
  }

  _toast(msg, type) {
    if (typeof showToast === 'function') {
      showToast(msg, type || 'success');
    } else {
      console.log(`[网关] ${msg}`);
    }
  }

  destroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}

// ==================== Module exports ====================

if (typeof module !== 'undefined') {
  module.exports = {
    GatewayManager,
    windowExports: {
      GatewayManager,
    },
  };
}
