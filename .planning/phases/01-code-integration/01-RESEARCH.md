# Phase 1: Code Integration - Research

**Researched:** 2026-03-27
**Domain:** Electron monolith renderer consolidation + data service layer abstraction
**Confidence:** HIGH

## Summary

Phase 1 consolidates three parallel renderer codebases (`js/`, `ui/`, `src/renderer/`) into a single `src/renderer/` module hierarchy and introduces a data service layer (`src/services/`) that abstracts direct filesystem and SQLite access. The current architecture loads 12 script tags in `index.html` in a fragile load order, and `renderer.js` (1166 lines) mixes orchestration with substantial business logic (account CRUD UI, batch registration, token operations, switch-account flows, current-account display). The IPC handler layer (`src/main/ipc/account.js`) contains ~22 direct `fs.readFile`/`fs.writeFile` calls against `accounts.json`, and 11 gateway modules directly call `getDb()` for SQLite access.

The migration is purely structural: no new features, no user-visible behavior changes, no data model redesign (deferred to Phase 2). The key challenge is the `window.*` global surface -- `js/` modules and `index.html` onclick handlers rely heavily on globals set by earlier scripts in the load order. The service layer must wrap existing storage mechanisms without changing them.

**Primary recommendation:** Follow the 5-step incremental migration order from CONTEXT.md (service stubs -> extract renderer.js modules -> migrate js/ files -> merge ui/ bootstrap -> update index.html), with each step verified by app launch.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Unify to `src/renderer/`, keep CommonJS `require()`. No ES modules / Vite bundling switch.
- **D-02:** Migrate ~10 files from `js/` into `src/renderer/`, merge 3 `ui/` bootstrap files into `src/renderer/` entry. `index.html` script tags reduced; renderer.js unified require loading.
- **D-03:** After migration, `js/` and `ui/` directories empty or deleted.
- **D-04:** Create abstract service layer, not migrate storage. `src/services/accountService.js` wraps accounts.json (with accountsFileLock), `src/services/gatewayDataService.js` wraps gateway.db.
- **D-05:** Business code accesses data through service layer only, no direct `fs.readFileSync` or `getDb()`.
- **D-06:** Actual storage unification (accounts.json -> SQLite) deferred to Phase 2.
- **D-07:** Extract renderer.js by functional module, aligned with `src/main/ipc/` domain split. New modules: accountRenderer, registrationRenderer, tokenRenderer, gatewayRenderer (merged from `js/gatewayManager.js`).
- **D-08:** Final renderer.js does only 3 things: (1) global init (Lucide, ipcRenderer), (2) require all modules + window exports, (3) IPC event delegation. Target < 200 lines.
- **D-09:** Incremental migration, each step keeps app launchable. Order: service stubs -> extract renderer.js modules -> migrate js/ files -> merge ui/ bootstrap -> update index.html.
- **D-10:** After each step verify: app launches, views switch, core functions (account list, registration, gateway management) work.

### Claude's Discretion
- Specific file naming and module internal organization
- Which renderer.js logic is "orchestration" (keep) vs "business" (extract)
- Minor interface adjustments to eliminate circular dependencies during migration

### Deferred Ideas (OUT OF SCOPE)
- None
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INTG-01 | Renderer layer unified into single module system, eliminating js/ / ui/ / src/renderer/ parallel structure | Full file inventory, dependency graph, load order analysis, module extraction plan |
| INTG-02 | Data layer unified interface: accounts.json and gateway.db accessed through unified service layer | Data access audit (22 fs calls in account.js, 11 getDb() usages), service abstraction design |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js built-in `node:test` | 22.19.0 | Test framework | Already used by existing tests (emailReceiver.test.js, accountDateFilter.test.js); no external test runner needed |
| better-sqlite3 | existing | SQLite driver for gateway.db | Already in use; gatewayDataService wraps it, not replaces |
| electron | existing | IPC, BrowserWindow | No version changes; renderer consolidation is code organization only |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| accountsFileLock.js | existing (singleton) | Concurrent write protection | Reused inside accountService.js; no changes to lock mechanism |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| node:test | Jest/Vitest | Would need to install and configure; node:test is zero-config and already used |
| Service class pattern | Repository pattern with interfaces | Repository pattern is over-engineering for wrapping 2 data stores; class with methods is sufficient |

**Installation:** No new packages needed. This phase is pure code reorganization.

## Architecture Patterns

