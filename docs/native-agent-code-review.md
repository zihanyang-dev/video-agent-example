# 原生 Agent 改动：代码风格与架构 review

> 本文按审查批次保留改动与验证证据，首轮计数不是后续代码的自动验收。最新清理结果见末尾「最后一轮清理」。

本轮针对当前未提交的原生 Agent 替换实现，而不是把历史研究稿或已删除的实现当成现行代码。范围包括两套 harness、session 持久化、execution 与 SQL 权威、sandbox 生命周期、worker、配置与部署接线，以及相邻测试和当前说明文档。既有无关改动、提示词、历史迁移和供应商证据未恢复或删除。

## 实际调整

### 1. 收平只有锁实现的源码目录

`apps/agent/src/native-state/` 原来只有 `lock.ts` 和相邻测试，没有独立状态管理职责。已移动为：

- `apps/agent/src/native-state-lock.ts`
- `apps/agent/src/native-state-lock.test.ts`

worker 导入、测试子进程模块路径和目录说明同步更新。运行时 `/state/native` 仍是私有持久数据边界；Compose 数据卷没有移动或删除。

另复现并修复了锁文件打开失败时未关闭已经打开的 FFI library。回归测试在隔离子进程中观察真实 library 的关闭，并保留竞争锁与 SIGKILL 后接管测试。

### 2. 按真实职责重构两个巨型 harness 函数

- **Pi**：`runSession` 从 100 行降至 34 行。私有 `PiTurn` 只拥有实际 SDK session、prompt/abort receipts、订阅与关闭；提示词构造、事件预算和最终文本提取分别留在对应职责。不是通用 runner 或 helper 容器。仍须同时 join prompt 与 abort，10 秒未知收尾会 fail-stop，未确认停止的 writer 不 dispose。
- **OpenAI**：`run` 从 167 行降至 50 行。快照串行保存、模型真实 dispatch、fresh agent/tools、Session 初始化及公开文本观察分别成为局部责任函数；移除 complexity suppression。SDK 仍独立拥有 Runner、Session、RunState 与 compaction，没有共享 transcript 或重复套一层循环。

总行数不作为优化目标：把资源状态表达清楚比机械切碎函数更重要。execution 的 stop reason、未 checkpoint effects、物理不确定性和 cleanup errors 没有合并为一个含糊的 retry 状态。

### 3. 修复 OpenAI compaction 的真实 IO 边界

原实现只在 Model wrapper 做 checkpoint，官方 compaction 直接使用 client，绕过该步骤。现在普通生成与 compaction 的真实 HTTP dispatch 都先验证已有 Session、保存原生快照、checkpoint、授权，再检查 abort 并发送。受控 injected Model 保留无 HTTP seam 时的对应门禁。

新增 loopback 回归先证明旧实现会在 checkpoint 拒绝后发送 compaction HTTP，再验证修复后请求数为零。没有制造 Responses 协议帧来适配不兼容供应商。

### 4. 区分本地拒绝与未知远端写入

原 E2B 工具收到已经取消的 tool signal 时，在 SDK action 调用前抛出普通 AbortError；execution 已经预留 effect，却把它当成未知写入，造成错误隔离。

只有 adapter 自己的本地 admission 边界现在返回带 cause 的 `CapabilityRejectedError`，用于纠正该操作自己的已确认 reservation。SDK action 调用后的 AbortError 仍是未知结果，不纠正、不退款；原有物理不确定性也不会被后续本地拒绝清除。

真实 E2B SDK 与 loopback fixture 覆盖 command、text write、binary write 的无 dispatch、单次 correction、继续安全推理、correction ACK 失败，以及已 dispatch 写入和既有不确定性。

### 5. 拆开启动恢复的文件 IO 与 SQL 权威

原恢复在一个事务中锁住所有活跃会话，再逐个等待原生文件。一个慢文件会阻塞无关取消；较后文件失败还会回滚较早的恢复。恢复时间也在文件读取前采样，可能把已越过原 deadline 的请求重新排队并消耗一次 resume。

现在每个原始身份只处理一次：无锁读取候选 → 原生 readonly lookup → 单会话事务，按 conversation、run 顺序锁定并重新验证 active run、fence、engine、native session 和初始化要求。最新取消、legacy gate、隔离及生命周期事实优先；身份改变或已终止的请求不会复活。无 final 的 continuation 在文件 IO 和两个锁之后才采样数据库时间。较早已提交的会话不受较后读取失败回滚。

