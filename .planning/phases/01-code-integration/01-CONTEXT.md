# Phase 1: 代码整合 - Context

**Gathered:** 2026-03-26
**Status:** Ready for planning

<domain>
## Phase Boundary

将三套并行的渲染层代码（`js/` / `ui/` / `src/renderer/`）和两套数据源（`accounts.json` + `gateway.db`）统一为清晰的单一架构。renderer.js 从 1166 行瘦身到 < 200 行的纯调度层。

不引入新功能、不改变用户可见行为、不重新设计数据模型（数据模型属于 Phase 2 统一号池）。

</domain>

<decisions>
## Implementation Decisions

### 渲染层目标结构
- **D-01:** 统一到 `src/renderer/` 目录下，保持 CommonJS `require()` 模式。不切换 ES modules / Vite 打包——项目全面使用 CommonJS，模块系统切换是独立工程量，Phase 1 目标是整合不是现代化。
- **D-02:** `js/` 下的 ~10 个文件逐个迁入 `src/renderer/`，`ui/` 下的 3 个引导文件合并到 `src/renderer/` 入口。最终 `index.html` 的 `<script>` 标签大幅减少，由 renderer.js 统一 require 加载。
- **D-03:** 迁移后 `js/` 和 `ui/` 目录应为空或删除，不保留废弃文件。

### 数据层统一方案
- **D-04:** 创建抽象服务层而非迁移存储。`src/services/accountService.js` 封装 accounts.json 读写（含 accountsFileLock），`src/services/gatewayDataService.js` 封装 gateway.db 操作。
- **D-05:** 业务代码（IPC handlers、renderer 模块）通过服务层访问数据，不再直接 `fs.readFileSync` 或 `getDb()`。
- **D-06:** 实际存储统一（accounts.json → SQLite）留给 Phase 2 统一号池——届时需要重新设计数据模型，现在迁移等于做两次。

### renderer.js 拆分方式
- **D-07:** 按功能模块拆分，对齐 `src/main/ipc/` 的 domain 划分方式。从 renderer.js 提取到 `src/renderer/` 的新模块包括但不限于：accountRenderer（账号管理）、registrationRenderer（注册流程 UI）、tokenRenderer（Token 相关）、gatewayRenderer（从 `js/gatewayManager.js` 迁移合并）。
- **D-08:** 最终 renderer.js 只做三件事：(1) 全局初始化（Lucide、ipcRenderer）、(2) require 所有模块并挂载 window 导出、(3) IPC 事件监听委托。目标 < 200 行。

### 迁移策略
- **D-09:** 渐进式迁移，每步保持应用可正常启动运行。顺序：1) 创建服务层存根 → 2) 提取 renderer.js 功能模块 → 3) 逐个迁移 js/ 文件 → 4) 合并 ui/ 引导逻辑 → 5) 更新 index.html script 标签。
- **D-10:** 每个迁移步骤完成后验证应用可正常启动、各视图可切换、核心功能（账号列表、注册、网关管理）正常工作。

### Claude's Discretion
- 具体的文件命名和模块内部组织由 Claude 在 planning/execution 阶段决定
- renderer.js 中哪些逻辑属于 "编排" 保留、哪些属于 "业务" 提取，由 Claude 根据代码实际内容判断
- 迁移过程中如发现需要小幅调整模块接口以消除循环依赖，Claude 可自行处理

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 代码库分析
- `.planning/codebase/ARCHITECTURE.md` — 完整架构分层、数据流、关键抽象
- `.planning/codebase/STRUCTURE.md` — 目录布局、文件职责、新代码放置指南
- `.planning/codebase/CONVENTIONS.md` — 命名规范、模块系统、import 顺序、错误处理
- `.planning/codebase/CONCERNS.md` — 技术债务、已知问题、安全考量

### 项目文件
- `.planning/REQUIREMENTS.md` §INTG — INTG-01（渲染层统一）和 INTG-02（数据层统一接口）的具体要求

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/renderer/ipcBridge.js`: IPC 调用封装（`safeIpcInvoke`），迁移后其他模块可直接复用
- `src/renderer/state.js`: 渲染层状态管理，可作为统一状态入口
- `src/renderer/modals.js`, `src/renderer/uiHelpers.js`: 通用 UI 工具，无需修改
- `src/accountsFileLock.js`: 并发写保护，封装进 accountService 后继续使用
- `src/gateway/db.js`: 完整的 migration 机制，封装进 gatewayDataService 后继续使用

### Established Patterns
- **IPC handler 分域注册**: `src/main/ipc/index.js` aggregator 模式——渲染层拆分应对齐此结构
- **CommonJS exports**: `module.exports = Class` 或 `module.exports = { fn1, fn2 }` 两种风格并存
- **Window 全局挂载**: `js/` 文件通过 `window.xxx = ...` 暴露给 HTML onclick，迁移后需保持此接口或改为事件委托

### Integration Points
- `index.html`: 当前 12 个 `<script>` 标签定义加载顺序——迁移后需重构为 renderer.js 统一入口
- `main.js → registerAllHandlers`: IPC handler 注册入口，服务层创建后 handler 改为调用服务层
- `ui/bootstrap.js`: 在 `<head>` 中最早加载，设置 ConfigManager / CONSTANTS / axios 到 window——需评估是否合入 renderer.js 初始化

</code_context>

<specifics>
## Specific Ideas

用户将所有决策委托给 Claude——开放标准做法，无特殊偏好或参考要求。

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-code-integration*
*Context gathered: 2026-03-26*
