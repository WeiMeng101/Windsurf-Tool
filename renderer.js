// renderer.js - Thin Orchestrator
'use strict';

// ==================== Lucide icon init ====================
if (typeof window !== 'undefined' && typeof lucide !== 'undefined') {
  window.lucide = lucide;
  window.lucideIcons = lucide.icons;
  const _origCreate = lucide.createIcons.bind(lucide);
  lucide.createIcons = (opts = {}) => _origCreate({ icons: lucide.icons, ...opts });
  window.initLucideIcons = () => { if (typeof lucide !== 'undefined') lucide.createIcons(); };
}

// ==================== Global IPC & shell ====================
window.ipcRenderer = require('electron').ipcRenderer;
const { shell } = require('electron');
window.axios = require('axios');

// ==================== Load modules (dependency order) ====================
const state = require('./src/renderer/state');
const constants = require('./src/renderer/constants');
const configRenderer = require('./src/renderer/configRenderer');
const pathRenderer = require('./src/renderer/pathRenderer');
const filterRenderer = require('./src/renderer/filterRenderer');
const sqliteHelperRenderer = require('./src/renderer/sqliteHelperRenderer');
const queryRenderer = require('./src/renderer/queryRenderer');
const domainRenderer = require('./src/renderer/domainRenderer');
const detectorRenderer = require('./src/renderer/detectorRenderer');
const loginRenderer = require('./src/renderer/loginRenderer');
const cardRenderer = require('./src/renderer/cardRenderer');
const accountManagerRenderer = require('./src/renderer/accountManagerRenderer');
const switcherRenderer = require('./src/renderer/switcherRenderer');
const codexSwitchRenderer = require('./src/renderer/codexSwitchRenderer');
const gatewayRenderer = require('./src/renderer/gatewayRenderer');
const poolRenderer = require('./src/renderer/poolRenderer');
const dashboardRenderer = require('./src/renderer/dashboardRenderer');
const tokenGetterRenderer = require('./src/renderer/tokenGetterRenderer');
const ipcBridge = require('./src/renderer/ipcBridge');
const modals = require('./src/renderer/modals');
const versionCheck = require('./src/renderer/versionCheck');
const emailConfig = require('./src/renderer/emailConfig');
const uiHelpers = require('./src/renderer/uiHelpers');
const CodexManager = require('./src/renderer/codexManager');
const accountRenderer = require('./src/renderer/accountRenderer');
const registrationRenderer = require('./src/renderer/registrationRenderer');
const tokenRenderer = require('./src/renderer/tokenRenderer');
const switchRenderer = require('./src/renderer/switchRenderer');

// ==================== Mount globals ====================
window.CONSTANTS = constants;
window.CodexManager = CodexManager;
window.safeIpcInvoke = ipcBridge.safeIpcInvoke;
window.setupMaintenanceInterceptors = ipcBridge.setupMaintenanceInterceptors;
[configRenderer, pathRenderer, filterRenderer, sqliteHelperRenderer, queryRenderer, domainRenderer,
  detectorRenderer, loginRenderer, cardRenderer, accountManagerRenderer, switcherRenderer,
  codexSwitchRenderer, gatewayRenderer, tokenGetterRenderer, modals, versionCheck, emailConfig,
  uiHelpers, accountRenderer, registrationRenderer, tokenRenderer, switchRenderer,
  poolRenderer, dashboardRenderer,
].forEach(m => { if (m?.windowExports) Object.assign(window, m.windowExports); });

// ==================== View controller (from ui/viewController.js) ====================
window.openQQGroup = () => { shell.openExternal('https://qm.qq.com/q/1W3jvnDoak'); };
let _gwInstance = null;
window.switchView = (viewName) => {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelector(`.nav-item[data-view="${viewName}"]`)?.classList.add('active');
  document.querySelectorAll('.view-content').forEach(v => v.classList.remove('active'));
  document.getElementById(viewName)?.classList.add('active');
  if (typeof window.switchTabLogic === 'function') window.switchTabLogic(viewName);
  if (viewName === 'settings') { window.loadConfigPath?.(); window.initDomainManager?.(); }
  if (viewName === 'autoBindCard' && window.AutoBindCard?.onViewSwitch) { window.AutoBindCard.onViewSwitch(); if (typeof lucide !== 'undefined') lucide.createIcons(); }
  if (viewName === 'gateway') {
    if (!_gwInstance) { _gwInstance = new GatewayManager(); _gwInstance.init(); }
    else { _gwInstance.switchTab(_gwInstance.currentTab); }
  }
  if (viewName === 'pool') {
    if (!window._poolInstance) { window._poolInstance = new PoolManager(); window._poolInstance.init(); }
    else { window._poolInstance.render(); }
  }
  if (viewName === 'dashboard') {
    if (!window._dashInstance) { window._dashInstance = new DashboardManager(); window._dashInstance.init(); }
    else { window._dashInstance.render(); }
  }
};

