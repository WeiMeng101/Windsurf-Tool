const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isCreatedToday,
  filterAccountsByScope,
  getAccountDateFilterSummary,
} = require('../src/renderer/filterRenderer');

test('isCreatedToday matches the local calendar day window', () => {
  const now = new Date('2026-03-24T15:00:00+08:00');

  assert.equal(isCreatedToday('2026-03-24T00:01:00+08:00', now), true);
  assert.equal(isCreatedToday('2026-03-24T23:59:59+08:00', now), true);
  assert.equal(isCreatedToday('2026-03-23T23:59:59+08:00', now), false);
  assert.equal(isCreatedToday('2026-03-25T00:00:00+08:00', now), false);
});

test('isCreatedToday rejects empty and invalid dates', () => {
  const now = new Date('2026-03-24T15:00:00+08:00');

  assert.equal(isCreatedToday('', now), false);
  assert.equal(isCreatedToday(null, now), false);
  assert.equal(isCreatedToday('invalid-date', now), false);
});

test('filterAccountsByScope only keeps today accounts in today mode', () => {
  const now = new Date('2026-03-24T15:00:00+08:00');
  const accounts = [
    { email: 'today-a@example.com', createdAt: '2026-03-24T10:00:00+08:00' },
    { email: 'today-b@example.com', createdAt: '2026-03-24T20:10:00+08:00' },
    { email: 'history@example.com', createdAt: '2026-03-23T22:10:00+08:00' },
    { email: 'missing@example.com' },
  ];

  const visibleAccounts = filterAccountsByScope(accounts, 'today', now);

  assert.deepEqual(visibleAccounts.map(account => account.email), [
    'today-a@example.com',
    'today-b@example.com',
  ]);
});

test('filterAccountsByScope returns a shallow copy in all mode', () => {
  const accounts = [
    { email: 'a@example.com', createdAt: '2026-03-24T10:00:00+08:00' },
    { email: 'b@example.com', createdAt: '2026-03-21T10:00:00+08:00' },
  ];

  const visibleAccounts = filterAccountsByScope(accounts, 'all', new Date('2026-03-24T15:00:00+08:00'));

  assert.deepEqual(visibleAccounts, accounts);
  assert.notStrictEqual(visibleAccounts, accounts);
});

test('filterAccountsByScope treats unknown scope as all mode', () => {
  const accounts = [
    { email: 'a@example.com', createdAt: '2026-03-24T10:00:00+08:00' },
    { email: 'b@example.com', createdAt: '2026-03-21T10:00:00+08:00' },
  ];

  const visibleAccounts = filterAccountsByScope(accounts, 'unexpected-scope', new Date('2026-03-24T15:00:00+08:00'));

  assert.deepEqual(visibleAccounts, accounts);
  assert.notStrictEqual(visibleAccounts, accounts);
});

test('getAccountDateFilterSummary returns stable copy for both scopes', () => {
  assert.equal(getAccountDateFilterSummary('today', 3, 8), '仅显示今天申请的账号 3 / 8');
  assert.equal(getAccountDateFilterSummary('all', 8, 8), '显示全部账号 8 / 8');
});