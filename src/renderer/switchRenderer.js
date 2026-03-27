'use strict';

const state = require('./state');
const emailConfig = require('./emailConfig');
const CodexManager = require('./codexManager');

// ==================== Tab switching ====================

function switchTabLogic(tabName) {
  if (tabName === 'register') {
    if (typeof window.loadAccounts === 'function') {
      window.loadAccounts();
    }
  } else if (tabName === 'switch') {
    if (typeof window.loadAccountsForSwitch === 'function') {
      window.loadAccountsForSwitch();
    }
    if (typeof window.loadCurrentMachineId === 'function') {
      window.loadCurrentMachineId();
    }
  } else if (tabName === 'token') {
    if (typeof window.loadTokenModule === 'function') {
      window.loadTokenModule();
    }
  } else if (tabName === 'codexManage') {
    CodexManager.init();
  } else if (tabName === 'settings') {
    emailConfig.loadSettings();
  }
}

function switchTab(tabName) {
  const isNewUI = document.querySelector('.app-container');

  if (!isNewUI) {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    if (event && event.target) {
      event.target.classList.add('active');
    }
    const el = document.getElementById(tabName);
    if (el) el.classList.add('active');
  }

  switchTabLogic(tabName);
}

// ==================== IPC event listeners ====================

function setupSwitchIpcListeners() {
  window.ipcRenderer.on('switch-error', (_event, error) => {
    console.error('收到切换错误:', error);
    const statusEl = document.getElementById('switchStatus');
    if (statusEl) {
      statusEl.innerHTML = `
        <div class="status-message status-error">
          <strong>切换失败：</strong>${error.message}<br><br>
          <details>
            <summary>查看详细错误信息</summary>
            <pre style="margin-top:10px; padding:10px; background:#f5f5f5; border-radius:4px; overflow-x:auto;">${error.stack || error.message}</pre>
          </details>
        </div>
      `;
    }
  });
}

// ==================== Module exports ====================

module.exports = {
  windowExports: {
    switchTabLogic,
    switchTab,
    setupSwitchIpcListeners,
  },
};
