# Agent 持久会话重构

> 历史计划：以下阶段、候选和矩阵记录生产替换前的判断，保留原始研究证据，不再是当前运行合同。2026-10-07 已实现独立 Pi / OpenAI 原生路径；尚未完成真实 provider 与独立 workspace 故障验收。当前实现/阻塞见 [native-agent-runtime.md](native-agent-runtime.md)。

## 状态与范围

本方案已获准开始。先确定正确的目标职责并验证执行核心，再替换生产路径；不是在现有 `turn()` 外继续叠加恢复框架，也不把兼容旧合同作为默认目标。

当前阶段：**基线已记录，处置审计、原生 SDK 与现成 Runtime 的故障验证进行中**。尚未选定新的执行 runtime，尚未切换生产实现。最新调研开始收窄不必要的硬门槛，见[再调研第 11 节](agent-harness-boundary-research.md#11-必要保障与过度防护先修正需求再选择实现)；Claude 按用户要求暂不测。

约束：亲自检查；不提交、推送或部署；不调用付费模型，不操作未知或共享 sandbox；记录并区分已有未提交修改，不无依据覆盖或删除无关改动。测试使用固定版本、受控模型与自有隔离资源。历史 migration 只前向修正；必要的新结构使用前向迁移，生成物从新合同重新生成而非手改。SDK 只使用正式发布包与公开 API。

## 目标

把 Agent 从“一次执行，成功后返回整份 history”改为“身份与状态持续存在的原生会话”。会话进程可以退出，计算资源可以挂起或重建，必要状态不能随旧进程或 sandbox 消失。

```text
产品服务
  请求接受、身份与授权、预算、取消、交付
          │ 输入 / steer / cancel；事件与结果
          ▼
原生 Agent 会话
  transcript、Agent loop、compaction、输入控制、执行恢复
          │ 使用被授权的环境与业务能力
          ▼
Sandbox 基础设施
  命令与文件、持久 workspace、挂起 / 恢复、重连 / 重建
```

三项原则：

1. 每项状态只有一个权威 owner。产品请求接受与原生输入接受可以衔接，但不得有两个调度器同时恢复同一任务。
2. 原生能力由原生 SDK/runtime 承担；基础设施能力由 provider 承担。产品代码不复制两者的状态机。
3. 替换与清理同批完成。每个新增责任对应旧实现的处置；过渡代码必须有明确退出条件。
4. 从正确目标反推实现，不从旧接口反推目标。旧 API、协议、表结构、前端接入和目录分层都可替换；不得为保持它们制造桥接层、双写或备用执行器。分批用于证明正确性，不用于维持旧架构。

## 必须保留的产品保证

保留的是下列行为与安全不变量，不是现有函数、字段、表、协议形状或实现方式。坏合同应连同实际调用方一起替换，包括必要的 server、合同源码与前端接入代码；这些改动不意味着顺便重做无关 UI。

- PostgreSQL 仍是产品与执行授权事实权威；Redis 仍是至少一次投递，持久接受后 ACK。
- 保留准确的请求重放/冲突、thread 归属、锁序、数据库时间和 owner/run/fence 校验。
- 保留已消耗预算、取消意图和原始外部 operation/job 身份，不因恢复盲建第二个付费业务 job。纯生成模型与业务副作用分开判断：建议显式允许限额内重算，不要求所有推理计费 exactly-once；重试仍不得退款/清零未知 attempt 或恢复已取消请求，费用上限策略待明确。
- 未知创建、工具副作用、PUT、pause 或 COMMIT 结果不是可以盲目重试的失败。
- SQL fence 不会物理停止旧 worker、VM 或外部任务；恢复必须先处理旧执行者和未知结果。
- 用户取消不是删除 workspace、退款或自动恢复许可。已经终态的请求不能因恢复复活。
- 资源创建者负责停止、等待与关闭；停止请求不等于实际收尾。保持原始错误与清理错误的区分。
- 原生历史是私有数据，不进入公开事件；序列化状态和 native session ID 不授予权限。

## 会话、请求与环境

### 原生会话

thread 是产品持续对话身份。Pi、Claude、Codex 各自保留自己的会话格式、ID、持久化和恢复 API。平台记录引擎、原生会话定位信息与 workspace 关联，不发明公共 transcript 或跨 harness 的私有恢复格式。

能力在原生会话接入时注册；当前请求的权限、预算、资产范围与取消信号仍需实时绑定，不能把上一轮 lease 固化进长期会话。

原生会话持续保存已完成消息和工具结果。必须另外明确未完成模型请求、流式片段、正在执行的工具和排队 steer 的故障语义；不能把 JSONL 自动写入直接叫作完整 durable execution。

### 多 harness 与执行 owner

多 harness 是选型前提，不是 Pi 改完后才处理的兼容问题。若最终选择 Pi durable，它只拥有 Pi 分支；Claude/Codex 仍使用自己的原生 loop、会话格式、输入与恢复入口。不得把其他 SDK 的整段 query/run 包成 Pi durable 的一个 task 来承诺其内部恢复，也不把多个引擎强制接成同样的 steer/replay API。

平台共用的是产品接受/准确冲突、当前授权、预算、取消、交付及 workspace/业务能力，不是第二套 transcript 或 Agent replay。每个分支必须独立通过它承诺的安全与恢复门槛；能力差异不是弱化授权的理由，也不要求所有 SDK 具有相同 hook 次数/原生冲突 API。缺可靠输入或真实副作用保证要明确报告，而非私造框架或用另一引擎的 receipts 替它验收。纯模型错误与特定未确认业务操作不应一律变成整个 workspace/thread 永久隔离。

### 产品请求

已接受输入需要可靠的身份、状态、取消、预算、公开输出和交付记录，但不要求继续使用现有 `run` 抽象、表结构或状态机。如果原生 operation 模型更合适，就替换旧合同及其消费者。产品请求不是临时 Agent 实例，不通过每次传入/返回整棵 history 决定下一次 Agent 上下文。

产品输入可靠接受与原生输入提交之间，必须使用原始请求身份处理重放和未知回执。若某 SDK 缺少相应保证，先记录能力缺口，再决定采用现成 runtime；不悄悄新增私有恢复引擎。

### 执行环境

workspace 的身份与保留策略独立于一次 run 和一次 VM 生命周期。模型中间产物不是只有最终 `export_file` 才获得存活机会；计算被销毁时，必要文件应能从持久卷或已经保存的快照恢复。

持久卷不等于备份；存储本身丢失、节点断电与 provider 故障仍需单独定义保证范围。

### 物理存储与进程部署（撤回内置方案，重新调研）

此前提出的“完整 harness 搬入业务 sandbox、会话与 workspace 共卷”已被用户否决，**不再是目标或默认候选**。它把控制面与执行环境绑定，不能用文件持久化便利性为理由推进。重新核查的版本、接口、限制与门槛见[外部 Harness 与 Sandbox 边界再调研](agent-harness-boundary-research.md)。

重新调研的边界是：harness/Agent loop 在受信执行服务；业务 sandbox 只提供被授权的命令、文件与任务环境。会话状态属于执行服务的独立持久存储，workspace 属于环境的独立持久存储。两者不必同卷，不要求相同进程生命周期。原生存储接入、单 writer 和跨域故障处理仍需实际验证，不能拿“挂一块盘”当完整答案。

Pi 的 `SessionManager` 使用所在进程的文件系统，可指定独立持久目录；这不要求把进程移动到 guest。Claude/Codex 的原生目录也在实际运行主机。必须分别验证每个 harness 的外部工具/执行接入及原生持久化接口，不能假设三个 SDK 都有相同的 remote filesystem 注入能力。

平台记录引擎、原生会话定位信息、workspace 存储身份和产品授权事实；不发明公共 transcript，也不为了分离部署增加第二个 Agent loop。外部 harness 并不意味着模型代码可以执行在受信 worker 上：模型命令必须进入 sandbox，远端失联不得回退本地执行。

### 存储故障与快照边界

- worker/harness 进程丢失：从执行服务的独立原生状态恢复；未落盘流式窗口、排队输入和工具未知结果按实际保证处理。进程退出不等于磁盘删除；容器重建、换节点和存储故障需要分别验收。
- sandbox 挂起/恢复：仅影响执行环境；harness 不因环境生命周期必须一起冷启动。恢复远端操作前仍须核验执行权与旧任务。
- sandbox 删除：从 workspace 的独立卷或已保存快照重建，再绑定到原生会话；会话状态不是环境快照的副产品。没有文件副本则明确不可恢复。
- **不能假定 VM 快照包含外部挂载卷。** 卷独立保留或使用其自己的快照；rootfs 原生快照须确认捕获范围。
- transcript 与 workspace 分开持久化，不伪造跨系统原子快照。恢复时须处理已记录工具结果、未知副作用和 workspace 恢复点差异，不能用随意的旧文件快照继续新会话。

当前执行服务存储、外部 harness 接入和 E2B 销毁重建均未通过新架构验收。重新调研与核心验证结束前不切换生产。

## Sandbox 生命周期

| 场景                 | 行为                                 | 前提与边界                                                     |
| -------------------- | ------------------------------------ | -------------------------------------------------------------- |
| 首次使用             | 创建环境并关联持久 workspace         | 分配身份确认并持久化后才能发起模型/工具                        |
| 后端仍存在           | 重连或恢复原环境                     | 先取得当前执行权；不能仅凭 native ID 授权                      |
| 正在运行命令         | 保持运行，在供应商限制内维护运行期限 | TTL 不代替取消；不能声称可以无限续命                           |
| 空闲且无 guest 任务  | 挂起计算、保留数据                   | 等待已发操作收尾，不能把仍需运行的进程当空闲                   |
| 新输入               | 恢复环境后提交给原生会话             | 原生输入与环境准备顺序必须有明确 owner                         |
| worker 崩溃          | 核验旧执行者、会话和远端状态         | 连接失败/lease 过期不等于旧 VM 已销毁或旧 worker 已停          |
| 后端确认销毁         | 从独立持久卷或已保存快照重建         | 原身份和数据恢复；没有副本则明确不可恢复，不新建空环境假装续跑 |
| 用户取消             | 停止请求，默认保留 workspace         | 外部任务需要查询/取消原 job，不假定随 VM 一起停止              |
| 明确删除或保留期结束 | 按保留政策删除环境与数据             | 先核对 active/unknown 工作；不以任务失败触发盲删               |

优先验证 workspace 持久化与冷恢复；harness 在外部独立存活或恢复，环境冷启动不要求搬移或重建 harness。保留 VM 内存只在确有终端、浏览器等进程恢复需求时采用，不能复活失去执行权的旧任务。

安装版 E2B 2.52.0 区分内存挂起与 filesystem-only 挂起。filesystem-only 的 timeout 自动挂起不能与 `autoResume` 组合，必须显式 `connect()`；自动唤醒不是一项应无条件开启的优化。实际部署还须验证控制面、节点版本和 feature flags。

## 当前实现与处置清单

下表是第一轮处置方向，不是已经删除或迁移的声明。新增事实应回填证据；“保留”指必要语义，不表示旧文件、函数或合同必须留下。实现不合适时可以整块替换，不能强行为新架构保留旧骨架。

| 当前位置                                                           | 已确认行为/责任                                                   | 处置                                               | 退出或验收条件                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| `apps/agent/src/contract.ts` 的 `AgentHarness.turn`                | 每次传入 text/history/tools，成功返回 history                     | 替换会话交互合同；保持实际消费的能力，避免万能接口 | 原生会话纵向链路通过；生产不再用 history 往返驱动 Agent   |
| `harness/pi/adapter.ts`                                            | 每次创建会话；原生 compaction/retry 关闭；成功后 snapshot         | 替换会话生命周期，接入原生持久化、输入与事件       | 固定 SDK/API 验证后替换；注册与短期授权分开；收尾不削弱   |
| `harness/pi/history.ts`                                            | 原生树校验、信封及 4 MiB admission，恢复到 in-memory manager      | 正常执行路径退役；必要历史导入单列                 | 历史用官方 API 验证迁移；旧数据保留但旧执行路径不继续运行 |
| `execution/execute-run.ts`                                         | 授权、取消、预算、工具未知结果、公开输出、交付和 sandbox 收尾混合 | 保留产品正确性；会话与环境职责归位                 | 实际调用方审阅；不能因“包装”删除未知结果隔离              |
| `execution/run-loop.ts`                                            | 领取、并发、进程停机及 active run supervision                     | 保留必要调度；不得新增第二个 Agent replay loop     | 一个请求只有一个执行 owner；停机加入所有在途工作          |
| `execution/db/execution-leases.ts`                                 | claim/renew/fence；过期 run 终态与隔离；整体 history admission    | 保留授权，替换 history 传输与恢复裁决              | 未知旧 owner 风险有替代处理；不直接删除 quarantine        |
| `execution/db/run-writes.ts`                                       | fenced 完成、整份 history 写入、结果 outbox、quarantine           | 保留产品事务；旧 history 更新退出正常执行路径      | 完成/取消/未知 COMMIT 回归；旧状态不能覆盖新 owner        |
| `sandbox/e2b.ts`                                                   | create/connect；每次 close filesystem-only pause；timeout kill    | 保留具体官方 SDK 接入，落实独立生命周期            | 同 ID 恢复与销毁后重建分别实测，不能拿前者证明后者        |
| `harness/pi/tools.ts`、`harness/files.ts`、`harness/web-search.ts` | 工具声明、资产授权/交付、搜索策略                                 | 保留必要业务与安全责任；消除重复 runtime 职责      | 只用当前授权；未知结果不自动重发；不引入工具 DSL          |
| `worker.ts`                                                        | 连接、配置、harness/sandbox 组装、进程任务 owner                  | 保留组装；改为会话生命周期接入                     | 无无意义转发层/manager；停机顺序和权限投影回归            |
| 对应 tests/config/docs                                             | 一部分保护安全，一部分固化旧执行模型                              | 逐项保留/更新/删除                                 | 不弱化断言或超时；无旧入口、死配置、旧文档或隐藏 fallback |

旧代码退役与旧数据保存分开处理。迁移只前向；过渡期间也只能有一个实际执行 owner。失败不能自动退回旧 runner。不得删除已有不明来源改动、历史证据、生成物或供应商来源。

## 执行阶段与门槛

### 0. 基线与审计（进行中）

记录 HEAD、所有现存受版本控制/未忽略文件的摘要，以及原有 diff。亲自查看关键实现、合同源码、server/前端调用方和测试，形成处置清单。没有读完和核实的范围明确标记；原有测试与文档也必须审查是否固化了错误合同。

退出条件：目标责任、三条故障路径和旧代码处置清单可核对；没有未经批准的框架或隐藏迁移策略。

### 1. 固定版本的原生 SDK 验证（进行中）

首先用当前 Pi 1.0.1 / Bun 1.4.2、loopback 假模型、自有临时文件与子进程验证，随后已验证 Pi durable 候选。**当前收敛固定版 Pi/Codex 路径，Claude 暂不测、独立标待验收**；多 harness 职责仍是架构前提，但不把未测 Claude 当作所有设计工作的阻塞，不先把公共合同做成 Pi durable 的形状。先写行为断言，再验证旧路径缺口与原生持久模式的实际行为。探索代码不作为生产备用实现。

重点：首次 prompt 尚未完成时能否保存；已完成工具结果是否在整个 run 完成前保存；SIGKILL 后重开同一 session 是否保留原始 ID/上下文；未完成工具是否被重放或明确中断；排队 steer 是否耐久；compaction 能否继续；SDK 的 flush 与故障范围。进程级探针先验证公开 API；随后验证外部 harness 的原生状态存储、全部模型工具的远端边界、失联不回退本地，以及 workspace 独立卷/快照与销毁重建。不能把 worker 临时文件验证算作跨节点恢复通过。

退出条件：有实际 receipts，明确能力与缺口。若 current SDK 不够，停止大规模改造并提交现成 runtime 的具体取舍，不私造恢复 engine。`pi-durable` 标为 Experimental，不能仅凭版本号或名字定成生产答案。

### 2. 单个 Pi 会话的完整纵向替换（未开始；以前述多 harness 门槛为前提）

在外部 Agent worker 接入持续原生 Pi 会话与独立持久状态，模型工具绑定受控 sandbox；接通原生输入控制与事件、产品授权/取消/预算、环境恢复和结果交付。凡旧合同阻碍这些职责，就在同一纵向批次替换合同源码、server、数据库结构与前端消费者；不以兼容旧协议、旧表或减少跨层改动为验收目标，也不在新会话模型外包回旧的 opaque turn。

退出条件：正确产品与安全语义的回归、并发/未知结果/停机测试通过；对应旧执行、history 和合同消费路径退出；必要生成物从源码再生成；数据迁移与版本回滚责任明确。

### 3. 多 harness 接入（未开始）

接 Claude、Codex 的原生 API、格式与能力；复用产品身份、业务 MCP 合同和 workspace 策略。不保证不同 SDK 有同样的 resume/replay/steer 语义。

退出条件：各引擎能力矩阵与测试真实，没有有限历史 prompt fallback 冒充完整原生恢复。

### 4. 清理与完整验收（未开始）

亲自审查调用图、生产入口、状态写入、配置、依赖、测试和文档。对每个暂留兼容项记录退出条件；不是跑绿就宣称全项目干净。

退出条件：旧生产路径、重复调度/存储、死导出和隐藏 fallback 无残留；必要兼容均有证据；完整检查和所承诺的真实故障验收通过。

## 验收矩阵

| 验收                     | 必须证明                                                                     | 当前状态                                                                        |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 未完成 run 的连续持久化  | 成功前输入/已完成工具结果已经存活于独立持久状态                              | Pi 进程级探针通过；独立部署存储未验收                                           |
| worker SIGKILL           | 同一原生会话可重开；已完成结果保留；未知操作不盲重放                         | 原生 ID/已完成结果保留；仅 open 不续跑，未知工具未归账                          |
| sandbox pause/resume     | 文件保留、预期内存/进程语义、同 ID                                           | 有历史受控记录；需随新架构重验                                                  |
| sandbox destroy/recreate | workspace 在新环境恢复；外部原生会话身份不重建                               | 未验证                                                                          |
| 副作用成功但回执丢失     | 核对原业务 operation，不能盲建第二个 job；任意 shell 不自动 replay           | 受控副作用已完成但原生 context 仅补缺结果；恢复策略未通过                       |
| 模型请求结果未知         | 区分纯生成与 hosted/stateful effects；按明确的跨恢复限额重算，不清零未知消耗 | 历史单次派发门槛 red 保留，但撤回为所有模型的默认硬门槛；新策略与消耗上限未验收 |
| 长任务/长等待与部署      | 有明确 owner/TTL/等待唤醒，进度不靠常驻 HTTP                                 | 未验证                                                                          |
| cancel/budget            | 取消不复活、预算不清零，终态不被旧 owner 覆盖                                | 旧路径有测试；新路径未验证                                                      |
| compaction               | 长对话继续，原始日志留存；不是删除 history 解决 4 MiB                        | 未验证新路径                                                                    |
| steer/follow-up          | 按原生边界生效；已接受输入的丢失/重放有定义                                  | 普通 SDK steer 丢失；durable 候选 steer 通过，follow-up 未验收                  |
| 双恢复者/旧 owner        | 物理执行权、原生存储 owner 和 SQL 权威一致                                   | 未验证新路径                                                                    |
| 清理                     | 旧执行入口、整份 history 往返与重复状态退出                                  | 未开始                                                                          |

禁止为绿色放宽 lint、复杂度、权限、超时或断言。项目检查至少包含 `sh scripts/check.sh`；SQL/迁移行为变更还需 `sh scripts/database-check.sh check` 与生成物一致性；sandbox 保证需要对应部署的自有真实资源验收。LSP 补充而不替代这些检查。

## 停工条件

- 第二套机制维护同一执行进度，或无法说清恢复 owner。
- 未通过核心验证，就开始增加通用框架/接口。
- 无对应旧实现处置的新增责任；没有退出条件的兼容或 fallback。
- 为兼容旧接口、表或前端合同引入重复状态、双写或桥接层，迫使新会话模型继续服从旧执行骨架。
- 序列化状态授予权限；失联被当作已销毁；未知业务副作用被当作可重试失败。反过来，也不得把可接受的纯推理重算等同不可逆业务 effects，为所有模型先构建 exactly-once 计费协议。
- 原生状态实际写在 worker 临时盘或未持久的 guest rootfs，却宣称可跨实例恢复；只保存 JSONL 却遗漏必要子会话、checkpoint、数据库或 WAL。
- 为会话文件持久化把完整 harness 搬入业务 sandbox，或让环境销毁同时决定会话状态生命周期。
- 模型生成的命令或任意 workspace 文件操作可以在受信 worker 本地执行、篡改原生状态；长期凭据暴露给 guest；假设 VM 快照自动覆盖外部卷。
- 把持续 transcript、SDK声明、正常重启或 SQLite WAL 当作所有故障下零丢失。
- 通过删必要功能、弱化安全或测试来简化实现。

## 本轮证据与更新

初始基线：HEAD `39a1157a44e9497b90d8ddb10ef1dcc26612e0b5`，222 个已跟踪或未忽略路径，包含原有删除和未提交修改。详细摘要/diff 保存于本轮独立临时证据目录，不包含环境凭据。

第一轮 Pi 1.0.1 / Bun 1.4.2 探针已有实际 receipts：当前路径缺原生文件的预期红测试；原生连续保存/同 ID 重开的 23 断言通过；queued steer 耐久性红测试；副作用完成但未回执时 context 仅补 `No result provided`。详细范围与证据见[再调研第 8 节](agent-harness-boundary-research.md#8-pi-外部-worker-的第一轮实证)。这不是核心恢复门槛全部通过；生产替换仍未开始，不新增私有 replay/queue 补洞。当前不宣称生产重构、自动恢复或全项目清理完成。

补充核查与受控故障探针见[再调研第 9 节](agent-harness-boundary-research.md#9-现成-runtime-的发布版与故障验证)：Pi durable 1.0.4 在 Bun/Node 都保住 steer，并不直接重放默认 unsafe 工具；但 safe 恢复不会再跑 beforeTool，未知模型请求仍会再次派发。六组探针为 2 个正向通过、4 个保留的产品门槛红测试，类型/lint/格式检查通过。它是另一套 loop/格式/API、仍为 Experimental，不能当现有 coding-agent 的存储插件。Cloudflare 0.27.0 的 Beta adapter 与 DBOS 5.2.11 也未被选中。项目依赖和生产源码未改；核心安全/能力与独立存储门槛未通过，不以现成库的名字代替验收。

多 harness 纠偏与 Codex 真实 CLI 验证见[再调研第 10 节](agent-harness-boundary-research.md#10-多-harness-是先决条件不让其他引擎套在-pi-durable-内)：0.160.1 app-server 原生 queue 在 active turn 的受控 SIGKILL 检查点保留原输入/ID，15 断言通过；同 client ID 的重复接受和内容冲突两项门槛仍红。只重开并读取队列，不证明原 turn 或远端 executor 自动恢复；daemon continuation 的当前 local-only 条件不符合默认 remote sandbox 路径。Claude query/UUID/interrupt 接口已复核，故障与隔离探针尚未运行。Pi durable 不再作为公共核心的默认方向，生产替换仍未开始。

最新必要性审查见[再调研第 11 节](agent-harness-boundary-research.md#11-必要保障与过度防护先修正需求再选择实现)：撤回纯推理零重复计费、强制 beforeTool 重入和 SDK 重复实现产品冲突的默认硬门槛。明确保留真实 IO 授权、取消、未知写/业务 job、native 连续状态与已接受输入保证；不扩成所有错误都需要恢复 VM。本轮真实 Pi + loopback 401、0 guest operations、确认 reference/pause 的红探针复现了过度 quarantine；未知写 effect 对照仍通过。没有生产修复，未变更原始 fault receipts 或项目断言，旧红不因政策重新分类而算通过。下一批优先原生能力/迁移成本、真实 IO 授权与跨恢复限额、Codex queue/drain 接受窗口以及支持部署的持久目录/workspace 恢复点；先不造模型拒发协议或分布式恢复框架。

## 参考与边界

- [当前架构](architecture.md)、[代码规范](code-style.md)、[生成物](generation.md)、[E2B 实际部署边界](e2b-local.md)。这些描述既存事实；本文描述重构目标与阶段。
- [OpenAI Sandbox Runtime Boundary](https://github.com/openai/openai-agents-python/blob/main/.agents/references/sandbox-runtime-boundary.md)：会话来源、resume/snapshot 与 cleanup owner。
- [OpenHands 原生状态持久化](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/state.py)、[Kubernetes workspace](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-workspace/openhands/workspace/agent_sandbox/README.md)。
- [Pi durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)、[Cloudflare Pi 设计笔记](https://github.com/cloudflare/agents/blob/main/examples/next/harnesses/pi/NOTES.md)：原生恢复 owner 与外层唤醒；目前 Experimental/Beta，不是本项目兼容证明。
- [Claude SessionStore](https://code.claude.com/docs/en/agent-sdk/session-storage)、[file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)：镜像不是 workspace 备份，不保证所有流式片段/副作用零丢失。
- [Rivet 恢复语义](https://rivet.dev/sandbox-agent/docs/session-restoration/)：有限历史 continuation 不等于完整 native resume。
