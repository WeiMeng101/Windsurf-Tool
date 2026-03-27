'use strict';

const uiHelpers = require('./uiHelpers');
const modals = require('./modals');

// ==================== Module-private state ====================
let switchAccountsCache = [];
let selectedSwitchAccountId = '';
let usedAccountIds = new Set();
let currentAccountRefreshTimer = null;

// ==================== Used accounts persistence ====================

function loadUsedAccountsFromStorage() {
  try {
    const raw = localStorage.getItem('usedAccounts');
    if (raw) {
      const arr = JSON.parse(raw);
      usedAccountIds = new Set(Array.isArray(arr) ? arr : []);
    }
  } catch (e) { /* ignore */ }
}

function saveUsedAccountsToStorage() {
  try {
    localStorage.setItem('usedAccounts', JSON.stringify(Array.from(usedAccountIds)));
  } catch (e) { /* ignore */ }
}

// ==================== Switch accounts grid ====================

function renderSwitchAccountsGrid() {
  const grid = document.getElementById('switchAccountsGrid');
  if (!grid) return;

  const available = (switchAccountsCache || []).filter(acc => !usedAccountIds.has(acc.id));
  if (available.length === 0) {
    grid.innerHTML = `<div style="color:#999; padding:10px;">暂无可用账号</div>`;
    return;
  }

  grid.innerHTML = available.map(acc => {
    const expiry = uiHelpers.calculateExpiry(acc.createdAt);
    const isSelected = acc.id === selectedSwitchAccountId;
    const statusBadge = expiry.isExpired
      ? `<span class="badge" style="background:#e74c3c;">已到期</span>`
      : `<span class="badge" style="background:${expiry.expiryColor};">${expiry.expiryText}</span>`;
    return `
      <div class="switch-account-card ${isSelected ? 'selected' : ''}" data-id="${acc.id}">
        ${statusBadge}
        <div class="email">${acc.email}</div>
        <div class="meta">到期: ${expiry.expiryDate ? expiry.expiryDate.toLocaleDateString() : '-'}</div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.switch-account-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      selectedSwitchAccountId = id;
      const selectedEl = document.getElementById('selectedSwitchAccount');
      const acc = switchAccountsCache.find(a => a.id === id);
      if (selectedEl && acc) {
        selectedEl.textContent = `已选择账号：${acc.email}`;
      }
      renderSwitchAccountsGrid();
    });
  });
}

function renderUsedAccountsGrid() {
  const grid = document.getElementById('usedAccountsGrid');
  if (!grid) return;
  const list = (switchAccountsCache || []).filter(acc => usedAccountIds.has(acc.id));
  if (list.length === 0) {
    grid.innerHTML = `<div style="color:#999; padding:10px;">暂无已使用账号</div>`;
    return;
  }
  grid.innerHTML = list.map(acc => {
    const expiry = uiHelpers.calculateExpiry(acc.createdAt);
    const statusBadge = expiry.isExpired
      ? `<span class="badge" style="background:#e74c3c;">已到期</span>`
      : `<span class="badge" style="background:${expiry.expiryColor};">${expiry.expiryText}</span>`;
    return `
      <div class="used-account-card" data-id="${acc.id}">
        ${statusBadge}
        <div class="email">${acc.email}</div>
        <div class="meta" style="display:flex; justify-content:space-between; align-items:center;">
          <span>到期: ${expiry.expiryDate ? expiry.expiryDate.toLocaleDateString() : '-'}</span>
          <button class="btn" data-action="restore" style="padding:4px 8px; font-size:11px; margin:0;">撤销</button>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.used-account-card button[data-action="restore"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.used-account-card');
      const id = card && card.getAttribute('data-id');
      if (!id) return;
      restoreUsedAccount(id);
    });
  });
}

function markAccountUsed(id) {
  if (!id) return;
  usedAccountIds.add(id);
  saveUsedAccountsToStorage();
  if (selectedSwitchAccountId === id) {
    selectedSwitchAccountId = '';
    const selectedEl = document.getElementById('selectedSwitchAccount');
    if (selectedEl) selectedEl.textContent = '未选择账号';
  }
  renderSwitchAccountsGrid();
  renderUsedAccountsGrid();
}

