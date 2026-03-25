# Architecture

**Analysis Date:** 2026-03-26

## Pattern Overview

**Overall:** Electron monolith with **main process orchestration**, **renderer-side UI** (Node integration enabled), and an **in-process HTTP API gateway** (Express) that shares the same Node/Electron runtime as the desktop shell.

**Key Characteristics:**
- Single repository; no separate backend service process — the gateway starts inside `app.whenReady()` in `main.js`.
- IPC is the primary bridge from UI to filesystem, automation (Puppeteer), and account data.
- LLM traffic is proxied through a **pipeline + pluggable transformers** pattern (`src/gateway/llm/`), backed by SQLite for channels and request metadata.
- UI loads as classic static HTML with many script tags (`index.html`) plus a **thin orchestrator** (`renderer.js`) that delegates to `src/renderer/*` modules.

## Layers

**Electron main process (shell & privileged I/O):**
- Purpose: Window lifecycle, shared `state`, IPC registration, optional gateway bootstrap, OS integration (paths, menus, dialogs).
- Location: `main.js` (root), `main.prod.js` (production variant if used by build pipeline).
- Contains: `BrowserWindow` setup, `initializeConfigFiles`, `registerAllHandlers` wiring, `GatewayServer` start/stop.
- Depends on: `electron`, Node built-ins, `src/main/ipc/*`, `src/gateway/server.js`, `src/accountsFileLock.js`.
- Used by: OS / Electron runtime only (not imported by renderer directly).

**IPC handler layer (domain boundaries on main):**
- Purpose: Map `ipcMain.handle` / `ipcMain.on` channels to business operations (accounts, registration, Codex, config, system, gateway metadata).
- Location: `src/main/ipc/index.js` (aggregator), `src/main/ipc/account.js`, `registration.js`, `codex.js`, `gateway.js`, `system.js`, `config.js`.
- Contains: Per-domain `registerHandlers(mainWindow, deps)` functions; `deps` includes `ACCOUNTS_FILE`, `accountsFileLock`, `userDataPath`, `appRoot`, `state`.
- Depends on: Feature modules under `src/` (e.g. `src/registrationBot.js`, `src/emailReceiver.js`, `src/codexRegistrationBot.js`), `js/` helpers where still required from main, filesystem, Puppeteer paths.
- Used by: Renderer via `ipcRenderer.invoke` / `send` (wrapped by `src/renderer/ipcBridge.js`).

**HTTP gateway (Express, OpenAI/Anthropic/Gemini-compatible surface):**
- Purpose: Local API server for chat/completions, responses, embeddings, images, provider-specific routes; admin CRUD for channels; health checks.
- Location: `src/gateway/server.js` (`GatewayServer` class), `src/gateway/routes/health.js`, `src/gateway/routes/admin.js`, `src/gateway/middleware/auth.js`, `src/gateway/middleware/tracing.js`.
- Contains: Route registration, handler methods delegating to pipeline, middleware stack (helmet, cors, json, tracing).
- Depends on: `src/gateway/llm/pipeline.js`, `src/gateway/db.js`, `src/gateway/cache.js`, `src/gateway/logger.js`.
- Used by: External HTTP clients on `127.0.0.1` (default port 8090); UI may discover port via IPC `get-gateway-port` in `src/main/ipc/gateway.js`.

**LLM pipeline & transformers:**
- Purpose: Normalize inbound API format, resolve model → channels from DB, call outbound provider with retries, stream/non-stream handling, usage/trace recording.
- Location: `src/gateway/llm/pipeline.js`, `src/gateway/llm/streams.js`, `src/gateway/llm/transformer/interfaces.js`, `src/gateway/llm/transformer/registry.js`, per-provider folders under `src/gateway/llm/transformer/*/index.js`.
- Contains: `Pipeline.execute(req, res, format)`, `InboundTransformer` / `OutboundTransformer` base classes, `TransformerRegistry` singleton `registry`.
- Depends on: `axios`, `getDb()` from `src/gateway/db.js`, `cacheManager` from `src/gateway/cache.js`.
- Used by: `GatewayServer` handler methods in `src/gateway/server.js`.

