# cut

一个视频剪辑 agent。**不给它工具,给它一台机器。**

pexo 把能力切成 MCP 工具直接调用 —— `concat(clips)`、`trim(clip, start, end)`。这里给模型一个
真的文件系统和一条真的命令行:ffmpeg、ffprobe、hyperframes,加一个只读的 `skills/` 目录。
它自己 `ffprobe` 素材、自己决定用哪条 filter、渲完自己抽一帧回看。

要证明的只有一句话:**同一份 brief、同一批素材,哪边剪得更好、返工更少。**
怎么量见 [`docs/comparison.md`](docs/comparison.md) —— 口径写在跑之前,brief 不是我们写的。

当前架构、目录边界和数据流在 [`docs/architecture.md`](docs/architecture.md)。
代码风格在 [`docs/code-style.md`](docs/code-style.md)。

## 四个进程

| 进程      | 是什么                  | 为什么单独                       |
| --------- | ----------------------- | -------------------------------- |
| `web`     | 页面,以及 `/api` 的透传 | 前端和 API 的发版节奏不一样      |
| `server`  | 会话:收消息、发 SSE     | 一轮跑十几分钟,HTTP 连接是秒级的 |
| `agent`   | 跑 pi,租沙箱,一轮一个   | 同上,反过来                      |
| `gateway` | 唯一拿着厂商 key 的进程 | **沙箱是不可信的那一方**         |

`skills/` 是内容不是代码:数据加脚本,发布到对象存储,改一条不用发版。

## 跑起来

需要 Docker、[Bun](https://bun.sh) 1.4+,和一个能出网的环境。

```bash
bun install

# 媒体厂商 key 和签名密钥。这份本地配置不进 git。
cp deploy/docker/gateway.env.example deploy/docker/gateway.env
$EDITOR deploy/docker/gateway.env

bun run services        # postgres · redis · minio
bun run services:ready  # 建桶,只用跑一次
bun run sandbox         # 打沙箱镜像,约 2.5G,第一次慢

export DATABASE_URL=postgres://vid:vid@localhost:5432/vid
export REDIS_URL=redis://localhost:6379
export OBJECTS_BUCKET=vid OBJECTS_ENDPOINT=http://localhost:9000
export OBJECTS_ACCESS_KEY=vid OBJECTS_SECRET_KEY=vid-secret

bun run migrate
bun run skills          # 把 skills/ 推到对象存储
```

四个进程各开一个终端:

```bash
bun run gateway   # docker,8080
bun run server    # 8787
bun run agent     # 需要 MODEL_* / SEEDANCE_MODEL / SEEDREAM_MODEL / TURN_TOKEN_SECRET
bun run web       # 3000
```

`TURN_TOKEN_SECRET` 两边必须一样:agent 签,gateway 验。

`deploy/local/` 里可以放一份把这些环境变量都设好的脚本(`agent.sh` / `server.sh` / `web.sh`),
整个目录不进 git —— 因为 agent 那份带着模型的 key。`agent.sh` 直接从 `gateway.env` 里读签名密钥,
不自己存一份:两边一旦不一致,skill 的每一次调用都是 401。

打开 <http://localhost:3000>,说一句想要什么。

## 改完跑什么

```bash
bun run check   # typecheck · lint · 单向依赖 · schema · 行为测试
```

`check` 里的 `schema` 会起一个临时库把迁移重放一遍再 `pg_dump`,所以它需要 Docker 在跑。

数据库结构快照在 [`deploy/database/schema.sql`](deploy/database/schema.sql)。迁移分别由
[`server`](apps/server/migrations/) 和 [`agent`](apps/agent/migrations/) 持有；
[`scripts/database`](scripts/database/) 负责执行迁移与生成快照。改表时新增迁移，再运行
`bun run schema`，不手改生成的 SQL。

`packages/` 只放跨应用协议和共享技术能力：`contract`、`queue`、`object-storage`、`turn-token`。
会话与执行领域仍归各自应用所有。依赖检查规则在 [`.dependency-cruiser.cjs`](.dependency-cruiser.cjs)。

持久化与传输测试使用真实 PostgreSQL / Redis / MinIO；运行控制使用可控 harness，真实 pi 适配器连接本地模拟模型。测试不调用付费 API。

首次升级到当前架构时，先停止旧 server / agent 并排空旧队列，再执行迁移，最后启动新版本。产品和执行数据分别进入 `product`、`execution` schema，迁移会保留原会话及模型历史。这次变更不支持新旧二进制混跑。
