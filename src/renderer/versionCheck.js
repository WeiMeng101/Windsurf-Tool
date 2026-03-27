// src/renderer/versionCheck.js - 版本检查、维护模式、强制更新保护
'use strict';

const { ipcRenderer } = require('electron');
const state = require('./state');

// 模块级状态
let isQuitting = false;

// ==================== 维护模式管理 ====================

function activateMaintenanceMode(maintenanceInfo) {
  console.log('⚠️ 进入维护模式:', maintenanceInfo);
  state.isMaintenanceModeActive = true;
  window.showMaintenanceModal(maintenanceInfo);
}

function deactivateMaintenanceMode() {
  console.log('✅ 维护模式已结束');
  state.isMaintenanceModeActive = false;
  const maintenanceModal = document.getElementById('maintenanceModal');
  if (maintenanceModal) maintenanceModal.remove();
  const maintenanceOverlay = document.getElementById('maintenanceOverlay');
  if (maintenanceOverlay) maintenanceOverlay.remove();
  document.body.style.pointerEvents = 'auto';
  enableAllFunctions();
  window.showCustomAlert('维护模式已结束，功能已恢复正常！', 'success');
}

function quitApplication() {
  isQuitting = true;
  removeForceUpdateProtection();
  ipcRenderer.send('quit-app');
}

// ==================== 版本检查 ====================

async function checkForUpdates() {
  const now = Date.now();
  if (now - state.lastVersionCheckTime < state.versionCheckCooldown) {
    console.log('⏳ 版本检查冷却中，跳过本次检查');
    return;
  }
  state.lastVersionCheckTime = now;

  try {
    const { safeIpcInvoke } = require('./ipcBridge');
    const data = await safeIpcInvoke('check-for-updates');
    if (!data || !data.hasUpdate) return;
    if (!data.latestVersion || !data.currentVersion) return;

    const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;
    if (!versionPattern.test(data.latestVersion)) return;

    if (data.forceUpdate) {
      window.showVersionUpdateModal(data);
    } else {
      const confirmed = await window.showCustomConfirm({
        title: '发现新版本',
        message: `最新版本 v${data.latestVersion}，当前 v${data.currentVersion}`,
        subMessage: false,
        confirmText: '查看详情',
        type: 'info'
      });
      if (confirmed) window.openDownloadUrl();
    }
  } catch (error) {
    console.error('检查更新时出错:', error);
  }
}

function checkForUpdatesOnRefresh() {
  const now = Date.now();
  if (now - state.lastVersionCheckTime < state.versionCheckCooldown) return;
  state.lastVersionCheckTime = now;

  ipcRenderer.invoke('check-for-updates').then(data => {
    if (data && data.hasUpdate && data.latestVersion && data.currentVersion) {
      const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;
      if (versionPattern.test(data.latestVersion)) {
        window.showVersionUpdateModal(data);
      }
    }
  }).catch(err => {
    console.error('刷新时检查更新失败:', err);
  });
}

function updateUILanguage() {
  if (typeof window.loadAccounts === 'function') window.loadAccounts();
  if (typeof window.renderSwitchAccountsGrid === 'function') window.renderSwitchAccountsGrid();
  if (typeof window.renderUsedAccountsGrid === 'function') window.renderUsedAccountsGrid();
}

// ==================== 强制更新保护 ====================

function initializeGlobalProtection() {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.isForceUpdateActive) {
      const modal = document.getElementById('versionUpdateModal');
      if (modal) {
        modal.style.display = 'flex';
        modal.style.pointerEvents = 'auto';
      }
    }
  });

  window.addEventListener('focus', () => {
    if (state.isForceUpdateActive) {
      const modal = document.getElementById('versionUpdateModal');
      if (modal) {
        modal.style.display = 'flex';
        modal.style.pointerEvents = 'auto';
      }
    }
  });
}

