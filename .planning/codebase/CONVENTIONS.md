# Coding Conventions

**Analysis Date:** 2026-03-26

## Naming Patterns

**Files:**
- Main-process and Node services: `camelCase.js` (e.g. `emailReceiver.js`, `registrationBot.js`).
- Renderer helpers under `src/renderer/`: `camelCase.js` (e.g. `ipcBridge.js`, `uiHelpers.js`).
- Preload/renderer-adjacent scripts at repo root: `renderer.js`, `main.js`.
- Gateway subsystem: one concern per file under `src/gateway/` (e.g. `server.js`, `logger.js`, `routes/admin.js`).

**Functions:**
- Use `camelCase` for free functions and methods (e.g. `isVerificationEmailCandidate`, `registerAllHandlers` in `src/main/ipc/index.js`).

**Variables:**
- Use `camelCase` for locals and options objects (e.g. `unpackedNodeModules`, `mainWindow` in `main.js`).

**Classes:**
- Use `PascalCase` for constructors (e.g. `GatewayServer` in `src/gateway/server.js`, `EmailReceiver` in `src/emailReceiver.js`).

**Constants:**
- Uppercase snake case for obvious constants (e.g. `DEFAULT_PORT` in `src/gateway/server.js`). Many modules use `const` with `camelCase` for configuration-derived values without a strict ALL_CAPS rule.

## Code Style

**Formatting:**
- No project-level ESLint config detected (no `.eslintrc*`, no `eslint.config.*`).
- No Prettier or Biome config detected.
- Indentation and quotes follow existing files (typically 2 spaces, single quotes in Node sources).

**Linting:**
- Not detected at repository root. Rely on editor defaults and consistency with neighboring files.

**Module system:**
- **CommonJS** is standard: `require()` / `module.exports` across `main.js`, `src/`, `js/`, and tests.
- Some renderer bundles may be built with Vite (`electron-vite` in `package.json`); authored sources in `src/renderer/` still use `require` where loaded by Electron without bundling that file.

**Strict mode:**
- Use `'use strict';` at the top of some modules (e.g. `src/gateway/server.js`, `renderer.js`). Other files omit it; match the file you edit.

## Import Organization

**Order (observed):**
1. Node built-ins (`path`, `fs`, `os`, `util`).
2. Third-party packages (`electron`, `express`, `axios`, etc.).
3. Project modules via relative paths (`./src/...`, `./accountsFileLock`).

**Path aliases:**
- Not detected; use relative paths from the requiring file (e.g. `require('../src/emailReceiver')` from `tests/emailReceiver.test.js`).

**Barrel files:**
- IPC aggregation: `src/main/ipc/index.js` exports `registerAllHandlers` and wires domain handlers from `src/main/ipc/account.js`, `registration.js`, `codex.js`, `gateway.js`, `system.js`, `config.js`.

## Error Handling

**Main process:**
- Async: `util.promisify(exec)` and `.catch` / `try`/`await` patterns as in `main.js`.
- Process streams: swallow expected `EPIPE` on `stdout`, rethrow other errors (`main.js`).

**HTTP (gateway):**
- Central Express error middleware logs with Winston and returns JSON `{ error: { message, type, code } }` (`src/gateway/server.js` `setupErrorHandling`).
- 404 handler returns structured JSON with `type: 'not_found'`.

**Renderer / IPC:**
- Wrap `ipcRenderer.invoke` in `try`/`catch`; log with `console.error` and return user-facing failure objects where applicable (`src/renderer/ipcBridge.js`).

**Optional dependencies:**
- Use `try`/`catch` around `require('electron')` when the same module must run outside Electron (e.g. `src/gateway/logger.js` falls back to a filesystem log directory).

**Promises:**
- Class methods that perform I/O reject with `{ success: false, message: '...' }` objects in places like `EmailReceiver.prototype.testConnection` (`src/emailReceiver.js`).

## Logging

**Framework:** Winston in the gateway (`src/gateway/logger.js`).

**Patterns:**
- Level from `process.env.GATEWAY_LOG_LEVEL` (default `info`).
- JSON logs with `timestamp`, `stack` on errors, `defaultMeta: { service: 'gateway' }`.
- Console transport uses colorized, human-readable lines prefixed with `[Gateway]`.

**Elsewhere:** `console.log` / `console.error` appear in renderer and IPC paths; emoji prefixes appear in some maintenance-mode logs (`src/renderer/ipcBridge.js`).

## Comments

**When to comment:**
- Explain non-obvious behavior, packaging quirks, or domain rules (e.g. asar / `Module._resolveFilename` hooks in `main.js`, verification-email heuristics in `src/emailReceiver.js`).

**JSDoc:**
- Used selectively for IPC registration and public shapes (e.g. `@param` blocks in `src/main/ipc/index.js`). Not required on every function.

**Language:**
- Mix of Simplified Chinese and English comments depending on module; follow the dominant language of the file being edited.

## Function Design

**Size:** Large modules exist (`renderer.js`, `src/emailReceiver.js`); prefer extracting pure helpers when adding behavior rather than growing monoliths further.

**Parameters:** Options objects for configurable behavior (e.g. `GatewayServer` constructor, `classifyVerificationEmail` inputs in `src/emailReceiver.js`).

**Return values:** Prefer explicit objects for complex outcomes (e.g. state objects from `analyzeHeaderScanCandidate`); use `{ success, error }` style for IPC-style results.

## Module Design

**Exports:**
- Default export class: `module.exports = EmailReceiver` (`src/emailReceiver.js`).
- Named helper attachment: pure functions are assigned onto the class for testability without changing the constructor API (e.g. `EmailReceiver.isKnownOtpSender = isKnownOtpSender` at end of `src/emailReceiver.js`).
- Named object exports: `module.exports = { registerAllHandlers }` (`src/main/ipc/index.js`).

**Browser-global scripts:**
- `js/accountDateFilter.js` wraps logic in an IIFE and attaches exports to `global` / `module.exports` pattern for reuse in renderer and tests.

---

*Convention analysis: 2026-03-26*
