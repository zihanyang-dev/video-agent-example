# video-agent-example

云端通用 agent 平台，视频是第一个应用场景。架构只有三个应用：web 呈现、server 管理产品交互、agent 执行任务。

## 当前状态

根 Bun workspace、精确依赖与锁文件、Docker 检查镜像及检查入口已建立。集中配置、内部执行协议和 server 消息提交规则已有实现与相邻单元测试；其他空目录仍由 `.gitkeep` 保留。

SQL-first 数据库底座已接入 Kysely + kysely-codegen + dbmate + pg，消息接收事务已验证权限、重放、并发去重和冲突回滚。生成类型与 schema 快照从一次性数据库生成并验证一致性。

已有单命令 outbox 发布操作和 Redis 消费适配器：保留 pending，显式 ACK，支持重领游标和已删除条目标识。发送端直接使用官方 Redis 客户端，不强绑消费端配置。

**完整应用尚不能启动或构建，端到端链路尚未交付。** 后台发布循环、worker 持久接受、浏览器与 AG-UI 接入仍待实现。

## 本地编辑器依赖

正常在仓库安装依赖以供 IDE 使用，`node_modules/` 已被 Git 忽略：

```sh
npx --yes bun@1.4.2 install --frozen-lockfile
```

服务和数据库仍在容器中运行，正式检查仍使用 Docker。

## 当前可运行的检查

只需要 Docker，不需要宿主机 Bun、Node 或 PostgreSQL 客户端：

```sh
sh scripts/check.sh                      # 类型、lint、格式、依赖、单元测试
sh scripts/database-check.sh test         # 新建临时 PostgreSQL / Redis，运行集成测试
sh scripts/database-check.sh verify       # 从迁移重新生成，核对生成物无漂移
sh scripts/database-check.sh generate     # 更新生成物，随后审查并提交
```

数据库检查使用隔离网络和一次性容器，不读取运维配置、不暴露宿主端口，结束后清理自己的容器与卷，不碰已有基础设施数据。

## 数据流

```text
浏览器 / web
    ⇅ HTTP + AG-UI（通过 SSE 流式输出）
server
    ⇅ Redis Streams（执行命令 / 执行事件）
agent worker → pi → sandbox → agent egress → provider

server / agent → PostgreSQL：各自拥有的持久事实
server / agent → 对象存储：工作区与公开产物
```

web 的构建产物由 server 托管。egress 是 agent 内部的独立转发进程，不是第四个业务应用。

## 已确定的技术选择

| 用途              | 选择                                  |
| ----------------- | ------------------------------------- |
| 应用与共享代码    | TypeScript                            |
| agent 引擎        | pi，运行于可信 worker                 |
| 浏览器交互        | AG-UI，公开事件由 server 输出         |
| 跨进程传输        | Redis Streams                         |
| 权威持久化        | PostgreSQL                            |
| 数据库访问 / 迁移 | Kysely / kysely-codegen / dbmate / pg |
| 文件与产物        | S3 兼容对象存储                       |
| 运行与验证        | Docker；本地依赖用于 IDE，不进入 Git  |

数据库稳定版本基线为 Kysely `0.29.6`、kysely-codegen `0.20.0`、dbmate `2.36.0`、pg 与 `@types/pg` `8.23.1`。手写迁移 SQL 是表结构唯一源码；数据库类型和 schema dump 是独立生成物。完整版本和验证边界见技术栈文档。

## 文档

- [完整技术栈与选型依据](docs/technology-stack.md)
- [架构与责任边界](docs/architecture.md)
- [目录与依赖规则](docs/directory-structure.md)
- [开发、配置与交付约定](docs/development.md)
- [代码艺术](docs/code-style.md)

## 暂不建设

不提前创建 auth、billing 模块，不建立 MCP 媒体编排、provider 任务服务、插件平台或通用 repository 框架。暂不编写 skill；未来的图片和音乐生成能力属于 agent，配置多个 fal 路由时可以引用同一份私有凭据。
