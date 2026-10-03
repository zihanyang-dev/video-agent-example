# 架构与责任边界

本文件记录重建决策，实际交付状态见 [README](../README.md)。组织原则是按事实归属划分模块，只在真实外部边界建立适配，不机械套用全局 domain/application/infrastructure 分层。

## 1. 三个应用

### web：呈现

负责会话页面、输入、公开消息、进度与产物展示，通过 HTTP 和 AG-UI 与 server 交互。界面状态不是执行状态的权威。

web 不持有长期密钥，不做最终授权，不连接数据库、Redis 或 agent。第一版由 server 托管静态构建产物，不再建立 web 后端代理。

### server：产品

拥有用户会话、用户消息、公开回复与公开产物记录，负责浏览器请求、授权、任务投递和 AG-UI 输出。未来 auth、billing 在这里按真实需求增加。

server 不接入 pi，不操作 sandbox，不选择生成模型，不解释 provider 的生成结果。公开回复是产品记录；模型完整历史、工具消息与执行检查点属于 agent，不能用浏览器传来的历史覆盖它们。

### agent：执行

包含 worker、sandbox、workspace 和 egress。

- **worker**：接收执行命令，认领运行，控制租约、取消、恢复和清理。pi SDK 在可信 worker 中运行。
- **sandbox**：执行 shell 与文件工具，隔离不同会话的工作区，不持有长期 provider、数据库或模型凭据。
- **workspace**：保存和恢复文件，发布可被 server 展示的产物引用。
- **egress**：独立低权限进程，校验短期访问凭证、选择固定目标、注入 provider 凭据并转发。

egress 独立部署的理由是凭据和网络隔离，不是业务拆分。它不拥有模型目录、生成任务、计费、轮询或媒体语义。图片和音乐生成以后由 skill 实现，通用执行核心不包含视频专用规则。

## 2. 三种协议不混用

```text
web ⇄ server                  HTTP + AG-UI
server ⇄ agent                Redis Streams + 内部执行协议
worker ⇄ pi                   pi SDK 事件与工具调用
sandbox → egress → provider   受限 HTTP 转发
```

AG-UI 是公开交互协议，不是数据库结构或内部任务协议。使用官方 schema 和类型，不复制一份自有 AG-UI 定义。

server 校验客户端输入、权限和上下文，转换为内部执行命令。agent 将 pi 输出转换为执行事实。server 再将允许公开的事实转换为 AG-UI 事件；不直接透传内部工具参数、工作区路径、系统提示或凭据。

内部线格式由 `packages/execution-protocol` 的 schema 定义并推导类型。它不包含 pi SDK 类型、数据库行类型或产品策略。

## 3. 事实归属

| 事实                                       | 权威 owner        | 其他方如何使用                                |
| ------------------------------------------ | ----------------- | --------------------------------------------- |
| 会话、用户消息、公开回复、公开产物记录     | server            | web 通过公开 API 读取；agent 接收执行所需输入 |
| 运行状态、租约、执行事件、模型历史、检查点 | agent             | server 消费事件，展示允许公开的结果           |
| 工作区文件和产物内容                       | agent             | server 按产品授权提供公开访问                 |
| 工具 provider 长期凭据                     | egress 的私有配置 | sandbox 只拿短期访问凭证与代理地址            |
| 页面交互与临时输入                         | web               | 不作为持久执行事实                            |

物理上可以共用 PostgreSQL 实例，但连接权限、表的写入责任和事务归属必须区分。共享数据库包不允许一个应用随意修改另一个应用的表。

## 4. 一次消息的处理

1. server 校验请求和权限，在产品事务中保存用户输入及待发送的执行命令。
2. 发送适配器将命令投递到 Redis Streams；投递失败时保留待发送记录。
3. worker 按命令标识去重并认领运行，记录输入已被持久接受，再确认传输消息。
4. worker 恢复必要上下文，调用 pi；shell 和文件操作在 sandbox 内执行。
5. agent 在自己的事务中保存执行事实与待发送事件，再投递 Redis。
6. server 按事件标识去重，将公开结果持久化后确认消息，并向浏览器输出 AG-UI。

这是完整链路的目标行为。当前已有消息接收事务、单命令 outbox 发布操作和 Redis 消费适配器；后台发布循环、agent 持久接受及端到端确认尚未实现。server 和 agent 的 outbox 各自属于对应 owner 的事务；它们是待发送记录，不是两套运行状态。`packages/messaging` 只提供发送、消费、确认和重试机制，不决定业务事务或表结构。

## 5. 可靠性约束