function setupForceUpdateProtection() {
  window.addEventListener('beforeunload', preventRefreshDuringForceUpdate);
  window.addEventListener('keydown', preventRefreshKeysDuringForceUpdate);
}

function removeForceUpdateProtection() {
  window.removeEventListener('beforeunload', preventRefreshDuringForceUpdate);
  window.removeEventListener('keydown', preventRefreshKeysDuringForceUpdate);
  ipcRenderer.send('set-force-update-status', false);
}

function preventRefreshDuringForceUpdate(event) {
  if (isQuitting) return;
  if (state.isForceUpdateActive) {
    event.preventDefault();
    event.returnValue = '';
    return '';
  }
}

function preventRefreshKeysDuringForceUpdate(event) {
  if (isQuitting) return;
  if (state.isForceUpdateActive) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'r') {
      event.preventDefault();
      event.stopPropagation();
    }
  }
}

// ==================== 功能 限/恢复 ====================

function disableAllFunctions() {
  const buttons = document.querySelectorAll('button:not(#maintenanceRetryBtn):not(#maintenanceExitBtn)');
  buttons.forEach(btn => { btn.disabled = true; btn.style.opacity = '0.5'; btn.style.cursor = 'not-allowed'; });
  const inputs = document.querySelectorAll('input, select, textarea');
  inputs.forEach(input => { input.disabled = true; input.style.opacity = '0.5'; });
  const links = document.querySelectorAll('a');
  links.forEach(link => { link.style.pointerEvents = 'none'; link.style.opacity = '0.5'; });

  document.addEventListener('keydown', preventMaintenanceKeyEvents, true);
  document.addEventListener('contextmenu', preventMaintenanceEvents, true);

  const existingOverlay = document.getElementById('maintenanceOverlay');
  if (existingOverlay) existingOverlay.remove();

  const overlay = document.createElement('div');
  overlay.id = 'maintenanceOverlay';
  overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 9998; pointer-events: none;';
  document.body.appendChild(overlay);
}

function preventMaintenanceKeyEvents(event) {
  if (event.key === 'F5' || (event.ctrlKey && event.key === 'r') || event.key === 'F12') {
    event.preventDefault();
    event.stopPropagation();
    return false;
  }
}

function preventMaintenanceEvents(event) {
  event.preventDefault();
  event.stopPropagation();
  return false;
}

function enableAllFunctions() {
  const buttons = document.querySelectorAll('button');
  buttons.forEach(btn => { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; });
  const inputs = document.querySelectorAll('input, select, textarea');
  inputs.forEach(input => { input.disabled = false; input.style.opacity = '1'; });
  const links = document.querySelectorAll('a');
  links.forEach(link => { link.style.pointerEvents = 'auto'; link.style.opacity = '1'; });

  document.removeEventListener('keydown', preventMaintenanceKeyEvents, true);
  document.removeEventListener('contextmenu', preventMaintenanceEvents, true);

  const overlay = document.getElementById('maintenanceOverlay');
  if (overlay) overlay.remove();
}

module.exports = {
  activateMaintenanceMode,
  deactivateMaintenanceMode,
  quitApplication,
  checkForUpdates,
  checkForUpdatesOnRefresh,
  updateUILanguage,
  initializeGlobalProtection,
  setupForceUpdateProtection,
  removeForceUpdateProtection,
  preventRefreshDuringForceUpdate,
  preventRefreshKeysDuringForceUpdate,
  disableAllFunctions,
  enableAllFunctions,
  preventMaintenanceKeyEvents,
  preventMaintenanceEvents,
  windowExports: {
    activateMaintenanceMode,
    deactivateMaintenanceMode,
    quitApplication,
    checkForUpdates,
    checkForUpdatesOnRefresh,
    updateUILanguage,
    initializeGlobalProtection,
    setupForceUpdateProtection,
    removeForceUpdateProtection,
    disableAllFunctions,
    enableAllFunctions,
  },
};
