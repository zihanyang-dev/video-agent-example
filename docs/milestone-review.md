# 全项目 milestone 审查

> 状态：本轮全项目审查、复现修复与合并源码本地门禁已完成。本文记录本地证据，不提前宣称远端 CI；发布结果以该文件所属提交的 GitHub Actions 检查为准。

## 范围与证据原则

本次不是只审未提交 diff：起始清单含 260 个现存项目文件，另有 7 个 tracked 删除需要核对旧实现、当前消费者与替代责任。范围包括应用、共享包、完整迁移、生成类型/schema/API 文档、完整锁文件、Docker/Compose、脚本、CI、全部测试及现行/历史文档。代码与测试使用英文，报告与操作手册使用中文。

此前已有大批 native runtime、统一 completed context 与目录简化的未提交实现。本 milestone 将其作为当前源码重新审查，不把全部 dirty tree 都归因于新发现，也不 reset、恢复退役文件或覆盖无关工作。生成物核对真实来源，不手改。每个分区提供完整读取范围与当前 SHA；父级重新核对更改、调用方、跨分区不变量和最终源码哈希。图缓存解析失败不算审查证据，历史绿色与 reviewer 报告不替代新源码门禁。

| 分区                                 | 起始文件 | 起始行数 | 重点                                             |
| ------------------------------------ | -------: | -------: | ------------------------------------------------ |
| execution / worker / sandbox         |       46 |   11,919 | 接受、预算、锁序、未知效果、物理收尾             |
| native harness / root lock           |       32 |    8,617 | 两种公开 SDK、持久格式、恢复与 writer 生命周期   |
| server / config / contract / storage |       61 |   15,303 | 身份、请求预算、授权、SSE、对象字节、wire 隐私   |
| database / migrations / integration  |       54 |   11,027 | SQL 不变量、历史来源、实际查询成本、fixture 归属 |
| delivery / tooling / CI              |       45 |    4,367 | 冻结依赖、构建投影、隔离、生成、完整门禁         |
| 父级文档 / 跨边界                    |       22 |   11,429 | 当前合同、历史冻结证据、来源与验收时间边界       |

文件数不是证明“无缺陷”的指标，也不要求每个文件都修改。历史 Handover 的 284 个有序代码正文与起始 HEAD 全字节相同；它们固定到旧基线，不被改写成当前架构。旧失败、旧版本与原始计数仍保留。六份历史文档的继承读取缺口已通过 127 个连续原文小段重新完整读取（10,656 行 / 731,562 字节），七份删除的起始 HEAD 正文另以 27 次读取核对（2,332 行 / 74,547 字节）；哈希只佐证身份，不替代阅读。补充 infra memo 历史 banner，明确撤回通用安全/可移植性和无宿主探测的旧推断，不改变冻结正文。

## 架构与代码艺术判断

### 责任应留在实际 owner

- server 直接拥有 auth/product、产品事务与公开观察；agent 拥有 execution、当前 lease/capability、native SDK 与 sandbox 生命周期。两者 SQL grants 独立，导入图不是数据库授权的替代品。
- Redis 只是至少一次投递。发送方 outbox、接收方 inbox/receipt 和 SQL 事务裁决精确重放/冲突；先持久接受再 ACK，不承诺跨系统 exactly-once。
- 消费契约在 `apps/agent/src/contract.ts`；具体 Pi/OpenAI adapter 自己使用原生 SDK。没有通用 transcript、成对 converter、第二 runner、空 engine、注册框架或用户 engine 选择 API。
- 完成业务历史和 native 运行状态是两种事实。平台 context 只投影完成的输入/输出；SDK 保留 loop、compaction、隐藏状态与中断恢复。跨 harness 建立新段，不能接管另一 SDK 的未完成 run。
- worker、SSE subscription、原生文件 Session 和 E2B session 中的 class 有真实状态或资源寿命，不应机械替换成散落的 closure。HTTP 与 SQL 则用具体函数，不叠加转发 service/repository/barrel。

### 保留同一决定，不制造对称结构

