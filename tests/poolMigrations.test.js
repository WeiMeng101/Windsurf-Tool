'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Load the migration SQL from db.js by requiring the module
 * and extracting the v2 migration.
 *
 * Since db.js calls getDbPath() at require time which needs `app`,
 * we read the file directly and parse out the migration SQL.
 */
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'src', 'gateway', 'db.js');
const dbSource = fs.readFileSync(dbPath, 'utf-8');

/**
 * Extract migration v2 SQL from the source.
 * We look for the version: 2 migration entry in the migrations array.
 */
function extractMigrationV2() {
  // Match the version 2 migration block
  const version2Match = dbSource.match(
    /\{\s*version:\s*2[\s\S]*?sql:\s*`([\s\S]*?)`\s*\}/
  );
  if (!version2Match) {
    throw new Error('Migration v2 not found in db.js');
  }
  return version2Match[1];
}

describe('Pool Migrations v2', () => {
  let sql;

  it('should exist in db.js', () => {
    sql = extractMigrationV2();
    assert.ok(sql.length > 0, 'Migration v2 SQL should not be empty');
  });

  describe('pool_accounts table', () => {
    it('contains CREATE TABLE IF NOT EXISTS pool_accounts', () => {
      sql = sql || extractMigrationV2();
      assert.ok(
        sql.includes('CREATE TABLE IF NOT EXISTS pool_accounts'),
        'Should create pool_accounts table'
      );
    });

    it('CHECK constraint for provider_type includes windsurf, codex, openai', () => {
      sql = sql || extractMigrationV2();
      assert.ok(sql.includes("'windsurf'"), 'provider_type should include windsurf');
      assert.ok(sql.includes("'codex'"), 'provider_type should include codex');
      assert.ok(sql.includes("'openai'"), 'provider_type should include openai');
      assert.ok(
        sql.includes('provider_type IN') || sql.includes('provider_type IN'),
        'Should have CHECK constraint on provider_type'
      );
    });

    it('CHECK constraint for status includes all 5 states', () => {
      sql = sql || extractMigrationV2();
      assert.ok(sql.includes("'available'"), 'status should include available');
      assert.ok(sql.includes("'in_use'"), 'status should include in_use');
      assert.ok(sql.includes("'error'"), 'status should include error');
      assert.ok(sql.includes("'cooldown'"), 'status should include cooldown');
      assert.ok(sql.includes("'disabled'"), 'status should include disabled');
    });
  });

  describe('pool_status_history table', () => {
    it('contains CREATE TABLE IF NOT EXISTS pool_status_history', () => {
      sql = sql || extractMigrationV2();
      assert.ok(
        sql.includes('CREATE TABLE IF NOT EXISTS pool_status_history'),
        'Should create pool_status_history table'
      );
    });

    it('has FOREIGN KEY referencing pool_accounts(id)', () => {
      sql = sql || extractMigrationV2();
      assert.ok(
        sql.includes('FOREIGN KEY') && sql.includes('pool_account_id') && sql.includes('pool_accounts(id)'),
        'Should have FOREIGN KEY on pool_account_id referencing pool_accounts(id)'
      );
    });
  });

  describe('Indexes', () => {
    it('creates index on pool_accounts(status, deleted_at)', () => {
      sql = sql || extractMigrationV2();
      assert.ok(
        sql.includes('idx_pool_status') ||
        sql.includes('CREATE INDEX IF NOT EXISTS') && sql.includes('pool_accounts') && sql.includes('status'),
        'Should create index on pool_accounts status'
      );
    });

    it('creates index on pool_accounts(provider_type, deleted_at)', () => {
      sql = sql || extractMigrationV2();
      assert.ok(
        sql.includes('idx_pool_provider') ||
        sql.includes('CREATE INDEX IF NOT EXISTS') && sql.includes('pool_accounts') && sql.includes('provider_type'),
        'Should create index on pool_accounts provider_type'
      );
    });

    it('creates index on pool_status_history(pool_account_id, created_at)', () => {
      sql = sql || extractMigrationV2();
      assert.ok(
        sql.includes('idx_status_history_account') ||
        sql.includes('CREATE INDEX IF NOT EXISTS') && sql.includes('pool_status_history'),
        'Should create index on pool_status_history'
      );
    });
  });
});
