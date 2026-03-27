// src/renderer/emailConfig.js - 邮箱配置和设置相关功能
'use strict';

const { ipcRenderer } = require('electron');
const state = require('./state');

// ==================== 渲染设置 ====================

function renderSettingsFromCurrentConfig() {
  const imapHost = document.getElementById('imapHost');
  const imapPort = document.getElementById('imapPort');
  const imapUser = document.getElementById('imapUser');
  const imapPass = document.getElementById('imapPass');
  const imapTls = document.getElementById('imapTls');
  const imapProvider = document.getElementById('imapProvider');
  const passwordMode = document.getElementById('passwordMode');
  const queryInterval = document.getElementById('queryInterval');

  if (state.currentConfig.emailConfig) {
    if (imapHost) imapHost.value = 'imap.qq.com';
    if (imapPort) imapPort.value = '993';
    if (imapUser) imapUser.value = state.currentConfig.emailConfig.user || '';
    if (imapPass) imapPass.value = state.currentConfig.emailConfig.password || '';
    if (imapTls) imapTls.checked = true;
    if (imapProvider) imapProvider.value = 'qq';
  }

  if (passwordMode) passwordMode.value = state.currentConfig.passwordMode || 'random';
  if (queryInterval) queryInterval.value = state.currentConfig.queryInterval || 5;

  if (imapHost) imapHost.readOnly = true;
  if (imapPort) imapPort.readOnly = true;
  if (imapTls) imapTls.disabled = true;
  if (imapProvider) imapProvider.disabled = true;
}

function loadSettings() {
  const savedConfig = localStorage.getItem('windsurfConfig');
  if (savedConfig) {
    try {
      const parsed = JSON.parse(savedConfig);
      Object.assign(state.currentConfig, parsed);
    } catch (e) {
      console.error('加载配置失败:', e);
    }
  }
  renderSettingsFromCurrentConfig();
}

// ==================== IMAP配置 ====================

function fillImapConfig() {
  const provider = document.getElementById('imapProvider');
  if (!provider) return;

  const presets = {
    gmail: { host: 'imap.gmail.com', port: 993, tls: true },
    outlook: { host: 'outlook.office365.com', port: 993, tls: true },
    qq: { host: 'imap.qq.com', port: 993, tls: true },
    '163': { host: 'imap.163.com', port: 993, tls: true },
    '126': { host: 'imap.126.com', port: 993, tls: true },
    yahoo: { host: 'imap.mail.yahoo.com', port: 993, tls: true },
    icloud: { host: 'imap.mail.me.com', port: 993, tls: true },
  };

  const preset = presets[provider.value] || presets.qq;

  document.getElementById('imapHost').value = 'imap.qq.com';
  document.getElementById('imapPort').value = '993';
  document.getElementById('imapTls').checked = true;
  document.getElementById('imapProvider').value = 'qq';

  const imapHost = document.getElementById('imapHost');
  const imapPort = document.getElementById('imapPort');
  const imapTls = document.getElementById('imapTls');
  const imapProviderEl = document.getElementById('imapProvider');

  if (imapHost) imapHost.readOnly = true;
  if (imapPort) imapPort.readOnly = true;
  if (imapTls) imapTls.disabled = true;
  if (imapProviderEl) imapProviderEl.disabled = true;
}

// ==================== 测试IMAP ====================

async function testImap() {
  const config = {
    host: 'imap.qq.com',
    port: 993,
    user: document.getElementById('imapUser')?.value,
    password: document.getElementById('imapPass')?.value,
    tls: true,
  };

  if (!config.user || !config.password) {
    window.showCenterMessage('请填写QQ邮箱和授权码', 'error');
    return;
  }

  window.showCenterMessage('正在测试IMAP连接...', 'info', 0);

  try {
    const result = await ipcRenderer.invoke('test-imap', config);
    if (result.success) {
      window.showCenterMessage('IMAP 连接成功！', 'success');
    } else {
      window.showCenterMessage(`连接失败: ${result.error}`, 'error');
    }
  } catch (err) {
    window.showCenterMessage(`测试失败: ${err.message}`, 'error');
  }
}

// ==================== 保存设置 ====================

async function saveSettings() {
  const emailConfig = {
    host: 'imap.qq.com',
    port: 993,
    user: document.getElementById('imapUser')?.value || '',
    password: document.getElementById('imapPass')?.value || '',
    tls: true,
  };

  const passwordMode = document.getElementById('passwordMode')?.value || 'random';
  const queryInterval = parseInt(document.getElementById('queryInterval')?.value) || 5;

  let domains = [];
  if (typeof window.DomainManager !== 'undefined' && window.DomainManager.domains) {
    domains = window.DomainManager.domains;
  }

  const config = {
    emailDomains: domains,
    emailConfig: emailConfig,
    passwordMode: passwordMode,
    queryInterval: queryInterval,
  };

  try {
    localStorage.setItem('windsurfConfig', JSON.stringify(config));
    state.currentConfig = { ...state.currentConfig, ...config };
    console.log('✅ 配置已保存到 localStorage');
  } catch (e) {
    console.error('保存到 localStorage 失败:', e);
  }

  try {
    const result = await ipcRenderer.invoke('save-windsurf-config', config);
    if (result.success) {
      window.showCenterMessage('设置已保存', 'success');
      console.log('✅ 配置已保存到文件');
    } else {
      window.showCenterMessage(`保存失败: ${result.error}`, 'error');
      console.error('保存到文件失败:', result.error);
    }
  } catch (err) {
    console.error('保存设置异常:', err);
    window.showCenterMessage('保存成功（仅本地）', 'warning');
  }

  const saveBtn = document.getElementById('saveSettingsBtn');
  if (saveBtn) {
    saveBtn.style.display = 'none';
  }
}

// ==================== 设置变更检测 ====================

function initSettingsChangeListener() {
  const settingsView = document.getElementById('settingsView');
  if (!settingsView) return;

  settingsView.addEventListener('input', () => {
    const saveBtn = document.getElementById('saveSettingsBtn');
    if (saveBtn) saveBtn.style.display = 'inline-flex';
  });
  settingsView.addEventListener('change', () => {
    const saveBtn = document.getElementById('saveSettingsBtn');
    if (saveBtn) saveBtn.style.display = 'inline-flex';
  });
}

module.exports = {
  renderSettingsFromCurrentConfig,
  loadSettings,
  fillImapConfig,
  testImap,
  saveSettings,
  initSettingsChangeListener,
  windowExports: {
    renderSettingsFromCurrentConfig,
    loadSettings,
    fillImapConfig,
    testImap,
    saveSettings,
    initSettingsChangeListener,
  },
};
