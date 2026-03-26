# Phase 2: Unified Pool - Research

**Researched:** 2026-03-27
**Domain:** Electron desktop app - account pool management with SQLite + JSON data layer
**Confidence:** HIGH

## Summary

The Windsurf-Tool project currently manages three separate account stores: (1) Windsurf accounts in `accounts.json` via `AccountService`, (2) Codex accounts in `codex_accounts.json` via `CodexAccountPool`, and (3) gateway channels in `gateway.db` SQLite via `AccountIntegrationService`. Phase 2 must unify these into a single "unified pool" with a consistent data model, state machine, health scoring, and management UI.

The key architectural decision is storage strategy: the existing gateway.db (better-sqlite3) already has a mature migration system and `channels` table that serves as the gateway's provider connection layer. The unified pool should live in gateway.db as a new `pool_accounts` table, with a new migration. This avoids adding a third storage mechanism and keeps the pool co-located with the gateway that will consume it (Phase 5).

The data model must accommodate three entity types: Windsurf accounts (Firebase auth, credits), Codex accounts (OpenAI OAuth, token rotation), and third-party LLM API keys (simple key+base_url). Each type has different credential shapes, which argues for a `credentials` JSON blob column (same pattern used by the existing `channels` table).

**Primary recommendation:** Add a `pool_accounts` table to gateway.db with a migration, create a `PoolService` data layer class, add pool IPC handlers, and build a new "号池" view in the renderer. Migrate existing Windsurf and Codex accounts into the pool during first boot after the migration.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| POOL-01 | Unified data model for Windsurf/Codex accounts and LLM API keys | New `pool_accounts` table in gateway.db with `provider_type` discriminator column and `credentials` JSON blob |
| POOL-02 | State machine: available -> in_use -> error -> cooldown -> disabled | Status column with CHECK constraint; `pool_status_history` table for audit trail; transition validation in PoolService |
| POOL-03 | Health score based on success rate and quota remaining | Computed column or on-read calculation from `usage_logs` table (already exists) + `provider_quota_statuses` table; cached in `health_score` column |
| POOL-04 | Group view/management by provider/type | `provider_type` column with values: `windsurf`, `codex`, `openai`, `anthropic`, `gemini`, `deepseek`, `moonshot`, `doubao`, `zhipu`, `openrouter`, `xai`, `siliconflow`, `ppio`, `other`; renderer filter by this column |
| POOL-05 | Manual add of third-party API keys | IPC handler `pool-add-account` with `provider_type` + `credentials.api_key` + optional `base_url` |
| POOL-06 | Manual enable/disable of any account | IPC handler `pool-set-status` with transition validation |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.8.0 | SQLite database engine | Already in project, used by gateway.db with WAL mode and migration system |
| electron | ^26.6.10 | Desktop app framework | Project is Electron-based |
| node:test | built-in (Node 22) | Test runner | Already used by existing tests, no additional dependency |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lucide | ^0.555.0 | Icon library | Already used in renderer, needed for pool view UI icons |
| node-cache | ^5.1.2 | In-memory cache | Health score caching to avoid recalculating on every read |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| New `pool_accounts` table in gateway.db | Separate pool.db SQLite file | Co-location with gateway avoids cross-DB joins; single migration system |
| `credentials` JSON blob | Separate columns per credential type | JSON blob is more flexible across 3 entity types; same pattern as existing `channels.credentials` |
| Status string with CHECK constraint | Separate status enum table | Simpler, matches existing pattern (channels.status uses CHECK) |

**Installation:**
```bash
# No new packages needed - all dependencies already in package.json
# better-sqlite3 ^12.8.0 already installed
# node-cache ^5.1.2 already installed
```

## Architecture Patterns

### Current Architecture (Pre-Phase-2)

```
Data Layer:
  accounts.json ── AccountService ── account IPC handlers ── renderer
  codex_accounts.json ── CodexAccountPool ── codex IPC handlers ── renderer
  gateway.db ── GatewayDataService ── gateway admin API ── GatewayManager (renderer)

Three separate account stores, no unified model, no shared state machine.
```

### Recommended Post-Phase-2 Architecture

