# 技术选择

精确版本以 workspace manifest、`bun.lock` 和 Dockerfile digest 为准。当前只有后端，没有 UI。

| 范围        | 选择                                 | 责任                                       |
| ----------- | ------------------------------------ | ------------------------------------------ |
| 运行与类型  | Bun、TypeScript                      | 原生 TS 入口；固定 Docker 镜像内安装和检查 |
| HTTP 与认证 | Hono、Better Auth                    | GitHub OAuth、PostgreSQL session、公开路由 |
| 合同        | Zod、OpenAPI 3.1                     | 运行时解析、推导 DTO、离线协议文档         |
| 公开事件    | AG-UI                                | 原生 schema、编码和客户端集成测试          |
| 执行        | pi-coding-agent/pi-ai、OpenAI Agents | 独立原生会话；显式模型、提示词、凭据和工具 |
| 沙箱        | 官方 E2B                             | 持久环境身份、有限生命周期、暂停与恢复     |
| 数据库      | PostgreSQL、Kysely、pg               | 事务、授权、时间、锁、唯一性与 fencing     |
| 迁移与类型  | dbmate、kysely-codegen、pg_dump      | SQL-first；一次性空库生成                  |
| 传输        | Redis Streams、node-redis            | 至少一次投递、稳定身份、接受后 ACK         |
| 资产        | S3、AWS SDK；本地 Silo               | 有界字节 I/O；server 裁决归属              |
| API 入口    | Caddy                                | `/api` 代理和 SSE，不托管静态页面          |
| 检查        | Oxlint、Prettier、dependency-cruiser | 严格类型、格式与真实导入边界               |

只使用官方发布包与公开 API，不修改第三方源码、不维护 SDK fork。新增依赖须有当前消费者并减少自有复杂度；锁定版本的 API 和实际部署行为分别核实。

SQL fence 不限制 VM 动作，SDK abort 不证明远端付费作业停止。未知结果保留并人工核实，不自动重放或退款。S3 和 Redis 不取代 SQL 权威；Embed 与 Cloud 不具有相同的持久性或可用性保证。

工程检查不替代真实供应商验证，入口见 [verification.md](verification.md)。两套原生适配器的职责和未完成的供应商、持久恢复验收见 [native-agent-runtime.md](native-agent-runtime.md)。