function restoreUsedAccount(id) {
  if (!id) return;
  usedAccountIds.delete(id);
  saveUsedAccountsToStorage();
  renderSwitchAccountsGrid();
  renderUsedAccountsGrid();
}

// ==================== Load accounts for switch ====================

async function loadAccountsForSwitch() {
  const result = await window.ipcRenderer.invoke('get-accounts');
  const accounts = result.success ? (result.accounts || []) : [];
  switchAccountsCache = accounts;
  selectedSwitchAccountId = '';
  const selectedEl = document.getElementById('selectedSwitchAccount');
  if (selectedEl) selectedEl.textContent = '未选择账号';
  renderSwitchAccountsGrid();
  renderUsedAccountsGrid();
  await detectWindsurfPaths();
}

async function detectWindsurfPaths() {
  const paths = await window.ipcRenderer.invoke('detect-windsurf-paths');
  let html = '<div style="margin-top:20px; padding:15px; background:#f9f9f9; border-radius:6px;">';
  html += '<h4>Windsurf配置路径检测</h4>';
  html += '<div style="font-size:12px; margin-top:10px;">';
  for (const key in paths) {
    const item = paths[key];
    const status = item.exists ? '✓' : '✗';
    const color = item.exists ? '#27ae60' : '#999';
    html += `<div style="margin:5px 0; color:${color};">${status} ${key}: ${item.path}</div>`;
  }
  html += '</div></div>';
  const statusEl = document.getElementById('switchStatus');
  if (statusEl && statusEl.innerHTML === '') {
    statusEl.innerHTML = html;
  }
}

// ==================== Switch selected account ====================

async function switchSelectedAccount() {
  const accountId = selectedSwitchAccountId;
  if (!accountId) {
    window.showCustomAlert('请选择要切换的账号', 'warning');
    return;
  }

  const confirmed = await showCustomConfirm({
    title: '自动化切换',
    message: '完整自动化切换将关闭并重置 Windsurf，然后启动并完成初始设置',
    subMessage: '确定要继续吗？',
    confirmText: '开始切换',
    type: 'info'
  });
  if (!confirmed) return;

  const accountsResult = await window.ipcRenderer.invoke('get-accounts');
  const accounts = accountsResult.success ? (accountsResult.accounts || []) : [];
  const account = accounts.find(acc => acc.id === accountId);

  const result = await window.ipcRenderer.invoke('switch-account', account);
  const statusEl = document.getElementById('switchStatus');

  if (result.success) {
    markAccountUsed(accountId);
    await getCurrentAccount();
    statusEl.innerHTML = `
      <div class="status-message status-success">
        <strong>切换成功！</strong><br>
        ${result.message}<br><br>
        <strong>账号信息：</strong><br>
        邮箱: ${result.account.email}<br>
        密码: ${result.account.password}
      </div>
    `;
  } else {
    statusEl.innerHTML = `
      <div class="status-message status-error">
        <strong>切换失败：</strong>${result.error}
      </div>
    `;
  }
}

// ==================== Current account ====================

