const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Mock accountsFileLock
function createMockLock() {
  let acquireCallback = null;
  const mockLock = {
    _acquired: false,
    acquire(fn) {
      this._acquired = true;
      return Promise.resolve(fn());
    },
    getQueueLength() { return 0; },
    isFileLocked() { return this._acquired; }
  };
  return mockLock;
}

describe('AccountService', () => {
  let AccountService;
  let service;
  let testDir;
  let testFilePath;
  let mockLock;

  before(async () => {
    // AccountService uses a hardcoded accountsFileLock singleton.
    // We mock the module by providing a test accounts file.
    // The real accountsFileLock is a singleton that acquires a queue.
    // For unit tests we just need the service to work correctly.
    AccountService = require('../src/services/accountService');
  });

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-service-test-'));
    testFilePath = path.join(testDir, 'accounts.json');
    mockLock = createMockLock();
    service = new AccountService(testFilePath, mockLock);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // Test 1: getAll() reads file, parses JSON, returns array
  it('getAll() reads file and returns parsed array', async () => {
    const testData = [{ id: '1', email: 'test@example.com' }];
    fs.writeFileSync(testFilePath, JSON.stringify(testData, null, 2), 'utf-8');

    const accounts = await service.getAll();
    assert.deepEqual(accounts, testData);
  });

  // Test 2: save(accounts) writes JSON.stringify(accounts, null, 2) with utf-8 encoding
  it('save() writes JSON with 2-space indent', async () => {
    const accounts = [{ id: '1', email: 'test@example.com' }];

    await service.save(accounts);

    const raw = fs.readFileSync(testFilePath, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, accounts);
    // Verify 2-space indentation (nested object uses 4-space indent for keys)
    assert.match(raw, /\n    "/);
  });

  // Test 3: add(account) appends to existing accounts and saves
  it('add() appends account to existing list', async () => {
    const existing = [{ id: '1', email: 'existing@example.com' }];
    fs.writeFileSync(testFilePath, JSON.stringify(existing, null, 2), 'utf-8');

    const newAccount = { id: '2', email: 'new@example.com', password: 'pass123' };
    await service.add(newAccount);

    const accounts = await service.getAll();
    assert.equal(accounts.length, 2);
    assert.equal(accounts[1].email, 'new@example.com');
  });

  // Test 4: getById(id) returns matching account or null
  it('getById() returns matching account', async () => {
    const accounts = [
      { id: '1', email: 'first@example.com' },
      { id: '2', email: 'second@example.com' }
    ];
    fs.writeFileSync(testFilePath, JSON.stringify(accounts, null, 2), 'utf-8');

    const found = await service.getById('2');
    assert.ok(found);
    assert.equal(found.email, 'second@example.com');

    const notFound = await service.getById('999');
    assert.equal(notFound, null);
  });

  // Test 5: update(id, updates) merges fields and saves
  it('update() merges updates into existing account', async () => {
    const accounts = [{ id: '1', email: 'old@example.com', name: 'Old' }];
    fs.writeFileSync(testFilePath, JSON.stringify(accounts, null, 2), 'utf-8');

    const updated = await service.update('1', { name: 'New Name', status: 'active' });
    assert.ok(updated);
    assert.equal(updated.name, 'New Name');
    assert.equal(updated.status, 'active');
    assert.equal(updated.email, 'old@example.com'); // original preserved

    // Verify persistence
    const all = await service.getAll();
    assert.equal(all[0].name, 'New Name');
  });

  // Test 5b: update() returns null for non-existent id
  it('update() returns null for non-existent account', async () => {
    const accounts = [{ id: '1', email: 'test@example.com' }];
    fs.writeFileSync(testFilePath, JSON.stringify(accounts, null, 2), 'utf-8');

    const result = await service.update('999', { name: 'Nope' });
    assert.equal(result, null);
  });

  // Test 6: delete(id) removes account and saves
  it('delete() removes account by id', async () => {
    const accounts = [
      { id: '1', email: 'first@example.com' },
      { id: '2', email: 'second@example.com' }
    ];
    fs.writeFileSync(testFilePath, JSON.stringify(accounts, null, 2), 'utf-8');

    const deleted = await service.delete('1');
    assert.equal(deleted, true);

    const remaining = await service.getAll();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, '2');
  });

  // Test 6b: delete() returns false if id not found
  it('delete() returns false when id not found', async () => {
    const accounts = [{ id: '1', email: 'test@example.com' }];
    fs.writeFileSync(testFilePath, JSON.stringify(accounts, null, 2), 'utf-8');

    const deleted = await service.delete('999');
    assert.equal(deleted, false);
  });

  // Test 7: deleteAll() writes empty array
  it('deleteAll() writes empty array', async () => {
    const accounts = [{ id: '1', email: 'test@example.com' }];
    fs.writeFileSync(testFilePath, JSON.stringify(accounts, null, 2), 'utf-8');

    await service.deleteAll();

    const result = await service.getAll();
    assert.deepEqual(result, []);
  });

  // Test 8: readFileRaw(path) reads arbitrary file path
  it('readFileRaw() reads arbitrary file', async () => {
    const otherFile = path.join(testDir, 'other.txt');
    fs.writeFileSync(otherFile, 'hello world', 'utf-8');

    const content = await service.readFileRaw(otherFile);
    assert.equal(content, 'hello world');
  });

  // Test 9: Lock is acquired for all write operations
  it('acquires lock for write operations', async () => {
    const testData = [{ id: '1', email: 'test@example.com' }];
    fs.writeFileSync(testFilePath, JSON.stringify(testData, null, 2), 'utf-8');

    await service.save(testData);
    assert.equal(mockLock._acquired, true);

    mockLock._acquired = false;
    await service.add({ id: '2', email: 'new@example.com', password: 'pass' });
    assert.equal(mockLock._acquired, true);

    mockLock._acquired = false;
    await service.update('1', { name: 'Updated' });
    assert.equal(mockLock._acquired, true);

    mockLock._acquired = false;
    await service.delete('1');
    assert.equal(mockLock._acquired, true);

    mockLock._acquired = false;
    await service.deleteAll();
    assert.equal(mockLock._acquired, true);
  });

  // Test: getAll() handles ENOENT gracefully
  it('getAll() returns empty array when file does not exist', async () => {
    const noFilePath = path.join(testDir, 'nonexistent.json');
    const noFileService = new AccountService(noFilePath, mockLock);
    const accounts = await noFileService.getAll();
    assert.deepEqual(accounts, []);
  });
});
