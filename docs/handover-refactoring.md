# Handover 对照报告的复审与逐条重构记录

## 当前状态

这是实施记录，不替代原报告的冻结 BEFORE。原报告首次交付时的 AFTER 只做过语法检查，不能直接作为补丁。

- 89 项提案已逐项阅读；F001–F026 另做了独立实际源码、类型和调用者风险复核。
- 十四个已验收批次完成全部 **89 项**处置：**84 项已实施并验证，5 项经实际证据拒绝政策性 AFTER 或记录生成物约束，0 项待处理**。最新合并源码重新捕获并通过全部八条 owning gates；历史候选失败未冒充最终验收。另完成 Agent execution 目录整理、Pi remote tool 调查及用户授权的 retention 合并，不虚增报告编号。
- 原始基线：`01b1f17760a8fd12c7cb18ac4100ac6721d6c6bb`。本地验收阶段未提交或推送；随后用户追加授权提交、推送并检查 GitHub CI。远端结果独立核对，不以前述本地验收冒充。
- 用户自行调整的 `docs/*.html` 不读取、不修改、不放入验证镜像。历史迁移、API 生成物、DB 类型、lockfile 和 prompt 保持；唯一生成物例外是用户明确授权的 retention schema 合并，采用实际 native generator 输出，并新增独立迁移，不手改 schema、不重写旧迁移。

## 复审更正

1. **F008**：输入附件 cap 原本是私有常量。删除拟议公共 re-export，保留现有 output cap 导出；不能借提取常量新增公共 API。
2. **F011**：adapter 片段缺少 `ExecutionOutcome` type-only import。必须配合 F001 的合同归属、F031 的终态控制流，以及所有 typed fixtures 一起迁移；未知 COMMIT 和 SQL 锁内裁决不变。
3. **F016**：尾部 `AggregateError` 只覆盖未 aborted 的路径，不能声称 error-listener 导致 abort 的普通连接失败已保存全部 receipt。最终监督结果需要独立证据。
4. **F017**：正文的 `cancelRun` 与现有 DB import 冲突；采用 `requestRunCancellation`，不加旧名转发。
5. **F051**：实际 TypeScript 7 编译证实原 AFTER 对 readonly `assets`、`sources` 赋值会报 `TS2540`。改为具名白名单和可选字段的独立投影，不用可写映射类型或 cast 绕过合同。
6. **F060**：实际建议是 SDK components/schemas 的私有 indexed type 别名，不是函数参数或 `SDKDocument` 改名。
7. **F048**：把准入和累计强塞进一个 loop 会触发既有 complexity/depth gate；保留原逐文件准入，改为一次具名预算累计，不新增 helper 或放宽规则。原 AFTER 不直接落地。
8. **F058**：五个 `&&` 使 SQL replay owner 的 complexity 升为 13；采用五条 eager 布尔事实的平铺 checklist，没有匿名 tuple，也不加额外类型/函数层。

F009、F013、F015、F019、F021–F024、F026 涉及不同程度的可观察合同或政策变化，不能标成纯美化。实施前逐项核对实际边界、兼容性和回归证据，不因为报告写了 AFTER 就默认批准收紧。尤其不能无证据改变已领取 publication batch、外部 S3-compatible bucket 的准入或管理员原因可见性。

## 第一批实施

- **F027**：生成树递归用直接循环归并；二进制 base64、相对路径和精确 artifact 比较保留。CI 使用官方 `bun` 模块的 `spawn`；已确认与 `Bun.spawn` 是同一函数。
- **F033**：非图片 import 提前返回；图片 1 MiB 准入仍在 base64 分配前，全部结果文本与字段保留。
- **F034**：只删除 private-history 子进程模板里的未使用 type import，并对齐实际入口 import。
- **F037–F040**：搜索实体解码、净化、codepoint 截断、bytes → text → JSON 分段；认证 headers 显式互斥；四项独立预算命名但不改值或消费时机。新增混合实体/标签/控制字符与 astral 边界的行为 characterization。
- **F060**：把官方 SDK 的嵌套 indexed 类型移到 generator 内私有别名；生成字节未变。
- **F089**：现有 compiler 和 type-aware lint 覆盖 `.github`。新增真实 compiler/lint 负例，修复前两项均因错误文件被忽略而失败；修复后通过。fixture 使用自己新建的临时目录，主动 kill/join 尚未退出的 child，并收齐已发出的两路 pipe 读取后才删除目录。

## 第二批实施

- **F001**：12 个共享执行能力定义移到实际消费的 `apps/agent/src/execution-contract.ts`；完整迁移 18 个类型消费者，包括 `.ts` 后缀和混合 import。运行时 `executeRun` 保留原入口，没有旧入口 re-export 或转发 barrel。
- **F011**：只在 `bindExecutionWrites` 的私有 adapter 中把 SQL boolean 回执翻译成 `ExecutionOutcome`。原 SQL 函数、锁、fence、post-lock 时钟及 raw API 保留；SQL 选择的 `cancelled`、`failed` 不被请求动作覆盖。全部 typed fixtures 同步迁移，save/append 的 boolean 不变。
- **F012**：quarantine 的 lease 从当前 execution owner 取得，去掉第二份身份参数；终态失败与 quarantine 失败仍按原顺序聚合，不重试未知 COMMIT。
- **F031**：终态使用直接返回；完成 helper 在真正写入之前证明 product，不用 `!`。独立复核发现初稿把缺失 product 的内部断言归入终态 SQL 日志，现已修正：离线实际函数差分确认同一异常、0 次写入、0 条终态诊断；随后重新构建并跑全部正式验收。

新增 9 个真实 SQL adapter 用例：3 个终态动作 × accepted/stale fence，以及 3 个 SQL 覆盖裁决 characterization。实施前的修正后 red 为 **20 pass / 6 fail**，六个失败均是 `true/false` 与明确 outcome 不符。初次 red 的三处 history 初始值误判（实际为 `[]`，非 null）已在实施前更正，原日志保留。

第二批**最终修订快照**的四条正式命令全部 exit 0：架构 **10 pass**、单元 **366 pass**；六个 credentialless script 文件 **13 pass**；API 实际生成精确一致；DB 生成一致且集成 **297 pass**，均 0 fail。新 contract 文件显式进入 snapshot；28 个变更文件与当前源码 SHA 一致；21 个 immutable 文件未变；owned runner containers/networks 为 0。初稿误用无 fixture 的 launcher 执行 deployment-native 测试，10 个连接/bucket 缺失失败保留；这不是部署验收，最终正确运行的是下述无凭据六文件集合。

主动 LSP 21 文件探测和随后 2 文件复探仍报告 4 个旧模块 union 类型的 stale 错误；当前源码已经没有该旧导出，fresh native compiler/type-aware lint 和独立 host strict compiler 均 exit 0。记录此工具差异，不 suppress、不放宽规则、不声称 LSP 全绿。

## 第三批实施

- **F003、F014**：Pi 三个本地政策分别命名（16 轮、2 MiB decoded delta、10 秒 cleanup wait），数值、严格 `>` 边界与 cleanup 生命周期不变。工具 allowlist 从同一组受信 definitions 派生；不引入 host discovery、工具注册框架或新工具。
- **F035、F036**：资产 prompt 的三字段 public projection 独立成段，顺序与实际文本保持；canonical finalText 独立命名，但仍在既有 history admission **之后**计算，保留拒绝/分配顺序与空白。
- **F004**：六个 inbound 名字用 owner 私有 literal tuple，公共名字类型由实际 output keys 与 Input mirrors 派生。只新增 type export，不导出无消费者 tuple；server 的 JSON reference 接受这个类型。新增回归编译实际 route 模块的 owned clone，只注入一个 misspelled reference，不在测试中复制 production union。
- **F007、F008**：两个进程复用原 polling schema，default/coercion/max 与 lease refine 不变；两个 input 合同共用私有 16 cap，没有公共 input re-export，output 32 和 legacy 语义保持。
- **F009**：只提取既有 HTTP text primitive，regex/error/HTTP 长度和 trim 行为不变；执行 start/completion/delta 仍保持原准入，不采用被真实 SDK 分片反例否定的收紧。
- **F010**：内部 cancel handler 使用原本已导出的 `CancelCommand`；现有 discriminant caller 与 SQL 事务正文不变，不重复定义 Extract union。

正式 native red 为 **4 pass / 1 fail**：项目 compiler 对实际 route clone 中拼错的 schema 名字错误地 exit 0，而不是 import/bootstrap 故障。初次 host fixture 放在 `.github` 导致 app-scoped Hono 无法解析；在生产实施前改为 owned `apps/server` 目录、保留真实 relative resolution，修正后的 host/native red 均是同一个接受缺陷。所有日志保留。新增 combined tools/public metadata/answer whitespace 与两进程 polling characterization 在实施前连同五个原 suite **140 pass**。

第三批同一份**最终源码快照**的正式检查：架构 **10 pass**，单元 **368 pass**；六个 script 文件 **14 pass**；API 生成精确一致；DB 生成一致且集成 **297 pass**，均 0 fail。36 个变更文件 SHA 与当前源码一致，新 contract/两个 primitive 显式捕获；21 个 immutable 文件未变；owned containers/networks 为 0。独立复核没有 actionable findings，完成 15 个静态 invariant groups；静态复核不替代父端实际 native 验收。