### Recommended Target Structure
```
src/
├── renderer/
│   ├── state.js              # (existing) Shared renderer state
│   ├── ipcBridge.js          # (existing) IPC call wrapper
│   ├── uiHelpers.js          # (existing) Toast, alert, helpers
│   ├── modals.js             # (existing) Modal dialogs
│   ├── versionCheck.js       # (existing) Version/maintenance
│   ├── emailConfig.js        # (existing) IMAP settings UI
│   ├── codexManager.js       # (existing) Codex management
│   ├── accountRenderer.js    # (NEW) Account CRUD UI from renderer.js + js/accountManager.js
│   ├── registrationRenderer.js # (NEW) Batch registration from renderer.js
│   ├── tokenRenderer.js      # (NEW) Batch token + token tab init from renderer.js
│   ├── switchRenderer.js     # (NEW) Account switching + used-accounts grid from renderer.js
│   ├── gatewayRenderer.js    # (NEW) Merged from js/gatewayManager.js
│   ├── configRenderer.js     # (NEW) From js/configManager.js
│   ├── domainRenderer.js     # (NEW) From js/domainManager.js
│   ├── queryRenderer.js      # (NEW) From js/accountQuery.js
│   ├── filterRenderer.js     # (NEW) From js/accountDateFilter.js
│   ├── cardRenderer.js       # (NEW) From js/autoBindCard.js
│   ├── loginRenderer.js      # (NEW) From js/accountLogin.js
│   ├── codexSwitchRenderer.js # (NEW) From js/codexAccountSwitcher.js
│   ├── pathRenderer.js       # (NEW) From js/filePathManager.js
│   ├── detectorRenderer.js   # (NEW) From js/currentAccountDetector.js
│   ├── sqliteHelperRenderer.js # (NEW) From js/sqliteHelper.js
│   └── constants.js          # (NEW) From js/constants.js
├── services/
│   ├── accountService.js     # (NEW) Abstracts accounts.json read/write
│   ├── gatewayDataService.js # (NEW) Abstracts gateway.db operations
│   ├── tokenUtils.js         # (existing)
│   ├── windsurfPaths.js      # (existing)
│   └── firebaseAuth.js       # (existing)
└── main/ipc/                 # (existing, updated to call service layer)
```

### Pattern 1: Service Layer Wrapper
**What:** Thin service class that encapsulates file I/O or DB access, exposing domain-oriented methods. IPC handlers call service methods instead of raw fs/DB calls.
**When to use:** All data access from `src/main/ipc/` must go through service layer.
**Example:**
```javascript
// src/services/accountService.js
const fs = require('fs').promises;
const accountsFileLock = require('../accountsFileLock');

class AccountService {
  constructor(accountsFilePath) {
    this.accountsFilePath = accountsFilePath;
  }

  async getAll() {
    const data = await accountsFileLock.acquire(async () => {
      const raw = await fs.readFile(this.accountsFilePath, 'utf-8');
      return JSON.parse(raw);
    });
    return data;
  }

  async save(accounts) {
    await accountsFileLock.acquire(async () => {
      await fs.writeFile(this.accountsFilePath, JSON.stringify(accounts, null, 2), 'utf-8');
    });
  }

  async add(account) {
    const accounts = await this.getAll();
    accounts.push(account);
    await this.save(accounts);
    return account;
  }

  // ... getById, update, delete, deleteAll, etc.
}

module.exports = AccountService;
```

### Pattern 2: Lazy Module Require in renderer.js
**What:** Instead of loading all js/ files via index.html script tags, renderer.js uses `require()` and mounts to `window`. This preserves the global surface that HTML onclick handlers depend on.
**When to use:** All migrated modules that set `window.*` globals.
**Example:**
```javascript
// renderer.js (final form)
const accountRenderer = require('./src/renderer/accountRenderer');
const tokenRenderer = require('./src/renderer/tokenRenderer');
// ... other modules

// Mount globals for HTML onclick compatibility
Object.assign(window, accountRenderer.windowExports);
Object.assign(window, tokenRenderer.windowExports);
```

### Pattern 3: Module Exports Contract
**What:** Each migrated module exports a `windowExports` object containing all functions that must be available as `window.*` globals. This makes the migration explicit and testable.
**When to use:** All modules migrated from `js/` that currently set `window.*` in their module body.
**Example:**
```javascript
// src/renderer/accountRenderer.js
const AccountManager = { /* ... */ };

module.exports = {
  AccountManager,
  windowExports: {
    AccountManager,
    loadAccounts: AccountManager.loadAccounts,
    deleteAllAccounts: AccountManager.deleteAllAccounts,
    // ... all functions referenced by index.html onclick
  },
};
```

