# Technology Stack

**Analysis Date:** 2026-03-26

## Languages

**Primary:**
- JavaScript (CommonJS `require` / `module.exports` across `main.js`, `src/**/*.js`, `js/**/*.js`) — application logic, Electron main, gateway, IPC, renderer scripts.
- JavaScript (ESM `import`/`export`) — `electron.vite.config.js` only.

**Secondary:**
- HTML — `index.html`, `language-selector.html` (renderer shell).
- CSS — modular sheets under `css/` (`variables.css`, `base.css`, `layout.css`, components, views).

## Runtime

**Environment:**
- Electron `^26.6.10` (`package.json` `devDependencies`) — desktop host; embeds a fixed Node.js version (match Node version to the Electron 26 release line in upstream release notes).
- Node.js — used implicitly inside Electron; also used when running `node` against standalone scripts (e.g. `tests/*.test.js`).

**Package Manager:**
- npm (lockfile: `package-lock.json` present).

## Frameworks

**Core:**
- Electron — main process `main.js`, `app.setPath('userData', ...)`, `BrowserWindow`, `ipcMain`, `safeStorage`-related flows documented in `main.js`.
- Express `^5.2.1` — embedded LLM gateway HTTP server (`src/gateway/server.js`).

**Testing:**
- Node.js built-in test runner — `node:test` and `node:assert/strict` in `tests/accountDateFilter.test.js`, `tests/emailReceiver.test.js` (no `jest`/`vitest` in `package.json` `devDependencies`).

**Build/Dev:**
- electron-vite `^4.0.1` + Vite `^7.2.4` — `electron.vite.config.js` (main bytecode plugin, renderer build from `index.html` → `dist/renderer`).
- electron-builder `^24.13.3` — packaged artifacts (macOS DMG, Windows NSIS, Linux AppImage/deb); config under `package.json` `build` key.
- asarmor `^3.0.2`, javascript-obfuscator `^4.1.1` — referenced in toolchain (asarmor in `devDependencies`; obfuscation aligned with build hardening).

## Key Dependencies

**Critical:**
- `axios` `^0.27.2` — HTTP client (OAuth refresh `src/gateway/biz/oauth.js`, LLM upstream calls in `src/gateway/llm/`, account flows).
- `better-sqlite3` `^12.8.0` — gateway persistence (`src/gateway/db.js` → `gateway.db` under Electron `userData`).
- `sql.js` `^1.10.3` — WASM SQLite for reading/writing Windsurf local state DB from renderer-side logic (`js/accountSwitcher.js`, `js/currentAccountDetector.js`, `src/machineIdResetter.js`).
- `puppeteer` `^21.11.0`, `puppeteer-real-browser` `^1.3.8`, `chrome-launcher` `^1.1.2` — browser automation (registration, login, Codex flows in `src/registrationBot.js`, `src/codexRegistrationBot.js`, `src/main/ipc/account.js`).
- `imap` `^0.8.19`, `mailparser` `^3.6.5` — mailbox polling and MIME parsing (`src/emailReceiver.js`).
- `express`, `cors`, `helmet` — gateway HTTP stack (`src/gateway/server.js`).
- `winston` `^3.19.0` — structured gateway logging (`src/gateway/logger.js`).
- `node-cache` `^5.1.2` — in-process cache tiers (`src/gateway/cache.js`).
- `eventsource-parser` `^3.0.6` — SSE/stream parsing in LLM pipeline (`src/gateway/llm/`).
- `decimal.js` `^10.6.0` — numeric precision for cost/quota style logic (`src/gateway/biz/costCalc.js`).
- `uuid` `^9.0.1` — identifier generation where used across gateway/services.
- `dotenv` `^16.4.7` — optional `.env` load when running under Electron (`js/constants.js`).

**Infrastructure / UX:**
- `lucide` `^0.555.0` — icon set for renderer UI.

**Declared but not referenced in app `src/` / root `*.js` (verify before relying):**
- `morgan`, `node-cron` — listed in `package.json` `dependencies`; repository grep shows no `require('morgan')` / `node-cron` in non-`参考/` paths.

## Configuration

**Environment:**
- `dotenv` loaded from `js/constants.js` when `process.versions.electron` is set; project root `.env` may exist — **do not commit secrets** (see `.env.example` presence in repo for variable names only).
- Gateway log level: `process.env.GATEWAY_LOG_LEVEL` in `src/gateway/logger.js`.
- Feature-related env reads: `js/constants.js` (`WORKER_SECRET_KEY`, `FIREBASE_API_KEY`), proxy env in `js/accountLogin.js` (`HTTPS_PROXY` / `HTTP_PROXY` and lowercase variants).

**Build:**
- `electron.vite.config.js` — main entry `main.js` → `dist/main`, renderer `index.html` → `dist/renderer`; Rollup `external` lists Node/Electron and heavy native deps.
- `package.json` `build` — `appId`, `asar` + large `asarUnpack` list for Puppeteer and native modules, `afterPack`: `build-scripts/afterPack.js`, artifacts under `release/`.

## Platform Requirements

**Development:**
- macOS / Windows / Linux per Electron and `electron-builder` targets; native module `better-sqlite3` requires toolchain compatible with the Electron Node ABI (rebuild on version bumps).

**Production:**
- Packaged desktop app (DMG / NSIS / AppImage / deb); local HTTP gateway binds loopback (default port `8090` in `main.js` `state` and `src/gateway/server.js` `DEFAULT_PORT`).

---

*Stack analysis: 2026-03-26*
