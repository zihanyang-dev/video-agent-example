# 开发、部署与验证

本文件只记录可执行的工作流和操作边界。目标架构见 [architecture.md](architecture.md)，代码形状见 [code-style.md](code-style.md)。

## 1. 配置与依赖

- 运维只填写 `config/.env`，模板解释字段，不定义第二套默认值。
- schema、空串处理、默认值和按进程解析在 `packages/config`。启动一次解析，业务函数不读环境。
- 配置错误一次列全，不回显秘密；缺失凭据或 profile 文件响亮失败。
- Compose 逐字段投影，不整体 `env_file`。auth/model/tool-provider 密钥不进入 web；模型、数据库、E2B、对象长期凭据不进入 sandbox。
- 精确 package pins 与 `bun.lock` 同步；Docker images 用 patch 与 digest。新库先核实官方 API 与兼容性，不能凭“latest”或虚构类型补齐。
- 本地 IDE 可以安装忽略的依赖；正式安装、应用运行、测试、生成在 Docker。

```sh
npx --yes bun@1.4.2 install --frozen-lockfile
```

这只是编辑器依赖，不授权自动启动模型或 sandbox。

## 2. 测试与修改

```sh
sh scripts/check.sh
sh scripts/check.sh test apps/agent/src/execute-run.test.ts
sh scripts/database-check.sh test
sh scripts/database-check.sh test test tests/integration/runtime.test.ts
sh scripts/database-check.sh verify
sh tests/scripts/deployment-check.sh
sh tests/scripts/storage-check.sh
```

`check.sh` 不传参数时运行根 `check`：类型、type-aware lint、格式、导入边界与单元测试。传参是 Bun 命令。`database-check.sh test` 不额外传参时运行集成套件；指定单文件时第二个 `test` 是 Bun 子命令，不能省成直接执行测试文件。

正式检查通过不能代替行为验收，也不能代替完整代码艺术评审。新行为/缺陷先复现失败；保持语义的重组先建立基线。测试断言真实权限、结果、唯一赢家与资源静止，不断言转发仪式或目录词汇。

## 3. SQL-first

1. 在唯一 `packages/database/migrations` 增加前向 dbmate SQL；已应用迁移不改写。
2. 在全新一次性 PostgreSQL 应用当前 checkout 迁移，不读取开发库、共享库或其他分支。
3. Kysely codegen 生成 `generated/db.ts`，pg_dump 独立生成 `generated/schema.sql`；两份禁止手改、不当作迁移输入。
4. 固定 patch/digest、dump restrict-key，排除 bookkeeping；生成逐字节复现。
5. 真实测试新库与旧结构升级、约束、锁序、并发重放和权限。

```sh
sh scripts/database-check.sh generate
sh scripts/database-check.sh verify
```

内部类型生成入口不是任意数据库 introspection 工具。认证库结构也由受控 migration 管理，应用不自动同步表。业务时间、唯一性、授权的最终写入与 fencing 由 SQL 裁决，不为分层拆开事务。

### 部署迁移

应用 Dockerfile 的 `migrate` 目标使用官方 dbmate 二进制和 PostgreSQL 客户端：先迁移，再以原生 psql 事务应用 `deploy/database.sql`。不创建临时库，不生成开发类型，不经过脚本编排层。Compose 等待整个任务成功后才启动应用；任务失败时不以新应用继续服务。

旧固定 owner 升级到真实用户需要显式映射，不把旧 thread 自动送给首个登录者，不丢弃旧记录。

## 4. Compose 部署

复制 `config/.env.example` 到 `config/.env` 并填写。为 PostgreSQL 管理员、两个数据库角色和两个 Redis 角色分别生成强密码，建议各运行一次 `openssl rand -hex 32`，使值也能直接用于连接 URL。不填写第二套 URL 密码。Compose 构造进程连接并逐字段投影；管理员和其他进程的密码不进入应用。

`POSTGRES_DB` 使用 ASCII 字母或下划线开头、后续字母/数字/下划线，最多 63 字符。`PUBLIC_PORT` 是 Caddy 外部端口，`PORT` 是 server 内部端口；默认均为 8787。`AUTH_BASE_URL` 必须与浏览器访问的规范 origin 一致，例如本地默认 `http://127.0.0.1:8787`；GitHub OAuth callback 为该 origin 加 `/api/auth/callback/github`。公开 HTTPS 由部署平台终止 TLS，本机 Caddy 只绑定回环端口。