主动 LSP 11 文件复探无错误，9 个 confirmed clean、2 个 push-only inconclusive；先前 stale missing-name 错误在实际 compiler/negative gate 通过后仅作 session false-positive 记录，没有写源码 ignore，也不声称 workspace 全部 LSP-clean。

## 第四批实施

- **F002、F030、F032**：stop 的纯优先级规则与同步清空/abort 副作用分开，保留 lost 的早退；诊断分类移入函数体并保持按需默认，不读取 rejected cause；工具调用用 `read-only` / `mutative` 代替位置 boolean，只有 read 是 read-only，quarantine/拒绝原因身份保持。
- **F029**：执行器 fixture 的手写 latch 复用项目已采用的 `Promise.withResolvers`。没有新增 production capability 或测试专用生命周期方法。
- **F041、F042**：执行 options 命名，但仍在每次 claim 后、原有 supervision try 内构造；拒绝原 AFTER 提升并冻结后续 timeout 的写法。两个完全相同的 waitForPoll 移到 agent 内共享模块，timer clear、listener remove、once 与 already-aborted 顺序逐字保持；不跨应用抽象。
- **F043、F044、F046、F047**：imports 按 native/external、shared、local 分段；三个赋值字段显式写出，保留原两个 capability 的 readonly；连接 options 的重复交集有 owner 私有名字；健康状态用 failed > stopping > ready > starting 的提前返回，资源构造/连接/关闭正文不动。
- **F045**：用仅对 undefined 生效的惰性 destructuring default，拒绝原 `??` 的 null fallback；harness default 的 await 顺序和 storage OR 保持。现有实际 callers 都提供稳定 capability 字段，不引入 discovery，也不声称与不稳定 getter/proxy 的任意读取 ABI 等价。

新增 characterization 先于生产改动：空 claim 遇 shutdown 不等 polling、两个连续 run 的当前 deadline、未连接 client 不能仅因 markReady 就 ready、失败不能被 stopping 掩盖。三个相关文件实施前后均 **62 pass / 0 fail / 319 assertions**；这是行为保持 refactor，不伪造 baseline red。独立实际函数差分 **20 stop / 32 health / 8 diagnosis** 全部一致，并证明两个原 polling body 与提取 body 相同；这些是 pure local/static 证明，不冒充 native durability。

第四批**最终修订快照**四条正式命令均 exit 0：strict compiler、type-aware lint、格式和边界通过；架构 **10 pass**、单元 **372 pass**、脚本 **14 pass**；API/DB 生成一致；集成 **297 pass**，均 0 fail。38 个变更文件与验收时 checkout SHA 一致，4 个新模块显式捕获，21 个 immutable 文件保持；owned containers/networks 为 0。新增失败测试的 async style 在初次 capture 后改为 try/catch，最终镜像重新捕获，不使用旧 image 认证新源码。

主动 LSP 7 个 touched 文件全部 confirmed clean、0 error diagnostics；不把既有辅助质量意见说成零。独立复核没有 actionable reachable findings，明确了范围：动态 accessor/proxy 不在实际调用者合同内；测试 watchdog 限制 observation 而不单独限制一个假设永不收尾的 finally join，外层正式 runner 仍有截止。这里不声称 F067 等后续测试所有权提案已经解决。

## 第五批：Agent execution owner 与 F068

用户补充指出 agent 已经散乱，需要把投递、持久化、可恢复执行路径重新组织。实际阅读和独立复核确认这一组已有完整内聚的责任，因此收进 `apps/agent/src/execution/`，不是恢复 application/infrastructure/transport 多层框架。

| 原位置（相对于 agent/src）                                          | 当前位置                                |
| ------------------------------------------------------------------- | --------------------------------------- |
| `execution-contract.ts`                                             | `execution/contract.ts`                 |
| `commands.ts`、`events.ts`                                          | `execution/` 内同名文件                 |
| `run-loop.ts`、`execute-run.ts`、`wait-for-poll.ts`                 | `execution/` 内同名文件                 |
| commands、execute-run、execute-run.sources、run-loop 的四个相邻测试 | 与新 owner 相邻的 `execution/*.test.ts` |
| `db/` 的五个执行 SQL 模块                                           | `execution/db/` 内同名文件              |

总计 **15 个文件**移动；**63 个静态 import** 和 **1 个动态 import** 修正，保留 Pi 的 `.ts` 后缀。所有消费者直接指向实际模块，旧文件/空 db 目录移除，无 compatibility re-export、barrel、额外调度层。`main/worker/worker-health` 保留进程资源所有权，harness/sandbox 保留 SDK 行为；prompt 不动。目录说明更新到 [directory-structure.md](directory-structure.md)。

独立最终 diff 复核证明，归一化路径后只有 F068 测试和目录文档变化：SQL 锁、post-lock 时钟、inbox→ACK、fenced 终态/outbox、未知 VM/COMMIT 隔离正文不变。原报告 BEFORE/旧文件路径属于冻结基线；不把历史示例重写成新源码，当前定位使用上表和 `/tmp/handover-refactor-layout-moves.json`。此前 F001 的合同现在位于 `execution/contract.ts`。

**F068** 新测试使用真实 WorkerProcess 与未发起请求的 native owners，blocked owned task 在释放前阻止 object close，释放后要求 literal task-finished → objects-closed 顺序；finally 无条件释放 gate 并 join。owned 副本中仅删掉 `await Promise.all(this.tasks)` 的 mutation **0 pass / 1 fail**，准确暴露 premature object-close；真实 checkout 没有被临时改坏。正常实现 characterization 通过，随后新镜像单元 suite **373 pass**。不把该对照冒充外部存储/部署持久性。

第五批同一份最终快照的四条正式命令均 exit 0：strict compiler、type-aware lint、格式、边界通过；架构 **10 pass**、单元 **373 pass**、脚本 **14 pass**、原生集成 **297 pass**，API/DB 生成一致，均 0 fail。50 个变更文件与当前验收源码 SHA 一致，15 个 relocation 验证完整，21 个 immutable 文件未变，owned containers/networks 为 0。正式镜像显式捕获全部新路径，不漏掉 untracked moved modules。

保留了工具差异与失败：LSP rename preview 拒绝 encoded dependency 越界 edit，未 apply 或绕过，改用已核对的 move map；初次探索漏掉 history admission 的动态 import，实际 LSP 定位后在最终快照前修正；directory-as-path probe 被拒后改显式 file batch。主动 LSP 35 文件可见 0 错误，但 **1 处 stale pending/any 错误经 session false-positive 隐藏，不是该处 clean 证明**；host 与最终 native strict compiler 均 0，无源码 ignore、不改正确控制流迎合缓存。既有 TS7 dependency-cruiser warning 保留。

## 第六批：Server 公开投影、预算与 replay 形状

- **F048**：原逐文件 schema、完整 namespace/assetID、legacy 16 MiB/current 配置上限准入保持；只用具名 currentFiles/currentBytes 一次累计，取代 filter/reduce。legacy 仍不消耗 current aggregate/count，全部输出仍受 32 项 protocol bound；不改预算政策。
- **F049、F050**：下载的 RFC5987 编码/完整 disposition 独立命名；SSE 最后一帧的 cursor metadata、encoder 和 id framing 分段。六个下载 headers、验证/catch、empty frames、final-frame-only cursor 与重连协议保持，不混入 F022 的 Unicode 收紧。
- **F051**：required completion 与 optional 白名单是两个不可变投影，最后返回 fresh object；不向 readonly 字段赋值，不用 cast。保留 undefined 省略、显式空数组、源列表严格 parser、私有 envelope 排除和原始文本。
- **F052、F053**：message 维度先命名再生成 frame identity；同 fact 的非 message frame 保留空 suffix。两个失败摘要共用 recovery sentence，三个实际公开 message 和 reason code 逐字保持，不暴露私有 cause。
- **F054–F057**：先 completed、后 cancelled 两段 outcome loop，保留覆盖/插入顺序；只有两段 SQL whitespace 改动，active status 明确 stopping > running > accepted；非完成写入早退，实际 assistant insert→conflict→assets 顺序和 transaction 位置保持。
- **F058、F059**：五条 replay identity 改成 eager 布尔 checklist；upload 与 generated 保留位置明确分支。保留原 header/text/asset-order 证明、materials/artifacts 兼容、精确 namespace 与代数，不 repair retained evidence，不移动锁内授权或接受回执。

新增三个 meaningful characterization 先于生产改动，覆盖 absent/显式空 optional、frozen receipt、message 维度身份；三文件实施前、初稿后、最终修订后均 **23 pass / 0 fail / 92 assertions**。生产行为没有新缺陷声明，不伪造 red。预改动 batch5 原生 DB snapshot 也重新运行 **297 pass**，只作为旧版本边界证明。

独立十文件复核无 actionable findings，第一份实际函数差分 **1,943 checks**；F048 修订后再做独立补审和 **1,945 checks**，均 0 failures。原逐文件 admission block 与 batch5 byte-identical；其余九个首次复核 hash 保持，最终 hash 全部匹配。两个 check 计数来自不同范围的运行，不累加成独立 case 总量；这些是 bounded pure-local/static 证明，不冒充 native durability 或任意 getters/proxies 等价。