**Gateway persistence & cross-cutting:**
- Purpose: SQLite schema/migrations for channels, requests, quotas, traces, etc.; structured logging; in-memory cache helpers.
- Location: `src/gateway/db.js`, `src/gateway/logger.js`, `src/gateway/cache.js`, business modules `src/gateway/biz/*.js` (e.g. `loadBalancer.js`, `quota.js`, `oauth.js`, `accountIntegration.js`, `trace.js`, `costCalc.js`, `promptProtection.js`, `backup.js`).
- Depends on: `better-sqlite3` (with load fallback handling in `db.js`), `winston` (via logger).
- Used by: Pipeline, admin routes, and biz modules as imported.

**Renderer / UI layer:**
- Purpose: DOM views, navigation, toasts/modals, Codex UI glue, version check flows; exposes globals for `onclick` and legacy scripts.
- Location: `index.html` (markup + CSS links + script order), `renderer.js` (orchestrator), `src/renderer/state.js`, `ipcBridge.js`, `uiHelpers.js`, `modals.js`, `versionCheck.js`, `emailConfig.js`, `codexManager.js`, `ui/bootstrap.js`, `ui/viewController.js`, `ui/gatewayInit.js`.
- Contains: `require('electron').ipcRenderer` usage, `window.*` exports, view switching (`switchView` in `ui/viewController.js`).
- Depends on: `js/*` account/domain/config modules loaded before `renderer.js` in `index.html`.
- Used by: User; communicates with main only through IPC (and HTTP to local gateway from gateway UI scripts if present).

**Automation & integration services (shared `src/`):**
- Purpose: Registration bots, email receiving, machine ID reset, token utilities, Windsurf path helpers, optional Firebase auth helper.
- Location: `src/registrationBot.js`, `src/registrationBotCancel.js`, `src/codexRegistrationBot.js`, `src/emailReceiver.js`, `src/machineIdResetter.js`, `src/services/tokenUtils.js`, `src/services/windsurfPaths.js`, `src/services/firebaseAuth.js`.
- Depends on: Puppeteer stack, IMAP/mailparser where applicable, `axios`, etc.
- Used by: IPC handlers and occasionally gateway biz modules.

## Data Flow

**Account / registration UI → main process:**

1. User interacts with DOM; scripts call `ipcRenderer.invoke('channel-name', payload)` (often via `safeIpcInvoke` in `src/renderer/ipcBridge.js`).
2. Matching handler in `src/main/ipc/*.js` runs with `deps` (paths, lock, `state`).
3. Handler reads/writes `accounts.json` under `app.getPath('userData')`, runs bots (`src/registrationBot.js`, etc.), or spawns browser automation.
4. Result returned to renderer; UI modules update DOM or show modals (`src/renderer/modals.js`, `src/renderer/uiHelpers.js`).

**Local LLM client → gateway → upstream provider:**

1. HTTP request hits `GatewayServer` route (e.g. `POST /v1/chat/completions` in `src/gateway/server.js`).
2. `apiKeyAuth` / `optionalAuth` in `src/gateway/middleware/auth.js` runs.
3. `Pipeline.execute` in `src/gateway/llm/pipeline.js` loads inbound transformer via `registry.getInbound(format)` (`src/gateway/llm/transformer/registry.js` side-effects register formats on load).
4. Model name resolves to channel rows via SQLite (`getDb()` in `src/gateway/db.js`); outbound transformer built with `registry.getOutbound(channel)`.
5. `axios` calls provider URL; streaming path uses `src/gateway/llm/streams.js` helpers; completion updates DB status/usage.

**Gateway administration from UI:**

1. Renderer loads gateway admin view scripts (`ui/gatewayInit.js`) and may call `fetch` to `http://127.0.0.1:<port>/api/admin/...` (port from `state.gatewayPort`, exposed via IPC `get-gateway-port` in `src/main/ipc/gateway.js`).
2. Admin routes in `src/gateway/routes/admin.js` read/write `channels` and related tables through `getDb()`.

**State Management:**
- **Main:** Mutable `state` object in `main.js` (`isForceUpdateActive`, `isMaintenanceModeActive`, `isApiUnavailable`, `gatewayPort`) passed into IPC handlers; gates operations in `src/main/ipc/account.js` via `isOperationAllowed`.
- **Renderer:** Module state in `src/renderer/state.js`; global `window` surface for legacy HTML event handlers.
- **Gateway:** SQLite as source of truth for channels/requests; `node-cache` usage in `src/gateway/cache.js` where applicable.

