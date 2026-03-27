// src/renderer/uiHelpers.js — 通用 UI 辅助函数（Toast、弹窗、复制、到期计算等）
'use strict';

const state = require('./state');

// ==================== Toast 提示 ====================

function showToast(message, type = 'info') {
  const existingToast = document.getElementById('toast');
  if (existingToast) existingToast.remove();
  
  const colors = {
    success: '#34c759',
    error: '#ff3b30',
    info: '#007aff',
    warning: '#ff9500'
  };
  
  const toastHTML = `
    <div id="toast" style="position: fixed; top: 80px; left: 50%; transform: translateX(-50%); background: ${colors[type]}; color: white; padding: 12px 24px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 10001; font-size: 14px; font-weight: 500; animation: slideDown 0.3s ease;">
      ${message}
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', toastHTML);
  
  setTimeout(() => {
    const toast = document.getElementById('toast');
    if (toast) {
      toast.style.animation = 'slideUp 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }
  }, 2000);
}

// ==================== 自定义弹窗 ====================

function showCustomAlert(message, type = 'info') {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  
  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog modern-modal';
  dialog.style.maxWidth = '400px';
  
  let iconHtml = '';
  let titleText = '';
  
  switch(type) {
    case 'success':
      iconHtml = '<i data-lucide="check-circle" style="width: 24px; height: 24px; color: #34c759;"></i>';
      titleText = '成功';
      break;
    case 'error':
      iconHtml = '<i data-lucide="x-circle" style="width: 24px; height: 24px; color: #ff3b30;"></i>';
      titleText = '错误';
      break;
    case 'warning':
      iconHtml = '<i data-lucide="alert-triangle" style="width: 24px; height: 24px; color: #ff9500;"></i>';
      titleText = '警告';
      break;
    default:
      iconHtml = '<i data-lucide="info" style="width: 24px; height: 24px; color: #007aff;"></i>';
      titleText = '提示';
  }
  
  dialog.innerHTML = `
    <div class="modern-modal-header">
      <div class="modal-title-row">
        ${iconHtml}
        <h3 class="modal-title">${titleText}</h3>
      </div>
      <button class="modal-close-btn" onclick="this.closest('.modal-overlay').remove()">
        <i data-lucide="x" style="width: 20px; height: 20px;"></i>
      </button>
    </div>
    <div class="modern-modal-body">
      <div style="font-size: 13px; line-height: 1.6; color: #1d1d1f;">${message}</div>
    </div>
    <div class="modern-modal-footer">
      <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">
        <i data-lucide="check" style="width: 16px; height: 16px;"></i>
        确定
      </button>
    </div>
  `;
  
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  
  if (window.lucide) {
    lucide.createIcons();
  }
  
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  };
}

// ==================== 居中提示消息 ====================

function showCenterMessage(message, type = 'info', duration = 3000) {
  const existing = document.querySelector('.center-message-overlay');
  if (existing) {
    existing.remove();
  }
  
  const overlay = document.createElement('div');
  overlay.className = 'center-message-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    animation: fadeIn 0.2s ease;
  `;
  
  const messageBox = document.createElement('div');
  messageBox.className = 'center-message-box';
  
  let bgColor, iconColor, icon;
  switch(type) {
    case 'success':
      bgColor = '#d1f2dd';
      iconColor = '#34c759';
      icon = '✓';
      break;
    case 'error':
      bgColor = '#ffd9d6';
      iconColor = '#ff3b30';
      icon = '✗';
      break;
    case 'warning':
      bgColor = '#fff3cd';
      iconColor = '#ff9500';
      icon = '⚠';
      break;
    default:
      bgColor = '#d1e7ff';
      iconColor = '#007aff';
      icon = 'ℹ';
  }
  
  messageBox.style.cssText = `
    background: white;
    border-radius: 12px;
    padding: 32px 40px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    max-width: 400px;
    text-align: center;
    animation: slideUp 0.3s ease;
  `;
  
  messageBox.innerHTML = `
    <div style="
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: ${bgColor};
      color: ${iconColor};
      font-size: 32px;
      font-weight: bold;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
    ">${icon}</div>
    <div style="
      font-size: 16px;
      color: #1d1d1f;
      line-height: 1.5;
      word-break: break-word;
    ">${message}</div>
  `;
  
  overlay.appendChild(messageBox);
  document.body.appendChild(overlay);
  
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  });
  
  if (duration > 0) {
    setTimeout(() => {
      overlay.style.animation = 'fadeOut 0.2s ease';
      setTimeout(() => overlay.remove(), 200);
    }, duration);
  }
}

// ==================== 导入结果对话框 ====================