**初次正式镜像 core exit 1**：native oxlint 把 optional chain 也计入 complexity 11，虽 active LSP 曾显示 clean。失败镜像/log 保留；不禁用规则、不以 LSP green 覆盖 native 失败。最终保留原 `.every` 准入阶段和单次累计，重新捕获并重跑四条完整命令。

第六批**最终修订快照**四条正式命令均 exit 0：strict compiler、type-aware lint（0 warnings/errors）、格式和边界通过；架构 **10 pass**、单元 **376 pass**、脚本 **14 pass**、原生集成 **297 pass**，API/DB 实际生成一致，均 0 fail。60 个变更源码/目录文件与最终 snapshot SHA 一致，10 个最终审查 hash 匹配，21 个 immutable 文件保持，owned containers/networks 为 0。没有用初稿的 DB green 认证后续修订。

主动 LSP 检查十个文件，0 primary error，31 条 auxiliary warnings 另记：既有 Bundler imports、return-await/private diagnostic 规则意见、`!==` 被误识别为 nonnull、UUID SQL row 派生 regex 的 generic taint。F048 最终复探 0 diagnostics；不宣称 workspace 或所有辅助规则全绿。既有 worker-health stale pending/any session false-positive 仍有 1 隐藏 finding，fresh host/native strict compiler 0，不对正确源码加 ignore。既有 dependency-cruiser TS7 warning 保留。

## 第七批：授权、双取消、native identity 与确认参数

- **F005**：原路由的 prebody transaction/lock 原样移到 uploadAsset owner，仍先于 metadata/body collection；reservation/completion 各自的锁内重授权保持，不延长原 transaction。
- **F013**：execute/read/write/import/export 每次调用合并 owner 与 SDK signals，不再用 `sdkSignal ?? signal` 丢掉后续 owner abort。SDK 已取消时仍在 capability 前拒绝，reason 与 issued IO settlement 保持。
- **F015**：实际 session constructor 冻结两个 string 字段组成的 nativeRef，返回同一个 object。证明值不能在 durable persistence 前被改写；不声称任意 untyped consumer 不能替换整个 session 属性。
- **F017**：更名为 requestRunCancellation，直接 import/caller 同步，没有兼容转发、wire operationID 或协议变化。
- **F018**：completeAsset 的 storage confirmation 是具名 readonly object，全部四处调用同步；SQL transaction、最终锁内授权、first-ready-wins/key/ready_at/replay 保持。
- **F024**：generate/verify 的 trailing args 在 fixture 分配前明确 exit 2；test/check 的 forwarding 不改。

实际 red：CLI 两项均收到 fake mktemp 的 71，而不是 2，说明已进入分配；ongoing owner abort 在独立 SDK signal 存在时未传给 import。修复前三项 **10 pass / 3 fail**。nativeRef 使用官方 E2B + owned loopback HTTP、没有 VM/Cloud，mutation 原先不抛异常且改变 ID，**0 pass / 1 fail**；冻结后通过。最终四文件 focused **70 pass / 365 assertions**。F005/F017/F018 是行为保持 refactor，不把先前通过当 defect red。

七批最终修订快照的四条正式检查均 exit 0：strict compiler、native type-aware lint 0 warnings/errors、format/boundaries；架构 **10 pass**、单元 **379 pass**、脚本 **16 pass**、真实集成 **297 pass**，API/DB 生成一致。扩展实际 shipped Compose 部署检查也 exit 0：存储 **17 pass**（包括 concurrent legacy/rehome first publication）、角色/密码轮换/原生重应用 checks 和 same-origin Caddy HTTP probe 通过；worker/server 关闭 exit 0。没有模型/VM调用，HTTP probe 不恢复暂停的 UI 设计工作。

扩展部署前两次失败是独占 remote Docker 的 frozen policy 文件未投递，并非产品功能 red。最小原生重现定位到 server-policy；实际 Compose canonical source 是 `/private/tmp`，不是 host `/tmp` alias。只向精确 owned VM snapshot 目录投递两份冻结 policy JSON，0444/同 SHA，维持原只读 policy mount和原部署命令；没有 checkout/home/credential/socket mount，没有改 VM sharing/default/profile config 或生产初始化逻辑。失败日志、非 canonical 投递与最后 canonical 成功均保留。最终无 owned containers/networks；两份尚未单独归因的 anonymous volumes 留在独占 profile，不做 blind prune，也不声称所有 volumes 为零。

14 文件独立复核首次发现 Pi SDK write 接入的 P1；撤回后补审确认其余 12 文件 hash 不变、两个修订文件对应最终 snapshot，无新 actionable findings。主动 LSP 13 文件可见 0 error，但三处 completeAsset 旧四参数缓存诊断经 session false-positive 隐藏，**不是这三处 clean**；实际三参数 source、host/native strict compiler 与真正 storage caller 都通过，无 inline ignore 或源码 workaround。TS7 dependency-cruiser warning 保留。

### 用户追加的 Pi remote tool 调查

应用 pinned **1.0.1** 与 host **1.0.4** 区分。公共 remote operations APIs 确实存在，但原生 read 在 adapter 前探测 host path；write/edit 的 mutation queue 也先调用 **host realpath**，且队列为 module-global；bash 截断输出写 host temp。初步建议只换 write 不完整，实际接入、独立复核和回归已纠正。

owned self-symlink + loopback Pi/assigned memory guest 的最终回归证明：候选 SDK write 因 host ELOOP 没有写入 guest（**0 pass / 1 fail**）；恢复原 assigned-only 定义后同例通过。没有把 private provider cause 当公开输出，测试只创建/删除自己的临时目录。早期同路径 native queue red/green 不能证明无 host IO，那个实验已替换为最终边界回归，日志仍保留。

因此撤回 SDK write factories，保留薄的 assigned read/write/execute 和已修正的双取消；不造 queue、file RPC/framework，不 private import、vendor patch、SDK upgrade 或 lock 改动。import/export 仍是授权/digest/预算/publication capability，不是普通 file tools。调查与候选验证已完成，**没有宣称安全迁移已完成**；支持 remote operations 不等于支持当前 zero-host-probe/allocated-session 边界。完整裁决见 `/tmp/handover-refactor-pi-remote-disposition.md`。

## 第八批：测试叙事与独立 oracle

- **F061、F063**：关系完整性矩阵改为具名对象；四种 indexed corruption 使用明确 switch。SQL、constraint、原始身份来源及 UUID 分配时机不变。
- **F064、F065、F066**：四条 credential rotation sed clause 分行；停止进程的 diagnostic 只读一次；本地工具模型只保留 requestCount，仍读取实际请求/实际 readResult，tool 存在决定 framing。原隐私、loader 与 downloadable bytes 断言保留。
- **F069、F071**：HTTP metadata 同时核对全部九种 MIME 和 required Content-Type enum；native/foreign validator 各自对照 literal validity，使用真正含字母的 UUID 和 malformed control，不以两者相等代替正确性。
- **F074、F078、F081**：迁移先要求恰好各一条 outbox/inbox，再核对 raw command 和实际 parser；inbox canonical oracle 使用独立 literal、先比较原始 JSON；SSE 先证明 START/CONTENT 都存在，再证明顺序。

独立十文件静态复核无 actionable findings，hash 与最终 snapshot 一致，不代替运行验收。独立 extracted-oracle proof 的 **44 次执行**都符合预期：缺失/额外 MIME、两个 validators 同时错误、raw UUID 被 parser 掩盖和缺失 START 的反例均能区分旧/新 oracle。运行器为 Node/SWC 与 assert/strict adapter，因 offline Bun resolution 的 ENOTCACHED 使用此 fallback；这些不是 44 个 Bun 测试，也不是 native SQL/SSE durability。父端核对 extraction/hash 并重放证明。

F074 另用 owned source copies、真实 dbmate/native PostgreSQL 做 source-loss mutation：仅在 upgrade 后删除 temporary inbox，旧两个测试仍通过，新两个测试都在缺少 inbox 处失败（**2 pass / 2 fail，预期 exit 1**）。正常 migration suite 在正式快照通过。该 mutation 只证明丢失一份来源的检测，不声称覆盖全部删除/字段变异；历史迁移和 checkout 未修改。首次 launcher 缺少第二个 test 参数的失败保留，不作为证明。

第八批最终快照六条 owning gates 均 exit 0：strict compiler、type-aware lint 0 warnings/errors、format/boundaries；架构 **10 pass**、单元 **379 pass**、六文件脚本 **16 pass**、真实集成 **297 pass**，API/DB 精确生成一致；shipped Compose 存储 **17 pass**，另有 2/2/10/1 组角色、轮换、重应用与 Caddy HTTP checks；production-runtime 的 server/worker frozen image native CMD **2 pass**。hash-pinned Python tools 下 `.github/python/check.sh` 也 exit 0，包含 shell/YAML gate。十个 touched-path 主动 LSP 0 diagnostics；不将其他批次隐藏 stale finding 称为 clean。既有 TS7 dependency-cruiser warning 保留。

72 个 captured 文件与当前源码一致，21 个 immutable 文件未变。无 owned containers/custom networks；独占 profile 内现有 **4 个 anonymous volumes**未单独归因，不 blind prune、不称零 volumes。仅两份冻结 policy JSON 0444/同 SHA 投递到精确 canonical VM snapshot path，未开放 host sharing。没有付费模型、VM、未知 sandbox 或浏览器/UI 验证。

