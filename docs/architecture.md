# 架构

## 进程与事实

```text
API 客户端 → Caddy → server → Redis Streams → agent → sandbox
                          ↘ PostgreSQL       ↗
                          ↘ 资产对象存储     ↗
```

thread 是持续对话的唯一身份，执行是一轮会话，资产与可恢复环境属于会话。没有 UI、project、第二套 Chat 标识或共享权限体系。

- **server**：认证、归属、消息/资产事实、请求接受与公开结果。
- **agent**：执行租约、官方 pi、沙箱工具与环境保存。
- **Caddy**：认证和 SSE 的 `/api` 代理。

server 使用 auth/product，agent 使用 execution；SQL 权限隔离不改变执行属于会话的关系。

## 一轮执行

```text
HTTP 身份与输入验证
→ 产品事务：锁 thread、裁决重放、写消息与命令 outbox
→ Redis 投递，agent 持久接受后 ACK
→ 领取 thread 租约、分配或恢复 sandbox
→ pi 与工具执行、取消/暂停与收尾
→ fenced 终态事务与事件 outbox
→ server 持久接受后 ACK
→ 产品快照与 AG-UI SSE
```

PostgreSQL 是权威，Redis 至少一次投递。稳定身份、精确重放、冲突拒绝、持久接收后 ACK 和 retained inbox/outbox 保护丢失回执，不宣称跨系统 exactly-once。公开事件按 ordinal、缺口与重连游标发布。

SSE reconnect cursor 是已经持久发布的公共事实标识，不是 run 内的 execution ordinal，也不是客户端可自行加一的序号。它由全局 sequence 分配、按当前 thread 授权验证，可以存在缺口；观察仍按指定 run 重建。`Last-Event-ID` 优先于 `forwardedProps.after`，二者缺省为 `0`（从头开始的 sentinel，不是实际发布事实）。客户端应回传收到的完整 cursor，不推算下一值。当前生成 OpenAPI 中的旧 ordinal 描述尚未调整：本次保持 API 生成物不可变，不修改比较器以隐藏差异。

同一 thread 的执行由 SQL 租约串行化。锁后数据库时间、owner/run/fence 决定写入权威。过期付费运行中断，不自动重新推理。取消是持久请求，不等于真实远端终止；客户端断线不取消已接受工作。终态事务依据最新锁内事实裁决，不在调用方多次续租猜测。

## 身份与资产

Better Auth 使用 GitHub OAuth 与 PostgreSQL session。服务端负责 cookie、可信 Origin、CSRF、账户绑定；请求不能声明 owner。未知或外人身份得到相同拒绝，写入在事务锁内检查最新归属和归档。

注销先持久撤销，再过期 cookie。SSE 每批重新检查会话和归属；到期停止读取，不取消任务。归档拒绝新写入并请求停止活跃运行。

旧 owner 经管理员显式映射给现有用户，不自动认领，不修改历史身份；未分配记录不可访问，但不阻断其他已正确归属的用户。

上传和交付共用资产元数据与授权读取：用户上传由身份/thread 裁决，agent 交付由执行权威/完成事实裁决。消息只引用同 thread 的完成资产，公开 DTO 不包含对象 key、长期凭据或私有 Pi 历史。

S3 保存字节，SQL 保存归属、摘要、不可变对象键与完成事实。正常 PUT 成功直接进入 fenced 完成；未知回执与冲突单独核对，不为每次成功强制下载重算。未知 PUT/COMMIT 不盲删对象，不换身份重试。保留历史 materials/artifacts 键。

文件导入与交付是明确工具动作，不扫描固定目录猜产物。guest 路径由 Agent 自主组织；中间文件不自动公开。媒体接收、模型理解和工具执行分别验证。

## 执行环境与边界

每个 thread 关联原生持久环境引用。首次创建，后续连接/恢复，空闲 filesystem-only pause；不每轮复制目录、kill 或创建空环境。文件系统/COW/缓存由供应商负责，私有模型历史留在 execution SQL。

只使用官方 SDK 和公开 API。`SandboxSessionPort` 只表达实际消费的执行、文件、引用与关闭能力，不复制全部供应商 API、不建 registry 或兼容框架。VM 使用有限任务生命周期，SQL lease 仍独立续租。

保留必要的并发、运行时间/步骤、文件与缓冲限制，不维护每条消息/delta/工具类的多层精确计账。历史过长与 VM 损坏分别处理：保留历史和引用，不自动删除或付费整理。只读失败作为工具错误；变更结果未知则停止该环境后续操作并隔离。

SQL fence 不阻止旧 worker 操作 VM。abort、PID kill、pause 或 TTL 不证明进程树/外部付费任务停止，也不意味着退款。创建、变更、暂停或 COMMIT 结果未知时保留证据，未经人工确认不交给下一轮、不重放 spending。

环境文件、内存快照和外部连接不是同一事实。filesystem-only pause 不保证所有 artifact 已复制；实际部署须验证暂停、恢复、重启、容量与保留策略。Embed 不提供 Cloud 的副本或 HA 保证。

资源创建者负责关闭。进程先停止入口和新任务，再取消/等待在途工作并关闭连接；有限停机宽限期不是全部远端结算的证书。恢复政策见 [operations.md](operations.md)。

## 结构与配置

SQL-first migration 是结构源码：dbmate 执行，Kysely 查询，一次性空库生成类型/schema。已应用历史只前向修正，不从生产库反推，不手改生成文件。

Zod 描述公开 HTTP 与私有执行合同，DTO 从 schema 推导；离线生成 OpenAPI/JSON Schema，没有生成 SDK 分发链。pg 使用标准 Pool/PostgresDialect 与公开 timeout 配置，不代理驱动内部 query。

`config/.env` 是唯一运维输入，Compose 逐字段投影。应用不拿管理员身份，沙箱不拿长期模型/数据库/存储凭据、宿主 home、仓库或 Docker socket。

源码按实际行为聚合。HTTP 直接调用具名事务函数；不为分层拆事务，不建纯转发 service、空目录、备用实现或通用生命周期系统。检查与生产验收见 [verification.md](verification.md)。
