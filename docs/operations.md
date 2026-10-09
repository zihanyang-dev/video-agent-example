# 运行与人工恢复

## 健康与日志

worker 仅在容器回环 `127.0.0.1:8788` 提供 `/livez`、`/readyz`，不发布公网端口。探针反映本地存活、连接就绪和停止状态，不认证模型、队列进展、VM 或付费操作已完成。容器 unhealthy 不授权重放任务。

server/worker 记录固定失败阶段及安全分类，不记录私人消息、cookie、工具参数、URL 密码或原始 SDK 异常内容。关注意外退出、持续未就绪、poison、ordinal 缺口、数据库/Redis 故障和清理失败。不额外建设健康推理或告警平台。

## 未知结果

allocation、命令、推理、PUT、pause 或 COMMIT 超时/断连可能已经发生效果。保留原 thread/run/command/message/object 身份、持久记录与供应商引用；不换 ID、换 VM 或重新排队旧付费运行。

数据库租约与 fence 决定 SQL 写入权威，但不能停止旧 worker 操作 VM。环境变更结果未知时隔离并人工核实；普通只读/模型认证失败不等于环境损坏。原生 SDK 可在原始模型额度内 compaction，不授权管理员自动删除历史或无限付费整理。未知 terminal COMMIT ACK 单独不触发 workspace quarantine。

恢复前确认旧 worker 已物理停止，而不是只等 SQL expiry。worker 对同一 native-state 目录持有 kernel flock；native writer 的 abort/join 不确定时先 fail-stop 整个 worker，锁保留到实际 process exit。核对供应商真实记录、同一环境与文件、SQL 终态和 fence。未知创建没有 ID 不证明不存在资源；未知 PUT 不盲删对象；未知 COMMIT 先读原身份。只有远端状态明确且无活跃运行时，管理员才可在锁内显式调整环境引用/恢复标记并留下审计。

Redis 发布成功不等于 receiver 持久接收。保留 outbox/inbox/receipt，投递核对见 [delivery-reconciliation.md](delivery-reconciliation.md)。没有在线自动 apply、自动推理补偿或通用恢复引擎。

## 持久卷、备份与升级

- PostgreSQL、Redis AOF、对象存储卷、worker 专属 `native-state:/state` 与 sandbox 供应商存储分别持久化；单机不提供 HA 或零数据丢失保证。
- 备份 PostgreSQL、资产对象与原生 state，分别记录时间和一致性边界。原生 state 含私人上下文，和配置/认证密钥一起加密并限制访问；Redis 和公开消息均不是私有模型历史备份。备份前 quiesce worker，确认模型/工具/guest 控制写全部 join，再 capture SQL 与 matching native state；仅停 Redis 消费或只备份 `/state/native` 不提供一致 cut。
- 在隔离环境演练恢复，不直接覆盖现有生产卷。恢复后核对消息/运行身份、迁移版本、资产摘要与缺失对象，再应用运行时授权。数据库回档可能使 receiver 记录缺失；缺行不能证明没有历史付费效果。
- binding 的 `execution.native_sessions.initialized` 为 true 后，丢失 assigned native 文件必须 fail closed（conversation 的 `native_state_initialized` 是当前指针镜像）：保留 engine/session/run 身份和预算，恢复核对过的原生文件，不能清空初始化位、删除 SQL 绑定、准备另一 harness 或从公共消息重建空历史。初始化位不是 checkpoint revision digest；同 UUID 的陈旧 native 副本也不能证明与 SQL effect ACK 一致，未核实前禁止接续 active run。
- 已完成 OpenAI request snapshots 和 Pi journal 的磁盘容量/retention 仍需监控与显式维护；当前没有已验收的自动 GC。不要删除 active state、Session history 或未知 ACK 的 final receipt 来腾空间。
- 升级前备份，使用前向 migration；迁移或权限初始化失败不能启动新应用。禁止回滚历史 migration 或重置身份来修复错误。
- provenance migration 是停止 server/worker 后执行的验证，不是数据修复。保留 ledger 必须与 completion 身份、版本及结果一致；已存在 context 则核对其 cutoff 内的完成事实和原始 accepted input，不因快照存在就拒绝，也不将之后完成的任务加入旧快照。来源已裁剪而无法核对、或数据相互矛盾时仍拒绝；保留 SQL/native/ledger 和原身份，不清空、造回执或禁用 immutable trigger。
- 本次经批准修正已发布的验证 migration `20261008030000_harness_completion_provenance.sql`，供尚未应用它的部署使用；已应用的部署通过新前向 `20261008040000_harness_context_provenance.sql` 复核。不手改 migration 执行记录，不回滚已应用版本；更早的 context backfill migration 保持原样。SQL 检查只证明保留材料一致，不证明历史消费或 native freshness；原生状态继续由现有 SDK 读取器校验，缺失 initialized 文件或 seed 不匹配不能用 SQL 快照补造。没有新的恢复 CLI、凭据体系或自动 replay。
- 密码轮换后重跑迁移/权限和 storage-init，再重建相关应用。更换 S3 access key 时显式撤销旧用户；不猜测哪些历史用户可以删除。
- `docker compose down` 保留卷。删除数据卷、供应商资源及全局缓存需独立授权；不使用 global prune 或 `down -v` 作为清理。

生产验收须包括真实授权、模型、官方 sandbox、资产持久化与恢复。历史 direct-token Responses endpoint 的 HTTP 200 未产生 native final；后续显式指派 endpoint 的独立四轮通过见 [verification.md](verification.md)，不将二者混为同一验收或自动购买 Platform API 额度。受信 harness 接续入口及其不能绕过的 native/lifecycle 边界见 [harness-context.md](harness-context.md)。当前没有独立 workspace 备份/销毁重建与永久 node-loss 验收；同 ID pause/reboot、正常 host restart 和 native-state 卷不能替代它。完整边界见 [native-agent-runtime.md](native-agent-runtime.md)。无凭据 fixture 和旧验证日志不认证这些能力；配置与部署命令见 [development.md](development.md)。
