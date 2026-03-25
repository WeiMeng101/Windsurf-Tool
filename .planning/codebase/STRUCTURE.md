# Codebase Structure

**Analysis Date:** 2026-03-26

## Directory Layout

```
Windsurf-Tool/
├── main.js                 # Electron main: window, IPC registration, gateway start
├── main.prod.js            # Production-oriented main entry (build pipeline)
├── index.html              # Shell UI: links css/, ordered <script> tags, views
├── renderer.js             # Renderer orchestrator; requires src/renderer/* modules
├── package.json            # Dependencies, electron-builder, scripts
├── electron.vite.config.js # electron-vite: main + renderer inputs/outputs
├── css/                    # Modular stylesheets (variables, layout, components, views)
├── js/                     # Renderer-side domain modules (accounts, paths, sqlite helpers)
├── ui/                     # bootstrap, view routing, gateway view init
├── src/
│   ├── main/ipc/           # ipcMain handlers by domain
│   ├── gateway/            # Express server, LLM pipeline, DB, routes, biz, transformers
│   ├── renderer/           # Modular renderer logic (IPC bridge, modals, Codex UI)
│   ├── services/           # tokenUtils, windsurfPaths, firebaseAuth
│   ├── registrationBot.js, registrationBotCancel.js, codexRegistrationBot.js
│   ├── emailReceiver.js, machineIdResetter.js, accountsFileLock.js
│   └── ...
├── tests/                  # Node tests (e.g. *.test.js)
├── build-scripts/          # afterPack, native rebuild, prepare/restore main
└── 参考/                   # Reference/third-party material (not app runtime)
```

## Directory Purposes

**Root (`/`):**
- Purpose: Electron entry (`main.js`), single-page app host (`index.html`), renderer entry (`renderer.js`), tooling config.
- Contains: `package.json`, `electron.vite.config.js`, top-level HTML/JS.
- Key files: `main.js`, `index.html`, `renderer.js`, `package.json`

**`css/`:**
- Purpose: Presentational styles split by concern.
- Contains: `variables.css`, `base.css`, `layout.css`, `responsive.css`, `animations.css`, `components/*.css`, `views/*.css`.
- Key files: `css/variables.css`, `css/layout.css`

**`js/`:**
- Purpose: Account management, config, file paths, SQLite helpers, gateway manager, constants — loaded before `renderer.js` in `index.html`.
- Contains: `accountManager.js`, `accountSwitcher.js`, `configManager.js`, `filePathManager.js`, `gatewayManager.js`, `sqliteHelper.js`, `constants.js`, etc.
- Key files: `js/accountManager.js`, `js/constants.js`

**`ui/`:**
- Purpose: Early renderer bootstrap and view-specific bootstrapping.
- Contains: `bootstrap.js` (ConfigManager, CONSTANTS, axios on `window`), `viewController.js` (`switchView`, modals/navigation helpers), `gatewayInit.js`.
- Key files: `ui/bootstrap.js`, `ui/viewController.js`, `ui/gatewayInit.js`

**`src/main/ipc/`:**
- Purpose: Isolate `ipcMain` registration per domain for maintainability.
- Contains: `index.js` aggregator, `account.js`, `registration.js`, `codex.js`, `gateway.js`, `system.js`, `config.js`.
- Key files: `src/main/ipc/index.js`, `src/main/ipc/account.js`

**`src/gateway/`:**
- Purpose: Embedded HTTP API and LLM proxy.
- Contains: `server.js`, `db.js`, `cache.js`, `logger.js`, `middleware/`, `routes/`, `llm/pipeline.js`, `llm/streams.js`, `llm/transformer/*`, `biz/*.js`.
- Key files: `src/gateway/server.js`, `src/gateway/db.js`, `src/gateway/llm/pipeline.js`, `src/gateway/routes/admin.js`

**`src/renderer/`:**
- Purpose: Non-trivial renderer logic extracted from a single giant script.
- Contains: `state.js`, `ipcBridge.js`, `uiHelpers.js`, `modals.js`, `versionCheck.js`, `emailConfig.js`, `codexManager.js`.
- Key files: `src/renderer/ipcBridge.js`, `src/renderer/modals.js`

**`src/services/`:**
- Purpose: Cross-cutting helpers usable from main or other `src/` modules.
- Contains: `tokenUtils.js`, `windsurfPaths.js`, `firebaseAuth.js`.
- Key files: `src/services/windsurfPaths.js`

