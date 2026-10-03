# 目录与依赖规则

## 当前布局与目标数据库目录

根 Bun workspace、package 清单、锁文件与 Docker 检查工具链已存在；配置、内部协议和 server 规则基础已有源码。下图表示责任布局，不表示完整应用已交付。数据库 SQL-first 目录已建立并验证；空目录用 `.gitkeep` 保留，加入实际文件后移除占位文件。

```text
apps/
  web/src/
    features/conversation/
    api/
  server/src/
    modules/conversation/
  agent/src/
    worker/
    sandbox/
    workspace/
    egress/
packages/
  database/
    migrations/            # 手写 SQL，唯一表结构源码
    generated/
      db.ts                # kysely-codegen 生成，禁止手改
      schema.sql           # pg_dump 生成，禁止手改
  execution-protocol/src/
  messaging/src/
  object-storage/src/
  config/src/
config/
  .env.example             # 唯一手填入口 config/.env 的模板
scripts/
  check.sh
  database-check.sh        # 临时库生成、漂移检查与集成验证
  generate-database.sh     # 内部类型生成阶段
deploy/
  docker/
  sandbox/
docs/
tests/
  integration/
  e2e/
```

## 应用内部如何放代码

### web

`features/conversation` 聚合会话的页面、输入、消息和进度展示。`api` 只放 HTTP 与 AG-UI 的客户端适配，不拥有产品规则。不连接内部基础设施。

以后出现另一个独立产品能力时，再增加对应 feature；不预建组件库、状态管理框架或空页面。

### server

按产品能力组织 `modules`，目前 `conversation` 已有消息提交规则与测试，Kysely 事务适配器已实现并通过真实数据库验证。模块内相关规则、入站接口与持久化实现相邻，不强制每个功能经过四层目录。

未来文件可按具体行为命名，例如 `conversation.ts`、`messages.ts`、`http.ts`、`ag-ui.ts`、`conversations-postgres.ts`、`execution-commands.ts`、`execution-results.ts`。这些是命名示例，不是已创建的文件或固定文件数量。

模块之间只使用公开入口，`index.ts` 只做再导出。auth、billing 有真实需求时再建立，不提前占位。

### agent

| 目录        | 内聚职责                                                              |
| ----------- | --------------------------------------------------------------------- |
| `worker`    | 运行规则、认领与控制、pi 适配、检查点、执行持久化、命令消费与事件发送 |
| `sandbox`   | 工具执行合同与 Docker 实现，不拥有运行状态                            |
| `workspace` | 文件保存、恢复和产物发布                                              |
| `egress`    | 独立进程的访问校验、固定目标转发与凭据注入                            |

worker 的执行规则通过消费方所需的最小接口使用 pi、sandbox 和持久化，不直接依赖具体 SDK。接口为了表达真实边界和可测试行为，不为了把单一函数再转发一遍。

应用入口以后放在各自 `src/main.ts`，进程装配和生命周期放在 `src/bootstrap.ts`；egress 有自己的入口，仍属于 agent 包。不建立 `apps/gateway` 或第四个业务应用。

## 共享包拥有什么

| 包                   | 拥有                                                | 不拥有                                    |
| -------------------- | --------------------------------------------------- | ----------------------------------------- |
| `database`           | 手写 SQL 迁移、生成类型与 schema dump、必要连接工具 | 产品规则、运行规则、通用 repository       |
| `execution-protocol` | 内部命令的线格式 schema 与推导类型                  | AG-UI 的重定义、pi 类型、数据库行         |
| `messaging`          | Redis Streams 的发送、消费、确认及可靠发送机制      | owner 的事务、outbox 表定义、业务重试判定 |
| `object-storage`     | 多个应用实际使用的对象存储操作                      | 会话授权、工作区恢复策略                  |
| `config`             | 集中的配置 schema、默认值与按进程解析               | 密钥值、业务决策、隐式全局配置对象        |

`database/migrations` 是唯一迁移目录，手写 SQL 按事实 owner 划分，conversation 属于 server，execution 属于 agent。dbmate 统一执行，不建立应用内迁移目录、自写迁移执行器或另一份手写 TypeScript 表结构。

`database/generated/db.ts` 与 `database/generated/schema.sql` 分别由 kysely-codegen 和 pg_dump 从只应用当前 checkout 迁移的新一次性数据库生成，禁止手改。固定数据库 patch/digest、dump restrict-key 并排除迁移 bookkeeping，保证字节级复现；不从开发库生成。

数据库包仅在实际消费者需要运行时代码时增加 `src`，不预建无消费者的连接包装或手写 TypeScript 表定义。业务查询留在应用的持久化适配器中，普通查询使用 Kysely 类型化 query builder，必要的参数化特殊 SQL 留在该边界并说明理由。迁移本身允许且要求手写 SQL。

共享代码必须对应实际复用或明确的跨进程线格式；命令 schema 当前由 server 构造和读取，agent 接收端尚未实现，不据此扩展通用协议框架。不建立 `common`、`utils`、`base` 或无消费者的技术包。

## 依赖方向

- 应用之间不直接 import 源码，通过 HTTP 或内部执行协议通信。
- 共享包不依赖应用，不持有应用实例，也不读取应用目录。
- web 不引用 database、messaging、内部执行协议或服务端配置代码；AG-UI 使用官方类型。
- server 与 agent 可以消费对应共享包，但只写自己拥有的表；共享 schema 不授予跨 owner 写权限。
- 核心规则不依赖 HTTP、Redis、Kysely 或 pi 的具体类型；适配器连接外部实现，装配入口绑定依赖。
- 模块按职责聚合，不按全局 controller/service/repository 横切。拆分依据是责任，不是行数。

根类型检查、lint 与 dependency-cruiser 配置已存在。依赖检查覆盖循环、跨应用和 web 私有包访问；SWC parser 保留类型导入，relative 与 alias 的 type-only 越界负向探针均已验证会失败。上游兼容性警告仍存在，不宣称所有工具组合均受正式支持；责任归属及未机械检查的规则仍需人工评审。

## 配置、部署与测试

- `config` 存放运维输入；`packages/config` 存放定义与校验代码。两者不重复维护默认值。
- `deploy/docker` 放可信应用、egress、数据库、Redis 和对象存储的镜像与 Compose 配置。
- `deploy/sandbox` 放不可信工具执行环境的镜像定义。
- 单元测试与源码相邻，使用同名 `.test.ts`；`tests/integration` 验证真实基础设施边界，`tests/e2e` 验证完整消息到产物链路。
- 本地安装依赖供 IDE 使用，`node_modules/` 不进 Git。服务、数据库和正式验证在 Docker 中执行；迁移镜像用于已有数据库，临时数据库脚本只用于检查。
- skills 和场景目录暂不创建，待能力实现时再确定位置。
