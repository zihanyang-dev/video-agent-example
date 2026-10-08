# 开发、部署与验证

## 配置与工具

`config/.env` 是唯一运维输入，由操作员提供；字段以 `packages/config/src/env.ts` 的验证和 Compose 的显式投影为准。当前 checkout 没有公开 env 模板，不从宿主账户配置推断凭据。配置错误不回显秘密。Compose 逐字段投影，模型/供应商凭据只进入可信 worker，管理员凭据不进入应用，长期凭据不进入 sandbox。

正式安装、运行、生成与检查使用固定 Docker 镜像和冻结 `bun.lock`；本地依赖只供 IDE。宿主控制器需要 Docker、Node 24.21.0、Python 3 和 GNU timeout（macOS 可安装 coreutils，使用 gtimeout）。不挂载 checkout、home 或 Docker socket 到检查容器。

```sh
npx --yes bun@1.4.2 install --frozen-lockfile
sh scripts/check.sh
sh scripts/database-check.sh test
sh scripts/database-check.sh verify
sh scripts/deployment-check.sh
```

`check.sh` 默认运行类型、type-aware lint、格式、导入边界与单元测试；参数传给 Bun。`database-check.sh test` 默认运行全部 PG/Redis 集成，也可追加 Bun 命令，例如 `sh scripts/database-check.sh test test tests/integration/runtime.test.ts`。

`deployment-check.sh` 是宿主 Docker 控制入口，顺序运行 production-runtime、storage-initialization 两个 Node 测试，再运行隔离 Compose 验收；任一前置失败即停止。CI 与本地使用同一入口，不能把它放进没有 Docker CLI 的检查容器，也不能用 `bun test tests/` 代替。底层 `tests/scripts/deployment-check.sh` 只负责 Compose 阶段，使用合成凭据和自有资源，不启动真实模型/VM；公开 storage policy 与初始化脚本随固定 `storage-init` build target 打包，不要求 Docker daemon 读取用户主机的源码路径。部署控制器只保留 Docker client 连接配置，service 参数来自自有合成 env 文件，不继承操作员的真实 S3/数据库/模型参数。

## 迁移与生成

唯一结构源码在 `packages/database/migrations`，只增加前向 dbmate migration，不改已应用历史。一次性空 PostgreSQL 应用当前迁移，Kysely codegen 和 pg_dump 生成类型/schema；禁止读取生产库反推或手改生成物。

```sh
sh scripts/database-check.sh generate
sh scripts/database-check.sh verify
```

测试 launcher 创建隔离数据库并写随机所有权标记，fixture 核实实际连接目标后才允许测试 SQL；库名或 URL 前缀不是删除权限。SQL 租约使用锁后的数据库时间，进程轮询用本地定时器；时钟跳变导致失效不能靠放宽 fence 或提高测试预算隐藏。

部署 `migrate` 任务先 dbmate，再以 psql 事务应用运行时 grants/password；任务失败不能启动应用。不生成开发类型，也不创建临时业务库。

旧 owner 需管理员显式分批映射给现有认证用户：在经审查的可信 Docker 运维环境内执行 `bun scripts/assign-legacy-threads.ts reviewed-assignments.json`，只接收管理数据库连接与 I/O 配置。未分配历史继续不可访问，但不阻断已正确归属用户。保留消息/运行/资产身份，未知 COMMIT 先核实原记录。

HTTP DTO 从 Zod 推导；OpenAPI、Better Auth spec 和执行 JSON Schema 离线生成，没有生成 SDK 或第三方源码补丁。命令及输出见 [generation.md](generation.md)。

## Compose 部署

创建私有 `config/` 目录与 `config/.env` 文件（文件权限建议 `0600`），按上述配置定义填写实际部署值。不要复制不存在的模板，也不要把真实配置提交进仓库。数据库管理员、server/worker 数据库角色与 Redis 角色使用独立强密码（可分别运行 `openssl rand -hex 32`）。`POSTGRES_DB` 是最多 63 字符的 ASCII SQL 标识，Caddy 外部端口为 `PUBLIC_PORT`，server 内部端口为 `PORT`。

`AUTH_BASE_URL` 必须等于客户端使用的规范 origin；GitHub callback 为 `/api/auth/callback/github`。只有本地回环可用 HTTP，公开部署由平台终止 HTTPS。Caddy 只代理 `/api/*` 和 SSE，不提供页面；私有 worker 探针 8788 不映射公网。

```sh
docker compose --env-file config/.env up --build -d
```