默认对象存储是 Compose 内的固定版本 Silo，数据保存在 `objects-data` 卷。填写独立的 `OBJECT_STORAGE_ROOT_USER/PASSWORD` 与 server/worker 应用凭据；应用 access key 必须彼此不同且不能等于 root user。endpoint/region/bucket 留空时使用 `http://objects:9000`、`us-east-1`、`vid-assets`。原生短期 `storage-init` 等待 Silo 健康，用 mcli 创建 bucket（`--ignore-existing`），按实际 bucket 渲染现有两份 IAM JSON，并更新用户密码和绑定权限；秘密通过 stdin，管理凭据只进入对象服务与这个任务，不进入应用。任务的客户端配置与具体 policy 临时文件仅在私有 tmpfs。

两个进程读取 uploads/generated 和历史 materials/artifacts；server 只写 uploads，worker 只写 generated。历史键只读，旧 workspaces 不作为应用工作区复用。不授予建桶、列举、管理或删除权限；未知 PUT/SQL 回执的对象保留供运维对账，不做自动扫描回收。

`ASSET_MAX_BYTES` 默认 8 MiB、最高 16 MiB，`ASSET_MAX_FILES` 默认 16、最高 32；新输入和新生成资产按当前预算检查，下载也受单文件读取预算约束。升级保留的 `artifacts` 完成回执按历史 SQL 上限（每文件 16 MiB、最多 32 文件）接受元数据，不因后来降低的预算阻塞收件箱；混合回执中的新生成资产仍受当前总字节与数量预算限制。历史文件若超过当前下载预算，可在上述范围内提高配置后重建应用再下载，不删除或改写旧对象。`FILE_IO_TIMEOUT_MS` 默认 30000，允许 1000–120000；它同时约束文件 I/O 和公开应用 JSON 请求的字节收集。JSON 最多 64 KiB，截止时间从开始收集时计算，超时或中止返回 400 且不执行对应变化；进程停止会中止并等待收集结束。该截止时间不限制 SSE 响应寿命，也不覆盖 Better Auth 自己解析的原生认证路由。

`IO_TIMEOUT_MS` 约束 PostgreSQL 连接、服务器端语句／锁及事务空闲预算；客户端响应截止时间为其两倍。响应超时会等待实际关闭并淘汰该物理连接，而不是仅由外部超时 Promise 提前返回。数据库连接可重建，但丢失 COMMIT 回执仍是未知结果，不据此重放写入或推理；关闭客户端也不证明后端立即停止或没有提交。

已有外部 S3 部署填写明确的 endpoint/region/bucket，并事先创建 bucket 和两个独立应用 key。使用 `deploy/storage/*-policy.json` 时替换 `vid-assets` 为真实 bucket；迁移任务不替外部供应商管理 IAM。`storage-init` 遇到非本地 endpoint 直接退出，不向外部发送本地 root；本地 Silo 仍会启动但应用不使用它。这不是通用供应商部署框架，外部 bucket/IAM 就绪由运维负责，HTTP 健康不能证明它。

```sh
docker compose --env-file config/.env up --build -d
```

Compose 直接表达启动顺序：PG/Redis/Silo 健康，数据库迁移与权限任务、对象 bucket/IAM 任务成功，然后 server 和 worker，最后 Caddy。无需先运行部署脚本。初始化任务也适用于已有卷，不能拿 PG 仅在空目录执行的 initdb hook 代替升级。dbmate 和权限 SQL 使用同一个 `postgres` owner；SQL 修复已有对象和该 owner 的 future default privileges，密码和权限在同一事务内更新，秘密由 psql 从环境读取。

Redis 服务旁的短启动段通过 stdin 哈希密码、写入私有 tmpfs 的两条原生 ACL，然后交给官方 entrypoint 降权。没有外部 bootstrap 或模板替换。ACL 只开放对应 stream 发布/消费/重领/ACK，不开放任意 key、管理或 trimming。AOF 使用 `appendfsync everysec`；主机或磁盘故障可能丢失已确认的写入，不承诺零丢失或跨系统 exactly-once。SQL retained inbox/outbox 和精确重放仍必需。

修改应用角色密码后，重新运行上述 Compose 命令；已完成的任务需要显式重跑 `docker compose --env-file config/.env run --rm migrate` 与 `docker compose --env-file config/.env run --rm storage-init`，然后重新创建受影响应用。S3 secret 轮换使用相同 access key；更换 access key 时运维还必须撤销旧用户，任务不推测哪些历史用户可以删除。不要打印包含秘密的 `docker compose config` 输出。

React 静态文件在 `/srv`，Caddy `/api/*` 同源代理包含认证/OAuth 回调，其他路径采用 React fallback。SSE 使用官方自动 flush，不使用负数 `flush_interval`。