## 第九批：本地验收入口与 fixture 收尾

- **F067**：BudgetScenario 只保留四个实际调用场景，write 成为明确分支；移除未使用的 batch/writes/command/path 叙事，不新增 production admission 政策。四个实际 loopback budget 测试保留原请求次数、拒绝与零 write 断言。
- **F070**：默认 test 先跑 apps/packages，再调用显式六文件 test:scripts；CI 删除唯一重复列表，Python/API/native 分区保持。真实 script expansion 的 process-boundary recorder 证明六文件发起一次、下游 exit 7 向上传递；这不是 recorder 所替代测试的运行证明。正式 core 确实通过共同入口运行六文件 16 pass；额外 alias gate 再验入口，不累加为独立用例。
- **F075**：复用 settleTestCleanup，按原 command_outbox→messages→threads→close 顺序和原 threadIDs filters 尝试全部清理，空 ledger 只 close。实际 afterAll body 的 native PG fault proof 只将第一个 table name 改为不存在的表：旧两例留下真实 message 而失败，新两例删除后续 message/thread、native driver 已 destroyed，并保留 42P01；close 后额外抛 undefined 的一例也保留该 cleanup cause。**2 pass / 2 fail，预期 exit 1**。没有虚称 afterAll 知道 test-runner 的 primary，也不把注入的 undefined 称为 native destroy 故障。
- **F076**：原 abort listener 注册后检查已取消状态。实际源码 block + native already-aborted AbortSignal 的对照原先未 resolve，修订后 resolve；证明只涉及 fixture waiter，不冒充远程 cleanup durability。
- **F083**：先消费实际 HTTP body，再要求 200、用公开 schema 验 actual，只有 exact assistant text 才结束。真实 loopback 的 user-only/错误 assistant/正确 assistant 序列及 401/500 canary controls 原先 **0 pass / 3 fail**，最终 **3 pass / 9 assertions**；保留原 raw body 返回与私有内容检查。新测试 initial await-thenable lint 意见已按同仓库的显式 rejection receipt 改正，重新捕获/完整验收，不加 ignore。

第九批最终快照六条 owning gates 全部 exit 0：compiler、type-aware lint 0 warnings/errors、format/boundaries；架构 **10 pass**、单元 **379 pass**、共同入口脚本 **16 pass**、原生集成 **300 pass**，API/DB 生成精确一致；扩展 Compose 的存储 **17 pass**与 2/2/10/1 组 native checks，production-runtime **2 pass**。hash-pinned shell/YAML gate exit 0；六个 touched-path 主动 LSP 0 diagnostics。独立六文件复核无 blocking findings，全部 hash 对应最终 snapshot。

74 个 captured 文件/21 个 immutable SHA 核对一致；无 owned containers/custom networks。独占 profile 的 **6 个 anonymous volumes**保留、未单独归因，不 blind prune。两份 policy 仍只投递到本次 canonical snapshot path；没有 host sharing、付费模型/VM或浏览器/UI 验证。TS7 dependency-cruiser warning 保留。其余 fixture 的 setup/child/barrier/deadline 项目继续按各自编号处理，不被这一批覆盖。

## 第十批：连接 receipt 与 restart status provenance

- **F016**：两条连接 allSettled 后按 status 收齐 rejection reasons，包括 undefined。未 aborted 时抛 ordered AggregateError；已 aborted 时先把全部 receipt 加入当前 owner failures，再抛原获胜 abort reason。保留任务 drain/cleanup 时机，不 retry、dedup 或读 private cause。listener 的失败与 connect receipt 可以重复出现，不声称唯一原因集。
- **F026**：restart outer cleanup 先保存原 status，以独立 failed 记录 SSH/rm 故障；只在原成功时转换为 cleanup failure，原非零或 signal status 不被覆盖，并给出固定 cleanup-incomplete 诊断。remote CLEAN heredoc 与其余 restart workflow byte-identical，unknown seed dispatch/label authority/metadata 清理保持。

实际 WorkerProcess 的 public connect/done/stop 回归，用 instance-native connect methods 的 test-only fault overrides 精确控制两条 issued IO。原 **4 pass / 4 fail**：普通双拒绝丢第二个原因，listener/外部 abort 路径丢 receipt，undefined 也丢失；修订后全部通过，reader gate 释放前 owner 不完成清理。aborted tests 核对 membership，不把它们说成 exact order/multiplicity 的 runtime 证明；顺序和不 dedup 另由源码复核确认。

restart 回归执行实际 cleanup/traps 的 /bin/sh fixture，SSH stub 消费但不执行 remote heredoc；40 个 primary/attempted/独立 cleanup 组合与三种真实前台 self-signal。原 **0 pass / 4 fail**，真实 2/129/130/143 均被覆盖成 1；修订后通过。新 fixture 初稿四层 loop 的 depth lint 意见通过具名八种 cleanup cases 降为两层，不放宽 gate。测试加入既有 test:scripts 的第七个显式文件，不用 glob，不重复 CI 入口。

focused **12 pass / 256 assertions**。第十批最终六条 owning gates 均 exit 0：compiler/native lint 0 warnings/errors、format/boundaries；架构 **10 pass**、单元 **383 pass**、七文件脚本 **20 pass**、原生集成 **300 pass**；API/DB 生成一致；扩展存储 **17 pass**和 2/2/10/1 组 native checks，production-runtime **2 pass**。hash-pinned shell/YAML gate exit 0。五文件独立复核无 reachable production regression，hash 对应最终 capture。

76 个 captured 文件/21 个 immutable hash 保持，无 owned containers/custom networks；独占 profile 中 **8 个 anonymous volumes**未单独归因，保留、不 blind prune。LSP 五文件 0 primary errors，worker 的 15 个既有辅助 hints/warnings（Bundler extensions/return-await/unknown/class shape）保留，不称全面 clean。TS7 dependency-cruiser warning 保留。未执行真实 Embed restart、SSH/VM或 paid provider，不碰 unknown sandbox/caches；本批只认证明示的 supervisor/outer-shell 边界。

## 第十一批：fixture framing 与独立 PUT oracle

- **F062**：仅将三个 test model 的完整 caller envelopes 串成 SSE Response、固定 content-type 和唯一尾部 DONE。caller 保留各自 id/object/model、答案队列、tools/reasoning/private canaries 和 request inspection；新增冻结输入与独立 literal wire characterization，不新增模型 policy。
- **F072**：真实 pinned S3Client/Bun loopback 发送 3 个 literal binary bytes，独立 literal digest 核对 return 和 metadata、实际 decoded wire、method/key/MIME/If-None-Match。503 SlowDown 与完整 settled requests 测试拒绝重试；**PUT 的 Readable body 在 pinned SDK 本身 non-retryable**，因此增加无 streaming request body 的 GET503 才验证 client maxAttempts。新 fixture 无论 setup/assertion 如何失败都独立尝试并等待两项 cleanup，以数组保留 primary/cleanup 和 undefined。原 GET test 的既有 sequential cleanup 限制未在本批修复，不称全文件所有 failure paths 均已覆盖。
- **F088**：uploadedAsset 只建立初始可用状态；上传 exact replay/conflict 移入现有具名 real-bytes test，完整 raw replay privacy 在 parser 前检查并消费 conflict body。message/completion 的全部原有 retry、digest conflict、snapshot link/privacy、download、foreign/logout 断言保持。不把未迁出的其他 helper 断言或 partial identity cleanup 说成已全面简化。

focused **4 pass / 29 assertions**。F072 复制完整当前 source/test、只 normalize public SDK import location 后作实际 native loopback mutation：control **1 pass**；maxAttempts2、去 conditional PUT、错误 metadata、return/header 联合错误 digest、错误 binary bytes 各 **1 fail**。maxAttempts2 确实由 GET 触发 4 而非 3 requests，不用 abort 提前掩盖 retry；仅 client/wire 证明，不替代真实 S3 durability。

第十一批最终六 owning gates exit 0：架构 **10**、单元 **384**、七文件脚本 **20**、原生集成 **301**，扩展存储 **17**及 2/2/10/1 checks，production-runtime **2**；compiler/lint/format/boundaries、API/DB equality、hash-pinned shell/YAML 通过。七文件独立静态复核无 introduced actionable finding，current/source/review hashes 对应。79 captured /21 immutable；新 depth3 lint 意见已通过移出 finally 的顺序 cleanup receipt 修正，没有 ignore；一次错误 tsgo launcher exit127 保留，随后使用项目实际 tsc 重跑。fresh 七路径 LSP probe 无新 finding，不抹除历史 suppressed 位置。无 owned container/custom network；10 anonymous volumes 保留、不 blind prune。未使用 paid provider/VM/unknownsandbox/browser/UI。

## 第十二批：PG/Redis/identity fixture 的 issued-work ownership