async function getCurrentAccount() {
  try {
    const result = await window.ipcRenderer.invoke('get-current-login');
    const currentAccountEmail = document.getElementById('currentAccountEmail');
    const currentAccountCredits = document.getElementById('currentAccountCredits');
    const currentAccountUsedCredits = document.getElementById('currentAccountUsedCredits');
    const currentAccountUsage = document.getElementById('currentAccountUsage');
    const currentAccountExpires = document.getElementById('currentAccountExpires');
    const currentAccountType = document.getElementById('currentAccountType');

    if (result && result.success && result.email) {
      if (currentAccountEmail) {
        currentAccountEmail.textContent = result.email;
        currentAccountEmail.style.color = '';
      }

      try {
        const response = await window.ipcRenderer.invoke('load-accounts');
        if (!response || !response.success) throw new Error('读取账号列表失败');
        const accounts = response.accounts || [];
        const account = accounts.find(acc => acc.email === result.email);

        if (account) {
          const credits = account.credits || account.credit || 0;
          const usedCredits = account.usedCredits || 0;
          const accountType = account.type || 'Free';

          if (currentAccountCredits) currentAccountCredits.textContent = credits.toLocaleString();
          if (currentAccountUsedCredits) currentAccountUsedCredits.textContent = usedCredits.toLocaleString();

          const creditsProgressBar = document.getElementById('creditsProgressBar');
          if (creditsProgressBar && credits > 0) {
            const usagePercent = Math.min(100, Math.round((usedCredits / credits) * 100));
            creditsProgressBar.style.width = `${usagePercent}%`;
          }

          if (currentAccountType) {
            currentAccountType.textContent = accountType;
            currentAccountType.classList.remove('free', 'enterprise', 'teams', 'trial');
            const typeLower = accountType.toLowerCase();
            if (typeLower.includes('free')) currentAccountType.classList.add('free');
            else if (typeLower.includes('enterprise')) currentAccountType.classList.add('enterprise');
            else if (typeLower.includes('team')) currentAccountType.classList.add('teams');
            else if (typeLower.includes('trial')) currentAccountType.classList.add('trial');
          }

          const statusDot = document.getElementById('loginStatusDot');
          if (statusDot) statusDot.classList.remove('offline');

          if (currentAccountUsage) {
            const usagePercent = account.usage || account.usagePercent || account.usage_percent || 0;
            let usageColor = '';
            if (usagePercent >= 90) usageColor = '#ef4444';
            else if (usagePercent >= 70) usageColor = '#f59e0b';
            else if (usagePercent >= 50) usageColor = '#eab308';
            currentAccountUsage.textContent = `${usagePercent}%`;
            currentAccountUsage.style.color = usageColor;
          }

          if (currentAccountExpires) {
            if (account.expiresAt) {
              const expiresDate = new Date(account.expiresAt);
              const now = new Date();
              const daysLeft = Math.ceil((expiresDate - now) / (1000 * 60 * 60 * 24));
              let expiresText = '', expiresColor = '';
              if (daysLeft < 0) { expiresText = '已过期'; expiresColor = '#ef4444'; }
              else if (daysLeft === 0) { expiresText = '今天到期'; expiresColor = '#f59e0b'; }
              else if (daysLeft <= 7) { expiresText = `${daysLeft}天后`; expiresColor = '#f59e0b'; }
              else { expiresText = expiresDate.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }); }
              currentAccountExpires.textContent = expiresText;
              currentAccountExpires.style.color = expiresColor;
            } else {
              currentAccountExpires.textContent = '--';
            }
          }
        } else {
          if (currentAccountCredits) { currentAccountCredits.textContent = '不在列表'; currentAccountCredits.style.color = '#f59e0b'; }
          if (currentAccountUsedCredits) currentAccountUsedCredits.textContent = '--';
          if (currentAccountUsage) currentAccountUsage.textContent = '--';
          if (currentAccountExpires) currentAccountExpires.textContent = '--';
          if (currentAccountType) { currentAccountType.textContent = '--'; currentAccountType.classList.remove('free', 'enterprise', 'teams', 'trial'); }
          const creditsProgressBar = document.getElementById('creditsProgressBar');
          if (creditsProgressBar) creditsProgressBar.style.width = '0%';
          const statusDot = document.getElementById('loginStatusDot');
          if (statusDot) statusDot.classList.add('offline');
        }
      } catch (error) {
        console.error('读取账号详情失败:', error);
        if (currentAccountCredits) currentAccountCredits.textContent = '--';
        if (currentAccountUsedCredits) currentAccountUsedCredits.textContent = '--';
        if (currentAccountUsage) currentAccountUsage.textContent = '--';
        if (currentAccountExpires) currentAccountExpires.textContent = '--';
        if (currentAccountType) currentAccountType.textContent = '--';
      }
    } else {
      if (currentAccountEmail) { currentAccountEmail.textContent = '未登录'; currentAccountEmail.style.color = 'var(--text-muted)'; }
      if (currentAccountCredits) currentAccountCredits.textContent = '--';
      if (currentAccountUsedCredits) currentAccountUsedCredits.textContent = '--';
      if (currentAccountUsage) currentAccountUsage.textContent = '--';
      if (currentAccountExpires) currentAccountExpires.textContent = '--';
      if (currentAccountType) { currentAccountType.textContent = '--'; currentAccountType.classList.remove('free', 'enterprise', 'teams', 'trial'); }
      const creditsProgressBar = document.getElementById('creditsProgressBar');
      if (creditsProgressBar) creditsProgressBar.style.width = '0%';
      const statusDot = document.getElementById('loginStatusDot');
      if (statusDot) statusDot.classList.add('offline');
    }
  } catch (error) {
    console.error('获取当前登录账号失败:', error);
    const currentAccountEmail = document.getElementById('currentAccountEmail');
    if (currentAccountEmail) { currentAccountEmail.textContent = '获取失败'; currentAccountEmail.style.color = '#ef4444'; }
  }
}