SQL admission 保持 conversation→run 锁序与锁后数据库时间；context/native source 的耗时读取在锁外准备，锁内复核 pointer/fence/intent。首次 binding、初始化证明、工具授权、budget/effect 与 terminal 的职责不能为了行数拆开。server 的会话/资产聚合和 agent 的持久 execution owner 不必目录镜像。

Schema 只负责边界数据与推导类型，不生成 model presentation。Pi 英文参考 history 和 OpenAI 公开 user/assistant items 留在各自 Session。reference 标签不提供 prompt-injection 保证；历史资产描述不授予 import 权限。

本次没有恢复退役 CLI、中文 legacy seed、`pi/context.ts`、生成 SDK 分发、UI 或业务 Skills 包，没有为了“最新”扩大 SDK 默认宿主工具、catalog/OAuth/env credential 权限。部分 concrete factory 的共享可选能力 annotation 仍可进一步改善推导，但没有实际能力缺失复现；不为消除标点扩张消费契约或批量改测试。

## 已复现的缺陷与最小修复

### 1. OpenAI 观察异常提前放弃后台 native writer（P1）

原 `for await` 中 `onText` 抛错后，后续 `stream.completed` 被跳过。iterator 取消只是 abort 请求，不证明 model/tool/session persistence/compaction 已结束。真实公开 Runner 与受控 Model 的 pending gate 复现了提前返回。

修复在同一 `try/finally` 中消费公开 `toTextStream()` 并等待公开 `completed`；未在 10 秒内确认收尾则使用已有 `NativeOwnerUnsettledError` fail-stop，不释放 root lock 交给下一任务。SDK 已结算拒绝与未知物理 owner 区分；原 observer/model 错误不变。父级去掉了中间修复新增的 max-depth 豁免，既没有弱化规则，也没有抽只为躲 lint 的转发 helper。

两个回归分别确认 gate release 后保留原错误、未 release 时明确 unsettled；fixture 最后释放并 join 自己的 producer。原 RED 与删除 join 的 mutation 失败均保留。

### 2. Pi 损坏平台回执被当作缺失（P1/P2）

完成回执解析失败原被跳过，可能重新推理已完成任务；trusted asset receipt 解析失败会静默遗失交付事实；input marker 的局部属性检查会把损坏 admission 当成新任务。

仅严格解析平台自己写出的 input/asset/completion envelope，损坏时 fail closed。不复制 SDK transcript schema，不从模型/tool 文本推断资产权威，不增加兼容 fallback。真实 SessionManager 回归证明错误拒绝、零 model/tool/checkpoint admission，完成 JSONL 字节不变、输入 marker 不追加。更新了原先允许丢弃损坏 trusted asset 的错误测试前提。

### 3. 原始接受事实未全部在领取时复核（P2）

`acceptedInput` 原遗漏 retained `command.commandID` 与 `run.command_id`、`command.input.text` 与 `run.text` 的比较。现在在锁内 native binding/run-started/spending 之前拒绝冲突。两个真实 PG corruption 回归的 RED 是 26 pass/2 fail；GREEN 同时确认 queued、null session、零模型与事件。这是保留事实的 fail-closed 完整性，不夸大为任意外部 SQL 攻击路径。

### 4. Better Auth parser 绕过 64 KiB/收集期限（P2）

原 `/api/auth/*` 在产品 middleware 之前直接进入 SDK。Bun 的上传级 body cap 不能替代认证 JSON/form 的字节与停滞预算。真实 Better Auth + Hono 超限请求 RED 得到 400 而非 413。

有 body 的认证请求复用既有 bounded collector，保留 method/URL/headers 和原始 JSON/form bytes，再交给 SDK；不自制 OAuth、CSRF、PKCE、cookie 或 auth parser。GREEN 覆盖 413、停滞 408、底层 cancel 与 reader lock release。收集期限不覆盖 SDK 后续数据库/供应商处理或 SSE 寿命。

### 5. command relay 随 retained history 全表扫描（P2）

实际轮询使用 `published_at IS NULL ORDER BY created_at, command_id LIMIT n`，原缺匹配访问路径。真实 PG 插入 12,000 条已发布历史和 1 条 pending，RED 读取 572 shared buffers。

