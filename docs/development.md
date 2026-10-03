# 开发、配置与交付约定

## 1. 当前交付范围

根 Bun workspace、package 清单、精确依赖与 `bun.lock` 已建立。`deploy/docker/checks.Dockerfile` 与 `scripts/check.sh` 提供容器内检查；集中配置、内部执行协议和 server 消息提交规则基础已有实现与单元测试。完整应用、部署与端到端链路尚未交付，不能把工程检查等同于可启动产品。

数据库 SQL-first 切换已完成；迁移、生成物一致性与消息接收事务已通过真实 PostgreSQL 验证。当前不编写 skill。

实现必须遵守 [架构](architecture.md)、[目录规则](directory-structure.md) 和 [代码艺术](code-style.md)。文档用中文，代码、注释、错误、测试名和提交信息用英文。

## 2. 配置集中、权限分离

部署输入集中在根目录 `config`，校验与默认值集中在 `packages/config`。每个进程启动时只解析一次自己的配置，之后将已解析的类型传入装配入口和调用方。

- 空串按未设置处理。
- 一次列出全部配置问题，不在每修一项后才暴露下一项。
- 错误与日志不回显密钥。
- 缺失凭据引用必须在启动时失败，不能静默禁用路由。
- Compose 显式选择每个进程所需的环境变量，不使用整体 `env_file` 将所有秘密注入所有容器。
- 不在业务函数中读取 `process.env`，也不在使用点添加临时默认值。

日常启动只填写 `config/.env` 一处,模板为 `config/.env.example`。provider key 也在这里维护,不要求另填 credentials JSON。公开路由以后随仓库提供默认配置,只有新增目标时才修改。模板说明运维输入,不能再成为一套独立默认值定义。

### 进程配置范围

以下是目标权限范围；当前解析字段以 `packages/config/src/env.ts` 为准，尚未接入的对象存储、授权和 provider 路由能力不视为已实现。`.env.example` 是单一输入模板，不是额外默认值源码。

| 进程    | 允许的配置                                                                           |
| ------- | ------------------------------------------------------------------------------------ |
| server  | 产品数据库角色、Redis、对象存储、公开访问地址与服务端授权配置                        |
| worker  | 执行数据库角色、Redis、对象存储、pi 模型配置、sandbox 配置与 egress 短期凭证签发配置 |
| egress  | provider 路由、按需注入的 provider 凭据及短期凭证验证配置                            |
| sandbox | 工作区、允许的工具参数、代理地址与有界短期凭证                                       |
| web     | 非秘密的公开交互信息，不读取服务端环境                                               |

路由文件只保存允许目标与凭据引用。部署从 `config/.env` 中选择对应 provider key,只注入 egress,不写入镜像或提交 Git。多个 fal 路由可以引用同一份凭据。生产可替换为部署平台的 secret 输入,无需修改业务代码或同时维护另一份手填配置。

provider key 不能进入 sandbox 或工具参数。临时代理凭证也不得进入公开消息和日志。对象存储的内部读写地址与浏览器可访问的签名地址要分开定义，不能把容器内部域名发给浏览器。

## 3. 数据库工作流

1. 在 `packages/database/migrations` 编写 dbmate SQL 迁移，审查 owner、数据影响、约束与权限变化。手写 SQL 是表结构唯一源码；已应用迁移不可改写，只前向修正。
2. 在 Docker 中创建全新的一次性 PostgreSQL，只应用当前 checkout 的迁移，不从开发库、共享库或其他分支的数据库生成。开发时允许生成工作区中的新迁移，发布时只应用已提交的版本。
3. kysely-codegen 生成 `packages/database/generated/db.ts`，pg_dump 独立生成 `packages/database/generated/schema.sql`；两者提交且禁止手改，不作为迁移输入。
4. 固定 PostgreSQL patch、镜像 digest、工具版本及 dump restrict-key，排除 dbmate bookkeeping 表及相关对象。重复生成必须逐字节一致，并检查干净 checkout 重新生成后的差异；不能忽略随机输出来伪装一致性。
5. 用真实 PostgreSQL 验证空库安装和从上一版本升级，覆盖事务、唯一约束、并发与重放行为。部署统一迁移后启动应用，应用进程不竞相迁移。

registry 稳定精确版本基线是 Kysely `0.29.6`、kysely-codegen `0.20.0`、dbmate `2.36.0`、pg 与 `@types/pg` `8.23.1`。Docker PostgreSQL `alpine` 当前已核对为 `18.6`，可变 tag 不是生成环境的锁定方式。