// viewController.js helpers
window.loadConfigPath = async () => { try { const r = await window.ipcRenderer.invoke('get-config-path'); const el = document.getElementById('configPath'); if (el && r.path) el.value = r.path; } catch {} };
window.copyConfigPath = async () => { const el = document.getElementById('configPath'); if (!el?.value) return showCustomAlert('配置文件路径未加载', 'warning'); try { await navigator.clipboard.writeText(el.value); showCustomAlert('已复制', 'success'); } catch { el.select(); document.execCommand('copy'); } };
window.openConfigFolder = async () => { try { const r = await window.ipcRenderer.invoke('open-config-folder'); if (!r.success) showCustomAlert('打开失败: ' + (r.error || ''), 'error'); } catch (e) { showCustomAlert('打开失败: ' + e.message, 'error'); } };
window.openExternalLink = (url) => { shell.openExternal(url); };
window.togglePassword = (event) => { event.stopPropagation(); const btn = event.currentTarget, cell = btn.closest('.password-cell'), m = cell?.querySelector('.password-masked'), t = cell?.querySelector('.password-text'), i = btn.querySelector('i'); if (!m || !t) return; const show = m.style.display === 'none'; m.style.display = show ? 'inline' : 'none'; t.style.display = show ? 'none' : 'inline'; if (i) i.setAttribute('data-lucide', show ? 'eye' : 'eye-off'); if (typeof lucide !== 'undefined') lucide.createIcons(); };
window.copyEmailText = (e) => { e.stopPropagation(); navigator.clipboard.writeText(e.target.textContent).catch(() => {}); };
window.copyPasswordText = (e) => { e.stopPropagation(); navigator.clipboard.writeText(e.target.textContent).catch(() => {}); };
window.toggleAddAccountMenu = (e) => { e.stopPropagation(); document.getElementById('addAccountMenu')?.classList.toggle('show'); };
window.hideAddAccountMenu = () => document.getElementById('addAccountMenu')?.classList.remove('show');
window.toggleExportMenu = (e) => { e.stopPropagation(); document.getElementById('exportAccountMenu')?.classList.toggle('show'); };
window.hideExportMenu = () => document.getElementById('exportAccountMenu')?.classList.remove('show');
window.addRegisterLog = (msg, type = 'info') => { const el = document.getElementById('registerLog'); if (!el) return; const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false }); const cls = type === 'success' ? 'log-success' : type === 'error' ? 'log-error' : type === 'warning' ? 'log-warning' : 'log-info'; const d = document.createElement('div'); d.className = 'log-entry'; d.innerHTML = `<span class="log-timestamp">[${ts}]</span><span class="${cls}">${msg}</span>`; el.appendChild(d); el.scrollTop = el.scrollHeight + 1000; };
window.updateRegisterStats = (t, s, f, p) => { document.getElementById('modalTotalCount').textContent = t; document.getElementById('modalSuccessCount').textContent = s; document.getElementById('modalFailCount').textContent = f; document.getElementById('modalProgress').textContent = p + '%'; };
window.closeBatchRegisterModal = () => { document.getElementById('batchRegisterModal').style.display = 'none'; };
window.openBatchRegisterModal = () => { const m = document.getElementById('batchRegisterModal'); if (document.getElementById('registerLog')) document.getElementById('registerLog').innerHTML = ''; ['modalTotalCount', 'modalSuccessCount', 'modalFailCount'].forEach(id => document.getElementById(id).textContent = '0'); document.getElementById('modalProgress').textContent = '0%'; ['registerConfigSection'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'block'; }); ['registerStatsSection', 'registerLogSection', 'registerFooterSection'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; }); m.style.display = 'flex'; if (typeof lucide !== 'undefined') lucide.createIcons(); };
window.showRegisterProgress = () => { ['registerConfigSection'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; }); ['registerStatsSection', 'registerLogSection', 'registerFooterSection'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = ''; }); };
window.closeLoginTokenModal = () => { const m = document.getElementById('loginTokenModal'); if (m) m.style.display = 'none'; };
document.addEventListener('click', (e) => { if (document.getElementById('addAccountMenu') && !document.getElementById('addAccountMenu').contains(e.target) && !document.getElementById('addAccountBtn')?.contains(e.target)) window.hideAddAccountMenu(); if (document.getElementById('exportAccountMenu') && !document.getElementById('exportAccountMenu').contains(e.target) && !document.getElementById('exportAccountBtn')?.contains(e.target)) window.hideExportMenu(); });