默认命令启动 worker，必须填写真实的模型 endpoint/key/id/上下文和输出限额，以及 E2B control-plane/client-proxy/key。启动不会自动提交新 Chat，但会消费数据库和 Redis 中已接受的待办；启动已有数据或提交任务可能调用真实模型和创建 VM，必须先确认目标、费用与授权。部署测试只启动镜像内 worker 并读取其 profile，不提交任务，模型和 VM 地址为不可解析的测试目标；它不能证明真实推理、Cloud、媒体 OAuth 或 VM 成功。

worker 加载镜像内 `profiles/video/instructions.md` 或配置的 profile，不发现宿主 home。不提供默认 Cloud 地址，不向 sandbox 复制长期凭据。

`docker compose --env-file config/.env down` 保留数据卷。删除卷需要单独授权；不用 `down -v` 或 global prune，也不修改现有 Colima 基础设施。

原生接口依据：[PostgreSQL psql](https://www.postgresql.org/docs/current/app-psql.html)、[Redis ACL selectors](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/)、[Redis 官方 entrypoint](https://github.com/redis/docker-library-redis/blob/master/docker-entrypoint.sh)、[Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Silo/mcli](https://github.com/pgsty/mc)。独立存储检查用固定 Silo 镜像内的 mcli 原生管理命令，秘密通过 stdin，管理员仅用于短期 bootstrap，不用于应用 SDK 测试。

## 5. 跨语言合同与生成

公开 HTTP 路由由 Hono 注册，邻近的原生 schema 生成 OpenAPI 3.1；官方 Hey API 生成浏览器 fetch SDK 和声明。Better Auth 的官方 OpenAPI 独立保存，不复制它的认证 DTO。Redis 使用私有 JSON Schema，不伪装成 HTTP 或 AG-UI。

`packages/contract/generated/` 中的 `openapi.json`、`authentication.openapi.json`、`execution-command.schema.json`、`execution-delivery.schema.json` 和 `client/` 都由 `scripts/generate-api.ts` 离线生成。刷新生成物只挂载这一输出目录：

```sh
image=$(docker build --quiet -f deploy/docker/checks.Dockerfile .)
docker run --rm --network none \
  --mount "type=bind,src=$PWD/packages/contract/generated,dst=/app/packages/contract/generated" \
  "$image" bun scripts/generate-api.ts
```

其他语言可以消费这些标准文本；公开 DTO 不包含对象 key、执行私有历史或 provider 凭据。UUID 在运行时规范为小写，JSON Schema 不负责转换值；文件名长度按 JavaScript UTF-16、模式按 ECMAScript 正则解释。HTTP 标题清理、唯一资产选择及官方 AG-UI custom 值等运行时条件不能假称所有外国验证器都等价实现。原生运行时验证仍是接受权威；AJV 独立检查可表示的约束。SDK 不手写、不修改模板，也不放宽应用的严格 TypeScript 设置。

## 6. 生命周期与资源

脚本是可信宿主控制器，检查容器不拿 Docker socket。创建可能成功但 ACK 丢失，清理凭唯一 owner label 与实际 ID，不凭名称删未知资源。客户端、阻塞等待、SSH 远端、临时凭据和防火墙都要有界并拥有收尾。

```sh
VID_CHECK_IMAGE=$(docker build --quiet -f deploy/docker/checks.Dockerfile .) \
  python3 tests/scripts/test_lifecycle.py -v
```

必须提供不可变本地 image ID；缺 Docker/镜像不能静默跳过。Python 控制器不安装主机依赖、不启动 VM，真实资源由 Docker 执行。SDK VM 检查见 [e2b-local.md](e2b-local.md)。

服务停机先拒绝入口，再等真正的 HTTP/SSE 查询、消费/发布、模型/工具/VM 清理，最后关闭 DB/Redis。异常和 cleanup 失败必须有安全诊断；日志不能包含私人消息、cookie、工具参数或连接凭据。

## 7. 人工验证与最终 review

- Playwright 使用独立 named session，结束关闭；SSR/build 不替代真实 DOM 与同源部署旅程。
- SDK 适配改变时验证真实本地 E2B；不调用 Cloud，阳性/阴性受控探测不扩大为全部网络保证。
- 资产与授权需要真实存储行为；不得仅测假 SDK 返回值。
- 类型/lint/格式/边界、全套集成、生成物、脚本与部署权限是不同证据，分别报告。
- 完成实现后才启动三个未参与实现的干净 reviewer；完整读文件和 diff，报告静态风险与可复现缺陷的区别。修复后重新验证。