- **F077**：真实 fence-loss test 的所有 stale checks 进入 owner catch；无论检查如何失败都释放 end/closed、等待原 run，保留 primary 与 run rejection/undefined，再继续成功路径 lost/history/no-terminal/限定 reaper 断言。issued run 立即附 rejection observer，不用替代 resolved promise。
- **F079**：proxy 的临时 error/listening listeners 在成功、native bind error、sync listen throw 都移除；address 验证位于 setup owner，失败关闭 owned listener/sockets，并保留 primary+cleanup。test-only port 参数让实际 occupied bind 可确定重现，不改变默认 ephemeral bind 或生产接口。
- **F080**：两条真实 Redis connect 先注册 error observers，以 allSettled 收齐；1s native-handshake deadline 的 destroy 是 **active abort**，随后等待全部 connect receipts，再 final teardown，不把取消说成先完成后关闭。failed setup 不发 DEL；两个 native client cleanup 独立尝试。silent local native RESP handshake 测试用25ms deadline，500ms proof-only watchdog 防止坏代码泄漏；不是 native服务整体 availability 证明，也不声称修复所有未触及 SQL/transport fixtures。
- **F082**：signed identity rejection 包在当前短 pool owner 中，关闭后 rethrow原 cause，close rejection 单独 aggregate（包括 undefined）；正常 close 仍在 HTTP submission 前。
- **F084**：test-only官方身份 fixture 在 save 前登记 exact planned user ID；suite cleanup ledger 覆盖2个初始身份和3个 session 场景。初始第二身份失败也清理第一身份再 close。真实 PG check constraint 令 official session login 失败，确认已保存 user 仍在账本；临时 constraint 独立移除。afterAll 删除6个 exact IDs 后查询 user/session 均为空，再close，实证cascade而非假定；不声称 afterAll 能获得 test runner primary。
- **F085**：原 writer 一发出即观察 rejection并登记；无论1或3个 writer 后的 observation、blocker 如何失败，都释放barrier、等待blocker及所有原writers，收齐原因再做成功断言，不去重或伪造成功。barrier setup 观察原transaction失败；等待改用monotonic期限，保留实际PG lock。

独立审查9文件无 blocking finding。**actual AST-extracted**旧/新 gate callbacks 的纯Node proof，10个旧预期失败/10个新通过，parent replay并核对source/extraction hashes；仅 in-memory lifecycle oracle，不冒充nativePG/auth。Native Bun/node:net/Redis loopback另有2个control pass：旧proxy只增加forced-port test输入、保持旧handler，确实EADDRINUSE fail；Redis fail-fast与禁用deadline各fail；不把SDKdestroy实现改成测试替身。

最终六owning gates exit0：架构10、单元384、七文件脚本20、原生集成 **304**；扩展存储17及2/2/10/1checks，production-runtime2，compiler/lint/format/boundaries/API/DB equality与hash-pinned shell/YAML通过。86 captured/21 immutable，9-path fresh LSP无新诊断，历史suppressed位置不因此变clean。proxy初稿depth3与新Redisprobe的generic ReturnType/complexity意见已通过直接SDK类型/具名peers/明确cleanup修正，不放宽lint。0owned containers/custom networks，12anonymous volumes保留待exact-profile清理；无paid/unknownsandbox/UI journeys。

## 第十三批：child/HTTP/Docker/probe 的明确 owner

**已在最终合并源码上验收并登记四项。** 以下过程中的历史 gates 只验证指定 frozen snapshot。此前发现四个运行源码的并发 outbox retention 修改，登记脚本在写 evidence/ledger 前因 hash 不一致失败。用户现已明确授权合并：保留其 pending index、配置和 owner 接线，修复显式默认值准入、active ordinal 与批量清理边界，并以新源重新 capture/gates；不把旧 snapshot 绿灯当作合并后验收。并发记录：`/tmp/handover-refactor-concurrent-source-drift.json`。

- **F025**：allocated sandbox 的 owner 从 Bun probe setup 前开始；setup、body、control kill、probe stop、sandbox close 均不掩盖 earlier cause，独立 cleanup 收齐 undefined。opt-in local Embed admission 与 runID metadata/correlation 原样保留；没有执行真实 Embed/network policy/VM journey。
- **F073**：两个 administrative children 均使用 native timeout+SIGKILL 和生命周期内 watchdog；立即观察 exit 和两个 reader-owned diagnostic drains，deadline 至所有 receipts settled 才解除。明确取消 actual reader，不在 Response.text lock 上调用 raw stream.cancel；16MiB 仅是本地测试诊断 cap，不新增应用预算。release blocker、child/pipes、blocker settlement、DBclose、目录移除独立尝试，保留 primary/cleanup。实际正常unicode输出与忽略SIGTERM、双pipe各128KiB的挂起child都通过；SIGKILL termination 的 Bun exitCode可以仍为null，改用已joined的signalCode确认terminal，不误称kill issuance即settlement。旧有 test-only Kysely close fault保留，不作为native destroy failure证明。
- **F086**：15s monotonic整体预算包含session readiness/private route，单次native fetch/json/cancel共用有限timer；200 malformed/wrongnull不重试，non200与private body cancel等待，sleep也不超剩余预算；明确保留任何body/cancel拒绝（含undefined）。6个真实loopback null/noheaders/stalled200/nonready/private/malformed场景通过。
- **F087**：inventory、worker Node probe、native CMD三条create路径都先登记random name+owner，inspect确认name/fullID/label及candidate一致；start/wait/logs/rm使用immutableID；一次cleanup attempt，不复发uncertain removal；context与其他container cleanup互不阻止。所有sync CLI hard SIGKILL，600s整体operation+每项10s cleanup在720s外层内留余量。one-shot unknown-create inspect失败明确是incomplete，**不保证稍后没有delayed create**，不rename/retry/删除unknown label。

独立9文件审查及stderr amendment无blocking finding；actual AST-extracted callback/helpers纯Node owner proof19个observations，parent再运行并核对current hashes，不是nativeVM/daemon证明。Actual nativeHTTP/child mutations：移除signal、headers后解除timer、丢bodycancel、双SIGTERM各fail；control6+2 pass。child mutation使用额外600ms硬guardian收掉坏实现PID，以400mslatency oracle区分被救援，不让红测遗留child。

F087补充 exclusively-owned native daemon proof：wrapper令真实已创建并running的owned container丢create ACK，实际ETIMEDOUT；登记name定位/verifylabel+fullID后rm-f，已知ID随后authoritative no-such-object。wrapper特意启动该container以覆盖live cleanup，不声称create天然启动，也不覆盖尚未出现的delayed create。第一次proof只因Docker诊断小写no-such-object而失败，native容器已删除；修正大小写匹配并重跑，未重试同一删除。

第一全套capture的production **0 pass /2 fail**暴露logs只收stdout而遗漏真实stderr；恢复一次bounded spawnSync双stream快照，privacy/CMD断言不放宽，重新capture并全部重跑。最终7条gates exit0：架构10、单元384、八文件脚本 **26**、原生集成 **306**、storage17及2/2/10/1checks、production-runtime2；额外SDK transport **6 pass /1 opt-in skip**，明确不执行VM。compiler/lint/format/boundaries/API/DB equality和hash-pinned shell/YAML通过。93captured/21immutable、9-path freshLSP无新diagnostic；stdout-only失败capture、signal-exitCode初稿测试失败、depth/complexity/断言修正均保留。0owned containers/custom networks、16anonymous volumes保留待exact profile收尾；无paid/unknownsandbox/UI。

## 第十四批：Bash 源、显式排版与 metadata 约束

- **F006**：Compose 特权初始化正文抽为 `deploy/storage/initialize.sh`，使用已有 Bash 与 readonly policies mount。原 `bash -e` 转为 shebang/`set -e`，仅给 stage 的 alias 字面量加引号以满足 ShellCheck；精确 body 对照已记录。外部 endpoint bypass、stdin 凭据、角色/policy、失败诊断不变。Python shell gate 仅此精确路径走 Bash，其余 shipped sh 保留原检查。实际 native 初始化四例通过，完整 storage/deployment 通过，不用 fake mcli 证明行为。
- **F028**：明确 authored 100 列；原报告 embedded formatting 关闭、prompt 保留 80，DB generator 显式 80。显式 manifest 在读取前排除 HTML、生成物、迁移、lock、prompt、原报告和用户独立研究；171 个 eligible 文件中 125 个被改写，全部 TypeScript/JS AST 等价。此证明固定在原 after hashes；之后 storage test 的 `DOCKER_HOST` 增补是独立有意行为变化，单独复核、重捕获和完整验收，绝不说成 AST 等价排版。最终报告冻结引用恢复也单独记录。
- **F020**：语义建议成立，但两个 description 都进入公开 OpenAPI。实际 pinned native generator/verifier 对只改这两段描述的 derivative container 产生 artifact mismatch；current control exit 0、mutant exit 1。API 生成字节没有获得修改授权，因此不修改 source metadata 或削弱完整 base64-tree verifier。`docs/architecture.md` 澄清公开 publication cursor 与 run ordinal、序列缺口、授权及重连优先级，并明确保留的旧导出描述限制。此项计入约束裁决，不虚称 metadata 全面修复。

## 用户授权合并：outbox retention

用户确认并发修改归其所有并要求合并。保留 pending index、worker owner wiring 与配置，独立复核和 native red 再修复：显式 30 天值原被 signed-32-bit timer 上限拒绝；活动 run 的 published 行删除后 ordinal 会回到 1；无限量 DELETE 缺少 sweep 预算。有效 red 为 1 pass / 2 fail，原格式错误的 fixture 运行保留、不当证明。

