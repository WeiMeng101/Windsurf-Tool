# CLIProxyAPI 项目结构与运维手册

适用路径：`/path/to/CLIProxyAPI`

本文档目标：不看源码，也能完成部署、后台运行、监控、排障和日常调整。

## 0. TL;DR（最短可执行流程）

```bash
cd /path/to/CLIProxyAPI

# 1) 初始化统一配置文件（首次执行）
scripts/bootstrap.sh init

# 2) 填写必填项（尤其是 CLI_PROXY_MANAGEMENT_KEY）
vi scripts/startup.env

# 3) 校验配置
scripts/bootstrap.sh check

# 4) 一键启动（含同步 + 健康检查 + 号池启动）
scripts/bootstrap.sh start

# 5) 查看状态/健康/日志
scripts/bootstrap.sh status
scripts/bootstrap.sh health
scripts/bootstrap.sh logs all
```
