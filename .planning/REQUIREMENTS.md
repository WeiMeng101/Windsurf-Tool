# Requirements: 大魏注册 (Dawei Register)

**Defined:** 2026-03-26
**Core Value:** 号池驱动的自动化闭环——注册、绑卡、入池、分配、切号、恢复全流程无需人工干预，网关永远有可用账号响应请求。

## v1 Requirements

### 账号注册 (REG)

- [ ] **REG-01**: 用户可批量发起 Windsurf 账号注册（多线程 Puppeteer 并发）
- [ ] **REG-02**: 用户可批量发起 Codex 账号注册（Puppeteer + Sentinel 验证）
- [ ] **REG-03**: 系统自动通过 IMAP 接收并匹配邮箱验证码完成注册验证
- [x] **REG-04**: 注册完成后账号自动写入号池，无需手动导入
- [ ] **REG-05**: 注册状态（进行中/成功/失败）实时反馈到仪表盘
- [ ] **REG-06**: 注册失败的账号自动进入重试队列

### 绑卡 (CARD)

- [ ] **CARD-01**: 用户可对号池中的账号批量发起银行卡自动绑定
- [~] **CARD-02**: 绑卡完成后自动更新号池中对应账号状态为「已激活」
- [ ] **CARD-03**: 绑卡失败的账号标记异常并进入重试队列

### 号池管理 (POOL)

- [x] **POOL-01**: 统一号池数据模型支持 Windsurf/Codex 账号和各家 LLM API Key
- [x] **POOL-02**: 账号具有状态机：可用 → 使用中 → 异常 → 冷却 → 禁用，状态可流转
- [x] **POOL-03**: 系统根据成功率和额度余量计算账号健康度评分
- [x] **POOL-04**: 号池支持按供应商/类型分组查看和管理
- [x] **POOL-05**: 用户可手动添加第三方 LLM API Key 到号池
- [x] **POOL-06**: 用户可手动禁用/启用号池中的账号

### 网关路由 (GW)

- [~] **GW-01**: 网关收到请求时从号池动态分配可用账号，替代静态渠道配置
- [ ] **GW-02**: 请求失败时立即切换到下一个可用账号，对调用方透明（报错即切）
- [x] **GW-03**: 智能路由按账号健康度评分和额度余量优先分配优质账号
- [ ] **GW-04**: 每个请求记录使用的账号信息，支持追踪查询
- [ ] **GW-05**: 网关支持现有全部 LLM 供应商 Transformer（OpenAI、Anthropic、Gemini、DeepSeek 等 12+）

### 自动恢复 (RECV)

- [ ] **RECV-01**: 系统定期对异常/冷却状态的账号发起健康探测
- [x] **RECV-02**: 探测成功的账号自动恢复为可用状态并放回号池
- [x] **RECV-03**: 系统区分异常类型：额度耗尽、Token 过期、被封禁、网络超时
- [~] **RECV-04**: 不同异常类型使用不同恢复策略（Token 过期自动刷新、额度耗尽等待重置、被封禁永久禁用）

### 仪表盘 (DASH)

- [x] **DASH-01**: 全局概览面板展示号池总数、可用数、异常数、禁用数
- [ ] **DASH-02**: 网关实时流量展示（请求量、成功率、平均响应时间）
- [ ] **DASH-03**: 账号状态分布可视化（按状态、按供应商）
- [x] **DASH-04**: 最近异常事件列表（时间、账号、异常类型、处理结果）

### 代码整合 (INTG)

- [x] **INTG-01**: 渲染层统一为单一模块体系，消除 js/ / ui/ / src/renderer/ 三套并行
- [x] **INTG-02**: 数据层统一接口，accounts.json 和 gateway.db 通过统一服务层访问

## v2 Requirements

### 高级调度

- **ADV-01**: 按时间段自动调整账号分配策略（高峰/低谷）
- **ADV-02**: 账号额度预测与提前补充提醒
- **ADV-03**: 跨多台机器的分布式号池同步

### 监控告警

- **MON-01**: 号池可用账号低于阈值时桌面通知告警
- **MON-02**: 网关连续失败超过阈值时告警
- **MON-03**: 运行日志导出与历史查询

## Out of Scope

| Feature | Reason |
|---------|--------|
| 多用户/多租户 | 面向个人运维，不需要用户系统 |
| 远程部署/Web 版 | 保持 Electron 桌面应用形态 |
| 账号交易/转让 | 仅限自用管理 |
| contextIsolation 安全改造 | 改动代价大，暂不触碰 |
| 移动端 | 桌面工具，无移动端需求 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| INTG-01 | Phase 1: 代码整合 | Done |
| INTG-02 | Phase 1: 代码整合 | Done |
| POOL-01 | Phase 2: 统一号池 | Done |
| POOL-02 | Phase 2: 统一号池 | Done |
| POOL-03 | Phase 2: 统一号池 | Done |
| POOL-04 | Phase 2: 统一号池 | Done |
| POOL-05 | Phase 2: 统一号池 | Done |
| POOL-06 | Phase 2: 统一号池 | Done |
| REG-01 | Phase 3: 注册流水线 | Pending |
| REG-02 | Phase 3: 注册流水线 | Pending |
| REG-03 | Phase 3: 注册流水线 | Pending |
| REG-04 | Phase 3: 注册流水线 | Done |
| REG-05 | Phase 3: 注册流水线 | Pending |
| REG-06 | Phase 3: 注册流水线 | Pending |
| CARD-01 | Phase 4: 绑卡激活 | Pending |
| CARD-02 | Phase 4: 绑卡激活 | Partial |
| CARD-03 | Phase 4: 绑卡激活 | Pending |
| GW-01 | Phase 5: 网关动态路由 | Partial |
| GW-02 | Phase 5: 网关动态路由 | Pending |
| GW-03 | Phase 5: 网关动态路由 | Done |
| GW-04 | Phase 5: 网关动态路由 | Pending |
| GW-05 | Phase 5: 网关动态路由 | Pending |
| RECV-01 | Phase 6: 异常恢复 | Pending |
| RECV-02 | Phase 6: 异常恢复 | Done |
| RECV-03 | Phase 6: 异常恢复 | Done |
| RECV-04 | Phase 6: 异常恢复 | Partial |
| DASH-01 | Phase 7: 全局仪表盘 | Done |
| DASH-02 | Phase 7: 全局仪表盘 | Pending |
| DASH-03 | Phase 7: 全局仪表盘 | Pending |
| DASH-04 | Phase 7: 全局仪表盘 | Done |

**Coverage:**
- v1 requirements: 30 total, Done: 12, Partial: 3, Pending: 15
- Mapped to phases: 30
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-26*
*Last updated: 2026-03-26 after roadmap creation*