最终 SQL retention 上限/默认均为 2592000000ms，不把 SQL 时间窗当 native timer；每小时 owner 内 sweep，pending publish 后检查 stop，没有 detached timer。数据库 stable statement clock 先选至多 128 个过期候选，再限 completed/failed/cancelled run 删除；保留 unpublished、recent、active ordinal evidence。新增 `20261006020000_event_outbox_retention.sql` 的 partial index；用户 `20261006010000_event_outbox_pending.sql` 保持精确原字节。native 生成 schema 与用户版本仅差新 index，DB types 未变；retention 三例 25 assertions 通过，最终 integration 含全部三例。

**保留限制**：候选数/删除数有界不证明固定 SQL 查询时间或指定物理计划；最早 active 候选可能长期推迟后续 terminal cleanup。测试仍要求 controlled database，不能说消除了所有全局 claim/sweep 假设。此合并是用户新增工作，不是第 90 项。

## 最终合并源码验收与证据一致性

最终快照：`/tmp/handover-refactor-final-reconciled.ag8zmez4`，147 个 captured 变更路径与当前源码逐一匹配；23 个 protected 文件精确一致（含授权 native schema 及两份新迁移）。Node 24.21.0、Bun 1.4.2、frozen lock 不变。实现记录是在 runtime 验收之后单独更新，不伪称其正文来自旧镜像。

| 完整 owning 命令                                           | 最终实际结果                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `sh scripts/check.sh`                                      | exit 0；strict compiler、type-aware lint、format、boundaries；架构 10、单元 385、脚本 26，0 fail |
| `sh scripts/check.sh run test:scripts`                     | exit 0；八个显式无凭据文件，26 pass；是重复入口验证，不额外累加用例                              |
| `sh scripts/check.sh run .github/verify-api.ts`            | exit 0；实际 API artifact 全树精确一致                                                           |
| `sh scripts/database-check.sh check`                       | exit 0；native DB 生成一致，集成 309 pass，0 fail                                                |
| `sh tests/scripts/deployment-check.sh`                     | exit 0；storage 17，另 2/2/10/1 组角色、轮换、原生重应用与 Caddy checks                          |
| `node --test tests/scripts/production-runtime.test.ts`     | exit 0；两个实际 frozen image native CMD 测试通过                                                |
| `sh scripts/check.sh test tests/sandbox/e2b.test.ts`       | exit 0；SDK transport 6 pass、1 个 explicit owned-Embed opt-in skip，不认证 VM                   |
| `node --test tests/scripts/storage-initialization.test.ts` | exit 0；四个实际 native 初始化场景通过                                                           |

额外 hash-pinned shell/YAML exit 0；host compiler/type-aware lint 通过。显式 LSP 130 文件中六个 contract test 文件有 12 条 inferred Bun/any warnings，实际 owning compiler 通过；目录 probe 的 10 个 `not a file` 已改显式文件重查。最后 env amendment 单文件主动 LSP 0 diagnostics。保留历史 suppressed/inconclusive 与 TS7 dependency-cruiser transpiler warning，不称全库 LSP/所有辅助规则全绿。

父端重放 actual-owner 19 个 observations、真实 HTTP/child control/mutations 和 committed-before-CLI-timeout Docker proof，source hashes 对齐；独立最后 review 21 输入和单行 env review 对齐。纯 Node AST/owner 证明不代替 PG/VM；Docker one-shot absence 不排除以后 delayed create。没有 paid provider、真实 Embed/未知 sandbox 或浏览器/UI journey。

### 冻结报告引用恢复

最终审计发现原报告整体 SHA 与历史 `3a1262…` 不同，**在任何最终 evidence/ledger 写入前拒绝接受**。现有版本的 embedded 排版重排了引用，不能把它说成冻结原文；没有擅自猜测是哪位作者造成。用固定基线与原始 findings/参考读取重新生成首次交付报告，得到精确 initial SHA `1cda40…`；仅恢复全部 89 项的 162 个原文/reference code blocks 和正面实例，保留当前全部 proposal code、复审 prose/目录说明。284 个 code blocks/89 IDs 保持；逐项原始引用完整比对通过。

恢复后整体 SHA 是 `78a949078553bd7107410462a6ab64ea701b153a79db4df62ee59c5e7a25f7a0`，**不声称整体仍是旧 hash**。恢复前文档备份、机械恢复范围和引用证明在 `/tmp/handover-refactor-report-restoration.json`。随后重新 capture，八条完整 gates 和 metadata constraint proof 全部重跑，不用恢复前 snapshot 认证新文档。首次新路径的 policy-delivery prefix guard 拒绝导致两个 native mount checks 失败；日志保留，只移除新 minted guest path 中可证明为空的自动创建目录，再投递 exact 0444 policies/script、重跑全部八条通过，无 shared/host sharing 改动。

## 政策性提案的最终裁决

- **F019：拒绝 AFTER，保留当前已领取 batch 的收尾政策。** 当前 relay 明确以 batch 为停机门，最多 32 条，各自等待 transport acceptance 与 SQL settlement。逐条新增 stop gate 会少发后续已选行、改变错误可见性；不是形状重构。已有真实 publication、lock、lost-ACK 与 relay 回归在第二批 native 集成中通过，不增加无用 signal 参数。
- **F020：约束裁决，保留 API 生成字节。** native control/mutant 证明 faithful description patch 必须改变导出 artifact；保留 whole-tree verifier，以 authored architecture 澄清真实 cursor，不能计作 metadata patch 已实施。
- **F021：拒绝 AFTER，保留外部 endpoint 的既有 bucket 准入。** 本地 provisioning 的命名限制不等于所有外部 S3-compatible provider 的合同。实际 config/官方 SDK path-style endpoint 解析接受 `ab`、`Legacy_Bucket` 等原字符串，而提案会新拒绝；这只证明准入变化，不声称外部 PUT 成功或持久性。没有证据授权统一收紧。
- **F022：拒绝本轮 filename 合同收紧，保留明确的 native/foreign 接受集。** 独立 PG 18.6/pg 8.23.1 实测中 JSONB 拒绝孤立 surrogate，而 text/varchar 参数会替换成 U+FFFD；正常 generated receipt 在 outbox JSONB 更早失败，未复现正常 persisted asset 下载故障。`encodeURIComponent` 的内存异常不等于线上下载缺陷；不以此静默改变原有 true/true 测试、255 UTF16 预算或规范产物。准入与持久化的落差保留为明确风险，不做有损替换、重推理或历史数据修补。
- **F023：拒绝 AFTER，保留 trusted admin CLI 的原因。** 现有真实 SQL 管理回归要求可见 native deadline，以及 operation/close 两个原因；固定一行输出会删除这个实际合同。产品进程的固定错误输出、公开事件 allowlist 与私有配置诊断继续独立，不把管理员原因送入公共面。

F009 的独立实测还有明确反例：官方 Pi loopback 分别发出 high/low surrogate delta，最后 canonical answer 为完整 `🎬`。**拒绝逐 delta 直接套用 productText 的拟议收紧**；完整字段收紧也不是纯重构。第三批只实施了既有 HTTP primitive 的行为保持归属提取，流式缓冲/协议新政策没有混入本轮。

## 独占环境最终清理

全部验收与证据登记后，只删除最初记录 `preexisting:false` 的 `handover-refactor-81b78af548ec`，使用明确 `colima --profile … delete --force --data`，exit 0。清理前 owned containers 为 0、network 仅三种默认类型；22 个未单独归因的 anonymous volumes 不做逐卷 blind prune，而随已证明独占的新 runtime data disk 删除。

确认 exact profile directory、socket、Lima VM 和对应 data disk 均不存在；default profile 仍 Running，非任务 contexts/active context、default config/VM/data metadata 与 unknown E2B cache directory metadata 清理前后相同。没有访问默认 Docker daemon、删除共享 container 或处理 unknown sandbox。证明：`/tmp/handover-refactor-owned-profile-cleanup.json`、`.log`。保存的 native snapshots/images provenance 是历史验收证据，不声称已删除的 daemon/image 仍可运行。

## 历史第一批实际验证（保留，不替代最终合并验收）

以下历史正式命令针对同一份已冻结的**第一批最终变更源码 snapshot**，不是基线镜像；Node 24.21.0、Bun 1.4.2 和 frozen lockfile 保持。

| 命令                                            | 实际结果                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `sh scripts/check.sh`                           | exit 0；typecheck、type-aware lint、format、依赖边界通过；架构 10 pass，单元 366 pass，0 fail |
| 六项 credentialless script suites               | exit 0；13 pass，0 fail；包括新增 compiler/lint 两项负例                                      |
| `sh scripts/check.sh run .github/verify-api.ts` | exit 0；实际生成物与原 artifacts 精确一致                                                     |
| `sh scripts/database-check.sh check`            | exit 0；生成 DB 产物一致；288 pass，0 fail                                                    |

另外，搜索 characterization 在重构前后各 20 pass；F089 的 red 记录明确为 2 pass / 2 fail，而非编译器启动异常。独立只读复核对 sanitizer 做了 1280 组精确差分，并检查了相关 SDK public typings、调用者和第一批 diff；其 mocked tree 检查不冒充真实文件系统验收。

