# 部署停机

Compose 给 server 1 分钟、worker 2 分钟的 TERM→KILL 宽限期。这是合理的默认运维窗口，不是所有 I/O、SDK 或远端作业已经结算的证明。按实际部署负载调整 Compose 停止窗口，不设置第二套配置有效范围。

先停入口和新任务，发出取消，等待在途请求、后台任务与本地清理，再关闭数据库、Redis 和对象存储。应用收尾期间依赖仍需可用；不要用外层更短期限提前切断依赖。

强杀、崩溃或连接丢失可能留下未知结果。Pi 的 abort/prompt join 超时或拒绝先 fail-stop 整个 worker，不 dispose 后把同一 native writer 交给下一轮；失败清理保留 kernel lock 到 main 的物理 process exit。E2B session heartbeat 失败同样通知 worker 停止模型 spending；close join 已发送的续租请求后才 pause。

重启先持有同一 statePath 的 kernel flock，优先核对 durable native final；没有未知 effect/lifecycle 才能在原始期限/额度内有限 continuation。不自动重放未知付费效果，旧 fence 不能继续写入；供应商操作与 COMMIT 是否发生须按原身份核实。不要根据退出码、abort 或 TTL 推断远端取消、回滚或退款。

quarantine 与 cancelled 分别保存：清理未知不把 durable cancel 改成 failed；未知 terminal COMMIT 本身不证明 VM 损坏。缺失 initialized native state 必须恢复匹配私有文件，不创建空 history。完整恢复范围见 [native-agent-runtime.md](native-agent-runtime.md)。

验证真实打包入口的启动失败和 TERM 行为，并在 PostgreSQL/Redis 集成中验证在途任务、重启后的事实与 fencing。合成睡眠进程或声明了 grace period 都不证明实际应用收尾。真实模型与 VM 验证需额外授权，见 [verification.md](verification.md)。