新增前向 `20261008020000_command_outbox_pending.sql` 的窄 partial btree，不索引 JSON、不改变 ACK/row lock/replay 事实。相同物理 buffer 回归 GREEN；不用微秒墙钟、强迫 planner 或增加预算制造通过。普通 index build 有表锁，需停止 server publisher。真实 generator 更新 schema dump，类型字节不变。

### 6. storage-init 依赖用户主机源码 bind（P2）

Compose 与初始化测试原 bind `deploy/storage`；Docker daemon 与 client 路径空间不同，外部 daemon 无法读取该路径。改为已有 application Dockerfile 中的固定 Silo `storage-init` stage，公开 policy/script 源码 COPY 打包。角色、secret stdin、tmpfs 与 mcli 行为不变。

测试构建实际 shipped target，不使用 fake mcli。RED→GREEN 与 Node24 的四项原生初始化探针保留；无 checkout/home/socket bind。历史文档中的旧只读挂载仍是旧版本证据，当前手册已更正。

### 7. `--env-file` 不隔离操作员 service 环境（P1）

Compose 插值中宿主环境优先于 env 文件。旧控制器会传入操作员真实 S3 等配置，合成 probe 可能误连外部资源。只检测命令环境、未访问假 endpoint 的 RED 证明该泄漏。

实际 Compose 函数用 `env -i`，只保留 Docker client 的连接配置；service 参数来自自有合成文件，cleanup 使用同一边界。没有读取/提取真实 provider 凭据或扩大应用 grants。GREEN 证明操作员变量不传入 Docker。最终合并源码的 pinned Node24 完整部署重跑通过。

### 8. 历史 context backfill provenance（P2）

实际旧迁移 `->> version = '1'` 同时接受数字 1 与字符串 "1"，并未将 JSON eventID 与 ledger event_id 对齐。独有 PG probe 两项 RED 已确认；当前严格 intake 不能追认为旧 backfill 已 canonical。

新增前向 `20261008030000_harness_completion_provenance.sql`，SHARE 锁内核对数字 version、ledger/event/run/thread/message 身份、所有 retained completed 结果一致及与 completion 相同。父级又复现了同 event ID 在另一 ledger 为 failed/started/null kind 的遗漏；现在 completed event 的身份比较检查对应的所有 retained facts，并保留 kind。47 项实际旧→新完整迁移回归通过，包含 uppercase UUID、合法重复、跨 kind 冲突、缺证明、矛盾和失败后所有数据不变；不重写旧迁移、删除、清空或造 completion。

门禁刻意保守：ledger 已裁剪的非空 completion，即使曾合法，也要求离线恢复；已经 seed 的 immutable context 无论 retained output 是否相等，都要求核对来源与消费。这是一次性 migration-time deployment gate，不是自动历史修复或持续协议审计。不提供在线 bypass；旧部署可能因此被阻断，保留 SQL/native/evidence 后按 [operations.md](operations.md) 取得显式审查的离线方案。

### 9. OpenAI SDK AbortError 被补造为空的成功 final（P1）

公开 SDK 的 `completed` 在 native abort 后也可能 resolve，而 owner signal 仍未取消，`finalOutput` 未定义。原 `writer.completion` 把 undefined 转成空字符串。真实 public Runner + Model 抛 AbortError 的 RED 证明持久 snapshot 写出了空 completion；不使用假 Runner 或生产终态帧。

保留 public join 后，只允许非 cancelled、string finalOutput 成为 durable business result，writer 的参数也收窄为 string，移除 undefined→empty coercion。真实明确 `""` final 仍合法。三个回归确认已收尾失败不冒充 unsettled、不写 completion、不增加 admission/model calls，正常/空字符串 final 的重放不重新 spending。

### 10. 合法 JSONL 的 Pi lineage cycle（P2）

删除旧 SQL history validator 时，结构 cycle 防御未等价迁入 native 文件边界。line-count 检查能拒绝被 SDK 丢弃的坏 JSON 行，却不能证明 parent graph 有限。受限子进程的 pinned SDK 对照证明：acyclic 控制正常，self-cycle 通过 count 检查后在 getBranch heap exhaustion/SIGABRT。这是私有损坏/恢复文件的可用性硬化，不声称存在远程租户注入路径。

