# Phase 1: 代码整合 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-26
**Phase:** 01-代码整合
**Areas discussed:** 渲染层目标结构, 数据层统一方案, renderer.js 拆分方式, 迁移策略

---

## 渲染层目标结构

| Option | Description | Selected |
|--------|-------------|----------|
| 统一到 src/renderer/ + CommonJS | 最小变动，保持现有模块系统，只做文件搬迁和 require 整合 | ✓ |
| 统一到 src/renderer/ + ES modules + Vite | 现代化方案，利用已有 electron-vite 配置，但变更范围大 | |
| 新建独立目录结构 | 完全重新组织，不沿用现有目录 | |

**User's choice:** Claude's Discretion（用户说"你自己决定"）
**Notes:** 选择 CommonJS 方案因为：(1) 全项目统一 CommonJS，切换模块系统是独立工程量；(2) Phase 1 目标是整合不是现代化；(3) electron-vite 配置存在但未全面使用，启用它需要额外验证。

---

## 数据层统一方案

| Option | Description | Selected |
|--------|-------------|----------|
| 抽象服务层包装两种存储 | 创建 accountService 和 gatewayDataService，业务代码走服务层 | ✓ |
| 全部迁移到 SQLite | accounts.json 数据迁入 gateway.db 或新数据库 | |
| 保持分离仅统一 API | 最小变动，只加薄封装 | |

**User's choice:** Claude's Discretion
**Notes:** 选择服务层方案因为：(1) Phase 2 统一号池会重新设计数据模型，现在迁 SQLite 等于做两次；(2) 服务层是低风险的渐进改进，可以立即解耦业务代码和存储细节。

---

## renderer.js 拆分方式

| Option | Description | Selected |
|--------|-------------|----------|
| 按功能模块拆分 | accountRenderer、registrationRenderer 等，对齐 IPC handler 分域 | ✓ |
| 按视图/页面拆分 | 每个 switchView 视图一个文件 | |
| 按关注点拆分 | state、events、DOM manipulation 分离 | |

**User's choice:** Claude's Discretion
**Notes:** 选择功能模块拆分因为：(1) 与 src/main/ipc/ 的 domain 划分一致，形成 main ↔ renderer 的对称结构；(2) 更容易定位代码——"账号相关" 对应一个文件而非散落在多个视图文件中。

---

## 迁移策略

| Option | Description | Selected |
|--------|-------------|----------|
| 渐进式迁移 | 逐模块迁移，每步验证应用可运行 | ✓ |
| 一次性重构 | 一步到位全部改完 | |
| Strangler fig | 新结构包裹旧结构，渐进替换 | |

**User's choice:** Claude's Discretion
**Notes:** 选择渐进式因为应用在使用中，不能承受长时间不可用。每步验证降低回归风险。

## Claude's Discretion

所有四个方向均由 Claude 自行决策，用户授权"你自己决定"。

## Deferred Ideas

无——讨论保持在 Phase 范围内。