普通查询与事务使用 Kysely 类型化 query builder 和 pg 驱动。必要的特殊 SQL 只在持久化 seam 中参数化使用并说明理由，不拼接外部输入，不另建通用 CRUD 框架。迁移 SQL 允许且要求手写。数据库类型由迁移后的数据库生成，wire 类型仍从内部协议 schema 推导，二者不是同一事实。

入口已验证：`sh scripts/database-check.sh test` 创建一次性 PostgreSQL 和 Redis 并运行集成测试；`verify` 在独立临时库中生成并逐字节比对两份生成物；`generate` 更新这两份生成物。内部 `db:generate` 只负责类型生成阶段，日常使用上述 Docker 编排入口，不直接对开发库做 introspection。

临时数据库固定为 PostgreSQL 18.6 的镜像 digest，只有一次性测试连接使用 `sslmode=disable`，不改变生产 TLS 策略。

### 发布到已有 PostgreSQL / Cloud SQL

`database-check.sh` 仅是本地和 CI 的隔离验证工具，创建临时库，不是发布迁移脚本。

发布入口是 `deploy/docker/migrate.Dockerfile` 构建的迁移镜像：只包含官方 dbmate 和迁移文件。部署平台注入目标 `DATABASE_URL`，执行 `migrate`；不创建数据库、不启动 Docker 基础设施，也不生成或复制开发类型。镜像可作为 Kubernetes Job、Cloud Run Job 或 CI 迁移任务运行。

Cloud SQL 的网络连通、TLS 与身份验证由部署环境提供，可以使用受控直连或 Cloud SQL Auth Proxy；不是在业务源码里硬编码云厂商。URL、证书和迁移角色权限依照目标环境配置，不把本地测试的 `sslmode=disable` 当作云数据库默认配置。

## 4. Docker 约定

本地运行 `npx --yes bun@1.4.2 install --frozen-lockfile` 安装编辑器所需依赖，`node_modules/` 不提交 Git。不用伪造声明或补 `any` 代替真实依赖；安装后必要时重载语言服务项目。

服务、数据库、构建、迁移生成和正式检查仍在 Docker 中执行；本地类型检查可以作为编辑器问题的补充诊断。

- web 构建产物由 server 托管，不需要另一个带业务逻辑的 web 进程。
- worker、server、egress 按需分别运行，不能用同一份环境配置覆盖全部进程。
- Docker socket 只给需要管理 sandbox 的可信 worker 或受控验证任务，不给 server、egress 或 sandbox。
- sandbox 的网络、文件挂载、进程超时与清理要通过真实容器测试。
- 基础设施端口在本地仅绑定回环地址，持久数据使用命名卷。
- 配置与凭据不烘焙进镜像。重建代码、重建容器和删除数据卷是三件事，清理数据必须明确授权。

仓库删除了旧实现，但不代表宿主机现有 Docker 服务、镜像或数据卷已经被删除。本次不清理这些基础设施数据。

## 5. 验证标准

实现功能时以行为证据为准，不以目录名单或调用顺序测试替代产品承诺。

- 纯规则：相邻单元测试。
- 数据与消息边界：真实 PostgreSQL、Redis、对象存储的集成测试。
- 浏览器交互：AG-UI 事件顺序、公开内容、断线重连与授权。
- sandbox：文件与环境隔离、出口限制、取消、超时和进程清理。
- 执行恢复：重复与冲突投递、并发认领、租约失效、晚到结果、外部请求结果未知。

交付代码前运行对应测试、类型检查、type-aware lint、格式检查和依赖检查，并报告实际执行结果。根检查入口已存在：`sh scripts/check.sh` 在 Docker 内运行根 `check`，包含类型、lint、格式、依赖和单元测试。数据库集成验证和生成物核对分别运行 `sh scripts/database-check.sh test` 与 `sh scripts/database-check.sh verify`，不据此声称完整应用或端到端检查通过。

仅文档变更，在 Docker 内检查 Prettier 格式，并核对本地链接、完整 diff 与空白错误，不要求启动尚未实现的完整应用。该检查是交付核对，不新增扫描目录名单的业务测试。

## 6. 后续实施顺序

1. 已建立 Docker 内 workspace 与检查工具链，以及配置、内部协议和 server 规则基础；继续以负向探针验证边界规则。
2. SQL-first 数据库、可复现生成、消息接收事务与传输操作已建立；接下来实现有界后台发布循环和 agent 的持久接受，再验证端到端恢复。
3. 跑通 web → server → agent → AG-UI 的最小闭环。
4. 加入 pi、sandbox、workspace 和低权限 egress，验证执行隔离与恢复。
5. 最后接入真实场景与图片、音乐 skill，不在基础闭环完成前编写生成工作流。

每一步都区分计划、实现和已验证结果，不以文档中的目标当作已完成能力。