首次共享 Docker 构建因现有数据盘 `ENOSPC` 失败，没有假报基线通过，也没有 prune 或清理共享资源。随后新建独占、无 host mount/SSH-agent 的验证 profile；仅该 guest 缺失的临时 resolver 文件被最小恢复，host/default/共享环境不改。之后原始基线和变更源码各自独立构建、验证。正式 runner 使用 exact owner/token；第一批最终检查后 owned containers/networks 均为 0。当时该验证 profile 留供后续批次使用；现已在最终验收后按上节删除其精确 owner/runtime data，共享资源不动。

### 证据索引

- 基线与环境恢复：`/tmp/handover-refactor-baseline-recovered-evidence.json`
- 第一批源码 SHA、image、命令日志、计数与 immutable 文件核对：`/tmp/handover-refactor-batch1-evidence.json`
- 第一批独立复核：`/tmp/handover-refactor-batch1-review.md`；其后 child/pipe 收尾增强已重新跑全部正式命令。
- 第二批源码/命令/计数/immutable 证明：`/tmp/handover-refactor-batch2-evidence.json`；独立复核：`/tmp/handover-refactor-batch2-review.md`；其 P3 已按上述修正并重新验收。
- 第二批 six-script 集合：`scripts/generate-api.test.ts`、`tests/scripts/{ci-policy,proxy-deadline,reconciliation-cli,database-project,process-diagnostics}.test.ts`。
- 第三批源码/命令/计数/immutable 证明：`/tmp/handover-refactor-batch3-evidence.json`；独立复核：`/tmp/handover-refactor-batch3-review.md`。
- 第四批源码/命令/计数/immutable 证明：`/tmp/handover-refactor-batch4-evidence.json`；独立复核：`/tmp/handover-refactor-batch4-review.md`。
- 第五批目录迁移与 F068 的完整证据：`/tmp/handover-refactor-batch5-evidence.json`；独立布局复核：`/tmp/handover-refactor-agent-layout-review.md`；最终 diff 复核：`/tmp/handover-refactor-batch5-review.md`；missing-join mutation：`/tmp/handover-refactor-batch5-shutdown-mutation.00lmzae4/red.log`。
- 第六批完整证据：`/tmp/handover-refactor-batch6-evidence.json`；独立复核：`/tmp/handover-refactor-batch6-review.md`、`/tmp/handover-refactor-batch6-amendment-review.md`；最终验收：`/tmp/handover-refactor-batch6-final-amended.nfyzj083`；初次 lint 失败 snapshot：`/tmp/handover-refactor-batch6-final.y3yth_de`。
- 第七批正式/扩展 native、源码/immutable/hash、失败与修订证据：`/tmp/handover-refactor-batch7-evidence.json`；复核：`/tmp/handover-refactor-batch7-review.md`、`/tmp/handover-refactor-batch7-amendment-review.md`；最终 snapshot：`/tmp/handover-refactor-batch7-final-amended.6b3wq2c4`。
- Pi remote tool 调查更正与 final boundary regression：`/tmp/handover-refactor-pi-remote-disposition.md`；未验收 SDK 候选 snapshot 与 host-probe red 日志保留，不认证 rollback 后源码。
- 政策边界复核：`/tmp/handover-refactor-policy-dispositions.md`；F022/F009 原生 PG/官方 Pi 证据：`/tmp/handover-refactor-unicode-proof.md`、`.json`。
- 第八批完整证据：`/tmp/handover-refactor-batch8-evidence.json`；静态复核：`/tmp/handover-refactor-batch8-review.json`；bounded oracle：`/tmp/handover-refactor-batch8-oracle-proof.json`；native source-loss：`/tmp/handover-refactor-batch8-migration-proof.6kw7mzhp/result.json`；最终 snapshot：`/tmp/handover-refactor-batch8-final.83hp8ps6`。
- 第九批完整证据：`/tmp/handover-refactor-batch9-evidence.json`；静态复核：`/tmp/handover-refactor-batch9-review.json`；native cleanup fault：`/tmp/handover-refactor-batch9-cleanup-proof.ihq9oeiq/result.json`；入口执行：`/tmp/handover-refactor-batch9-entry-proof.u5_kfxlr/result.json`；最终 snapshot：`/tmp/handover-refactor-batch9-final.xv7vrbe8`。
- 第十批完整证据：`/tmp/handover-refactor-batch10-evidence.json`；独立复核：`/tmp/handover-refactor-batch10-review.json`；remote body equality：`/tmp/handover-refactor-batch10-shell-preservation.json`；最终 snapshot：`/tmp/handover-refactor-batch10-final.s7p2lkye`。
- 第十一批完整证据：`/tmp/handover-refactor-batch11-evidence.json`；独立复核：`/tmp/handover-refactor-batch11-review.json`；native mutation：`/tmp/handover-refactor-batch11-put-proof.tam3t_je/result.json`；最终 snapshot：`/tmp/handover-refactor-batch11-final.o0o1mwtp`。
- 第十二批完整证据：`/tmp/handover-refactor-batch12-evidence.json`；独立复核及AST proof：`/tmp/handover-refactor-batch12-review.json`、`/tmp/handover-refactor-batch12-gate-parent-replay.log`；native controls：`/tmp/handover-refactor-batch12-native-proof.acbsjh3q/result.json`；最终snapshot：`/tmp/handover-refactor-batch12-final.djewz1a1`。
- 第十三批原候选历史（现已由最终共享 evidence/ledger 验收）：9文件审查/更正：`/tmp/handover-refactor-batch13-review.json`、`/tmp/handover-refactor-batch13-amendment-review.json`；native local mutation：`/tmp/handover-refactor-batch13-local-proof.b2rzf2k8/result.json`；native daemon proof路径在`/tmp/handover-refactor-batch13-docker-proof-path`；最终snapshot：`/tmp/handover-refactor-batch13-final-amended.vo4g3tl_`。
- 第十三/十四批最终登记：`/tmp/handover-refactor-batch13-evidence.json`、`/tmp/handover-refactor-batch14-evidence.json`；共享当前源码/gates/immutable/proofs：`/tmp/handover-refactor-final-evidence.json`。
- 最终额外复核：`/tmp/handover-refactor-final-amendments-review.json`、`/tmp/handover-refactor-final-docker-env-review.json`；retention 初始风险：`/tmp/handover-refactor-retention-merge-review.json`；授权 schema 例外：`/tmp/handover-refactor-merge-immutable.json`。
- Bash 精确抽取：`/tmp/handover-refactor-storage-script-extraction.json`；171/125 原 format proof 及后续语义变动区分：`/tmp/handover-refactor-format-final-proof.json`、`/tmp/handover-refactor-format-final-reconciliation.json`。
- 全部 89 项机器账本：`/tmp/handover-refactor-state.json`

证据仅覆盖记录中的源码版本与测试范围。不以这些结果宣称真实付费模型、E2B/未知 sandbox、生产外部对象存储或用户 UI 已验收。LSP 已主动检查 touched files；generic Bundler-relative-import、必要的 Record 与 unknown 边界辅助意见单独记录，不伪称所有辅助意见为零。

## 逐项状态

全部 89 项已逐项收束为 84 项实施/5 项证据裁决，无待处理；历史条目路径以冻结报告和 execution relocation map 解释，不能将提案直接当补丁。

