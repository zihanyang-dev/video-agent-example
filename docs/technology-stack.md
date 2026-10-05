# 技术选择

版本的可执行事实是各 workspace `package.json`、`bun.lock` 和 Dockerfile digest；本文件说明职责与取舍，不复制完整依赖清单。检查入口与证据边界见 [验证](verification.md)。

## 应用与基础设施

| 范围        | 选择                                                | 取舍                                                               |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| 类型与运行  | TypeScript 7.0.2、Bun 1.4.2                         | 严格类型；正式安装、构建和检查在 Docker 中运行                     |
| 页面        | React 19.3.0、JSX、CSS                              | 使用原生可访问元素；页面展示现有 thread，不另造 Chat 实体          |
| 服务端状态  | TanStack Query 5.104.1                              | 服务端事实只有一个缓存；AG-UI 流是临时视图，不替代规范快照         |
| 构建与 HTTP | Bun HTML build、Request/Response                    | 不为目录对称安装额外 HTTP 框架                                     |
| 同源入口    | Caddy 2.11.6                                        | 静态托管、反向代理与 SSE，不拥有认证或产品规则                     |
| 认证        | Better Auth 1.7.7、GitHub、PostgreSQL session       | 使用官方库；撤销必须先持久提交，不能依赖最佳努力的退出接口         |
| 公开流      | AG-UI core/client/encoder 1.0.1                     | 使用官方 schema、客户端和编码；不复制协议                          |
| 可信执行    | pi-coding-agent/pi-ai 1.0.1                         | 显式模型、凭据、profile 和工具；不发现宿主环境配置                 |
| 工具环境    | E2B SDK 2.52.0、Firecracker                         | 消费原生环境身份与持久化；SDK 相同不表示 Embed 与 Cloud 的保证相同 |
| 数据库      | PostgreSQL 18.6、Kysely 0.29.6、pg 8.23.1           | SQL 保持授权、数据库时间、锁、唯一性与 fencing 权威                |
| 迁移与生成  | dbmate 2.36.0、kysely-codegen 0.20.0、pg_dump       | SQL-first；在一次性空库生成类型与 schema，保留前向迁移历史         |
| 传输        | Redis Streams、node-redis 6.3.0                     | 直接使用官方 SDK；稳定 wire、inbox/outbox、持久接受后 ACK          |
| 资产存储    | AWS SDK for JavaScript v3 3.1146.0、S3              | 显式应用凭据与有界二进制 I/O；资产授权由 server 决定               |
| 边界校验    | Zod 4.6.5                                           | 校验外部输入、配置与持久读回；内部已知类型不重复解析               |
| 工程检查    | Oxlint/type-aware、Prettier、dependency-cruiser/SWC | 类型、异步与依赖边界；工具通过不替代人工设计审查                   |

精确镜像 digest 直接查部署文件。新增依赖必须有当前消费者，并减少更多自有复杂度；先核实锁定版本的实现、API 与实际运行约束，不把最新文档当作旧部署能力。TypeScript 7 的工具兼容性限制不能靠降级或取消负向边界检查隐藏。

## 能力与证据边界

- S3 只是字节存储，不拥有用户权限。上传与生成文件共享资产概念；guest 普通文件不是自动公开的资产。
- 原生暂停、恢复与快照属于 provider。持久化 provider 和 opaque native ID 不意味着不同 provider 的环境、内存或快照可互换。
- SQL fence 不能阻止旧 worker 操作远端 VM。租约丢失或远端操作结果未知必须隔离；不能自动重建空环境或重放付费推理。
- Redis 使用至少一次交付。SQL 的幂等与 outbox 不构成 Redis 已确认写入的零丢失保证，也不构成跨系统 exactly-once。
- 本地 Playwright fixture 证明页面行为，不证明生产 OAuth、真实部署、媒体理解或 VM 持久化。媒体接收、模型理解、工具执行和部署可用性分别验证。

## 设计依据

以下是实践者的设计论述，不是“社区禁止 class”的共识，也不是引入依赖的理由：

- TkDodo：[Creating Query Abstractions](https://tkdodo.eu/blog/creating-query-abstractions)，2026-02-23。窄抽象保留推断，区分共享配置与共享逻辑。
- TkDodo：[The Vertical Codebase](https://tkdodo.eu/blog/the-vertical-codebase)，2026-04-13。一起变化的代码相邻；公开接口和依赖边界不能只靠移动文件。
- Matt Pocock：[Codebase Design](https://www.aihero.dev/skills-codebase-design)，2026-07-07，2026-08-24 更新。关注接口背后的真实复杂度、局部性与删除测试；模块可以是函数、类或 package。
- [Handover](https://github.com/zihanyang-dev/handover)：借鉴模块函数、具名事务与真实资源实例，不复制无消费者的层次或生命周期缺口。

## 官方 API 依据

实现使用官方文档与锁定版本源码核实：[React](https://react.dev/)、[TanStack Query](https://tanstack.com/query/latest)、[Better Auth](https://www.better-auth.com/docs)、[Bun](https://bun.sh/docs)、[AG-UI](https://github.com/ag-ui-protocol/ag-ui)、[pi](https://github.com/earendil-works/pi)、[E2B](https://e2b.dev/docs)、[Kysely](https://kysely.dev/)、[dbmate](https://github.com/amacneil/dbmate)、[node-redis](https://redis.io/docs/latest/develop/clients/nodejs/)、[AWS SDK](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/)、[Caddy](https://caddyserver.com/docs/)、[Playwright](https://playwright.dev/docs/intro)。

官方资料说明组件行为；事实归属、权限语义、恢复策略与文件组织由本项目的实现、行为测试与独立评审共同保证。
