# 统一已完成上下文与可替换 harness

## 两种状态，不是第二套 Agent runner

同一产品 thread 可以由不同 harness 接续新的任务。平台保存已完成业务对话；Pi / OpenAI SDK 各自负责模型与工具 loop、compaction、原生 checkpoint、取消和恢复。每个 harness 只适配一次共同合同，不实现成对迁移、通用原生 transcript 或业务路由服务。

当前支持 Pi 1.0.1 与 OpenAI Agents SDK 0.19.0。没有 Codex/Claude 生产 engine、A/B 策略或用户选择 UI。OpenAI Agents SDK 不等于 Codex CLI/SDK。

```text
accepted command → immutable run binding → harness native loop
                                        ↘ completed business result
下一任务 + completed context → fresh target session → 同一 thread workspace
```

跨 harness 是新 session 的历史接续，不是恢复另一 SDK 的中断 run。隐藏推理、provider ID/signature、RunState、待执行工具和审批仍留在原 SDK 内。

## 业务合同与模型呈现

`packages/contract/src/conversation-context.ts` 只定义严格 readonly version 1 数据：`throughRunID` 与有序 `turns`，每项保留 run ID、原输入 message ID/text/assets 和最终输出 message ID/text/sources/assets。拒绝未知字段、重复身份、错误 cutoff 和超过 1 MiB 的序列化 UTF8 材料，不静默裁剪；不负责生成提示词。

`execution.runs.completion` 在成功 terminal/outbox 原事务中保存。失败、取消和未完成运行不进入上下文；缺失或不合法的成功结果拒绝聚合。输入从 retained execution inbox 重读并核对原始身份/文本，不需要 worker 访问 product/auth。顺序使用 `created_at, run_id` FIFO，恢复不改变这些键。

切换准备在 SQL 领取锁外完成原生证明读取和历史聚合；领取时按 conversation→run 锁顺序复核源指针、fence 与意图。历史读取先检查 SQL 原始材料大小，超过 3 MiB 时不把消息正文整包传给 worker；这个读取预算包含 command envelope 和重复的输入文本，最终 canonical context 仍受精确 1 MiB 限制。聚合仍需扫描历史，不宣称恒定时间。

模型呈现由具体 harness 负责：OpenAI 使用公开的 user/assistant history items，Pi 使用公开 custom history text。新历史使用英文参考标签，只展示文本、公开 sources 及资产 name/mimeType，不发送内部 run/message/cutoff IDs、objectKey、摘要或长度。参考标签不是禁止重放或 prompt-injection 防护保证；用户文本也不会被当成能自动识别并移除秘密的数据。

历史资产描述不赋予 import 能力。本轮 assets、工具闭包、token、signal 与模型 dispatch 权限仍重新分配。SQL completion 不能清除未知 effects、证明 guest 已停止，或补造丢失的 initialized 原生历史。

## 不可变 binding 与一次初始化

- `execution.native_sessions` 保存 engine、storage 布局、初始化证明和首次 context；`execution.runs.native_session_id` 第一次领取后不可修改。conversation 只是当前指针。
- legacy 存储定位保持已有路径；新的接续段使用 `engine/thread/nativeSessionID`。切回 Pi 也建立新段，不复用落后的旧历史。
- 初始化证明按 binding 单调 false→true，只有真实 durable checkpoint 后确认；历史 run 始终定位自己的原 binding。
- 首次真实输入前 seed；同 digest 不追加，冲突或已有非 bootstrap 历史拒绝覆盖。OpenAI history 与 digest 原子保存，compaction 保留 metadata。Pi 尚未收到首个真实输入时可能不创建 JSONL，不能提前确认 initialized。
- completed replay 优先于 seed/admission，不新增模型或工具。missing/malformed initialized 状态不能由 pending selection 绕过；不匹配的 seed 拒绝继续，不自动重写文件或维护另一套文本格式。

## 平台受信选择

`requestHarness(db, { threadID, nativeSessionID, engine })` 是现有内部库函数，只保存下一新任务的意图。调用方必须受信，并核对当前 binding；同请求重放，冲突拒绝，活跃或待核对生命周期不接受切换。没有独立操作 CLI、公开选择 API、自动路由或切换策略，不扩大 worker 的数据库权限。

worker 在同一 root lifetime flock 下准备和消费意图。只有 FIFO 下一项为未绑定的新任务才消费；已有 binding 的 resumed run 继续原 session、deadline 和额度，pending 留给下一任务。未观察到意图的旧快照不能抹掉随后接受的选择。

已初始化原生源缺失、源 run 缺失或未成功完成、原生 final 不可验证、业务历史缺失/超限或生命周期未结算时不切换。异常需显式核对，不能换 ID 绕过，也不提供跨 SDK 中断恢复。

## Physical、workspace 与迁移

terminal、SQL expiry 或 idle 不证明 writer joined。所有段共享原 root flock；未知收尾的 fail-stop 保留到进程真正退出。切换不清除 workspace quarantine、pending transition 或 cold-reset 标记，不新建 thread workspace。未知 dispatch 不退款，不重置原请求的 16 次模型预留、2 次安全恢复或 deadline。

历史前向 migration 从身份匹配且结果一致的 retained outbox/product receipts 回填业务 final；缺失/冲突保留缺口。后续 provenance 门禁重新核对数字 version、ledger/event/run/thread/message 身份与结果一致性，不将旧回填文本比较当作完整来源证明；验证失败不清空或自动修复数据。非空 completion 已无 retained ledger、或已经 seed 的 immutable context，即使原本合法也需要显式离线核对，边界见 [operations.md](operations.md)。旧 `legacy_history`、inbox/outbox 和 native 文件保留，状态迁移拒绝在线 down。查询索引迁移只改变访问路径并替换重叠 FIFO 索引；普通索引构建会取表锁，必须停止对应的 execution worker 或 product command publisher，再执行迁移。

## 验证层次

合同/公开 SDK bootstrap、真实 PostgreSQL authority/migration 和生产角色 HTTP 场景是不同证据。历史独立 Pi/OpenAI 四轮不认证之后的代码；milestone 审查修复前的源码快照另行通过真实同 thread 的 Pi→OpenAI→Pi→Pi 四轮，核对两次新段、最后复用、context cutoff/provenance/digest、同 workspace、精确工具/文件字节、对话回忆、live streaming 与观察重放无重执行。切换使用内部受信 SQL 入口，不是公开 HTTP 选择 API。实际证据与源码时间边界见 [verification.md](verification.md)，该真实模型 receipt 不覆盖之后的 milestone 修复；physical owner/备份政策见 [operations.md](operations.md)。没有验收对抗性历史指令、隐藏状态完整保真、跨地域恢复或外部付费任务 exactly-once。