function showImportResultDialog(message, successCount, failCount, duplicateCount, errorCount) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  
  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog modern-modal';
  dialog.style.maxWidth = '500px';
  
  let iconHtml = '';
  let titleText = '';
  
  if (failCount === 0 && errorCount === 0 && duplicateCount === 0) {
    iconHtml = '<i data-lucide="check-circle" style="width: 48px; height: 48px; color: #34c759;"></i>';
    titleText = '导入成功';
  } else if (successCount > 0) {
    iconHtml = '<i data-lucide="alert-circle" style="width: 48px; height: 48px; color: #ff9500;"></i>';
    titleText = '导入完成（部分成功）';
  } else {
    iconHtml = '<i data-lucide="x-circle" style="width: 48px; height: 48px; color: #ff3b30;"></i>';
    titleText = '导入失败';
  }
  
  dialog.innerHTML = `
    <div class="modern-modal-header">
      <div class="modal-title-row">
        ${iconHtml}
        <h3 class="modal-title">${titleText}</h3>
      </div>
      <button class="modal-close-btn" onclick="this.closest('.modal-overlay').remove()">
        <i data-lucide="x" style="width: 20px; height: 20px;"></i>
      </button>
    </div>
    <div class="modern-modal-body">
      <div style="white-space: pre-line; font-size: 13px; line-height: 1.8; color: #1d1d1f;">${message}</div>
    </div>
    <div class="modern-modal-footer">
      <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">
        <i data-lucide="check" style="width: 16px; height: 16px;"></i>
        确定
      </button>
    </div>
  `;
  
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  
  if (window.lucide) {
    lucide.createIcons();
  }
  
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  };
}

// ==================== 手动复制对话框 ====================

function showManualCopyDialog(text) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay active';
  modal.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-header">复制账号信息</div>
      <div style="margin: 16px 0;">
        <p style="margin-bottom: 12px; color: #86868b; font-size: 12px;">
          自动复制失败，请手动选择并复制以下内容：
        </p>
        <textarea readonly style="width: 100%; height: 80px; font-family: monospace; font-size: 12px; padding: 8px; border: 1px solid #d2d2d7; border-radius: 6px; resize: none;">${text}</textarea>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">确定</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  const textarea = modal.querySelector('textarea');
  setTimeout(() => {
    textarea.focus();
    textarea.select();
  }, 100);
}

// ==================== 复制功能 ====================

function copyAccount(email, password) {
  const text = `邮箱: ${email}\n密码: ${password}`;
  
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showCustomAlert('账号信息已复制到剪贴板！', 'success');
    }).catch(() => {
      fallbackCopyToClipboard(text);
    });
  } else {
    fallbackCopyToClipboard(text);
  }
}

function fallbackCopyToClipboard(text) {
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    
    textArea.focus();
    textArea.select();
    
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    
    if (successful) {
      showCustomAlert('账号信息已复制到剪贴板！', 'success');
    } else {
      copyWithElectron(text);
    }
  } catch (err) {
    console.error('复制失败:', err);
    copyWithElectron(text);
  }
}

async function copyWithElectron(text) {
  try {
    const result = await window.ipcRenderer.invoke('copy-to-clipboard', text);
    if (result.success) {
      showCustomAlert('账号信息已复制到剪贴板！', 'success');
    } else {
      showManualCopyDialog(text);
    }
  } catch (err) {
    console.error('Electron复制失败:', err);
    showManualCopyDialog(text);
  }
}

// ==================== 到期时间计算 ====================

function calculateExpiry(createdAt, expiresAt) {
  let expiry;
  
  if (expiresAt) {
    expiry = new Date(expiresAt);
  } else if (createdAt) {
    const created = new Date(createdAt);
    expiry = new Date(created);
    expiry.setDate(expiry.getDate() + 13);
  } else {
    return {
      expiryDate: null,
      daysLeft: null,
      isExpired: false,
      expiryText: '-',
      expiryColor: '#999999'
    };
  }
  
  const now = new Date();
  const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
  const isExpired = daysLeft <= 0;
  
  return {
    expiryDate: expiry,
    daysLeft,
    isExpired,
    expiryText: isExpired ? '已到期' : `剩余${daysLeft}天`,
    expiryColor: isExpired ? '#e74c3c' : (daysLeft <= 3 ? '#ff9500' : '#007aff')
  };
}

// ==================== 删除模式 ====================

function toggleDeleteMode() {
  state.deleteMode = !state.deleteMode;
  const btn = document.getElementById('deleteModeBtn');
  if (btn) {
    btn.textContent = state.deleteMode ? '删除账号：开' : '删除账号：关';
    btn.className = state.deleteMode ? 'btn btn-danger' : 'btn btn-warning';
  }
}

// ==================== 空桩函数 ====================

function updateSelectedAccounts() {}
function selectAllAccounts() {}
function deselectAllAccounts() {}

// ==================== 导出 ====================

module.exports = {
  showToast,
  showCustomAlert,
  showCenterMessage,
  showImportResultDialog,
  showManualCopyDialog,
  copyAccount,
  fallbackCopyToClipboard,
  copyWithElectron,
  calculateExpiry,
  toggleDeleteMode,
  updateSelectedAccounts,
  selectAllAccounts,
  deselectAllAccounts,
  windowExports: {
    showToast,
    showCustomAlert,
    showCenterMessage,
    showImportResultDialog,
    showManualCopyDialog,
    copyAccount,
    fallbackCopyToClipboard,
    copyWithElectron,
    calculateExpiry,
    toggleDeleteMode,
    updateSelectedAccounts,
    selectAllAccounts,
    deselectAllAccounts,
  },
};