- PostgreSQL 保存权威事实；Redis 负责传输，不成为第二套运行状态。
- 采用至少一次投递，不宣称端到端 exactly-once。命令和事件按稳定标识去重，冲突重放不能静默覆盖。
- 运行认领需要有界租约与 fencing；旧 worker 不能在租约丢失后提交结果。
- 取消是执行命令，不等于浏览器断线。断线不停止任务；重连从已持久化的公开记录恢复。
- Redis 消息确认不早于接收方可靠接受。传输保留和故障恢复策略必须在实现时明确，不能只依赖内存或 Redis 缓存。
- server 只保存必要的公开结果与重放记录，不复制整套 agent 运行状态或模型历史。
- 外部付费请求发送后结果未知时，不自动重新付费提交。需要可恢复的请求标识或显式保留未知状态。
- 启动后台工作的一方拥有取消、等待和清理；清理失败不能被伪装成成功。

### 当前传输与重放约束

- `published_at` 表示发布调用已返回接受，不表示 agent 已可靠接受或执行完成。接收方仍必须先持久化并按 `commandID` 去重，再 ACK。
- 当前消息重放从 outbox 读取原始命令和运行标识。已发布行同时承担重放记录职责，不能按“发送完成”直接清空；改变保留方式需要一起迁移重放查询。
- 单命令发布持有数据库行锁跨越外部调用。调用方必须为数据库等待和 Redis 调用配置可终止的等待；连接重试、队列和关闭不能靠 Redis `BLOCK` 超时保证。
- Redis 消费适配器保留原生回复与已删除条目标识。恢复游标要持续推进，重领不能取代业务认领与 fencing。
- 当前没有生产 Redis 持久化、保留或灾难恢复配置；不把一次 XADD 响应宣称为跨 Redis 故障的端到端投递保证。

## 6. 数据库与迁移

采用 SQL-first：`packages/database/migrations` 中的手写迁移 SQL 是表结构唯一源码，由 dbmate 按统一顺序执行。已应用迁移不可改写，修正使用新迁移；部署阶段迁移，应用启动不竞相迁移，不使用自动结构同步。

Kysely 使用 pg 驱动执行类型化查询、关联、更新与事务。kysely-codegen 从迁移后的数据库生成 `packages/database/generated/db.ts`；pg_dump 另行生成 `packages/database/generated/schema.sql`。两者都是禁止手改的生成物，不是迁移输入，不存在手写 TypeScript 表结构的第二份真相。

普通查询使用类型化 query builder。只有 query builder 不适合表达的数据库特殊操作，才在 owner 的持久化适配器中使用参数化 SQL，并说明必要性；不拼接外部输入，也不增加通用 `BaseRepository`。迁移 SQL 本来就是手写源码，不受查询层的限制。

生成必须使用全新的一次性 PostgreSQL，只应用当前 checkout 的迁移，不从开发库或共享库反推；开发允许未提交迁移，发布只使用已提交版本。固定 PostgreSQL patch、镜像 digest、工具版本及 dump restrict-key，排除 dbmate bookkeeping，使生成物能逐字节复现。具体执行与验证入口以仓库实际脚本为准；迁移、类型生成和字节一致性检查已建立。

共享 database 包只拥有迁移、生成数据库类型和必要的连接工具。`src` 仅在实际消费者需要运行时代码时存在；实际业务查询、事务边界、并发裁决和恢复策略留在对应应用。表仍按 conversation 与 execution 等事实 owner 划分，共享类型不授予跨 owner 写权限。

## 7. 凭据与网络

集中管理配置，但每个进程只获得自己的配置投影。worker 拿模型访问凭据与执行所需连接配置；server 拿产品连接配置；egress 拿 provider 凭据；web 不拿服务端配置。

日常启动只填写 `config/.env`（当前模板为 `config/.env.example`，完整应用启动仍待实现）,长期 provider key 也在其中维护。provider 路由与凭据分开,公开路由以后随仓库提供默认配置,部署只将对应 key 注入 egress,不要求另填 credentials JSON。多个 fal 入口可以引用同一份 key。sandbox 不能提交任意转发目标或替换凭据引用。凭据请求不跟随重定向，输出下载若支持重定向则逐跳校验目标，不附带 provider 凭据。

sandbox 网络只开放必要出口，不可访问 PostgreSQL、Redis、宿主 Docker socket 或 worker 的控制接口。worker 持有 Docker 控制能力，不能把它交给 sandbox。具体网络拓扑和限制需由真实 Docker 测试证明。

## 8. 不提前建设

不创建空 auth/billing 模块，不做 MCP 媒体编排、provider 任务服务、通用 agent 插件平台、配额系统或多套状态投影。视频只是第一个场景，不是 server 或执行协议的默认语义。

当前不写 skill。以后图片、音乐等能力加入时，再确定场景文件、skill 目录和外部操作恢复实现，不先制造空扩展框架。

## 参考

- [AG-UI 官方介绍](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/introduction.mdx)
- [Kysely](https://kysely.dev/)
- [kysely-codegen](https://github.com/RobinBlomberg/kysely-codegen)
- [dbmate](https://github.com/amacneil/dbmate)
- [node-postgres](https://node-postgres.com/)
