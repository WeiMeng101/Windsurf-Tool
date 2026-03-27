// state.js - 所有渲染进程模块的共享状态
module.exports = {
  isForceUpdateActive: false,
  isMaintenanceModeActive: false,
  isApiUnavailable: false,
  lastVersionCheckTime: 0,
  versionCheckCooldown: 30000,
  versionUpdateInfo: null,
  isQuitting: false,
  currentConfig: {
    emailDomains: ['example.com'],
    emailConfig: null,
    passwordMode: 'email',
  },
  switchAccountsCache: [],
  selectedSwitchAccountId: '',
  usedAccountIds: new Set(),
  deleteMode: false,
  isRegistering: false,
  currentAccountRefreshTimer: null,
};
