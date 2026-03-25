# External Integrations

**Analysis Date:** 2026-03-26

## APIs & External Services

**Windsurf / Codeium (account & billing):**
- Registration page: `https://windsurf.com/account/register` (`src/registrationBot.js`).
- Login / pricing / billing flows: `https://windsurf.com/account/login`, `https://windsurf.com/pricing`, Stripe Checkout URLs extracted from page content (`src/main/ipc/account.js`).
- Backend gRPC-over-HTTP style endpoints: `https://web-backend.windsurf.com/...` (e.g. `exa.seat_management_pb.SeatManagementService/GetPlanStatus`, billing-related calls) (`src/main/ipc/account.js`).
- User registration RPC: `https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser` (`js/constants.js` `WINDSURF_REGISTER_API`).

**Firebase (Google Identity Toolkit):**
- Email/password and token refresh via REST: `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`, `https://securetoken.googleapis.com/v1/token` (`src/services/firebaseAuth.js`; API key supplied via env wired through `js/constants.js` `FIREBASE_API_KEY`).

**Cloudflare Worker (custom relay):**
- Base URL `https://windsurf.hfhddfj.cn` (`js/constants.js` `WORKER_URL`); requests authenticated with `WORKER_SECRET_KEY` from environment (same file).

**OpenAI / Codex:**
- Codex responses API: `https://chatgpt.com/backend-api/codex/responses` (`src/gateway/llm/transformer/codex/index.js`).
- OAuth authorize/token: `https://auth.openai.com/oauth/authorize`, `https://auth.openai.com/oauth/token` (`src/gateway/llm/transformer/codex/index.js`, `js/constants.js`).
- Local OAuth redirect: `http://localhost:1455/auth/callback` (`js/constants.js` `CODEX_OAUTH_REDIRECT_URI`).
- Sentinel / bot-protection endpoints: `https://sentinel.openai.com/...` (`src/codexRegistrationBot.js`).
- OpenAI API (gateway upstream default): `https://api.openai.com` (`src/gateway/llm/transformer/openai/index.js`).

**Anthropic:**
- Default upstream: `https://api.anthropic.com` (`src/gateway/llm/transformer/anthropic/index.js`).

**Google Gemini:**
- Default upstream: `https://generativelanguage.googleapis.com` (`src/gateway/llm/transformer/gemini/index.js`).

**Other LLM / OpenAI-compatible providers (gateway outbound defaults):**
- DeepSeek: `https://api.deepseek.com` — `src/gateway/llm/transformer/deepseek/index.js`.
- Moonshot: `https://api.moonshot.cn` — `src/gateway/llm/transformer/moonshot/index.js`.
- Doubao (Volcengine): `https://ark.cn-beijing.volces.com/api/v3` — `src/gateway/llm/transformer/doubao/index.js`.
- Zhipu: `https://open.bigmodel.cn/api/paas/v4` — `src/gateway/llm/transformer/zhipu/index.js`.
- OpenRouter: `https://openrouter.ai/api` — `src/gateway/llm/transformer/openrouter/index.js`.
- xAI: `https://api.x.ai` — `src/gateway/llm/transformer/xai/index.js`.

**Additional registered provider *types* (routing in `src/gateway/llm/transformer/registry.js`):**
- OpenAI-format aliases: `siliconflow`, `ppio`, `deepinfra`, `cerebras`, `minimax`, `aihubmix`, `burncloud`, `volcengine`, `github`, `longcat`, `modelscope`, `bailian`, `nanogpt`, `antigravity`, `vercel`, etc. — each mapped to existing outbound transformers (same file).

**Stripe:**
- Checkout links detected in automation strings (`https://checkout.stripe.com`) — `src/main/ipc/account.js` (link extraction, not necessarily Stripe Node SDK).

**Email / IMAP:**
- Arbitrary IMAP servers (user-configured host/user/pass) via `imap` + `mailparser` (`src/emailReceiver.js`); sender heuristics include `openai.com`, `chatgpt.com`, `windsurf`, `codeium`, `exafunction`.

**Distribution / updates:**
- Releases link: `https://github.com/crispvibe/Windsurf-Tool/releases` (`src/main/ipc/system.js`, `src/renderer/modals.js`).

## Data Storage

**Databases:**
- SQLite (native) — gateway DB file `gateway.db` under Electron `userData`, opened with `better-sqlite3` (`src/gateway/db.js` `getDbPath`, migrations in same file).
- SQLite (WASM) — `sql.js` used against Windsurf/Chromium profile databases on disk (`js/accountSwitcher.js`, `js/currentAccountDetector.js`, `src/machineIdResetter.js`).

**File Storage:**
- Local filesystem — app `userData` (`windsurf-tool` under OS app data), logs under `logs/` relative to `userData` (`src/gateway/logger.js`), Windsurf install paths resolved in `src/services/windsurfPaths.js` and related IPC.

**Caching:**
- In-process `node-cache` instances for gateway (`src/gateway/cache.js`) — not Redis/external.

## Authentication & Identity

**Gateway API consumers:**
- API keys validated against SQLite (`api_keys` joined with `users`) — `src/gateway/middleware/auth.js`; keys passed as `Authorization: Bearer …` or `X-API-Key` or `api_key` query.

**OAuth (Codex / OpenAI-style):**
- Token refresh and client id embedded in gateway OAuth helper (`src/gateway/biz/oauth.js` default `client_id` pattern; token URL supplied per integration).

**Firebase:**
- REST sign-in and refresh as above (`src/services/firebaseAuth.js`).

**Electron:**
- `safeStorage` and Windows `Local State` copy behavior described in `main.js` (integration with OS secret storage for sensitive local data).

## Monitoring & Observability

**Error Tracking:**
- Not detected (no Sentry/Datadog SDK in `package.json` dependencies).

**Logs:**
- Winston JSON + console colorized output for gateway (`src/gateway/logger.js`); HTTP access logging via custom middleware in `src/gateway/server.js` (not morgan).

## CI/CD & Deployment

**Hosting:**
- Desktop distribution via `electron-builder` artifacts (`release/`); not a hosted web service.

**CI Pipeline:**
- No `.github/workflows` at repository root; sample workflows exist only under `参考/` trees — treat main project CI as not configured in-repo.

## Environment Configuration

**Required env vars (behavioral):**
- `FIREBASE_API_KEY` — Firebase REST auth (`js/constants.js`, `src/services/firebaseAuth.js`).
- `WORKER_SECRET_KEY` — Worker HMAC/validation (`js/constants.js`).
- `GATEWAY_LOG_LEVEL` — optional gateway log verbosity (`src/gateway/logger.js`).

**Secrets location:**
- Intended: project `.env` loaded by `dotenv` from `js/constants.js` when running under Electron; never commit populated `.env` files.

## Webhooks & Callbacks

**Incoming:**
- Local HTTP server: OpenAI-/Anthropic-/Gemini-compatible routes on the gateway (`src/gateway/server.js`) — bound to app-controlled port (default `8090`, surfaced via IPC `src/main/ipc/gateway.js` and `main.js` `state.gatewayPort`).
- OAuth callback URL `http://localhost:1455/auth/callback` (Codex registration / token flow).

**Outgoing:**
- Client-initiated HTTPS calls to provider bases listed above via `axios` from gateway pipeline and account automation modules; no generic webhook dispatcher identified.

---

*Integration audit: 2026-03-26*