14 个新的真实 PostgreSQL 回归覆盖慢文件隔离、并发取消、身份变化、最新 workspace/legacy 状态、terminal 不复活、deadline、部分进度，以及 exhausted budgets 后的合法 final。已有 completion 测试未删改。没有增加恢复服务、注册表或自动重试框架。

### 6. 让已存在但损坏的 OpenAI history fail closed

原 `FileSession` 对缺失或 null 的 `items` 使用空数组兜底，可能把同一个 Session 身份下的损坏文件当成空历史，并在下一次写入覆盖它。

现在仅对真正不存在且允许首次初始化的文件返回空历史；存在文件的本地存储 envelope 必须包含数组 history。无效 envelope 拒绝读取、写入及模型 admission，保留原文件。只验证自有 envelope，不复制 SDK 的完整 item schema，也不转换原生 items。

### 7. 删除已核实无消费者的旧表面

- 删除孤立的 `releaseConversation`；terminal release 仍由原子 `recordTerminal` 负责，恢复保留自己的 fence/reset 处理。
- 删除 `FileTools.hasUnknownOutcome`、对应 boolean 和测试替身。生产监督已经通过同步 uncertainty callback 和 effect accounting 接收结果；测试改为直接验证 callback。未知 PUT/import 的保护未删除。
- 模型授权只调用 `reserveModel`；移除旧的通用 `beginEffect` 分支，effect admission 保留操作局部 correction receipt。
- file factory 只接收 `SandboxFiles`，guarded model/file capabilities 不再暴露 `nativeRef` 或 `close`。生命周期仍由创建资源的 execution 收尾。
- 四个 spending/checkpoint 实现 helper 不再导出；保留真正被消费者使用的 SQL 接口。
- README 与技术选择补充独立 OpenAI 适配器及其验收边界，历史研究稿仍保留历史标记。

## 首轮验证

执行使用 Bun 1.4.2 的独立 Docker 源码副本，不挂载宿主工作目录。246 个源码文件的 host/container SHA-256 全部一致；测试中的模型与 E2B HTTP 均为受控 loopback，不调用真实付费模型或 VM。

| 最后整合检查                          | 结果                                                          |
| ------------------------------------- | ------------------------------------------------------------- |
| `bun run check`                       | exit 0；root typecheck、全仓 type-aware lint 和 Prettier 通过 |
| apps/packages 单元测试                | 443 pass / 0 fail                                             |
| 脚本测试                              | 26 pass / 0 fail                                              |
| 架构回归                              | 20 pass / 0 fail；扫描未报告依赖违规                          |
| `sh scripts/database-check.sh test`   | 真实 PostgreSQL/Redis：350 pass / 0 fail，2313 assertions     |
| `sh scripts/database-check.sh verify` | 17 个前向迁移、即时重复 migrate、生成物完全匹配；exit 0       |
| changed-path active LSP               | 13 个路径，无 error diagnostics                               |

dependency-cruiser 仍报告与 TS 7 compiler API 不兼容，可能漏扫 TypeScript 依赖；不能把扫描结果表述为无条件全覆盖，20 个显式负向/正向架构回归单独通过。LSP 补充项目 compiler/lint，不替代它们。

整合日志与源码清单保存在 `/tmp/native-style-review.b0sPLE/`；报告完成后的文档格式另行复核。

## 没有被本轮包装成“已完成”的事项

- native history/snapshot 的保留与 GC 尚无已验收自动策略。
- SQL/native 备份 revision 一致性仍需要 quiesced capture 和运维核实；文件存在不证明 revision 匹配。
- 当前直连 Responses endpoint 的真实 OpenAI final 协议兼容性仍未通过；HTTP 200 不代表原生 Runner 成功。
- 独立 workspace 备份、销毁后重建、永久节点/卷损失、HA 和 Cloud 长作业恢复仍没有完整验收。
- kernel flock 仍只属于声明的同存储主机边界，不是分布式 fencing。

本轮没有提交、推送或部署，也没有提高预算、放宽 lint、增加 suppression 或把未知结果改成自动重放。

## 最后一轮清理（2026-10-08）

对当前源码、实际消费者、CLI/部署入口和文档再做独立审查，未找到可证明无用的生产源文件，不为凑删除数量移除模块或历史证据。