共用 loader 现在在 SDK open/traversal 之前检查唯一 leading header、基本 version、ID/parent 元数据，并以 O(entries) 迭代遍历所有枝：cycle（含 inactive branch）、重复 ID、孤儿/非法 parent 均拒绝，原字节不变。旧 linear session 的 lineage 交给公开 `migrateSessionEntries` 在内存补齐；不自写兼容框架、复制 provider/message schema 或增加 suppression。

安全 RED 的 11 个失败到达 public getBranch veto，而不是再次让 SDK 耗尽父进程；16 个 GREEN 包含真实 SDK branching、summary、compaction、多根、v1/v2 migration 与 30,001 entries。该 guard 不声称校验任意 provider payload、所有 compaction references、外部非协作 writer 的文件替换或 node-loss durability；七份删除补审没有另证实新增责任丢失。

## 官方 API 与版本决定

精确安装以 manifest/lock/digest 为准；核验 released API 与相关 changelog，不自动追 latest。

| 组件                             | 当前 pin                          | 本次官方 latest | 决定                                                                                                |
| -------------------------------- | --------------------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| Pi / pi-ai                       | 1.0.1                             | 1.1.0           | 保留已验证 native 格式；新 event 类型含 breaking change，升级应单独验证 admission/cancel/compaction |
| OpenAI Agents                    | 0.19.0                            | 0.19.0          | 使用公开 Runner/Session/RunState/compaction/text stream/completed                                   |
| OpenAI client                    | 7.19.0                            | 7.30.1          | 不混入其它 Beta Agents/Decisions/hosted API；与 Agents 依赖一致                                     |
| E2B                              | 2.52.0                            | 2.53.1          | 保留真实已验收版本；公开生命周期语义需按实际部署目标另验                                            |
| Better Auth / Hono / Kysely / pg | 1.7.7 / 4.13.13 / 0.29.6 / 8.23.1 | 同 pin          | 保留官方适配，核对当前发布实现与 docs                                                               |
| AWS S3                           | 3.1146.0                          | 3.1147.0        | 最新为 version bump；保留显式 maxAttempts=1、条件 PUT 与有界 consume/destroy                        |
| Node / Bun                       | 24.21.0 / 1.4.2                   | 按固定验证条件  | 不借宿主 Node26 冒充 pinned controller                                                              |

Actions 经官方 release/tag/action.yml 核验：checkout7.0.1 不变，upload-artifact7.0.2、setup-node7.1.0 更新为完整 SHA；contents:read、不 persist checkout credentials、无 provider secrets、无自动缓存，完整 CI 不加 path exclusion。

父级 Context7 核对官方 OpenAI Agents streaming/results；server 分区也核对 Better Auth/Hono/Kysely/AWS docs。main 文档不是 pin 证据，安装发布包与实际 loopback/类型验证补核。子代理没有相应工具时明确记录，不能声称调用过。只审读官方实现以理解行为，生产不 private import、fork 或 patch SDK。

