# 技术栈与选型依据

本文件区分技术选择与已实现能力。版本于本次开发通过 npm registry 的稳定 `latest` 核对；工程工具链已锁定精确版本与锁文件，并在 Docker 中运行；实际交付状态见 README，基线不等于已验证交付。不是因为版本新就直接用于生产，也不把尚未实现的模块提前装满依赖。

## 技术栈

| 范围                 | 选择                               | 版本基线                   | 用途                                                              |
| -------------------- | ---------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| 语言                 | TypeScript                         | 7.0.2                      | 严格类型检查；wire 从 schema 推导；数据库类型从迁移后的数据库生成 |
| 运行、安装、单元测试 | Bun                                | 1.4.2                      | server、worker、egress 与工程命令                                 |
| Node 工具兼容        | Node.js                            | 24 LTS 系列                | Docker 内运行要求 Node 的工程工具，不引入另一个业务后端           |
| 页面                 | React                              | 19.3.0                     | 功能聚合的 UI；暂不添加全局状态框架                               |
| 前端构建             | Vite                               | 8.3.2                      | 构建静态页面，由 server 托管；构建不替代类型检查                  |
| 样式                 | CSS                                | 浏览器标准                 | 不提前建设设计系统或引入 UI 套件                                  |
| HTTP                 | Hono                               | 4.13.12                    | server 与 egress 的入站适配；产品规则不写在框架中                 |
| 公开交互             | `@ag-ui/core`、`client`、`encoder` | 1.0.1                      | 官方 schema、客户端与事件编码；不手写另一套协议                   |
| agent 引擎           | `@earendil-works/pi-coding-agent`  | 1.0.0                      | pi SDK，仅在可信 worker 接入                                      |
| 边界校验             | Zod                                | 4.6.5                      | 配置、内部 wire 与外部输出；不重复校验已解析的内部值              |
| 数据库               | PostgreSQL                         | 18.6                       | 持久事实、事务、唯一约束与并发裁决                                |
| 查询                 | Kysely                             | 0.29.6                     | 普通查询使用类型化 query builder，事务留在 owner                  |
| 数据库类型生成       | kysely-codegen                     | 0.20.0                     | 从迁移后的新一次性数据库生成 DB 类型                              |
| 迁移                 | dbmate                             | 2.36.0                     | 统一执行手写 SQL 迁移；SQL 是唯一表结构源码                       |
| PostgreSQL 驱动      | pg、`@types/pg`                    | 8.23.1 / 8.23.1            | Kysely PostgreSQL dialect 驱动与类型；装配入口管理关闭            |
| 消息                 | Redis Streams                      | 服务端稳定版本在部署时锁定 | 消费组、待确认消息与重领，不替代数据库事实                        |
| Redis 客户端         | 官方 node-redis（`redis`）         | 6.3.0                      | 使用官方客户端，不手写 RESP 或自造队列协议                        |
| 文件存储             | S3 兼容 API、AWS SDK v3            | `client-s3` 3.1146.0       | 工作区与产物；实际引入时同步锁定签名 SDK                          |
| sandbox              | Docker                             | CLI/API 兼容性随部署验证   | 初始工具执行实现，不是执行核心的类型或永久部署约束                |
| provider             | fal 的 HTTP API                    | 接口按官方文档验证         | 图片与音乐能力以后通过 skill 接入，不提前编写                     |
| 静态质量             | Oxlint、oxlint-tsgolint            | 1.86.0 / 7.0.2003          | type-aware 异步检查及代码形状约束                                 |
| 格式                 | Prettier                           | 3.9.9                      | 在容器中格式化源码与文档                                          |
| 依赖边界             | dependency-cruiser                 | 18.5.0                     | 检查实际导入、循环和跨应用访问，不扫描源码词汇                    |
| 依赖解析             | `@swc/core`                        | 1.16.13                    | SWC parser 保留 type-only 导入                                    |
| 浏览器验证           | Playwright                         | 实现前锁定稳定版           | 验证 AG-UI 展示、重连和完整用户行为                               |

依赖基线不意味着这些包已全部安装。认证、支付、对象存储服务端镜像和云 sandbox 厂商不在没有需求时随意指定，接入时单独核对维护状态、许可、兼容性和威胁模型。

TypeScript 7 保留不降级，dependency-cruiser 使用 `@swc/core` `1.16.13` 的 SWC parser，避免依赖旧 TypeScript compiler API。上游版本兼容性警告仍是已知限制；relative 与 alias 的 type-only 越界探针均已验证会正确失败，但这不等于所有工具组合都受到正式支持。