```
Data Layer:
  gateway.db
    ├── pool_accounts (NEW) ── PoolService (NEW) ── pool IPC handlers (NEW) ── PoolView (NEW)
    ├── pool_status_history (NEW) ── PoolService
    └── channels (existing) ── AccountIntegrationService (adapted)

  accounts.json ── AccountService (kept for backward compat, synced FROM pool)
  codex_accounts.json ── CodexAccountPool (kept for backward compat, synced FROM pool)
```

### Pattern 1: Migration-Based Schema Addition

**What:** Add new tables via the existing migration system in `src/gateway/db.js`
**When to use:** Every schema change
**Example:**
```javascript
// Source: src/gateway/db.js existing pattern
const migrations = [
  // ... existing migration v1 ...
  {
    version: 2,
    name: 'pool_accounts',
    sql: `
      CREATE TABLE IF NOT EXISTS pool_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_type TEXT NOT NULL DEFAULT 'windsurf'
          CHECK(provider_type IN ('windsurf','codex','openai','anthropic','gemini',
            'deepseek','moonshot','doubao','zhipu','openrouter','xai',
            'siliconflow','ppio','claudecode','other')),
        email TEXT DEFAULT '',
        display_name TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'available'
          CHECK(status IN ('available','in_use','error','cooldown','disabled')),
        credentials TEXT DEFAULT '{}',
        health_score REAL DEFAULT 100.0,
        success_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        total_requests INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_error TEXT DEFAULT '',
        cooldown_until TEXT,
        tags TEXT DEFAULT '[]',
        remark TEXT DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual'
          CHECK(source IN ('manual','registration','import','codex')),
        source_ref TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pool_status ON pool_accounts(status, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_pool_provider ON pool_accounts(provider_type, deleted_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_email ON pool_accounts(email)
        WHERE email IS NOT NULL AND email != '' AND deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS pool_status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_account_id INTEGER NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        reason TEXT DEFAULT '',
        triggered_by TEXT NOT NULL DEFAULT 'manual'
          CHECK(triggered_by IN ('manual','system','registration','gateway','scheduler')),
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (pool_account_id) REFERENCES pool_accounts(id)
      );
      CREATE INDEX IF NOT EXISTS idx_status_history_account ON pool_status_history(pool_account_id, created_at);
    `
  }
];
```

### Pattern 2: PoolService Data Layer

**What:** New service class following AccountService/GatewayDataService patterns
**When to use:** All pool data access
**Example:**
```javascript
// Source: following src/services/accountService.js and src/services/gatewayDataService.js patterns
class PoolService {
  constructor(getDb) {
    this._getDb = getDb;
    this._cache = new Map();
  }

  getAll(filters = {}) {
    const db = this._getDb();
    let sql = 'SELECT * FROM pool_accounts WHERE deleted_at IS NULL';
    const params = [];
    if (filters.provider_type) {
      sql += ' AND provider_type = ?';
      params.push(filters.provider_type);
    }
    if (filters.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    sql += ' ORDER BY updated_at DESC';
    return db.prepare(sql).all(...params).map(row => this._parseRow(row));
  }

  _parseRow(row) {
    return {
      ...row,
      credentials: JSON.parse(row.credentials || '{}'),
      tags: JSON.parse(row.tags || '[]'),
    };
  }
}
```

### Pattern 3: IPC Handler Registration

**What:** Follow existing pattern in `src/main/ipc/*.js` with `registerHandlers(mainWindow, deps)`
**When to use:** All new IPC endpoints
**Example:**
```javascript
// Source: following src/main/ipc/account.js pattern
function registerHandlers(mainWindow, deps) {
  const { poolService } = deps;

  ipcMain.handle('pool-get-accounts', async (event, filters) => {
    try {
      const accounts = poolService.getAll(filters);
      return { success: true, accounts };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}
```

### Pattern 4: Renderer View Module

**What:** Self-contained renderer module with `init()` and `windowExports`
**When to use:** All new UI views
**Example:**
```javascript
// Source: following src/renderer/gatewayRenderer.js pattern
class PoolView {
  constructor() {
    this.currentFilter = 'all';
    this.currentGroupBy = 'provider';
  }

  async init() {
    this.bindEvents();
    await this.render();
  }

  async render() {
    const result = await window.ipcRenderer.invoke('pool-get-accounts', {
      provider_type: this.currentFilter === 'all' ? undefined : this.currentFilter,
    });
    if (result.success) {
      this.renderAccountGrid(result.accounts);
    }
  }
}
```

### Pattern 5: View Registration in renderer.js

**What:** Add new view div to index.html, register module in renderer.js, add nav button
**When to use:** Every new view
**Example:**
```html
<!-- index.html: new view container -->
<div id="pool" class="view-content">
  <!-- Pool view content -->
</div>

<!-- Navigation button -->
<button class="nav-item" data-view="pool" onclick="switchView('pool')">
  <i data-lucide="database" class="nav-item-icon"></i>
  <span>号池管理</span>
</button>
```

```javascript
// renderer.js: register and mount
const poolView = require('./src/renderer/poolView');
window.PoolView = poolView;
// In switchView: if (viewName === 'pool') { window.PoolView.init(); }
```

### Anti-Patterns to Avoid
- **Direct DB access from renderer:** All DB access must go through IPC -> service layer. The gateway admin API pattern (direct fetch to gateway server) should NOT be used for pool management -- pool IPC handlers give better control.
- **Mutation of service-returned objects:** Always return copies from service layer (spread operator), following AccountService pattern of `{ ...accounts[index], ...updates }`.
- **String concatenation for SQL:** Always use parameterized queries. The existing codebase consistently uses `?` placeholders.
- **Duplicating credential validation in IPC handlers:** Validate in PoolService, keep IPC handlers thin.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Database migration system | Custom migration tracking | Existing `schema_migrations` table + `runMigrations()` in `src/gateway/db.js` | Already proven with v1 migration, supports versioned ordering |
| File locking for concurrent access | Custom mutex | Existing `accountsFileLock` (singleton) if keeping JSON compat | Already handles queue-based locking |
| SQLite connection management | New connection per query | Existing `getDb()` singleton with WAL mode | WAL mode allows concurrent reads, busy_timeout handles contention |
| IPC error envelope | Ad-hoc error handling | Existing `{ success: boolean, error?: string, ...data }` pattern | Consistent across all 17+ IPC handlers |
| Health score calculation | Complex custom algorithm | Weighted formula: `0.7 * successRate + 0.3 * quotaRemaining` | Simple, transparent, sufficient for Phase 2; can be refined in Phase 6 |

**Key insight:** The project already has robust infrastructure for each concern. The unified pool should leverage existing patterns rather than inventing new ones.

## Common Pitfalls

### Pitfall 1: GatewayDataService constructor called without getDb
**What goes wrong:** In `main.js` line 377, `new GatewayDataService()` is called without the required `getDb` parameter. Any attempt to call `service.getDb()` will throw `TypeError: this._getDb is not a function`.
**Why it happens:** The constructor requires a function but main.js passes nothing.
**How to avoid:** When PoolService follows the same pattern, ensure main.js passes `getDb` from `src/gateway/db.js`. Verify the constructor call at startup.
**Warning signs:** `TypeError: this._getDb is not a function` on first pool operation.

### Pitfall 2: JSON blob column requires explicit parse/stringify
**What goes wrong:** `credentials` and `tags` columns store JSON strings. Reading them returns strings, not objects. Forgetting to `JSON.parse()` causes subtle bugs where `credentials.api_key` is `undefined`.
**Why it happens:** SQLite has no native JSON type; the existing `channels` table uses the same pattern with explicit parse in `admin.js` routes.
**How to avoid:** Always parse JSON columns in `_parseRow()` method of PoolService. Always stringify when writing. Follow the `admin.js` pattern exactly.
**Warning signs:** `credentials.api_key` returns `undefined` in renderer, or data appears as `"[object Object]"` in DB.

### Pitfall 3: CodexAccountPool lives in renderer process, not main
**What goes wrong:** `CodexAccountPool` is defined in `src/renderer/codexSwitchRenderer.js`, not in a main-process module. It directly uses `fs` and `axios`. If you try to `require()` it from a main-process IPC handler, it works but breaks the process boundary convention.
**Why it happens:** Historical code -- the pool was built as a renderer-only module that persists to `codex_accounts.json`.
**How to avoid:** Create a new main-process `PoolService` class. Do NOT reuse `CodexAccountPool` from the renderer. The migration should read `codex_accounts.json` and import into the DB pool, then the old file becomes a legacy export target.
**Warning signs:** `require()` path crossing renderer/main boundary.

### Pitfall 4: Three competing "account" concepts
**What goes wrong:** The codebase has "Windsurf accounts" (accounts.json, managed by account IPC), "Codex accounts" (codex_accounts.json, managed by codex IPC), and "gateway channels" (gateway.db, managed by admin API). Confusing which one you're working with leads to wrong data source bugs.
**Why it happens:** Organic growth without unification.
**How to avoid:** The unified pool introduces a single "pool account" concept. During migration, clearly map: `accounts.json -> pool_accounts(provider_type='windsurf')`, `codex_accounts.json -> pool_accounts(provider_type='codex')`, `channels(type=*) -> pool_accounts(provider_type=*)`. Old stores become read-only fallbacks.
**Warning signs:** IPC handler calling wrong service (e.g., pool handler calling `accountService` instead of `poolService`).

### Pitfall 5: Status enum mismatch between pool and channels
**What goes wrong:** Gateway `channels` use `enabled/disabled/archived`. Pool accounts use `available/in_use/error/cooldown/disabled`. If the integration service maps between them incorrectly, accounts get wrong statuses.
**Why it happens:** Different status models evolved independently.
**How to avoid:** Create explicit mapping functions: `poolStatusToChannelStatus()` and `channelStatusToPoolStatus()`. Never do inline status translation.
**Warning signs:** Accounts showing "disabled" in pool but "enabled" in gateway, or vice versa.

### Pitfall 6: Nav view proliferation
**What goes wrong:** Adding a "号池管理" nav button creates a 6th primary nav item, crowding the sidebar. The existing nav already has 5 items + 2 section labels.
**Why it happens:** Each phase adds a new view without reconsidering the nav structure.
**How to avoid:** Consider making "号池管理" a replacement for "账号中心" (rename/repurpose), or adding it under the "渠道网关" section since the pool feeds the gateway. Do NOT add a top-level nav item without considering the sidebar layout.
**Warning signs:** Sidebar overflow, unclear navigation hierarchy.

## Code Examples

### Migration v2: pool_accounts table
```javascript
// Source: src/gateway/db.js - following v1 migration pattern
{
  version: 2,
  name: 'pool_accounts',
  sql: `
    CREATE TABLE IF NOT EXISTS pool_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_type TEXT NOT NULL DEFAULT 'windsurf'
        CHECK(provider_type IN ('windsurf','codex','openai','anthropic','gemini',
          'deepseek','moonshot','doubao','zhipu','openrouter','xai',
          'siliconflow','ppio','claudecode','other')),
      email TEXT DEFAULT '',
      display_name TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'available'
        CHECK(status IN ('available','in_use','error','cooldown','disabled')),
      credentials TEXT DEFAULT '{}',
      health_score REAL DEFAULT 100.0,
      success_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      total_requests INTEGER DEFAULT 0,
      last_used_at TEXT,
      last_error TEXT DEFAULT '',
      cooldown_until TEXT,
      tags TEXT DEFAULT '[]',
      remark TEXT DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual'
        CHECK(source IN ('manual','registration','import','codex')),
      source_ref TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pool_status ON pool_accounts(status, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_pool_provider ON pool_accounts(provider_type, deleted_at);

    CREATE TABLE IF NOT EXISTS pool_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_account_id INTEGER NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      reason TEXT DEFAULT '',
      triggered_by TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (pool_account_id) REFERENCES pool_accounts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_status_history_account ON pool_status_history(pool_account_id, created_at);
  `
}
```

### PoolService: status transition validation
```javascript
// Source: designed from POOL-02 requirement
const VALID_TRANSITIONS = {
  available:  ['in_use', 'error', 'cooldown', 'disabled'],
  in_use:     ['available', 'error', 'cooldown', 'disabled'],
  error:      ['available', 'cooldown', 'disabled'],
  cooldown:   ['available', 'error', 'disabled'],
  disabled:   ['available'],
};

transitionStatus(accountId, newStatus, reason = '', triggeredBy = 'manual') {
  const db = this._getDb();
  const account = db.prepare('SELECT status FROM pool_accounts WHERE id = ?').get(accountId);
  if (!account) throw new Error('Account not found');

  const allowed = VALID_TRANSITIONS[account.status] || [];
  if (!allowed.includes(newStatus)) {
    throw new Error(`Invalid transition: ${account.status} -> ${newStatus}`);
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE pool_accounts SET status = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(newStatus, accountId);
    db.prepare(`INSERT INTO pool_status_history (pool_account_id, from_status, to_status, reason, triggered_by)
      VALUES (?, ?, ?, ?, ?)`)
      .run(accountId, account.status, newStatus, reason, triggeredBy);
  });
  tx();
  return true;
}
```

### PoolService: health score calculation
```javascript
// Source: designed from POOL-03 requirement
calculateHealthScore(account) {
  // Success rate component (0-100)
  const successRate = account.total_requests > 0
    ? (account.success_count / account.total_requests) * 100
    : 100;

  // Quota component (0-100) - from provider_quota_statuses if available
  const db = this._getDb();
  // For API key accounts, check channel quota
  // For Windsurf accounts, use credits/usage fields from credentials
  const quotaScore = this._getQuotaScore(account);

  // Weighted: 70% success rate, 30% quota remaining
  const healthScore = Math.round(0.7 * successRate + 0.3 * quotaScore);

  // Cache the result
  db.prepare('UPDATE pool_accounts SET health_score = ? WHERE id = ?')
    .run(healthScore, account.id);

  return healthScore;
}
```

### IPC handler pattern (following existing style)
```javascript
// Source: following src/main/ipc/account.js registerHandlers pattern
ipcMain.handle('pool-set-status', async (event, { accountId, newStatus, reason }) => {
  try {
    if (!accountId || !newStatus) {
      return { success: false, error: 'accountId and newStatus are required' };
    }
    poolService.transitionStatus(accountId, newStatus, reason, 'manual');
    const updated = poolService.getById(accountId);
    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pool-status-changed', { accountId, newStatus });
    }
    return { success: true, account: updated };
  } catch (error) {
    console.error('Pool status transition failed:', error);
    return { success: false, error: error.message };
  }
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Separate JSON files per account type | Unified SQLite table with discriminator | Phase 2 | Single source of truth, queryable, migration-safe |
| Status as ad-hoc string field | Enum with CHECK constraint + transition validation | Phase 2 | Prevents invalid states, auditable history |
| No health scoring | Weighted health_score column | Phase 2 | Enables smart routing (Phase 5), auto-recovery (Phase 6) |
| Manual account management only | Pool with manual + automatic status transitions | Phase 2 | Foundation for automated lifecycle (Phases 3-6) |

**Deprecated/outdated:**
- `CodexAccountPool` in renderer: Will be superseded by PoolService in main process. Keep as read-only legacy during transition.
- Direct `accounts.json` manipulation for Windsurf accounts: PoolService becomes the primary interface; accounts.json becomes a legacy sync target.

## Open Questions

1. **Migration strategy for existing accounts**
   - What we know: Windsurf accounts are in `accounts.json` (~N accounts), Codex accounts in `codex_accounts.json` (~M accounts). Both have different field schemas.
   - What's unclear: Should migration be automatic on first boot (with user confirmation dialog), or manual (button in settings)?
   - Recommendation: Automatic on first boot with a one-time migration dialog. Read both files, upsert into `pool_accounts`, mark `source` as `'manual'` or `'codex'` respectively. Keep original files as backup.

2. **Nav placement for pool view**
   - What we know: Current nav has 5 items + 2 sections. Adding another top-level item crowds the sidebar.
   - What's unclear: Should "号池" replace "账号中心" (since accounts will live in the pool), or be a separate nav item?
   - Recommendation: Replace "账号中心" with "号池管理" since the pool IS the account center. The old "账号中心" view becomes the pool view. This avoids nav proliferation.

3. **Backward compatibility with existing IPC handlers**
   - What we know: 17+ existing IPC handlers (`get-accounts`, `add-account`, `codex-get-accounts`, etc.) read from the old stores.
   - What's unclear: Should these handlers be updated to read from pool, or kept as-is with sync?
   - Recommendation: Update `get-accounts` and `load-accounts` to read from pool (via PoolService) while maintaining the same response format. This ensures existing renderer code continues working. Deprecate `codex-get-accounts` etc. in favor of `pool-get-accounts`.

4. **Third-party API key validation**
   - What we know: POOL-05 requires manual API key addition. Keys vary by provider (OpenAI uses `sk-*`, Anthropic uses `sk-ant-*`, etc.).
   - What's unclear: Should we validate key format on add, or trust user input?
   - Recommendation: Basic format validation (non-empty, no spaces). Full validation (API test call) is deferred to Phase 5/6 when the gateway actually uses the keys.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Test runner, build | Yes | 22.19.0 | -- |
| better-sqlite3 | Pool data storage | Yes | ^12.8.0 (installed) | -- |
| electron | App framework | Yes | ^26.6.10 | -- |
| node:test | Unit tests | Yes | built-in | -- |
| node-cache | Health score caching | Yes | ^5.1.2 (installed) | In-memory Map |

**Missing dependencies with no fallback:**
- None

**Missing dependencies with fallback:**
- None

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | node:test (built-in, Node 22) |
| Config file | none (tests use direct require) |
| Quick run command | `node --test tests/poolService.test.js` |
| Full suite command | `node --test tests/poolService.test.js tests/poolMigrations.test.js tests/poolIpc.test.js` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| POOL-01 | Unified data model supports all provider types | unit | `node --test tests/poolService.test.js` | No - Wave 0 |
| POOL-02 | Status transitions validate correctly | unit | `node --test tests/poolService.test.js::test_status_transitions` | No - Wave 0 |
| POOL-03 | Health score calculation | unit | `node --test tests/poolService.test.js::test_health_score` | No - Wave 0 |
| POOL-04 | Filter by provider_type | unit | `node --test tests/poolService.test.js::test_provider_filter` | No - Wave 0 |
| POOL-05 | Add API key account | unit | `node --test tests/poolService.test.js::test_add_api_key` | No - Wave 0 |
| POOL-06 | Enable/disable account | unit | `node --test tests/poolService.test.js::test_enable_disable` | No - Wave 0 |
| Migration | v2 migration creates tables correctly | unit | `node --test tests/poolMigrations.test.js` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `node --test tests/poolService.test.js`
- **Per wave merge:** `node --test tests/poolService.test.js tests/poolMigrations.test.js`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/poolService.test.js` - covers POOL-01 through POOL-06 unit tests
- [ ] `tests/poolMigrations.test.js` - covers migration v2 table creation and data import
- [ ] `tests/conftest.js` - shared test helpers (mock DB, mock IPC)

## Sources

### Primary (HIGH confidence)
- `src/gateway/db.js` - Full schema, migration system, all table definitions
- `src/services/accountService.js` - Account CRUD patterns, file lock usage
- `src/services/gatewayDataService.js` - SQLite query patterns
- `src/main/ipc/account.js` - IPC handler patterns (17 handlers analyzed)
- `src/main/ipc/codex.js` - Codex IPC patterns, CodexAccountPool usage
- `src/main/ipc/index.js` - Handler registration pattern
- `src/renderer/codexSwitchRenderer.js` - CodexAccountPool class (full implementation read)
- `src/renderer/gatewayRenderer.js` - Channel type labels, GatewayManager pattern
- `src/gateway/routes/admin.js` - Channel CRUD API patterns
- `src/gateway/biz/accountIntegration.js` - Account-to-channel sync logic
- `main.js` - Service initialization, dependency injection
- `renderer.js` - View switching, module loading, global exports
- `index.html` - Nav structure, view containers, CSS includes

### Secondary (MEDIUM confidence)
- `package.json` - Dependency versions, build config
- `tests/accountService.test.js` - Test patterns, mock strategies
- `tests/gatewayDataService.test.js` - Mock DB patterns

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all dependencies verified in package.json and tests pass
- Architecture: HIGH - all source files read, patterns extracted from working code
- Pitfalls: HIGH - GatewayDataService constructor bug found via direct code inspection; CodexAccountPool location verified

**Research date:** 2026-03-27
**Valid until:** 2026-04-27 (30 days - stable codebase, no fast-moving dependencies)
