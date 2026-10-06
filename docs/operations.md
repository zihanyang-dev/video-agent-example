# 运行与人工恢复

## 健康与日志

worker 仅在容器回环 `127.0.0.1:8788` 提供 `/livez`、`/readyz`，不发布公网端口。探针反映本地存活、连接就绪和停止状态，不认证模型、队列进展、VM 或付费操作已完成。容器 unhealthy 不授权重放任务。

server/worker 记录固定失败阶段及安全分类，不记录私人消息、cookie、工具参数、URL 密码或原始 SDK 异常内容。关注意外退出、持续未就绪、poison、ordinal 缺口、数据库/Redis 故障和清理失败。不额外建设健康推理或告警平台。

## 未知结果

allocation、命令、推理、PUT、pause 或 COMMIT 超时/断连可能已经发生效果。保留原 thread/run/command/message/object 身份、持久记录与供应商引用；不换 ID、换 VM 或重新排队旧付费运行。

数据库租约与 fence 决定 SQL 写入权威，但不能停止旧 worker 操作 VM。环境变更结果未知时隔离并人工核实；普通只读失败不等于环境损坏。过长历史原样保留，不自动删除或付费整理。

恢复前确认旧 worker 已停止，核对供应商真实记录、同一环境与文件、SQL 终态和 fence。未知创建没有 ID 不证明不存在资源；未知 PUT 不盲删对象；未知 COMMIT 先读原身份。只有远端状态明确且无活跃运行时，管理员才可在锁内显式调整环境引用/恢复标记并留下审计。

Redis 发布成功不等于 receiver 持久接收。保留 outbox/inbox/receipt，投递核对见 [delivery-reconciliation.md](delivery-reconciliation.md)。没有在线自动 apply、自动推理补偿或通用恢复引擎。

## 持久卷、备份与升级

- PostgreSQL、Redis AOF、对象存储卷与 sandbox 供应商存储分别持久化；单机不提供 HA 或零数据丢失保证。
- 定期备份 PostgreSQL 和资产对象；分别记录时间与一致性边界。备份配置、认证加密密钥和供应商引用，秘密须加密并限制访问。Redis 不是业务事实备份。
- 在隔离环境演练恢复，不直接覆盖现有生产卷。恢复后核对消息/运行身份、迁移版本、资产摘要与缺失对象，再应用运行时授权。数据库回档可能使 receiver 记录缺失；缺行不能证明没有历史付费效果。
- 升级前备份，使用前向 migration；迁移或权限初始化失败不能启动新应用。禁止回滚历史 migration 或重置身份来修复错误。
- 密码轮换后重跑迁移/权限和 storage-init，再重建相关应用。更换 S3 access key 时显式撤销旧用户；不猜测哪些历史用户可以删除。
- `docker compose down` 保留卷。删除数据卷、供应商资源及全局缓存需独立授权；不使用 global prune 或 `down -v` 作为清理。

生产验收须包括真实 OAuth、模型、官方 sandbox、资产持久化与恢复。无凭据 fixture 和旧验证日志不认证这些能力；配置与部署命令见 [development.md](development.md)。
