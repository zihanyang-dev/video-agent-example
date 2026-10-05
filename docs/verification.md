# 验证

验证行为与边界，不把目录、类型检查、SDK 声明或局部浏览器测试当成产品能力证明。

## 正式入口

安装、运行、生成和检查使用固定版本 Docker；本地依赖只供 IDE。

```sh
sh scripts/check.sh
sh scripts/database-check.sh test
sh scripts/database-check.sh verify
sh tests/scripts/deployment-check.sh
sh tests/scripts/storage-check.sh
```

精确 VM 与浏览器入口见 [development.md](development.md) 和 [e2b-local.md](e2b-local.md)。检查不读取真实 `config/.env`，不挂载 Docker socket、宿主 home 或仓库到工具 VM，不调用付费模型/fal/E2B Cloud，不删除未知容器或已有卷。

## 必须成立的行为

### 身份与会话

- 未登录、到期、撤销、注销、可信 Origin 与 CSRF；真实签名 cookie。
- 跨用户 thread、消息、资产和下载拒绝，不泄露标识是否存在。
- thread 创建、消息和取消的稳定意图支持未知回执后精确重试，冲突不覆盖。
- 提交、归档和取消基于锁读最新事实；SSE 后续批次重新检查身份与归属。
- 旧 owner 显式映射，原 thread/message/run/history/outbox 身份保持。

### 执行与原生环境

- 接受后 ACK、重领、poison 与 deleted pending、重复/冲突、ordinal 缺口和游标。
- 锁后过期、fencing、晚到结果、取消与慢收尾；未知付费结果不自动重放。
- Agent 自定路径的文件在下一轮恢复；取消/失败不伪造目录回滚。
- 原生暂停、恢复、过期、未知创建/暂停回执、部署重启与无法恢复的明确结果。
- 失联旧 worker 的环境不自动交给新运行；SQL fence 不冒充 VM fence。
- 文件系统恢复不继续旧进程；供应商不支持时明确失败。
- 停机等待实际模型、工具、保存与 SDK 操作，然后关闭连接。

### 资产与界面

- 有界上传、摘要、完整上传、稳定重试、资产选择归属与消息重放。
- Agent 明确选择文件交付，不以固定目录扫描产生结果。
- 公开产物与终态原子接受、授权读取、安全 MIME/文件名、并发/大小/超时预算。
- React 的一个服务端缓存、用户/会话隔离、稳定重试、刷新发现运行和退出隐私清理。
- 实际同源浏览器：登录会话、Chat、文本/资产、产物、刷新、取消、退出。
- 模板依赖与媒体执行有实际证据；上传、理解和处理不混为一项。

### 部署与工程

- 真实 native psql/Redis 入口、重复应用、已有结构升级、default privileges、密码轮换和坏输入。
- server/agent 数据库与 stream 权限隔离，资产存储使用不同应用凭据；凭据不进 argv/log/VM。
- 实际 packaged web/server/agent 命令、Caddy `/api`、冻结安装与构建。
- 类型、type-aware lint、格式、依赖边界负向探针、全套配置集成、生成物复现与脚本资源清理。

## 完整审查

从真实文件清单读取全部项目源码、测试、配置、部署、脚本和文档；生成物核对来源与复现。缓存图、outline 和 lint 不代替函数体或完整文件。

实现完成后，三位没有参与实现的独立 reviewer 分别覆盖：

1. 身份、会话、资产、SQL、迁移和权限。
2. agent、协议、沙箱、文件、租约、未知结果、取消与资源关闭。
3. React、部署、配置、脚本、文档及全项目代码形状。

报告可复现缺陷或有具体依据的静态风险；所有发现修复或明确处置。修复、清理之后重新执行相关检查和完整检查。检查记录写明实际命令、时间、结果与未覆盖范围，不引用旧计数宣称完成。