## Key Abstractions

**IPC aggregator:**
- Purpose: Single registration entry for all main-process IPC domains.
- Examples: `src/main/ipc/index.js` exporting `registerAllHandlers`.
- Pattern: Each file exports `registerHandlers(mainWindow, deps)`; no central channel enum file — channel names are string literals aligned with renderer calls.

**Gateway pipeline:**
- Purpose: Uniform execution path for all LLM API shapes (stream vs non-stream, multi-channel failover).
- Examples: `src/gateway/llm/pipeline.js`, invoked from `src/gateway/server.js`.
- Pattern: Class method `execute(req, res, format)` with retry loop over DB-ordered channels.

**Transformer registry:**
- Purpose: Map API format strings and channel `type` fields to concrete transformer classes.
- Examples: `src/gateway/llm/transformer/interfaces.js`, `src/gateway/llm/transformer/registry.js`.
- Pattern: Side-effect registration on `require('./transformer/registry')` from `pipeline.js` line 8.

**File lock for accounts JSON:**
- Purpose: Avoid corrupt concurrent writes to `accounts.json`.
- Examples: `src/accountsFileLock.js`, used as `deps.accountsFileLock` in IPC handlers.

**Thin renderer orchestrator:**
- Purpose: Keep `renderer.js` as load order + `window` exports; isolate logic into `src/renderer/*.js`.
- Examples: `renderer.js` header comment and `require('./src/renderer/...')` block.

## Entry Points

**Electron application main:**
- Location: `main.js`
- Triggers: `electron .` / packaged app launch (`package.json` `"main": "main.js"`).
- Responsibilities: `app.whenReady()`, `createWindow()`, `loadFile('index.html')`, `registerAllHandlers`, start/stop `GatewayServer`, application menu, lifecycle hooks (`window-all-closed`, `activate`).

**Vite/Electron-Vite build inputs (when using `electron-vite`):**
- Location: `electron.vite.config.js` — main input `main.js`, renderer input `index.html`, output `dist/main` and `dist/renderer`.
- Triggers: `npm run dev` / `build:vite` from `package.json`.
- Responsibilities: Bundle/obfuscate main and renderer assets per config; production path may use `main.prod.js` / `build-scripts/*` depending on release pipeline (verify `package.json` build hooks).

**Renderer page:**
- Location: `index.html` → last script `renderer.js`
- Triggers: Window `loadFile` from `main.js`.
- Responsibilities: Compose CSS from `css/`, bootstrap globals from `ui/bootstrap.js` and `js/*`, then `renderer.js` + `ui/viewController.js` + `ui/gatewayInit.js`.

**HTTP gateway:**
- Location: `src/gateway/server.js` — `GatewayServer.prototype.start`
- Triggers: Instantiation in `main.js` inside `app.whenReady().then(...)`.
- Responsibilities: Listen on configured port (default 8090), attach Express app.

## Error Handling

**Strategy:** Layer-local handling with logging; user-visible dialogs for catastrophic failures in main (`dialog.showErrorBox` in `main.js` for load/crash paths).

**Patterns:**
- IPC: Handlers typically try/catch and return `{ success: false, error }` or reject; renderer uses `safeIpcInvoke` patterns in `src/renderer/ipcBridge.js`.
- Gateway: Route handlers catch pipeline errors; Express error middleware in `setupErrorHandling()` returns JSON `{ error: { message, type, code } }` (`src/gateway/server.js`).
- Pipeline: Per-channel failures logged with `logger.warn`; final `502`-class response if all channels fail (`src/gateway/llm/pipeline.js`).

## Cross-Cutting Concerns

**Logging:** `winston`-based `src/gateway/logger.js` for gateway; `console` for main/bootstrap paths in `main.js`.

**Validation:** Express `express.json` body parsing with size limit; route-level checks in `src/gateway/routes/admin.js` (e.g. required `type` and `name` for channel create).

**Authentication:** Gateway HTTP uses `apiKeyAuth` / `optionalAuth` from `src/gateway/middleware/auth.js` for API routes; desktop shell relies on local machine trust (no separate renderer auth layer).

---

*Architecture analysis: 2026-03-26*