| 编号 | 原提案                                                                     | 当前状态                                      |
| ---- | -------------------------------------------------------------------------- | --------------------------------------------- |
| F001 | 能力合同不要成为执行入口前的 147 行类型墙                                  | 已实施并验证                                  |
| F002 | stop reason 优先级是一条纯规则，不是 abort 副作用里的条件拼接              | 已实施并验证                                  |
| F003 | Pi 的 admission 与 cleanup 政策命名，明确不是 SDK 原生保证                 | 已实施并验证                                  |
| F004 | OpenAPI 引用名字应由现有 schema owner 约束，而非任意 string                | 缩减公共导出后已实施并验证                    |
| F005 | 上传的授权预检仍由路由直接拥有 SQL 事务                                    | 保留 prebody 授权顺序已实施并验证             |
| F006 | 将Compose中的特权storage init正文作为可检查Bash源                          | 精确 Bash 抽取已实施并 native 验证            |
| F007 | 共享polling政策一个名字，进程schema不合并                                  | 已实施并验证                                  |
| F008 | 输入附件数上限在两个 wire 合同里重复拥有                                   | 更正后已实施并验证                            |
| F009 | 公开输入与执行回执对 PostgreSQL text 的可表示性有两个不同 owner            | 仅 HTTP primitive 已实施；拒绝 wire 收紧      |
| F010 | acceptCancel 只接受 schema 已经分辨的 cancel command                       | 用既有类型已实施并验证                        |
| F011 | 终态 adapter 把 boolean SQL receipt 翻译为统一 outcome                     | 更正后已实施并验证                            |
| F012 | quarantine 的 lease 只从当前 execution owner 取一次                        | 已实施并验证                                  |
| F013 | 原生工具调用同时携带 owner 与 SDK 的取消权                                 | 双取消已实施并验证                            |
| F014 | 工具定义与工具名称 allowlist 应由同一组受信定义派生                        | 已实施并验证                                  |
| F015 | 已知 native identity 在 session 生命周期内应不可变                         | 值冻结已实施并验证                            |
| F016 | 两条 Redis 连接的拒绝原因应完整保留，而非只选第一条                        | 更正 aborted receipt 后已实施并验证           |
| F017 | 取消 run 的名字不要暗示只取消观察                                          | 更名后已实施并验证                            |
| F018 | 资产完成的相邻字符串参数缺少具名 storage confirmation                      | 具名确认已实施并验证                          |
| F019 | 停机门应位于每条 outbox publication 的发起点                               | 拒绝政策性 AFTER；保留现状                    |
| F020 | 观察 cursor 文档不可把 thread publication 与 run ordinal 混为一谈          | API 生成物约束裁决；authored 文档澄清         |
| F021 | bucket名称准入不应只存在于本地provisioning程序                             | 拒绝政策性 AFTER；保留现状                    |
| F022 | 文件名合同允许孤立 surrogate，但下载 header 编码拒绝它                     | 拒绝政策性 AFTER；保留现状                    |
| F023 | legacy assignment的CLI输出与trusted API原因应分开                          | 拒绝政策性 AFTER；保留现状                    |
| F024 | generate/verify参数应在分配fixture前明确拒绝                               | 分配前拒绝已实施并验证                        |
| F025 | 独立测试资源的 cleanup 应互不阻止并保留全部失败                            | 资源 owner 已实施并验证；未认证真实 VM        |
| F026 | restart shell cleanup 不覆盖原始失败或信号状态                             | outer status 已实施并验证；不认证 VM restart  |
| F027 | 生成 artifact 树的递归归并使用直接循环                                     | 已实施并验证                                  |
| F028 | 明确采用 100 列，但把列宽视为排版预算而非重构规则                          | 100 列及 125 AST 等价排版已验证               |
| F029 | 并发 fixture 使用原生 Promise.withResolvers 表达 latch                     | 已实施并验证                                  |
| F030 | diagnose 的默认分类从类型/默认参数交界移到函数体                           | 保留惰性默认后已实施并验证                    |
| F031 | 终态完成分支在本地证明 product，不使用跨条件 non-null assertion            | 更正后已实施并验证                            |
| F032 | tool outcome 的 mutative 政策不要靠位置 boolean 表达                       | 已实施并验证                                  |
| F033 | import_file 的图片与普通文件结果采用分支提前返回                           | 已实施并验证                                  |
| F034 | subprocess eval 只包含真正执行的入口 import                                | 已实施并验证                                  |
| F035 | prompt 中资产投影先形成 public metadata 段落                               | 已实施并验证                                  |
| F036 | canonical answer 文本归约与 history result 分成独立段落                    | 保留 admission 顺序后已实施并验证             |
| F037 | 净化、固定实体映射和 Unicode 截断按线性阶段展开                            | 已实施并验证                                  |
| F038 | 在拥有 reader 的函数内显式写出 bytes→text→JSON 三步                        | 已实施并验证                                  |
| F039 | 认证 headers 的互斥策略用显式赋值而不是条件 spread                         | 已实施并验证                                  |
| F040 | 给搜索配额与响应预算一组模块私有政策名字                                   | 已实施并验证                                  |
| F041 | 把每个 run 的可选超时一次投影成执行 options                                | 保留 per-run/try 位置后已实施并验证           |
| F042 | 两个同样的 abortable polling 实现共用一个生命周期 helper                   | 已实施并验证                                  |
| F043 | Worker 的 imports 按外部边界与本地依赖形成稳定段落                         | 已实施并验证                                  |
| F044 | 把测试赋值能力直接写成三个可选字段                                         | 保留 readonly 后已实施并验证                  |
| F045 | 用惰性的空值默认表达启动能力选择                                           | undefined-only 默认已实施；拒绝 null fallback |
| F046 | 连接配置重复的 Pick 交集应有一个 owner 内名字                              | 已实施并验证                                  |
| F047 | 健康阶段的优先级不要藏在三层 ternary 中                                    | 已实施并验证                                  |
| F048 | 生成资产预算验证用单次具名累计区分 legacy 与 current                       | 保留准入、更正后已实施并验证                  |
| F049 | download header 的 RFC5987 编码从超长插值里移出                            | 已实施并验证                                  |
| F050 | SSE 最后一帧的元数据投影与 wire framing 应是两个可见阶段                   | 已实施并验证                                  |
| F051 | completion 的可选字段用具名白名单对象组装                                  | 不可变投影已实施并验证                        |
| F052 | AG-UI frame identity 的消息维度先命名再组装                                | 已实施并验证                                  |
| F053 | 失败摘要与共用恢复步骤分开呈现，保留不同 reason                            | 已实施并验证                                  |
| F054 | 终态 outcome map 用两段直接循环替代双链、spread 与 tuple 断言              | 保留覆盖顺序后已实施并验证                    |
| F055 | readActiveRuns 的 running / terminal SQL 用 SQL 自己的多行结构             | 已实施并验证                                  |
| F056 | 活动 run 状态优先级用局部变量明确声明                                      | 已实施并验证                                  |
| F057 | 完成消息写入的主体不必整段缩进在唯一 kind 条件内                           | 已实施并验证                                  |
| F058 | 重放的五条 identity 对照不必先变成匿名 tuple 矩阵                          | 更正 checklist 后已实施并验证                 |
| F059 | 保留位置的 upload 与 generated 策略用明确分支赋值                          | 已实施并验证                                  |
| F060 | OpenAPI SDK 兼容断言用一个 owner 内 type alias 表达                        | 已实施并验证                                  |
| F061 | 关系完整性矩阵用具名 case，而不是依赖四槽 tuple 位置                       | 已实施并验证                                  |
| F062 | 三个 local model fixtures 只共享 SSE framing，答案与工具叙事继续各自独立   | 已实施并验证                                  |
| F063 | indexed corruption 场景的值选择显示真实 identity 来源，不用右移三元阶梯    | 已实施并验证                                  |
| F064 | 让四种fixture凭据旋转显示成四条sed clause                                  | 已实施并验证                                  |
| F065 | 停止进程的diagnostic应只采集成一个快照                                     | 已实施并验证                                  |
| F066 | 本地工具模型只记住 request ordinal，不维护无人读取的完整请求历史           | 已实施并验证                                  |
| F067 | budget fixture 的闭合场景应与实际 admission 政策一致                       | 保留实际四场景已实施并验证                    |
| F068 | WorkerProcess 的 shutdown promise 应有未完成 owned-task 回归               | 已实施并验证；missing-join mutation 失败      |
| F069 | upload 文档测试应核对全部 MIME，而不是只测一正一负                         | 已实施并验证；metadata mutation 区分旧 oracle |
| F070 | 无需凭据的脚本回归应有同一个本地/CI入口                                    | 共同入口已实施并验证                          |
| F071 | native/foreign 一致性断言需要独立的预期真值                                | 已实施并验证；独立 literal oracle             |
| F072 | native PUT测试需钉住immutable条件、metadata与单次尝试                      | 更正 streaming retry 证明后已实施并验证       |
| F073 | 第二个 administrative child 与第一个一样由 test owner 设 watchdog 并 join  | child/watchdog/pipes owner 已实施并验证       |
| F074 | 迁移命令断言先证明 outbox/inbox 两份记录都保留，再检查独立 wire 形状       | 已实施并验证；native source-loss mutation     |
| F075 | 清理序列复用现有 settleTestCleanup，而不是首个 DELETE 失败就跳过余项       | 已实施并验证；native SQL cleanup fault        |
| F076 | fixture 的 abort 等待需与同文件 late-quarantine 场景一样处理已发生的 abort | 已实施并验证；已取消 native signal 对照       |
| F077 | 失去 fence 的慢 cleanup 测试必须在 assertion 失败后也释放 sandbox gate     | 已实施并验证                                  |
| F078 | canonical inbox 的 oracle 不再对 actual 与 expected 同时运行被测 parser    | 已实施并验证；先比较独立 raw 预期             |
| F079 | Postgres proxy 创建 owner 必须把 listen error 接到 setup Promise           | 更正 setup cleanup 后已实施并验证             |
| F080 | 并发fixture接入应先收齐sibling结果，再按owner关闭Redis/SQL资源             | Redis owner 已实施并验证；未扩称全部 SQL      |
| F081 | SSE 顺序断言先证明两种事件都存在，避免 -1 充当正确先后                     | 已实施并验证；missing-START 反例              |
| F082 | runtime submit 的身份 setup rejection 不应跳过自己打开的数据库关闭         | 已实施并验证                                  |
| F083 | runtime answer polling 证明 assistant 消息，而非响应任意位置含有 canary    | 已实施并验证；真实 HTTP canary red/green      |
| F084 | 会话到期三种场景创建的官方身份也应加入本套件清理账本                       | 更正 partial identity owner 后已实施并验证    |
| F085 | archive/send/replay barrier 在失败路径也收齐已发出的真实 writer            | 已实施并验证                                  |
| F086 | readiness polling同时拥有monotonic预算和每次请求截止                       | body-inclusive deadline 已实施并 native 验证  |
| F087 | daemon probe需要在Docker client超时前登记可定位身份                        | name/label/fullID owner 已实施并 native 验证  |
| F088 | 上传 fixture 只保证初始可用状态；重放和冲突应由命名测试自己拥有            | upload 部分已实施并验证；其他 oracles 保留    |
| F089 | 可执行CI TypeScript应进入现有compiler/lint边界                             | 已实施并验证                                  |
