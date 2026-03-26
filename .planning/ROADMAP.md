# Roadmap: 大魏注册 (Dawei Register)

## Overview

将现有分散的注册、绑卡、网关、账号管理模块整合为号池驱动的自动化闭环。从代码整合打基础，到号池核心建设，再到注册/绑卡流水线对接，最终实现网关动态路由、异常自愈和全局仪表盘。

## Phases

- [ ] **Phase 1: 代码整合** - 渲染层与数据层统一，为后续建设打好地基
- [ ] **Phase 2: 统一号池** - 构建支持全类型账号的号池核心数据模型与管理界面
- [ ] **Phase 3: 注册流水线** - 批量注册自动入池，状态实时可见
- [ ] **Phase 4: 绑卡激活** - 批量绑卡自动更新池中状态
- [ ] **Phase 5: 网关动态路由** - 网关从号池分配账号，报错即切
- [ ] **Phase 6: 异常恢复** - 异常账号自动探测、分类、恢复
- [ ] **Phase 7: 全局仪表盘** - 一眼掌控号池、网关、异常全局状态

## Phase Details

### Phase 1: 代码整合
**Goal**: 将三套并行的渲染层代码和两套数据源统一为清晰的单一架构，消除后续开发的技术负债
**Depends on**: Nothing (foundation)
**Requirements**: INTG-01, INTG-02
**Success Criteria** (what must be TRUE):
  1. 渲染层代码统一在一个模块体系下，js/ / ui/ / src/renderer/ 三套并行结构不再存在
  2. accounts.json 和 gateway.db 通过统一的数据服务层访问，业务代码不再直接操作文件或数据库
  3. renderer.js 瘦身为路由/调度层（< 200 行），不再包含内联业务逻辑
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Data service layer (accountService + gatewayDataService)
- [ ] 01-02-PLAN.md — Renderer module extraction from renderer.js
- [ ] 01-03-PLAN.md — js/ and ui/ migration + index.html cleanup

### Phase 2: 统一号池
**Goal**: 用户可在同一个池子里管理 Windsurf/Codex 账号和各家 LLM API Key，账号有完整的状态生命周期
**Depends on**: Phase 1
**Requirements**: POOL-01, POOL-02, POOL-03, POOL-04, POOL-05, POOL-06
**Success Criteria** (what must be TRUE):
  1. 用户可在同一个界面查看和按供应商/类型分组管理 Windsurf、Codex 账号和第三方 LLM API Key
  2. 每个账号显示当前状态（可用/使用中/异常/冷却/禁用），状态可手动流转
  3. 用户可手动添加第三方 API Key 到号池，也可手动禁用/启用任意账号
  4. 系统根据成功率和额度余量自动计算并展示账号健康度评分
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Data service layer (accountService + gatewayDataService)
- [ ] 01-02-PLAN.md — Renderer module extraction from renderer.js
- [ ] 01-03-PLAN.md — js/ and ui/ migration + index.html cleanup
**UI hint**: yes

### Phase 3: 注册流水线
**Goal**: 批量注册完成后账号自动进入号池，注册全程状态可见，失败自动重试
**Depends on**: Phase 2
**Requirements**: REG-01, REG-02, REG-03, REG-04, REG-05, REG-06
**Success Criteria** (what must be TRUE):
  1. 用户发起批量 Windsurf/Codex 注册后，注册完成的账号自动出现在号池中，无需手动导入
  2. 注册过程中的状态（排队/进行中/成功/失败）在界面上实时更新
  3. 注册失败的账号自动进入重试队列，重试无需人工干预
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Data service layer (accountService + gatewayDataService)
- [ ] 01-02-PLAN.md — Renderer module extraction from renderer.js
- [ ] 01-03-PLAN.md — js/ and ui/ migration + index.html cleanup
**UI hint**: yes

### Phase 4: 绑卡激活
**Goal**: 号池中的账号可批量自动绑卡激活，失败自动重试
**Depends on**: Phase 2
**Requirements**: CARD-01, CARD-02, CARD-03
**Success Criteria** (what must be TRUE):
  1. 用户可选择号池中的待激活账号批量发起绑卡，绑卡完成后账号状态自动更新为「已激活」
  2. 绑卡失败的账号自动标记异常并进入重试队列，无需手动处理
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Data service layer (accountService + gatewayDataService)
- [ ] 01-02-PLAN.md — Renderer module extraction from renderer.js
- [ ] 01-03-PLAN.md — js/ and ui/ migration + index.html cleanup
**UI hint**: yes

### Phase 5: 网关动态路由
**Goal**: 网关请求自动从号池分配可用账号，失败即切，调用方完全无感知
**Depends on**: Phase 2
**Requirements**: GW-01, GW-02, GW-03, GW-04, GW-05
**Success Criteria** (what must be TRUE):
  1. 网关收到 LLM 请求时自动从号池选取可用账号处理，不再依赖手动配置的静态渠道
  2. 请求失败时立即切换到下一个可用账号重试，调用方无感知（报错即切）
  3. 路由优先使用健康度高、额度充裕的账号
  4. 每个请求的账号分配和结果记录可追踪查询
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Data service layer (accountService + gatewayDataService)
- [ ] 01-02-PLAN.md — Renderer module extraction from renderer.js
- [ ] 01-03-PLAN.md — js/ and ui/ migration + index.html cleanup

### Phase 6: 异常恢复
**Goal**: 异常账号自动探测、分类处理、恢复入池，形成自愈闭环
**Depends on**: Phase 2, Phase 5
**Requirements**: RECV-01, RECV-02, RECV-03, RECV-04
**Success Criteria** (what must be TRUE):
  1. 异常/冷却状态的账号被系统定期自动探测，恢复后自动放回可用池
  2. 系统区分异常类型（额度耗尽、Token 过期、被封禁、网络超时）并采取对应恢复策略
  3. Token 过期自动刷新恢复、额度耗尽等待周期重置、被封禁永久禁用，全程无需人工介入
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Data service layer (accountService + gatewayDataService)
- [ ] 01-02-PLAN.md — Renderer module extraction from renderer.js
- [ ] 01-03-PLAN.md — js/ and ui/ migration + index.html cleanup

### Phase 7: 全局仪表盘
**Goal**: 用户打开应用即可一眼掌控号池状态、网关流量、异常事件，日常运维只看这一个面板
**Depends on**: Phase 2, Phase 5, Phase 6
**Requirements**: DASH-01, DASH-02, DASH-03, DASH-04
**Success Criteria** (what must be TRUE):
  1. 用户打开应用即看到号池概览：总数、可用数、异常数、禁用数
  2. 网关实时流量指标（请求量、成功率、平均响应时间）在仪表盘上清晰展示
  3. 账号状态分布可视化，支持按状态和按供应商两个维度查看
  4. 最近异常事件列表按时间排列，展示账号、异常类型、处理结果
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Data service layer (accountService + gatewayDataService)
- [ ] 01-02-PLAN.md — Renderer module extraction from renderer.js
- [ ] 01-03-PLAN.md — js/ and ui/ migration + index.html cleanup
**UI hint**: yes

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. 代码整合 | 0/3 | Planned | - |
| 2. 统一号池 | 0/? | Not started | - |
| 3. 注册流水线 | 0/? | Not started | - |
| 4. 绑卡激活 | 0/? | Not started | - |
| 5. 网关动态路由 | 0/? | Not started | - |
| 6. 异常恢复 | 0/? | Not started | - |
| 7. 全局仪表盘 | 0/? | Not started | - |

---
*Roadmap created: 2026-03-26*
*Last updated: 2026-03-27*
