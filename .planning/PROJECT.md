# 大魏注册 (Dawei Register)

## What This Is

自动化 LLM 账号运营平台。批量注册 Windsurf/Codex 账号、自动绑卡激活、统一号池管理（含各家 LLM API Key），并通过本地网关路由服务自动分配账号处理请求，实现报错即切、异常自动恢复的全闭环运营。面向个人运维，日常通过全局仪表盘监控即可。

## Core Value

**号池驱动的自动化闭环**——注册、绑卡、入池、分配、切号、恢复全流程无需人工干预，网关永远有可用账号响应请求。

## Requirements

### Validated

- ✓ Windsurf 账号注册（Puppeteer 自动化） — existing
- ✓ Codex 账号注册（Puppeteer + Sentinel） — existing
- ✓ 邮箱验证码接收（IMAP 轮询 + 分类） — existing
- ✓ 账号管理（增删改查、导入导出 JSON） — existing
- ✓ 银行卡自动绑定 — existing
- ✓ Windsurf 本地切号（SQLite 写入） — existing
- ✓ Token 获取与刷新（Firebase Auth） — existing
- ✓ LLM 网关代理（Express + 12 种 Transformer） — existing
- ✓ 网关渠道管理（SQLite CRUD） — existing
- ✓ 网关请求记录与追踪 — existing
- ✓ 渠道负载均衡与重试 — existing
- ✓ 机器 ID 重置 — existing

### Active

- [ ] 统一号池：Windsurf/Codex 账号 + 各家 LLM API Key 纳入同一个池子管理
- [ ] 自动化流水线：注册完成 → 自动入池 → 自动标记状态
- [ ] 网关-号池打通：网关请求从号池分配账号，而非静态渠道配置
- [ ] 报错即切：请求失败立即切换下一个可用账号，对调用方透明
- [ ] 异常自动恢复：异常账号定期探测，恢复后自动放回可用池
- [ ] 全局仪表盘：一眼查看号池状态、网关流量、异常账号、额度消耗
- [ ] 渲染层统一：消除 js/ / ui/ / src/renderer/ 三套并行的代码组织

### Out of Scope

- 多用户/多租户 — 面向个人运维，不需要用户系统
- 远程部署/Web 版 — 保持 Electron 桌面应用形态
- 账号交易/转让 — 仅限自用管理

## Context

**技术环境：**
- Electron 26 桌面应用，CommonJS 模块系统
- Express 5 内嵌网关，better-sqlite3 持久化
- Puppeteer 21 驱动浏览器自动化（注册、绑卡）
- 12+ LLM 供应商 Transformer（OpenAI、Anthropic、Gemini、DeepSeek、Moonshot 等）

**现状问题：**
- 注册、绑卡、号池（accounts.json）、网关（gateway.db）四块数据不通，靠人工串联
- 渲染层三重分裂（js/ 全局脚本、ui/ 引导层、src/renderer/ 模块化），状态管理不统一
- 网关渠道配置是静态的，和账号池之间没有联动
- renderer.js 名义上是 "thin orchestrator"，实际 1100+ 行

**已有代码基础（.planning/codebase/ 分析完成）：**
- 架构、结构、技术栈、集成、规范、关注点 6 份分析文档已就位
- 核心自动化流程（注册、邮件验证、绑卡、切号）已验证可用
- 网关 pipeline + transformer 架构设计良好，可扩展

## Constraints

- **运行时**: Electron 26 + 内嵌 Node.js，单进程模型
- **持久化**: SQLite（网关）+ JSON 文件（账号），需要统一或桥接
- **自动化**: Puppeteer 依赖 Chrome，资源消耗大，并发数受机器限制
- **安全**: nodeIntegration: true + contextIsolation: false，暂不改动（改动代价大）

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 全自动流水线而非手动串联 | 减少日常运维成本，实现 set-and-forget | — Pending |
| 号池统一管理所有类型账号 | Windsurf/Codex 和第三方 API Key 走同一套调度逻辑 | — Pending |
| 报错即切 + 自动恢复 | 无需人工干预异常，网关可用性最大化 | — Pending |
| 仪表盘为主要交互界面 | 日常只看面板，减少操作复杂度 | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-26 after initialization*
