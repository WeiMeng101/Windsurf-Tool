'use strict';

const modals = require('./modals');
const uiHelpers = require('./uiHelpers');

// ==================== Token module lazy loading ====================

function loadTokenModule() {
  try {
    if (!window.TokenGetter) {
      console.log('加载Token获取模块...');
      window.TokenGetter = require('./tokenGetterRenderer').TokenGetter;
      window.TokenGetter.initialize('tokenGetterContainer');
    }
  } catch (error) {
    console.error('Token获取模块加载失败:', error);
    const container = document.getElementById('tokenGetterContainer');
    if (container) {
      container.innerHTML = `
        <div class="status-message status-error" style="padding:20px;">
          <h3>加载失败</h3>
          <p>无法加载Token获取模块: ${error.message}</p>
        </div>
      `;
    }
  }
}

// ==================== Batch token operations ====================

async function batchGetAllTokens() {
  try {
    const btn = document.getElementById('batchGetAllTokensBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader" style="width: 16px; height: 16px; animation: spin 1s linear infinite;"></i> 处理中...';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    modals.showBatchTokenProgressModal();

    const result = await window.ipcRenderer.invoke('batch-get-all-tokens');
    if (!result.success) {
      window.showToast(result.error || '批量获取Token失败', 'error');
      modals.closeBatchTokenProgressModal();
    }
  } catch (error) {
    console.error('批量获取Token失败:', error);
    window.showToast('批量获取Token失败: ' + error.message, 'error');
    modals.closeBatchTokenProgressModal();
  } finally {
    const btn = document.getElementById('batchGetAllTokensBtn');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="key" style="width: 16px; height: 16px;"></i> 获取Token';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
}

// ==================== IPC event listeners ====================

function setupTokenIpcListeners() {
  window.ipcRenderer.on('batch-token-progress', (_event, data) => {
    const { current, total, email, status, error } = data;
    document.getElementById('batchTokenProgressText').textContent = `${current} / ${total}`;
    document.getElementById('batchTokenTotalCount').textContent = total;
    const percentage = (current / total) * 100;
    document.getElementById('batchTokenProgressFill').style.width = `${percentage}%`;
    document.getElementById('batchTokenCurrentEmail').textContent = email;

    if (status === 'processing') {
      document.getElementById('batchTokenCurrentStatus').textContent = '正在处理...';
      document.getElementById('batchTokenCurrentStatus').style.color = '#007aff';
      modals.addBatchTokenLog(`[${current}/${total}] 开始处理: ${email}`, 'info');
    } else if (status === 'success') {
      document.getElementById('batchTokenCurrentStatus').textContent = '成功';
      document.getElementById('batchTokenCurrentStatus').style.color = '#4caf50';
      const successCount = parseInt(document.getElementById('batchTokenSuccessCount').textContent) + 1;
      document.getElementById('batchTokenSuccessCount').textContent = successCount;
      modals.addBatchTokenLog(`[${current}/${total}] 成功: ${email}`, 'success');
    } else if (status === 'failed') {
      document.getElementById('batchTokenCurrentStatus').textContent = `失败: ${error || '未知错误'}`;
      document.getElementById('batchTokenCurrentStatus').style.color = '#f44336';
      const failCount = parseInt(document.getElementById('batchTokenFailCount').textContent) + 1;
      document.getElementById('batchTokenFailCount').textContent = failCount;
      modals.addBatchTokenLog(`[${current}/${total}] 失败: ${email} - ${error || '未知错误'}`, 'error');
    }
  });

  window.ipcRenderer.on('batch-token-log', (_event, data) => {
    const { email, message } = data;
    modals.addBatchTokenLog(`[${email}] ${message}`, 'info');
  });

  window.ipcRenderer.on('batch-token-complete', (_event, data) => {
    const { total, successCount, failCount, cancelled } = data;
    modals.addBatchTokenLog('', 'info');

    if (cancelled) {
      modals.addBatchTokenLog('========== 操作已取消 ==========', 'warning');
      modals.addBatchTokenLog(`已处理: ${successCount + failCount} / ${total} 个账号`, 'info');
      modals.addBatchTokenLog(`成功: ${successCount} 个`, 'success');
      modals.addBatchTokenLog(`失败: ${failCount} 个`, failCount > 0 ? 'error' : 'info');
      modals.addBatchTokenLog(`剩余: ${total - successCount - failCount} 个（已跳过）`, 'warning');
      window.showToast(`操作已取消！已处理 ${successCount + failCount} 个账号`, 'warning');
    } else {
      modals.addBatchTokenLog('========== 批量获取完成 ==========', 'info');
      modals.addBatchTokenLog(`总计: ${total} 个账号`, 'info');
      modals.addBatchTokenLog(`成功: ${successCount} 个`, 'success');
      modals.addBatchTokenLog(`失败: ${failCount} 个`, failCount > 0 ? 'error' : 'info');
      if (failCount === 0) {
        window.showToast(`批量获取完成！成功 ${successCount} 个`, 'success');
      } else {
        window.showToast(`批量获取完成！成功 ${successCount} 个，失败 ${failCount} 个`, 'warning');
      }
    }

    const closeBtn = document.getElementById('batchTokenCloseBtn');
    if (closeBtn) {
      closeBtn.disabled = false;
      closeBtn.textContent = '关闭';
      closeBtn.className = 'btn btn-secondary';
    }
  });
}

// ==================== Module exports ====================

module.exports = {
  setupTokenIpcListeners,
  windowExports: {
    loadTokenModule,
    batchGetAllTokens,
    setupTokenIpcListeners,
  },
};
