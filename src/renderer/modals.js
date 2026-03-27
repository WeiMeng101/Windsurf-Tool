// src/renderer/modals.js - 弹窗和对话框功能模块
'use strict';

const { ipcRenderer, shell } = require('electron');
const state = require('./state');

// 模块级状态：版本更新信息（仅本模块使用）
let versionUpdateInfo = null;

// ==================== API 无法访问弹窗 ====================

function showApiUnavailableModal(errorInfo) {
  const modalHTML = `
    <div id="apiUnavailableModal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;">
      <div style="background: white; border-radius: 16px; padding: 32px; max-width: 500px; text-align: center; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);">
        <div style="margin-bottom: 16px;"><i data-lucide="wifi-off" style="width: 64px; height: 64px; color: #ff3b30;"></i></div>
        <h2 style="margin: 0 0 16px 0; font-size: 24px; color: #ff3b30;">无法连接到服务器</h2>
        <p style="color: #86868b; margin: 0 0 24px 0; line-height: 1.6;">
          ${errorInfo.message || '无法连接到服务器，请检查网络连接后重启软件'}
        </p>
        <div style="background: #fff3e0; border: 1px solid #ff9800; border-radius: 8px; padding: 16px; margin-bottom: 16px; display: flex; align-items: center; gap: 12px;">
          <i data-lucide="alert-triangle" style="width: 20px; height: 20px; color: #ff9800; flex-shrink: 0;"></i>
          <p style="margin: 0; color: #e65100; font-size: 14px; text-align: left;">
            软件需要连接到服务器才能使用<br>
            请检查您的网络连接后重新启动软件
          </p>
        </div>
        <div style="background: #e3f2fd; border: 1px solid #2196f3; border-radius: 8px; padding: 16px; margin-bottom: 24px; display: flex; align-items: center; gap: 12px;">
          <i data-lucide="shield" style="width: 20px; height: 20px; color: #1976d2; flex-shrink: 0;"></i>
          <p style="margin: 0; color: #0d47a1; font-size: 14px; text-align: left;">
            <strong>如果您开启了代理/VPN（魔法）：</strong><br>
            请关闭代理后重试，或将软件添加到代理白名单
          </p>
        </div>
        <div style="display: flex; gap: 12px; justify-content: center;">
          <button id="retryConnectionBtn" onclick="retryConnection()" style="background: linear-gradient(180deg, #34c759 0%, #28a745 100%); color: white; border: none; padding: 12px 32px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(52, 199, 89, 0.3); transition: all 0.2s; display: flex; align-items: center; gap: 8px;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(52, 199, 89, 0.4)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 8px rgba(52, 199, 89, 0.3)'">
            <i data-lucide="refresh-cw" style="width: 16px; height: 16px;"></i>
            <span>重试连接</span>
          </button>
          <button id="apiUnavailableExitBtn" style="background: linear-gradient(180deg, #ff3b30 0%, #d32f2f 100%); color: white; border: none; padding: 12px 32px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(255, 59, 48, 0.3); transition: all 0.2s;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(255, 59, 48, 0.4)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 8px rgba(255, 59, 48, 0.3)'">
            退出软件
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);

  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

  const exitBtn = document.getElementById('apiUnavailableExitBtn');
  if (exitBtn) {
    exitBtn.addEventListener('click', () => {
      window.quitApplication();
    });
  }

  document.body.style.pointerEvents = 'none';
  document.getElementById('apiUnavailableModal').style.pointerEvents = 'auto';

  state.isForceUpdateActive = true;
  window.setupForceUpdateProtection();
}

// 重试连接到服务器
async function retryConnection() {
  const retryBtn = document.getElementById('retryConnectionBtn');
  const modal = document.getElementById('apiUnavailableModal');

  if (!retryBtn) return;

  retryBtn.disabled = true;
  retryBtn.style.opacity = '0.6';
  retryBtn.style.cursor = 'not-allowed';
  retryBtn.innerHTML = '<i data-lucide="loader" style="width: 16px; height: 16px; animation: spin 1s linear infinite;"></i><span>正在重试...</span>';

  const spinStyle = document.createElement('style');
  spinStyle.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
  document.head.appendChild(spinStyle);

  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

  try {
    console.log('🔄 用户手动重试连接到服务器...');
    const result = await ipcRenderer.invoke('check-for-updates');

    if (result.success) {
      console.log('✅ 重试成功，服务器连接正常');
      retryBtn.innerHTML = '<i data-lucide="check" style="width: 16px; height: 16px;"></i><span>连接成功！</span>';
      retryBtn.style.background = 'linear-gradient(180deg, #34c759 0%, #28a745 100%)';
      if (typeof lucide !== 'undefined') lucide.createIcons();

      setTimeout(() => {
        if (modal) modal.remove();
        document.body.style.pointerEvents = 'auto';
        state.isForceUpdateActive = false;
        if (typeof window.refreshAllData === 'function') window.refreshAllData();
        window.showCustomAlert('服务器连接已恢复！', 'success');
      }, 1000);
    } else {
      throw new Error(result.error || '连接失败');
    }
  } catch (error) {
    console.error('❌ 重试连接失败:', error);
    retryBtn.disabled = false;
    retryBtn.style.opacity = '1';
    retryBtn.style.cursor = 'pointer';
    retryBtn.innerHTML = '<i data-lucide="refresh-cw" style="width: 16px; height: 16px;"></i><span>重试连接</span>';
    retryBtn.style.background = 'linear-gradient(180deg, #34c759 0%, #28a745 100%)';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    window.showCustomAlert('连接失败，请检查网络后再试\n\n错误信息: ' + error.message, 'error');
  }
}

// ==================== 版本更新弹窗 ====================

function showVersionUpdateModal(versionInfo) {
  if (!versionInfo) {
    console.error('❌ 版本信息为空，无法显示更新弹窗');
    return;
  }
  if (!versionInfo.currentVersion || !versionInfo.latestVersion) {
    console.error('❌ 版本信息不完整，无法显示更新弹窗:', versionInfo);
    return;
  }

  const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;
  if (!versionPattern.test(versionInfo.latestVersion)) {
    console.error('❌ 最新版本号格式异常:', versionInfo.latestVersion);
    return;
  }
  const versionParts = versionInfo.latestVersion.split('.').map(Number);
  if (versionParts.some(part => part > 100)) {
    console.error('❌ 版本号数值异常:', versionInfo.latestVersion);
    return;
  }

  versionUpdateInfo = versionInfo;

  const modal = document.getElementById('versionUpdateModal');
  const title = document.getElementById('versionUpdateTitle');
  const content = document.getElementById('versionUpdateContent');
  const currentVersion = document.getElementById('currentVersionDisplay');
  const latestVersion = document.getElementById('latestVersionDisplay');
  const downloadBtn = document.getElementById('versionDownloadBtn');
  const closeBtn = document.getElementById('versionCloseBtn');
  const notice = document.getElementById('versionNotice');

  if (!modal) return;

  console.log('✅ 显示版本更新弹窗:', versionInfo);

  if (versionInfo.forceUpdate) {
    title.textContent = '强制更新';
  } else {
    title.textContent = '发现新版本';
  }

  let updateMessage = '';
  if (versionInfo.updateMessage) {
    if (typeof versionInfo.updateMessage === 'string') {
      updateMessage = versionInfo.updateMessage;
    } else if (versionInfo.updateMessage.content) {
      updateMessage = versionInfo.updateMessage.content;
    } else {
      updateMessage = formatUpdateMessage(versionInfo.updateMessage);
    }
  } else {
    updateMessage = versionInfo.forceUpdate
      ? '当前版本已不再支持，请立即下载最新版本以继续使用。'
      : '发现新版本，建议您更新以获得更好的体验和新功能。';
  }
  content.textContent = updateMessage;

  if (versionInfo.currentVersion) currentVersion.textContent = versionInfo.currentVersion;
  if (versionInfo.latestVersion) latestVersion.textContent = versionInfo.latestVersion;

  if (versionInfo.forceUpdate) {
    downloadBtn.innerHTML = '<i data-lucide="alert-triangle" style="width: 16px; height: 16px; margin-right: 8px;"></i>立即更新（必需）';
    if (closeBtn) {
      closeBtn.style.display = 'inline-block';
      closeBtn.textContent = '退出程序';
      const newCloseBtn = closeBtn.cloneNode(true);
      closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
      newCloseBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        window.quitApplication();
      });
      newCloseBtn.className = 'btn btn-secondary';
    }
  } else {
    downloadBtn.innerHTML = '<i data-lucide="download" style="width: 16px; height: 16px; margin-right: 8px;"></i>立即下载最新版本';
    if (versionInfo.isSupported === false) {
      if (closeBtn) {
        closeBtn.style.display = 'inline-block';
        closeBtn.textContent = '退出程序';
        const newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
        newCloseBtn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          window.quitApplication();
        });
        newCloseBtn.className = 'btn btn-secondary';
      }
    } else {
      if (closeBtn) {
        closeBtn.style.display = 'inline-block';
        closeBtn.textContent = '稍后更新';
        const newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
        newCloseBtn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          closeVersionUpdateModal();
        });
        newCloseBtn.className = 'btn btn-secondary';
      }
    }
  }

  if (versionInfo.forceUpdate) {
    notice.textContent = '当前版本已停止支持，请立即更新或退出程序';
    notice.parentElement.style.background = '#ffebee';
    notice.parentElement.style.borderColor = '#f44336';
    notice.style.color = '#d32f2f';
  } else if (versionInfo.isSupported === false) {
    notice.textContent = '当前版本已进入维护模式，请立即更新或退出程序';
    notice.parentElement.style.background = '#fff3e0';
    notice.parentElement.style.borderColor = '#ff9800';
    notice.style.color = '#e65100';
  } else {
    notice.textContent = '为了确保最佳体验和安全性，强烈建议及时更新到最新版本';
    notice.parentElement.style.background = '#fff8e1';
    notice.parentElement.style.borderColor = '#ffcc02';
    notice.style.color = '#f57c00';
  }

  modal.style.display = 'flex';
  modal.style.pointerEvents = 'auto';
  const modalDialog = modal.querySelector('.modal-dialog');
  if (modalDialog) modalDialog.style.pointerEvents = 'auto';

  if (versionInfo.forceUpdate || versionInfo.isSupported === false) {
    state.isForceUpdateActive = true;
    window.setupForceUpdateProtection();
    ipcRenderer.send('set-force-update-status', true);
    document.body.style.pointerEvents = 'none';
    modal.style.pointerEvents = 'auto';
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function formatUpdateMessage(updateMessage) {
  if (typeof updateMessage === 'string') return updateMessage;

  let formatted = '';
  if (updateMessage.title) formatted += `${updateMessage.title}\n\n`;
  if (updateMessage.features && updateMessage.features.length > 0) {
    formatted += '✨ 新功能:\n';
    updateMessage.features.forEach(f => { formatted += `• ${f}\n`; });
    formatted += '\n';
  }
  if (updateMessage.fixes && updateMessage.fixes.length > 0) {
    formatted += '🐛 修复:\n';
    updateMessage.fixes.forEach(f => { formatted += `• ${f}\n`; });
    formatted += '\n';
  }
  if (updateMessage.improvements && updateMessage.improvements.length > 0) {
    formatted += '⚡ 改进:\n';
    updateMessage.improvements.forEach(i => { formatted += `• ${i}\n`; });
    formatted += '\n';
  }
  if (updateMessage.notes) formatted += `📝 说明:\n${updateMessage.notes}`;
  return formatted.trim() || '发现新版本，建议您更新以获得更好的体验。';
}

function closeVersionUpdateModal() {
  if (versionUpdateInfo && versionUpdateInfo.forceUpdate) {
    window.showCustomAlert('当前版本已停止支持，必须更新才能继续使用。\n\n请点击"立即更新"按钮下载最新版本。', 'warning');
    return;
  }
  if (versionUpdateInfo && versionUpdateInfo.isSupported === false) {
    window.showCustomAlert('当前版本已进入维护模式，为了您的使用安全，强烈建议立即更新。\n\n请点击"立即下载最新版本"按钮。', 'warning');
    return;
  }

  const modal = document.getElementById('versionUpdateModal');
  if (modal) {
    modal.style.display = 'none';
    document.body.style.pointerEvents = 'auto';
    console.log('✕ 用户关闭了版本更新弹窗');
  }
  versionUpdateInfo = null;
}

// ==================== 维护模式弹窗 ====================

function showMaintenanceModal(maintenanceInfo) {
  console.log('显示维护模式弹窗:', maintenanceInfo);

  const existingModal = document.getElementById('maintenanceModal');
  if (existingModal) existingModal.remove();

  const modalHTML = `
    <div id="maintenanceModal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="background: white; border-radius: 16px; padding: 40px; max-width: 500px; text-align: center; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);">
        <div style="margin-bottom: 24px;">
          <i data-lucide="wrench" style="width: 64px; height: 64px; color: #ff9500; animation: pulse 2s infinite;"></i>
        </div>
        <h2 style="margin: 0 0 16px 0; font-size: 24px; color: #1d1d1f; font-weight: 600;">服务器维护中</h2>
        <p style="color: #86868b; margin: 0 0 24px 0; font-size: 16px; line-height: 1.6;">
          ${maintenanceInfo.message || '服务器正在维护中，请稍后再试'}
        </p>
        <div style="background: #fff3e0; border: 1px solid #ff9800; border-radius: 8px; padding: 16px; margin-bottom: 24px; display: flex; align-items: center; gap: 12px;">
          <i data-lucide="clock" style="width: 20px; height: 20px; color: #ff9800; flex-shrink: 0;"></i>
          <p style="margin: 0; color: #e65100; font-size: 14px; text-align: left;">
            检测时间: ${new Date(maintenanceInfo.timestamp || Date.now()).toLocaleString('zh-CN')}
          </p>
        </div>
        <div style="display: flex; gap: 12px; justify-content: center;">
          <button id="maintenanceRetryBtn" style="background: linear-gradient(180deg, #34c759 0%, #2ea44f 100%); color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; box-shadow: 0 2px 8px rgba(52, 199, 89, 0.3); display: flex; align-items: center; gap: 8px;">
            <i data-lucide="refresh-cw" style="width: 16px; height: 16px;"></i>
            <span>重新检查</span>
          </button>
          <button id="maintenanceExitBtn" style="background: linear-gradient(180deg, #ff3b30 0%, #d32f2f 100%); color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; box-shadow: 0 2px 8px rgba(255, 59, 48, 0.3); display: flex; align-items: center; gap: 8px;">
            <i data-lucide="x-circle" style="width: 16px; height: 16px;"></i>
            <span>退出应用</span>
          </button>
        </div>
      </div>
    </div>
    <style>
      @keyframes pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.1); opacity: 0.8; }
      }
    </style>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
  if (typeof lucide !== 'undefined') lucide.createIcons();

  const retryButton = document.getElementById('maintenanceRetryBtn');
  if (retryButton) {
    retryButton.addEventListener('click', async () => {
      retryButton.disabled = true;
      retryButton.innerHTML = '<i data-lucide="loader-2" style="width: 16px; height: 16px; animation: spin 1s linear infinite;"></i><span>检查中...</span>';
      if (typeof lucide !== 'undefined') lucide.createIcons();
      setTimeout(() => {
        retryButton.disabled = false;
        retryButton.innerHTML = '<i data-lucide="refresh-cw" style="width: 16px; height: 16px;"></i><span>重新检查</span>';
        if (typeof lucide !== 'undefined') lucide.createIcons();
        window.showCustomAlert('请等待系统自动检测维护模式恢复', 'info');
      }, 2000);
    });
  }

  const exitButton = document.getElementById('maintenanceExitBtn');
  if (exitButton) {
    exitButton.addEventListener('click', async () => {
      const confirmed = await window.showCustomConfirm({
        title: '退出应用',
        message: '确定要退出应用吗？',
        subMessage: false,
        confirmText: '退出',
        type: 'warning'
      });
      if (confirmed) window.quitApplication();
    });
  }

  document.body.style.pointerEvents = 'none';
  document.getElementById('maintenanceModal').style.pointerEvents = 'auto';
  window.disableAllFunctions();
}