// ==================== Global refresh ====================
window.refreshAllData = async () => { try { window.loadAccounts?.(); window.DomainManager?.init?.(); window.loadSettings?.(); window.refreshCurrentAccount?.(); } catch (e) { console.error('数据刷新失败:', e); } };

// ==================== FadeOut style ====================
if (!document.getElementById('fadeOutStyle')) { const s = document.createElement('style'); s.id = 'fadeOutStyle'; s.textContent = '@keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }'; document.head.appendChild(s); }

// ==================== Error handlers ====================
window.addEventListener('error', (e) => console.error('全局错误:', e.error));
window.addEventListener('unhandledrejection', (e) => console.error('未处理的Promise拒绝:', e.reason));

// ==================== IPC event listeners ====================
window.ipcRenderer.on('check-for-updates', () => versionCheck.checkForUpdates());
window.ipcRenderer.on('version-update-available', (_e, d) => { if (d?.latestVersion) modals.showVersionUpdateModal(d); });
window.ipcRenderer.on('maintenance-mode-active', () => versionCheck.activateMaintenanceMode());
window.ipcRenderer.on('maintenance-mode-ended', () => versionCheck.deactivateMaintenanceMode());
window.ipcRenderer.on('api-unavailable', (_e, err) => { if (!state.isApiUnavailable) { state.isApiUnavailable = true; modals.showApiUnavailableModal(err); } });
registrationRenderer.setupRegistrationIpcListeners();
tokenRenderer.setupTokenIpcListeners();
switchRenderer.setupSwitchIpcListeners();
queryRenderer.setupQueryListeners();

// ==================== DOMContentLoaded ====================
window.addEventListener('DOMContentLoaded', async () => {
  versionCheck.updateUILanguage();
  ipcBridge.setupMaintenanceInterceptors();
  if (typeof lucide !== 'undefined') lucide.createIcons();
  ['maintenanceOverlay', 'maintenanceModal', 'versionUpdateModal'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  window.ipcRenderer.on('version-update-required', (_e, d) => { if (d?.latestVersion) { modals.showVersionUpdateModal(d); versionCheck.setupForceUpdateProtection(); } });
  versionCheck.initializeGlobalProtection();
  window.ipcRenderer.on('show-force-update-warning', () => showCustomAlert('当前版本需要更新才能继续使用，请先下载最新版本。', 'warning'));
  setTimeout(() => versionCheck.checkForUpdatesOnRefresh(), 2000);
  const ndi = document.getElementById('newDomain');
  if (ndi) ndi.addEventListener('keypress', (e) => { if (e.key === 'Enter' && window.DomainManager?.addDomain) window.DomainManager.addDomain(); });
  const pt = ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[process.platform] || process.platform;
  ['sidebarPlatformInfo', 'platformInfo'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = pt; });
  if (typeof window.getCurrentAccount === 'function') await window.getCurrentAccount();
  if (typeof window.initAccountRenderer === 'function') window.initAccountRenderer();
  try { const r = await window.ipcRenderer.invoke('load-windsurf-config'); if (r.success && r.config) { state.currentConfig = r.config; localStorage.setItem('windsurfConfig', JSON.stringify(state.currentConfig)); } else { const s = localStorage.getItem('windsurfConfig'); if (s) state.currentConfig = JSON.parse(s); } } catch { const s = localStorage.getItem('windsurfConfig'); if (s) state.currentConfig = JSON.parse(s); }
  window.loadFilePaths?.(); window.initDomainManager?.(); window.loadAccounts?.();
});

// ==================== External link handling ====================
document.addEventListener('click', (e) => { const t = e.target.closest('a[target="_blank"]'); if (t?.href) { e.preventDefault(); shell.openExternal(t.href); } });
