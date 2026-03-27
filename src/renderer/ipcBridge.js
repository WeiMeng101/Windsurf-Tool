// ipcBridge.js - IPC 通信与维护模式拦截
const { ipcRenderer, shell } = require('electron');
const state = require('./state');

// 设置 window.ipcRenderer 供全局使用
window.ipcRenderer = ipcRenderer;

/**
 * 带维护模式检测的 IPC 调用包装器
 */
async function safeIpcInvoke(channel, ...args) {
  if (state.isMaintenanceModeActive && !isMaintenanceAllowedOperation(channel)) {
    showCustomAlert('服务器维护中，该功能暂时不可用', 'warning');
    return { success: false, error: '服务器维护中' };
  }

  try {
    const result = await ipcRenderer.invoke(channel, ...args);

    if (result && result.error && result.error.includes('维护')) {
      console.log('🔧 API调用检测到维护模式');
      setTimeout(async () => {
        try {
          const maintenanceResult = await ipcRenderer.invoke('check-maintenance-mode');
          if (maintenanceResult.success && maintenanceResult.inMaintenance) {
            activateMaintenanceMode({
              enabled: maintenanceResult.maintenanceInfo.enabled,
              message: maintenanceResult.maintenanceInfo.message || '服务器正在维护中，请稍后再试',
              timestamp: new Date().toISOString()
            });
          }
        } catch (error) {
          console.error('维护模式检查失败:', error);
        }
      }, 100);
    }

    return result;
  } catch (error) {
    console.error(`IPC调用失败 (${channel}):`, error);
    throw error;
  }
}

function isMaintenanceAllowedOperation(channel) {
  const allowedOperations = ['check-maintenance-mode', 'exit-maintenance-mode'];
  return allowedOperations.includes(channel);
}

function setupMaintenanceInterceptors() {
  document.addEventListener('click', (event) => {
    if (state.isMaintenanceModeActive) {
      const target = event.target;
      if (target.closest('#maintenanceModal')) return;
      if (target.tagName === 'BUTTON' || target.closest('button')) {
        event.preventDefault();
        event.stopPropagation();
        showCustomAlert('服务器维护中，该功能暂时不可用', 'warning');
        return false;
      }
    }
  }, true);

  document.addEventListener('submit', (event) => {
    if (state.isMaintenanceModeActive) {
      event.preventDefault();
      event.stopPropagation();
      showCustomAlert('服务器维护中，无法提交表单', 'warning');
      return false;
    }
  }, true);

  document.addEventListener('click', (event) => {
    if (state.isMaintenanceModeActive) {
      const target = event.target;
      if (target.tagName === 'A' || target.closest('a')) {
        if (!target.closest('#maintenanceModal')) {
          event.preventDefault();
          event.stopPropagation();
          showCustomAlert('服务器维护中，链接暂时不可用', 'warning');
          return false;
        }
      }
    }
  }, true);
}

// 延迟引用——避免循环依赖，在调用时才查找
function showCustomAlert(msg, type) {
  if (typeof window.showCustomAlert === 'function') {
    window.showCustomAlert(msg, type);
  }
}
function activateMaintenanceMode(info) {
  if (typeof window.activateMaintenanceMode === 'function') {
    window.activateMaintenanceMode(info);
  }
}

module.exports = {
  ipcRenderer,
  shell,
  safeIpcInvoke,
  isMaintenanceAllowedOperation,
  setupMaintenanceInterceptors,
  windowExports: {
    safeIpcInvoke,
    setupMaintenanceInterceptors,
  },
};