- 删除无消费者的 `FailedRun`、`ThreadsResponse`、`ThreadResponse` 类型别名，保留对应 schemas 与 OpenAPI keys。
- 收窄 9 个仅文件内使用的导出，包括 Pi options、server 内部类型、局部 HTTP schemas 和管理 CLI helper；真正的消费者与入口仍保留。
- 移除 server 重复声明的直接 `pg` dependency，由已声明相同版本的 database package 继续拥有。Bun 原生重新生成 lock，唯一变化是这一 workspace edge；没有依赖版本升级。与 Dockerfile 同参数的 frozen production workspace 安装成功（212 packages），server、worker、database 真实源码导入成功，未打开运行时连接。
- 修复 cancel 后再观察到 fencing loss 被忽略的控制流。loss 现在优先于 cancel；已知失去权威后不再续租或尝试 terminal，但仍 join sandbox cleanup。生产 SQL 原有 fence 一直阻止越权提交，本次没有把这个局部错误夸大为生产越权。新行为测试先 RED（错误返回 cancelled），修复后通过。
- 当前开发说明不再要求复制不存在的 env 模板；不恢复未知来源的删除。历史 infra 研究添加标签，Handover 报告只修当前导航，冻结 BEFORE 和 provenance 保留。

最后整合 `bun run check` exit 0：全仓类型、type-aware lint、格式通过，444 单元、26 脚本、20 架构测试通过；全套真实 PG/Redis 集成 350/0（2313 assertions）。原生 API 重新生成比对通过，public schemas 未变。生产安装闭包不是实际供应商 E2E、全镜像部署或 VM 故障验收。

缓存只做 metadata 分类：有活跃 Ruff 进程，不删除其缓存；`.cache` 的研究与归属证据、浏览器输出、UI 原型、专用 E2B/Lima/home、未知资源以及 prompt 均保留。审查不能把“不参与当前运行”直接等同于垃圾。

本轮证据目录：`/tmp/native-final-cleanup.4nt7b1h0/`。没有提交、部署或真实模型/VM 调用。

## 后续 GC 锁缺陷修复

独立复现确认 Bun 1.4.2 会回收失去引用的 FileHandle 并关闭 fd，进程仍活着时 flock 已释放。之前通过的竞争测试没有强制 GC，不能证明这条物理所有权保证。

`native-state-lock.ts` 现在只在成功 flock 后将 FileHandle 加入模块强引用；正常显式 close 仍幂等，仅在 fd 关闭成功后解除引用。close 拒绝时继续保留到进程退出。没有修改 SQL fence、引入超时偷锁或扩大跨主机恢复保证。运行时文档同步明确 fd 关闭与进程退出这两种真实释放条件。

锁测试覆盖持有/丢弃句柄、失败关闭、failed worker 的实际 GC（WeakRef 核实）、仍活着的竞争进程、显式关闭、SIGKILL 后重新获取，以及 fd 与 FFI library 的实际释放。stdout 收据按流累积读取，不依赖单个 chunk。旧实现确定性 RED：丢弃句柄、关闭失败、failed worker 三种情况均被抢锁；修复后通过。两个独立变异控制分别移除保留到关闭成功的保护、跳过 FFI 关闭，回归均失败。

最新验证：完整 `bun run check` exit 0（448 单元、26 脚本、20 架构，类型/lint/格式通过）；真实 PostgreSQL/Redis 350/0；锁与 worker-unsettled 集中检查 8/0。生产镜像检查在 host Node 26 仅作 Docker 控制端的正确边界重跑，2/0；镜像内实际确认 Node 24.21.0 / Bun 1.4.2，未启动模型或 VM 请求。早先 Docker CLI 不存在的 ENOENT 属于无效启动方式，不作为生产回归证据。

尚未核实完整 Compose、MinIO/轮换、Caddy 和专用 VM 验收。前两类 launcher 需要公开 storage policy 的只读 host bind，与当前禁止 bind 的约束冲突，需明确授权或单独调整接线；不能把剩余环境失败称为已解决。真实 VM/模型也不自动启动。

证据：`/tmp/native-lock-gc-fix.7700dvku/`、`/tmp/native-lock-runtime-verification.md`。独立代码审查未发现阻塞缺陷。没有提交或部署；检查过程中出现的无关 UI 原型删除未恢复，也不归为本次锁修复。