参考：[Agents streaming](https://openai.github.io/openai-agents-js/guides/streaming/)、[Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)、[Pi releases](https://github.com/earendil-works/pi/releases)、[Better Auth security](https://www.better-auth.com/docs/reference/security)、[Bun install](https://bun.com/docs/pm/cli/install)。

## 风险、拒绝的伪修复与验收边界

- 开发生成链 `kysely-codegen → micromatch → braces@3.0.3` 有 HIGH [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)，官方没有 patched version，audit 非零仍保留。固定源码 pattern `{auth,product,execution}.*` 不是外部输入；表名只是匹配目标。最终实际打包的 server/worker 生产闭包均检查不含 codegen/braces；不编造 override/版本，不删除生成器隐瞒风险。
- dependency-cruiser 的 TS7 legacy-transpiler 提示不能据 exit0 忽略。实际配置公开选择 SWC；父级 graph 覆盖全部起始 115 个 app/package TS 加 4 新测试，149 modules/555 edges/113 type-only edges，零 violation；20 个真实负向 fixture 另验证跨应用、concrete harness/SDK、cycles、unresolved 与环境边界。最终合并源码再通过 151 modules/568 edges 和全部 20 项负向 fixture；不声称覆盖任意动态加载。
- 原 fixture 的固定 auth 用户不提供逐调用删除权威；裸 Redis setup/顺序 sibling cleanup 有可靠性风险。外层 dedicated launcher 最终销毁自己库，但不能盲改共享 seed helper 删除别人的用户。两项历史完整 integration 的 runtime 失败在 exact historical image 与多次 current/instrumented 全集重跑均未复现；原 15 秒 timeout 与 PEL counter2 记录仍保留，根因未证明，不称已修好。不提高 timeout、放宽 poison 断言或把“另一个 consumer reclaim”假设当事实。
- context 1 MiB canonical/3 MiB SQL 读取预算是逻辑材料限制，聚合仍 O(history)；decoded event/tool caps 不是 HTTP frame、token、RSS 或账单硬限额。
- root flock 只证明同一支持 storage host/path 的物理 owner；deadline、SQL terminal、abort、TTL、kill/pause ACK 不证明远端 paid jobs 停止/退款或 bytes 物理抹除。
- 上一轮真实 Pi→OpenAI→Pi→Pi receipt 只认证当时源码；本轮 body/join/corruption/migration/delivery 修复不得借用它。没有重新授权或重复调用付费模型/VM。fixture auth 不等于 OAuth，local Embed 不等于 Cloud/HA。
- 不认证对抗性历史指令优先级、跨 SDK 中断恢复、所有媒体/搜索/Skills 组合、node/volume loss、掉电恢复或 billing exactly-once。

## 最终合并源码验证与发布

所有 implementation writer 结束后，现存范围为 270 个项目文件；新增 10 项包括六份 native 回归、两份前向迁移、relay-index 回归及本文。七份删除责任另外审查。以下均使用自有源码副本、冻结依赖、精确版本，容器无 checkout/home/socket bind；数据库、部署 fixture 的 producer 与资源按精确 owner 清理，不 global prune。

| 合并源码门禁                                                       | 实际结果                                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VID_CHECK_IMAGE=… sh scripts/check.sh`                            | exit0；strict TypeScript、type-aware lint 零 warnings/errors、完整 Prettier、151-module boundaries；20 architecture / 530 unit / 33 script，零失败 |
| `VID_CHECK_IMAGE=… sh scripts/database-check.sh test`              | serial PG/Redis：430 pass / 0 fail，36 files / 2,593 assertions，包含 47 项完整 provenance 迁移回归                                                |
| `… database-check.sh verify`                                       | 真实迁移 + codegen + schema dump；15 tables，生成字节与现有产物一致                                                                                |
| `… check.sh run .github/verify-api.ts`                             | 公开 API 生成字节完全一致，exit0                                                                                                                   |
| pinned host Node24 `sh scripts/deployment-check.sh`                | 完整 production roles/build/storage/restart/shutdown/replay/auth gates exit0；6 个 Node、32 个 Bun 测试，零失败                                    |
| hash-locked `.github/python/check.sh` / checksum-pinned actionlint | 全 shipped Shell syntax/ShellCheck、strict YAML 和 Actions，exit0                                                                                  |
| 最终 shipped server/worker closure                                 | 不含 braces/kysely-codegen；不抹除开发 advisory                                                                                                    |
| LSP 与源码检查                                                     | 四份最终 native 变更无 primary LSP 错误；辅助 generic style hints 单独保留/处置，不冒充项目 lint 失败或强行抑制                                    |

最终 manifest、分区实际完整阅读与后续补审范围、原始 RED/GREEN、未解释历史失败、生成来源、source/staged secret signature scan 与 diff 检查保存在本地 `/tmp/milestone-review/`。该目录不是永久公开证据归档；签名扫描也不是所有秘密的不存在证明。Git 本身保留发布源码，后续删减必须是独立可审提交。

发布只 stage 已审查范围，不 force push；对应 exact head SHA 的 [Credentialless native checks](https://github.com/zihanyang-dev/video-agent-example/actions/workflows/ci.yaml) 必须观察到结论。旧 `39a1157` 的 CI 与此前真实模型 receipt 不是本次发布证明。提交 SHA、精确 CI run URL 与实际结论由发布回执给出，不把文档中的预期当已发生事实。