async function refreshCurrentAccount() {
  await getCurrentAccount();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function startCurrentAccountAutoRefresh() {
  if (currentAccountRefreshTimer) clearInterval(currentAccountRefreshTimer);
  currentAccountRefreshTimer = setInterval(async () => {
    await refreshCurrentAccount();
  }, 60000);
}

function stopCurrentAccountAutoRefresh() {
  if (currentAccountRefreshTimer) {
    clearInterval(currentAccountRefreshTimer);
    currentAccountRefreshTimer = null;
  }
}

async function loadCurrentMachineId() {
  const machineIdEl = document.getElementById('currentMachineId');
  if (!machineIdEl) return;

  try {
    const result = await window.ipcRenderer.invoke('get-machine-id');
    if (result.success) {
      machineIdEl.innerHTML = `
        <div style="margin-bottom:8px;">
          <strong style="color:#6e6e73;">Device ID:</strong>
          <span style="color:#007aff;">${result.devDeviceId}</span>
        </div>
        <div style="margin-bottom:8px;">
          <strong style="color:#6e6e73;">SQM ID:</strong>
          <span style="color:#007aff;">${result.sqmId}</span>
        </div>
        <div>
          <strong style="color:#6e6e73;">Machine ID:</strong>
          <span style="color:#007aff; word-break:break-all;">${result.machineId}</span>
        </div>
      `;
    } else {
      machineIdEl.textContent = result.machineId || '未安装或未配置';
      machineIdEl.style.color = '#86868b';
    }
  } catch (error) {
    machineIdEl.textContent = '请重启应用以加载此功能';
    machineIdEl.style.color = '#ff9500';
    console.error('获取机器ID失败:', error);
  }
}

// ==================== Initialization helper (called from renderer.js DOMContentLoaded) ====================

function initAccountRenderer() {
  loadUsedAccountsFromStorage();
  startCurrentAccountAutoRefresh();
}

// ==================== Delayed references (avoid circular deps) ====================

function showCustomConfirm(optionsOrMessage, titleParam) {
  if (typeof window.showCustomConfirm === 'function') {
    return window.showCustomConfirm(optionsOrMessage, titleParam);
  }
  return Promise.resolve(false);
}

// ==================== Account operations (onclick handlers from HTML) ====================

function viewAccountDetails(event) {
  event.stopPropagation();
  const accountData = event.currentTarget.getAttribute('data-account');
  if (!accountData) {
    window.showCustomAlert('无法获取账号信息', 'error');
    return;
  }
  try {
    const account = JSON.parse(accountData.replace(/&apos;/g, "'"));
    modals.showAccountDetailsModal(account);
  } catch (error) {
    console.error('解析账号数据失败:', error);
    window.showCustomAlert('解析账号数据失败: ' + error.message, 'error');
  }
}

async function refreshAccountInfo(event) {
  event.stopPropagation();
  const btn = event.currentTarget;
  const accountData = btn.getAttribute('data-account');
  if (!accountData) return;

  const account = JSON.parse(accountData);
  btn.disabled = true;
  const icon = btn.querySelector('i');
  if (icon) icon.style.animation = 'spin 1s linear infinite';

  try {
    const result = await window.ipcRenderer.invoke('refresh-account-credits', account);
    if (result.success) {
      const row = btn.closest('.account-item');
      const typeEl = row.querySelector('.acc-col-type');
      if (typeEl && result.subscriptionType) typeEl.textContent = result.subscriptionType;
      const creditsEl = row.querySelector('.acc-col-credits');
      if (creditsEl && result.credits !== undefined) creditsEl.textContent = result.credits;
      const usageEl = row.querySelector('.acc-col-usage');
      if (usageEl && result.usage !== undefined) usageEl.textContent = result.usage + '%';

      window.showCustomAlert(`账号信息刷新成功！\n\n订阅类型: ${result.subscriptionType || '-'}\n积分: ${result.credits || '-'}\n使用率: ${result.usage || '-'}%`, 'success');
    } else {
      window.showCustomAlert('刷新失败: ' + (result.error || '未知错误'), 'error');
    }
  } catch (error) {
    console.error('刷新账号信息失败:', error);
    window.showCustomAlert('刷新失败: ' + error.message, 'error');
  } finally {
    if (icon) icon.style.animation = '';
    btn.disabled = false;
  }
}

async function switchAccount(event) {
  event.stopPropagation();
  const btn = event.currentTarget;
  const accountId = btn.getAttribute('data-id');
  const email = btn.getAttribute('data-email');

  let shouldContinue = false;
  if (typeof window.showCustomConfirm === 'function') {
    shouldContinue = await window.showCustomConfirm(
      `确定切换到账号：${email} 吗？\n\n这将自动登录到 Windsurf 并使用该账号。`,
      '切换账号'
    );
  }
  if (!shouldContinue) return;

  try {
    const accountsResult = await window.ipcRenderer.invoke('get-accounts');
    if (!accountsResult.success || !accountsResult.accounts) {
      window.showCustomAlert('获取账号信息失败', 'error');
      return;
    }
    const account = accountsResult.accounts.find(acc => acc.id === accountId || acc.email === email);
    if (!account) {
      window.showCustomAlert('未找到账号信息', 'error');
      return;
    }
    const result = await window.ipcRenderer.invoke('switch-account', account);
    if (result.success) {
      window.showCustomAlert(`切换成功！\n已切换到账号：${email}`, 'success');
    } else {
      window.showCustomAlert(`切换失败：${result.error || '未知错误'}`, 'error');
    }
  } catch (error) {
    console.error('切换账号失败:', error);
    window.showCustomAlert(`切换失败：${error.message}`, 'error');
  }
}

async function exportSingleAccount(event) {
  event.stopPropagation();
  const btn = event.currentTarget;
  const accountData = btn.getAttribute('data-account');

  if (!accountData) {
    window.showCustomAlert('无法获取账号信息', 'error');
    return;
  }

  try {
    const account = JSON.parse(accountData.replace(/&apos;/g, "'"));
    const exportData = {
      id: account.id,
      email: account.email,
      password: account.password,
      apiKey: account.apiKey || '',
      type: account.type || '',
      credits: account.credits,
      usage: account.usage,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      tokenUpdatedAt: account.tokenUpdatedAt,
      refreshToken: account.refreshToken || '',
      accessToken: account.accessToken || ''
    };

    const content = JSON.stringify(exportData, null, 2);
    const safeEmail = account.email
      .replace(/[<>:"\/\\|?*]/g, '_')
      .replace(/@/g, '_at_')
      .replace(/\./g, '_');
    const filename = `${safeEmail}.json`;

    const result = await window.ipcRenderer.invoke('save-file', {
      content,
      filename,
      filters: [
        { name: 'JSON 文件', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });

    if (result.success) {
      window.showCustomAlert(`账号导出成功！\n\n文件已保存到：\n${result.filePath}`, 'success');
    } else if (result.error !== '用户取消了保存操作') {
      window.showCustomAlert('导出失败: ' + result.error, 'error');
    }
  } catch (error) {
    console.error('导出账号失败:', error);
    window.showCustomAlert('导出失败: ' + error.message, 'error');
  }
}

async function deleteAccount(event) {
  event.stopPropagation();
  const btn = event.currentTarget;
  const id = btn.getAttribute('data-id');
  const email = btn.getAttribute('data-email');

  let shouldContinue = false;
  if (typeof window.showCustomConfirm === 'function') {
    shouldContinue = await window.showCustomConfirm(
      `确定删除账号：${email} 吗？`,
      '删除账号'
    );
  }
  if (!shouldContinue) return;

  const result = await window.ipcRenderer.invoke('delete-account', id);
  if (result.success) {
    if (typeof window.loadAccounts === 'function') window.loadAccounts();
    window.showCustomAlert('账号删除成功！', 'success');
  } else {
    window.showCustomAlert('删除失败: ' + result.error, 'error');
  }
}

// ==================== Context menu helpers ====================

async function refreshSingleAccount(email) {
  const result = await window.ipcRenderer.invoke('get-accounts');
  if (!result.success) return;
  const account = result.accounts.find(acc => acc.email === email);
  if (account && account.refreshToken && typeof window.AccountQuery !== 'undefined') {
    window.showToast('正在刷新...', 'info');
    const queryResult = await window.AccountQuery.queryAccount(account);
    if (queryResult.success) {
      if (typeof window.loadAccounts === 'function') window.loadAccounts();
      window.showToast('刷新成功！', 'success');
    } else {
      window.showToast('刷新失败：' + (queryResult.error || '未知错误'), 'error');
    }
  }
}

async function switchAccountFromMenu(email, password) {
  let shouldContinue = false;
  if (typeof window.showCustomConfirm === 'function') {
    shouldContinue = await window.showCustomConfirm(
      `确定切换到账号：${email} 吗？\n\n这将自动登录到 Windsurf 并使用该账号。`,
      '切换账号'
    );
  }
  if (!shouldContinue) return;

  try {
    const accountsResult = await window.ipcRenderer.invoke('get-accounts');
    if (!accountsResult.success || !accountsResult.accounts) {
      window.showToast('获取账号信息失败', 'error');
      return;
    }
    const account = accountsResult.accounts.find(acc => acc.email === email);
    if (!account) {
      window.showToast('未找到账号信息', 'error');
      return;
    }
    const result = await window.ipcRenderer.invoke('switch-account', account);
    if (result.success) {
      window.showToast(`切换成功！已切换到：${email}`, 'success');
    } else {
      window.showToast(`切换失败：${result.error || '未知错误'}`, 'error');
    }
  } catch (error) {
    window.showToast(`切换失败：${error.message}`, 'error');
  }
}

async function exportSingleAccountFromMenu(email, password) {
  try {
    const exportData = `邮箱: ${email}\n密码: ${password}\n`;
    const result = await window.ipcRenderer.invoke('save-file', {
      content: exportData,
      filename: `${email.replace('@', '_')}.txt`,
      filters: [
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.success) {
      window.showToast('导出成功！', 'success');
    } else if (result.error !== '用户取消了保存操作') {
      window.showToast('导出失败: ' + result.error, 'error');
    }
  } catch (error) {
    window.showToast('导出失败: ' + error.message, 'error');
  }
}

async function deleteAccountFromMenu(id, email) {
  let shouldContinue = false;
  if (typeof window.showCustomConfirm === 'function') {
    shouldContinue = await window.showCustomConfirm(
      `确定删除账号：${email} 吗？`,
      '删除账号'
    );
  }
  if (!shouldContinue) return;

  const result = await window.ipcRenderer.invoke('delete-account', id);
  if (result.success) {
    if (typeof window.loadAccounts === 'function') window.loadAccounts();
    window.showToast('删除成功！', 'success');
  } else {
    window.showToast('删除失败: ' + result.error, 'error');
  }
}

// ==================== Module exports ====================

module.exports = {
  windowExports: {
    renderSwitchAccountsGrid,
    renderUsedAccountsGrid,
    markAccountUsed,
    restoreUsedAccount,
    refreshCurrentAccount,
    loadCurrentMachineId,
    loadAccountsForSwitch,
    getCurrentAccount,
    switchSelectedAccount,
    initAccountRenderer,
    startCurrentAccountAutoRefresh,
    stopCurrentAccountAutoRefresh,
    viewAccountDetails,
    refreshAccountInfo,
    switchAccount,
    exportSingleAccount,
    deleteAccount,
    refreshSingleAccount,
    switchAccountFromMenu,
    exportSingleAccountFromMenu,
    deleteAccountFromMenu,
  },
};