PostgreSQL Docker `alpine` 当前已核对为 `18.6`，不是旧的 17 系列。可复现生成必须锁定具体 patch 和镜像 digest，而不是跟随可变 tag。手写迁移在 `packages/database/migrations`；kysely-codegen 的 `packages/database/generated/db.ts` 与 pg_dump 的 `packages/database/generated/schema.sql` 分开生成且禁止手改。生成只使用当前 checkout 迁移构建的新一次性库（开发允许未提交迁移，发布只使用已提交版本），固定 dump restrict-key 并排除 dbmate bookkeeping；不可读取开发库。实际生成与验证入口见开发文档，不以技术选型表代替交付状态。

## 一处填写配置

日常启动只有一个需要填写的入口：`config/.env`，当前模板为 `config/.env.example`。完整应用启动仍待实现。模型设置、数据库所需密码、provider key 和短期凭证签发秘密都在这里维护。

公开 provider 路由以后提供随仓库版本管理的默认配置，不要求用户为了首次启动再填写路由和 credentials JSON。新增 provider 时才修改对应路由定义；多个 fal 路由可以引用同一份 key。

Compose 只将需要的字段投影给对应进程。egress 拿 provider key，worker 拿模型配置，server 不拿这两类秘密。集中填写不是整体注入。生产可以将秘密输入替换为部署平台的 secret 管理，不改业务模块，也不立即造一个 secret 插件系统。

## 可扩展性落在真实边界

- **sandbox**：合同由 worker 的实际工具消费需求决定；执行、取消、文件访问与销毁语义不能携带 container ID 或 Docker SDK 类型。Docker 实现拥有自己的容器细节，未来云 sandbox 实现同一消费合同。
- **pi**：SDK 事件转换位于适配器；运行规则不依赖 SDK 消息类型。不是提前支持多种 agent 引擎。
- **数据库**：业务事务留在 owner，手写 SQL 迁移由 dbmate 统一管理，Kysely 使用从迁移后数据库生成的类型。普通查询用类型化 query builder，必要的特殊 SQL 只在持久化 seam 中参数化使用并说明理由；迁移 SQL 允许手写。抽象不隐藏事务、约束或授权的最终裁决者。
- **Redis**：按官方 Streams 消费组机制接受、确认与重领；阻塞读取使用专用连接，去重与持久接受由 owner 保证。不声称 exactly-once。
- **AG-UI**：使用官方库；内部事件由 server 转换为公开协议，不让前端格式驱动执行存储结构。
- **provider**：egress 只提供受限传输和凭据注入；具体生成流程与未知结果恢复以后属于 skill。

Docker 共享宿主内核，不等于已经获得强多租户安全隔离。初版必须验证网络出口、挂载、权限、进程取消和清理；生产是否使用更强隔离或托管 sandbox，根据威胁模型决定，不以一个接口声称已经解决安全问题。

## 实践依据与本项目决策

官方资料用于核对 API、运行要求和组件行为；事实 owner、三应用划分和目录组织是本项目的设计决定，必须说明取舍并用行为测试保护，不能冒称某厂商的统一最佳实践。

- [Bun 文档](https://bun.sh/docs)：运行、安装与测试。
- [TypeScript TSConfig](https://www.typescriptlang.org/tsconfig/)：严格类型与模块配置。
- [React 文档](https://react.dev/learn)：组件与状态组织。
- [Vite 指南](https://vite.dev/guide/)：构建和运行要求。
- [Hono Bun 入门](https://hono.dev/docs/getting-started/bun)：HTTP 适配。
- [AG-UI 官方仓库](https://github.com/ag-ui-protocol/ag-ui)：公开协议与 SDK。
- [Kysely](https://kysely.dev/)：类型化查询与事务。
- [kysely-codegen](https://github.com/RobinBlomberg/kysely-codegen)：从数据库生成类型。
- [dbmate](https://github.com/amacneil/dbmate)：SQL-first 迁移。
- [node-postgres](https://node-postgres.com/)：pg 驱动与连接生命周期。
- [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)：独立 schema dump。
- [Redis Streams 与 node-redis](https://redis.io/docs/latest/develop/use-cases/streaming/nodejs/)：消费、确认与 pending 消息恢复。
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/welcome.html)：S3 客户端与签名。
- [Docker 安全说明](https://docs.docker.com/engine/security/)：隔离能力及限制。
- [Oxlint type-aware 检查](https://oxc.rs/docs/guide/usage/linter/type-aware.html)：带类型信息的规则。
- [dependency-cruiser](https://github.com/sverweij/dependency-cruiser)：实际依赖图检查。
- [Playwright](https://playwright.dev/docs/intro)：浏览器行为验证。