**`tests/`:**
- Purpose: Automated tests co-located at project level (not inside `src/`).
- Contains: `emailReceiver.test.js`, `accountDateFilter.test.js`, etc.
- Key files: `tests/emailReceiver.test.js`

**`build-scripts/`:**
- Purpose: Packaging hooks and native module handling for Electron builder.
- Contains: `afterPack.js`, `prepare-main.js`, `restore-main.js`, `rebuildNativeModules.js`, etc.
- Key files: `build-scripts/afterPack.js`

**`参考/`:**
- Purpose: External reference code and sample assets; not imported by `main.js` for core app behavior.
- Contains: Large vendored or sample trees; treat as read-only reference when navigating the product codebase.

## Key File Locations

**Entry Points:**
- `main.js`: Electron main process bootstrap and gateway lifecycle.
- `index.html`: UI shell and script load order for renderer.
- `renderer.js`: Post-`js/*` orchestration and `window` exports.

**Configuration:**
- `package.json`: Scripts, `dependencies`, `build` (electron-builder), `main` field.
- `electron.vite.config.js`: Vite inputs/outputs and externals for Electron.
- `.env.example`: Documented env vars (do not commit real secrets).

**Core Logic:**
- `src/main/ipc/*.js`: Privileged operations from UI requests.
- `src/gateway/server.js` + `src/gateway/llm/pipeline.js`: Local API and LLM proxy.
- `src/registrationBot.js`, `src/codexRegistrationBot.js`, `src/emailReceiver.js`: Automation and mail integration.

**Testing:**
- `tests/*.test.js`: Project-level test files; run via project test script if defined in `package.json` (verify scripts before adding new runners).

## Naming Conventions

**Files:**
- **camelCase.js** for application modules (`accountManager.js`, `ipcBridge.js`).
- **kebab-case** less common; gateway and IPC files use **camelCase** or single-word (`server.js`, `db.js`).
- Test suffix: `*.test.js` under `tests/`.

**Directories:**
- **lowercase** with slashes for feature areas: `src/main/ipc`, `src/gateway/llm/transformer/openai`.
- **PascalCase** not used for folders; `biz`, `routes`, `middleware` are lowercase nouns.

**IPC channels:**
- **kebab-case** string literals (e.g. `check-for-updates`, `get-file-paths`) — align new channels with existing `src/main/ipc/*` and renderer callers.

**SQL / DB:**
- **snake_case** column names in gateway migrations (e.g. `ordering_weight`, `deleted_at` in `src/gateway/db.js`).

## Where to Add New Code

**New main-process capability (filesystem, automation, new privileged API):**
- Primary code: new `registerHandlers` module under `src/main/ipc/` or extend the closest domain file (`account.js`, `system.js`, etc.).
- Registration: add `require` + `registerHandlers` call in `src/main/ipc/index.js`.

**New HTTP gateway route or admin API:**
- Routes: `src/gateway/routes/admin.js` or new router mounted in `src/gateway/server.js`.
- Middleware: `src/gateway/middleware/`.
- LLM provider support: new outbound/inbound under `src/gateway/llm/transformer/<provider>/index.js`, register in `src/gateway/llm/transformer/registry.js`.

**New DB table or migration:**
- Migrations array / schema in `src/gateway/db.js` (follow existing `migrations` pattern).

**New renderer feature (UI + IPC client):**
- DOM/HTML: `index.html` (new view section + nav button pattern used by `switchView`).
- Logic: prefer `src/renderer/<feature>.js` and `require` + `window` exports from `renderer.js` for globals used in HTML `onclick`.
- IPC wrapper: reuse `src/renderer/ipcBridge.js` patterns.

**Shared helpers (no UI, no Express):**
- `src/services/` for cross-cutting utilities used from IPC or bots.

**Client-only account UI logic (legacy style):**
- `js/` when the script is loaded directly from `index.html` before `renderer.js` and must stay compatible with non-module globals.

**Tests:**
- Add `tests/<module>.test.js` mirroring the module under test (`src/` or `js/`).

## Special Directories

**`dist/` (when built):**
- Purpose: electron-vite output (`dist/main`, `dist/renderer`).
- Generated: Yes, by `npm run build:vite` / dev server.
- Committed: Typically no — confirm `.gitignore`.

**`参考/`:**
- Purpose: Reference-only trees and samples.
- Generated: No.
- Committed: May be present locally; do not treat as application source for imports.

---

*Structure analysis: 2026-03-26*
