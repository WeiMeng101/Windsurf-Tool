// filterRenderer.js - 账号日期过滤模块
// 从 js/accountDateFilter.js 迁移

function isFiniteDate(date) {
  return date instanceof Date && Number.isFinite(date.getTime());
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return isFiniteDate(date) ? date : null;
}

function getDayWindow(now = new Date()) {
  const current = normalizeDate(now);
  if (!current) {
    return null;
  }

  const start = new Date(current.getFullYear(), current.getMonth(), current.getDate(), 0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function isCreatedToday(createdAt, now = new Date()) {
  const created = normalizeDate(createdAt);
  const window = getDayWindow(now);

  if (!created || !window) {
    return false;
  }

  return created >= window.start && created < window.end;
}

function filterAccountsByScope(accounts = [], scope = 'today', now = new Date()) {
  if (!Array.isArray(accounts)) {
    return [];
  }

  const normalizedScope = scope === 'today' ? 'today' : 'all';

  if (normalizedScope === 'all') {
    return accounts.slice();
  }

  return accounts.filter(account => isCreatedToday(account && account.createdAt, now));
}

function getAccountDateFilterSummary(scope, visibleCount, totalCount) {
  if (scope === 'today') {
    return `仅显示今天申请的账号 ${visibleCount} / ${totalCount}`;
  }

  return `显示全部账号 ${visibleCount} / ${totalCount}`;
}

// ==================== Module exports ====================

module.exports = {
  isCreatedToday,
  filterAccountsByScope,
  getAccountDateFilterSummary,
  windowExports: {
    AccountDateFilter: {
      isCreatedToday,
      filterAccountsByScope,
      getAccountDateFilterSummary,
    },
  },
};