### Anti-Patterns to Avoid
- **Changing load order semantics:** The 12-script load order is fragile but functional. During migration, ensure each module's dependencies are satisfied before it runs. The safest approach: migrate in order of dependency (leaf modules first).
- **Breaking window.* globals:** HTML onclick handlers like `onclick="AccountManager.setListScope('today')"` require `window.AccountManager` to exist. Migration must maintain these globals.
- **Double-requiring electron:** Multiple modules call `require('electron').ipcRenderer`. After consolidation, ipcRenderer should be set once in renderer.js init and shared via `window.ipcRenderer`.
- **Creating circular dependencies:** Some js/ files conditionally use `window.AccountQuery`, `window.ConfigManager`, etc. After migration to `require()`, use lazy references or dependency injection to avoid cycles.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File locking | Custom mutex | Existing `src/accountsFileLock.js` | Already implements queue-based async lock with singleton pattern |
| SQLite connection management | Connection pooling | Existing `src/gateway/db.js` `getDb()` | Already handles lazy init, WAL mode, migrations |
| IPC safety wrapper | Custom error handling | Existing `src/renderer/ipcBridge.js` `safeIpcInvoke` | Already handles maintenance mode, error logging |
| Modal dialogs | Custom DOM manipulation | Existing `src/renderer/modals.js` | 36KB of battle-tested modal logic |
| UI state management | Redux/Zustand | Existing `src/renderer/state.js` | Simple mutable state object, appropriate for Electron app |

**Key insight:** This phase is about consolidation, not invention. Reuse every existing abstraction; only create the new service layer wrapper classes.

## Common Pitfalls

### Pitfall 1: Script Load Order Fragility
**What goes wrong:** After migration, some modules fail because they depend on globals set by other modules that haven't loaded yet. For example, `js/accountManager.js` checks `window.AccountDateFilter` at require time.
**Why it happens:** Current architecture uses 12 sequential `<script>` tags to establish dependency order. Converting to `require()` changes evaluation timing.
**How to avoid:** Audit each `js/` file for runtime `window.*` checks (not just `require()` imports). Convert these to explicit `require()` calls with the module's actual path. Test each module in isolation after migration.
**Warning signs:** `typeof window.X !== 'undefined'` checks at module top level; conditional requires based on `window` availability.

### Pitfall 2: gatewayInit.js Monkey-Patching switchView
**What goes wrong:** `ui/gatewayInit.js` wraps `window.switchView` with a closure that lazily initializes `GatewayManager`. If `switchView` is moved or renamed, the monkey-patch breaks silently.
**Why it happens:** The module captures the original function reference and replaces it. This is a side-effect pattern that doesn't survive refactoring well.
**How to avoid:** During ui/ merge step, convert the monkey-patch to an explicit event listener or integrate gateway init into the unified `switchView`/`switchTab` flow in renderer.js.
**Warning signs:** `_origSwitchView` pattern, function reassignment on `window`.

### Pitfall 3: Duplicate ipcRenderer Assignment
**What goes wrong:** Both `ui/bootstrap.js` (line 8) and `renderer.js` (line 29) set `window.ipcRenderer = require('electron').ipcRenderer`. After migration, removing `ui/bootstrap.js` could break modules that relied on it running first.
**Why it happens:** Two separate entry points both initialize the same global.
**How to avoid:** Single ipcRenderer initialization in renderer.js init block. Ensure no migrated module tries to set `window.ipcRenderer` itself.
**Warning signs:** Multiple `window.ipcRenderer =` assignments across files.