// ==================== 账号详情弹窗 ====================

async function showAccountDetailsModal(account) {
  let usageInfo = null;
  if (account.refreshToken && typeof window.AccountQuery !== 'undefined') {
    try {
      usageInfo = await window.AccountQuery.queryAccount(account);
    } catch (error) {
      console.error('查询积分失败:', error);
    }
  }

  const modalHTML = `
    <div class="modal-overlay" id="accountDetailsModal" onclick="if(event.target===this) this.remove()">
      <div class="modal-content" style="max-width: 600px; max-height: 80vh; overflow-y: auto;">
        <div class="modal-header">
          <h2 style="margin: 0; font-size: 20px;">账号详情</h2>
          <button class="modal-close" onclick="document.getElementById('accountDetailsModal').remove()">
            <i data-lucide="x" style="width: 20px; height: 20px;"></i>
          </button>
        </div>
        <div class="modal-body" style="padding: 24px;">
          <div style="display: flex; flex-direction: column; gap: 16px;">
            <div class="detail-section">
              <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #1d1d1f;">基本信息</h3>
              <div class="detail-grid">
                <div class="detail-item"><span class="detail-label">邮箱:</span><span class="detail-value">${account.email || '-'}</span></div>
                <div class="detail-item"><span class="detail-label">密码:</span><span class="detail-value">${account.password || '-'}</span></div>
                <div class="detail-item"><span class="detail-label">创建时间:</span><span class="detail-value">${account.createdAt ? new Date(account.createdAt).toLocaleString('zh-CN') : '-'}</span></div>
              </div>
            </div>
            ${usageInfo && usageInfo.success ? `
            <div class="detail-section">
              <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #1d1d1f;">订阅信息</h3>
              <div class="detail-grid">
                <div class="detail-item"><span class="detail-label">订阅类型:</span><span class="detail-value" style="color: ${usageInfo.planName === 'Pro' ? '#007aff' : '#86868b'};">${usageInfo.planName}</span></div>
                <div class="detail-item"><span class="detail-label">已用积分:</span><span class="detail-value">${usageInfo.usedCredits}</span></div>
                <div class="detail-item"><span class="detail-label">总积分:</span><span class="detail-value">${usageInfo.totalCredits}</span></div>
                <div class="detail-item"><span class="detail-label">使用率:</span><span class="detail-value" style="color: ${usageInfo.usagePercentage >= 80 ? '#ff3b30' : usageInfo.usagePercentage >= 50 ? '#ff9500' : '#34c759'};">${usageInfo.usagePercentage}%</span></div>
              </div>
            </div>
            ` : ''}
            ${account.apiKey ? `
            <div class="detail-section">
              <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #1d1d1f;">API 信息</h3>
              <div class="detail-grid">
                <div class="detail-item" style="grid-column: 1 / -1;"><span class="detail-label">API Key:</span><span class="detail-value" style="font-family: monospace; font-size: 12px; word-break: break-all;">${account.apiKey}</span></div>
                <div class="detail-item" style="grid-column: 1 / -1;"><span class="detail-label">API Server:</span><span class="detail-value" style="font-size: 12px;">${account.apiServerUrl || '-'}</span></div>
                <div class="detail-item" style="grid-column: 1 / -1;"><span class="detail-label">Refresh Token:</span><span class="detail-value" style="font-family: monospace; font-size: 12px; word-break: break-all;">${account.refreshToken || '-'}</span></div>
              </div>
            </div>
            ` : ''}
            <div class="detail-section">
              <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #1d1d1f;">完整 JSON 数据</h3>
              <pre style="background: #f5f5f7; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; margin: 0;">${JSON.stringify(account, null, 2)}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ==================== 导入账号 ====================

async function showImportAccountForm() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';

  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog modern-modal';
  dialog.style.maxWidth = '600px';

  dialog.innerHTML = `
    <div class="modern-modal-header">
      <div class="modal-title-row">
        <i data-lucide="upload" style="width: 24px; height: 24px; color: #007aff;"></i>
        <h3 class="modal-title">导入账号</h3>
      </div>
      <button class="modal-close-btn" onclick="this.closest('.modal-overlay').remove()">
        <i data-lucide="x" style="width: 20px; height: 20px;"></i>
      </button>
    </div>
    <div class="modern-modal-body">
      <div style="margin-bottom: 20px;">
        <h4 style="font-size: 14px; font-weight: 600; color: #1d1d1f; margin-bottom: 12px;">导入账号格式说明：</h4>
        <ul style="list-style: none; padding: 0; margin: 0; font-size: 13px; color: #1d1d1f; line-height: 1.8;">
          <li style="display: flex; align-items: flex-start; margin-bottom: 8px;">
            <span style="color: #007aff; margin-right: 8px;">•</span>
            <span>仅支持 JSON 格式文件 (.json)</span>
          </li>
          <li style="display: flex; align-items: flex-start; margin-bottom: 8px;">
            <span style="color: #007aff; margin-right: 8px;">•</span>
            <span>JSON 根节点必须为数组</span>
          </li>
          <li style="display: flex; align-items: flex-start; margin-bottom: 8px;">
            <span style="color: #007aff; margin-right: 8px;">•</span>
            <span>每个账号对象需包含以下字段：</span>
          </li>
          <li style="padding-left: 24px; margin-bottom: 4px; font-size: 12px; color: #6e6e73;">- email: 邮箱地址（必填）</li>
          <li style="padding-left: 24px; margin-bottom: 4px; font-size: 12px; color: #6e6e73;">- password: 密码（必填）</li>
          <li style="padding-left: 24px; margin-bottom: 4px; font-size: 12px; color: #6e6e73;">- apiKey: Token（可选）</li>
        </ul>
      </div>
      <div style="background: #f5f5f7; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
        <div style="font-size: 12px; font-weight: 600; color: #6e6e73; margin-bottom: 8px;">示例格式：</div>
        <pre style="background: #ffffff; border: 1px solid #e5e5ea; border-radius: 6px; padding: 12px; margin: 0; font-size: 12px; color: #1d1d1f; overflow-x: auto; font-family: 'Monaco', 'Menlo', monospace;">[
  {
    "email": "user@example.com",
    "password": "password123",
    "apiKey": "token_here"
  }
]</pre>
      </div>
      <div class="form-tip" style="background: #e3f2fd; border-color: #90caf9; color: #1976d2;">
        <i data-lucide="info" style="width: 16px; height: 16px; flex-shrink: 0;"></i>
        <span>点击确定后将打开文件选择器，请选择要导入的 JSON 文件</span>
      </div>
    </div>
    <div class="modern-modal-footer">
      <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">
        <i data-lucide="x" style="width: 16px; height: 16px;"></i>
        取消
      </button>
      <button class="btn btn-primary" id="confirmImportBtn">
        <i data-lucide="check" style="width: 16px; height: 16px;"></i>
        确定
      </button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  if (window.lucide) lucide.createIcons();

  document.getElementById('confirmImportBtn').onclick = () => {
    overlay.remove();
    selectImportFile();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

function selectImportFile() {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.style.display = 'none';

  fileInput.onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith('.json')) {
      window.showCustomAlert('请选择 JSON 格式文件（.json）', 'error');
      return;
    }
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      window.showCustomAlert('文件过大，请选择小于 10MB 的文件', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onerror = function() {
      window.showCustomAlert('文件读取失败，请检查文件是否损坏或权限是否正确', 'error');
    };
    reader.onload = async function(e) {
      try {
        await processImportFile(e.target.result, file.name);
      } catch (error) {
        console.error('处理文件失败:', error);
        window.showCustomAlert(`处理文件失败: ${error.message}`, 'error');
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  document.body.appendChild(fileInput);
  fileInput.click();
  document.body.removeChild(fileInput);
}

async function processImportFile(content, filename = 'unknown') {
  if (!content || content.trim() === '') {
    window.showCustomAlert('文件内容为空，请选择有效的 JSON 文件！', 'error');
    return;
  }

  console.log(`📥 开始处理导入文件: ${filename}`);

  const accounts = [];
  const errors = [];
  let parsed;

  try {
    const cleanContent = content.replace(/^\uFEFF/, '');
    parsed = JSON.parse(cleanContent);
  } catch (e) {
    console.error('JSON 解析错误:', e);
    window.showCustomAlert(`JSON 格式错误，无法解析账号数据！\n\n错误详情: ${e.message}`, 'error');
    return;
  }

  if (!Array.isArray(parsed)) {
    window.showCustomAlert('JSON 格式不正确，根节点必须是数组！\n\n请确保文件格式为: [{ "email": "...", "password": "..." }]', 'error');
    return;
  }

  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      errors.push(`第 ${index + 1} 条记录格式错误：不是对象`);
      return;
    }
    const email = (item.email || '').trim();
    const password = (item.password || '').toString();
    const apiKey = item.apiKey || item.token || item.accessToken || '';
    if (!email) { errors.push(`第 ${index + 1} 条记录缺少邮箱字段`); return; }
    if (!email.includes('@')) { errors.push(`第 ${index + 1} 条记录邮箱格式错误：${email}`); return; }
    accounts.push({ email, password, apiKey });
  });

  if (accounts.length === 0) {
    window.showCustomAlert('没有有效的账号数据！', 'error');
    return;
  }

  const existingAccountsResult = await ipcRenderer.invoke('get-accounts');
  const existingEmails = new Set();
  if (existingAccountsResult.success && existingAccountsResult.accounts) {
    existingAccountsResult.accounts.forEach(acc => existingEmails.add(acc.email.toLowerCase()));
  }

  const duplicateAccounts = [];
  const newAccounts = [];
  accounts.forEach(account => {
    if (existingEmails.has(account.email.toLowerCase())) {
      duplicateAccounts.push(account.email);
    } else {
      newAccounts.push(account);
    }
  });

  let confirmMsg = '';
  if (newAccounts.length > 0) confirmMsg += `准备导入 ${newAccounts.length} 个新账号`;
  if (duplicateAccounts.length > 0) {
    confirmMsg += `\n跳过 ${duplicateAccounts.length} 个重复账号：\n`;
    confirmMsg += duplicateAccounts.slice(0, 5).join('\n');
    if (duplicateAccounts.length > 5) confirmMsg += `\n... 还有 ${duplicateAccounts.length - 5} 个`;
  }
  if (errors.length > 0) confirmMsg += `\n跳过 ${errors.length} 个格式错误行`;

  if (newAccounts.length === 0) {
    window.showCustomAlert('没有新账号需要导入！所有账号都已存在。', 'warning');
    return;
  }

  confirmMsg += '\n\n确定要导入吗？';
  const shouldContinue = await window.showCustomConfirm(confirmMsg, '确认导入');
  if (!shouldContinue) return;

  let successCount = 0;
  let failCount = 0;
  const failDetails = [];

  for (const account of newAccounts) {
    const result = await ipcRenderer.invoke('add-account', account);
    if (result.success) { successCount++; } else { failCount++; failDetails.push(`${account.email}: ${result.error}`); }
  }

  let resultMsg = `导入完成！\n\n`;
  resultMsg += `✓ 成功导入: ${successCount} 个\n`;
  if (failCount > 0) resultMsg += `✗ 导入失败: ${failCount} 个\n`;
  if (duplicateAccounts.length > 0) resultMsg += `⊘ 跳过重复: ${duplicateAccounts.length} 个\n`;
  if (errors.length > 0) resultMsg += `⚠ 格式错误: ${errors.length} 行\n`;
  if (failDetails.length > 0 && failDetails.length <= 5) {
    resultMsg += `\n失败详情:\n`;
    failDetails.forEach(detail => { resultMsg += `• ${detail}\n`; });
  }

  window.showImportResultDialog(resultMsg, successCount, failCount, duplicateAccounts.length, errors.length);

  if (successCount > 0 && typeof window.loadAccounts === 'function') {
    window.loadAccounts();
  }
}

// ==================== 下载选择对话框 ====================

async function openDownloadUrl() {
  const modalHTML = `
    <div id="downloadChoiceModal" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.6); display: flex; align-items: center; justify-content: center; z-index: 10001; pointer-events: auto;">
      <div style="background: white; border-radius: 16px; padding: 32px; max-width: 450px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3); pointer-events: auto;">
        <h2 style="margin: 0 0 24px 0; font-size: 20px; text-align: center;">选择下载方式</h2>
        <div style="display: flex; flex-direction: column; gap: 16px;">
          <button onclick="openGithubReleases()" style="background: linear-gradient(180deg, #24292e 0%, #1a1e22 100%); color: white; border: none; padding: 16px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 12px; transition: all 0.2s; pointer-events: auto;">
            <i data-lucide="github" style="width: 24px; height: 24px;"></i>
            <div style="text-align: left;">
              <div>GitHub Releases</div>
              <div style="font-size: 12px; opacity: 0.8; font-weight: normal;">https://github.com/crispvibe/Windsurf-Tool/releases</div>
            </div>
          </button>
          <button onclick="openQQGroup()" style="background: linear-gradient(180deg, #12b7f5 0%, #0099e5 100%); color: white; border: none; padding: 16px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 12px; transition: all 0.2s; pointer-events: auto;">
            <i data-lucide="message-circle" style="width: 24px; height: 24px;"></i>
            <div style="text-align: left;">
              <div>加入 QQ 群获取</div>
              <div style="font-size: 12px; opacity: 0.8; font-weight: normal;">群号：469028100</div>
            </div>
          </button>
        </div>
        <button onclick="closeDownloadChoice()" style="margin-top: 16px; width: 100%; background: #f5f5f7; color: #1d1d1f; border: none; padding: 12px; border-radius: 8px; font-size: 14px; cursor: pointer; pointer-events: auto;">
          取消
        </button>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
  const modal = document.getElementById('downloadChoiceModal');
  if (modal) modal.style.pointerEvents = 'auto';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openGithubReleases() {
  shell.openExternal('https://github.com/crispvibe/Windsurf-Tool/releases');
  closeDownloadChoice();
}

function closeDownloadChoice() {
  const modal = document.getElementById('downloadChoiceModal');
  if (modal) modal.remove();
}

// ==================== 批量Token进度弹窗 ====================

function showBatchTokenProgressModal() {
  const modal = document.getElementById('batchTokenProgressModal');
  if (modal) {
    document.getElementById('batchTokenProgressText').textContent = '0/0';
    document.getElementById('batchTokenProgressFill').style.width = '0%';
    document.getElementById('batchTokenCurrentEmail').textContent = '等待开始...';
    document.getElementById('batchTokenSuccessCount').textContent = '0';
    document.getElementById('batchTokenFailCount').textContent = '0';
    document.getElementById('batchTokenTotalCount').textContent = '0';
    document.getElementById('batchTokenLogContainer').innerHTML = '<div>正在启动...</div>';
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('active'), 10);
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

async function closeBatchTokenProgressModal() {
  try {
    await ipcRenderer.invoke('cancel-batch-get-tokens');
    console.log('已发送取消批量获取Token请求');
  } catch (error) {
    console.error('取消批量获取Token失败:', error);
  }

  const modal = document.getElementById('batchTokenProgressModal');
  if (modal) {
    modal.classList.remove('active');
    setTimeout(() => { modal.style.display = 'none'; }, 200);
  }

  if (typeof window.loadAccounts === 'function') window.loadAccounts();
}

function addBatchTokenLog(message, type = 'info') {
  const container = document.getElementById('batchTokenLogContainer');
  if (!container) return;

  const colors = { info: '#f5f5f7', success: '#4caf50', error: '#f44336', warning: '#ff9800' };
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = document.createElement('div');
  logEntry.style.color = colors[type] || colors.info;
  logEntry.style.marginBottom = '4px';
  logEntry.textContent = `[${timestamp}] ${message}`;
  container.appendChild(logEntry);
  container.scrollTop = container.scrollHeight;
}

module.exports = {
  showApiUnavailableModal,
  retryConnection,
  showVersionUpdateModal,
  formatUpdateMessage,
  closeVersionUpdateModal,
  showMaintenanceModal,
  showAccountDetailsModal,
  showImportAccountForm,
  selectImportFile,
  processImportFile,
  openDownloadUrl,
  openGithubReleases,
  closeDownloadChoice,
  showBatchTokenProgressModal,
  closeBatchTokenProgressModal,
  addBatchTokenLog,
  windowExports: {
    showApiUnavailableModal,
    retryConnection,
    showVersionUpdateModal,
    closeVersionUpdateModal,
    showMaintenanceModal,
    showAccountDetailsModal,
    showImportAccountForm,
    selectImportFile,
    processImportFile,
    openDownloadUrl,
    openGithubReleases,
    closeDownloadChoice,
    showBatchTokenProgressModal,
    closeBatchTokenProgressModal,
    addBatchTokenLog,
  },
};
