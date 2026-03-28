'use strict';

const state = require('./state');
const uiHelpers = require('./uiHelpers');
const modals = require('./modals');

// ==================== Module-private state ====================
let isRegistering = false;

// ==================== Registration progress helpers ====================
// These functions delegate to window.* globals set by js/accountManager.js or index.html
// Using window.* because they are defined externally and may not be available at require time

function showRegisterProgress() {
  if (typeof window.showRegisterProgress === 'function') {
    window.showRegisterProgress();
  }
}

function hideRegisterProgress() {
  if (typeof window.hideRegisterProgress === 'function') {
    window.hideRegisterProgress();
  }
}

function updateRegisterStats(total, success, fail, progress) {
  if (typeof window.updateRegisterStats === 'function') {
    window.updateRegisterStats(total, success, fail, progress);
  }
}

function addRegisterLog(message, type = 'info') {
  if (typeof window.addRegisterLog === 'function') {
    window.addRegisterLog(message, type);
  }
}

// ==================== Batch registration ====================

async function startBatchRegister() {
  if (isRegistering) {
    addRegisterLog('批量注册正在进行中，请勿重复点击', 'warning');
    return;
  }

  const count = parseInt(document.getElementById('registerCount').value);
  const threads = parseInt(document.getElementById('registerThreads').value);

  if (!count || count < 1) {
    window.showCustomAlert('请输入有效的注册数量', 'warning');
    return;
  }
  if (!threads || threads < 1) {
    window.showCustomAlert('请输入有效的并发数', 'warning');
    return;
  }
  if (!state.currentConfig.emailConfig) {
    window.showCustomAlert('请先在系统设置中配置IMAP邮箱', 'warning');
    return;
  }

  showRegisterProgress();

  isRegistering = true;
  updateRegisterStats(count, 0, 0, 0);
  addRegisterLog(`开始批量注册，总数量: ${count}, 并发数: ${threads}`, 'info');

  try {
    if (window.DomainManager && window.DomainManager.init) {
      await window.DomainManager.init();
      addRegisterLog(`已刷新域名配置: ${state.currentConfig.emailDomains.join(', ')}`, 'info');
    }

    const result = await window.ipcRenderer.invoke('batch-register', {
      count,
      threads,
      ...state.currentConfig
    });

    const successCount = result.filter(r => r.success).length;
    const failedCount = result.filter(r => !r.success).length;

    updateRegisterStats(count, successCount, failedCount, 100);

    result.forEach((r, index) => {
      if (r.success) {
        addRegisterLog(`[${index + 1}/${count}] 注册成功: ${r.email}`, 'success');
      } else {
        addRegisterLog(`[${index + 1}/${count}] 注册失败: ${r.error || '未知错误'}`, 'error');
      }
    });

    addRegisterLog(`批量注册完成！成功: ${successCount}, 失败: ${failedCount}`, successCount > 0 ? 'success' : 'error');

    if (typeof window.loadAccounts === 'function') {
      window.loadAccounts();
    }
  } catch (error) {
    console.error('批量注册错误:', error);
    addRegisterLog(`批量注册失败: ${error.message || '未知错误'}`, 'error');
  } finally {
    isRegistering = false;
  }
}

async function cancelBatchRegister() {
  if (!isRegistering) return;
  addRegisterLog('正在取消批量注册...', 'warning');

  try {
    const result = await window.ipcRenderer.invoke('cancel-batch-register');
    if (result.success) {
      addRegisterLog('批量注册已取消', 'info');
      isRegistering = false;
    } else {
      addRegisterLog(`取消失败: ${result.message || '未知错误'}`, 'error');
    }
  } catch (error) {
    console.error('取消注册错误:', error);
    addRegisterLog(`取消失败: ${error.message}`, 'error');
  }
}

// ==================== IPC event listeners ====================
// These are set up by renderer.js after module load

function setupRegistrationIpcListeners() {
  window.ipcRenderer.on('registration-progress', (_event, progress) => {
    const percent = Math.round((progress.current / progress.total) * 100);
    updateRegisterStats(progress.total, progress.success || 0, progress.failed || 0, percent);
    addRegisterLog(`进度: ${progress.current}/${progress.total} (${percent}%)`, 'info');
  });

  window.ipcRenderer.on('registration-log', (_event, log) => {
    if (log && log.message) {
      addRegisterLog(log.message, log.type || 'info');
    } else if (typeof log === 'string') {
      addRegisterLog(log, 'info');
    }
  });
}

// ==================== Module exports ====================

module.exports = {
  setupRegistrationIpcListeners,
  windowExports: {
    startBatchRegister,
    cancelBatchRegister,
    showRegisterProgress,
    hideRegisterProgress,
    updateRegisterStats,
    addRegisterLog,
    setupRegistrationIpcListeners,
  },
};