### Pitfall 4: configManager.js Global Side Effects
**What goes wrong:** `js/configManager.js` (14545 bytes, 426 lines) is loaded early and used by `js/tokenGetter.js`, `js/domainManager.js`, and `js/accountQuery.js` via `window.ConfigManager`. If the migration doesn't set this global before dependent modules run, they break.
**Why it happens:** ConfigManager provides both data (file paths, loaded config) and behavior (loadConfig, saveConfig, updateAccount). It's the widest dependency in the js/ tree.
**How to avoid:** Migrate configManager.js early (it's a leaf dependency), and ensure it's required before modules that reference `window.ConfigManager`. Convert `window.ConfigManager` references to direct `require()`.
**Warning signs:** `window.ConfigManager.getConfigFilePath()` calls scattered across 6+ files.

### Pitfall 5: accountService.js Must Not Change Data Format
**What goes wrong:** During service layer creation, the new abstraction accidentally changes JSON serialization (indentation, key order, encoding) which breaks consumers that rely on exact format.
**Why it happens:** `JSON.stringify(accounts, null, 2)` with specific encoding options is used consistently; any deviation (e.g., compact JSON, different encoding) could cause issues.
**How to avoid:** Extract the exact write pattern from existing code: `JSON.stringify(data, null, 2)` with `{ encoding: 'utf-8' }`. Use identical patterns in service methods.
**Warning signs:** Custom JSON serialization, encoding options in write calls.

## Code Examples

### Current Data Access Pattern (to be wrapped)
```javascript
// src/main/ipc/account.js (current - 22 occurrences of this pattern)
const data = await fs.readFile(accountsFilePath, 'utf-8');
const accounts = JSON.parse(data);
// ... modify accounts ...
await fs.writeFile(accountsFilePath, JSON.stringify(accounts, null, 2), { encoding: 'utf-8' });
```

### Target Data Access Pattern (via service)
```javascript
// src/main/ipc/account.js (after migration)
const accounts = await accountService.getAll();
// ... modify accounts ...
await accountService.save(accounts);
```

### Current Script Load Order in index.html
```html
<!-- HEAD - loaded before body -->
<script src="ui/bootstrap.js"></script>          <!-- 1: ipcRenderer, ConfigManager, CONSTANTS, axios -->
<script src="js/filePathManager.js"></script>     <!-- 2 -->
<script src="js/domainManager.js"></script>       <!-- 3: depends on ConfigManager -->
<script src="js/accountQuery.js"></script>        <!-- 4: depends on axios, CONSTANTS -->
<script src="js/accountDateFilter.js"></script>   <!-- 5 -->
<script src="js/accountManager.js"></script>      <!-- 6: depends on AccountDateFilter, AccountQuery -->
<script src="js/accountSwitcher.js"></script>     <!-- 7 -->
<script src="js/currentAccountDetector.js"></script> <!-- 8 -->
<script src="js/autoBindCard.js"></script>        <!-- 9 -->

<!-- BODY - loaded after DOM -->
<script src="ui/viewController.js"></script>     <!-- 10: switchView -->
<script src="js/gatewayManager.js"></script>      <!-- 11: GatewayManager class -->
<script src="ui/gatewayInit.js"></script>         <!-- 12: wraps switchView -->
<script src="renderer.js"></script>               <!-- 13: orchestrator -->
```

### Migration-Safe Module Require Order
```javascript
// renderer.js - consolidated require order (respects dependency graph)
'use strict';

// 1. Electron & global init
window.ipcRenderer = require('electron').ipcRenderer;
const { shell } = require('electron');

// 2. Constants & config (leaf dependencies)
const constants = require('./src/renderer/constants');
const configRenderer = require('./src/renderer/configRenderer');

// 3. Cross-cutting (no domain deps)
const state = require('./src/renderer/state');
const ipcBridge = require('./src/renderer/ipcBridge');
const uiHelpers = require('./src/renderer/uiHelpers');
const modals = require('./src/renderer/modals');

// 4. Domain modules (can depend on 1-3)
const filterRenderer = require('./src/renderer/filterRenderer');
const queryRenderer = require('./src/renderer/queryRenderer');
const domainRenderer = require('./src/renderer/domainRenderer');
// ... etc.

// 5. Mount window exports
Object.assign(window, configRenderer.windowExports);
// ... etc.
```

## Runtime State Inventory

> Not applicable -- this is a code reorganization phase, not a rename/refactor. No strings are being renamed. File paths change but only within the project source tree; no external services, databases, or OS registrations reference `js/` or `ui/` directory paths.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None -- no database collections or file keys reference `js/` or `ui/` paths | N/A |
| Live service config | None -- gateway listens on port, no path-dependent config | N/A |
| OS-registered state | None -- no scheduled tasks reference project paths | N/A |
| Secrets/env vars | None -- no env var names reference renderer directories | N/A |
| Build artifacts | `electron.vite.config.js` references `main.js` and `index.html` as entry points -- both stay at root, unchanged | None (renderer.js stays at root per D-08) |

## Environment Availability

Step 2.6: SKIPPED (no external dependencies identified -- this phase is pure code reorganization within the existing Electron project)

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | node:test (Node.js built-in) + node:assert/strict |
| Config file | none -- zero config test runner |
| Quick run command | `node --test tests/<file>.test.js` |
| Full suite command | `node --test tests/*.test.js` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INTG-01 | renderer.js < 200 lines after extraction | smoke | `wc -l renderer.js` (verify < 200) | No -- Wave 0 |
| INTG-01 | js/ directory empty or deleted | smoke | `ls js/` (verify empty) | No -- Wave 0 |
| INTG-01 | ui/ directory empty or deleted | smoke | `ls ui/` (verify empty) | No -- Wave 0 |
| INTG-01 | All migrated modules require() successfully | unit | `node --test tests/rendererModules.test.js` | No -- Wave 0 |
| INTG-01 | index.html has <= 3 script tags (lucide + renderer + maybe one more) | smoke | `grep -c '<script' index.html` | No -- Wave 0 |
| INTG-02 | accountService wraps all accounts.json access | unit | `node --test tests/accountService.test.js` | No -- Wave 0 |
| INTG-02 | gatewayDataService wraps getDb() | unit | `node --test tests/gatewayDataService.test.js` | No -- Wave 0 |
| INTG-02 | No direct fs calls to accounts.json in ipc handlers | grep audit | `grep -r "readFile.*accounts" src/main/ipc/` should return 0 | No -- Wave 0 |
| INTG-02 | No direct getDb() calls outside service layer and gateway/ | grep audit | `grep -r "getDb()" src/main/ipc/ src/services/` should return 0 outside service | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `node --test tests/*.test.js` (quick run)
- **Per wave merge:** `node --test tests/*.test.js` + manual app launch verification
- **Phase gate:** Full suite green + manual app launch with core flows verified before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/accountService.test.js` -- covers INTG-02 account service
- [ ] `tests/gatewayDataService.test.js` -- covers INTG-02 gateway data service
- [ ] `tests/rendererModules.test.js` -- covers INTG-01 module require chain
- [ ] `tests/smokeStructure.test.js` -- covers INTG-01 directory/file structure checks
- [ ] Framework install: none needed -- `node:test` is built-in

## Open Questions

1. **Should constants.js and configManager.js migrate as-is or be split?**
   - What we know: `js/constants.js` is small (1543 bytes), `js/configManager.js` is large (14545 bytes, 426 lines) and provides both data and behavior.
   - What's unclear: Whether configManager should be split into a pure data module (for src/services/) and a UI module (for src/renderer/).
   - Recommendation: Migrate as-is first; splitting is an optimization that can happen later if needed. The service layer (D-04) is the right place to abstract config file I/O.

2. **How to handle the tokenGetter.js lazy require in renderer.js?**
   - What we know: `renderer.js` line 263 does `window.TokenGetter = require('./js/tokenGetter')` inside `switchTabLogic` -- a lazy require triggered only when the user clicks the Token tab.
   - What's unclear: Whether tokenGetter should remain lazy-loaded or be eagerly required.
   - Recommendation: Keep lazy loading -- tokenGetter is 42KB and only needed for one tab. Move the require path to `./src/renderer/tokenRenderer` but keep the lazy pattern.

3. **Should the service layer be instantiated where?**
   - What we know: IPC handlers receive `deps` including `ACCOUNTS_FILE` path and `accountsFileLock`. The service layer needs the file path.
   - What's unclear: Whether to instantiate in `main.js` and pass via deps, or instantiate within each IPC handler module.
   - Recommendation: Instantiate in `main.js` (single source of truth for paths), pass as part of `deps` to `registerAllHandlers`. This matches the existing dependency injection pattern.

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis of all 15 files in `js/`, 3 files in `ui/`, 8 files in `src/renderer/`, 7 files in `src/main/ipc/`
- `.planning/codebase/ARCHITECTURE.md` -- layer boundaries, data flows, key abstractions
- `.planning/codebase/STRUCTURE.md` -- directory layout, file purposes, naming conventions
- `.planning/codebase/CONVENTIONS.md` -- module system (CommonJS), import order, error handling
- `.planning/codebase/CONCERNS.md` -- tech debt inventory, security considerations, known bugs

### Secondary (MEDIUM confidence)
- CONTEXT.md locked decisions D-01 through D-10 -- migration strategy and constraints
- Existing test files (`tests/emailReceiver.test.js`, `tests/accountDateFilter.test.js`) -- test framework pattern (node:test)

### Tertiary (LOW confidence)
- None -- all findings are based on direct codebase analysis, no external web sources needed

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new packages, only code reorganization using existing dependencies
- Architecture: HIGH - complete codebase analysis with line counts, dependency graphs, and load order mapping
- Pitfalls: HIGH - identified from direct code inspection, especially fragile patterns like window.* globals, monkey-patching, and conditional requires

**Research date:** 2026-03-27
**Valid until:** 60 days (code organization patterns are stable; no external dependencies to go stale)
