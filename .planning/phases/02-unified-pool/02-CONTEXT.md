# Phase 2: 统一号池 - Context

**Gathered:** 2026-03-27
**Status:** Ready for planning
**Mode:** Auto-generated (autonomous mode — no user questions)

<domain>
## Phase Boundary

统一号池：将 Windsurf 账号、Codex 账号和第三方 LLM API Key 纳入同一个 SQLite 池管理，每个账号有完整的状态生命周期（可用/使用中/异常/冷却/禁用），支持按供应商/类型分组查看、手动添加 API Key、状态手动流转、健康度评分。前端新增"号池管理"视图。

</domain>

<decisions>
## Implementation Decisions

### Data Storage
- 使用 gateway.db SQLite（新增 pool_accounts 表 + migration v2），不新建数据库
- 账号凭证用 JSON blob 存储（兼容 Windsurf tokens、Codex OAuth、API Key 三种异构格式）
- 保留 accounts.json 和 codex_accounts.json 作为迁移源，迁移后可删除

### 状态机
- 状态枚举：available, in_use, error, cooldown, disabled
- 状态转换规则：available → in_use → available/error → cooldown → available
- 手动操作：disable/enable 任意状态

### UI
- 在 index.html 侧边栏新增"号池管理"导航项
- 号池视图按供应商分组显示，每个账号卡片显示状态、健康度评分、操作按钮
- 健康度评分 = f(成功率, 额度余量)，0-100 分

### Architecture
- PoolService（main process）封装所有号池 CRUD
- IPC handlers（src/main/ipc/pool.js）暴露给 renderer
- poolRenderer.js（src/renderer/）负责 UI 渲染

### Claude's Discretion
- 迁移策略（自动首次启动 vs 手动按钮）
- API Key 验证方式（格式检查 vs 完整 API 调用测试）
- 健康度评分算法权重

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- AccountService pattern (src/services/accountService.js) — CRUD + file lock
- GatewayDataService pattern (src/services/gatewayDataService.js) — SQLite wrapper
- gateway.db migration system (v1 with schema_migrations table)
- src/renderer/* windowExports pattern for UI modules

### Established Patterns
- IPC handlers via deps injection (registerAllHandlers pattern)
- renderer.js as orchestrator with Object.assign(window, module.windowExports)
- SQLite WAL mode, better-sqlite3

### Integration Points
- main.js: instantiate PoolService, add to deps
- src/main/ipc/index.js: register pool handlers
- renderer.js: require poolRenderer, mount windowExports
- index.html: add nav item for 号池管理

</code_context>

<specifics>
## Specific Ideas

- Pool accounts table schema: id, type (windsurf/codex/api_key), provider, credentials (JSON), status, health_score, last_used_at, error_count, total_requests, created_at, updated_at
- View filter: All / Windsurf / Codex / API Keys
- Account card: status badge, provider icon, health score bar, action buttons (disable/enable/delete)

</specifics>

<deferred>
## Deferred Ideas

- API Key 验证（完整 API 调用测试）— 留到 Phase 5 网关集成时验证
- 自动入池（注册完成自动加入号池）— Phase 3 注册流水线
- 网关从号池分配账号 — Phase 5

</deferred>