启动顺序由 Compose 表达：PG/Redis/Silo 健康，迁移/grants 与 storage-init 成功，再启动应用及代理。启动已有数据库中的 worker 会消费已接受任务，可能调用真实模型和 VM；先确认目标与费用授权。

本地对象存储为固定版本 Silo，`objects-data` 保留字节。短期 storage-init 使用原生 mcli 创建 bucket、角色用户与 IAM，管理凭据只进入对象服务/初始化任务，秘密经 stdin，客户端配置与 policy 临时文件在私有 tmpfs。server 只写 uploads，worker 只写 generated；两者读取 uploads/generated 和历史 materials/artifacts，不获建桶、列举或删除权限。

外部 S3 必须预先创建 bucket 与两套应用 key，并填写 endpoint/region/bucket。storage-init 跳过外部 endpoint，不向外部发送本地 root；IAM 与容量由运维负责。使用 `deploy/storage/*-policy.json` 时只替换 Resource 的 bucket，保留结构和角色边界。

新资产默认单文件 8 MiB、16 个，允许最高 16 MiB、32 个；历史完成回执保留原 SQL 上限。下载仍受当前读取预算限制，历史文件超过当前预算时可在合法范围调整配置，不删改旧对象。文件 I/O 默认 30 秒。

应用 JSON 最多 64 KiB，以真实字节而非 Content-Length 判断；无效 JSON/UTF-8 400、超量 413、收集超时 408、中止/传输失败 503，收集失败不执行业务变化。Better Auth 有 body 的原生认证路由也先执行相同字节限额和收集期限，JSON/form 保持原始字节交给 SDK；这不替代 SDK 的 CSRF/OAuth 校验，也不覆盖 SDK 数据库处理或 SSE 寿命。

pg 使用标准 Pool/PostgresDialect 和公开的连接/语句/锁/事务空闲/客户端 timeout。客户端超时不证明服务器回滚，COMMIT 回执未知不允许自动重放；不要在连接 URL/PGOPTIONS 中覆盖应用的 timeout。VM 有限生命周期与 SQL heartbeat 分开；abort 或 TTL 不证明远端作业停止。

worker 加载 `apps/agent/prompt.md`，可通过 `MODEL_PROMPT_PATH` 指定受信任文件。`AGENT_ENGINE=pi|openai` 只选择尚未绑定 conversation 的 engine，不能重解释已存 native identity。`NATIVE_STATE_PATH=/state/native` 挂载 worker 专属 native-state 卷；`RUN_TIMEOUT_MS` 是原始请求预算，而非每次重启的新额度。模型能力/额度必须显式填写，E2B control-plane/proxy/key 使用实际部署值；没有默认 Cloud 地址，不发现宿主配置，不使用 SDK fork。direct-token OAuth 当前不能作为已验收的 Agents SDK 标准 Responses 配置，见 [native-agent-runtime.md](native-agent-runtime.md)。

密码轮换后重跑权限初始化并重建相关应用：

```sh
docker compose --env-file config/.env run --rm migrate
docker compose --env-file config/.env run --rm storage-init
```

不要打印含秘密的完整 Compose config。更换 access key 后显式撤销旧用户；备份、恢复和未知结果政策见 [operations.md](operations.md)，停机见 [deployment-shutdown.md](deployment-shutdown.md)。`docker compose down` 保留数据卷，不使用 `down -v` 或 global prune。

## 检查与 CI

CI 只有基本检查和必要集成两个普通 job，不接收部署秘密，不调用付费模型/Cloud/VM。每个环境准备一次，复用检查镜像与隔离服务；使用原生 readiness、等待和 job timeout，不维护 CLI lost-ACK/单调轮询认证框架。Actions 固定完整 commit，失败只上传明确的安全文本日志。

Shell/YAML 工具按 `.github/python/requirements.txt` 安装，检查实际存活源码；设置 `VID_CI_PYTHON_BIN` 后运行 `sh .github/python/check.sh`。当前没有项目 Python 源码，不保留 Ruff/Pyright 或旧 Python fixture 框架。不用删除业务断言、压低阈值或额外重试制造绿色。

检查脚本只删除 owner label 与 ID 匹配的资源，临时测试不操作现有服务、卷或专用 VM。平台强杀可能打断收尾，不宣称取消无损。

新行为先测试失败，保持语义的重组先建立基线。完成后检查实际文件/diff、冗余与调用方并重跑相关及完整检查。正常磁盘的 PG/Redis/S3、全新安装/打包、在途停机与迁移升级分别验收；旧镜像或 tmpfs 补充检查不替代它们。真实 OAuth/模型/官方 sandbox 需额外授权，见 [verification.md](verification.md) 与 [e2b-local.md](e2b-local.md)。
