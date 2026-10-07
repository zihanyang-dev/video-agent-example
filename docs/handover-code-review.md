# 与 Handover 的全库设计、边界与代码形状对照审查

<!-- markdownlint-configure-file {"MD033":{"allowed_elements":["a"]}} -->

> 原始审查全库静态阅读：**171/171 文件、32,162/32,162 行**；独立建议：**89 项**。首次交付仅新增报告，AFTER 是提案，不是已验收补丁。
>
> **逐条重构复审更新**：用户现已授权实施。本报告保留冻结版本的 BEFORE 与原始证据边界；各项「拟议，未实施／当前验证状态」描述的是首次交付阶段。复审更正及实际实施、测试状态见 [逐条重构记录](handover-refactoring.md)，不能把原始提案的静态解析当作当前源码验证。用户自行调整的 `docs/*.html` 继续排除。
>
> **Agent 目录更新**：第五批按用户新增要求把持久执行路径移到 `apps/agent/src/execution/`。本文旧路径/行号仍定位冻结 BEFORE，不冒充现行目录；原文可用 `git show 01b1f17760a8fd12c7cb18ac4100ac6721d6c6bb:<旧路径>` 读取。当前路径对照见重构记录「第五批」，合同现位于 `execution/contract.ts`，没有旧入口兼容转发。

## 1. 审查范围、版本与证据边界

当前仓库冻结在 `01b1f17760a8fd12c7cb18ac4100ac6721d6c6bb`；参考 Handover 冻结在 `901e1afb55c3973adac1626915015a6160e52356`。全部位置以这两个版本为准，参考链接使用固定 commit，不使用会变化的 main。

审查对象是清单中的 **171 个手写代码与配置文件、32,162 行**，包括生产 TypeScript、单元/集成/存储/sandbox 测试、脚本、部署、CI、配置与 13 份历史 SQL migration。生成物、第三方依赖、lockfile、二进制与用户自行调整的 `docs/*.html` 不在逐文件改动建议范围。历史 migration 被阅读用于确认设计和兼容约束，**不是重写或排版目标**。Markdown 架构/规范文档作为上下文阅读，不把规范文本当成实际实现证明。

高级模型评审先经 `openai-codex/gpt-6.1-sol` 通道启动，后因 quota 中断，通过 `openai/gpt-6.1-sol` 继续；批次记录保留历史来源。模型标识来自会话可见 `PI_PROVIDER`/`PI_MODEL` 与代理观察，只说明所暴露的标识，不推断服务内部路由。runtime/server continuation可见provider；integration与tooling批次未暴露`PI_PROVIDER`，只确认`PI_MODEL=gpt-6.1-sol`，不替它们补造provider。父审查核对引用、合并重叠建议、修正示例并拒绝证据不足的候选。分批未读、计数不够的结果没有升级为全库完成。

**这是静态设计/可读性报告，不是已实施重构，也不是生产缺陷已经复现的声明。** BEFORE 直接从冻结源码的连续行提取；AFTER 是拟议形状，其中局部表达式/属性/签名片段会明确写出原词法上下文。示例的语法解析不等于严格类型检查、真实 SDK 兼容性、SQL 并发或运行验收。现有行为检查只列为未来实施时的验证要求，不引用过去的 CI 绿色来证明建议正确。

### 1.1 如何理解优先级

- **P2 / 边界可维护性**：容易误解权威、身份、取消或输入可表示性的地方，值得独立验证；并不意味着已复现安全漏洞。
- **P3 / 表达质量**：阅读、导航、视觉形状或测试叙述的改善；没有必要把个人偏好当 blocking defect。
- **合同变化项**：另行标明，不能混进「只保持行为的美化」提交。原合同明确允许的值、停机粒度、异常/退出码若改变，先决定政策再修改。
- 同文件多项必须有独立责任和改动位置；同一 sanitizer 的实体表与外层链整理合为一项，重复 import-sort/formatter 规则不按文件重复计数。

## 2. 总体结论：差距是真实的，但不是换一套架构就会漂亮

### 2.1 两个系统的实际代价不同

| 维度           | 当前仓库                                                                                            | Handover                                                                         | 应怎样比较                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 运行形态       | server / Redis / agent / 远程 E2B /对象存储，SQL 承担 durable acceptance、执行 fence 与公开 receipt | server /主动 check-in的机器 /本地已登录 agent，turn reporting 与服务器数据库裁决 | 不能拿本地 CLI 的简短调用抹掉远程付费结果未知、租约失效与隔离                              |
| 执行接入       | 显式 assigned model、工具和 sandbox 能力；不能继承 host credentials/resources                       | agent adapter驱动机器上的 CLI与原生账户能力                                      | 借鉴 adapter内聚，不复制账户继承或执行权限                                                 |
| 消息与公开事实 | command/event outbox、durable receipt、ordinal缺口、public publication cursor、AG-UI投影            | 持久消息与 live moment区分，NOTIFY/SSE服务当前观看者                             | 借鉴清晰命名，不能把 receipt、stream和canonical product合为一种消息                        |
| SQL职责        | 产品与execution权限隔离；锁后实际时间/fence决定写权限                                               | DB transaction owns membership、turn、机器与消息赢家                             | 同样学习事务阶段；本项目的post-lock deadline不能机械换成reference的transaction-start clock |
| 外部字节       | 上传/导入/导出、不可变对象key、未知PUT、历史namespace兼容                                           | 有自身bucket/输出功能，但不是同构的远程资产交付模型                              | 无直接对应时明确指出，不把avatar缓存或内存bucket套在认证附件上                             |
| 阅读形状       | 80列默认、内联泛型/conditional spread/长模板/匿名事务/固定值矩阵较多                                | 100列、具名行为段落、明示边界与局部状态常见                                      | 首先改善这些具体代码，而不是新建service/repository框架                                     |

表中的描述对应当前 `docs/architecture.md` 及源码 `execute-run.ts`、`worker.ts`、`db/run-writes.ts`、server outbox/receipt模块；reference对应 `docs/architecture.md` 与 `answering.ts`、`checking-in.ts`、`server/conversation-api.ts`、`db/conversation.ts`。这些源码的逐处对照在下文，而不是只拿文档给整个项目盖章。

### 2.2 我们为什么显得不够赏心悦目

1. **一段动作被语法包成很多碎片。** `Partial<Pick<…>> & …`、多层 `NonNullable`、tuple assertion、长插值和嵌套ternary让符号占据了阅读中心。
2. **阶段已经存在，却没有在代码里显出来。** metadata投影/编码、锁读/判断/写入、验证/组装经常藏在对象属性或匿名callback里。读者必须自己补出段落。
3. **固定事实在两个家维护。** 工具定义与allowlist、输入文件数量、schema组件名字、scope身份在相邻模块重复表达。目标不是建通用框架，而是找当前真实owner。
4. **入口顺序和类型密度加重导航。** 能力合同挤在执行入口前、adapter消费混合receipt形状，使一条操作的主线埋得过深。减少导航不等于拆成更多短文件。
5. **测试有时像设置设备，而不像证明一件事。** 独立重放/冲突断言藏在fixture，巨大输入字面量混在断言中，差分校验缺少独立oracle。要留下必要的真实系统边界，但让准备、行动、事实断言分开。

100列能减少不必要断行，**不能修复表达式嵌套、匿名阶段或重复事实**。同样，提前返回并不是见到ternary就禁止，loop也不是永远比map漂亮。下面每项以实际片段解释取舍，不把某种语法当道德标准。

### 2.3 Handover 也不是抽象越少越好、代码永远更好

- `server/conversation-api.ts`漂亮的路由背后有真实且不小的 `server/route.ts`类型/adapter机制；引入它必须计算总复杂度，不能只比handler行数。
- `answering.ts`自身包含conditional spread；`checking-in.ts:292–299`使用map/filter/map与assertion。它们不自动成为我们的重写模板。
- `sleeping.ts`的秒单位和允许无signal，不是当前lease/poll毫秒合同；复用思想可以学，单位与owner不照搬。
- reference的本地agent取消、账户权限、unknown-turn及workspace策略，与远程付费VM及不可撤销外部效果不同；不能以「一致」为理由降低本项目边界。
- 我们的 `decideMessageReplay` 是清楚的责任段落：先授权，再裁决不兼容输入，再返回durable IDs。`request-body` reader ownership、单一terminal SQL裁决、S3 `maxAttempts:1` 等限制有实际价值。改善报告不是全盘否定。

## 3. 不能被审美优化删掉的合同

1. 身份由session给出，不由body声明；CSRF/Origin、注销持久撤销、owner隔离保留。
2. 最终授权来自锁内最新SQL事实；owner/run/fence及post-lock DB时间仍裁决每次写入。
3. durable acceptance后才ACK；不因为整理控制流而吞poison/conflict或ACK未知COMMIT。
4. 精确重放用已持久IDs；不换run/sandbox/asset身份，不trim输入或重排asset引用。
5. public事实白名单不能泄露私有Pi history、thinking、provider错误/凭据；snapshot与live frame职责不混淆。
6. 支出/步骤/字节/并发预算仍有界；命名常量不代表额外transport/RSS硬上限。
7. abort spending、请求取消、已发停止和实际收尾不是同一事实；resource owner仍等待已发IO并收尾。
8. unknown allocation/paid调用/write/PUT/pause/COMMIT不自动replay、refund、delete或replacement identity。
9. 历史migration和materials/artifacts位置兼容保留，官方SDK与公开API不fork、不反射。
10. 建议只减少已存在的自有复杂度，不新增provider registry、generic compensation或空service层。

## 4. 分类与发现索引

| 分类                 | 独立项数 |
| -------------------- | -------: |
| 架构设计与事实归属   |        9 |
| 职责、身份与外部边界 |       17 |
| 代码形状与阅读节奏   |       40 |
| 测试与工具链的表达   |       23 |

若先看实际代码形状，集中阅读 **F027–F066（40项）**；其余架构/边界26项、测试与工具23项各有独立位置，不靠重复formatter规则凑数。

| ID            | 分类                 | 优先级                      | 适用置信度                                                                                               | 改进点                                                                     | 原文位置                                                                                                                 |
| ------------- | -------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [F001](#f001) | 架构设计与事实归属   | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | 能力合同不要成为执行入口前的 147 行类型墙                                  | [`apps/agent/src/execute-run.ts:1–147`](../apps/agent/src/execute-run.ts#L1)                                             |
| [F002](#f002) | 架构设计与事实归属   | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | stop reason 优先级是一条纯规则，不是 abort 副作用里的条件拼接              | [`apps/agent/src/execute-run.ts:164–178`](../apps/agent/src/execute-run.ts#L164)                                         |
| [F003](#f003) | 架构设计与事实归属   | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | Pi 的 admission 与 cleanup 政策命名，明确不是 SDK 原生保证                 | [`apps/agent/src/harness/pi.ts:219–258`](../apps/agent/src/harness/pi.ts#L219)                                           |
| [F004](#f004) | 架构设计与事实归属   | P2 / 边界与合同可维护性     | 高（静态判断；不代表动态复现）                                                                           | OpenAPI 引用名字应由现有 schema owner 约束，而非任意 string                | [`apps/server/src/http.ts:60–62`](../apps/server/src/http.ts#L60)                                                        |
| [F005](#f005) | 架构设计与事实归属   | P2 / 边界与合同可维护性     | 高（静态判断；不代表动态复现）                                                                           | 上传的授权预检仍由路由直接拥有 SQL 事务                                    | [`apps/server/src/http.ts:491–494`](../apps/server/src/http.ts#L491)                                                     |
| [F006](#f006) | 架构设计与事实归属   | P2 / 边界与验收             | 高（静态证据；拟议实现未验证）                                                                           | 将Compose中的特权storage init正文作为可检查Bash源                          | [`compose.yaml:120–168`](../compose.yaml#L120)                                                                           |
| [F007](#f007) | 架构设计与事实归属   | P3 / 可维护性               | 高（静态证据；拟议实现未验证）                                                                           | 共享polling政策一个名字，进程schema不合并                                  | [`packages/config/src/env.ts:95–99`](../packages/config/src/env.ts#L95)                                                  |
| [F008](#f008) | 架构设计与事实归属   | P2 / 边界与合同可维护性     | 高（静态判断；不代表动态复现）                                                                           | 输入附件数上限在两个 wire 合同里重复拥有                                   | [`packages/contract/src/execution.ts:25–26`](../packages/contract/src/execution.ts#L25)                                  |
| [F009](#f009) | 架构设计与事实归属   | P2 / 边界与合同可维护性     | 中高：合同/PG可表示性差异可定位；真实消费失败路径与SDK增量切分未复现                                     | 公开输入与执行回执对 PostgreSQL text 的可表示性有两个不同 owner            | [`packages/contract/src/execution.ts:28–43`](../packages/contract/src/execution.ts#L28)                                  |
| [F010](#f010) | 职责、身份与外部边界 | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | acceptCancel 只接受 schema 已经分辨的 cancel command                       | [`apps/agent/src/db/command-acceptance.ts:128–145`](../apps/agent/src/db/command-acceptance.ts#L128)                     |
| [F011](#f011) | 职责、身份与外部边界 | P3 / 责任与表达可读性       | 中（适用前提见说明）                                                                                     | 终态 adapter 把 boolean SQL receipt 翻译为统一 outcome                     | [`apps/agent/src/execute-run.ts:93–103`](../apps/agent/src/execute-run.ts#L93)                                           |
| [F012](#f012) | 职责、身份与外部边界 | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | quarantine 的 lease 只从当前 execution owner 取一次                        | [`apps/agent/src/execute-run.ts:548–560`](../apps/agent/src/execute-run.ts#L548)                                         |
| [F013](#f013) | 职责、身份与外部边界 | P2 / 取消权边界（需验证）   | 中（适用前提见说明）                                                                                     | 原生工具调用同时携带 owner 与 SDK 的取消权                                 | [`apps/agent/src/harness/pi.ts:88–155`](../apps/agent/src/harness/pi.ts#L88)                                             |
| [F014](#f014) | 职责、身份与外部边界 | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | 工具定义与工具名称 allowlist 应由同一组受信定义派生                        | [`apps/agent/src/harness/pi.ts:156–209`](../apps/agent/src/harness/pi.ts#L156)                                           |
| [F015](#f015) | 职责、身份与外部边界 | P3 / 责任与表达可读性       | 中：fresh identity runtime不可变性硬化；当前无实际修改且消费port可能已静态readonly，不是已发现跨租户风险 | 已知 native identity 在 session 生命周期内应不可变                         | [`apps/agent/src/sandbox/e2b.ts:58–69`](../apps/agent/src/sandbox/e2b.ts#L58)                                            |
| [F016](#f016) | 职责、身份与外部边界 | P3 / 责任与表达可读性       | 中（适用前提见说明）                                                                                     | 两条 Redis 连接的拒绝原因应完整保留，而非只选第一条                        | [`apps/agent/src/worker.ts:259–268`](../apps/agent/src/worker.ts#L259)                                                   |
| [F017](#f017) | 职责、身份与外部边界 | P2 / 降低生命周期误读       | 高                                                                                                       | 取消 run 的名字不要暗示只取消观察                                          | [`apps/server/src/conversation/http.ts:62–79`](../apps/server/src/conversation/http.ts#L62)                              |
| [F018](#f018) | 职责、身份与外部边界 | P2 / 边界与合同可维护性     | 高（静态判断；不代表动态复现）                                                                           | 资产完成的相邻字符串参数缺少具名 storage confirmation                      | [`apps/server/src/db/assets.ts:84–89`](../apps/server/src/db/assets.ts#L84)                                              |
| [F019](#f019) | 职责、身份与外部边界 | P2 / 边界与合同可维护性     | 中：这是停止粒度的可选合同增强，不是已证明违反当前批次合同                                               | 停机门应位于每条 outbox publication 的发起点                               | [`apps/server/src/db/command-publication.ts:14–47`](../apps/server/src/db/command-publication.ts#L14)                    |
| [F020](#f020) | 职责、身份与外部边界 | P2 / 边界与合同可维护性     | 高（静态判断；不代表动态复现）                                                                           | 观察 cursor 文档不可把 thread publication 与 run ordinal 混为一谈          | [`apps/server/src/http.ts:375–390`](../apps/server/src/http.ts#L375)                                                     |
| [F021](#f021) | 职责、身份与外部边界 | P2 / 边界与验收             | 高（静态证据；拟议实现未验证）                                                                           | bucket名称准入不应只存在于本地provisioning程序                             | [`packages/config/src/env.ts:50–55`](../packages/config/src/env.ts#L50)                                                  |
| [F022](#f022) | 职责、身份与外部边界 | P2 / 边界与合同可维护性     | 高（静态判断；不代表动态复现）                                                                           | 文件名合同允许孤立 surrogate，但下载 header 编码拒绝它                     | [`packages/contract/src/file-name.ts:3–15`](../packages/contract/src/file-name.ts#L3)                                    |
| [F023](#f023) | 职责、身份与外部边界 | P2 / 边界与验收             | 高（静态证据；拟议实现未验证）                                                                           | legacy assignment的CLI输出与trusted API原因应分开                          | [`scripts/assign-legacy-threads.ts:34–41`](../scripts/assign-legacy-threads.ts#L34)                                      |
| [F024](#f024) | 职责、身份与外部边界 | P2 / 边界与验收             | 高（静态证据；拟议实现未验证）                                                                           | generate/verify参数应在分配fixture前明确拒绝                               | [`scripts/database-check.sh:4–8`](../scripts/database-check.sh#L4)                                                       |
| [F025](#f025) | 职责、身份与外部边界 | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | 独立测试资源的 cleanup 应互不阻止并保留全部失败                            | [`tests/sandbox/e2b.test.ts:193–196`](../tests/sandbox/e2b.test.ts#L193)                                                 |
| [F026](#f026) | 职责、身份与外部边界 | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | restart shell cleanup 不覆盖原始失败或信号状态                             | [`tests/sandbox/restart-check.sh:11–44`](../tests/sandbox/restart-check.sh#L11)                                          |
| [F027](#f027) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | 生成 artifact 树的递归归并使用直接循环                                     | [`.github/verify-api.ts:6–25`](../.github/verify-api.ts#L6)                                                              |
| [F028](#f028) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | 明确采用 100 列，但把列宽视为排版预算而非重构规则                          | [`.prettierrc.json:1–5`](../.prettierrc.json#L1)                                                                         |
| [F029](#f029) | 代码形状与阅读节奏   | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | 并发 fixture 使用原生 Promise.withResolvers 表达 latch                     | [`apps/agent/src/execute-run.test.ts:14–21`](../apps/agent/src/execute-run.test.ts#L14)                                  |
| [F030](#f030) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | diagnose 的默认分类从类型/默认参数交界移到函数体                           | [`apps/agent/src/execute-run.ts:200–218`](../apps/agent/src/execute-run.ts#L200)                                         |
| [F031](#f031) | 代码形状与阅读节奏   | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | 终态完成分支在本地证明 product，不使用跨条件 non-null assertion            | [`apps/agent/src/execute-run.ts:404–441`](../apps/agent/src/execute-run.ts#L404)                                         |
| [F032](#f032) | 代码形状与阅读节奏   | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | tool outcome 的 mutative 政策不要靠位置 boolean 表达                       | [`apps/agent/src/execute-run.ts:493–510`](../apps/agent/src/execute-run.ts#L493)                                         |
| [F033](#f033) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | import_file 的图片与普通文件结果采用分支提前返回                           | [`apps/agent/src/harness/file-tools.ts:34–54`](../apps/agent/src/harness/file-tools.ts#L34)                              |
| [F034](#f034) | 代码形状与阅读节奏   | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | subprocess eval 只包含真正执行的入口 import                                | [`apps/agent/src/harness/pi.test.ts:503–514`](../apps/agent/src/harness/pi.test.ts#L503)                                 |
| [F035](#f035) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | prompt 中资产投影先形成 public metadata 段落                               | [`apps/agent/src/harness/pi.ts:273–278`](../apps/agent/src/harness/pi.ts#L273)                                           |
| [F036](#f036) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | canonical answer 文本归约与 history result 分成独立段落                    | [`apps/agent/src/harness/pi.ts:299–314`](../apps/agent/src/harness/pi.ts#L299)                                           |
| [F037](#f037) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | 净化、固定实体映射和 Unicode 截断按线性阶段展开                            | [`apps/agent/src/harness/web-search.ts:22–56`](../apps/agent/src/harness/web-search.ts#L22)                              |
| [F038](#f038) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | 在拥有 reader 的函数内显式写出 bytes→text→JSON 三步                        | [`apps/agent/src/harness/web-search.ts:138–146`](../apps/agent/src/harness/web-search.ts#L138)                           |
| [F039](#f039) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | 认证 headers 的互斥策略用显式赋值而不是条件 spread                         | [`apps/agent/src/harness/web-search.ts:165–171`](../apps/agent/src/harness/web-search.ts#L165)                           |
| [F040](#f040) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | 给搜索配额与响应预算一组模块私有政策名字                                   | [`apps/agent/src/harness/web-search.ts:192–204`](../apps/agent/src/harness/web-search.ts#L192)                           |
| [F041](#f041) | 代码形状与阅读节奏   | P3 / 可读性                 | 中：只是局部阅读次序改善，不是修复错误                                                                   | 把每个 run 的可选超时一次投影成执行 options                                | [`apps/agent/src/run-loop.ts:32–41`](../apps/agent/src/run-loop.ts#L32)                                                  |
| [F042](#f042) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | 两个同样的 abortable polling 实现共用一个生命周期 helper                   | [`apps/agent/src/run-loop.ts:89–100`](../apps/agent/src/run-loop.ts#L89)                                                 |
| [F043](#f043) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | Worker 的 imports 按外部边界与本地依赖形成稳定段落                         | [`apps/agent/src/worker.ts:1–23`](../apps/agent/src/worker.ts#L1)                                                        |
| [F044](#f044) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | 把测试赋值能力直接写成三个可选字段                                         | [`apps/agent/src/worker.ts:25–27`](../apps/agent/src/worker.ts#L25)                                                      |
| [F045](#f045) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | 用惰性的空值默认表达启动能力选择                                           | [`apps/agent/src/worker.ts:34–41`](../apps/agent/src/worker.ts#L34)                                                      |
| [F046](#f046) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | 连接配置重复的 Pick 交集应有一个 owner 内名字                              | [`apps/agent/src/worker.ts:158–163`](../apps/agent/src/worker.ts#L158)                                                   |
| [F047](#f047) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | 健康阶段的优先级不要藏在三层 ternary 中                                    | [`apps/agent/src/worker.ts:195–205`](../apps/agent/src/worker.ts#L195)                                                   |
| [F048](#f048) | 代码形状与阅读节奏   | P3 / 表达与测试可读性       | 高（静态判断；不代表动态复现）                                                                           | 生成资产预算验证用单次具名累计区分 legacy 与 current                       | [`apps/server/src/assets/files.ts:75–109`](../apps/server/src/assets/files.ts#L75)                                       |
| [F049](#f049) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | download header 的 RFC5987 编码从超长插值里移出                            | [`apps/server/src/assets/http.ts:93–102`](../apps/server/src/assets/http.ts#L93)                                         |
| [F050](#f050) | 代码形状与阅读节奏   | P3 / 表达与测试可读性       | 高（静态判断；不代表动态复现）                                                                           | SSE 最后一帧的元数据投影与 wire framing 应是两个可见阶段                   | [`apps/server/src/conversation/event-stream.ts:331–340`](../apps/server/src/conversation/event-stream.ts#L331)           |
| [F051](#f051) | 代码形状与阅读节奏   | P3 / 可读性                 | 中高：需编译确认 inferred contract 可写                                                                  | completion 的可选字段用具名白名单对象组装                                  | [`apps/server/src/conversation/execution-receipts.ts:20–30`](../apps/server/src/conversation/execution-receipts.ts#L20)  |
| [F052](#f052) | 代码形状与阅读节奏   | P3 / 表达与测试可读性       | 高（静态判断；不代表动态复现）                                                                           | AG-UI frame identity 的消息维度先命名再组装                                | [`apps/server/src/conversation/public-run-events.ts:62–69`](../apps/server/src/conversation/public-run-events.ts#L62)    |
| [F053](#f053) | 代码形状与阅读节奏   | P3 / 表达与测试可读性       | 高（静态判断；不代表动态复现）                                                                           | 失败摘要与共用恢复步骤分开呈现，保留不同 reason                            | [`apps/server/src/conversation/public-run-events.ts:152–165`](../apps/server/src/conversation/public-run-events.ts#L152) |
| [F054](#f054) | 代码形状与阅读节奏   | P3 / 可读性                 | 高：两段循环保留原覆盖顺序，不需要假定相同键永远不存在                                                   | 终态 outcome map 用两段直接循环替代双链、spread 与 tuple 断言              | [`apps/server/src/db/conversations.ts:162–184`](../apps/server/src/db/conversations.ts#L162)                             |
| [F055](#f055) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | readActiveRuns 的 running / terminal SQL 用 SQL 自己的多行结构             | [`apps/server/src/db/conversations.ts:241–250`](../apps/server/src/db/conversations.ts#L241)                             |
| [F056](#f056) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | 活动 run 状态优先级用局部变量明确声明                                      | [`apps/server/src/db/conversations.ts:253–264`](../apps/server/src/db/conversations.ts#L253)                             |
| [F057](#f057) | 代码形状与阅读节奏   | P3 / 表达与测试可读性       | 高（静态判断；不代表动态复现）                                                                           | 完成消息写入的主体不必整段缩进在唯一 kind 条件内                           | [`apps/server/src/db/execution-events.ts:173–194`](../apps/server/src/db/execution-events.ts#L173)                       |
| [F058](#f058) | 代码形状与阅读节奏   | P3 / 表达与测试可读性       | 高（静态判断；不代表动态复现）                                                                           | 重放的五条 identity 对照不必先变成匿名 tuple 矩阵                          | [`apps/server/src/db/submissions.ts:146–152`](../apps/server/src/db/submissions.ts#L146)                                 |
| [F059](#f059) | 代码形状与阅读节奏   | P3 / 表达与测试可读性       | 高（静态判断；不代表动态复现）                                                                           | 保留位置的 upload 与 generated 策略用明确分支赋值                          | [`apps/server/src/db/submissions.ts:179–187`](../apps/server/src/db/submissions.ts#L179)                                 |
| [F060](#f060) | 代码形状与阅读节奏   | P3 / 可读性                 | 高                                                                                                       | OpenAPI SDK 兼容断言用一个 owner 内 type alias 表达                        | [`scripts/generate-api.ts:29–37`](../scripts/generate-api.ts#L29)                                                        |
| [F061](#f061) | 代码形状与阅读节奏   | P3 / 可读性                 | 高（静态证据；实际失败后果未运行复现）                                                                   | 关系完整性矩阵用具名 case，而不是依赖四槽 tuple 位置                       | [`tests/integration/relational-integrity.test.ts:180–217`](../tests/integration/relational-integrity.test.ts#L180)       |
| [F062](#f062) | 代码形状与阅读节奏   | P3 / 可读性                 | 高（静态证据；实际失败后果未运行复现）                                                                   | 三个 local model fixtures 只共享 SSE framing，答案与工具叙事继续各自独立   | [`tests/integration/runtime.test.ts:60–68`](../tests/integration/runtime.test.ts#L60)                                    |
| [F063](#f063) | 代码形状与阅读节奏   | P3 / 可读性                 | 高（静态证据；实际失败后果未运行复现）                                                                   | indexed corruption 场景的值选择显示真实 identity 来源，不用右移三元阶梯    | [`tests/integration/submission.test.ts:333–338`](../tests/integration/submission.test.ts#L333)                           |
| [F064](#f064) | 代码形状与阅读节奏   | P3 / 可维护性               | 高（静态证据；拟议实现未验证）                                                                           | 让四种fixture凭据旋转显示成四条sed clause                                  | [`tests/scripts/deployment-check.sh:159–163`](../tests/scripts/deployment-check.sh#L159)                                 |
| [F065](#f065) | 代码形状与阅读节奏   | P3 / 可维护性               | 高（静态证据；拟议实现未验证）                                                                           | 停止进程的diagnostic应只采集成一个快照                                     | [`tests/scripts/production-runtime.test.ts:228–236`](../tests/scripts/production-runtime.test.ts#L228)                   |
| [F066](#f066) | 代码形状与阅读节奏   | P3 / fixture 状态与表达形状 | 高：requests 的唯一消费者是 length                                                                       | 本地工具模型只记住 request ordinal，不维护无人读取的完整请求历史           | [`tests/storage/assets.test.ts:413–479`](../tests/storage/assets.test.ts#L413)                                           |
| [F067](#f067) | 测试与工具链的表达   | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | budget fixture 的闭合场景应与实际 admission 政策一致                       | [`apps/agent/src/harness/pi.test.ts:1224–1287`](../apps/agent/src/harness/pi.test.ts#L1224)                              |
| [F068](#f068) | 测试与工具链的表达   | P3 / 责任与表达可读性       | 高（静态判断）                                                                                           | WorkerProcess 的 shutdown promise 应有未完成 owned-task 回归               | [`apps/agent/src/worker.test.ts:5–43`](../apps/agent/src/worker.test.ts#L5)                                              |
| [F069](#f069) | 测试与工具链的表达   | P3 / 表达与测试可读性       | 高（静态判断；不代表动态复现）                                                                           | upload 文档测试应核对全部 MIME，而不是只测一正一负                         | [`apps/server/src/http.test.ts:18–25`](../apps/server/src/http.test.ts#L18)                                              |
| [F070](#f070) | 测试与工具链的表达   | P2 / 边界与验收             | 高（静态证据；拟议实现未验证）                                                                           | 无需凭据的脚本回归应有同一个本地/CI入口                                    | [`package.json:11–17`](../package.json#L11)                                                                              |
| [F071](#f071) | 测试与工具链的表达   | P3 / 表达与测试可读性       | 高（静态判断；不代表动态复现）                                                                           | native/foreign 一致性断言需要独立的预期真值                                | [`packages/contract/src/execution-schema.test.ts:34–68`](../packages/contract/src/execution-schema.test.ts#L34)          |
| [F072](#f072) | 测试与工具链的表达   | P2 / 边界与验收             | 高（静态证据；拟议实现未验证）                                                                           | native PUT测试需钉住immutable条件、metadata与单次尝试                      | [`packages/object-storage/src/objects.test.ts:30–72`](../packages/object-storage/src/objects.test.ts#L30)                |
| [F073](#f073) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | 第二个 administrative child 与第一个一样由 test owner 设 watchdog 并 join  | [`tests/integration/administration.test.ts:72–113`](../tests/integration/administration.test.ts#L72)                     |
| [F074](#f074) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | 迁移命令断言先证明 outbox/inbox 两份记录都保留，再检查独立 wire 形状       | [`tests/integration/assets-migration.test.ts:244–259`](../tests/integration/assets-migration.test.ts#L244)               |
| [F075](#f075) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | 清理序列复用现有 settleTestCleanup，而不是首个 DELETE 失败就跳过余项       | [`tests/integration/database.test.ts:6–24`](../tests/integration/database.test.ts#L6)                                    |
| [F076](#f076) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | fixture 的 abort 等待需与同文件 late-quarantine 场景一样处理已发生的 abort | [`tests/integration/execute-run.test.ts:136–140`](../tests/integration/execute-run.test.ts#L136)                         |
| [F077](#f077) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | 失去 fence 的慢 cleanup 测试必须在 assertion 失败后也释放 sandbox gate     | [`tests/integration/execute-run.test.ts:282–316`](../tests/integration/execute-run.test.ts#L282)                         |
| [F078](#f078) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | canonical inbox 的 oracle 不再对 actual 与 expected 同时运行被测 parser    | [`tests/integration/execution-store.test.ts:861–861`](../tests/integration/execution-store.test.ts#L861)                 |
| [F079](#f079) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | Postgres proxy 创建 owner 必须把 listen error 接到 setup Promise           | [`tests/integration/postgres-proxy-fixture.ts:41–44`](../tests/integration/postgres-proxy-fixture.ts#L41)                |
| [F080](#f080) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | 并发fixture接入应先收齐sibling结果，再按owner关闭Redis/SQL资源             | [`tests/integration/redis.test.ts:19–19`](../tests/integration/redis.test.ts#L19)                                        |
| [F081](#f081) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | SSE 顺序断言先证明两种事件都存在，避免 -1 充当正确先后                     | [`tests/integration/run-scoped-observation.test.ts:254–256`](../tests/integration/run-scoped-observation.test.ts#L254)   |
| [F082](#f082) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | runtime submit 的身份 setup rejection 不应跳过自己打开的数据库关闭         | [`tests/integration/runtime.test.ts:92–95`](../tests/integration/runtime.test.ts#L92)                                    |
| [F083](#f083) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | runtime answer polling 证明 assistant 消息，而非响应任意位置含有 canary    | [`tests/integration/runtime.test.ts:116–128`](../tests/integration/runtime.test.ts#L116)                                 |
| [F084](#f084) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | 会话到期三种场景创建的官方身份也应加入本套件清理账本                       | [`tests/integration/thread-lifecycle.test.ts:47–70`](../tests/integration/thread-lifecycle.test.ts#L47)                  |
| [F085](#f085) | 测试与工具链的表达   | P2 / 测试边界               | 高（静态证据；实际失败后果未运行复现）                                                                   | archive/send/replay barrier 在失败路径也收齐已发出的真实 writer            | [`tests/integration/thread-lifecycle.test.ts:295–316`](../tests/integration/thread-lifecycle.test.ts#L295)               |
| [F086](#f086) | 测试与工具链的表达   | P2 / 边界与验收             | 高（静态证据；拟议实现未验证）                                                                           | readiness polling同时拥有monotonic预算和每次请求截止                       | [`tests/scripts/deployment-web.test.ts:4–18`](../tests/scripts/deployment-web.test.ts#L4)                                |
| [F087](#f087) | 测试与工具链的表达   | P2 / 边界与验收             | 高（静态证据；拟议实现未验证）                                                                           | daemon probe需要在Docker client超时前登记可定位身份                        | [`tests/scripts/production-runtime.test.ts:157–179`](../tests/scripts/production-runtime.test.ts#L157)                   |
| [F088](#f088) | 测试与工具链的表达   | P3 / 测试叙述与职责         | 高：已完整读两份 storage tests；不是功能缺陷                                                             | 上传 fixture 只保证初始可用状态；重放和冲突应由命名测试自己拥有            | [`tests/storage/assets.test.ts:92–118`](../tests/storage/assets.test.ts#L92)                                             |
| [F089](#f089) | 测试与工具链的表达   | P2 / 边界与验收             | 高（静态证据；拟议实现未验证）                                                                           | 可执行CI TypeScript应进入现有compiler/lint边界                             | [`tsconfig.json:30–36`](../tsconfig.json#L30)                                                                            |

## 5. 逐项对照：现在 → 为什么不好 → 怎么改 → 改后形状

### 架构设计与事实归属

<a id="f001"></a>

#### F001 — 能力合同不要成为执行入口前的 147 行类型墙

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`execution capability declarations`。

**现在（连续原文）** — [`apps/agent/src/execute-run.ts:1–147`](../apps/agent/src/execute-run.ts#L1)

```ts
import { HistoryLimitError } from './harness/pi-history'
import type { WebSource } from '@vid/contract/web-source'
import type { AssetReference } from '@vid/contract/execution'
import type { NativeSandboxReference } from './sandbox/reference'

/** A database-issued execution capability. The fence/owner must remain valid for every write. */
export type ExecutionLease = Readonly<{
  runID: string
  threadID: string
  text: string
  fence: number
  ownerID: string
  history: unknown
  assets?: readonly AssetReference[]
  nativeRef?: NativeSandboxReference
}>

/** Tool operations address only the worker-assigned sandbox, never a host path or container ID. */
export interface SandboxTools {
  /** Uses supported command abort/kill; unknown mutative outcomes reject.
   * Does not promise process-tree or external paid-job cancellation. */
  execute: (
    request: Readonly<{ command: string; signal: AbortSignal }>,
  ) => Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>>
  read: (
    request: Readonly<{ path: string; signal: AbortSignal }>,
  ) => Promise<string>
  write: (
    request: Readonly<{ path: string; content: string; signal: AbortSignal }>,
  ) => Promise<void>
}

/** Vendor-independent business capabilities of the lease-assigned sandbox session,
 * not a provider registry or a replica of the native SDK surface. */
export interface SandboxSessionPort extends SandboxTools, SandboxFiles {
  /** Opaque native identity; execution persists it without interpreting provider details. */
  nativeRef: NativeSandboxReference
  /** Pauses after the caller finishes its tools; unknown mutative outcomes reject. Neither external job cancellation nor durable artifact proof. */
  close: () => Promise<void>
}

export interface SandboxFiles {
  readBytes: (
    path: string,
    signal: AbortSignal,
    maxBytes: number,
  ) => Promise<Uint8Array>
  writeBytes: (
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) => Promise<void>
}

export interface AgentHarness {
  /** Uses bounded Pi abort and cleanup, without remote settlement guarantees. */
  turn: (
    request: Readonly<{
      text: string
      history: unknown
      tools: SandboxTools
      signal: AbortSignal
      fileTools?: FileTools
      onText: (delta: string) => void
    }>,
  ) => Promise<
    Readonly<{ text: string; history: unknown; sources?: readonly WebSource[] }>
  >
}

export type ExecutionFailure = 'execution-error' | 'interrupted'
export type ExecutionCompletion = {
  sources?: readonly WebSource[] | undefined
  text: string
  history: unknown
  assets?: readonly AssetReference[]
}

export interface ExecutionWrites {
  saveSandbox: (
    lease: ExecutionLease,
    reference: NativeSandboxReference,
  ) => Promise<boolean>
  quarantine: (
    lease: ExecutionLease,
    reason?: ExecutionFailure,
  ) => Promise<void>

  renew: (
    lease: ExecutionLease,
    leaseMs: number,
  ) => Promise<'renewed' | 'cancel' | 'lost' | 'recovery-required'>
  appendText: (lease: ExecutionLease, delta: string) => Promise<boolean>

  complete: (
    lease: ExecutionLease,
    completion: ExecutionCompletion,
  ) => Promise<boolean | ExecutionOutcome>
  fail: (
    lease: ExecutionLease,
    reason: ExecutionFailure,
  ) => Promise<boolean | ExecutionOutcome>
  cancel: (lease: ExecutionLease) => Promise<boolean | ExecutionOutcome>
}

/** Per-run file authority; the harness implements it, execution owns its result. */
export interface FileTools {
  assigned: readonly AssetReference[]
  prepared: readonly AssetReference[]
  importFile: (request: {
    assetID: string
    path: string
    signal: AbortSignal
  }) => Promise<{ bytes: Uint8Array; mimeType: string }>
  exportFile: (request: {
    path: string
    name: string
    mimeType: string
    signal: AbortSignal
  }) => Promise<AssetReference>
  hasUnknownOutcome: () => boolean
}

export type ExecuteRunDependencies = Readonly<{
  writes: ExecutionWrites
  fileTools?: (
    lease: ExecutionLease,
    sandbox: SandboxSessionPort,
    stopSpending: () => void,
  ) => FileTools
  harness: AgentHarness
  /** The assigned allocator owns connection settings and awaits failed-allocation cleanup. */
  openSandbox: (
    lease: ExecutionLease,
    signal: AbortSignal,
  ) => Promise<SandboxSessionPort>
}>

export type ExecuteRunOptions = Readonly<{
  leaseMs: number
  pollMs: number
  runTimeoutMs?: number
  /** Worker shutdown, not the database's cancellation authority. */
  signal: AbortSignal
}>

export type ExecutionOutcome = 'completed' | 'cancelled' | 'failed' | 'lost'
```

##### F001：为什么不好

execute-run.ts 同时是实际一轮执行的 owner 和 147 行公共能力合同的 import home；sandbox、harness、DB、scheduler 都反向 import 此入口的 types，真正可执行流程直到 443 行才出现。问题不是存在 interface，而是消费合同与执行实现的导航耦合；main.ts 38 行本身已经是窄 process adapter，不应继续抽空 main 或建 service 层。

**Handover 实际对照** — [`apps/cli/src/agents/agent.ts:1–76`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/agents/agent.ts#L1-L76)

reference 把 Agent/Talk/Asked 放在真实 adapter 合同 owner，answering/checking-in 消费它；本项目不是复制 reference 的 wire/CLI vocabulary。

```ts
import type { components } from '../../generated/api.ts'

/**
 * What it takes to drive one agent.
 *
 * An adapter implements this and nothing else. Ordering, persistence, idempotency, retries and
 * the three outcomes belong to the caller — an adapter that reaches for any of them has taken
 * over a decision that is not its to make.
 *
 * Adding an agent takes five changes, not the two this once claimed — the list lives in
 * `docs/roadmap/03-talking-to-an-agent/design.md`, "加一个 agent 要做什么", and is not copied here
 * because a copy is how it went back to saying two. Two of the five fail late: a new adapter runs
 * a whole turn and is then refused at the write.
 */

export type Agent = {
  /**
   * The command this drives, as it is found on the PATH.
   *
   * Said by the adapter because the adapter is what has to run it. Discovery reports by command
   * and the server hands out work by kind, so something has to pair them; the one place that
   * cannot get it wrong is the file that spawns the thing.
   */
  readonly command: string

  /**
   * What this agent lets a person choose, as it reports it right now.
   *
   * Empty means it does not let you choose, and the page then has no control to show. Agents
   * differ here and that is the honest answer: picking an agent is picking what it can do.
   */
  readonly offers: (where: string) => Promise<readonly Model[]>

  /**
   * Begin one turn, or pick up a conversation this agent still remembers.
   *
   * One turn per {@link Talk}: `sofar` is fixed when it is made, so a second turn asks for a new
   * one with whatever session the first turn reported.
   */
  readonly talk: (where: string, sofar: string | null) => Talk
}

/**
 * One thing this agent lets a person choose for a single question.
 *
 * The wire's shape, not a second one beside it. What an adapter reports here is reported to the
 * server verbatim, so a copy written out here would be a copy that could disagree with the thing
 * it is sent as — and the compiler would have no way to say which of the two was right.
 */
export type Model = components['schemas']['Model']

export type Talk = {
  /**
   * Say one thing, and report what happens until the agent is done.
   *
   * Never throws. Both SDKs report every kind of trouble by throwing, and what they throw is not
   * fit to show anyone; catching it here is what keeps a `try` out of every caller.
   */
  readonly say: (asked: Asked) => AsyncIterable<Told>

  /**
   * Ask it to stop what it is doing.
   *
   * The turn ends as `cancelled` rather than failed, and the conversation can be picked up again
   * afterwards — a person who interrupts wants to redirect it, not to lose it.
   */
  readonly stop: () => Promise<void>
}

/** What a person said, in the same words the server keeps it in. */
export type Asked = {
  readonly text: string
  /** Absent leaves the agent on its own default. We never choose one on its behalf. */
  readonly model?: string
  readonly effort?: string
}
```

##### F001：应该怎么改

将现有公共合同原样移到一个 execution-contract.ts（明确的能力边界，不是 barrel），所有现有 type-only 消费者直接改 import；executeRun 的行为和私有状态仍在原文件。类型名和接口不改，不增加 provider registry。下面包含新模块完整正文及原入口替换 import。 如消费方没有导航痛点，仅把executeRun公共入口前置也是更小选择；不要为了满足行数阈值把每个能力再拆一个文件。此模块必须对应现有多方真实合同消费者，不创建备用实现。

##### F001：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
// New file: apps/agent/src/execution-contract.ts
import type { WebSource } from '@vid/contract/web-source'
import type { AssetReference } from '@vid/contract/execution'
import type { NativeSandboxReference } from './sandbox/reference'

/** A database-issued execution capability. The fence/owner must remain valid for every write. */
export type ExecutionLease = Readonly<{
  runID: string
  threadID: string
  text: string
  fence: number
  ownerID: string
  history: unknown
  assets?: readonly AssetReference[]
  nativeRef?: NativeSandboxReference
}>

/** Tool operations address only the worker-assigned sandbox, never a host path or container ID. */
export interface SandboxTools {
  /** Uses supported command abort/kill; unknown mutative outcomes reject.
   * Does not promise process-tree or external paid-job cancellation. */
  execute: (
    request: Readonly<{ command: string; signal: AbortSignal }>,
  ) => Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>>
  read: (
    request: Readonly<{ path: string; signal: AbortSignal }>,
  ) => Promise<string>
  write: (
    request: Readonly<{ path: string; content: string; signal: AbortSignal }>,
  ) => Promise<void>
}

/** Vendor-independent business capabilities of the lease-assigned sandbox session,
 * not a provider registry or a replica of the native SDK surface. */
export interface SandboxSessionPort extends SandboxTools, SandboxFiles {
  /** Opaque native identity; execution persists it without interpreting provider details. */
  nativeRef: NativeSandboxReference
  /** Pauses after the caller finishes its tools; unknown mutative outcomes reject. Neither external job cancellation nor durable artifact proof. */
  close: () => Promise<void>
}

export interface SandboxFiles {
  readBytes: (
    path: string,
    signal: AbortSignal,
    maxBytes: number,
  ) => Promise<Uint8Array>
  writeBytes: (
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) => Promise<void>
}

export interface AgentHarness {
  /** Uses bounded Pi abort and cleanup, without remote settlement guarantees. */
  turn: (
    request: Readonly<{
      text: string
      history: unknown
      tools: SandboxTools
      signal: AbortSignal
      fileTools?: FileTools
      onText: (delta: string) => void
    }>,
  ) => Promise<
    Readonly<{ text: string; history: unknown; sources?: readonly WebSource[] }>
  >
}

export type ExecutionFailure = 'execution-error' | 'interrupted'
export type ExecutionCompletion = {
  sources?: readonly WebSource[] | undefined
  text: string
  history: unknown
  assets?: readonly AssetReference[]
}

export interface ExecutionWrites {
  saveSandbox: (
    lease: ExecutionLease,
    reference: NativeSandboxReference,
  ) => Promise<boolean>
  quarantine: (
    lease: ExecutionLease,
    reason?: ExecutionFailure,
  ) => Promise<void>

  renew: (
    lease: ExecutionLease,
    leaseMs: number,
  ) => Promise<'renewed' | 'cancel' | 'lost' | 'recovery-required'>
  appendText: (lease: ExecutionLease, delta: string) => Promise<boolean>

  complete: (
    lease: ExecutionLease,
    completion: ExecutionCompletion,
  ) => Promise<boolean | ExecutionOutcome>
  fail: (
    lease: ExecutionLease,
    reason: ExecutionFailure,
  ) => Promise<boolean | ExecutionOutcome>
  cancel: (lease: ExecutionLease) => Promise<boolean | ExecutionOutcome>
}

/** Per-run file authority; the harness implements it, execution owns its result. */
export interface FileTools {
  assigned: readonly AssetReference[]
  prepared: readonly AssetReference[]
  importFile: (request: {
    assetID: string
    path: string
    signal: AbortSignal
  }) => Promise<{ bytes: Uint8Array; mimeType: string }>
  exportFile: (request: {
    path: string
    name: string
    mimeType: string
    signal: AbortSignal
  }) => Promise<AssetReference>
  hasUnknownOutcome: () => boolean
}

export type ExecuteRunDependencies = Readonly<{
  writes: ExecutionWrites
  fileTools?: (
    lease: ExecutionLease,
    sandbox: SandboxSessionPort,
    stopSpending: () => void,
  ) => FileTools
  harness: AgentHarness
  /** The assigned allocator owns connection settings and awaits failed-allocation cleanup. */
  openSandbox: (
    lease: ExecutionLease,
    signal: AbortSignal,
  ) => Promise<SandboxSessionPort>
}>

export type ExecuteRunOptions = Readonly<{
  leaseMs: number
  pollMs: number
  runTimeoutMs?: number
  /** Worker shutdown, not the database's cancellation authority. */
  signal: AbortSignal
}>

export type ExecutionOutcome = 'completed' | 'cancelled' | 'failed' | 'lost'
```

execute-run.ts替换原147行类型定义后，实际实现所消费的imports；其他生产/测试调用者直接迁移到contract模块。不保留旧入口barrel。

```ts
import { HistoryLimitError } from './harness/pi-history'
import type {
  ExecutionLease,
  SandboxSessionPort,
  ExecutionFailure,
  ExecutionCompletion,
  FileTools,
  ExecuteRunDependencies,
  ExecuteRunOptions,
  ExecutionOutcome,
} from './execution-contract'
```

**不能改变的事实**：只移动类型，不改变 DB fence、SDK 工具能力、私有 unknown history 或 single cleanup owner；NativeSandboxReference 保持官方 provider opaque identity。

**实施时的验证要求**：sh scripts/check.sh；sh scripts/check.sh test apps/agent/src/execute-run.test.ts apps/agent/src/run-loop.test.ts；检查所有消费者 type-only import，无新增运行时依赖。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f002"></a>

#### F002 — stop reason 优先级是一条纯规则，不是 abort 副作用里的条件拼接

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`stop`。

**现在（连续原文）** — [`apps/agent/src/execute-run.ts:164–178`](../apps/agent/src/execute-run.ts#L164)

```ts
function stop(execution: Execution, reason: StopReason) {
  // Fencing loss dominates: this worker must never attempt a stale terminal mutation.
  if (execution.reason === 'lost') return
  if (
    execution.reason === undefined ||
    reason === 'lost' ||
    reason === 'execution-error' ||
    (reason === 'cancel' && execution.reason === 'interrupted')
  ) {
    execution.reason = reason
  }
  execution.pendingText = ''
  execution.pendingBytes = 0
  execution.controller.abort()
}
```

##### F002：为什么不好

lost 吸收一切、execution-error 覆盖 cancel/interrupted、cancel 覆盖 interrupted 是影响终态和是否 quarantine 的实际政策。当前布尔 OR 与清空/abort 紧贴，读者必须同时模拟优先级与同步副作用；该规则应能逐组合测试，而不是靠计时 race 测试间接覆盖。

**Handover 实际对照** — [`apps/cli/src/agents/claude-code.ts:293–335`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/agents/claude-code.ts#L293-L335)

reference 明确将 accepted interrupt 与终态转换区分成 accepted/asStopped；其取消可恢复政策不等同本项目未知 VM 结果。

```ts
 * Interrupting leaves the conversation alive to be picked up again; killing the process would not.
 * Somebody who stops an agent means to redirect it, not to lose it.
 *
 * Only an accepted interrupt counts, because accepting is what rewrites the ending as cancelled.
 * Assumed rather than asked, an interrupt that was refused — an older CLI, a turn already over —
 * would put "you stopped it" in the record for a turn that ran to the end. That is the one thing
 * the transcript exists to make visible: asked to stop, and did not.
 */
async function accepted(running: ReturnType<typeof query> | undefined): Promise<boolean> {
  if (running === undefined) return false

  return running.interrupt().then(
    () => true,
    () => false,
  )
}

/** A turn that ended only because the session it was told to pick up is gone. */
function forgotten(told: Told): boolean {
  return told.told === 'ended' && told.why.why === 'failed' && looksForgotten(told.why.said)
}

/** What a turn somebody asked to stop ends as, however the CLI happened to report it. */
const STOPPED = { told: 'ended', why: { why: 'cancelled' } } as const

const asStopped = (told: Told): Told => (told.told === 'ended' ? STOPPED : told)

/**
 * Everything one query said, until it says the session it was told to pick up is gone.
 *
 * An interrupt does not always arrive as a throw: asked to stop part way through, the CLI
 * finishes the turn normally and reports an error result. Both paths mean the same thing, and
 * only we know which it was — we are the ones who asked.
 */
async function* everythingItSaid(
  asking: ReturnType<typeof query>,
  resume: string | null,
  /** Read each time, not once: somebody can ask it to stop while this is still running. */
  interrupted: () => boolean,
): AsyncGenerator<Told, boolean> {
  const translate = fold()

  for await (const message of asking) {
```

##### F002：应该怎么改

提取只拥有优先级的纯函数 preferredStopReason，保留当前 lost 早返（不能为了整齐让 lost 再做其他副作用）。不是泛化状态机；含undefined初始状态的20组闭合输入可 table test。

##### F002：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
function preferredStopReason(
  current: StopReason | undefined,
  requested: StopReason,
): StopReason {
  if (current === undefined || requested === 'lost') return requested
  if (current === 'lost') return current
  if (requested === 'execution-error') return requested
  if (requested === 'cancel' && current === 'interrupted') return requested
  return current
}

function stop(execution: Execution, reason: StopReason) {
  if (execution.reason === 'lost') return
  execution.reason = preferredStopReason(execution.reason, reason)
  execution.pendingText = ''
  execution.pendingBytes = 0
  execution.controller.abort()
}
```

**不能改变的事实**：逐组合等价；lost 永远禁止 stale terminal mutation；abort spending 不结束 SQL renewal；未知 IO 不变成成功取消。

**实施时的验证要求**：sh scripts/check.sh test apps/agent/src/execute-run.test.ts；新增包括undefined初值的全部20个current/requested组合和 lost 吸收性测试，保留取消/失败/heartbeat 并发回归。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f003"></a>

#### F003 — Pi 的 admission 与 cleanup 政策命名，明确不是 SDK 原生保证

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`runTurn budget state / admitDelta`。

**现在（连续原文）** — [`apps/agent/src/harness/pi.ts:219–258`](../apps/agent/src/harness/pi.ts#L219)

```ts
  let budgetError: Error | undefined
  let aborting: Promise<void> | undefined
  let session: AgentSession
  const abort = () => {
    aborting ??= session.abort()
    void aborting.catch(() => {})
  }
  const refuse = () => {
    budgetError ??= new Error('Pi turn budget exceeded')
    abort()
  }
  const onLimit = (): never => {
    refuse()
    throw budgetError
  }
  session = await assignedSession(options, manager, input, {
    onSources,
    onLimit,
  })
  let iterations = 0
  let deltas = 0
  let failed = false
  const admitDelta = (delta: AssistantMessageEvent) => {
    if (
      delta.type !== 'text_delta' &&
      delta.type !== 'thinking_delta' &&
      delta.type !== 'toolcall_delta'
    )
      return
    const bytes = Buffer.byteLength(delta.delta)
    deltas += bytes
    if (deltas > 2 * 1024 * 1024) refuse()
  }
  const unsubscribe = session.subscribe((event) => {
    // Subscribers are synchronous. Retain abort's idle receipt; never await it here.
    if (event.type === 'turn_start') {
      if (++iterations > 16) refuse()
      return
    }
    if (event.type === 'message_end') {
```

##### F003：为什么不好

16 iteration、2MiB decoded delta、10s cleanup wait 分散在回调和 finally，另有 file-tools 的 1MiB image。Pi adapter 确实同时承载本项目 model-turn admission 政策，这是合理 owner，但当前裸字面量让读者难区分 SDK transport/RSS 能力与应用有限支出政策。不要以“纯 adapter”名义把这些保护删掉。

**Handover 实际对照** — [`apps/cli/src/agents/codex-app-server.ts:23–25`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/agents/codex-app-server.ts#L23-L25)

reference 明确命名 STDERR_LIMIT/MAX_PENDING_NOTIFICATIONS，表示实际本地 transport buffering policy；不是与本项目 spending bounds 等价。

```ts
const STDERR_LIMIT = 4000
const MAX_PENDING_NOTIFICATIONS = 256
const RESUME_PENDING_NOTIFICATIONS = MAX_PENDING_NOTIFICATIONS / 2
```

##### F003：应该怎么改

在 Pi owner 内命名三个常量（image admission 仍留 file-tools owner），替换三个使用表达式。不要抽 provider-neutral budget framework、不要把 UTF8/history/pending text 合并 cap 或新增 env。

##### F003：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
const maxTurnIterations = 16
const maxDecodedDeltaBytes = 2 * 1024 * 1024
const cancellationWaitMs = 10000
```

turn_start与admitDelta两个已有分支内各自完整statement替换（这些片段并非顺序放在同一callback）。

```ts
if (++iterations > maxTurnIterations) refuse()
if (deltas > maxDecodedDeltaBytes) refuse()
```

cleanup finally内原timer赋值完整替换。

```ts
timer = setTimeout(
  () => reject(new Error('Pi cancellation deadline exceeded')),
  cancellationWaitMs,
)
```

**不能改变的事实**：订阅同步 refuse，SDK abort receipt 单一 owner，已解析当前 event 内存不伪称硬 transport cap；16 iteration、2MiB、10s 数值及 paid no-retry 保留。

**实施时的验证要求**：sh scripts/check.sh test apps/agent/src/harness/pi.test.ts apps/agent/src/execute-run.test.ts；保留 thinking/toolcall_delta/iterations 和 fatal sibling join tests。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f004"></a>

#### F004 — OpenAPI 引用名字应由现有 schema owner 约束，而非任意 string

- **优先级**：P2 / 边界与合同可维护性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`json(name)`。

**现在（连续原文）** — [`apps/server/src/http.ts:60–62`](../apps/server/src/http.ts#L60)

```ts
const json = (name: string) => ({
  'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
})
```

##### F004：为什么不好

json(name:string)接收任意组件名并拼$ref。真实 publicSchemas 和 inboundNames 已在 contract 拥有名字集合，但路由看不到这份类型；拼错MessageAccepted仍通过TypeScript直到离线生成/foreign引用回归才被发现。无需搬来Handover整套路由DSL，只把现有跨模块名字绑定。

**Handover 实际对照** — [`apps/server/src/server/route.ts:50–69`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/route.ts#L50-L69)

Actual takes/sends receive Zod schema instances, so metadata is tied to the schema owner. Our hono-openapi adapter can bind names without transplanting their route framework.

```ts
function takes<T extends z.ZodType>(schema: T) {
  return { content: { 'application/json': { schema } }, required: true }
}

/**
 * Answers a request this route could not parse in its own words.
 *
 * The app-wide answer is right nearly everywhere — a malformed body is the same thing at every
 * route. It is wrong exactly where the malformed thing is an identifier, because there the caller
 * has somewhere to go, and it is the same somewhere they are sent when the identifier is merely
 * one they may not have.
 */
function insteadOfMalformed<E extends Env>(failure: Failure) {
  return (result: { success: boolean }, c: Context<E>) =>
    result.success ? undefined : refused(c, failure)
}

export function sends<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } }
}
```

##### F004：应该怎么改

contract 用 owner 私有 inboundNames literal tuple 派生 PublicSchemaName 联合；只导出实际 server 消费的类型，不新增无消费者的 runtime tuple export。Set 继续用于运行时生成。json 参数使用这个联合，路由与 generation 内容不变。第三批用真实 route clone 的 compiler typo red/green 验证，而非普通 expectTypeOf 运行时断言。

##### F004：改完之后的形状（拟议，未实施）

```ts
// contract/http.ts: replace the inboundNames declaration with:
const inboundSchemaNames = [
  'UUID',
  'EmptyRequest',
  'ThreadCreation',
  'ThreadUpdate',
  'MessageSubmission',
  'RunCancellation',
] as const satisfies readonly (keyof typeof publicSchemas)[]
const inboundNames: ReadonlySet<string> = new Set(inboundSchemaNames)
export type PublicSchemaName =
  keyof typeof publicSchemas | `${(typeof inboundSchemaNames)[number]}Input`

// server/http.ts: import type PublicSchemaName; replace the entire helper:
const json = (name: PublicSchemaName) => ({
  'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
})
```

**不能改变的事实**：现有publicSchemas及inboundNames集合/生成内容不变；仅把合法组件名集合升为静态类型，json(name)输出结构不变，不引入路由DSL或手写schema镜像。新增export应有真实server消费者，校验不得扩散为每次反复parse。

**实施时的验证要求**：sh scripts/check.sh; packages/contract/src/http.test.ts reference-resolution and inbound mirror tests; apps/server/src/http.test.ts offline route tests. Use an actual project compiler negative test on the route reference; require the intended argument-type diagnostic, not a missing import or a mirrored union.

**当前验证状态**：Static evidence only; proposed AFTER is not implemented, compiled or run. No functional failure is claimed reproduced.

<a id="f005"></a>

#### F005 — 上传的授权预检仍由路由直接拥有 SQL 事务

- **优先级**：P2 / 边界与合同可维护性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`upload route handler`。

**现在（连续原文）** — [`apps/server/src/http.ts:491–494`](../apps/server/src/http.ts#L491)

```ts
      await c.env.db
        .transaction()
        .execute((tx) => lockThread(tx, query, 'write'))
      return await uploadAsset(c.env.db, query, c.req.raw, c.env.files)
```

##### F005：为什么不好

这个入口直接创建 transaction 并调用 lockThread；而实际 body/signature/store orchestration 在 assets/http.ts，最终权威又在 reserveAsset/completeAsset。预检是为了在收集大 body 前拒绝越权，不能删除；但路由因此成为唯一直接拥有上传事务的 transport 分支，独立调用 uploadAsset 则没有同样的前置门。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:466–488`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L466-L488)

Handover reporting calls machineSays; DB owns stillItsToWriteOn. Preserve our separate pre-body admission and multi-phase remote upload rather than copying its single machine-write transaction.

```ts
function reporting({ db }: ConversationApi) {
  return aMachine(db).post('/machines/current/conversations/{id}/messages', {
    summary: 'Add what the agent said or did',
    params: { id: rowId },
    body: MachineMessage,
    answers: {
      204: 'Written, or already written',
      404: refuses(UNAVAILABLE, 'That conversation was not given to this machine'),
    },

    run: async (c) => {
      const sent = c.req.valid('json')
      const written = await machineSays(db, {
        conversationId: c.req.valid('param').id,
        machineId: c.get('machineId'),
        key: sent.key,
        message: sent.message,
      })

      return written.kind === 'no-conversation' ? refused(c, UNAVAILABLE) : nothing(c, 204)
    },
  })
}
```

##### F005：应该怎么改

把相同预检移动到 uploadAsset 开头；路由只选定 query/capability。保留 reservation/completion 锁内重新授权，预检绝非最终 authority。AFTER 给出路由 handler 替换与 assets/http.ts 的完整函数替换；新增 lockThread import。 同时删除root http.ts中若已无人用的lockThread导入，不保留预检转发壳。错误仍由root的既有catch映射；不把移动后的函数误当永远返回Response。

##### F005：改完之后的形状（拟议，未实施）

```ts
;async (c) => {
  const query = ownedThread(c)
  if (!query || !c.env.files) return unavailable()
  return await uploadAsset(c.env.db, query, c.req.raw, c.env.files)
}

// In assets/http.ts, import lockThread from '../db/thread-access'.
export async function uploadAsset(
  db: Kysely<DB>,
  query: OwnedThread,
  request: Request,
  io: FileHTTP,
) {
  await db.transaction().execute((tx) => lockThread(tx, query, 'write'))
  const metadata = uploadMetadata(request)
  if (metadata === null || !request.body)
    return Response.json({ error: 'Invalid upload metadata' }, { status: 400 })
  const signal = AbortSignal.any([
    io.signal,
    request.signal,
    AbortSignal.timeout(io.timeoutMs),
  ])
  let bytes: Uint8Array
  try {
    bytes = await collectRequestBody(request.body, io.maxAssetBytes, signal)
  } catch (cause) {
    const rejection = requestBodyRejection(cause)
    if (rejection) return rejection
    throw cause
  }
  if (!validateFile(metadata.name, metadata.mimeType, bytes))
    return Response.json({ error: 'Invalid file' }, { status: 415 })
  const completion = await publishUpload(
    db,
    query,
    { ...metadata, bytes },
    { ...io, signal },
  )
  if (completion === null)
    return Response.json(
      { error: 'Upload not confirmed. Retry the same asset ID and file.' },
      { status: 503 },
    )
  return Response.json({ asset: completion.asset } satisfies AssetResponse, {
    status: completion.created ? 201 : 200,
  })
}
```

**不能改变的事实**：在收集request body前仍先做thread write预检；预检不授予最终权限，reserveAsset/completeAsset锁内再次授权原样保留。route整体catch对threadUnavailable的404、archiveConflict的409映射不变；独立uploadAsset调用者也必须采用同一错误合同。body预算、signature、PUT确认、固定assetID与unknown receipt503不动。

**实施时的验证要求**：未来 sh scripts/database-check.sh test 运行真实SQL集成；tests/storage/assets.test.ts覆盖foreign/Origin/archive/no-effects和unknown PUT。新增直接uploadAsset调用的foreign/archive预body拒绝测试。只做单元sh scripts/check.sh不能替代这些SQL/S3证据。

**当前验证状态**：Static source comparison only. AFTER is proposed, not implemented, compiled or functionally reproduced.

<a id="f006"></a>

#### F006 — 将Compose中的特权storage init正文作为可检查Bash源

- **优先级**：P2 / 边界与验收。
- **适用置信度**：高（静态证据；拟议实现未验证）。
- **符号**：`storage-init Bash program embedded in Compose`。

**现在（连续原文）** — [`compose.yaml:120–168`](../compose.yaml#L120)

```yaml
    entrypoint: [bash, -ec]
    command:
      - |
        # External S3 is operator-provisioned, never managed with local root.
        [ "$$OBJECT_STORAGE_URL" = http://objects:9000 ] || exit 0
        set -o pipefail
        stage=input
        trap \
          'echo "Local object storage initialization failed: $$stage" >&2' ERR
        umask 077
        export MC_CONFIG_DIR=/run/storage/client
        bucket=$$OBJECT_STORAGE_BUCKET
        [[ "$$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$$ ]]
        [[ "$$bucket" != *..* && "$$bucket" != *.-* && "$$bucket" != *-.* ]]
        [[ ! "$$bucket" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$$ ]]
        [ "$$SERVER_ACCESS_KEY" != "$$WORKER_ACCESS_KEY" ]
        [ "$$SERVER_ACCESS_KEY" != "$$MINIO_ROOT_USER" ]
        [ "$$WORKER_ACCESS_KEY" != "$$MINIO_ROOT_USER" ]
        stage=alias
        printf '%s\n%s\n' "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" |
          mcli alias set local http://objects:9000 --api S3v4 --path on \
          >/dev/null 2>&1
        unset MINIO_ROOT_USER MINIO_ROOT_PASSWORD
        stage=bucket
        mcli mb --ignore-existing "local/$$bucket" >/dev/null 2>&1
        # Canonical full-JSON template contract: this reserved ARN prefix occurs
        # only at Resource bucket slots. Real-JSON conformance is gated by
        # tests/scripts/storage-initialization.test.ts; not a generic renderer.
        slot='arn:aws:s3:::vid-assets/'
        for role in server worker; do
          stage=$$role-policy
          policy=$$(cat "/policies/$$role-policy.json" 2>/dev/null)
          printf '%s\n' "$${policy//"$$slot"/"arn:aws:s3:::$$bucket/"}" \
            > "/run/storage/$$role.json"
          mcli admin policy create local "$$role" \
            "/run/storage/$$role.json" >/dev/null 2>&1
        done
        stage=server-principal
        printf '%s\n%s\n' "$$SERVER_ACCESS_KEY" "$$SERVER_SECRET_KEY" |
          mcli admin user add local >/dev/null 2>&1
        stage=worker-principal
        printf '%s\n%s\n' "$$WORKER_ACCESS_KEY" "$$WORKER_SECRET_KEY" |
          mcli admin user add local >/dev/null 2>&1
        stage=server-attach
        mcli admin policy attach local server --user "$$SERVER_ACCESS_KEY" \
          >/dev/null 2>&1
        stage=worker-attach
        mcli admin policy attach local worker --user "$$WORKER_ACCESS_KEY" \
          >/dev/null 2>&1
```

##### F006：为什么不好

YAML内嵌46行管理程序混合双美元、缩进、Bash替换、regex、secret pipe及七个failure stages。测试先逆转dollar escaping才执行；现有shell lint只枚举*.sh，该真实privileged程序不在shell-source边界。

**Handover 实际对照** — [`deploy/compose.yml:44–70`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/deploy/compose.yml#L44-L70)

reference用短生命周期deployment job创建native bucket。它较小的inline命令不证明本项目role/policy程序无需shell检查，也不复制root-app credentials或release profile。

```yaml
  # Making the bucket is this deployment's job, not the server's: production credentials may be
  # allowed to read and write objects without being allowed to create buckets.
  #
  # A release step, for the same reason the migrations are one — and it used to be neither. Left
  # to `up`, it ran on every start, nothing read its exit code, and a `mc mb` that failed was a
  # bucket that did not exist with nobody saying so: the first word anybody got was an upload
  # failing days later. Behind a profile it does not start with everything else; `release.sh` asks
  # for it by name and stops if it fails.
  objects-ready:
    profiles: ['release']
    image: minio/mc:RELEASE.2025-08-13T08-35-41Z
    depends_on:
      objects:
        condition: service_healthy
    entrypoint:
      - /bin/sh
      - -c
      - >-
        mc alias set here http://objects:9000 "$$OBJECT_STORE_ACCESS_KEY" "$$OBJECT_STORE_SECRET_KEY" &&
        mc mb --ignore-existing here/"$$OBJECT_STORE_BUCKET"
    environment:
      OBJECT_STORE_ACCESS_KEY: ${OBJECT_STORE_ACCESS_KEY:?}
      OBJECT_STORE_SECRET_KEY: ${OBJECT_STORE_SECRET_KEY:?}
      # No default here. `env.ts` refuses to invent one because a process that guessed a bucket
      # could write a valid object into the wrong deployment; inventing one here would put that
      # guess back, one layer down.
      OBJECT_STORE_BUCKET: ${OBJECT_STORE_BUCKET:?the bucket must be set}
```

##### F006：应该怎么改

正文原样移到deploy/storage/initialize.sh，由现有readonly /policies mount与bash执行；为该文件选择bash -n/shellcheck。tests改为实际文件/service command，而非重写dollars；不改init job、secret、tmpfs、depends_on或JSON policy。

##### F006：改完之后的形状（拟议，未实施）

compose.yaml storage-init服务原entrypoint与command两个属性的完整replacement；只显示这个局部service子集。

```yaml
entrypoint: [bash]
command: [/policies/initialize.sh]
```

新文件deploy/storage/initialize.sh完整Bash正文，原YAML dollar escaping仅去掉一层，执行逻辑不变。

```bash
#!/usr/bin/env bash
set -e
# External S3 is operator-provisioned, never managed with local root.
[ "$OBJECT_STORAGE_URL" = http://objects:9000 ] || exit 0
set -o pipefail
stage=input
trap \
  'echo "Local object storage initialization failed: $stage" >&2' ERR
umask 077
export MC_CONFIG_DIR=/run/storage/client
bucket=$OBJECT_STORAGE_BUCKET
[[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]
[[ "$bucket" != *..* && "$bucket" != *.-* && "$bucket" != *-.* ]]
[[ ! "$bucket" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
[ "$SERVER_ACCESS_KEY" != "$WORKER_ACCESS_KEY" ]
[ "$SERVER_ACCESS_KEY" != "$MINIO_ROOT_USER" ]
[ "$WORKER_ACCESS_KEY" != "$MINIO_ROOT_USER" ]
stage=alias
printf '%s\n%s\n' "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" |
  mcli alias set local http://objects:9000 --api S3v4 --path on \
  >/dev/null 2>&1
unset MINIO_ROOT_USER MINIO_ROOT_PASSWORD
stage=bucket
mcli mb --ignore-existing "local/$bucket" >/dev/null 2>&1
# Canonical full-JSON template contract: this reserved ARN prefix occurs
# only at Resource bucket slots. Real-JSON conformance is gated by
# tests/scripts/storage-initialization.test.ts; not a generic renderer.
slot='arn:aws:s3:::vid-assets/'
for role in server worker; do
  stage=$role-policy
  policy=$(cat "/policies/$role-policy.json" 2>/dev/null)
  printf '%s\n' "${policy//"$slot"/"arn:aws:s3:::$bucket/"}" \
    > "/run/storage/$role.json"
  mcli admin policy create local "$role" \
    "/run/storage/$role.json" >/dev/null 2>&1
done
stage=server-principal
printf '%s\n%s\n' "$SERVER_ACCESS_KEY" "$SERVER_SECRET_KEY" |
  mcli admin user add local >/dev/null 2>&1
stage=worker-principal
printf '%s\n%s\n' "$WORKER_ACCESS_KEY" "$WORKER_SECRET_KEY" |
  mcli admin user add local >/dev/null 2>&1
stage=server-attach
mcli admin policy attach local server --user "$SERVER_ACCESS_KEY" \
  >/dev/null 2>&1
stage=worker-attach
mcli admin policy attach local worker --user "$WORKER_ACCESS_KEY" \
  >/dev/null 2>&1
```

.github/python/check.sh现有for file loop内syntax checker及shellcheck命令；替换原sh -n与固定--shell=sh，保留中间exclude case。

```sh
case "$file" in
  deploy/storage/initialize.sh) shell=bash ;;
  *) shell=sh ;;
esac
"$shell" -n "$file" || status=1

# Replace the complete shellcheck command expression.
"$VID_CI_PYTHON_BIN/shellcheck" --shell="$shell" --external-sources \
  --exclude="$exclude" "$file" || status=1
```

**不能改变的事实**：external endpoint在任何root访问前跳过；root仅init、stdin credentials、stage-only diagnostics、不同principal及legacy read prefixes保持。固定image已有Bash；不改历史migration。

**实施时的验证要求**：实施后先bash -n新文件与hash-locked shell/YAML检查，再sh scripts/check.sh、node --test tests/scripts/storage-initialization.test.ts和隔离deployment-check.sh。实际mount/service body必须被测试，不能只测试拷贝。

**当前验证状态**：源body完整阅读，范围/hash静态核对。AFTER未实施、未编译、未类型检查、未功能验证；未运行Docker/VM/provider旅程。

<a id="f007"></a>

#### F007 — 共享polling政策一个名字，进程schema不合并

- **优先级**：P3 / 可维护性。
- **适用置信度**：高（静态证据；拟议实现未验证）。
- **符号**：`server polling default; duplicate worker policy at line130`。

**现在（连续原文）** — [`packages/config/src/env.ts:95–99`](../packages/config/src/env.ts#L95)

```ts
  GITHUB_CLIENT_ID: requiredString,
  GITHUB_CLIENT_SECRET: requiredString,
  IO_TIMEOUT_MS: ioTimeout,
  POLL_MS: positiveInteger.max(10000).default(200),
})
```

##### F007：为什么不好

server与worker重复positiveInteger.max(10000).default(200)，worker注释也说明共同ceiling；共享政策两处维护，而IO timeout已有本模块共同owner。值本身没有被证明不合理。

**Handover 实际对照** — [`apps/server/src/env.ts:9–19`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/env.ts#L9-L19)

reference env owner集中default与bounded process setting；无server/worker两处polling的直接同构实现，比较的是政策归属而不是数值。

```ts
const SHAPE = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Keys the hash of an emailed code. Long enough that knowing a hash does not reveal the code. */
  AUTH_SECRET: z.string().min(32),
  /**
   * Connections this process may hold. Every instance holds its own, so the number that matters
   * is this times the instance count, and it has to stay under the server's `max_connections`
   * with room left for migrations and whoever needs to look at the database by hand.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
```

##### F007：应该怎么改

在ioTimeout旁新增私有pollingInterval，替换两个POLL_MS属性。lease关系仍worker-only，server/worker secret projection仍分开，不建policy registry。

##### F007：改完之后的形状（拟议，未实施）

所列原文件的局部replacement；必要的新模块/调用段落另列，不是全库可直接应用补丁。

```ts
const pollingInterval = positiveInteger.max(10000).default(200)
```

server与worker两个已有schema对象中都替换完整POLL_MS属性。

```ts
POLL_MS: pollingInterval,
```

**不能改变的事实**：POLL_MS仍1..10000、default200；LEASE_MS仍大于三倍poll interval；schema仍strip无关秘密。

**实施时的验证要求**：实施后运行sh scripts/check.sh test packages/config/src/env.test.ts；让现有default/blank/timer边界对两个process schema都断言。

**当前验证状态**：源body完整阅读，范围/hash静态核对。AFTER未实施、未编译、未类型检查、未功能验证；未运行Docker/VM/provider旅程。

<a id="f008"></a>

#### F008 — 输入附件数上限在两个 wire 合同里重复拥有

- **优先级**：P2 / 边界与合同可维护性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`ASSET_MAX_INPUT_FILES and messageSubmissionSchema.assetIDs`。

**现在（连续原文）** — [`packages/contract/src/execution.ts:25–26`](../packages/contract/src/execution.ts#L25)

```ts
const ASSET_MAX_INPUT_FILES = 16
export const ASSET_MAX_OUTPUT_FILES = 32
```

##### F008：为什么不好

执行 start assets 上限由这里16定义，公开 submission assetIDs 又在 http.ts:21 写.max(16)。两个入口表达同一轮接受的输入数量，修改任一处会让合法公开请求进入无法发布/消费的start；当前只是重复政策证据，并非现有16不一致。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:119–125`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L119-L125)

Handover TaskState derives its enum from STATE owner rather than writing the closed set again. Same fact-ownership principle; no direct attachment business analogue.

```ts
/**
 * The four, from the module that owns them rather than written out again.
 *
 * Listed here, a fifth state would exist everywhere except on the wire — and the screen reading
 * this would refuse the answer as malformed rather than show it.
 */
const TaskState = z.enum(STATE)
```

##### F008：应该怎么改

在contract内部 asset-limits.ts 放 shared input cap；两个 schema 内部 import，execution.ts 的既有 public output cap 留在原处。input cap 目前是私有常量，不新增 package 公共导出。不要把 input16/output32或 configured generated count 合并。

##### F008：改完之后的形状（拟议，未实施）

```ts
export const ASSET_MAX_INPUT_FILES = 16
```

execution.ts删除本地input cap声明，只引入内部常量，不 re-export。outputcap不动。

```ts
import { ASSET_MAX_INPUT_FILES } from './asset-limits'
```

http.ts新增同一常量import；messageSubmissionSchema内assetIDs属性完整替换。

```ts
assetIDs: z.array(uuid).max(ASSET_MAX_INPUT_FILES).default([]).meta({
  uniqueItems: true,
  description:
    'Unique after lowercase UUID canonicalization; case-insensitive equality is additionally enforced at runtime.',
}),
```

**不能改变的事实**：input附件上限仍16，output上限仍32，不与配置maxFiles混为一谈；保持assetIDs顺序、lowercasecanonicalization和unique-ref精确重放。ASSET_MAX_INPUT_FILES 原本没有公共消费者，不凭提取常量新增公共 API；ASSET_MAX_OUTPUT_FILES 的既有导出保持。

**实施时的验证要求**：sh scripts/check.sh test packages/contract/src/http.test.ts packages/contract/src/execution.test.ts; add 16/17 boundary assertions at both schemas; preserve legacy max16.

**当前验证状态**：Static source comparison only. AFTER is proposed, not implemented, compiled or functionally reproduced.

<a id="f009"></a>

#### F009 — 公开输入与执行回执对 PostgreSQL text 的可表示性有两个不同 owner

- **优先级**：P2 / 边界与合同可维护性。
- **适用置信度**：中高：合同/PG可表示性差异可定位；真实消费失败路径与SDK增量切分未复现。
- **符号**：`startInputSchema.text; analogous completedEventSchema.text`。
- **是否改变合同**：是：收紧私有执行wire可接受字符集合，并使生成JSON Schema改变；先核对SDK delta Unicode分片方式及现有消费者，不能按排版提交静默改变。

**现在（连续原文）** — [`packages/contract/src/execution.ts:28–43`](../packages/contract/src/execution.ts#L28)

```ts
const startInputSchema = z
  .strictObject({
    messageID: z.uuid().toLowerCase(),
    text: z.string(),
    assets: z
      .array(assetReferenceSchema)
      .min(1)
      .max(ASSET_MAX_INPUT_FILES)
      .readonly()
      .optional(),
  })
  .refine(
    (input) => input.text.trim().length > 0 || input.assets !== undefined,
    { error: 'Message text must not be blank' },
  )
  .readonly()
```

##### F009：为什么不好

HTTP productText 明确拒绝 NUL/孤立 surrogate，但 startInput/text、completed text、assistant delta 都是无限制 z.string。尤其 run-completed 经合法 executionDeliverySchema 后 storeFinalMessage 写 product.messages/text 和 JSONB receipt，PostgreSQL 不接受同类字符；因此输入合同合法不等于可持久接受，故障会经 consumer 升级为进程失败。这是静态可达差异，未运行复现。 特别注意assistant-text可能是流式分片，不能假定每片都天然在Unicode code-point边界；先检查真实Pi delta，再决定拒绝整片还是在owner层缓冲完整字符。不要在未知付费运行后自动重推理。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:522–534`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L522-L534)

Handover distinguishes stored unknown content from admitted Spoken in asTranscript. No direct NUL business analogue; borrow the explicit persistence-read/write boundary, not its unreadable-line fallback.

```ts
function asTranscript(reading: Reading) {
  const offers = Models.safeParse(reading.offers)

  return {
    ...reading,
    underway: asUnderway(reading.underway),
    offers: offers.success ? offers.data : [],
    messages: reading.messages.map((one) => {
      const read = Spoken.safeParse({ ...one, at: one.at.toISOString() })
      return read.success ? read.data : unreadable(one.seq, one.at)
    }),
  }
}
```

##### F009：复审实证与实施裁决

原生 PG 18.6 / pg 8.23.1 证明：JSONB 拒绝 NUL 和孤立 surrogate；直接 text/varchar 参数对孤立 surrogate 则会先有损替换为 U+FFFD。实际 inbox/outbox JSONB acceptance 会拒绝并回滚，不能把 schema accepted 等同 durable accepted。官方 Pi loopback 又证明 high/low surrogate 可以分别触发 `onText`，最终答案是完整 `🎬`。因此不采用下文拟议的逐 delta 校验；完整 wire 字段收紧也不作为行为保持重构自动批准。先只评估已有 HTTP primitive 的归属提取，不新增协议接受集变化、付费重推理或有损替换。详情与原生日志见 [实施记录](handover-refactoring.md) 及 `/tmp/handover-refactor-unicode-proof.{md,json}`；下文 AFTER 保留为原提案，不是已批准补丁。

##### F009：应该怎么改

把现有 PostgreSQL-safe primitive 移到 contract 私有 product-text.ts，两类合同引用同一个 primitive；保留 HTTP 的32768上界、trim阶段与执行协议原本长度/空文本语义。JSON Schema 自动导出同规则，不改历史数据。AFTER 是新 primitive 和完整属性表达式替换。

##### F009：改完之后的形状（拟议，未实施）

```ts
// packages/contract/src/product-text.ts
import { z } from 'zod'
export const productTextSchema = z.string().regex(
  // Reject values that cannot be retained losslessly through PostgreSQL JSONB.
  // oxlint-disable-next-line no-control-regex -- PostgreSQL rejects NUL.
  /^[^\u0000\ud800-\udfff]*$/u,
  'Text must be representable in PostgreSQL',
)
```

http.ts现有productText消费者不变；用这个import替换本地定义（先确认module export）。

```ts
import { productTextSchema as productText } from './product-text'
```

execution.ts新增import；startInputSchema/completedEventSchema的完整text属性各自替换为下行。这是已有object中的属性片段，不是独立程序。

```ts
text: productTextSchema,
```

若真实SDK增量Unicode完整性已验证，assistant-text branch完整delta属性替换；否则先不要采用该增量收紧。

```ts
delta: productTextSchema,
```

**不能改变的事实**：HTTP文本32768上限与exact replay不trim；私有start非空策略、完成空文本与history隐私仍保持。NUL/lone-surrogate不得被有损替换成另一条事实；若收紧wire，必须更新原生/外语validator一致性和generated产物，而非手改generated。已accepted付费work的失败不得自动重放。

**实施时的验证要求**：sh scripts/check.sh test packages/contract/src/execution.test.ts packages/contract/src/execution-schema.test.ts packages/contract/src/http.test.ts; add literal NUL/lone-surrogate rejection and valid astral Unicode acceptance for native/foreign command and delivery.

**当前验证状态**：Static source comparison only. AFTER is proposed, not implemented, compiled or functionally reproduced.

### 职责、身份与外部边界

<a id="f010"></a>

#### F010 — acceptCancel 只接受 schema 已经分辨的 cancel command

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`acceptCancel`。

**现在（连续原文）** — [`apps/agent/src/db/command-acceptance.ts:128–145`](../apps/agent/src/db/command-acceptance.ts#L128)

```ts

async function acceptCancel(tx: Transaction<DB>, command: ExecutionCommand) {
  const run = await tx
    .updateTable('execution.runs')
    .set({ cancel_requested: true })
    .where('run_id', '=', command.runID)
    .where('thread_id', '=', command.threadID)
    .where('status', 'in', ['queued', 'running'])
    .returning('status')
    .executeTakeFirst()
  if (run?.status !== 'queued') return
  await tx
    .updateTable('execution.runs')
    .set({ status: 'cancelled' })
    .where('run_id', '=', command.runID)
    .execute()
  await enqueueEvent(tx, { ...eventIdentities(command), kind: 'run-cancelled' })
}
```

##### F010：为什么不好

acceptStart 使用 StartCommand，acceptCancel 却使用全 ExecutionCommand。实际调用只在 kind===cancel 的分支，现有行为正确；但参数合同允许 start command 进入 cancellation SQL，函数内部又没有自行 discriminant check。无需再 runtime parse，类型应记述调用处已获得的事实。

**Handover 实际对照** — [`apps/cli/src/checking-in.ts:287–303`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/checking-in.ts#L287-L303)

reference stopIfAsked 接收只表示 Stopping 的 wanted，而非报告/提问混合 union；本项目必须保留 DB serialized cancellation，不采用本地 map 作为权威。

```ts
export async function stopIfAsked(
  answering: ReadonlyMap<string, Answering>,
  wanted: readonly Stopping[],
  say: (line: string) => void,
): Promise<readonly Answering[]> {
  const stopping = wanted
    .map((one) => ({ one, running: answering.get(one.conversationId) }))
    // The turn and not just the conversation. A stop is read out of the tables a moment before it
    // is acted on, and in that moment the turn it was about can end and the next one begin — on
    // the same conversation, because interrupting is how the next one got there. Matched loosely,
    // the interrupt stops the answer it was making room for.
    .filter((both) => both.running !== undefined && both.running.afterSeq === both.one.afterSeq)
    .map((both) => both.running as Answering)

  for (const one of stopping) {
    say(`stopping ${one.conversationId}`)
    await one.stop()
```

##### F010：应该怎么改

只把参数收窄到 owner 已导出的 CancelCommand，并加入现有 type-only import；不重复定义 Extract union。继续由 acceptCommand 完成一次 parse 和分支。不是新 DTO，也不把事务前 type narrow 当 SQL 授权。第三批已按此更小方案实施；SQL 正文与 lock/acceptance 次序保持。

##### F010：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
async function acceptCancel(tx: Transaction<DB>, command: CancelCommand) {
  const run = await tx
    .updateTable('execution.runs')
    .set({ cancel_requested: true })
    .where('run_id', '=', command.runID)
    .where('thread_id', '=', command.threadID)
    .where('status', 'in', ['queued', 'running'])
    .returning('status')
    .executeTakeFirst()
  if (run?.status !== 'queued') return
  await tx
    .updateTable('execution.runs')
    .set({ status: 'cancelled' })
    .where('run_id', '=', command.runID)
    .execute()
  await enqueueEvent(tx, { ...eventIdentities(command), kind: 'run-cancelled' })
}
```

**不能改变的事实**：inbox→conversation lock 顺序、pre-start durable cancel、thread/run identity、终态 outbox、acceptance-before-ACK 全部不变；start/cancel 仍通过生成 schema owner。

**实施时的验证要求**：sh scripts/check.sh；sh scripts/check.sh test apps/agent/src/commands.test.ts；保留数据库 cancellation-before-start 与 exact replay/conflict 集成测试；编译应拒绝 StartCommand 调用 acceptCancel。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f011"></a>

#### F011 — 终态 adapter 把 boolean SQL receipt 翻译为统一 outcome

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：中（适用前提见说明）。
- **符号**：`ExecutionWrites.complete / fail / cancel`。

**现在（连续原文）** — [`apps/agent/src/execute-run.ts:93–103`](../apps/agent/src/execute-run.ts#L93)

```ts
  appendText: (lease: ExecutionLease, delta: string) => Promise<boolean>

  complete: (
    lease: ExecutionLease,
    completion: ExecutionCompletion,
  ) => Promise<boolean | ExecutionOutcome>
  fail: (
    lease: ExecutionLease,
    reason: ExecutionFailure,
  ) => Promise<boolean | ExecutionOutcome>
  cancel: (lease: ExecutionLease) => Promise<boolean | ExecutionOutcome>
```

##### F011：为什么不好

complete/fail/cancel 返回 boolean | ExecutionOutcome；true 的含义依赖被调用方法，false 意味 lost，字符串又覆盖 caller 请求的终态。执行 owner 因此还要维护 stage→outcome map；SDK/DB receipt 适配没有在 bindExecutionWrites 边界完成，混合类型扩大调用方推理负担。

**Handover 实际对照** — [`apps/cli/src/agents/agent.ts:130–143`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/agents/agent.ts#L130-L143)

reference Why 是执行方消费的单一终态 vocabulary；本项目额外 lost/fencing 是必须保留的事实，而不是照搬 done/cancelled。

```ts
 * `unknown` is absent on purpose: an adapter that can still speak is an adapter that is still
 * alive, so it is never the one to say nobody knows. That belongs to whoever finds the turn
 * afterwards.
 */
export type Why =
  | { readonly why: 'done' }
  | { readonly why: 'cancelled' }
  /** `said` is shown to a person, so it owes them plain words rather than whatever was thrown. */
  | { readonly why: 'failed'; readonly said: string }

/**
 * How much of a tool's output is worth keeping.
 *
 * Enough to recognise what happened, never the whole thing. It belongs here rather than to either
```

##### F011：应该怎么改

仅把执行消费端三个方法改为 `Promise<ExecutionOutcome>`，SQL 具名事务的既有 true/false/string 返回保留。bindExecutionWrites 内 normalizer 知道请求 outcome，并把拒绝权限映射 lost；更新 typed test writes 不改变 SQL 终态裁决。代码为完整三个属性替换、helper 和消费后的返回段。

##### F011：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
function terminalOutcome(
  receipt: boolean | ExecutionOutcome,
  requested: ExecutionOutcome,
): ExecutionOutcome {
  if (typeof receipt === 'string') return receipt
  return receipt ? requested : 'lost'
}
```

ExecutionWrites内三个完整terminal成员类型替换（如采用RT01，从新contract模块导出ExecutionOutcome）。

```ts
complete: (lease: ExecutionLease, completion: ExecutionCompletion) =>
  Promise<ExecutionOutcome>
fail: (lease: ExecutionLease, reason: ExecutionFailure) =>
  Promise<ExecutionOutcome>
cancel: (lease: ExecutionLease) => Promise<ExecutionOutcome>
```

bindExecutionWrites内terminal属性完整替换；DB具名事务函数不改。run-writes.ts 还须从执行能力合同 owner 增加 ExecutionOutcome 的 type-only import（F001 迁移后同步更新路径），并迁移所有 typed fixtures；下面是属性片段，不是可直接粘贴的完整模块。

```ts
complete: async (lease, completion) =>
  terminalOutcome(await completeExecutionRun(db, lease, completion), 'completed'),
fail: async (lease, reason) =>
  terminalOutcome(await failExecutionRun(db, lease, reason), 'failed'),
cancel: async (lease) => terminalOutcome(await cancelExecutionRun(db, lease), 'cancelled'),
```

finishExecution的receipt变量声明替换；其原catch之后的boolean→outcome映射整体替换为return accepted。它与RT03应协调采用，而不是将两个独立AFTER直接拼接。

```ts
let accepted: ExecutionOutcome
```

finishExecution原catch之后完整尾部替换。

```ts
return accepted
```

**不能改变的事实**：锁内 cancel/failed 仍覆盖请求 complete；false 永不解释成失败可重试；SQL 原函数和所有 COMMIT 异常保持原语义。

**实施时的验证要求**：sh scripts/check.sh；sh scripts/check.sh test apps/agent/src/execute-run.test.ts apps/agent/src/execute-run.sources.test.ts；测试三个 adapter 的 true/false/overriding string，保留未知 COMMIT 无 replay。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f012"></a>

#### F012 — quarantine 的 lease 只从当前 execution owner 取一次

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`quarantineExecution`。

**现在（连续原文）** — [`apps/agent/src/execute-run.ts:548–560`](../apps/agent/src/execute-run.ts#L548)

```ts

async function quarantineExecution(
  execution: Execution,
  lease: ExecutionLease,
  reason?: ExecutionFailure,
) {
  try {
    await execution.deps.writes.quarantine(lease, reason)
  } catch (error) {
    diagnose(execution, 'quarantine')
    throw error
  }
}
```

##### F012：为什么不好

helper 同时收 execution 与 lease，并使用前者诊断、后者持久化。现有调用都传 execution.lease，因此第二份可交换输入没有新事实，未来错配会日志归属 A、quarantine B；不是删掉隔离 helper，而是去掉 receiver 已拥有的身份。

**Handover 实际对照** — [`apps/cli/src/answering.ts:443–499`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/answering.ts#L443-L499)

reference writingInto 将固定 conversation identity 绑定一次，后续写不再带两份 identity；不能照搬其可重试 HTTP 消息到 paid allocation。

```ts

function writingInto(api: Api, asking: Asking, machine: Machine): Writing {
  const path = { params: { path: { id: asking.conversationId } } }
  const { say, until } = machine
  const live = liveWriter(async (said) => {
    await api.POST('/machines/current/conversations/{id}/live', { ...path, body: said })
  })

  /**
   * Sends one thing until it is in, or until it is certain it never will be.
   *
   * The three answers are different in kind. Accepted is done. Refused — anything but a 503 — means
   * this build and that server disagree about what a message is, and every attempt after it would
   * be refused the same way. Nobody answering is a network, and a network comes back; the name on
   * the message is what makes trying again safe, so trying again is what happens.
   */
  async function sent(send: () => Promise<{ response: Response }>): Promise<boolean> {
    const giveUpAt = Date.now() + KEEP_TRYING_MS

    for (;;) {
      const answered = await send()
      if (answered.response.ok) return true

      if (answered.response.status !== NO_ANSWER) {
        say(`the server refused a message (${answered.response.status}); it is not being kept`)
        return false
      }

      if (until.aborted || Date.now() > giveUpAt) return false
      await sleep(BETWEEN_TRIES_SECONDS, until)
    }
  }

  return {
    message: async (key, message) => {
      // A durable result must not overtake the live fragments that explain it. Waiting happens
      // here, not in the adapter loop: moments are still accepted without holding up the agent.
      await live.drain()
      return sent(async () =>
        api.POST('/machines/current/conversations/{id}/messages', {
          ...path,
          body: { key, message },
        }),
      )
    },

    session: async (id) => {
      // Same treatment: losing it means the next turn starts over and says so, which is honest but
      // worse than the turn it could have continued.
      await sent(async () =>
        api.PUT('/machines/current/conversations/{id}/session', { ...path, body: { session: id } }),
      )
    },

    moment: live.push,
  }
}
```

##### F012：应该怎么改

删除第二 lease 参数；两个调用点分别为 quarantineExecution(execution, reason) 与 quarantineExecution(execution)。下面给完整 helper。

##### F012：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
async function quarantineExecution(
  execution: Execution,
  reason?: ExecutionFailure,
) {
  try {
    await execution.deps.writes.quarantine(execution.lease, reason)
  } catch (error) {
    diagnose(execution, 'quarantine')
    throw error
  }
}
```

**不能改变的事实**：隔离事务仍允许 late old worker 设置 recovery flag，但绝不覆盖新 fence 的 run/history/reference；未知 COMMIT 仍保留全部 causes。

**实施时的验证要求**：sh scripts/check.sh test apps/agent/src/execute-run.test.ts；terminal + quarantine 双失败、lost allocation fence 和 existing SQL integration tests 不变。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f013"></a>

#### F013 — 原生工具调用同时携带 owner 与 SDK 的取消权

- **优先级**：P2 / 取消权边界（需验证）。
- **适用置信度**：中（适用前提见说明）。
- **符号**：`executeTool / readTool / writeTool`。
- **是否改变合同**：是：受信SandboxTools adapter获得owner与SDK联合取消权，不再只收到SDKsignal；生产E2B已有独立owner合并。需证明两方取消和SDK生命周期都兼容，不能称已修复生产继续spending问题。

**现在（连续原文）** — [`apps/agent/src/harness/pi.ts:88–155`](../apps/agent/src/harness/pi.ts#L88)

```ts
function executeTool(tools: SandboxTools, signal: AbortSignal) {
  return defineTool({
    name: 'execute',
    label: 'Execute',
    description: 'Execute a command in the assigned sandbox.',
    parameters: Type.Object({ command: Type.String({ maxLength: 16 * 1024 }) }),
    async execute(_id, params, sdkSignal) {
      signal.throwIfAborted()
      sdkSignal?.throwIfAborted()
      const result = await tools.execute({
        command: params.command,
        signal: sdkSignal ?? signal,
      })
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: {},
      }
    },
  })
}

function readTool(tools: SandboxTools, signal: AbortSignal) {
  return defineTool({
    name: 'read',
    label: 'Read',
    description: 'Read a file in the assigned sandbox.',
    parameters: Type.Object({ path: Type.String({ maxLength: 4 * 1024 }) }),
    async execute(_id, params, sdkSignal) {
      signal.throwIfAborted()
      sdkSignal?.throwIfAborted()
      const content = await tools.read({
        path: params.path,
        signal: sdkSignal ?? signal,
      })
      return { content: [{ type: 'text', text: content }], details: {} }
    },
  })
}

function writeTool(
  tools: SandboxTools,
  signal: AbortSignal,
  onLimit: () => never,
) {
  return defineTool({
    name: 'write',
    label: 'Write',
    description: 'Write a file in the assigned sandbox.',
    parameters: Type.Object({
      path: Type.String({ maxLength: 4 * 1024 }),
      content: Type.String({ maxLength: 256 * 1024 }),
    }),
    async execute(_id, params, sdkSignal) {
      signal.throwIfAborted()
      sdkSignal?.throwIfAborted()
      if (Buffer.byteLength(params.content) > 256 * 1024) onLimit()
      await tools.write({
        path: params.path,
        content: params.content,
        signal: sdkSignal ?? signal,
      })
      return {
        content: [{ type: 'text', text: 'Written' }],
        details: {},
      }
    },
  })
}
```

##### F013：为什么不好

三个工具启动前都检查 owner 与 sdkSignal，但发给 SandboxTools 的实际 signal 是 sdkSignal ?? signal：存在 SDK signal 时，下游合同只收到 SDK 取消权。当前 E2BSandboxSession.operation 另行合并构造时 owner，因此生产 E2B 路径有第二道保护，不能宣称已复现继续花费；然而 AgentHarness 的公开 SandboxTools 消费和测试注入不能依赖此 E2B 隐含保障。web_search/file 工具已经采用两者联合，基本工具应同样明确边界。

**Handover 实际对照** — [`apps/cli/src/agents/codex.ts:39–53`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/agents/codex.ts#L39-L53)

reference ActiveTurn/RunControl 显式保存取消实际指向的进行中操作；no direct business analogue：本项目有额外 DB spending owner，而 reference 是本地 CLI。

```ts
type ActiveTurn =
  | { readonly phase: 'starting'; readonly server: AppServer }
  | {
      readonly phase: 'running'
      readonly server: AppServer
      readonly threadId: string
      readonly turnId: string
    }
type RunControl = { active: ActiveTurn | undefined; interrupted: boolean }
type TurnRun = 'done' | 'forgotten'
type Running = {
  readonly where: string
  readonly env: NodeJS.ProcessEnv
  readonly control: RunControl
}
```

##### F013：应该怎么改

三个 execute 回调中均建立 cancellation：无 sdkSignal 时沿用 owner，否则 AbortSignal.any。使用联合 signal 的启动检查和 IO 传递；write 保留 UTF8 admission。下面是完整 execute 回调替换及 read/write 的完整 signal 表达式替换，不改官方工具 API。

##### F013：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
async execute(_id, params, sdkSignal) {
  const cancellation = sdkSignal === undefined ? signal : AbortSignal.any([signal, sdkSignal])
  cancellation.throwIfAborted()
  const result = await tools.execute({ command: params.command, signal: cancellation })
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    details: {},
  }
}
```

readTool/writeTool原signal属性完整替换；两处启动前owner/sdk checks仍保留。

```ts
signal: sdkSignal === undefined ? signal : AbortSignal.any([signal, sdkSignal]),
```

**不能改变的事实**：任何一方取消均停止受信工具；E2B 独立 owner 合并仍保留；read 错误可纠正、mutative unknown 隔离不改；write 字节限制与同步 onLimit 不动。

**实施时的验证要求**：sh scripts/check.sh；sh scripts/check.sh test apps/agent/src/harness/pi.test.ts apps/agent/src/execute-run.test.ts；加可观察联合 signal 的受信 SandboxTools fixture，分别取消 owner/SDK，覆盖已启动和 pre-aborted 情况。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f014"></a>

#### F014 — 工具定义与工具名称 allowlist 应由同一组受信定义派生

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`assignedSession`。

**现在（连续原文）** — [`apps/agent/src/harness/pi.ts:156–209`](../apps/agent/src/harness/pi.ts#L156)

```ts

type TurnInput = Parameters<AgentHarness['turn']>[0]

async function assignedSession(
  options: PiHarnessOptions,
  manager: SessionManager,
  { tools, signal, fileTools }: TurnInput,
  {
    onSources,
    onLimit,
  }: {
    onSources: (sources: readonly WebSource[]) => void
    onLimit: () => never
  },
) {
  const { runtime, model } = await assignedModel(options)
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    model,
    thinkingLevel: options.reasoning ? 'medium' : 'off',
    sessionManager: manager,
    resourceLoader: isolatedResources(options.systemPrompt),
    settingsManager: SettingsManager.inMemory({
      cacheWarming: 'off',
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
    }),
    // Name allowlist plus custom replacements: no host bash/edit/grep or skill tools.
    tools: [
      'execute',
      'read',
      'write',
      ...(options.webSearch === undefined ? [] : ['web_search']),
      ...(fileTools === undefined ? [] : ['import_file', 'export_file']),
    ],
    customTools: [
      executeTool(tools, signal),
      readTool(tools, signal),
      writeTool(tools, signal, onLimit),
      ...(options.webSearch === undefined
        ? []
        : [webSearchTool(options.webSearch, signal, onSources)]),
      ...(fileTools === undefined
        ? []
        : fileToolDefinitions(
            fileTools,
            signal,
            options.input.includes('image'),
            onLimit,
          )),
    ],
  })
  return session
}
```

##### F014：为什么不好

allowed tools 与 customTools 重复 execute/read/write/web_search/import/export 名字和两次条件分支。当前内容一致且安全；但扩一个定义忘记另一个列表会静默不可用，重命名时两份名单增加 host-tool allowlist 审核负担。

**Handover 实际对照** — [`apps/cli/src/agents/known-agents.ts:1–55`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/agents/known-agents.ts#L1-L55)

reference agentFor 是受信 registry 的 owner，EVERY_KIND 由 BUILD 派生；本项目不需新增 registry，仅消除同一工具名单的重复。

```ts
/**
 * Which agents this machine can drive.
 *
 * Adding one is a file next to this and a line below. Nothing else in this program, on the
 * server, or on the page has to be told.
 *
 * The key is the kind, in the same words the server uses. An adapter does not repeat it: two
 * places naming the same agent is two places to disagree about what it is called.
 */

import type { Agent } from './agent.ts'
import { claudeCode } from './claude-code.ts'
import { codex } from './codex.ts'

/**
 * Each adapter is built around this machine's environment, because that is where the PATH
 * captured at connection time lives — and without it both SDKs quietly fall back to a copy of the
 * agent they ship with, which is signed into nothing.
 */
const BUILD: Record<string, (env: NodeJS.ProcessEnv) => Agent> = {
  'claude-code': claudeCode,
  codex,
}

/**
 * Every agent this machine can drive.
 *
 * The registry saying what is in it, so the shared journey suite runs against whatever is
 * registered rather than against a second list of the same names. Registering an adapter is what
 * puts it under those tests.
 */
export const EVERY_KIND: readonly string[] = Object.keys(BUILD)

/**
 * The adapter for a command, or nothing.
 *
 * Discovery finds agents by command, because that is what is on the PATH; the server hands out
 * work by kind. Both arrive here, and the pairing is stated once — in the adapter, which is the
 * one thing that already has to know which binary it drives.
 */
export function agentForCommand(command: string, env: NodeJS.ProcessEnv): Agent | undefined {
  const built = Object.values(BUILD).map((build) => build(env))
  return built.find((agent) => agent.command === command)
}

/**
 * The adapter for a kind, or nothing.
 *
 * A server that knows about an agent this machine has no adapter for is the ordinary way an older
 * machine meets a newer deployment. It has to come back as an absence somebody can report, not as
 * a crash in the middle of a turn.
 */
export function agentFor(kind: string, env: NodeJS.ProcessEnv): Agent | undefined {
  return BUILD[kind]?.(env)
}
```

##### F014：应该怎么改

先创建当前受信 definitions 数组，再用 definition.name 形成唯一 allowlist；不能使用 SDK discovery/listAllTools、不允许 ambient 默认工具。当前官方 defineTool.name 是现有对象字段，无新增 SDK API。

##### F014：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
async function assignedSession(
  options: PiHarnessOptions,
  manager: SessionManager,
  { tools, signal, fileTools }: TurnInput,
  {
    onSources,
    onLimit,
  }: {
    onSources: (sources: readonly WebSource[]) => void
    onLimit: () => never
  },
) {
  const { runtime, model } = await assignedModel(options)
  const definitions = [
    executeTool(tools, signal),
    readTool(tools, signal),
    writeTool(tools, signal, onLimit),
    ...(options.webSearch === undefined
      ? []
      : [webSearchTool(options.webSearch, signal, onSources)]),
    ...(fileTools === undefined
      ? []
      : fileToolDefinitions(
          fileTools,
          signal,
          options.input.includes('image'),
          onLimit,
        )),
  ]
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    model,
    thinkingLevel: options.reasoning ? 'medium' : 'off',
    sessionManager: manager,
    resourceLoader: isolatedResources(options.systemPrompt),
    settingsManager: SettingsManager.inMemory({
      cacheWarming: 'off',
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
    }),
    tools: definitions.map((definition) => definition.name),
    customTools: definitions,
  })
  return session
}
```

**不能改变的事实**：只有当前显式定义进入 Pi；host bash/edit/grep/skills/extensions/ambient credentials 仍禁用；quota closure 每 turn 新建；settings 与 assigned model policy 不改。

**实施时的验证要求**：sh scripts/check.sh test apps/agent/src/harness/pi.test.ts；检查三种工具集合（基础/search/files）和不存在 host tools 的实际 HTTP payload。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f015"></a>

#### F015 — 已知 native identity 在 session 生命周期内应不可变

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：中：fresh identity runtime不可变性硬化；当前无实际修改且消费port可能已静态readonly，不是已发现跨租户风险。
- **符号**：`E2BSandboxSession.nativeRef / constructor`。

**现在（连续原文）** — [`apps/agent/src/sandbox/e2b.ts:58–69`](../apps/agent/src/sandbox/e2b.ts#L58)

```ts
class E2BSandboxSession implements SandboxSessionPort {
  readonly nativeRef
  private closing?: Promise<void>
  private unknownOutcome = false

  constructor(
    private readonly remote: Sandbox,
    private readonly owner: AbortSignal,
    private readonly timeoutMs: number,
  ) {
    this.nativeRef = { provider: 'e2b', id: remote.sandboxId }
  }
```

##### F015：为什么不好

外层 readonly nativeRef 阻止替换整个对象，却没有禁止修改其 provider/id，constructor 推导出的对象也未 freeze；当前使用者没有修改它，不能说已发生串租户错误。但持久化的是同一个对象的 ID，pause/execute 仍作用于 private remote，意外编辑 nativeRef.id 会使持久 identity 与实际 SDK handle 脱节。既有 sandboxReferenceFromJSON 对恢复输入 freeze，fresh identity 可以采用同一个约束。

**Handover 实际对照** — [`apps/cli/src/agents/codex.ts:32–46`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/agents/codex.ts#L32-L46)

reference TurnIdentity/ActiveTurn 的 threadId/turnId 是 readonly；no direct business analogue：SDK local conversation 不是远程付费 sandbox durable identity。

```ts
type Item = Record<string, unknown> & { readonly id: string; readonly type: string }
type TurnIdentity = { readonly threadId: string; readonly turnId: string }
export type OutputProgress = {
  readonly at: number
  readonly excerpt: string
  readonly prefixMissing: boolean
}
type ActiveTurn =
  | { readonly phase: 'starting'; readonly server: AppServer }
  | {
      readonly phase: 'running'
      readonly server: AppServer
      readonly threadId: string
      readonly turnId: string
    }
```

##### F015：应该怎么改

对 fresh provider/id 对象 Object.freeze，不复制 SDK handle，不加入可写的 identity setter、不 fork SDK。下面替换整个 constructor 赋值表达式。

##### F015：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
this.nativeRef = Object.freeze({ provider: 'e2b', id: remote.sandboxId })
```

**不能改变的事实**：取消期间已知 allocation ID 仍必须返回和 persist 后 cleanup；不改变 create/connect 次数、resume reboot、fence、pause receipt 或未知 ACK 不重放。

**实施时的验证要求**：sh scripts/check.sh test apps/agent/src/sandbox/reference.test.ts apps/agent/src/sandbox/e2b.test.ts；增加 fresh nativeRef immutable 检查，并用现有真实 loopback SDK fixture 断言 ID 与实际 create response 一致。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f016"></a>

#### F016 — 两条 Redis 连接的拒绝原因应完整保留，而非只选第一条

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：中（适用前提见说明）。
- **符号**：`WorkerProcess.connectRedis`。

**现在（连续原文）** — [`apps/agent/src/worker.ts:259–268`](../apps/agent/src/worker.ts#L259)

```ts
  private async connectRedis() {
    const connected = await Promise.allSettled([
      connectBounded(this.commands, this.connections.IO_TIMEOUT_MS),
      connectBounded(this.blockingReader, this.connections.IO_TIMEOUT_MS),
    ])
    this.signal.throwIfAborted()
    for (const connection of connected) {
      if (connection.status === 'rejected') throw connection.reason
    }
  }
```

##### F016：为什么不好

连接已经正确使用 allSettled 等待两个 native clients，也在返回前尊重 shutdown；但是 settled results 的循环只 throw 第一个 rejected reason，其余 connect() promise 的原因只能寄希望于 error listener 重复上报。失败收集器本来已用 AggregateError 保存所有 lifecycle failures，可以在接入边界完整记述这一次并行连接的 receipt，不发明 retry 或 raw public logging。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F016：应该怎么改

保留 await allSettled 和 signal.throwIfAborted 的既有优先级，将最后循环替换为收集两条 rejected receipts 并抛 AggregateError。**该尾部改动只处理未 aborted 的路径**：实际 error listener 会调用 fail 并 abort，signal.throwIfAborted 可能先遮蔽本段，不能据此声称普通连接失败的全部 receipt 已完整保存。重复 listener 原因可能仍存在，别做按 message 去重（那会 inspect private 数据）；真正的全原因修正须先证明监督 owner 最终返回值的缺口。Handover 的本地 CLI adapter 没有有用直接 analogue；不借其 process.close/settle 冒充 remote resource 或 Redis connection receipt 的等价实现。

##### F016：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
const failures: unknown[] = []
for (const connection of connected) {
  if (connection.status === 'rejected') failures.push(connection.reason)
}
if (failures.length)
  throw new AggregateError(failures, 'Worker Redis connections failed')
```

**不能改变的事实**：两条 IO 都必须 settle，shutdown abort 仍先胜出；没有 retry/reconnect/Redis offline queue；own(task.catch(fail)) 和 done/stop 错误监督、single close receipt、cleanup owners 不改；public main 仍只 fixed classification。

**实施时的验证要求**：sh scripts/check.sh test apps/agent/src/worker.test.ts；加 owned loopback Redis connection 两拒绝 scenario，检查 private causes 两个均保留、没有公开错误文本；不以 mocked SDK 覆盖生产连接路径。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f017"></a>

#### F017 — 取消 run 的名字不要暗示只取消观察

- **优先级**：P2 / 降低生命周期误读。
- **适用置信度**：高。
- **符号**：`cancelObservation`。

**现在（连续原文）** — [`apps/server/src/conversation/http.ts:62–79`](../apps/server/src/conversation/http.ts#L62)

```ts
export async function cancelObservation(
  db: Kysely<DB>,
  query: OwnedThread & { runID: string },
  body: unknown,
) {
  const input = runCancellationSchema.safeParse(body)
  if (!input.success) return invalid()
  const outcome = await cancelRun(db, { ...query, ...input.data })
  if (outcome === 'unavailable') return unavailable()
  if (outcome === 'conflict') return conflict()
  return Response.json(
    {
      commandID: input.data.commandID,
      runID: query.runID,
    } satisfies CancellationAccepted,
    { status: 202 },
  )
}
```

##### F017：为什么不好

该函数调用 cancelRun 并产生 durable cancellation command，而 openObservation 是 SSE 观察。cancelObservation 容易让维护者把断开观察当成停止付费执行，或者误删 durability。改成 requestRunCancellation，并修改 http.ts:42 的 import 与 http.ts:359 的调用（不能仅加旧名转发 alias）。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:438–462`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L438-L462)

直接比较取消请求的语义命名：reference stopping endpoint 调用 askToStop；本项目也应明确 request，与观察断线或已停止区分。

```ts
/** Asking it to stop, which is allowed only while there is something to stop. */
function stopping({ db }: ConversationApi) {
  return aMember(db).post('/spaces/{slug}/conversations/{id}/stop', {
    summary: 'Ask the agent to stop what it is doing',
    params: { id: rowId },
    body: StopThis,
    answers: {
      204: 'Asked, or asked already',
      404: NOT_THERE,
      409: refuses(NOTHING_RUNNING, 'Nothing is running in it'),
    },

    run: async (c) => {
      const asked = await askToStop(db, {
        conversationId: c.req.valid('param').id,
        spaceId: c.get('space').id,
        key: c.req.valid('json').key,
      })

      if (asked.kind === 'no-conversation') return refused(c, UNAVAILABLE)
      if (asked.kind === 'nothing-to-stop') return refused(c, NOTHING_RUNNING)

      return nothing(c, 204)
    },
  })
```

##### F017：应该怎么改

仅将cancelObservation改名为requestRunCancellation，并更新actual调用；现有 DB cancelRun import 保留，不能同名遮蔽或新增转发 alias。保持route authorization、durable cancellation、202/replay/conflict语义，不把它解释为断开SSE。

##### F017：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
export async function requestRunCancellation(
  db: Kysely<DB>,
  query: OwnedThread & { runID: string },
  body: unknown,
) {
  const input = runCancellationSchema.safeParse(body)
  if (!input.success) return invalid()

  const outcome = await cancelRun(db, { ...query, ...input.data })
  if (outcome === 'unavailable') return unavailable()
  if (outcome === 'conflict') return conflict()

  return Response.json(
    {
      commandID: input.data.commandID,
      runID: query.runID,
    } satisfies CancellationAccepted,
    { status: 202 },
  )
}
```

**不能改变的事实**：URL、body、202/400/404/409、durable cancellation 与 authorization 不变；观察断开绝不隐式 cancel；202 不表示 remote cleanup 已成功。

**实施时的验证要求**：未来 typecheck；tests/integration/conversation-http.test.ts 与 execution-events.test.ts，补显式对照 disconnect vs cancellation。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f018"></a>

#### F018 — 资产完成的相邻字符串参数缺少具名 storage confirmation

- **优先级**：P2 / 边界与合同可维护性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`completeAsset signature`。

**现在（连续原文）** — [`apps/server/src/db/assets.ts:84–89`](../apps/server/src/db/assets.ts#L84)

```ts
export async function completeAsset(
  db: Kysely<DB>,
  query: OwnedThread,
  assetID: string,
  confirmedObjectKey: string,
) {
```

##### F018：为什么不好

assetID和confirmedObjectKey连续两个string位于OwnedThread之后。调用publishUpload按顺序传入；交换仍可编译，改变的是持久asset身份和确认的object location，不是普通显示字符串。命名参数能直接表达这一阶段的确认事实，不增加资源claim或重新验证typed value。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:478–484`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L478-L484)

Actual Handover reporting names conversationId, machineId, key and message in the confirmed write request rather than adjacent interchangeable string positions.

```ts
      const written = await machineSays(db, {
        conversationId: c.req.valid('param').id,
        machineId: c.get('machineId'),
        key: sent.key,
        message: sent.message,
      })
```

##### F018：应该怎么改

以具名confirmation参数替代相邻assetID/objectKey字符串；下方完整函数保留实际事务体。迁移所有调用者，包含publishUpload及storage tests中历史位置winner并发调用，不仅唯一生产调用者；不新增branded镜像或第二次校验。

##### F018：改完之后的形状（拟议，未实施）

```ts
export async function completeAsset(
  db: Kysely<DB>,
  query: OwnedThread,
  {
    assetID,
    confirmedObjectKey,
  }: Readonly<{ assetID: string; confirmedObjectKey: string }>,
) {
  return await db.transaction().execute(async (tx) => {
    await lockThread(tx, query, 'write')
    const reserved = await tx
      .selectFrom('product.assets')
      .selectAll()
      .where('asset_id', '=', assetID)
      .where('thread_id', '=', query.threadID)
      .where('source', '=', 'upload')
      .executeTakeFirst()
    if (!reserved) throw threadUnavailable
    // First confirmed publication wins. A concurrent legacy confirmation or
    // rehome must never change the location of an already-visible asset.
    if (reserved.ready_at !== null)
      return { asset: publicAsset(reserved), created: false }
    const row = await tx
      .updateTable('product.assets')
      .set({
        ready_at: sql<Date>`clock_timestamp()`,
        object_key: confirmedObjectKey,
      })
      .where('asset_id', '=', assetID)
      .where('thread_id', '=', query.threadID)
      .returningAll()
      .executeTakeFirstOrThrow()
    return { asset: publicAsset(row), created: true }
  })
}
```

publishUpload原return表达式；tests/storage/assets.test.ts两组completeAsset并发调用也需同一具名参数迁移。

```ts
return await completeAsset(db, query, {
  assetID: upload.assetID,
  confirmedObjectKey: objectKey,
})
```

**不能改变的事实**：同一thread锁内读取最新owner/archive/asset ready状态；第一ready位置胜出与后来幂等读取不变。确认objectKey不是任意caller storage权威；metadata和不可变digest不变。历史materials与新uploads竞争仍保留两份不可变对象。

**实施时的验证要求**：未来真实storage runner tests/scripts/storage-check.sh，特别tests/storage/assets.test.ts concurrent confirmed legacy and rehome publications...；tests/integration/conversation-http.test.ts权属/重放及严格typecheck检出所有调用者。

**当前验证状态**：Static source comparison only. AFTER is proposed, not implemented, compiled or functionally reproduced.

<a id="f019"></a>

#### F019 — 停机门应位于每条 outbox publication 的发起点

- **优先级**：P2 / 边界与合同可维护性。
- **适用置信度**：中：这是停止粒度的可选合同增强，不是已证明违反当前批次合同。
- **符号**：`CommandBatch / publishCommands`。
- **是否改变合同**：是：从batch-level stopping改为per-publication stopping；需要先确认停止合同。已发IO/COMMIT仍正常结算，不能以abort推断没有后果。

**现在（连续原文）** — [`apps/server/src/db/command-publication.ts:14–47`](../apps/server/src/db/command-publication.ts#L14)

```ts
type CommandBatch = Readonly<{
  limit: number
  publish: (command: ExecutionCommand) => Promise<void>
}>

// Each row commits independently. After a partial failure, retry retains the
// original identities and skips rows whose publication already committed.
export async function publishCommands(
  db: Kysely<DB>,
  batch: CommandBatch,
): Promise<number> {
  if (!Number.isSafeInteger(batch.limit) || batch.limit < 1) {
    throw new RangeError('Command batch limit must be a positive safe integer')
  }

  const pending = await db
    .selectFrom('product.command_outbox')
    .select('command_id')
    .where('published_at', 'is', null)
    .orderBy('created_at')
    .orderBy('command_id')
    .limit(batch.limit)
    .execute()

  let published = 0
  for (const row of pending) {
    const outcome = await publishCommand(db, {
      commandID: row.command_id,
      publish: batch.publish,
    })
    if (outcome === 'published') published += 1
  }
  return published
}
```

##### F019：为什么不好

publishPendingCommands 只在外层 while 看 signal；publishCommands 已取出的最多32行随后逐条启动事务。停机发生在第一条 transport IO 时，剩余31条仍可开启新 publication。与 receipt consumer 的逐条 stop gate 不一致；不是要求取消已发 xAdd 或挪走锁内 transport。 当前代码的合同是完成已经领取的有界批次；并没有发现未受控无限发起。这里提出逐条禁止后续发起，需要明确产品/停机政策后才采用，不能作为保持行为的纯重构。

**Handover 实际对照** — [`apps/server/src/db/conversation.ts:353–384`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/conversation.ts#L353-L384)

No direct business analogue for Redis publication. Handover machineSays keeps append and turn ledger in one transaction; comparison is keeping atomic effects while placing initiation decisions before effects.

```ts
export async function machineSays(db: Database, reporting: Reporting): Promise<Said> {
  return db.transaction().execute(async (tx) => {
    const conversation = await stillItsToWriteOn(tx, reporting)

    if (conversation === undefined) return { kind: 'no-conversation' }

    const written = await append(tx, reporting)

    // A line that was already here is a retry, and everything below already happened in the
    // transaction that wrote it. Carried on regardless, an ending retried under an old name ends
    // whichever turn is running *now* — which by then is a different question, still being
    // answered.
    if (written.kind === 'said-already') return written

    // The record and the ledger move together. An ending in the transcript with the turn still
    // open would leave a conversation that reads as finished and is still owed an answer — and
    // the machine would be handed the same question again on its next report.
    if (ends(reporting.message)) {
      const running = await openTurn(tx, reporting.conversationId)
      if (running !== undefined) await endTurn(tx, reporting.conversationId, running)
      // A turn that went wrong stops a piece of work that was handed over: whether it matters is
      // a person's to say, and an agent that is not handed a turn cannot try again on its own.
      if (wentWrong(reporting.message)) await waitsForAPerson(tx, reporting.conversationId)
      // This machine has just become free, and whatever it is holding open was answered "nothing"
      // because it was not. Waking it is how the next question starts now rather than in
      // twenty-five seconds.
      await wakeMachine(tx, reporting.machineId)
    }

    return written
  })
}
```

##### F019：应该怎么改

CommandBatch 增加可选 signal，每条 publishCommand 前检查；publisher 传 polling.signal。在途 transaction 照常等待并结算；不把 abort 当作 COMMIT/transport 未发生证明。

##### F019：最终复审裁决

**拒绝下文 AFTER，保留当前 bounded batch 的停机合同。** 每条新增 stop gate 会改变已选后续行的发起和错误可见性；当前 owner 明确以新 batch 为停机门，并等待真实 transport/SQL settlement。独立源码复核及本轮 native publication/relay 回归依据见 [实施记录](handover-refactoring.md)，不新增闲置 signal 参数或替换 durability 设计。

##### F019：改完之后的形状（拟议，未实施）

```ts
type CommandBatch = Readonly<{
  limit: number
  signal?: AbortSignal
  publish: (command: ExecutionCommand) => Promise<void>
}>

export async function publishCommands(
  db: Kysely<DB>,
  batch: CommandBatch,
): Promise<number> {
  if (!Number.isSafeInteger(batch.limit) || batch.limit < 1)
    throw new RangeError('Command batch limit must be a positive safe integer')
  if (batch.signal?.aborted) return 0
  const pending = await db
    .selectFrom('product.command_outbox')
    .select('command_id')
    .where('published_at', 'is', null)
    .orderBy('created_at')
    .orderBy('command_id')
    .limit(batch.limit)
    .execute()
  let published = 0
  for (const row of pending) {
    if (batch.signal?.aborted) break
    const outcome = await publishCommand(db, {
      commandID: row.command_id,
      publish: batch.publish,
    })
    if (outcome === 'published') published += 1
  }
  return published
}

// Replace the entire publishCommands call in publishPendingCommands:
await publishCommands(db, {
  limit: 32,
  signal: polling.signal,
  publish: async (command) => {
    await commands.xAdd(executionStreams.commands, '*', {
      command: JSON.stringify(command),
    })
  },
})
```

**不能改变的事实**：本条若采用仅停止后续发起，不取消已发xAdd或拆开publication row lock；原same-ID重投/unknown COMMIT和已发布跳过保持。总批次32上限仍有界；不制造transport exactly-once承诺。

**实施时的验证要求**：sh scripts/check.sh; add SQL outbox batch regression: hold first publisher receipt, abort, resolve it, assert later rows remain unpublished and identical IDs remain retryable.

**当前验证状态**：Static source comparison only. AFTER is proposed, not implemented, compiled or functionally reproduced.

<a id="f020"></a>

#### F020 — 观察 cursor 文档不可把 thread publication 与 run ordinal 混为一谈

- **优先级**：P2 / 边界与合同可维护性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`observeRun.description and Last-Event-ID.description`。

**现在（连续原文）** — [`apps/server/src/http.ts:375–390`](../apps/server/src/http.ts#L375)

```ts
      description:
        'Official AG-UI RunAgentInput (https://docs.ag-ui.com/sdk/js/core). Runtime validation uses the official SDK. JSON metadata cannot faithfully describe its custom values; no replacement DTO is generated. Cursor precedence: Last-Event-ID, forwardedProps.after, then 0. Cursors are decimal signed-int64 ordinals authorized against persisted public events.',
      requestBody: {
        required: true,
        description:
          'Official RunAgentInput: threadId and runId must be UUIDs matching the canonical path identifiers. Submitted history, state, context and tools never initiate new execution.',
        content: { 'application/json': {} },
      },
      parameters: [
        {
          in: 'header',
          name: 'Last-Event-ID',
          schema: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
          description: 'Decimal ordinal at most 9223372036854775807',
        },
      ],
```

##### F020：为什么不好

文档写“decimal signed-int64 ordinals”与“Decimal ordinal”。实际execution ordinal为run-local，readPublicEvents按独立replay_cursor读取，SQL sequence在thread锁后给public publication发cursor，terminal过滤还会使receipt没有public cursor。客户端按ordinal续传会拿到不存在或其他publication cursor；只改文档，不改边界。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F020：应该怎么改

替换完整description字符串；显式opaque decimal publication cursor, 0起点, scope thread, gaps合法，不许自行加1，明确与execution ordinal不同。

##### F020：改完之后的形状（拟议，未实施）

```ts
// Replace observeRun description:
'Official AG-UI RunAgentInput (https://docs.ag-ui.com/sdk/js/core). Runtime validation uses the official SDK. JSON metadata cannot faithfully describe its custom values; no replacement DTO is generated. Cursor precedence: Last-Event-ID, forwardedProps.after, then 0. A cursor is an opaque decimal signed-int64 public publication identity authorized for the owned thread, not a run-local execution ordinal. Preserve the returned value exactly; gaps are valid and clients must not increment it.'

// Replace Last-Event-ID description:
'Opaque public publication cursor at most 9223372036854775807, authorized for this thread; 0 starts from the beginning. Not an execution ordinal.'
```

**不能改变的事实**：只澄清metadata语义，不改cursor生成/read过滤；Last-Event-ID优先、forwardedProps.after次之、0默认不变，thread授权和int64上限保持。若更新generated产物须离线生成，不手改。

**实施时的验证要求**：sh scripts/check.sh test apps/server/src/http.test.ts; add generated route metadata assertion that documentation distinguishes public cursor from execution ordinal. No direct Handover two-clock business analogue; reference null.

**当前验证状态**：Static evidence only; proposed AFTER is not implemented, compiled or run. No functional failure is claimed reproduced.

<a id="f021"></a>

#### F021 — bucket名称准入不应只存在于本地provisioning程序

- **优先级**：P2 / 边界与验收。
- **适用置信度**：高（静态证据；拟议实现未验证）。
- **符号**：`objectStorage configuration shape`。
- **是否改变合同**：配置合同收紧：原先非空但格式更宽的external bucket被拒绝。先确认所有支持的S3-compatible endpoints采用这组portable限制；不是无行为变化重构。

**现在（连续原文）** — [`packages/config/src/env.ts:50–55`](../packages/config/src/env.ts#L50)

```ts
const objectStorage = {
  OBJECT_STORAGE_URL: httpUrl,
  OBJECT_STORAGE_REGION: requiredString,
  OBJECT_STORAGE_BUCKET: requiredString,
  OBJECT_STORAGE_ACCESS_KEY_ID: requiredString,
  OBJECT_STORAGE_SECRET_ACCESS_KEY: requiredString,
```

##### F021：为什么不好

OBJECT_STORAGE_BUCKET只要求非空，而本地init已有格式约束。external endpoint按设计跳过本地init，不意味着external bucket配置已经过相同名称准入。静态风险是错误可推迟到asset IO；没有复现实际外部请求失败。

**Handover 实际对照** — [`apps/server/src/env.ts:64–72`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/env.ts#L64-L72)

reference bucket env同样只nonempty，因此不是它已经实现bucket-format validation的证明。没有local/external provisioning skip的直接对应，本项基于本项目两个准入边界。

```ts
   *
   * The endpoint is absent for AWS itself and explicit for an S3-compatible store such as MinIO
   * or R2. The bucket and region are always stated: a process that guessed a bucket could write a
   * valid object to the wrong deployment, which is a successful request and a missing avatar at
   * the same time.
   */
  OBJECT_STORE_BUCKET: z.string().min(1),
  OBJECT_STORE_REGION: z.string().min(1),
  OBJECT_STORE_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
```

##### F021：应该怎么改

在env owner加入私有Zod名称规则，采用本地init已执行的可移植限制。external资源仍operator-provisioned，不探测existence、不发送本地root凭据、不增加无依据reserved-name限制。

##### F021：最终复审裁决

**拒绝下文 AFTER，保留外部 endpoint 既有准入。** 本地 provisioning 的正则不代表所有外部 provider 的合同；actual config 与官方 SDK path-style endpoint 解析会接受提案新拒绝的原字符串。没有依据统一收紧，解析成功也不等于外部 PUT 或持久性已验收。边界与反例详见 [实施记录](handover-refactoring.md)。

##### F021：改完之后的形状（拟议，未实施）

所列原文件的局部replacement；必要的新模块/调用段落另列，不是全库可直接应用补丁。

```ts
const objectBucket = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, {
    error: 'Must be a portable S3 bucket name',
  })
  .refine(
    (name) =>
      !name.includes('..') &&
      !name.includes('.-') &&
      !name.includes('-.') &&
      !/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(name),
    { error: 'Must be a portable S3 bucket name' },
  )
```

已有objectStorage对象中的完整property。

```ts
OBJECT_STORAGE_BUCKET: objectBucket,
```

**不能改变的事实**：默认与符合规则的bucket保留；诊断只显示字段而不泄露credentials。外部S3兼容provider若原允许更宽名字，须明确兼容决策，不能声称全部已有名称不变。

**实施时的验证要求**：实施后增加两进程的quoted/IPv4-shaped/adjacent-dots拒绝与alternate-assets通过；保留storage-initialization测试shell准入的独立职责；运行sh scripts/check.sh。

**当前验证状态**：源body完整阅读，范围/hash静态核对。AFTER未实施、未编译、未类型检查、未功能验证；未运行Docker/VM/provider旅程。

<a id="f022"></a>

#### F022 — 文件名合同允许孤立 surrogate，但下载 header 编码拒绝它

- **优先级**：P2 / 边界与合同可维护性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`fileNameSchema`。
- **是否改变合同**：是：现有测试明确接受lone surrogate；改为拒绝是filename合同改变，不是保持行为的排版。需要评估旧数据与native/foreign兼容。

**现在（连续原文）** — [`packages/contract/src/file-name.ts:3–15`](../packages/contract/src/file-name.ts#L3)

```ts
export const fileNameSchema = z
  .string()
  .min(1)
  .max(255)
  // No /u flag: the bound must count UTF-16 units, not Unicode code points.
  .regex(
    // oxlint-disable-next-line no-control-regex -- The filename boundary must reject ASCII controls.
    /^(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f]{1,255}$/,
    'File names must be 1–255 UTF-16 code units, not dot names or paths, and cannot contain ASCII controls',
  )
  .describe(
    'File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.',
  )
```

##### F022：为什么不好

file-name.test.ts显式把孤立high/low surrogate列为true/true；fileNameSchema因此允许不能可靠写入PostgreSQL JSONB或encodeURIComponent的名字。encodeURIComponent对这种值抛URIError是静态事实，但不能断言已存在“可见但下载失败”的generated asset：正常receipt JSONB路径可能更早拒绝。问题是filename合同与持久化/UTF-8 header消费者不一致，边界在哪里裁决需要写清。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F022：最终复审裁决

**本轮拒绝下文 AFTER，保留原合同。** 实测 JSONB 会更早拒绝 invalid generated receipt；PG text/varchar 参数会把孤立 surrogate 替换为 U+FFFD，正常 PG UTF8 text 回读不产生原样孤立 surrogate。没有复现正常 persisted asset 的下载故障，原生 encoder 的内存异常不能作为静默修改现有 true/true 接受集的理由。UTF16 255 预算、有效 astral、既有 identities/locations 与规范产物均保持；准入/可持久性落差明确记录，不自动清洗、替换或重推理。原生/官方 SDK 证据和局限见 [实施记录](handover-refactoring.md) 与 `/tmp/handover-refactor-unicode-proof.{md,json}`。

##### F022：应该怎么改

增加独立 Unicode-mode 字符合法性 regex。原 no-/u 正则和 max255仍负责 UTF16单位长度；不要整体切换到 /u 改变计数。更新两个 surrogate test rows 为false/false，保留 emoji长度差异与安全头。

##### F022：改完之后的形状（拟议，未实施）

```ts
export const fileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    // Keep UTF-16 unit counting independent of Unicode validity.
    // oxlint-disable-next-line no-control-regex -- Filename admission rejects ASCII controls.
    /^(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f]{1,255}$/,
    'File names must be 1–255 UTF-16 code units, not dot names or paths, and cannot contain ASCII controls',
  )
  .regex(/^[^\ud800-\udfff]*$/u, 'File names cannot contain lone surrogates')
  .describe(
    'File name, not a path. Length is measured in UTF-16 code units at runtime; foreign validators may count Unicode code points.',
  )
```

**不能改变的事实**：UTF16单位255上界与dot/path/ASCII control拒绝不变；不要把第一个regex整体改为/u导致长度语义改变。有效astral emoji仍通过；任意旧资产位置/identity不变，不修历史migration，不自动改写既有文件名。

**实施时的验证要求**：sh scripts/check.sh test packages/contract/src/file-name.test.ts apps/server/src/assets/files.test.ts; add completion asset name rejection and valid emoji attachment filename HTTP regression.

**当前验证状态**：Static source comparison only. AFTER is proposed, not implemented, compiled or functionally reproduced.

<a id="f023"></a>

#### F023 — legacy assignment的CLI输出与trusted API原因应分开

- **优先级**：P2 / 边界与验收。
- **适用置信度**：高（静态证据；拟议实现未验证）。
- **符号**：`administrative CLI entrypoint`。
- **是否改变合同**：CLI的可见diagnostic/exit输出政策改变；exported trusted API保留全原因。现有administration child断言明确期待native原因，因此必须协调更新，不能宣称零行为diff。

**现在（连续原文）** — [`scripts/assign-legacy-threads.ts:34–41`](../scripts/assign-legacy-threads.ts#L34)

```ts
if (import.meta.main) {
  const path = process.argv[2]
  if (!path || process.argv.length !== 3)
    throw new Error(
      'Usage: bun scripts/assign-legacy-threads.ts reviewed-assignments.json',
    )
  console.log(await assignReviewedLegacyThreads(path, readAdministrationEnv()))
}
```

##### F023：为什么不好

CLI未捕获JSON/Zod/DB/聚合cleanup失败，native未处理异常render可能展示input/SQL/connection细节。是静态potential disclosure，不是已复现泄露。exported函数必须继续保留trusted调用者的完整原因；CLI是否允许native诊断是要决定的输出合同。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F023：应该怎么改

只包装CLI调用，固定recovery statement并exitCode=1；unsupported args与operation failure不插值输入。事务/API unchanged。现有administration subprocess测试明确期待两个native原因，必须协调更新；不能宣称此项无observable变化。

##### F023：最终复审裁决

**拒绝下文 AFTER，保留 trusted administrator CLI 原因可见性。** 现有 native SQL 回归要求 deadline 和 operation/close 双原因可见，固定一行 catch-all 会删除实际管理合同。公共 HTTP/事件/产品进程的隐私 allowlist 不因此放宽；不发明新私有 side-channel 迁就提案。依据见 [实施记录](handover-refactoring.md)。

##### F023：改完之后的形状（拟议，未实施）

所列原文件的局部replacement；必要的新模块/调用段落另列，不是全库可直接应用补丁。

```ts
if (import.meta.main) {
  const path = process.argv[2]
  if (!path || process.argv.length !== 3) {
    console.error(
      'Usage: bun scripts/assign-legacy-threads.ts reviewed-assignments.json',
    )
    process.exitCode = 1
  } else {
    try {
      console.log(
        await assignReviewedLegacyThreads(path, readAdministrationEnv()),
      )
    } catch {
      console.error(
        'Legacy assignment failed; inspect the reviewed input and database state before any retry.',
      )
      process.exitCode = 1
    }
  }
}
```

**不能改变的事实**：不自动认领identity、创建users、删除或blind retry；API仍保留private causes。DB settlement后才打印固定CLI失败；双cause证明转到trusted API而非公开CLI。

**实施时的验证要求**：实施后增加invalid JSON/private marker/refused DB subprocess测试，检查exit1及无marker；更新tests/integration/administration.test.ts的CLI断言，在trusted调用边界继续验证primary+cleanup causes；与I15的watchdog方案一起合并。

**当前验证状态**：源body完整阅读，范围/hash静态核对。AFTER未实施、未编译、未类型检查、未功能验证；未运行Docker/VM/provider旅程。

<a id="f024"></a>

#### F024 — generate/verify参数应在分配fixture前明确拒绝

- **优先级**：P2 / 边界与验收。
- **适用置信度**：高（静态证据；拟议实现未验证）。
- **符号**：`mode and forwarded argument admission`。
- **是否改变合同**：新拒绝以前被忽略的generate/verify trailing args，exit2发生在allocation前。正常合法模式不变。

**现在（连续原文）** — [`scripts/database-check.sh:4–8`](../scripts/database-check.sh#L4)

```sh
mode=${1:-test}
case "$mode" in test|check|generate|verify) ;; *) echo 'Usage: sh scripts/database-check.sh [test|check|generate|verify]' >&2; exit 2 ;; esac
if [ "$#" -gt 0 ]; then shift; fi
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
. "$root/scripts/check-lifecycle.sh"
```

##### F024：为什么不好

database-check.sh保存剩余args给test/check，但generate/verify完全不消费。verify unexpected会在fixture setup后静默忽略，使调用者误以为选项有效。mode已早拒绝，剩余参数也应有明确合同。

**Handover 实际对照** — [`apps/server/scripts/run-command.ts:27–33`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/scripts/run-command.ts#L27-L33)

reference command runner显式处理invocation失败，但没有四-mode参数同构；只借实际边界清楚性，不复制命令格式。

```ts
export function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { cwd: ROOT, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}
```

##### F024：应该怎么改

test/check继续转发Bun args，generate/verify剩余args先exit2。保持无参数default test，不等Docker/image staging才拒绝。

##### F024：改完之后的形状（拟议，未实施）

所列原文件的局部replacement；必要的新模块/调用段落另列，不是全库可直接应用补丁。

```sh
mode=${1:-test}
case "$mode" in
  test|check|generate|verify) ;;
  *)
    echo 'Usage: sh scripts/database-check.sh [test|check|generate|verify]' >&2
    exit 2
    ;;
esac
if [ "$#" -gt 0 ]; then shift; fi
case "$mode" in
  generate|verify)
    if [ "$#" -ne 0 ]; then
      echo 'generate and verify do not accept test arguments' >&2
      exit 2
    fi
    ;;
esac
```

**不能改变的事实**：不改变fixture权威、generated hashes/content或test参数转发；拒绝发生在Docker、filesystem allocation和secret读取前。

**实施时的验证要求**：在database-project.test.ts用empty PATH/Docker canary检查generate/verify extra token exit2；未来隔离runner仍验证四种合法模式。

**当前验证状态**：源body完整阅读，范围/hash静态核对。AFTER未实施、未编译、未类型检查、未功能验证；未运行Docker/VM/provider旅程。

<a id="f025"></a>

#### F025 — 独立测试资源的 cleanup 应互不阻止并保留全部失败

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`network probe finally`。

**现在（连续原文）** — [`tests/sandbox/e2b.test.ts:193–196`](../tests/sandbox/e2b.test.ts#L193)

```ts
    } finally {
      await probe.stop(true)
      await sandbox.close()
    }
```

##### F025：为什么不好

网络隔离测试 finally 顺序 await probe.stop(true) 然后 sandbox.close；前者一旦拒绝会跳过 pause。afterAll 仍按 owned runID kill，因此不是已证实 orphan 泄漏，但单测试不能丢掉 pause receipt；两个资源没有 drain 依赖（control sandbox 已在自己的 finally kill）。应独立尝试而非把它们接成成功链。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F025：应该怎么改

只替换这段 finally 的资源结算正文，Promise.resolve().then 捕获同步 throw，使全部尝试进入 allSettled；汇总 fixed-message AggregateError。主测试失败 + cleanup 失败的优先级若要进一步保留需单独记录 primary，不将这段误说为解决 primary masking。 Handover 的本地 CLI adapter 没有有用直接 analogue；不借其 process.close/settle 冒充 remote resource 或 Redis connection receipt 的等价实现。

##### F025：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
const settled = await Promise.allSettled([
  Promise.resolve().then(() => probe.stop(true)),
  Promise.resolve().then(() => sandbox.close()),
])
const failures: unknown[] = []
for (const result of settled) {
  if (result.status === 'rejected') failures.push(result.reason)
}
if (failures.length)
  throw new AggregateError(failures, 'Network test resource cleanup failed')
```

**不能改变的事实**：probe 与 assigned sandbox 各自 cleanup owner 不增加重放/退款；afterAll 仍保留 IDs 并 reconcile unknown allocation；其它有顺序依赖的 control.kill/issued IO 不并行化。

**实施时的验证要求**：实施者在显式 owned Embed 环境运行 sh scripts/sandbox-check.sh tests/sandbox/e2b.test.ts；不能默认 paid Cloud。补 focused local cleanup scenario：probe stop reject，sandbox close 仍执行，两个 reject 都保留。审计没有运行 Docker/VM。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f026"></a>

#### F026 — restart shell cleanup 不覆盖原始失败或信号状态

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`cleanup shell trap`。
- **是否改变合同**：是：主失败且cleanup失败时退出码从1改为原主失败/信号码；仍非零。必须用shell harness验证，不伪称不改变可观察行为。

**现在（连续原文）** — [`tests/sandbox/restart-check.sh:11–44`](../tests/sandbox/restart-check.sh#L11)

```sh
cleanup() {
 status=$?; trap - EXIT HUP INT TERM
 # The build has no sandbox or runner to reconcile. Seed dispatch can commit
 # before losing its receipt, so cleanup must check actual labelled ownership.
 if [ "$remote_attempted" -eq 1 ]; then
 ssh_vm sh -s -- "$owner" <<'CLEAN' || status=1
set -eu
cd "$HOME/e2b"
if sudo timeout 10 docker inspect "$1" >/dev/null 2>&1; then
 label=$(sudo timeout 5 docker inspect --format '{{ index .Config.Labels "vid.check.owner" }}' "$1")
 [ "$label" = "$1" ] || exit 1
 sudo timeout 10 docker stop --time 5 "$1" >/dev/null || :
 sudo timeout 5 docker start "$1" >/dev/null
 sudo timeout 10 sh -c 'iptables -C INPUT -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP 2>/dev/null || iptables -I INPUT 1 -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP; iptables -C DOCKER-USER -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP'
 sudo timeout 90 docker compose up -d --wait >/dev/null
 sudo timeout 15 docker exec -e E2B_RESTART_PHASE=cleanup "$1" bun test tests/sandbox/native-restart.test.ts
 label=$(sudo timeout 5 docker inspect --format '{{ index .Config.Labels "vid.check.owner" }}' "$1")
 [ "$label" = "$1" ] || exit 1
 sudo timeout 5 docker rm -f "$1" >/dev/null
else
 # A failed inspect is not evidence of absence (daemon errors and timeouts
 # have the same status). Only a successful full listing may release metadata.
 names=$(sudo timeout 10 docker container ls -a --format '{{.Names}}')
 if printf '%s\n' "$names" | grep -Fx "$1" >/dev/null; then
  echo "Cleanup inspection uncertain for owned runner $1" >&2
  exit 1
 fi
fi
sudo timeout 5 rm -f "/tmp/$1.env"
CLEAN
 fi
 rm -rf "$staging" || status=1
 exit "$status"
}
```

##### F026：为什么不好

cleanup 先保留 status=$?，但 remote cleanup 或 staging rm 一旦失败就无条件 status=1，使 run-stage failure/129/130/143 变成 1。脚本仍正确失败，问题是 primary failure provenance 被覆写，无法区分人为终止与资源清理失败。本仓 scripts/check.sh 已用独立 failed 且只有 primary==0 时更新退出码，restart runner 应遵循同一个 owner 模式。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F026：应该怎么改

替换下方完整cleanup函数。remote heredoc/权限/ownedrunner判断保持，外层新增failed变量只记录cleanup失败；主status非零时不覆盖，主成功时才转cleanup失败。SSH调用的owner与iptables/S3/metadata范围不扩大。

##### F026：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```sh
cleanup() {
 status=$?
 trap - EXIT HUP INT TERM
 failed=0
 # The build has no sandbox or runner to reconcile. Seed dispatch can commit
 # before losing its receipt, so cleanup must check actual labelled ownership.
 if [ "$remote_attempted" -eq 1 ]; then
 ssh_vm sh -s -- "$owner" <<'CLEAN' || failed=1
set -eu
cd "$HOME/e2b"
if sudo timeout 10 docker inspect "$1" >/dev/null 2>&1; then
 label=$(sudo timeout 5 docker inspect --format '{{ index .Config.Labels "vid.check.owner" }}' "$1")
 [ "$label" = "$1" ] || exit 1
 sudo timeout 10 docker stop --time 5 "$1" >/dev/null || :
 sudo timeout 5 docker start "$1" >/dev/null
 sudo timeout 10 sh -c 'iptables -C INPUT -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP 2>/dev/null || iptables -I INPUT 1 -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP; iptables -C DOCKER-USER -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -i eth0 -p tcp -m conntrack --ctstate NEW -j DROP'
 sudo timeout 90 docker compose up -d --wait >/dev/null
 sudo timeout 15 docker exec -e E2B_RESTART_PHASE=cleanup "$1" bun test tests/sandbox/native-restart.test.ts
 label=$(sudo timeout 5 docker inspect --format '{{ index .Config.Labels "vid.check.owner" }}' "$1")
 [ "$label" = "$1" ] || exit 1
 sudo timeout 5 docker rm -f "$1" >/dev/null
else
 # A failed inspect is not evidence of absence (daemon errors and timeouts
 # have the same status). Only a successful full listing may release metadata.
 names=$(sudo timeout 10 docker container ls -a --format '{{.Names}}')
 if printf '%s\n' "$names" | grep -Fx "$1" >/dev/null; then
  echo "Cleanup inspection uncertain for owned runner $1" >&2
  exit 1
 fi
fi
sudo timeout 5 rm -f "/tmp/$1.env"
CLEAN
 fi
 rm -rf "$staging" || failed=1
 if [ "$failed" -ne 0 ]; then
  echo "Cleanup incomplete for owned runner $owner" >&2
 fi
 if [ "$status" -eq 0 ]; then status=$failed; fi
 exit "$status"
}
```

**不能改变的事实**：cleanup 无论主失败仍执行，label 验证、successful listing proof、iptables guards、metadata retention、有限 timeout 不改；主成功/cleanup 失败仍非零；不删除未知 sandbox 身份或外部 paid resources。

**实施时的验证要求**：sh -n tests/sandbox/restart-check.sh（实施者执行）；focused shell harness：primary 0/2/129/130/143 × cleanup success/fail 的退出码和警告；真实 host-restart journey 仅显式 local Embed，审计未运行。Reference 无有用直接 analogue；该 shell owner 是本项目特有的 native host restart verification，沿用本仓 scripts/check.sh。 对应实际 journey 命令 sh scripts/sandbox-check.sh --restart（仅实施者在显式 local Embed 环境执行）。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

### 代码形状与阅读节奏

<a id="f027"></a>

#### F027 — 生成 artifact 树的递归归并使用直接循环

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`tree`。

**现在（连续原文）** — [`.github/verify-api.ts:6–25`](../.github/verify-api.ts#L6)

```ts
async function tree(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      Object.assign(
        files,
        Object.fromEntries(
          Object.entries(await tree(path)).map(([name, content]) => [
            `${entry.name}/${name}`,
            content,
          ]),
        ),
      )
    } else {
      files[entry.name] = (await readFile(path)).toString('base64')
    }
  }
  return files
}
```

##### F027：为什么不好

Object.assign(Object.fromEntries(Object.entries(await tree).map(tuple))) 在 recursion 中嵌了四层表达式。字节内容不是 transformation pipeline：只给 child 文件名前加目录前缀。用两段有名字的循环；不改变 base64 精确比较。

**Handover 对照边界**：参考仓库没有核实到同构的生成物递归树比较，不强行把其 map/filter 链当直接循环的最佳示例。本项只以当前四层转换与等价两段循环比较。

##### F027：应该怎么改

递归walk里直接累积files：目录递归、普通文件push。保持当前实际排序/相对路径和read-only comparison，非文件/目录原过滤规则不改变，不新增tree framework。

##### F027：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
async function tree(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (!entry.isDirectory()) {
      files[entry.name] = (await readFile(path)).toString('base64')
      continue
    }
    const children = await tree(path)
    for (const [name, content] of Object.entries(children)) {
      files[`${entry.name}/${name}`] = content
    }
  }
  return files
}
```

**不能改变的事实**：递归、相对 path、二进制 base64 比较不变；生成失败不允许继续比较；rm owner 仍 finally；不要降低 artifact mismatch 到 warning。

**实施时的验证要求**：未来 .github/verify-api.ts；在 /tmp 构建嵌套二进制树验证两算法输出一致；不以 calls/count 代替 artifact 内容。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f028"></a>

#### F028 — 明确采用 100 列，但把列宽视为排版预算而非重构规则

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`Prettier configuration`。

**现在（连续原文）** — [`.prettierrc.json:1–5`](../.prettierrc.json#L1)

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all"
}
```

##### F028：为什么不好

当前未设置 printWidth，使用 Prettier 默认 80。WorkerAssignment 的泛型、find 回调、单个 await 调用被分成多行；视觉碎片多于表达的概念。100 列能减少非语义断裂，但不能修复嵌套三元、匿名事务或长模板字符串。建议团队确认后显式设置 100，单独提交排版 diff；不要为缩到 80 列新增 helper，也不要为了利用 100 列合并安全阶段。

**Handover 实际对照** — [`.prettierrc:1–6`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/.prettierrc#L1-L6)

直接配置对应：Handover 显式使用 100 列。这个选择是偏好，不是正确性证明。

```text
{
  "semi": false,
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "all"
}
```

##### F028：应该怎么改

先明确团队选择100列，单独review格式diff；配置只新增printWidth。不要用formatter掩盖下面的结构/行为变化，也不要重排生成物或历史migration。

##### F028：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```json
{
  "semi": false,
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "all"
}
```

**不能改变的事实**：只改排版；生成物、历史迁移的内容不改；安全条件与执行顺序不变。

**实施时的验证要求**：未来运行 bun run fmt:check，抽样比较 worker、file tools、SQL；检查所有语义 diff 为零。不能仅用 formatter 作为本报告其余项的验收。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f029"></a>

#### F029 — 并发 fixture 使用原生 Promise.withResolvers 表达 latch

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`deferred`。

**现在（连续原文）** — [`apps/agent/src/execute-run.test.ts:14–21`](../apps/agent/src/execute-run.test.ts#L14)

```ts
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
```

##### F029：为什么不好

测试为每个 latch 手写 Promise constructor + definite assignment assertion，再回传 promise/resolve；读者需证明 constructor 同步赋值。相邻 native-command.test.ts 已使用 Promise.withResolvers，当前 Bun/TS 环境已有实际先例。应消除同一生命周期 primitive 的两种写法，不为了统一而引入通用测试框架。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F029：应该怎么改

将这个被多处测试使用的 helper 的完整实现替换为 native primitive；保留 helper 名是为避免无关调用点 diff，并不增加新的包。拒绝通道可以由 native 返回但不必消费。

##### F029：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
function deferred<Value>() {
  return Promise.withResolvers<Value>()
}
```

**不能改变的事实**：所有测试仍由人工 release 控制真实 settle，不用 sleep 取代 causal barrier；不改 production 或真实 SDK transport fixture。

**实施时的验证要求**：sh scripts/check.sh test apps/agent/src/execute-run.test.ts；sh scripts/check.sh（校验 Promise.withResolvers 的既有 ES/Bun typings）。Reference 无有用直接 analogue；采用本仓 native-command.test.ts:16–18 的既有方式。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f030"></a>

#### F030 — diagnose 的默认分类从类型/默认参数交界移到函数体

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`diagnose`。

**现在（连续原文）** — [`apps/agent/src/execute-run.ts:200–218`](../apps/agent/src/execute-run.ts#L200)

```ts
function diagnose(
  execution: Execution,
  stage: FailureStage,
  classification:
    | 'unknown-outcome'
    | 'text-budget-exceeded'
    | 'history-limit-exceeded' = execution.historyRejected
    ? 'history-limit-exceeded'
    : 'unknown-outcome',
) {
  // Private diagnostics deliberately never inspect a rejected value, including
  // its message/cause/status/body. Public failure reasons remain unchanged.
  console.error({
    runID: execution.lease.runID,
    fence: execution.lease.fence,
    stage,
    classification,
  })
}
```

##### F030：为什么不好

classification 的 multiline union、默认值三元与 execution.historyRejected 混在同一个参数声明中。这个复杂视觉形状不是函数有多个责任，而是类型与决定缠在一起。私有 union 命名后，在函数体明确 default。

**Handover 实际对照** — [`apps/cli/src/agents/agent.ts:132–139`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/agents/agent.ts#L132-L139)

reference 给 turn outcome 一个局部 Why 联合名，让消费函数不混入长类型表达式。这里只命名私有诊断 classification，不替换本项目公开失败协议。

```ts
 * afterwards.
 */
export type Why =
  | { readonly why: 'done' }
  | { readonly why: 'cancelled' }
  /** `said` is shown to a person, so it owes them plain words rather than whatever was thrown. */
  | { readonly why: 'failed'; readonly said: string }
```

##### F030：应该怎么改

给可选diagnostic kind在函数体内明确默认值，不在类型/默认参数/条件交界里塞一个长式。保持显式传入kind优先，private cause分类与终态write规则不变。

##### F030：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
type FailureClassification =
  'unknown-outcome' | 'text-budget-exceeded' | 'history-limit-exceeded'

function diagnose(
  execution: Execution,
  stage: FailureStage,
  classification?: FailureClassification,
) {
  const defaultClassification = execution.historyRejected
    ? 'history-limit-exceeded'
    : 'unknown-outcome'
  // Never inspect a native rejected value, including its message or cause.
  console.error({
    runID: execution.lease.runID,
    fence: execution.lease.fence,
    stage,
    classification: classification ?? defaultClassification,
  })
}
```

**不能改变的事实**：diagnostics 只 four safe fields；不加入 native error/cause/body/status；显式 classification 优先；默认 historyRejected 分类保持；不把 public failure reason 扩成 private categories。

**实施时的验证要求**：未来 execute-run.test.ts diagnostics canaries；tests/scripts/process-diagnostics.test.ts；实际 report 不声称这些测试已运行。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f031"></a>

#### F031 — 终态完成分支在本地证明 product，不使用跨条件 non-null assertion

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`finishExecution`。
- **是否改变合同**：仅内部不可能状态的日志数量会改变：guard移入try会新增安全diagnose。正常complete/cancel/fail与unknown COMMIT不变；若要完全保持日志合同需采用说明里的try前narrowing方案。

**现在（连续原文）** — [`apps/agent/src/execute-run.ts:404–441`](../apps/agent/src/execute-run.ts#L404)

```ts
async function finishExecution(
  execution: Execution,
  turnProduct: SettledTurn,
): Promise<ExecutionOutcome> {
  const { lease, deps, reason } = execution
  if (reason === 'lost') return 'lost'
  if (reason === undefined && turnProduct === undefined)
    throw new Error('Execution settled without a turn result')
  let stage: 'terminal-complete' | 'terminal-cancel' | 'terminal-fail' =
    'terminal-complete'
  let accepted: boolean | ExecutionOutcome
  try {
    if (reason === 'cancel') {
      stage = 'terminal-cancel'
      accepted = await deps.writes.cancel(lease)
    } else if (reason !== undefined) {
      stage = 'terminal-fail'
      accepted = await deps.writes.fail(lease, reason)
    } else {
      // An unknown COMMIT must retain uploaded objects, which SQL may have committed.
      accepted = await deps.writes.complete(lease, turnProduct!)
    }
  } catch (error) {
    diagnose(execution, stage)
    throw error
  }
  if (typeof accepted === 'string') return accepted
  if (accepted) {
    const outcomes = {
      'terminal-complete': 'completed',
      'terminal-cancel': 'cancelled',
      'terminal-fail': 'failed',
    } as const
    return outcomes[stage]
  }
  return 'lost'
}
```

##### F031：为什么不好

函数先检查 reason===undefined && turnProduct===undefined，再经过三分支在 complete 中用 turnProduct!。TS 无法保持两个独立变量的关系；视觉上完成数据的证明与消费隔了十多行，断言成为读者需要自行验证的隐含合同。

**Handover 实际对照** — [`apps/cli/src/answering.ts:250–265`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/answering.ts#L250-L265)

reference ended 把 why/whole 的实际决定显式放在同一消费段；无直接 completion/history business analogue。

```ts
/** How a turn the agent finished is closed, and what is said about it out loud. */
async function ended(
  writing: Writing,
  asking: Asking,
  say: (line: string) => void,
  /** What the agent said, and whether every line of the turn before it landed. */
  how: { readonly why: Why; readonly whole: boolean },
): Promise<void> {
  // What the agent said it was, unless the record is missing lines — then nobody can say.
  const said = how.whole ? how.why.why : 'unknown, part of it was lost'
  say(`answered ${asking.conversationId}: ${said}`)
  await closing(writing, asking, how.whole ? ending(how.why) : LOST)
}

/**
 * Writes down everything one turn produced.
```

##### F031：应该怎么改

把缺失 product 卫语句移入最终 complete 分支。仍在 terminal try 中记录 stage；内部不可能状态错误现在也记录安全 classification（如要严格保留原日志数量，将该检查置于 try 前并用具名 completion 决定）。不改变任何正常/未知 DB 结果。

##### F031：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
async function finishExecution(
  execution: Execution,
  turnProduct: SettledTurn,
): Promise<ExecutionOutcome> {
  const { lease, deps, reason } = execution
  if (reason === 'lost') return 'lost'
  let stage: 'terminal-complete' | 'terminal-cancel' | 'terminal-fail' =
    'terminal-complete'
  let accepted: boolean | ExecutionOutcome
  try {
    if (reason === 'cancel') {
      stage = 'terminal-cancel'
      accepted = await deps.writes.cancel(lease)
    } else if (reason !== undefined) {
      stage = 'terminal-fail'
      accepted = await deps.writes.fail(lease, reason)
    } else {
      // An unknown COMMIT must retain uploaded objects, which SQL may have committed.
      if (turnProduct === undefined)
        throw new Error('Execution settled without a turn result')
      accepted = await deps.writes.complete(lease, turnProduct)
    }
  } catch (error) {
    diagnose(execution, stage)
    throw error
  }
  if (typeof accepted === 'string') return accepted
  if (accepted) {
    const outcomes = {
      'terminal-complete': 'completed',
      'terminal-cancel': 'cancelled',
      'terminal-fail': 'failed',
    } as const
    return outcomes[stage]
  }
  return 'lost'
}
```

**不能改变的事实**：cancel/fail 分支不需要 product；lost 不写终态；complete 只有 settled success 产品；未知 COMMIT 仍由 finishWithRecovery 隔离而不 replay。

**实施时的验证要求**：sh scripts/check.sh test apps/agent/src/execute-run.test.ts apps/agent/src/execute-run.sources.test.ts；增加内部缺失 product 的固定诊断测试（若公开可观察不到则无需暴露 helper）。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f032"></a>

#### F032 — tool outcome 的 mutative 政策不要靠位置 boolean 表达

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`executeToolOperation`。

**现在（连续原文）** — [`apps/agent/src/execute-run.ts:493–510`](../apps/agent/src/execute-run.ts#L493)

```ts
async function executeToolOperation<Outcome>(
  execution: Execution,
  operation: () => Promise<Outcome>,
  readOnly = false,
) {
  try {
    execution.controller.signal.throwIfAborted()
    return await operation()
  } catch (error) {
    // Pi normally exposes tool failures to the model. Unknown VM outcomes must
    // instead stop the session, before any automatic next inference.
    if (error !== execution.controller.signal.reason && !readOnly) {
      diagnose(execution, 'tool')
      stop(execution, 'execution-error')
    }
    throw error
  }
}
```

##### F032：为什么不好

readOnly=false 与唯一调用处末尾 true（executeAssignedTurn:347）传递是否未知结果应停止 spending 的政策。该参数不是普通展示开关：误复制 true 到 write/execute 会取消隔离；阅读调用点无法从 true 看出它授予的恢复解释。

**Handover 实际对照** — [`apps/cli/src/agents/codex.ts:174–225`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/agents/codex.ts#L174-L225)

reference 按 item.type 具名解释不同工具结果；无直接 remote VM mutation uncertainty analogue。

```ts
  if (item.type === 'agentMessage') {
    const answer = text(item['text'])
    return answer === '' ? [] : [{ said: 'text', text: answer }]
  }
  if (item.type !== 'reasoning') return undefined
  const thinking = [...texts(item['summary']), ...texts(item['content'])].join('\n')
  return thinking === '' ? [] : [{ said: 'thinking', text: thinking }]
}

/** One completed app-server tool in the provider-neutral transcript vocabulary. */
function toolFrom(item: Item, streamedOutput: OutputProgress | undefined): Said[] {
  if (item.type === 'commandExecution') return [commandFinished(item, streamedOutput)]
  if (item.type === 'fileChange') {
    return [
      did({
        callId: item.id,
        name: 'file_change',
        verb: 'edited',
        arg: changedPaths(item['changes']),
        ok: item['status'] === 'completed',
        excerpt: '',
      }),
    ]
  }
  if (item.type === 'mcpToolCall') {
    const name = `${text(item['server'])}/${text(item['tool'])}`
    const error = toolError(item)
    return [
      did({
        callId: item.id,
        name,
        verb: '',
        arg: '',
        ok: item['status'] === 'completed',
        excerpt: shorten(error),
      }),
    ]
  }
  if (item.type === 'webSearch') {
    return [
      did({
        callId: item.id,
        name: 'web_search',
        verb: 'searched',
        arg: shorten(text(item['query'])),
        excerpt: '',
      }),
    ]
  }

  // The tool set is open. Preserve an unfamiliar item by its provider name without guessing a
  // verb, verdict, parameters or output that this build does not know how to read.
```

##### F032：应该怎么改

用闭合 operation kind 替代 boolean：默认 mutative，唯一 read 调用显式 read-only。不要为每个工具造 class 或 result hierarchy。

##### F032：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
async function executeToolOperation<Outcome>(
  execution: Execution,
  operation: () => Promise<Outcome>,
  kind: 'read-only' | 'mutative' = 'mutative',
) {
  try {
    execution.controller.signal.throwIfAborted()
    return await operation()
  } catch (error) {
    // Pi normally exposes tool failures to the model. Unknown VM outcomes must
    // instead stop the session, before any automatic next inference.
    if (error !== execution.controller.signal.reason && kind === 'mutative') {
      diagnose(execution, 'tool')
      stop(execution, 'execution-error')
    }
    throw error
  }
}
```

harness tools object的完整read属性替换。

```ts
read: (request) => executeToolOperation(execution, () => tools.read(request), 'read-only'),
```

**不能改变的事实**：只读 transport/不存在/超额仍作为普通工具纠正；所有变更未知仍同步 abort，close/quarantine 不改变。

**实施时的验证要求**：sh scripts/check.sh test apps/agent/src/execute-run.test.ts apps/agent/src/sandbox/e2b.test.ts apps/agent/src/sandbox/native-command.test.ts；保留 readonly ordinary-error 与 mutative ACK-loss 对照。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f033"></a>

#### F033 — import_file 的图片与普通文件结果采用分支提前返回

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`fileToolDefinitions → import_file.execute`。

**现在（连续原文）** — [`apps/agent/src/harness/file-tools.ts:34–54`](../apps/agent/src/harness/file-tools.ts#L34)

```ts
        const bytes = image ? file.bytes : undefined
        if (bytes !== undefined && bytes.byteLength > 1024 * 1024) onLimit()
        return {
          content:
            bytes !== undefined
              ? [
                  { type: 'text', text: `Imported to ${path}` },
                  {
                    type: 'image',
                    data: Buffer.from(bytes).toString('base64'),
                    mimeType: file.mimeType,
                  },
                ]
              : [
                  {
                    type: 'text',
                    text: `Imported to ${path}. Use tools to inspect; importing does not establish understanding.`,
                  },
                ],
          details: {},
        }
```

##### F033：为什么不好

对象内 content ternary 的数组再包对象，让文本主路径落在第四层缩进。这里两个返回值形状明确，可以普通文件先返回、图片预算检查后返回，不造 render helper。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:321–339`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L321-L339)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
    run: async (c) => {
      const asked = c.req.valid('json')
      const opened = await beginConversation(db, {
        conversationId: asked.id,
        spaceId: c.get('space').id,
        machineId: asked.machineId,
        agentKind: asked.agentKind,
        asked: asked.asked,
        // From the session, never from the body, for the reason `saying` says.
        saidBy: c.get('userId'),
      })

      if (opened.kind === 'no-machine') return refused(c, UNAVAILABLE)
      if (opened.kind === 'no-agent') return refused(c, NO_AGENT)
      if (opened.kind === 'machine-away') return refused(c, MACHINE_AWAY)
      if (opened.kind === 'id-taken') return refused(c, ID_TAKEN)

      return c.json({ id: opened.conversationId }, 201)
    },
```

##### F033：应该怎么改

普通文件结果先return，image结果作为后续可见段落；文本、mimeType、base64与返回协议字段逐字保留，不修改file admission或byte上限。

##### F033：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
const bytes = image ? file.bytes : undefined
if (bytes === undefined) {
  return {
    content: [
      {
        type: 'text',
        text: `Imported to ${path}. Use tools to inspect; importing does not establish understanding.`,
      },
    ],
    details: {},
  }
}
if (bytes.byteLength > 1024 * 1024) onLimit()
return {
  content: [
    { type: 'text', text: `Imported to ${path}` },
    {
      type: 'image',
      data: Buffer.from(bytes).toString('base64'),
      mimeType: file.mimeType,
    },
  ],
  details: {},
}
```

**不能改变的事实**：模型不支持图片时绝不附加 image block；1MiB 上限在 base64 分配前；导入不自动承诺理解；abort checks 与 files.importFile 不动。

**实施时的验证要求**：未来 harness/pi.test.ts 的图片支持、无图片支持、过大图片与文件预算；harness/files.test.ts 的赋值权限。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f034"></a>

#### F034 — subprocess eval 只包含真正执行的入口 import

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`invalid-history subprocess script`。

**现在（连续原文）** — [`apps/agent/src/harness/pi.test.ts:503–514`](../apps/agent/src/harness/pi.test.ts#L503)

```ts
      const script = `
        import type { WebSearchConfig } from './web-search'
import { createPiHarness } from ${JSON.stringify(new URL('./pi.ts', import.meta.url).pathname)};
        try {
          await createPiHarness(${JSON.stringify({ ...options, baseURL: provider.baseURL })}).turn({
            history: ${JSON.stringify(history)}, text: 'invalid',
            signal: AbortSignal.timeout(100), onText() {},
            tools: { async execute() { throw Error('unexpected tool') }, async read() { throw Error('unexpected tool') }, async write() { throw Error('unexpected tool') } }
          });
          console.log('ACCEPTED');
        } catch (error) { console.log(error.message) }
      `
```

##### F034：为什么不好

模板中的 type-only WebSearchConfig import 没有任何消费，且使用相对路径 ./web-search；下一行真正 import 使用绝对路径。该多余行还打断模板缩进，视觉上像粘贴残留。Bun 很可能 erase type import，不能把它夸大为已复现 module-resolution bug；删除它让 bounded child 的实际能力依赖可审。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F034：应该怎么改

只删除模板中的未使用 type import 并对齐唯一入口 import；模块顶部实际被测试使用的 WebSearchConfig import 留下。下面替换完整 eval 字符串，不新造 subprocess runner。

##### F034：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
const script = `
  import { createPiHarness } from ${JSON.stringify(new URL('./pi.ts', import.meta.url).pathname)};
  try {
    await createPiHarness(${JSON.stringify({ ...options, baseURL: provider.baseURL })}).turn({
      history: ${JSON.stringify(history)}, text: 'invalid',
      signal: AbortSignal.timeout(100), onText() {},
      tools: { async execute() { throw Error('unexpected tool') }, async read() { throw Error('unexpected tool') }, async write() { throw Error('unexpected tool') } }
    });
    console.log('ACCEPTED');
  } catch (error) { console.log(error.message) }
`
```

**不能改变的事实**：child timeout/SIGKILL 仍包住 SDK 同步 cycle traversal；不增加真实 provider、host credential/resource discovery，stdout/stderr/exitCode/no-dispatch 断言不变。

**实施时的验证要求**：sh scripts/check.sh test apps/agent/src/harness/pi.test.ts；每个 corrupt history child 必须正确退出、无 stderr、provider.requests===0。Reference 无直接 analogue；本仓用隔离 subprocess 检查恶意 private history，而非 reference 可重建本地 session。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f035"></a>

#### F035 — prompt 中资产投影先形成 public metadata 段落

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`runTurn inputText`。

**现在（连续原文）** — [`apps/agent/src/harness/pi.ts:273–278`](../apps/agent/src/harness/pi.ts#L273)

```ts
    const inputText =
      fileTools === undefined
        ? prompt
        : `${prompt}
Assigned assets (import_file by assetID to a path you choose):
${JSON.stringify(fileTools.assigned.map(({ assetID, name, mimeType }) => ({ assetID, name, mimeType })))}`
```

##### F035：为什么不好

模板插值里 JSON.stringify(map(destructuring → object)) 挤成超长单行；周围又是 ternary。把受限资产投影放在 if 内的局部 metadata，保留同一 runTurn owner，不新增 prompt builder abstraction。

**Handover 实际对照** — [`apps/cli/src/answering.ts:171–188`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/answering.ts#L171-L188)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
function whatToDo(asking: Asking, handover: string): Asked {
  const chosen = {
    ...(asking.model === null ? {} : { model: asking.model }),
    ...(asking.effort === null ? {} : { effort: asking.effort }),
  }

  if (asking.goal === null) return { text: whatWasSaid(asking.asked), ...chosen }

  const said =
    asking.asked.length === 0 ? [] : [`They have just said: ${whatWasSaid(asking.asked)}`]

  return {
    text: [`You are carrying this on by yourself: ${asking.goal}`, ...said, canSay(handover)].join(
      '\n\n',
    ),
    ...chosen,
  }
}
```

##### F035：应该怎么改

先投影准许公开的资产metadata，再JSON编码并插入prompt。仍只允许assetID/name/mimeType/byteLength等当前白名单，不把object key或凭据补进模型上下文。

##### F035：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
let inputText = prompt
if (fileTools !== undefined) {
  const assets = fileTools.assigned.map(({ assetID, name, mimeType }) => ({
    assetID,
    name,
    mimeType,
  }))
  inputText = `${prompt}
Assigned assets (import_file by assetID to a path you choose):
${JSON.stringify(assets)}`
}
```

**不能改变的事实**：仅 assetID/name/mimeType，绝不 objectKey/digest/provider creds；assigned [] 时仍保留原提示段；不 trim 用户 prompt；文本换行保持精确。

**实施时的验证要求**：未来 harness/pi.test.ts / execute-run.sources.test.ts；新增 prompt canary 检查 objectKey 不进入模型。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f036"></a>

#### F036 — canonical answer 文本归约与 history result 分成独立段落

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`runTurn result`。

**现在（连续原文）** — [`apps/agent/src/harness/pi.ts:299–314`](../apps/agent/src/harness/pi.ts#L299)

```ts
    const answer = session.messages.findLast(
      (message) => message.role === 'assistant',
    )
    const history = {
      header: manager.getHeader(),
      entries: manager.getEntries(),
      leafID: manager.getLeafId(),
    }
    admitPiHistory(history)
    return {
      text:
        answer?.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('') ?? '',
      history: structuredClone(history),
    }
```

##### F036：为什么不好

result 对象的 text 属性内串 findLast 后的 optional content/flatMap/join，与 private history structuredClone 混在一起。给 finalText 一个局部名字，让读者清楚 canonical final assistant 与已 streamed narration 的区别；不提取纯转发 text helper。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:522–533`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L522-L533)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
function asTranscript(reading: Reading) {
  const offers = Models.safeParse(reading.offers)

  return {
    ...reading,
    underway: asUnderway(reading.underway),
    offers: offers.success ? offers.data : [],
    messages: reading.messages.map((one) => {
      const read = Spoken.safeParse({ ...one, at: one.at.toISOString() })
      return read.success ? read.data : unreadable(one.seq, one.at)
    }),
  }
```

##### F036：应该怎么改

把 assistant 文本归约命名成独立段落，但保留既有 history admission 在文本归约之前、clone 在归约之后的实际求值/分配次序。第三批采用这项修正。片段顺序、过滤规则和 exact whitespace 不变，不把 private reasoning/history 当公开 answer。

##### F036：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
const answer = session.messages.findLast(
  (message) => message.role === 'assistant',
)
const history = {
  header: manager.getHeader(),
  entries: manager.getEntries(),
  leafID: manager.getLeafId(),
}
admitPiHistory(history)

const finalText =
  answer?.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('') ?? ''
return { text: finalText, history: structuredClone(history) }
```

**不能改变的事实**：只取最后 native assistant 的 text blocks；不混 tool narration、thinking、tool blocks；不使用 trimming getter；history size admission 在 clone 前。

**实施时的验证要求**：未来 harness/pi.test.ts canonical final answer、thinking privacy、空 final answer；tests/integration/public-sources.test.ts。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f037"></a>

#### F037 — 净化、固定实体映射和 Unicode 截断按线性阶段展开

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`plainText`。

**现在（连续原文）** — [`apps/agent/src/harness/web-search.ts:22–56`](../apps/agent/src/harness/web-search.ts#L22)

```ts
function plainText(value: string, limit: number) {
  return Array.from(
    value
      .replace(/&(?:lt|gt|quot|apos|amp|nbsp);/gi, (entity) => {
        const entities: Record<string, string> = {
          '&lt;': '<',
          '&gt;': '>',
          '&quot;': '"',
          '&apos;': "'",
          '&amp;': '&',
          '&nbsp;': ' ',
        }
        return entities[entity.toLowerCase()] ?? ''
      })
      .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_entity, code: string) => {
        const point = code.toLowerCase().startsWith('x')
          ? Number.parseInt(code.slice(1), 16)
          : Number(code)
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
      })
      .replace(/<(script|style|think|thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/[<>]/g, '')
      .replace(
        // Control and invisible formatting characters must not enter model evidence.
        // oxlint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, limit)
    .join('')
}
```

##### F037：为什么不好

Array.from 把整条多步 replace 链包在外层，尾部又 slice/join，读者需要跨 30 多行匹配括号才知道截断的是 code point。用 cleaned 本地变量表示安全净化的结果；不是把每个 replace 拆函数。 同时，固定六项 entity 表目前在每次回调中分配；合并改善为本项，不再单独计一个问题。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:522–533`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L522-L533)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
function asTranscript(reading: Reading) {
  const offers = Models.safeParse(reading.offers)

  return {
    ...reading,
    underway: asUnderway(reading.underway),
    offers: offers.success ? offers.data : [],
    messages: reading.messages.map((one) => {
      const read = Spoken.safeParse({ ...one, at: one.at.toISOString() })
      return read.success ? read.data : unreadable(one.seq, one.at)
    }),
  }
```

##### F037：应该怎么改

固定entity map放在module私有常量，sanitize按tag/entity/whitespace/Unicode截断线性展开。一次合并改动，不为entity allocation与表达式链单独计数；保留UTF-16/有效code point与输出上限语义。

##### F037：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
const htmlEntities: Readonly<Record<string, string>> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
  '&nbsp;': ' ',
}

function plainText(value: string, limit: number) {
  const cleaned = value
    .replace(
      /&(?:lt|gt|quot|apos|amp|nbsp);/gi,
      (entity) => htmlEntities[entity.toLowerCase()] ?? '',
    )
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_entity, code: string) => {
      const point = code.toLowerCase().startsWith('x')
        ? Number.parseInt(code.slice(1), 16)
        : Number(code)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
    })
    .replace(/<(script|style|think|thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(
      // Control and invisible formatting characters must not enter model evidence.
      // oxlint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()

  return Array.from(cleaned).slice(0, limit).join('')
}
```

**不能改变的事实**：实体解码在标签过滤前；code point 而非 UTF16 截断；六项映射内容、gi/大小写、控制字符和全部净化步骤顺序不变。固定表留在模块内，不新增 env 或通用 sanitizer。

**实施时的验证要求**：未来 web-search.test.ts；补 surrogate pair 接近 limit 的案例与 entity/tag/controls 混合案例。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f038"></a>

#### F038 — 在拥有 reader 的函数内显式写出 bytes→text→JSON 三步

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`boundedBody`。

**现在（连续原文）** — [`apps/agent/src/harness/web-search.ts:138–146`](../apps/agent/src/harness/web-search.ts#L138)

```ts
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown
```

##### F038：为什么不好

拼 bytes 后直接 return JSON.parse(new TextDecoder.decode(bytes)) as unknown 把两种边界失败叠在表达式里。用局部 text 让 fatal UTF8 解码与 JSON 解析两个阶段可见；不移动 reader 的 loop/finally。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:522–533`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L522-L533)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
function asTranscript(reading: Reading) {
  const offers = Models.safeParse(reading.offers)

  return {
    ...reading,
    underway: asUnderway(reading.underway),
    offers: offers.success ? offers.data : [],
    messages: reading.messages.map((one) => {
      const read = Spoken.safeParse({ ...one, at: one.at.toISOString() })
      return read.success ? read.data : unreadable(one.seq, one.at)
    }),
  }
```

##### F038：应该怎么改

在仍拥有reader/issued IO的函数里命名bytes、text、JSON三个阶段；错误/cancel/finally仍归原owner，不把解析移到无法收尾的外层。

##### F038：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
const bytes = new Uint8Array(size)
let offset = 0
for (const chunk of chunks) {
  bytes.set(chunk, offset)
  offset += chunk.byteLength
}
const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const payload: unknown = JSON.parse(text)
return payload
```

**不能改变的事实**：262144-byte cap、fatal UTF8、signal checks、cancel await 与 releaseLock 的单一 owner 保留；绝不 race-and-detach body cleanup。

**实施时的验证要求**：未来 web-search.test.ts 的响应体过大、无效 UTF8/JSON、trickle cancellation；无需新增仅检查变量名的测试。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f039"></a>

#### F039 — 认证 headers 的互斥策略用显式赋值而不是条件 spread

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`webSearchTool`。

**现在（连续原文）** — [`apps/agent/src/harness/web-search.ts:165–171`](../apps/agent/src/harness/web-search.ts#L165)

```ts
  const transport = config.transport ?? fetch
  const headers = {
    'Content-Type': 'application/json',
    ...(config.authMode === 'keyless'
      ? { 'X-Tavily-Access-Mode': 'keyless' }
      : { Authorization: `Bearer ${config.apiKey}` }),
  }
```

##### F039：为什么不好

Content-Type 固定，认证二选一。但 spread 中的 ternary 强迫读者把两个部分对象重新合成。在能力构造阶段完成 headers 赋值，execute 只消费已绑定配置。

**Handover 实际对照** — [`apps/cli/src/answering.ts:171–188`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/answering.ts#L171-L188)

无直接搜索认证对应。参考也使用 conditional spread：它不是一律禁用；这里只对互斥认证策略采用显式分支。

```ts
function whatToDo(asking: Asking, handover: string): Asked {
  const chosen = {
    ...(asking.model === null ? {} : { model: asking.model }),
    ...(asking.effort === null ? {} : { effort: asking.effort }),
  }

  if (asking.goal === null) return { text: whatWasSaid(asking.asked), ...chosen }

  const said =
    asking.asked.length === 0 ? [] : [`They have just said: ${whatWasSaid(asking.asked)}`]

  return {
    text: [`You are carrying this on by yourself: ${asking.goal}`, ...said, canSay(handover)].join(
      '\n\n',
    ),
    ...chosen,
  }
}
```

##### F039：应该怎么改

先构建公共headers，再按互斥authMode分支设置key/bearer。不能同时发两类凭据，不能把秘密写入日志或query。

##### F039：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
const transport = config.transport ?? fetch
const headers: Record<string, string> = { 'Content-Type': 'application/json' }
if (config.authMode === 'keyless') {
  headers['X-Tavily-Access-Mode'] = 'keyless'
} else {
  headers.Authorization = `Bearer ${config.apiKey}`
}
```

**不能改变的事实**：key 模式前置 trim 验证不删；keyless 不带 bearer；失败 keyed request 不能降级 keyless；固定 endpoint 与 redirect:error 不改。

**实施时的验证要求**：未来 web-search.test.ts 的 key/keyless 请求、失败不 fallback、私有 key 不泄漏。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f040"></a>

#### F040 — 给搜索配额与响应预算一组模块私有政策名字

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`webSearchTool.execute`。

**现在（连续原文）** — [`apps/agent/src/harness/web-search.ts:192–204`](../apps/agent/src/harness/web-search.ts#L192)

```ts
      const query = searchQuery.safeParse(params.query)
      if (!query.success) return failure('Invalid search query.')
      if (closed) return failure(unavailable)
      if (dispatched >= 3) return failure('Search limit reached for this turn.')
      // Reserve before the first await; failed/ambiguous requests consume quota.
      dispatched++
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), 10000)
      const signal = AbortSignal.any([
        ownerSignal,
        callerSignal,
        deadline.signal,
      ])
```

##### F040：为什么不好

3 次调用、10 秒、256KiB raw body、16KiB evidence output 分散在不同阶段（另见 102、135）。读者难以区分 transport admission、模型 evidence 与 dispatch count。把政策命名到同一文件，不加 env 可配置项，也不把不同 cap 合并。

**Handover 实际对照** — [`apps/cli/src/answering.ts:23–35`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/answering.ts#L23-L35)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
/**
 * How long one write keeps trying before its turn is called `unknown`.
 *
 * Long enough to sit out the network coming back, and bounded because a turn has to end: a turn
 * that never ends is one a page shows as still working forever. Every attempt carries the same
 * name, so landing twice is landing once.
 */
const KEEP_TRYING_MS = 120_000

const BETWEEN_TRIES_SECONDS = 2

/** Batches noisy provider updates before each cross-instance NOTIFY without making them feel late. */
const LIVE_OUTPUT_EVERY_MS = 75
```

##### F040：应该怎么改

从两个实际consumer抽取各预算的module私有名字；max search count、max response bytes、snippet/sources预算仍不同，不建通用Budget对象。

##### F040：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
const searchLimits = {
  dispatches: 3,
  timeoutMs: 10000,
  responseBytes: 262144,
  evidenceBytes: 16384,
} as const
```

execute 中原来的 quota/deadline 段落替换为下段；仍在第一个 await 前 reserve。

```ts
if (dispatched >= searchLimits.dispatches)
  return failure('Search limit reached for this turn.')
// Reserve before the first await; failed/ambiguous requests consume quota.
dispatched++
const deadline = new AbortController()
const timer = setTimeout(() => deadline.abort(), searchLimits.timeoutMs)
```

normalize 中原来的输出裁剪循环（仍由 results/output/encoder 这个已有词法上下文拥有）。

```ts
while (
  encoder.encode(JSON.stringify(output)).byteLength > searchLimits.evidenceBytes
) {
  results.pop()
  output.truncated = true
}
```

boundedBody 内原来的 admission 段落，仍在 reader owner 的 try/finally 里。

```ts
size += chunk.value.byteLength
if (size > searchLimits.responseBytes) throw new Error(unavailable)
chunks.push(chunk.value)
```

**不能改变的事实**：原 cap 和比较方向保持；配额在第一个 await 前消耗；未知请求结果仍消耗配额；不是 transport/RSS 硬上限的声明。

**实施时的验证要求**：未来 web-search.test.ts 的第4次拒绝、失败消耗配额、raw/evidence 独立大小界限与 deadline；AFTER 为常量和四处精确替换说明。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f041"></a>

#### F041 — 把每个 run 的可选超时一次投影成执行 options

- **优先级**：P3 / 可读性。
- **适用置信度**：中：只是局部阅读次序改善，不是修复错误。
- **符号**：`runWorker.superviseRun`。

**现在（连续原文）** — [`apps/agent/src/run-loop.ts:32–41`](../apps/agent/src/run-loop.ts#L32)

```ts
  async function superviseRun(lease: ExecutionLease) {
    try {
      await executeRun(lease, deps, {
        leaseMs: options.leaseMs,
        pollMs: options.pollMs,
        signal,
        ...(options.runTimeoutMs === undefined
          ? {}
          : { runTimeoutMs: options.runTimeoutMs }),
      })
```

##### F041：为什么不好

runWorker 的 options 在整个 scheduler 内固定，却在每个 superviseRun 的核心 await 中展示可选字段 spread。这个条件只是 exactOptionalPropertyTypes 的结构投影，不是每个 run 新策略。移到 signal 创建之后，callback 保留真实监督责任。

**Handover 实际对照** — [`apps/cli/src/answering.ts:122–136`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/answering.ts#L122-L136)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
export function startAnswering(
  api: Api,
  asking: Asking,
  agent: Agent,
  on: { readonly machine: Machine; readonly where: string },
): Answering {
  const writing = writingInto(api, asking, on.machine)
  const talk = agent.talk(on.where, asking.agentSession)

  return {
    conversationId: asking.conversationId,
    afterSeq: asking.afterSeq,
    stop: talk.stop,
    done: write(writing, asking, talk.say(whatToDo(asking, on.machine.handover)), on.machine.say),
  }
```

##### F041：应该怎么改

在每个 superviseRun 原有 try 内把参数对象命名成 runOptions，仍在该次 claim 后读取 timeout，保持 undefined 时省略字段。不能提升到 runWorker 外层并冻结后续 run 的读取；第四批用真实两个 run 的 deadline characterization 验证这项修正。

##### F041：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
// Add ExecuteRunOptions to the existing type import from './execution-contract'.
async function superviseRun(lease: ExecutionLease) {
  try {
    const runOptions: ExecuteRunOptions = {
      leaseMs: options.leaseMs,
      pollMs: options.pollMs,
      signal,
      ...(options.runTimeoutMs === undefined
        ? {}
        : { runTimeoutMs: options.runTimeoutMs }),
    }
    await executeRun(lease, deps, runOptions)
  } catch (error) {
    failures.push(error)
    stop.abort()
  } finally {
    active.delete(lease.runID)
  }
}
```

**不能改变的事实**：保留 conditional spread 的字段省略语义，不显式写入 undefined；Readonly owner 类型不放宽；signal 仍合成内部 stop；shutdown 后完成 claim 仍须监督收尾。

**实施时的验证要求**：未来 typecheck 与 run-loop.test.ts，尤其有/无 runTimeoutMs、claim 在 shutdown 后完成、并发收尾。可选字段 spread 本身正确；只命名投影，不移出 per-run callback 或原有错误监督范围。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f042"></a>

#### F042 — 两个同样的 abortable polling 实现共用一个生命周期 helper

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`waitForPoll; duplicate execute-run.ts:239–250`。

**现在（连续原文）** — [`apps/agent/src/run-loop.ts:89–100`](../apps/agent/src/run-loop.ts#L89)

```ts
function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}
```

##### F042：为什么不好

这里与 execute-run.ts 是逐行同样的 timer/listener lifecycle。这个 helper 不只转发：它拥有定时器与监听器的对称清理，且有两个真实消费者；集中是合理复用，而不是为了凑短函数。使用毫秒，不能照搬 reference 秒单位。

**Handover 实际对照** — [`apps/cli/src/sleeping.ts:14–31`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/sleeping.ts#L14-L31)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
export async function sleep(seconds: number, until?: AbortSignal): Promise<void> {
  if (until?.aborted === true) return

  const { promise: waited, resolve: wake } = Promise.withResolvers<void>()
  const over = (): void => {
    wake()
  }

  const timer = setTimeout(over, seconds * 1000)
  until?.addEventListener('abort', over, { once: true })

  try {
    await waited
  } finally {
    clearTimeout(timer)
    until?.removeEventListener('abort', over)
  }
}
```

##### F042：应该怎么改

提取现有两个完全相同的abortable polling body到同一milliseconds helper；两个真实owner共享。保留abort listener、timer清理、already-aborted逻辑，不复制reference的seconds接口。

##### F042：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
// Proposed new file: apps/agent/src/wait-for-poll.ts
export function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}
```

**不能改变的事实**：中断只结束等待、不自动 stop SQL heartbeat ownership；ms 单位与预 aborted 检查保留；每个 wait 清 timer/listener；不改变 authority signal 的来源。

**实施时的验证要求**：未来 run-loop.test.ts 与 execute-run.test.ts；新 helper 用 fake timers/可计数 signal 验证 already-aborted、timer完成、abort完成均解绑；不要只断言函数被调用。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f043"></a>

#### F043 — Worker 的 imports 按外部边界与本地依赖形成稳定段落

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`module imports`。

**现在（连续原文）** — [`apps/agent/src/worker.ts:1–23`](../apps/agent/src/worker.ts#L1)

```ts
import { once } from 'node:events'
import { openDatabase } from '@vid/database/connection'
import type { DB } from '@vid/database/types'
import type { Kysely } from 'kysely'
import {
  createClient,
  type RedisClientOptions,
  type RedisClientType,
} from 'redis'

import { connectObjects, type ObjectStore } from '@vid/object-storage'
import { assignFileTools } from './harness/files'
import { readFile } from 'node:fs/promises'
import type { WorkerEnv } from '@vid/config'
import { openE2BSandbox } from './sandbox/e2b'
import { acceptCommands, initializeCommands } from './commands'
import { relayEvents } from './events'
import { bindExecutionWrites } from './db/run-writes'
import { claimExecutionRun } from './db/execution-leases'
import type { ExecuteRunDependencies } from './execute-run'
import { createPiHarness } from './harness/pi'
import { runWorker } from './run-loop'
import type { WorkerHealth } from './worker-health'
```

##### F043：为什么不好

node:fs 的 readFile 混在本地 harness 与 workspace imports 中，读者扫描进程的宿主权限时必须来回跳。整理现有 imports，既不新增 barrel，也不改变依赖边界。

**Handover 实际对照** — [`apps/cli/src/answering.ts:9–21`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/answering.ts#L9-L21)

直接对比模块导入的视觉段落：reference 将协议值/type与本地模块聚拢；不要求逐字复制它的排序规则。

```ts
import { fitsInPiece, textPieces } from '@handover/universal'
import type { components } from '../generated/api.ts'
import {
  type Agent,
  type Asked,
  EXCERPT,
  type Said,
  type Told,
  type Why,
  shorten,
} from './agents/agent.ts'
import { NO_ANSWER, type Api } from './api.ts'
import { sleep } from './sleeping.ts'
```

##### F043：应该怎么改

保留所有 imported bindings，分成 native/third-party、workspace 合同、本应用模块三个视觉段落。配合 F001，type import 指向实际 execution-contract owner，而不是旧执行入口；无新增 barrel/运行时资源，核对模块初始化副作用。

##### F043：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import type { Kysely } from 'kysely'
import {
  createClient,
  type RedisClientOptions,
  type RedisClientType,
} from 'redis'

import type { WorkerEnv } from '@vid/config'
import { openDatabase } from '@vid/database/connection'
import type { DB } from '@vid/database/types'
import { connectObjects, type ObjectStore } from '@vid/object-storage'

import { acceptCommands, initializeCommands } from './commands'
import { claimExecutionRun } from './db/execution-leases'
import { bindExecutionWrites } from './db/run-writes'
import { relayEvents } from './events'
import type { ExecuteRunDependencies } from './execution-contract'
import { assignFileTools } from './harness/files'
import { createPiHarness } from './harness/pi'
import { runWorker } from './run-loop'
import { openE2BSandbox } from './sandbox/e2b'
import type { WorkerHealth } from './worker-health'
```

**不能改变的事实**：保留全部 imported symbols；不改变初始化副作用与权限投影。

**实施时的验证要求**：未来 typecheck、lint、boundaries；worker.test.ts 与 worker-health.test.ts。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f044"></a>

#### F044 — 把测试赋值能力直接写成三个可选字段

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`WorkerAssignment`。

**现在（连续原文）** — [`apps/agent/src/worker.ts:25–27`](../apps/agent/src/worker.ts#L25)

```ts
type WorkerAssignment = Partial<
  Pick<ExecuteRunDependencies, 'harness' | 'openSandbox'>
> & { signal?: AbortSignal }
```

##### F044：为什么不好

Partial<Pick<…>> 与 intersection 的三行语法要求读者先计算类型再知道可信调用方能覆盖什么。只有三个字段，直接枚举更清晰；用 indexed access 继续从能力 owner 派生，不手抄函数签名。

**Handover 实际对照** — [`apps/cli/src/answering.ts:122–136`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/answering.ts#L122-L136)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
export function startAnswering(
  api: Api,
  asking: Asking,
  agent: Agent,
  on: { readonly machine: Machine; readonly where: string },
): Answering {
  const writing = writingInto(api, asking, on.machine)
  const talk = agent.talk(on.where, asking.agentSession)

  return {
    conversationId: asking.conversationId,
    afterSeq: asking.afterSeq,
    stop: talk.stop,
    done: write(writing, asking, talk.say(whatToDo(asking, on.machine.handover)), on.machine.say),
  }
```

##### F044：应该怎么改

将Partial<Pick<...>>交集替换为三个optional property，类型仍用ExecuteRunDependencies indexed access，不手抄能力函数signature。

##### F044：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
type WorkerAssignment = {
  readonly harness?: ExecuteRunDependencies['harness']
  readonly openSandbox?: ExecuteRunDependencies['openSandbox']
  signal?: AbortSignal
}
```

**不能改变的事实**：仍仅 trusted library caller 可注入；exactOptionalPropertyTypes 不放宽；env 不接受实现选择。

**实施时的验证要求**：未来 typecheck；worker.test.ts 的双能力旁路及单能力仍需要配置。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f045"></a>

#### F045 — 用惰性的空值默认表达启动能力选择

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`startWorker`。

**现在（连续原文）** — [`apps/agent/src/worker.ts:34–41`](../apps/agent/src/worker.ts#L34)

```ts
  const harness =
    assignment.harness === undefined
      ? await loadConfiguredHarness(env)
      : assignment.harness
  const openSandbox =
    assignment.openSandbox === undefined
      ? bindConfiguredSandbox(env)
      : assignment.openSandbox
```

##### F045：为什么不好

两个四行 ternary 让 capability 选择的主段落偏重；可以对稳定的 trusted assignment 用惰性 destructuring default。原文声称 ?? 与 undefined 分支等价只适用于非 null 类型域；第四批不以此静默引入 null fallback，也不把此改法宣称为不稳定 accessor 的通用 ABI 等价。

**Handover 实际对照** — [`apps/cli/src/answering.ts:122–136`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/answering.ts#L122-L136)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
export function startAnswering(
  api: Api,
  asking: Asking,
  agent: Agent,
  on: { readonly machine: Machine; readonly where: string },
): Answering {
  const writing = writingInto(api, asking, on.machine)
  const talk = agent.talk(on.where, asking.agentSession)

  return {
    conversationId: asking.conversationId,
    afterSeq: asking.afterSeq,
    stop: talk.stop,
    done: write(writing, asking, talk.say(whatToDo(asking, on.machine.handover)), on.machine.say),
  }
```

##### F045：应该怎么改

两个 fallback 用只对 undefined 生效的惰性 destructuring default；await 仍在 harness default 内，先选 harness 再选 sandbox，storage 需求 OR 不动。现有实际 trusted callers 提供稳定能力字段；拒绝原 ?? 的 null fallback，不引入动态 capability discovery。

##### F045：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
const {
  harness = await loadConfiguredHarness(env),
  openSandbox = bindConfiguredSandbox(env),
} = assignment
```

**不能改变的事实**：必须保留 fallback 的惰性；不能预先调用 loadConfiguredHarness；needsStorage 的 OR 不改。默认仅作用于 undefined，不把 null 改为配置 fallback；只针对实际稳定 trusted assignment 核验，不承诺 getter 多次读取的通用等价。

**实施时的验证要求**：未来 worker.test.ts；新增注入 harness 时缺失 prompt 文件也不读磁盘的测试。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f046"></a>

#### F046 — 连接配置重复的 Pick 交集应有一个 owner 内名字

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`allocateWorkerProcess / WorkerProcess.constructor`。

**现在（连续原文）** — [`apps/agent/src/worker.ts:158–163`](../apps/agent/src/worker.ts#L158)

```ts
function allocateWorkerProcess(
  connections: Pick<WorkerEnv, 'DATABASE_URL' | 'REDIS_URL' | 'IO_TIMEOUT_MS'> &
    Partial<Pick<WorkerEnv, 'POLL_MS'>>,
  signal: AbortSignal | undefined,
  objects: ObjectStore | undefined,
) {
```

##### F046：为什么不好

相同 Pick + `Partial<Pick>` 同时出现在工厂参数与构造器中（后者 210–218）。这不是业务策略，但漂移会使构造与分配表达不同的连接能力。只在此文件命名，不新增共享 config 包。

**Handover 实际对照** — [`apps/server/src/db/connection.ts:22–37`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/connection.ts#L22-L37)

reference 给数据库连接与事务句柄两个实际职责分别命名为 Database/Tx；借鉴类型名隐藏泛型细节的用途，不采用其数据库时间策略。

```ts

import { Kysely, PostgresDialect, type Transaction } from 'kysely'
import { Pool } from 'pg'
import type { DB } from '../../generated/db.ts'
import type { Env } from '../env.ts'

export type Database = Kysely<DB>

/**
 * An open transaction, for anything that only works inside one.
 *
 * `pg_advisory_xact_lock` is released when the transaction ends, so handed the pool instead, it
 * is taken and let go by the same statement and protects nothing. Nothing about that shows up at
 * runtime — the code runs, the race just comes back. Naming the type is what makes it a compile
 * error rather than a comment somebody has to have read.
 */
```

##### F046：应该怎么改

在worker.ts owner内定义WorkerConnections，移走重复Pick交集；constructor/open的参数使用同名类型，不把它导出成新的公共配置包。

##### F046：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
type WorkerConnections = Pick<
  WorkerEnv,
  'DATABASE_URL' | 'REDIS_URL' | 'IO_TIMEOUT_MS'
> & {
  POLL_MS?: WorkerEnv['POLL_MS']
}

function allocateWorkerProcess(
  connections: WorkerConnections,
  signal: AbortSignal | undefined,
  objects: ObjectStore | undefined,
) {
  try {
    return new WorkerProcess(connections, signal, objects)
  } catch (cause) {
    try {
      objects?.close()
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        'Worker construction and cleanup failed',
      )
    }
    throw cause
  }
}
```

**不能改变的事实**：POLL_MS 仍可缺失；构造失败由分配者关闭 objects；AggregateError 不丢初始 cause；不扩大资源生命周期。

**实施时的验证要求**：未来 typecheck；tests/integration/worker-health.test.ts 中启动连接失败与 shutdown；AFTER 中构造器是明确的签名替换说明，不是可独立运行的类。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f047"></a>

#### F047 — 健康阶段的优先级不要藏在三层 ternary 中

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`WorkerProcess.health`。

**现在（连续原文）** — [`apps/agent/src/worker.ts:195–205`](../apps/agent/src/worker.ts#L195)

```ts
  readonly health = (): WorkerHealth => {
    const phase =
      this.failures.length > 0
        ? 'failed'
        : this.signal.aborted
          ? 'stopping'
          : this.started && this.commands.isReady && this.blockingReader.isReady
            ? 'ready'
            : 'starting'
    return { live: !this.signal.aborted, ready: phase === 'ready', phase }
  }
```

##### F047：为什么不好

失败→停止→连接 ready→启动的优先级是产品状态，而不是普通值选择。嵌套 ternary 形成右移阶梯，尤其难检查 failed 与 stopping 的优先顺序。用同一个方法内的卫语句，不抽出一个额外 phase helper。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:321–339`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L321-L339)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
    run: async (c) => {
      const asked = c.req.valid('json')
      const opened = await beginConversation(db, {
        conversationId: asked.id,
        spaceId: c.get('space').id,
        machineId: asked.machineId,
        agentKind: asked.agentKind,
        asked: asked.asked,
        // From the session, never from the body, for the reason `saying` says.
        saidBy: c.get('userId'),
      })

      if (opened.kind === 'no-machine') return refused(c, UNAVAILABLE)
      if (opened.kind === 'no-agent') return refused(c, NO_AGENT)
      if (opened.kind === 'machine-away') return refused(c, MACHINE_AWAY)
      if (opened.kind === 'id-taken') return refused(c, ID_TAKEN)

      return c.json({ id: opened.conversationId }, 201)
    },
```

##### F047：应该怎么改

保留stopping/disconnecting/draining/waiting原优先级；在原方法局部用顺序分支指定phase，健康snapshot的其他字段和退出责任不动。

##### F047：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
readonly health = (): WorkerHealth => {
  if (this.failures.length > 0) {
    return { live: !this.signal.aborted, ready: false, phase: 'failed' }
  }
  if (this.signal.aborted) return { live: false, ready: false, phase: 'stopping' }
  if (this.started && this.commands.isReady && this.blockingReader.isReady) {
    return { live: true, ready: true, phase: 'ready' }
  }
  return { live: true, ready: false, phase: 'starting' }
}
```

**不能改变的事实**：failure 优先于 abort；live 仍由 signal 决定；两个 Redis ready 与 markReady 都必要；不要仅凭连接成功 ready。

**实施时的验证要求**：未来 worker-health.test.ts、tests/integration/worker-health.test.ts；组合 failures/abort/started/双连接状态表。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f048"></a>

#### F048 — 生成资产预算验证用单次具名累计区分 legacy 与 current

- **优先级**：P3 / 表达与测试可读性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`validGeneratedAssets`。

**现在（连续原文）** — [`apps/server/src/assets/files.ts:75–109`](../apps/server/src/assets/files.ts#L75)

```ts
export function validGeneratedAssets(
  query: Readonly<{ threadID: string; runID: string }>,
  assets: readonly AssetReference[],
  limits: AssetLimits,
) {
  if (assets.length > ASSET_MAX_OUTPUT_FILES) return false
  if (new Set(assets.map((file) => file.assetID)).size !== assets.length)
    return false
  const runKey = new RegExp(
    `^(artifacts|assets/generated)/${query.threadID}/${query.runID}/[1-9][0-9]*/([^/]+)$`,
  )
  const validFiles = assets.every((file) => {
    if (!assetReferenceSchema.safeParse(file).success) return false
    const key = runKey.exec(file.objectKey)
    if (!key || key[2] !== file.assetID) return false
    // Legacy GET-only keys retain the old SQL per-file limit. This is metadata
    // acceptance, not a relaxation of configured upload or download IO budgets.
    return (
      file.byteLength <=
      (key[1] === 'artifacts' ? 16 * 1024 * 1024 : limits.maxBytes)
    )
  })
  if (!validFiles) return false

  const legacyPrefix = `artifacts/${query.threadID}/${query.runID}/`
  const currentAssets = assets.filter(
    (file) => !file.objectKey.startsWith(legacyPrefix),
  )
  if (currentAssets.length > limits.maxFiles) return false
  const currentBytes = currentAssets.reduce(
    (sum, file) => sum + file.byteLength,
    0,
  )
  return currentBytes <= limits.maxBytes
}
```

##### F048：为什么不好

先every逐文件解runKey，再filter通过另一个legacyPrefix识别current，最后reduce和length比较。相同namespace分类写在regex capture和prefix两个地方，且审阅需要跨三次遍历合成单文件上限与当前合计预算。不是运行性能缺陷。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F048：应该怎么改

保留count/dedup两个独立先决条件；for-of每项解析一次，legacy只看其16MiB单文件上限，current分别累计count/bytes。所有原上限值与空集语义不变，不添加配置或取消metadata再验证。

##### F048：改完之后的形状（拟议，未实施）

```ts
export function validGeneratedAssets(
  query: Readonly<{ threadID: string; runID: string }>,
  assets: readonly AssetReference[],
  limits: AssetLimits,
) {
  if (assets.length > ASSET_MAX_OUTPUT_FILES) return false
  if (new Set(assets.map((file) => file.assetID)).size !== assets.length)
    return false
  const runKey = new RegExp(
    `^(artifacts|assets/generated)/${query.threadID}/${query.runID}/[1-9][0-9]*/([^/]+)$`,
  )
  let currentFiles = 0
  let currentBytes = 0
  for (const file of assets) {
    if (!assetReferenceSchema.safeParse(file).success) return false
    const key = runKey.exec(file.objectKey)
    if (!key || key[2] !== file.assetID) return false
    if (key[1] === 'artifacts') {
      if (file.byteLength > 16 * 1024 * 1024) return false
      continue
    }
    if (file.byteLength > limits.maxBytes) return false
    currentFiles += 1
    currentBytes += file.byteLength
  }
  return currentFiles <= limits.maxFiles && currentBytes <= limits.maxBytes
}
```

**不能改变的事实**：emptyassets通过；全部数量≤32与assetID无重复；每项assetReferenceSchema和run/thread/fence/key匹配仍验证。legacyartifacts各自16MiB且不占currentconfigured总量；current同时受单件/总bytes和maxFiles限制。旧位置不能被重写成新位置。

**实施时的验证要求**：sh scripts/check.sh test apps/server/src/assets/files.test.ts; add mixed legacy/current case at current configured byte/count edges, all-legacy case and over32/dedup negatives. No useful direct binary-asset business analogue in Handover; reference null intentionally.

**当前验证状态**：Static evidence only; proposed AFTER is not implemented, compiled or run. No functional failure is claimed reproduced.

<a id="f049"></a>

#### F049 — download header 的 RFC5987 编码从超长插值里移出

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`downloadAsset headers`。

**现在（连续原文）** — [`apps/server/src/assets/http.ts:93–102`](../apps/server/src/assets/http.ts#L93)

```ts
    return new Response(Buffer.from(bytes), {
      headers: {
        'content-type': row.mime_type,
        'content-length': String(bytes.length),
        'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/'/g, '%27')}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
```

##### F049：为什么不好

content-disposition 的一行同时包含固定安全策略、URL 编码与 apostrophe 修正；即使 100 列仍超长。先计算 encodedName 与 disposition，headers 列表回到可扫描的安全白名单。这里不用抽单消费者 helper。

**Handover 对照边界**：无同构的认证附件 RFC5987 下载实现；Handover avatar 是不同输出合同。此项不移植 avatar 的公开缓存策略，只比较本地计算与headers白名单形状。

##### F049：应该怎么改

把RFC5987 percent encoding命名为本模块helper，再组装原header。保存content-disposition语法、quote与非ASCII处理；非法Unicode准入另属SC04合同决策，不在本美化里吞异常。

##### F049：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
const encodedName = encodeURIComponent(row.name).replace(/'/g, '%27')
const disposition = `attachment; filename="download"; filename*=UTF-8''${encodedName}`
return new Response(Buffer.from(bytes), {
  headers: {
    'content-type': row.mime_type,
    'content-length': String(bytes.length),
    'content-disposition': disposition,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
    'content-security-policy': "default-src 'none'; sandbox",
  },
})
```

**不能改变的事实**：private attachment、不暴露 bearer URL、nosniff/no-store/CSP 保留；encodeURIComponent 与 apostrophe 替换顺序保持；上传 signature 检查与可信 export 的区别不动。

**实施时的验证要求**：未来 tests/storage/assets.test.ts 的下载 headers、Unicode名字、隔离权限、digest拒绝；新增 apostrophe/Unicode 字符名 roundtrip。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f050"></a>

#### F050 — SSE 最后一帧的元数据投影与 wire framing 应是两个可见阶段

- **优先级**：P3 / 表达与测试可读性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`encodeFact`。

**现在（连续原文）** — [`apps/server/src/conversation/event-stream.ts:331–340`](../apps/server/src/conversation/event-stream.ts#L331)

```ts
function encodeFact(cursor: string, frames: Event[], encoder: EventEncoder) {
  // Only the final frame advances the cursor: a mid-fact disconnect replays
  // all frames with stable identities instead of silently dropping the suffix.
  let encoded = ''
  for (const frame of frames.slice(0, -1)) encoded += encoder.encodeSSE(frame)
  const final = frames.at(-1)
  if (final)
    encoded += `${encoder.encodeSSE({ ...final, metadata: { ...final.metadata, cursor } }).trimEnd()}\nid: ${cursor}\n\n`
  return encoded
}
```

##### F050：为什么不好

最终encoded +=超长模板把event clone、metadata合并、encoder调用、trimEnd、id framing全部嵌在一行。cursor只落最后一帧是可靠重放关键，现在审阅者必须同时核对对象白名单和换行协议。不同于既有download header字符串：这里是一次durable fact的确认边界。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:537–557`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L537-L557)

Handover asUnderway visibly projects product facts to wire fields before surrounding route serialization. No direct SSE cursor business analogue.

```ts
function asUnderway(underway: Reading['underway']) {
  if (underway === undefined) return undefined

  return {
    goal: underway.task.goal,
    ownerUserId: underway.task.ownerUserId,
    state: underway.task.state,
    sleepUntil: underway.task.sleepUntil?.toISOString() ?? null,
    presence: onTheWire(underway.whereabouts, underway.asOf),
    handedOff: underway.handedOff.map((one) => ({
      conversationId: one.conversationId,
      goal: one.goal,
      state: one.state,
      machineName: one.machineName,
      agentKind: one.agentKind,
      presence: onTheWire(one.whereabouts, underway.asOf),
    })),
    outputs: underway.outputs,
    under: underway.under,
  }
}
```

##### F050：应该怎么改

保留先编码非final帧，再具名lastFrame/finalSSE，两行构造最后id。不要改变trimEnd行为或在每帧写id。

##### F050：改完之后的形状（拟议，未实施）

```ts
function encodeFact(cursor: string, frames: Event[], encoder: EventEncoder) {
  let encoded = ''
  for (const frame of frames.slice(0, -1)) encoded += encoder.encodeSSE(frame)
  const final = frames.at(-1)
  if (!final) return encoded
  const lastFrame = { ...final, metadata: { ...final.metadata, cursor } }
  const finalSSE = encoder.encodeSSE(lastFrame).trimEnd()
  return `${encoded}${finalSSE}\nid: ${cursor}\n\n`
}
```

**不能改变的事实**：非final frame无SSE id；最后一个frame才携带同一cursor metadata和id。encoded串、trimEnd和两个结尾换行逐字不变；中途断连按whole-fact重放，不丢私有/公开过滤或重新授权。

**实施时的验证要求**：sh scripts/check.sh test tests/integration/conversation-http.test.ts; keep final-frame-only cursor, mid-fact replay, terminal reconnect cursor scenarios.

**当前验证状态**：Static source comparison only. AFTER is proposed, not implemented, compiled or functionally reproduced.

<a id="f051"></a>

#### F051 — completion 的可选字段用具名白名单对象组装

- **优先级**：P3 / 可读性。
- **适用置信度**：中高：需编译确认 inferred contract 可写。
- **符号**：`publicEvent run-completed branch`。

**现在（连续原文）** — [`apps/server/src/conversation/execution-receipts.ts:20–30`](../apps/server/src/conversation/execution-receipts.ts#L20)

```ts
    case 'run-completed':
      return {
        ...identities,
        kind: event.kind,
        messageID: event.messageID.toLowerCase(),
        text: event.text,
        ...(event.assets === undefined ? {} : { assets: event.assets }),
        ...(event.sources === undefined
          ? {}
          : { sources: webSourcesSchema.parse(event.sources) }),
      }
```

##### F051：为什么不好

两条 conditional spreads 同时混在 public allowlist 中，schema.parse 是 boundary safety，不能为了好看删掉。把 typed completion 对象先建好，明确逐字段加可选 public data，使隐藏私有 extras 的白名单更可审。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:522–533`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L522-L533)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
function asTranscript(reading: Reading) {
  const offers = Models.safeParse(reading.offers)

  return {
    ...reading,
    underway: asUnderway(reading.underway),
    offers: offers.success ? offers.data : [],
    messages: reading.messages.map((one) => {
      const read = Spoken.safeParse({ ...one, at: one.at.toISOString() })
      return read.success ? read.data : unreadable(one.seq, one.at)
    }),
  }
```

##### F051：应该怎么改

先建立具名 completion 白名单，再单独投影存在的 assets/sources，最后组装返回值。复审已用实际 TypeScript 7 编译器证明原示例对 readonly assets/sources 赋值会报 TS2540，不能引入可写映射类型或 cast 绕过合同。只复制白名单，不 spread 私有 history/provider 结果，不混淆 undefined 与省略。

##### F051：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
case 'run-completed': {
  const completed: Extract<ExecutionEvent, { kind: 'run-completed' }> = {
    ...identities,
    kind: event.kind,
    messageID: event.messageID.toLowerCase(),
    text: event.text,
  }
  const assets = event.assets === undefined ? {} : { assets: event.assets }
  const sources =
    event.sources === undefined ? {} : { sources: webSourcesSchema.parse(event.sources) }
  return { ...completed, ...assets, ...sources }
}
```

**不能改变的事实**：绝不 return {...event}；保持 UUID canonicalization 与来源 schema 清洗；undefined 与字段缺失仍区别处理；合同 readonly 保持，不增加可写 DTO 或类型断言。修正版仍须在实际 owner 内编译和验证。

**实施时的验证要求**：未来 apps/server/src/conversation/execution-receipts.test.ts、tests/integration/public-sources.test.ts 与 execution-events.test.ts；private extras canaries、omit vs []。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f052"></a>

#### F052 — AG-UI frame identity 的消息维度先命名再组装

- **优先级**：P3 / 表达与测试可读性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`projectPublicRunEvent.frames.map`。

**现在（连续原文）** — [`apps/server/src/conversation/public-run-events.ts:62–69`](../apps/server/src/conversation/public-run-events.ts#L62)

```ts
  return frames.map((frame) => ({
    ...frame,
    metadata: {
      mappingVersion: 'ag-ui-1.0.1-v1',
      eventID: `${fact.eventID}:${frame.type}:${'messageId' in frame ? frame.messageId : ''}`,
      factID: fact.eventID,
    },
  }))
```

##### F052：为什么不好

模板字符串中内嵌in-narrowing ternary，和mappingVersion/factID白名单混在一段。eventID的三段稳定身份是mid-fact重放协议，值得看见messageId空段而不是在模板里即时决定；不改变identity格式。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F052：应该怎么改

callback改block，局部messageID表示可选frame维度，再return同一个元数据对象。只替换整个map表达式，不抽identity框架。

##### F052：改完之后的形状（拟议，未实施）

```ts
return frames.map((frame) => {
  const messageID = 'messageId' in frame ? frame.messageId : ''
  return {
    ...frame,
    metadata: {
      mappingVersion: 'ag-ui-1.0.1-v1',
      eventID: `${fact.eventID}:${frame.type}:${messageID}`,
      factID: fact.eventID,
    },
  }
})
```

**不能改变的事实**：mappingVersion/factID/eventID及messageId缺失时空段逐字不变；只复制typedpublicframe，不引入随机ID或原SDKevent；同fact重放frameID稳定。

**实施时的验证要求**：sh scripts/check.sh test apps/server/src/conversation/public-run-events.test.ts; preserve stable unique frame identity replay for text, RUN_STARTED and terminal frames. No direct Handover AG-UI identity analogue, reference null.

**当前验证状态**：Static evidence only; proposed AFTER is not implemented, compiled or run. No functional failure is claimed reproduced.

<a id="f053"></a>

#### F053 — 失败摘要与共用恢复步骤分开呈现，保留不同 reason

- **优先级**：P3 / 表达与测试可读性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`failureMessage`。

**现在（连续原文）** — [`apps/server/src/conversation/public-run-events.ts:152–165`](../apps/server/src/conversation/public-run-events.ts#L152)

```ts
function failureMessage(
  reason: Extract<ExecutionEvent, { kind: 'run-failed' }>['reason'],
) {
  switch (reason) {
    case 'execution-error':
      return 'The run could not finish. Check Chat history and ask the operator to verify the execution environment before retrying.'
    case 'sandbox-recovery-required':
      return 'The execution environment needs recovery before another run.'
    case 'interrupted':
      return 'The run was interrupted. Check Chat history and ask the operator to verify the execution environment before retrying.'
    default:
      return assertNever(reason)
  }
}
```

##### F053：为什么不好

execution-error与interrupted第一句不同，但后面的长恢复句逐字相同。当前两条长return让读者比较整句才知道什么属于分类、什么属于共用恢复。RUN_ERROR.code仍来自fact.reason，不能把两类事实合成。

**Handover 实际对照** — [`apps/server/src/server/conversation-api.ts:37–55`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/conversation-api.ts#L37-L55)

Reference separates NO_AGENT/MACHINE_AWAY because their recovery differs. Here shared prose is warranted only when recovery truly matches; distinct wire reason remains.

```ts
const NO_AGENT: Failure<409> = {
  reason: 'agent-not-on-machine',
  recovery: 'choose-another-agent',
  status: 409,
}

/**
 * Its machine is not here, so the first message was not written.
 *
 * Only ever the answer to starting one. A conversation is pinned to its machine for as long as it
 * exists, so this is the last moment anybody can choose a different one — which is what the
 * recovery says to do. Saying something into a conversation that already exists is never refused
 * for this: there is nothing left to choose, and the words wait for the machine it has.
 */
const MACHINE_AWAY: Failure<409> = {
  reason: 'machine-not-here',
  recovery: 'choose-another-machine',
  status: 409,
}
```

##### F053：应该怎么改

在同一个函数内给共同恢复句一个局部名字，switch保留不同首句和闭合default。不是建立文案框架，也不是合并原因。

##### F053：改完之后的形状（拟议，未实施）

```ts
function failureMessage(
  reason: Extract<ExecutionEvent, { kind: 'run-failed' }>['reason'],
) {
  const recovery =
    'Check Chat history and ask the operator to verify the execution environment before retrying.'
  switch (reason) {
    case 'execution-error':
      return `The run could not finish. ${recovery}`
    case 'sandbox-recovery-required':
      return 'The execution environment needs recovery before another run.'
    case 'interrupted':
      return `The run was interrupted. ${recovery}`
    default:
      return assertNever(reason)
  }
}
```

**不能改变的事实**：三种reason和RUN_ERROR.code不合并；两句原公开英文逐字不变，sandbox-recovery-required仍为不同恢复句。不要展示私有SDK原因或原始exception。

**实施时的验证要求**：sh scripts/check.sh test apps/server/src/conversation/public-run-events.test.ts; existing literal interrupted wording must remain unchanged; add exact prose and distinct code assertions for all three reasons.

**当前验证状态**：Static source comparison only. AFTER is proposed, not implemented, compiled or functionally reproduced.

<a id="f054"></a>

#### F054 — 终态 outcome map 用两段直接循环替代双链、spread 与 tuple 断言

- **优先级**：P3 / 可读性。
- **适用置信度**：高：两段循环保留原覆盖顺序，不需要假定相同键永远不存在。
- **符号**：`snapshotOwnedMessages outcomes`。

**现在（连续原文）** — [`apps/server/src/db/conversations.ts:162–184`](../apps/server/src/db/conversations.ts#L162)

```ts
      const outcomes = new Map<
        string,
        { runID: string; status: 'completed' | 'cancelled' }
      >([
        ...terminals
          .filter((terminal) => terminal.kind === 'run-completed')
          .map(
            (terminal) =>
              [
                publicUUIDSchema.parse(terminal.output_message_id),
                { runID: terminal.run_id, status: 'completed' },
              ] as const,
          ),
        ...terminals
          .filter((terminal) => terminal.kind === 'run-cancelled')
          .map(
            (terminal) =>
              [
                terminal.message_id,
                { runID: terminal.run_id, status: 'cancelled' },
              ] as const,
          ),
      ])
```

##### F054：为什么不好

两次 filter/map、两组 spread 与 as const tuple 叠成缩进阶梯。先 completed 后 cancelled 是现有覆盖顺序：不为了变成一遍 loop 而假定两者永远没有同一个键。两段直接循环保留顺序，把两种 message identity 的差异写出来。

**Handover 实际对照** — [`apps/cli/src/checking-in.ts:292–304`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/checking-in.ts#L292-L304)

没有直接业务对应；只借鉴下列实际源码的表达形状，不移植其协议或架构。

```ts
  const stopping = wanted
    .map((one) => ({ one, running: answering.get(one.conversationId) }))
    // The turn and not just the conversation. A stop is read out of the tables a moment before it
    // is acted on, and in that moment the turn it was about can end and the next one begin — on
    // the same conversation, because interrupting is how the next one got there. Matched loosely,
    // the interrupt stops the answer it was making room for.
    .filter((both) => both.running !== undefined && both.running.afterSeq === both.one.afterSeq)
    .map((both) => both.running as Answering)

  for (const one of stopping) {
    say(`stopping ${one.conversationId}`)
    await one.stop()
  }
```

##### F054：应该怎么改

用两段直接for循环填Map：completed先、cancelled后。保留原override顺序而不交错一遍loop；删map/filter/spread/tuple assertions，不改变durable outcome事实。

##### F054：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
const outcomes = new Map<
  string,
  { runID: string; status: 'completed' | 'cancelled' }
>()
for (const terminal of terminals) {
  if (terminal.kind !== 'run-completed') continue
  const messageID = publicUUIDSchema.parse(terminal.output_message_id)
  outcomes.set(messageID, { runID: terminal.run_id, status: 'completed' })
}
for (const terminal of terminals) {
  if (terminal.kind !== 'run-cancelled') continue
  outcomes.set(terminal.message_id, {
    runID: terminal.run_id,
    status: 'cancelled',
  })
}
```

**不能改变的事实**：完成对应 assistant output；取消对应 user input；completed阶段在cancelled阶段前，保持相同键覆盖优先级；failure 仍独立组装；锁、事务、canonical ledger、publicUUID parse 保持。

**实施时的验证要求**：未来 execution-events.test.ts durable reload/gap/cancellation；tests/integration/thread-lifecycle.test.ts；增加同 input 重用的合法多 run 情况确认 map 覆盖优先级。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f055"></a>

#### F055 — readActiveRuns 的 running / terminal SQL 用 SQL 自己的多行结构

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`readActiveRuns SQL predicates`。

**现在（连续原文）** — [`apps/server/src/db/conversations.ts:241–250`](../apps/server/src/db/conversations.ts#L241)

```ts
    .select(
      sql<boolean>`exists (select 1 from product.execution_events e where e.run_id = start.run_id and e.thread_id = start.thread_id and e.payload ->> 'kind' = 'run-started')`.as(
        'is_running',
      ),
    )
    .where('start.thread_id', '=', threadID)
    .where(acceptedStartIdentity())
    .where(
      sql<boolean>`not exists (select 1 from product.execution_events e where e.run_id = start.run_id and e.thread_id = start.thread_id and e.payload ->> 'kind' in ('run-completed','run-cancelled','run-failed'))`,
    )
```

##### F055：为什么不好

这两条极长 template literal 不会被 Prettier 按 SQL clause 自动断开，100 列也无济于事。把 exists 与 not exists 的 FROM/WHERE/AND 展开，仍 inline、同一查询，避免为每个 predicate 添加 helper。

**Handover 实际对照** — [`apps/server/src/db/connection.ts:30–38`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/connection.ts#L30-L38)

没有直接对应的 active-run SQL。引用显示 reference 用具名事务边界表达实际权威；这里只改善 SQL 的视觉 clause，不改事务/时钟。

```ts
/**
 * An open transaction, for anything that only works inside one.
 *
 * `pg_advisory_xact_lock` is released when the transaction ends, so handed the pool instead, it
 * is taken and let go by the same statement and protects nothing. Nothing about that shows up at
 * runtime — the code runs, the race just comes back. Naming the type is what makes it a compile
 * error rather than a comment somebody has to have read.
 */
export type Tx = Transaction<DB>
```

##### F055：应该怎么改

将running/terminal SQL predicate按SQL语义多行展开；不拆成generic query DSL，不改变bindings、状态集合、锁/时间语义。

##### F055：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
.select(
  sql<boolean>`exists (
select 1 from product.execution_events e
where e.run_id = start.run_id
  and e.thread_id = start.thread_id
  and e.payload ->> 'kind' = 'run-started'
)`.as('is_running'),
)
.where('start.thread_id', '=', threadID)
.where(acceptedStartIdentity()).where(sql<boolean>`not exists (
select 1 from product.execution_events e
where e.run_id = start.run_id
and e.thread_id = start.thread_id
and e.payload ->> 'kind' in ('run-completed','run-cancelled','run-failed')
)`)
```

**不能改变的事实**：参数仍由 Kysely SQL tag 绑定；存储 run/thread 两列同筛；acceptedStartIdentity 不删；终态列表和 canonical ledger authority 不改。

**实施时的验证要求**：未来 execution-events.test.ts 的取消等待终态与 gap reload；integration SQL 测试，不写扫描换行的测试。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f056"></a>

#### F056 — 活动 run 状态优先级用局部变量明确声明

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`readActiveRuns result mapping`。

**现在（连续原文）** — [`apps/server/src/db/conversations.ts:253–264`](../apps/server/src/db/conversations.ts#L253)

```ts
  return runs.map((run) => {
    if (!run.message_id)
      throw new Error('Accepted start lacks message identity')
    return {
      runID: run.run_id,
      messageID: run.message_id,
      status: run.is_stopping
        ? 'stopping'
        : run.is_running
          ? 'running'
          : 'accepted',
    }
```

##### F056：为什么不好

is_stopping 和 is_running 是不同事实，嵌套 ternary 隐藏 stopping 的优先级。读者同时还在审 accepted start message identity。保留一个 map，只把状态判定从对象里移出。

**Handover 实际对照** — [`apps/server/src/conversation/busy.ts:23–32`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/conversation/busy.ts#L23-L32)

直接对比 derived status 的清晰判定。其 idle/working/unknown 与本项目 accepted/running/stopping 不是同一状态机；只借鉴在返回形状前明示判定，不移植状态。

```ts
/**
 * `owed` is a question with no answer yet: one no machine has taken, or one a machine took and
 * has not ended. The difference matters to the machine and to nobody else — from here both are
 * "it is still owed an answer".
 */
export function working(owed: boolean, machine: Presence): Working {
  if (!owed) return { state: 'idle' }

  return machine.state === 'here' ? { state: 'working' } : { state: 'unknown' }
}
```

##### F056：应该怎么改

在readActiveRuns映射的原局部声明状态，再按stopping优先、running其次、terminal最后赋值；其他公开projection与排序不变。

##### F056：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
return runs.map((run) => {
  if (!run.message_id) throw new Error('Accepted start lacks message identity')
  let status: ActiveRun['status'] = 'accepted'
  if (run.is_running) status = 'running'
  if (run.is_stopping) status = 'stopping'

  return { runID: run.run_id, messageID: run.message_id, status }
})
```

**不能改变的事实**：stopping 覆盖 running；没有 durable terminal 前还要 active；不借 worker lease 判断 completed/cancelled。

**实施时的验证要求**：未来 execution-events.test.ts 的 cancellation 不能提前 fabricating outcome；tests/integration/conversation-http.test.ts 的 accepted/running/stopping reload。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f057"></a>

#### F057 — 完成消息写入的主体不必整段缩进在唯一 kind 条件内

- **优先级**：P3 / 表达与测试可读性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`storeFinalMessage`。

**现在（连续原文）** — [`apps/server/src/db/execution-events.ts:173–194`](../apps/server/src/db/execution-events.ts#L173)

```ts
async function storeFinalMessage(
  tx: Transaction<DB>,
  event: ExecutionEvent,
): Promise<void> {
  if (event.kind === 'run-completed') {
    // Never adopt an existing message ID, even if its text happens to match.
    const message = await tx
      .insertInto('product.messages')
      .values({
        message_id: event.messageID,
        thread_id: event.threadID,
        role: 'assistant',
        text: event.text,
        sources: sql`${JSON.stringify(event.sources ?? [])}::jsonb`,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning('message_id')
      .executeTakeFirst()
    if (!message) throw receiptConflict
    await storeAssets(tx, event)
  }
}
```

##### F057：为什么不好

只对run-completed有动作，却将insert chain、collision guard和asset effect整段包在if里。kind排除是简单前置条件；提前返回使整个“写最终消息然后附件”的同一事务阶段成为函数主段落。不是要求拆开事务或去掉collision。

**Handover 实际对照** — [`apps/server/src/db/conversation.ts:353–384`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/conversation.ts#L353-L384)

machineSays returns early for no-conversation and said-already before its ledger effects. Same phase readability, no direct canonical assistant completion analogue.

```ts
export async function machineSays(db: Database, reporting: Reporting): Promise<Said> {
  return db.transaction().execute(async (tx) => {
    const conversation = await stillItsToWriteOn(tx, reporting)

    if (conversation === undefined) return { kind: 'no-conversation' }

    const written = await append(tx, reporting)

    // A line that was already here is a retry, and everything below already happened in the
    // transaction that wrote it. Carried on regardless, an ending retried under an old name ends
    // whichever turn is running *now* — which by then is a different question, still being
    // answered.
    if (written.kind === 'said-already') return written

    // The record and the ledger move together. An ending in the transcript with the turn still
    // open would leave a conversation that reads as finished and is still owed an answer — and
    // the machine would be handed the same question again on its next report.
    if (ends(reporting.message)) {
      const running = await openTurn(tx, reporting.conversationId)
      if (running !== undefined) await endTurn(tx, reporting.conversationId, running)
      // A turn that went wrong stops a piece of work that was handed over: whether it matters is
      // a person's to say, and an agent that is not handed a turn cannot try again on its own.
      if (wentWrong(reporting.message)) await waitsForAPerson(tx, reporting.conversationId)
      // This machine has just become free, and whatever it is holding open was answered "nothing"
      // because it was not. Waking it is how the next question starts now rather than in
      // twenty-five seconds.
      await wakeMachine(tx, reporting.machineId)
    }

    return written
  })
}
```

##### F057：应该怎么改

非completion立即return；移动现有写入表达式不改值、冲突处理、effect顺序。

##### F057：改完之后的形状（拟议，未实施）

```ts
async function storeFinalMessage(
  tx: Transaction<DB>,
  event: ExecutionEvent,
): Promise<void> {
  if (event.kind !== 'run-completed') return
  // Never adopt an existing message ID, even if its text happens to match.
  const message = await tx
    .insertInto('product.messages')
    .values({
      message_id: event.messageID,
      thread_id: event.threadID,
      role: 'assistant',
      text: event.text,
      sources: sql`${JSON.stringify(event.sources ?? [])}::jsonb`,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('message_id')
    .executeTakeFirst()
  if (!message) throw receiptConflict
  await storeAssets(tx, event)
}
```

**不能改变的事实**：只有run-completed写assistantmessage；onConflict不adopt既有ID，receiptConflict仍抛并回滚整个receipt/assistant/assets事务；sources JSONB白名单和storeAssets顺序不变。

**实施时的验证要求**：sh scripts/check.sh; tests/integration/conversation-http.test.ts; retain duplicate completion, conflicting message identity, noncompletion-no-message scenarios.

**当前验证状态**：Static evidence only; proposed AFTER is not implemented, compiled or run. No functional failure is claimed reproduced.

<a id="f058"></a>

#### F058 — 重放的五条 identity 对照不必先变成匿名 tuple 矩阵

- **优先级**：P3 / 表达与测试可读性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`acceptedMessage matchingHeaders`。

**现在（连续原文）** — [`apps/server/src/db/submissions.ts:146–152`](../apps/server/src/db/submissions.ts#L146)

```ts
  const matchingHeaders = [
    [command.commandID, message.command_id],
    [command.runID, message.run_id],
    [command.threadID, message.command_thread_id],
    [command.threadID, message.thread_id],
    [command.input.messageID, message.command_message_id],
  ].every(([wire, indexed]) => wire === indexed)
```

##### F058：为什么不好

五对opaque identity先组数组，再每行解构成通用wire/indexed，类型推断把不同字段统一为string|null。没有真实需要遍历的产品集合；这是固定的五条权威相等条件，矩阵降低读者看清input-message双重身份的速度。

**Handover 实际对照** — [`apps/server/src/db/conversation.ts:189–194`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/conversation.ts#L189-L194)

Actual openedBefore explicitly compares existing.spaceId/machineId/agentKind to beginning; fixed identity conditions stay visibly paired.

```ts
  if (
    existing.spaceId !== beginning.spaceId ||
    existing.machineId !== beginning.machineId ||
    existing.agentKind !== beginning.agentKind
  )
    return { kind: 'id-taken' }
```

##### F058：应该怎么改

直接命名matchingHeaders为五项&&表达式；保留额外command.input.text检查及assets事实重放，不能仅比较commandID。

##### F058：改完之后的形状（拟议，未实施）

```ts
const matchingHeaders =
  command.commandID === message.command_id &&
  command.runID === message.run_id &&
  command.threadID === message.command_thread_id &&
  command.threadID === message.thread_id &&
  command.input.messageID === message.command_message_id
```

**不能改变的事实**：保留两份thread identity、messageID、commandID/runID全部相等条件；后续text/assets比对、先授权锁thread和durable重放IDs不变；不能把不一致索引当可接受replay。

**实施时的验证要求**：sh scripts/check.sh test tests/integration/conversation-http.test.ts; retained uppercase, corrupted headers, exact replay and foreign IDs must retain outcomes.

**当前验证状态**：Static source comparison only. AFTER is proposed, not implemented, compiled or functionally reproduced.

<a id="f059"></a>

#### F059 — 保留位置的 upload 与 generated 策略用明确分支赋值

- **优先级**：P3 / 表达与测试可读性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`retainedReferencesMatch.locationMatches`。

**现在（连续原文）** — [`apps/server/src/db/submissions.ts:179–187`](../apps/server/src/db/submissions.ts#L179)

```ts
    const locationMatches =
      asset.source === 'upload'
        ? reference.objectKey ===
            `materials/${asset.thread_id}/${asset.asset_id}` ||
          reference.objectKey ===
            `assets/uploads/${asset.thread_id}/${asset.asset_id}`
        : new RegExp(
            `^(artifacts|assets/generated)/${asset.thread_id}/${asset.run_id}/[1-9][0-9]*/${asset.asset_id}$`,
          ).test(reference.objectKey)
```

##### F059：为什么不好

这里ternary内含两个upload key相等条件、跨行||和另一个generated RegExp/test。静态重放兼容性的两套键规则需要可读，但不是扩展新key或重写历史identity；分支在表达式里叠了三层。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F059：应该怎么改

用let locationMatches:boolean和if/else，在同一callback保留exact旧路径；后续sameFile和every仍原样。AFTER仅替换整个声明表达式。

##### F059：改完之后的形状（拟议，未实施）

```ts
let locationMatches: boolean
if (asset.source === 'upload') {
  locationMatches =
    reference.objectKey === `materials/${asset.thread_id}/${asset.asset_id}` ||
    reference.objectKey ===
      `assets/uploads/${asset.thread_id}/${asset.asset_id}`
} else {
  const generatedKey = new RegExp(
    `^(artifacts|assets/generated)/${asset.thread_id}/${asset.run_id}/[1-9][0-9]*/${asset.asset_id}$`,
  )
  locationMatches = generatedKey.test(reference.objectKey)
}
```

**不能改变的事实**：upload匹配materials或assets/uploads的两条原位置；generated匹配artifacts或assets/generated原run/fence/path。sameFile/typedmetadata/order及已readyfirstlocation authority不变，不自动rehome历史资产。

**实施时的验证要求**：sh scripts/check.sh; tests/integration/conversation-http.test.ts retained command asset key/rehome scenarios. No direct Handover remote-storage legacy key analogue; reference null intentionally.

**当前验证状态**：Static evidence only; proposed AFTER is not implemented, compiled or run. No functional failure is claimed reproduced.

<a id="f060"></a>

#### F060 — OpenAPI SDK 兼容断言用一个 owner 内 type alias 表达

- **优先级**：P3 / 可读性。
- **适用置信度**：高。
- **符号**：`generateDocuments component schema adapter`。

**现在（连续原文）** — [`scripts/generate-api.ts:29–37`](../scripts/generate-api.ts#L29)

```ts
      components: {
        // Hono OpenAPI's component declaration still narrows JSON Schema to
        // OpenAPI 3.0. The emitted document is 3.1 and uses native 2020-12 schemas;
        // independent AJV tests validate the conversion rather than weakening it.
        schemas: schemas as NonNullable<
          NonNullable<
            GenerateSpecOptions['documentation']['components']
          >['schemas']
        >,
```

##### F060：为什么不好

三层 indexed NonNullable 放在对象属性的 as 之后，挡住 components 的视觉结构。兼容性断言有真实理由（官方库 typing 窄于3.1），不应删掉或 any；为这个 SDK boundary 给出私有 alias。

**Handover 实际对照** — [`apps/cli/src/agents/agent.ts:90–94`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/agents/agent.ts#L90-L94)

没有直接 OpenAPI generator 对应；reference 以 Message/Tool 命名 indexed access+Extract 组合，借鉴可读类型层次，不能据此删除官方 typing兼容断言。

```ts
/** One message as the server will accept it, and the shape of a tool line inside it. */
type Message = components['schemas']['MachineMessage']['message']

type Tool = Extract<Message, { role: 'tool' }>['content']
```

##### F060：应该怎么改

在generator owner定义 components 和 schemas 两个私有 indexed type 别名，components.schemas 的 SDK 兼容断言改用别名。实际不涉及函数参数或 SDKDocument 名称；不引入新SDK/compiler探针，不改变生成物内容。

##### F060：改完之后的形状（拟议，未实施）

在原符号的同一词法作用域替换所示段落；若为表达式/签名fragment，不把它当完整可编译模块。

```ts
type OpenAPIComponents = NonNullable<
  GenerateSpecOptions['documentation']['components']
>
type OpenAPIComponentSchemas = NonNullable<OpenAPIComponents['schemas']>
```

generateDocuments 的 documentation.components 属性完整替换；schemas 是前文已有 publicJSONSchemas() 结果。

```ts
components: {
  // Hono OpenAPI narrows component declarations to OpenAPI 3.0.
  // The document uses native 2020-12 schemas; independent AJV checks validate them.
  schemas: schemas as OpenAPIComponentSchemas,
  securitySchemes: {
    sessionCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: 'better-auth.session_token',
      description:
        'Native Better Auth signed cookie; production cookie naming follows SDK configuration.',
    },
  },
},
```

**不能改变的事实**：仍 native publicJSONSchemas 唯一 source；不手写 schema、不弱化到 any；3.1/2020-12 独立 AJV 验证保留；auth spec 仍 offline。

**实施时的验证要求**：未来 scripts/generate-api.test.ts、.github/verify-api.ts；生成检查写 /tmp 而非项目 generated，比较内容；本次没有运行 generator。

**当前验证状态**：当前原文和引用范围已核对；AFTER 未实施、未编译或运行。不把样式判断当作已复现功能缺陷。

<a id="f061"></a>

#### F061 — 关系完整性矩阵用具名 case，而不是依赖四槽 tuple 位置

- **优先级**：P3 / 可读性。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`invalid relational-integrity cases`。

**现在（连续原文）** — [`tests/integration/relational-integrity.test.ts:180–217`](../tests/integration/relational-integrity.test.ts#L180)

```ts
const invalid = [
  [
    'product message thread',
    "INSERT INTO product.command_outbox (command_id,thread_id,run_id,message_id,command) VALUES ($1,$2,$3,$4,'{}')",
    (ids: ReturnType<typeof identities>) => [id(), ids.b, ids.run, ids.message],
    'command_outbox_message_identity',
  ],
  [
    'run command thread',
    'UPDATE execution.runs SET thread_id=$1 WHERE run_id=$2',
    (ids: ReturnType<typeof identities>) => [ids.b, ids.run],
    'runs_command_identity',
  ],
  [
    'run command native ID',
    'UPDATE execution.runs SET run_id=$1 WHERE run_id=$2',
    (ids: ReturnType<typeof identities>) => [id(), ids.run],
    'runs_command_identity',
  ],
  [
    'event run thread',
    "INSERT INTO execution.event_outbox (event_id,thread_id,run_id,ordinal,event) VALUES ($1,$2,$3,1,'{}')",
    (ids: ReturnType<typeof identities>) => [id(), ids.b, ids.run],
    'event_outbox_run_identity',
  ],
  [
    'active run other thread',
    "UPDATE execution.conversations SET active_run_id=$1,lease_owner='worker',lease_until=now() WHERE thread_id=$2",
    (ids: ReturnType<typeof identities>) => [ids.run, ids.b],
    'conversations_active_run_identity',
  ],
  [
    'active run missing native ID',
    "UPDATE execution.conversations SET active_run_id=$1,lease_owner='worker',lease_until=now() WHERE thread_id=$2",
    (ids: ReturnType<typeof identities>) => [id(), ids.a],
    'conversations_active_run_identity',
  ],
] as const
```

##### F061：为什么不好

每项含 name、长 SQL、生成 values 的 function、constraint；两个 consumer 一个完整 destructure、一个跳过第一槽。review 需跨数十行记住第 3/4 项语义，长 SQL/FK tests 很容易把 assertion 的 constraint 与 value factory 对错位。具名事实比为每项抽函数更少概念。

**Handover 实际对照** — [`apps/server/src/db/across-instances.spec.ts:54–69`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/across-instances.spec.ts#L54-L69)

参考 concurrent mail test 把 request 的 requestKey/email/purpose/codeHash/askedBy 命名为一个实际概念；本矩阵同理用 case 属性代替 positional slots，不是新的生产 owner。

```ts
  it('send one mail between them when the same request reaches both', async () => {
    const request = {
      requestKey: `${RUN}-k1`,
      email: EMAIL,
      purpose: 'sign-in' as const,
      codeHash: hashCode(EMAIL, CODE, env.AUTH_SECRET),
      askedBy: null,
    }

    const [a, b] = await Promise.all([issueCode(one, request, ROOM), issueCode(two, request, ROOM)])

    expect([a.kind, b.kind].sort()).toEqual(['issued', 'replayed'])
    expect(
      await one.selectFrom('email_codes').select('id').where('email', '=', EMAIL).execute(),
    ).toHaveLength(1)
  })
```

##### F061：应该怎么改

只将六个四槽 tuple 改对象。两个 loop 改 for (const { name, query, values, constraint } of invalid) 与 for (const { query, values, constraint } of invalid)。保持原 SQL 字节、factory 和所有场景；不变历史 migration。

##### F061：改完之后的形状（拟议，未实施）

在所列原文件的同一词法上下文替换此局部段落；它不是可单独编译的完整模块。

```ts
const invalid = [
  {
    name: 'product message thread',
    query:
      "INSERT INTO product.command_outbox (command_id,thread_id,run_id,message_id,command) VALUES ($1,$2,$3,$4,'{}')",
    values: (ids: ReturnType<typeof identities>) => [
      id(),
      ids.b,
      ids.run,
      ids.message,
    ],
    constraint: 'command_outbox_message_identity',
  },
  {
    name: 'run command thread',
    query: 'UPDATE execution.runs SET thread_id=$1 WHERE run_id=$2',
    values: (ids: ReturnType<typeof identities>) => [ids.b, ids.run],
    constraint: 'runs_command_identity',
  },
  {
    name: 'run command native ID',
    query: 'UPDATE execution.runs SET run_id=$1 WHERE run_id=$2',
    values: (ids: ReturnType<typeof identities>) => [id(), ids.run],
    constraint: 'runs_command_identity',
  },
  {
    name: 'event run thread',
    query:
      "INSERT INTO execution.event_outbox (event_id,thread_id,run_id,ordinal,event) VALUES ($1,$2,$3,1,'{}')",
    values: (ids: ReturnType<typeof identities>) => [id(), ids.b, ids.run],
    constraint: 'event_outbox_run_identity',
  },
  {
    name: 'active run other thread',
    query:
      "UPDATE execution.conversations SET active_run_id=$1,lease_owner='worker',lease_until=now() WHERE thread_id=$2",
    values: (ids: ReturnType<typeof identities>) => [ids.run, ids.b],
    constraint: 'conversations_active_run_identity',
  },
  {
    name: 'active run missing native ID',
    query:
      "UPDATE execution.conversations SET active_run_id=$1,lease_owner='worker',lease_until=now() WHERE thread_id=$2",
    values: (ids: ReturnType<typeof identities>) => [id(), ids.a],
    constraint: 'conversations_active_run_identity',
  },
] as const
```

**不能改变的事实**：保留同-schema 六类拒绝、真实 SAVEPOINT rollback、forward validation 未重写 retained JSON、native lifecycle admission。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/relational-integrity.test.ts。聚焦回归要求：Run the unchanged integration scenarios against launcher-owned PostgreSQL/Redis; no provider calls. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f062"></a>

#### F062 — 三个 local model fixtures 只共享 SSE framing，答案与工具叙事继续各自独立

- **优先级**：P3 / 可读性。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`localModel fetch response / shared model SSE framing`。

**现在（连续原文）** — [`tests/integration/runtime.test.ts:60–68`](../tests/integration/runtime.test.ts#L60)

```ts
      return new Response(
        chunks
          .map(
            (chunk) =>
              `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, ...chunk }] })}\n\n`,
          )
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
```

##### F062：为什么不好

runtime.localModel、execution-store.piProviderFixture 和 public-sources 的 model fetch 各自复制 map→JSON.stringify→template→join→DONE→Response headers 的三层表达式；对 framing 的共同修正要跨三个文件，而 answer queue、tool_calls/reasoning/private canaries 是三种独立被测事实。不能为了去重把 expected answer 或动态行为统一。

**Handover 实际对照** — [`apps/server/src/db/across-instances.spec.ts:356–411`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/across-instances.spec.ts#L356-L411)

参考 aQuestion 复用非平凡真实 enrollment/conversation plumbing，而各 race test 仍独立断言不同 outcomes；本项目相应只复用 wire framing，不能把 paid sandbox与local-account adapter约束等同。

```ts
/** A machine in a Space, a conversation on it, and one question nobody has answered. */
async function aQuestion(): Promise<{
  machineId: string
  conversationId: string
  spaceId: string
  userId: string
}> {
  const userId = await someone('asking')
  const made = await createSpace(one, {
    requestKey: `${RUN}-space`,
    userId,
    displayName: `Acme ${RUN.slice(0, 6)}`,
    emoji: '🏠',
    slug: normalizeSlug(`Acme ${RUN.slice(0, 6)}`) as Slug,
  })
  if (made.kind !== 'created') throw new Error('the fixture could not make a Space')

  const secret = newEnrolmentSecret()
  const userCode = newUserCode()
  await openEnrolment(one, {
    kind: 'asking',
    machineName: 'mina-mbp',
    secretHash: secret.hash,
    userCode,
  })
  await approveEnrolment(one, userCode, { userId, approvedSpaceId: made.space.id })
  const collected = await collectEnrolment(one, {
    secretHash: secret.hash,
    tokenHash: hashSecret(`hm_${randomUUID()}`),
    machineName: 'mina-mbp',
  })
  if (collected.kind !== 'granted') throw new Error('the fixture could not attach a machine')
  await checkIn(one, collected.machineId, {
    version: undefined,
    found: [{ kind: 'claude-code', version: '2.1.231' }],
  })

  const conversation = await beginConversation(one, {
    conversationId: randomUUID(),
    spaceId: made.space.id,
    machineId: collected.machineId,
    agentKind: 'claude-code',
    saidBy: userId,
    asked: { text: 'take your time' },
  })
  if (conversation.kind !== 'begun') {
    throw new Error(`the fixture could not open a conversation: ${conversation.kind}`)
  }

  return {
    machineId: collected.machineId,
    conversationId: conversation.conversationId,
    spaceId: made.space.id,
    userId,
  }
}
```

##### F062：应该怎么改

新增仅测试用model-stream-fixture；它只将调用者提供的完整envelopes编码为SSE、追加DONE和创建Response。三处原始id/model/object存在性与choices形状逐字保留，不添加统一的OpenAI DTO或可选配置。request inspection、answer queue、tool_calls/reasoning/private canaries仍在各自owner。

##### F062：改完之后的形状（拟议，未实施）

runtime.localModel的fetch callback中，替换原new Response表达式。新helper不接收expected答案。

```ts
const envelopes = chunks.map((chunk) => ({
  id: 'local',
  object: 'chat.completion.chunk',
  model: 'local',
  choices: [{ index: 0, ...chunk }],
}))
return modelStream(envelopes)
```

新文件tests/integration/model-stream-fixture.ts完整正文；只接受已由消费者组装的完整envelope，不读答案、不规范化payload。

```ts
export function modelStream(envelopes: readonly unknown[]) {
  const frames = envelopes.map(
    (envelope) => `data: ${JSON.stringify(envelope)}\n\n`,
  )
  return new Response(frames.join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
}
```

三个现有消费者的named import；运行时产品模块不依赖该测试fixture。

```ts
import { modelStream } from './model-stream-fixture'
```

execution-store.test.ts现有piProviderFixture的fetch回调中，替换new Response表达式；text仍来自原answer queue。

```ts
const chunks = [
  { delta: { role: 'assistant', content: text }, finish_reason: null },
  { delta: {}, finish_reason: 'stop' },
]
const envelopes = chunks.map((chunk) => ({
  id: 'fixture',
  object: 'chat.completion.chunk',
  model: 'fixture-model',
  choices: [{ index: 0, ...chunk }],
}))
return modelStream(envelopes)
```

public-sources.test.ts现有model fetch回调，保留它原来没有object字段这一事实；chunks/动态tool_calls/COT仍在原局部。

```ts
const envelopes = chunks.map((chunk) => ({
  id: 'fixture',
  model: 'fixture',
  choices: [{ index: 0, ...chunk }],
}))
return modelStream(envelopes)
```

**不能改变的事实**：不替换 real Pi HTTP loopback为 mocked harness；模型 request/auth检查、两轮history与web_search tool/reasoning隐私路径均留在原 test；expected values不来自helper。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/runtime.test.ts。聚焦回归要求：Retain tests/integration/runtime.test.ts, execution-store.test.ts and public-sources.test.ts full Pi loopback cases; add a focused framing check for two chunks followed by DONE, without moving answer expectations into helper. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f063"></a>

#### F063 — indexed corruption 场景的值选择显示真实 identity 来源，不用右移三元阶梯

- **优先级**：P3 / 可读性。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`exact replay rejects inconsistent indexed header: value`。

**现在（连续原文）** — [`tests/integration/submission.test.ts:333–338`](../tests/integration/submission.test.ts#L333)

```ts
    const value =
      header === 'thread_id'
        ? other.threadID
        : header === 'message_id'
          ? other.messageID
          : crypto.randomUUID()
```

##### F063：为什么不好

这不是普通默认值：thread/message 必须来自已真实插入的 other rows 才能区分 FK 先拒绝与 wire replay conflict，而 command/run 可是新 UUID。嵌套三元把这两个证据来源折进六行右移表达式，紧接 message unique deletion 和 mutation 时难审每个 branch 的前置事实。

**Handover 实际对照** — [`apps/server/src/db/across-instances.spec.ts:212–251`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/across-instances.spec.ts#L212-L251)

参考 actual race tests 各自显式命名 relation、opened/taken/written 和不同拒绝 outcome；这里无需机械拆成四个 test，只显露来源决定。

```ts

    const opened = await afterRelationshipRemoval({ machineId, spaceId }, async () =>
      beginConversation(one, {
        conversationId: randomUUID(),
        spaceId,
        machineId,
        agentKind: 'claude-code',
        saidBy: userId,
        asked: { text: 'too late' },
      }),
    )

    expect(opened).toEqual({ kind: 'no-machine' })
  })

  it('does not claim a turn after relationship removal has begun', async () => {
    const { machineId, spaceId } = await aQuestion()

    const taken = await afterRelationshipRemoval({ machineId, spaceId }, async () =>
      takeOne(one, machineId),
    )

    expect(taken).toBeUndefined()
  })

  it('does not write after relationship removal has begun', async () => {
    const { machineId, conversationId, spaceId } = await aQuestion()

    const written = await afterRelationshipRemoval({ machineId, spaceId }, async () =>
      machineSays(one, {
        conversationId,
        machineId,
        key: 'too-late',
        message: { role: 'assistant', content: { text: 'too late' } },
      }),
    )

    expect(written).toEqual({ kind: 'no-conversation' })
  })
```

##### F063：应该怎么改

在原 test 局部 switch 四项闭合 header；不抽只转发的 helper、不动 mutation 或 FK 分支。类型保留 as const header union，任意将来新增 header 会因 value 未赋值而暴露。

##### F063：改完之后的形状（拟议，未实施）

在所列原文件的同一词法上下文替换此局部段落；它不是可单独编译的完整模块。

```ts
let value: string
switch (header) {
  case 'thread_id':
    value = other.threadID
    break
  case 'message_id':
    value = other.messageID
    break
  case 'command_id':
  case 'run_id':
    value = crypto.randomUUID()
    break
}
```

**不能改变的事实**：所有四种 corruption cases、真实 FK、message unique removal、wire 不修复历史与精确 replay 保留；不把 expected value 从 production normalization 派生。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/submission.test.ts。聚焦回归要求：Run the unchanged integration scenarios against launcher-owned PostgreSQL/Redis; no provider calls. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f064"></a>

#### F064 — 让四种fixture凭据旋转显示成四条sed clause

- **优先级**：P3 / 可维护性。
- **适用置信度**：高（静态证据；拟议实现未验证）。
- **符号**：`rotation fixture rewrite and native reapplication`。

**现在（连续原文）** — [`tests/scripts/deployment-check.sh:159–163`](../tests/scripts/deployment-check.sh#L159)

```sh
# Reapply the same native initialization with rotated fixture passwords.
sed -e 's/^SERVER_DB_PASSWORD=.*/SERVER_DB_PASSWORD=0000000000000000000000000000000000000000000000000000000000000006/' -e 's/^SERVER_OBJECT_STORAGE_SECRET_ACCESS_KEY=.*/SERVER_OBJECT_STORAGE_SECRET_ACCESS_KEY=rotated-server-secret/' -e 's/^WORKER_OBJECT_STORAGE_SECRET_ACCESS_KEY=.*/WORKER_OBJECT_STORAGE_SECRET_ACCESS_KEY=rotated-worker-secret/' -e 's/^WORKER_DB_PASSWORD=.*/WORKER_DB_PASSWORD=0000000000000000000000000000000000000000000000000000000000000007/' "$staging/env" > "$staging/rotated"
mv "$staging/rotated" "$staging/env"
compose run --rm -T migrate
compose run --rm -T storage-init
```

##### F064：为什么不好

四个独立替换挤在几百列一行，review难辨server/worker的SQL和storage两对凭据都被旋转。printWidth不会拆这条shell；native reapply顺序本身正确，应保持线性。

**Handover 实际对照** — [`apps/server/scripts/generate.ts:22–32`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/scripts/generate.ts#L22-L32)

reference将真实command arguments显示为顺序clauses；无role-secret rotation直接对应，不要求shell改写为TypeScript。

```ts
run(binary('kysely-codegen'), [
  '--url',
  url,
  '--dialect',
  'postgres',
  '--out-file',
  'generated/db.ts',
  // dbmate's own bookkeeping table is not part of our schema.
  '--exclude-pattern',
  'schema_migrations',
])
```

##### F064：应该怎么改

每个完整-e表达式各一续行，保持staging/mv原子边界和后续native jobs。不引入template renderer或credential-rotation框架。

##### F064：改完之后的形状（拟议，未实施）

所列原文件的局部replacement；必要的新模块/调用段落另列，不是全库可直接应用补丁。

```sh
# Reapply the same native initialization with rotated fixture passwords.
sed \
  -e 's/^SERVER_DB_PASSWORD=.*/SERVER_DB_PASSWORD=0000000000000000000000000000000000000000000000000000000000000006/' \
  -e 's/^SERVER_OBJECT_STORAGE_SECRET_ACCESS_KEY=.*/SERVER_OBJECT_STORAGE_SECRET_ACCESS_KEY=rotated-server-secret/' \
  -e 's/^WORKER_OBJECT_STORAGE_SECRET_ACCESS_KEY=.*/WORKER_OBJECT_STORAGE_SECRET_ACCESS_KEY=rotated-worker-secret/' \
  -e 's/^WORKER_DB_PASSWORD=.*/WORKER_DB_PASSWORD=0000000000000000000000000000000000000000000000000000000000000007/' \
  "$staging/env" > "$staging/rotated"
mv "$staging/rotated" "$staging/env"
compose run --rm -T migrate
compose run --rm -T storage-init
```

**不能改变的事实**：精确fixture值、rotation语义、native job顺序和retained PostgreSQL volume不变；不触碰production credentials。

**实施时的验证要求**：实施后sh -n与现有hash-locked shellcheck；后续隔离deployment-check.sh验证rotation。纯形状项不宣称新的功能修复。

**当前验证状态**：源body完整阅读，范围/hash静态核对。AFTER未实施、未编译、未类型检查、未功能验证；未运行Docker/VM/provider旅程。

<a id="f065"></a>

#### F065 — 停止进程的diagnostic应只采集成一个快照

- **优先级**：P3 / 可维护性。
- **适用置信度**：高（静态证据；拟议实现未验证）。
- **符号**：`private native process failure assertions`。

**现在（连续原文）** — [`tests/scripts/production-runtime.test.ts:228–236`](../tests/scripts/production-runtime.test.ts#L228)

```ts
        // The unchanged CMD must fail privately when native services are absent.
        assert.equal(docker('wait', id).trim(), '1')
        assert.match(logs(id), /Process stopped after failure/)
        assert.match(logs(id), new RegExp(`${service}-entrypoint`))
        assert.doesNotMatch(logs(id), /ECONNREFUSED|postgres:\/\/|redis:\/\//)
        assert.doesNotMatch(
          logs(id),
          /Cannot find|ModuleNotFound|ENOENT|Invalid environment/,
        )
```

##### F065：为什么不好

docker wait之后四次logs(id)各发一次CLI/timeout，但断言四个属性属于同一已结束进程。重复采集藏起同一证据对象并引入额外subprocess失败点；未声称性能瓶颈。

**Handover 实际对照** — [`apps/server/scripts/run-command.ts:36–47`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/scripts/run-command.ts#L36-L47)

reference capture将一次child stdout作为一个值。无native production-image诊断直接对应；比较的是同一证据的获取方式。

```ts
export function capture(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
  return result.stdout
}
```

##### F065：应该怎么改

wait后采集一次diagnostic，全部patterns原样作用于该值。保留logs helper错误检查与private rendering断言。

##### F065：改完之后的形状（拟议，未实施）

所列原文件的局部replacement；必要的新模块/调用段落另列，不是全库可直接应用补丁。

```ts
// The unchanged CMD must fail privately when native services are absent.
assert.equal(docker('wait', id).trim(), '1')
const diagnostic = logs(id)
assert.match(diagnostic, /Process stopped after failure/)
assert.match(diagnostic, new RegExp(`${service}-entrypoint`))
assert.doesNotMatch(diagnostic, /ECONNREFUSED|postgres:\/\/|redis:\/\//)
assert.doesNotMatch(
  diagnostic,
  /Cannot find|ModuleNotFound|ENOENT|Invalid environment/,
)
```

**不能改变的事实**：四类assertion、production CMD与finally cleanup不变；同一已结束container snapshot不是四次live观察。

**实施时的验证要求**：实施后formatter/typecheck；后续node --test tests/scripts/production-runtime.test.ts。静态核对patterns保留，本次未Docker。

**当前验证状态**：源body完整阅读，范围/hash静态核对。AFTER未实施、未编译、未类型检查、未功能验证；未运行Docker/VM/provider旅程。

<a id="f066"></a>

#### F066 — 本地工具模型只记住 request ordinal，不维护无人读取的完整请求历史

- **优先级**：P3 / fixture 状态与表达形状。
- **适用置信度**：高：requests 的唯一消费者是 length。
- **符号**：`toolModel`。

**现在（连续原文）** — [`tests/storage/assets.test.ts:413–479`](../tests/storage/assets.test.ts#L413)

```ts
function toolModel(assetPath: string, expected: string) {
  const requests: unknown[] = []
  let readResult: string | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: { role: string; tool_call_id?: string; content?: string }[]
      }
      requests.push(body)
      const turn = requests.length
      if (turn === 2) {
        const imported = body.messages.filter(
          (message) =>
            message.role === 'tool' && message.tool_call_id === 'local-tool-1',
        )
        expect(imported).toHaveLength(1)
        expect(imported[0]?.content).toBe(
          'Imported to /tmp/input.txt. Use tools to inspect; importing does not establish understanding.',
        )
      }
      if (turn === 3) {
        const read = body.messages.filter(
          (message) =>
            message.role === 'tool' && message.tool_call_id === 'local-tool-2',
        )
        expect(read).toHaveLength(1)
        expect(read[0]?.content).toBe(expected)
        readResult = read[0]!.content!
      }
      const tools = chosenTools(assetPath, readResult ?? '')
      const tool = tools[turn - 1]
      const delta =
        turn <= 4
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `local-tool-${turn}`,
                  type: 'function',
                  function: tool,
                },
              ],
            }
          : { role: 'assistant', content: 'Done' }
      const chunk = {
        id: 'local',
        object: 'chat.completion.chunk',
        model: 'local',
        choices: [
          { index: 0, delta, finish_reason: turn <= 4 ? 'tool_calls' : 'stop' },
        ],
      }
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  return {
    server,
    readResult: () => readResult,
    url: `http://127.0.0.1:${server.port}/v1`,
  }
}
```

##### F066：为什么不好

requests: unknown[] 每次保存含 messages 的完整 body，但后续只使用 requests.length，没有任何断言读取这份历史。它让读者以为 fixture 拥有请求回放或历史验证。与此同时 turn<=4 在 delta 与 finish_reason 重复编码工具列表长度，读者需要把列表与常数保持一致。只保留已发请求数和 readResult，再从本次实际选出的 tool 决定回复阶段；这是局部 state projection，不是新 fake-provider 框架。

**Handover 实际对照** — [`apps/server/src/server/avatar-api.spec.ts:8–21`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/avatar-api.spec.ts#L8-L21)

没有直接 OpenAI tool-model 对应。仅对比局部 fixture 状态按实际消费者保存：kept 被读取内容与 size，writes 单独计数，而不是保存全部 put 调用对象来求长度。本项目不改为内存对象存储。

```ts
function emptyBucket() {
  const kept = new Map<string, StoredObject>()
  let writes = 0
  const objects: ObjectStore = {
    find: async (key) => kept.get(key),
    put: async (key, object) => {
      writes += 1
      kept.set(key, object)
    },
    close: () => undefined,
  }

  return { objects, kept, writes: () => writes }
}
```

##### F066：应该怎么改

把 requests 换成 requestCount；保留第2/第3次请求中对 import/read 真实工具回传的断言。工具列表仍由 chosenTools 拥有；是否结束从选出的 tool 是否存在得出，不重复写 4。assetPath 实为 assetID，在这份完整函数替换里一并纠正语义。

##### F066：改完之后的形状（拟议，未实施）

```ts
function toolModel(assetID: string, expected: string) {
  let requestCount = 0
  let readResult: string | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: { role: string; tool_call_id?: string; content?: string }[]
      }
      const turn = ++requestCount

      if (turn === 2) {
        const imported = body.messages.filter(
          (message) =>
            message.role === 'tool' && message.tool_call_id === 'local-tool-1',
        )
        expect(imported).toHaveLength(1)
        expect(imported[0]?.content).toBe(
          'Imported to /tmp/input.txt. Use tools to inspect; importing does not establish understanding.',
        )
      }
      if (turn === 3) {
        const read = body.messages.filter(
          (message) =>
            message.role === 'tool' && message.tool_call_id === 'local-tool-2',
        )
        expect(read).toHaveLength(1)
        expect(read[0]?.content).toBe(expected)
        readResult = read[0]!.content!
      }

      const tool = chosenTools(assetID, readResult ?? '')[turn - 1]
      const delta =
        tool === undefined
          ? { role: 'assistant', content: 'Done' }
          : {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `local-tool-${turn}`,
                  type: 'function',
                  function: tool,
                },
              ],
            }
      const chunk = {
        id: 'local',
        object: 'chat.completion.chunk',
        model: 'local',
        choices: [
          {
            index: 0,
            delta,
            finish_reason: tool === undefined ? 'stop' : 'tool_calls',
          },
        ],
      }
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    },
  })

  return {
    server,
    readResult: () => readResult,
    url: `http://127.0.0.1:${server.port}/v1`,
  }
}
```

**不能改变的事实**：import -> read -> write -> export 四个实际工具调用及 local-tool ordinal 不变；readResult 来自真实 Pi tool response，不从 expected 伪造；保持 loopback/port0/SSE framing；原调用者 finally 仍等待 model.server.stop(true)，不替代 E2B 真实执行证据。

**实施时的验证要求**：未来通过真实 storage runner 运行 uploaded asset traverses actual worker execution and official Pi tools... case；确认四工具及最终 done 的五次模型请求、两处 tool response 断言和 downloadable bytes 仍成立。此处 local model fixture 不证明实际付费模型或 E2B。

**当前验证状态**：完整函数及调用方已读，确认 requests 没有除 length 外的消费者；源范围/hash 静态核对。AFTER 未编译/执行。

### 测试与工具链的表达

<a id="f067"></a>

#### F067 — budget fixture 的闭合场景应与实际 admission 政策一致

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`budgetResponses`。

**现在（连续原文）** — [`apps/agent/src/harness/pi.test.ts:1224–1287`](../apps/agent/src/harness/pi.test.ts#L1224)

```ts
function budgetResponses(scenario: string) {
  const call = (name: string, args: unknown) => calls([{ name, args }])
  switch (scenario) {
    case 'iterations':
      return [
        ...Array.from({ length: 17 }, () => call('read', { path: '/fixture' })),
        answer('unexpected'),
      ]
    case 'thinking':
      return [
        [
          {
            delta: {
              role: 'assistant',
              reasoning_content: 'x'.repeat(2 * 1024 * 1024 + 1),
            },
            finish_reason: null,
          },
          { delta: {}, finish_reason: 'stop' },
        ],
        answer('unexpected'),
      ]
    case 'arguments':
      return [
        call('read', { path: 'x'.repeat(2 * 1024 * 1024 + 1) }),
        answer('unexpected'),
      ]
    case 'batch':
      return [
        calls(
          Array.from({ length: 33 }, () => ({
            name: 'read',
            args: { path: '/fixture' },
          })),
        ),
        answer('unexpected'),
      ]
    case 'writes':
      return [
        ...Array.from({ length: 5 }, () =>
          call('write', { path: '/fixture', content: 'x'.repeat(256 * 1024) }),
        ),
        answer('unexpected'),
      ]
    case 'command':
      return [
        call('execute', { command: 'x'.repeat(16 * 1024 + 1) }),
        answer('unexpected'),
      ]
    case 'path':
      return [
        call('read', { path: 'x'.repeat(4 * 1024 + 1) }),
        answer('unexpected'),
      ]
    default:
      return [
        call('write', {
          path: '/fixture',
          content: 'é'.repeat(128 * 1024 + 1),
        }),
        answer('unexpected'),
      ]
  }
}
```

##### F067：为什么不好

唯一调用者的 const 场景列表是 iterations/thinking/arguments/write，但 fixture 还包含未使用 batch/writes/command/path 分支，default 隐式代表 write。读者可能误以为 33-tool batch 和累计 5 次写都是 production budget 保证；实际生产没有该 batch/cumulative-write admission。不是建议盲目开启这些 case 来制造失败，而是删除未宣称的政策影子。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F067：应该怎么改

参数用闭合 union，只保留实际四个预算 case，将 default 明确为 write case。command/path 是已有 TypeBox malformed-input 边界，保留其它既有测试，不将其混成 fatal budget。下面为完整函数。

##### F067：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
type BudgetScenario = 'iterations' | 'thinking' | 'arguments' | 'write'

function budgetResponses(scenario: BudgetScenario) {
  const call = (name: string, args: unknown) => calls([{ name, args }])
  switch (scenario) {
    case 'iterations':
      return [
        ...Array.from({ length: 17 }, () => call('read', { path: '/fixture' })),
        answer('unexpected'),
      ]
    case 'thinking':
      return [
        [
          {
            delta: {
              role: 'assistant',
              reasoning_content: 'x'.repeat(2 * 1024 * 1024 + 1),
            },
            finish_reason: null,
          },
          { delta: {}, finish_reason: 'stop' },
        ],
        answer('unexpected'),
      ]
    case 'arguments':
      return [
        call('read', { path: 'x'.repeat(2 * 1024 * 1024 + 1) }),
        answer('unexpected'),
      ]
    case 'write':
      return [
        call('write', {
          path: '/fixture',
          content: 'é'.repeat(128 * 1024 + 1),
        }),
        answer('unexpected'),
      ]
  }
}
```

**不能改变的事实**：16 iterations、2MiB decoded aggregate、256KiB UTF8 per-write 的实际边界和 no-subsequent-request 断言不变；不发明 cumulative write/batch cap；普通 malformed input 仍可让模型纠正。

**实施时的验证要求**：sh scripts/check.sh test apps/agent/src/harness/pi.test.ts；type check 全部 budgetResponses 调用者；保留对应四个 HTTP payload 场景，不把 SDK transport memory 误称 hard bound。Reference 无有用直接 analogue，因本项目必须限制 remote paid turn spending。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f068"></a>

#### F068 — WorkerProcess 的 shutdown promise 应有未完成 owned-task 回归

- **优先级**：P3 / 责任与表达可读性。
- **适用置信度**：高（静态判断）。
- **符号**：`WorkerProcess lifecycle regression`。

**现在（连续原文）** — [`apps/agent/src/worker.test.ts:5–43`](../apps/agent/src/worker.test.ts#L5)

```ts
test('worker installs one cleanup receipt before abort listeners can reenter close', async () => {
  // Real native owners, never connected or dispatched. No external request.
  const objects = connectObjects({
    endpoint: 'http://127.0.0.1:1',
    region: 'fixture',
    bucket: 'fixture',
    accessKeyID: 'fixture',
    secretAccessKey: 'fixture',
  })
  const worker = new WorkerProcess(
    {
      DATABASE_URL:
        'postgres://fixture:fixture@127.0.0.1:1/fixture?sslmode=disable',
      REDIS_URL: 'redis://127.0.0.1:1',
      IO_TIMEOUT_MS: 1000,
    },
    undefined,
    objects,
  )
  let reentrant: Promise<void> | undefined
  worker.signal.addEventListener(
    'abort',
    () => {
      reentrant = worker.close()
    },
    { once: true },
  )
  const closing = worker.close()
  try {
    expect(reentrant).toBe(closing)
    await closing
    expect(worker.close()).toBe(closing)
    await worker.stop()
    expect(worker.commands.isOpen).toBe(false)
    expect(worker.blockingReader.isOpen).toBe(false)
  } finally {
    await Promise.allSettled([closing, reentrant, worker.stop()])
  }
})
```

##### F068：为什么不好

现有测试很好地证明 reentrant close 是同一 receipt，但没有在 tasks 非空时验证 disconnectAfterTasks 真正先 await Promise.all(this.tasks) 再关闭 native owners。该行为承载 DB writes/tool cleanup drain，不是单纯仪式调用顺序；reference checking-in 会 settle 正在回答的内容，而本项目还需要 terminal/fence 结算。

**Handover 实际对照** — [`apps/cli/src/checking-in.ts:203–213`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/cli/src/checking-in.ts#L203-L213)

reference 停机先 await settle(answering,running)，保留最后写入；本项目的 owned promise 增加 SQL/SDK 未结算 drain，不能仅等待 local map 清空。

```ts
    await beginAnswering(api, reported.asking, answering, { ...running, until: stopping })
    await waitBeforeReportingAgain(running, reported, stopped, stopping)
  }

  // Stopping on purpose stops the agent too, and waits for the last of what it said to be written
  // down. A turn abandoned here would be one nobody can say the outcome of, and the measured
  // difference between asking an agent to stop and being killed is exactly that.
  await settle(answering, running)

  return { kind: 'asked-to-stop' }
}
```

##### F068：应该怎么改

保留原测试，在同文件增加下面无连接/无请求的真实 native owner 测试。使用现有 ObjectStore 能力的 close wrapper 观察资源结算开始；timer turn 确保 queued microtasks 已运行，owned task 人工 release 后才能出现 close。不要通过改 production visibility expose disconnect helper。

##### F068：改完之后的形状（拟议，未实施）

原owner内的拟议replacement。分开的signature/property/case按其描述在各自原上下文应用，不是可直接拼接的完整补丁。

```ts
test('worker close drains owned work before closing object storage', async () => {
  const objects = connectObjects({
    endpoint: 'http://127.0.0.1:1',
    region: 'fixture',
    bucket: 'fixture',
    accessKeyID: 'fixture',
    secretAccessKey: 'fixture',
  })
  const objectClosing = Promise.withResolvers<void>()
  const worker = new WorkerProcess(
    {
      DATABASE_URL:
        'postgres://fixture:fixture@127.0.0.1:1/fixture?sslmode=disable',
      REDIS_URL: 'redis://127.0.0.1:1',
      IO_TIMEOUT_MS: 1000,
    },
    undefined,
    {
      ...objects,
      close: () => {
        objectClosing.resolve()
        objects.close()
      },
    },
  )
  const task = Promise.withResolvers<void>()
  worker.own(task.promise)
  const closing = worker.close()
  try {
    const first = await Promise.race([
      objectClosing.promise.then(() => 'objects-closed' as const),
      Bun.sleep(0).then(() => 'still-draining' as const),
    ])
    expect(first).toBe('still-draining')
    task.resolve()
    await objectClosing.promise
    await closing
    await worker.stop()
  } finally {
    task.resolve()
    await Promise.allSettled([closing, worker.stop()])
  }
})
```

**不能改变的事实**：使用真实未连接数据库/Redis owners，无 paid API 或外部请求；closing 单 owner、任务错误 aggregate、停止 spending 后 drain 不变。

**实施时的验证要求**：sh scripts/check.sh test apps/agent/src/worker.test.ts；实施时暂将 await Promise.all(this.tasks) 删除，新增测试应失败，然后恢复做 red/green（审计未执行）。

**当前验证状态**：完整source body与参考实际范围已静态阅读/核对。AFTER未实施、未编译、未类型检查、未功能验证；无tests/provider旅程。

<a id="f069"></a>

#### F069 — upload 文档测试应核对全部 MIME，而不是只测一正一负

- **优先级**：P3 / 表达与测试可读性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`upload documentation test`。

**现在（连续原文）** — [`apps/server/src/http.test.ts:18–25`](../apps/server/src/http.test.ts#L18)

```ts
test('upload documentation only advertises media types accepted by the byte boundary', async () => {
  const spec = await generateSpecs(createRouter())
  const body = spec.paths['/api/threads/{threadID}/assets']?.post?.requestBody
  if (!body || !('content' in body))
    throw new Error('Missing upload body metadata')
  expect(body.content['text/plain']).toBeDefined()
  expect(body.content['application/octet-stream']).toBeUndefined()
})
```

##### F069：为什么不好

标题声称only advertises accepted media types，实际只查text/plain存在及octet-stream不存在；image/png漏文档、额外text/html或header enum漂移都不在assert范围。现有schema.options就是精确文档集合owner，可直接比完整keys，不重复byte signature测试。

**Handover 实际对照** — [`apps/server/src/server/route.ts:50–69`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/route.ts#L50-L69)

Actual takes/sends derive published media body metadata from schema. This proposal verifies our binary metadata adapter exhaustively without replacing it with their JSON-only DSL.

```ts
function takes<T extends z.ZodType>(schema: T) {
  return { content: { 'application/json': { schema } }, required: true }
}

/**
 * Answers a request this route could not parse in its own words.
 *
 * The app-wide answer is right nearly everywhere — a malformed body is the same thing at every
 * route. It is wrong exactly where the malformed thing is an identifier, because there the caller
 * has somewhere to go, and it is the same somewhere they are sent when the identifier is merely
 * one they may not have.
 */
function insteadOfMalformed<E extends Env>(failure: Failure) {
  return (result: { success: boolean }, c: Context<E>) =>
    result.success ? undefined : refused(c, failure)
}

export function sends<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } }
}
```

##### F069：应该怎么改

import uploadMimeTypeSchema，替换完整test，比较requestBody全部key和Content-Type enum，保留缺失metadata显式失败。

##### F069：改完之后的形状（拟议，未实施）

```ts
test('upload documentation advertises the entire declared MIME set and no extras', async () => {
  const spec = await generateSpecs(createRouter())
  const operation = spec.paths['/api/threads/{threadID}/assets']?.post
  const body = operation?.requestBody
  if (!body || !('content' in body))
    throw new Error('Missing upload body metadata')
  const expected = [...uploadMimeTypeSchema.options].sort()
  expect(Object.keys(body.content).sort()).toEqual(expected)
  const header = operation.parameters?.find(
    (parameter) =>
      'in' in parameter &&
      parameter.in === 'header' &&
      parameter.name === 'Content-Type',
  )
  if (
    !header ||
    !('schema' in header) ||
    !header.schema ||
    !('enum' in header.schema)
  )
    throw new Error('Missing upload Content-Type enum')
  expect([...(header.schema.enum ?? [])].sort()).toEqual(expected)
})
```

**不能改变的事实**：docrequestBody与Content-Typeenum都必须与原uploadMimeTypeSchema集合一致；测试不替代真实byte/signature或nativeFetch附件测试；离线generateSpecs不创建外部连接。

**实施时的验证要求**：sh scripts/check.sh test apps/server/src/http.test.ts; proposed test uncompiled, confirm generateSpecs parameters typing before implementation. Reference route.ts: takes/sends tie documentation to actual schema; no direct binary MIME analogue.

**当前验证状态**：Static evidence only; proposed AFTER is not implemented, compiled or run. No functional failure is claimed reproduced.

<a id="f070"></a>

#### F070 — 无需凭据的脚本回归应有同一个本地/CI入口

- **优先级**：P2 / 边界与验收。
- **适用置信度**：高（静态证据；拟议实现未验证）。
- **符号**：`check and test scripts`。

**现在（连续原文）** — [`package.json:11–17`](../package.json#L11)

```json
    "check": "bun run typecheck && bun run lint && bun run fmt:check && bun run boundaries && bun run test",
    "test": "bun test apps packages",
    "test:integration": "bun test tests/integration",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint --type-aware --deny-warnings apps packages tests scripts deploy",
    "fmt:check": "prettier --check . '!**/generated/**' --ignore-path .gitignore",
    "boundaries": "depcruise --config .dependency-cruiser.cjs apps packages && bun test tests/scripts/architecture.test.ts"
```

##### F070：为什么不好

本地check只执行bun test apps packages，CI另列六个无需凭据的script regressions。本地标准入口因此可漏掉参数准入、private diagnostics、deadline与offline generation；basic suite事实由两处列表维护。

**Handover 实际对照** — [`.github/workflows/check.yml:24–26`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/.github/workflows/check.yml#L24-L26)

reference CI将basic检查交给pnpm check，不维护另一份basic test列表。它的check包含数据库工作，不复制进本项目credentialless分区。

```yaml
      # Use the local compose file, so CI proves the same checkout.
      - run: pnpm db:up
      - run: pnpm check
```

##### F070：应该怎么改

新增单一test:scripts脚本，让test调用它，再删CI的重复独立调用。禁止glob全部tests/scripts；native deployment/storage等仍归integration。

##### F070：改完之后的形状（拟议，未实施）

package.json scripts对象内这两项属性；只展示改动子集，不替换整个package。

```json
{
  "test": "bun test apps packages && bun run test:scripts",
  "test:scripts": "bun test tests/scripts/ci-policy.test.ts tests/scripts/database-project.test.ts tests/scripts/proxy-deadline.test.ts tests/scripts/reconciliation-cli.test.ts tests/scripts/process-diagnostics.test.ts scripts/generate-api.test.ts"
}
```

ci.yaml现有basic检查run block的完整命令正文；去掉重复six-test调用，保留其他native/readonly验证。

```sh
set -euo pipefail
mkdir -p ci-logs
{
  sh .github/python/check.sh
  sh scripts/check.sh
  sh scripts/check.sh run .github/verify-api.ts
} 2>&1 | tee ci-logs/check.log
```

**不能改变的事实**：architecture仍归boundaries；basic不进入native DB/Docker/付费旅程，显式分区不合并所有测试。

**实施时的验证要求**：实施后运行sh scripts/check.sh，确认六项在CI basic各运行一次，native probes仍由独立runner负责。

**当前验证状态**：源body完整阅读，范围/hash静态核对。AFTER未实施、未编译、未类型检查、未功能验证；未运行Docker/VM/provider旅程。

<a id="f071"></a>

#### F071 — native/foreign 一致性断言需要独立的预期真值

- **优先级**：P3 / 表达与测试可读性。
- **适用置信度**：高（静态判断；不代表动态复现）。
- **符号**：`command samples and differential loop`。

**现在（连续原文）** — [`packages/contract/src/execution-schema.test.ts:34–68`](../packages/contract/src/execution-schema.test.ts#L34)

```ts
  const samples = [
    start,
    { ...start, version: 2 },
    { ...start, input: { ...start.input, text: ' \n\t\uFEFF' } },
    { ...start, input: { ...start.input, text: '', assets: [reference] } },
    { ...start, input: { ...start.input, text: '', assets: [] } },
    {
      ...start,
      input: {
        ...start.input,
        assets: [{ ...reference, name: '../source.txt' }],
      },
    },
    {
      ...start,
      input: { ...start.input, assets: [{ ...reference, name: '.' }] },
    },
    {
      ...start,
      input: {
        ...start.input,
        assets: [{ ...reference, name: 'bad\u0000name' }],
      },
    },
    { ...start, privateHistory: [] },
    {
      version: 1,
      kind: 'cancel',
      commandID: identity.toUpperCase(),
      threadID: identity,
      runID: identity,
    },
  ]
  for (const value of samples)
    expect(command(value)).toBe(executionCommandSchema.safeParse(value).success)
```

##### F071：为什么不好

samples只比较Ajv result与Zod safeParse.success；若两个schema一起放宽version/privateHistory/nonblank，测试仍绿。现有后续filename loop已经独立assert false，说明此处也能用明确预期而不用新测试框架。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F071：应该怎么改

保留differential价值，但samples每行带true/false；两个validator分别等于预期。AFTER完整替换samples和loop，delivery三行同理可随后用该形式，算一个oracle改进而非多个数量。

##### F071：改完之后的形状（拟议，未实施）

```ts
const samples = [
  [start, true],
  [{ ...start, version: 2 }, false],
  [{ ...start, input: { ...start.input, text: ' \n\t\uFEFF' } }, false],
  [
    { ...start, input: { ...start.input, text: '', assets: [reference] } },
    true,
  ],
  [{ ...start, input: { ...start.input, text: '', assets: [] } }, false],
  [
    {
      ...start,
      input: {
        ...start.input,
        assets: [{ ...reference, name: '../source.txt' }],
      },
    },
    false,
  ],
  [
    {
      ...start,
      input: { ...start.input, assets: [{ ...reference, name: '.' }] },
    },
    false,
  ],
  [
    {
      ...start,
      input: {
        ...start.input,
        assets: [{ ...reference, name: 'bad\u0000name' }],
      },
    },
    false,
  ],
  [{ ...start, privateHistory: [] }, false],
  [
    {
      version: 1,
      kind: 'cancel',
      commandID: identity.toUpperCase(),
      threadID: identity,
      runID: identity,
    },
    true,
  ],
] as const
for (const [value, valid] of samples) {
  expect(executionCommandSchema.safeParse(value).success).toBe(valid)
  expect(command(value)).toBe(valid)
}
```

**不能改变的事实**：保留Ajv对exported2020-12schema与nativeZod的差分比较；再补独立booleanoracle，不替代长度/空白/资产/版本/未知extra覆盖。维护有意nativeUTF16与foreigncode-point差异，不要求两者无条件一样。

**实施时的验证要求**：sh scripts/check.sh test packages/contract/src/execution-schema.test.ts; add delivery ordinal1=true, ordinal0=false and privateHistory=false independent oracle. No direct native-vs-exported JSON Schema test analogue in reference; reference null.

**当前验证状态**：Static evidence only; proposed AFTER is not implemented, compiled or run. No functional failure is claimed reproduced.

<a id="f072"></a>

#### F072 — native PUT测试需钉住immutable条件、metadata与单次尝试

- **优先级**：P2 / 边界与验收。
- **适用置信度**：高（静态证据；拟议实现未验证）。
- **符号**：`native S3 GET-only adapter coverage`。

**现在（连续原文）** — [`packages/object-storage/src/objects.test.ts:30–72`](../packages/object-storage/src/objects.test.ts#L30)

```ts
test('native S3 GET bounds both declared and chunked HTTP bodies', async () => {
  const bytes = new Uint8Array([0, 255, 128, 10])
  let chunked = false
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        chunked
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.slice(0, 2))
                controller.enqueue(bytes.slice(2))
                controller.close()
              },
            })
          : bytes,
      ),
  })
  const objects = connectObjects({
    endpoint: server.url.toString(),
    region: 'us-east-1',
    bucket: 'binary-test',
    accessKeyID: 'fixture',
    secretAccessKey: 'fixture-secret',
  })
  try {
    for (chunked of [false, true]) {
      expect(
        await objects.read('owned-key', 4, AbortSignal.timeout(5000)),
      ).toEqual(bytes)
      const failure = await objects
        .read('owned-key', 3, AbortSignal.timeout(5000))
        .catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(Error)
      expect(failure instanceof Error && failure.message).toBe(
        'Object byte limit exceeded',
      )
    }
  } finally {
    objects.close()
    await server.stop(true)
  }
})
```

##### F072：为什么不好

对象adapter目前邻接tests只覆盖bounded GET。高层asset测试不能直接证明官方SDK请求带IfNoneMatch:*、sha256 metadata，或maxAttempts:1在可重试HTTP错误下仍不重发。这是缺少独立wire证据，不是已证明当前覆盖失败。

**Handover 实际对照** — [`apps/server/src/object-store.spec.ts:11–25`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/object-store.spec.ts#L11-L25)

reference在object edge直接验证put/read；其avatar overwrite合同不同。不能把deterministic avatar覆盖移植为本项目assigned immutable asset的行为。

```ts
describe('the S3-compatible object boundary', () => {
  it('writes bytes that a later read gets back with their media type', async () => {
    // One fixed key keeps repeated test runs from turning the local bucket into a growing log.
    const key = 'checks/object-store.txt'
    const written = {
      bytes: new TextEncoder().encode('the bucket answered'),
      contentType: 'text/plain',
    }

    await objects.put(key, written)
    const found = await objects.find(key)

    expect(found?.contentType).toBe(written.contentType)
    expect(new TextDecoder().decode(found?.bytes)).toBe('the bucket answered')
  })
```

##### F072：应该怎么改

新增credentialless loopback接收真实SDK PUT，检验condition/content-type/digest。第二次返回503 ServiceUnavailable以触发原生可重试错误类别；412通常本就不可重试，不能用它证明maxAttempts:1。真实远端conditional durability仍归native storage验收。

##### F072：改完之后的形状（拟议，未实施）

所列原文件的局部replacement；必要的新模块/调用段落另列，不是全库可直接应用补丁。

```ts
test('native S3 PUT sends the immutable-key condition and never retries a rejected write', async () => {
  const requests: Request[] = []
  let reject = false
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(request)
      await request.arrayBuffer()
      if (reject) {
        return new Response(
          '<Error><Code>ServiceUnavailable</Code><Message>Fixture transient failure</Message></Error>',
          { status: 503, headers: { 'content-type': 'application/xml' } },
        )
      }
      return new Response(null, { status: 200 })
    },
  })
  const objects = connectObjects({
    endpoint: server.url.toString(),
    region: 'us-east-1',
    bucket: 'binary-test',
    accessKeyID: 'fixture',
    secretAccessKey: 'fixture-secret',
  })
  const bytes = new Uint8Array([0, 255, 128])
  try {
    expect(
      await objects.put(
        'assigned-key',
        bytes,
        'application/octet-stream',
        AbortSignal.timeout(5000),
      ),
    ).toEqual({ byteLength: 3, sha256: sha256(bytes) })
    expect(requests[0]?.method).toBe('PUT')
    expect(requests[0]?.headers.get('if-none-match')).toBe('*')
    expect(requests[0]?.headers.get('x-amz-meta-sha256')).toBe(sha256(bytes))
    expect(requests[0]?.headers.get('content-type')).toBe(
      'application/octet-stream',
    )
    reject = true
    const failure = await objects
      .put(
        'assigned-key',
        bytes,
        'application/octet-stream',
        AbortSignal.timeout(5000),
      )
      .catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect(requests).toHaveLength(2)
  } finally {
    objects.close()
    await server.stop(true)
  }
})
```

**不能改变的事实**：不改production adapter、不fallback覆盖、不换identity重试、无provider调用。loopback不是S3持久性或退款证明。

**实施时的验证要求**：实施后运行sh scripts/check.sh test packages/object-storage/src/objects.test.ts；反向临时把maxAttempts改大，503场景应观察额外请求。真实conditional PUT支持另跑隔离storage部署检查。

**当前验证状态**：源body完整阅读，范围/hash静态核对。AFTER未实施、未编译、未类型检查、未功能验证；未运行Docker/VM/provider旅程。

<a id="f073"></a>

#### F073 — 第二个 administrative child 与第一个一样由 test owner 设 watchdog 并 join

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`administrative cleanup retains the primary rejection after closing the actual database`。

**现在（连续原文）** — [`tests/integration/administration.test.ts:72–113`](../tests/integration/administration.test.ts#L72)

```ts
test('administrative cleanup retains the primary rejection after closing the actual database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vid-administration-'))
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  try {
    const input = join(directory, 'assignments.json')
    await Bun.write(
      input,
      JSON.stringify([
        { legacyOwnerID: 'not-a-retained-owner', userID: 'unknown-user' },
      ]),
    )
    // Inject only an additional close failure: the native pool still closes.
    const preload = join(directory, 'close-fault.ts')
    await Bun.write(
      preload,
      `import { Kysely } from ${JSON.stringify(import.meta.resolve('kysely'))};\nconst close = Kysely.prototype.destroy;\nKysely.prototype.destroy = async function () { await close.call(this); throw new Error('fixture-owned-close-failure'); };\n`,
    )
    child = Bun.spawn(['bun', '--preload', preload, script, input], {
      env: {
        ...process.env,
        DATABASE_URL: readMigrationEnv().DATABASE_URL,
        IO_TIMEOUT_MS: '1000',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    expect(await child.exited).not.toBe(0)
    expect(await stdout).toBe('')
    const diagnostic = await stderr
    expect(diagnostic).toContain('unknown legacy owner')
    expect(diagnostic).toContain('fixture-owned-close-failure')
  } finally {
    if (child !== undefined) {
      child.kill()
      await child.exited
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 10000)
```

##### F073：为什么不好

第一 test 给 child 3500ms kill watchdog并断言不是 forced；第二个在 await child.exited 前没有自有 deadline。Bun test 10000 timeout 是 runner failure budget，不是子进程关闭 capability。注入 destroy 故障正涉及 exit lifecycle，若回归为挂起，owner 没有按相同方式主动终结 child。

**Handover 实际对照** — [`apps/server/src/db/notifications.spec.ts:55–89`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/notifications.spec.ts#L55-L89)

参考 test 的 native listener stop 在 finally，与本 test own child 的主动终结和 join对应；没有 direct administrative child business analogue。

```ts
    let came = 0
    const listening = listenOn({
      env,
      log: silent,
      channel: CHANNEL,
      heard: (payload) => heard.push(payload),
      again: () => {
        came += 1
      },
    })

    try {
      await listening.listening
      await sql`select pg_notify(${CHANNEL}, 'first')`.execute(db)
      await until(() => heard.length === 1)
      expect(heard).toEqual(['first'])

      // What a database restart does to it, done on purpose.
      const [pid] = await listeners()
      expect(pid).toBeDefined()
      await sql`select pg_terminate_backend(${pid})`.execute(db)

      // Nothing sent in the gap can be replayed, so what is asked is that it is listening again
      // and that it said so — which is the only reason anybody can go and look.
      await until(() => came === 1)
      expect(came).toBe(1)

      await sql`select pg_notify(${CHANNEL}, 'second')`.execute(db)
      await until(() => heard.length === 2)

      expect(heard).toEqual(['first', 'second'])
    } finally {
      await listening.stop()
    }
  })
```

##### F073：应该怎么改

复用同文件已存在的 watchdog 形状，不抽通用 subprocess runner：启动后注册 timer，exited 后断言 forced=false，finally clear timer、kill/join及 rm。stdout/stderr仍立即开始 drain。 与TP08有政策交互：本项解决child ownership，不决定CLI是否公开native causes；采纳固定CLI输出后，双原因检查应移到trusted exported API，child只检查固定输出/exit/cleanup。

##### F073：改完之后的形状（拟议，未实施）

完整替换现有第二个administration test。保留当前CLI诊断政策时适用；若采纳TP08，诊断断言必须与之一起调整，不能直接叠加两项AFTER。

```ts
test('administrative cleanup retains the primary rejection after closing the actual database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vid-administration-'))
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let forced = false
  try {
    const input = join(directory, 'assignments.json')
    await Bun.write(
      input,
      JSON.stringify([
        { legacyOwnerID: 'not-a-retained-owner', userID: 'unknown-user' },
      ]),
    )
    // Inject only an additional close failure: the native pool still closes.
    const preload = join(directory, 'close-fault.ts')
    await Bun.write(
      preload,
      `import { Kysely } from ${JSON.stringify(import.meta.resolve('kysely'))};\nconst close = Kysely.prototype.destroy;\nKysely.prototype.destroy = async function () { await close.call(this); throw new Error('fixture-owned-close-failure'); };\n`,
    )
    child = Bun.spawn(['bun', '--preload', preload, script, input], {
      env: {
        ...process.env,
        DATABASE_URL: readMigrationEnv().DATABASE_URL,
        IO_TIMEOUT_MS: '1000',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const owned = child
    deadline = setTimeout(() => {
      forced = true
      owned.kill()
    }, 3500)
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    expect(await child.exited).not.toBe(0)
    expect(forced).toBe(false)
    expect(await stdout).toBe('')
    const diagnostic = await stderr
    expect(diagnostic).toContain('unknown legacy owner')
    expect(diagnostic).toContain('fixture-owned-close-failure')
  } finally {
    if (deadline !== undefined) clearTimeout(deadline)
    if (child !== undefined) {
      child.kill()
      await child.exited
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 10000)
```

**不能改变的事实**：保留 actual database close + injected additional close failure、unknown legacy owner primary diagnostic、双 cause evidence；不调用 paid provider、不改变脚本生产行为。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/administration.test.ts。聚焦回归要求：Introduce a test-only child that never exits after destroy rejection; watchdog should kill/join and explicitly fail forced=false without leaving the child alive. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f074"></a>

#### F074 — 迁移命令断言先证明 outbox/inbox 两份记录都保留，再检查独立 wire 形状

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`asset migration: command_outbox and command_inbox assertions`。

**现在（连续原文）** — [`tests/integration/assets-migration.test.ts:244–259`](../tests/integration/assets-migration.test.ts#L244)

```ts
    const { materialID, ...reference } = file
    for (const row of commands.rows) {
      const command = executionCommandSchema.parse(row.command)
      expect(command).toEqual({
        version: 1,
        kind: 'start',
        commandID: ids.command,
        threadID: ids.thread,
        runID: ids.run,
        input: {
          messageID: ids.message,
          text: 'Historical input',
          assets: [{ assetID: materialID, ...reference }],
        },
      })
    }
```

##### F074：为什么不好

UNION ALL 查询两份持久命令后仅遍历 rows；零行时循环完全不执行，一行时也通过，所以 test 名承诺的两份 accepted inputs 没有 cardinality 证据。当前 expected 通过旧 file 的 materialID/rest spread 得到，并先 parse actual，读者要推导 rename 才知道迁移输出的全部字段。executionCommandSchema 实际是 strict current schema，能拒绝 legacy aliases/未知字段，不应误称会接受 materials；但 UUID parse 会 canonicalize case，raw output assertion与消费者 acceptance仍是两种证据。

**Handover 实际对照** — [`apps/server/src/db/sign-in.spec.ts:99–111`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/sign-in.spec.ts#L99-L111)

参考实际 sign-in test 直接从 credentials 查询 kind/subject 对比显式 expected，然后独立断言 sessions 数量，避免把 persistence correctness仅归给返回转换。

```ts
describe('signing in with a code', () => {
  it('creates the account on the first correct code, and a session with it', async () => {
    const result = await submit(await sendCode())

    expect(result.kind).toBe('signed-in')
    const keys = await db
      .selectFrom('credentials')
      .select(['kind', 'subject'])
      .where('subject', 'like', `%${RUN}%`)
      .execute()
    expect(keys).toEqual([{ kind: 'email', subject: EMAIL }])
    expect(await sessions()).toBe(1)
  })
```

##### F074：应该怎么改

保留 UNION ALL 查询，先断言两行。raw row.command 直接等于显式 assets 新协议对象，再独立 safeParse 验证可消费。故意重写 expected fields 不复用 migration transformation；IDs 仍来自固定 identity fixture，属于输入事实不是被测转换。

##### F074：改完之后的形状（拟议，未实施）

在所列原文件的同一词法上下文替换此局部段落；它不是可单独编译的完整模块。

```ts
expect(commands.rows).toHaveLength(2)
for (const row of commands.rows) {
  expect(row.command).toEqual({
    version: 1,
    kind: 'start',
    commandID: ids.command,
    threadID: ids.thread,
    runID: ids.run,
    input: {
      messageID: ids.message,
      text: 'Historical input',
      assets: [
        {
          assetID: ids.asset,
          name: 'source.txt',
          mimeType: 'text/plain',
          byteLength: 3,
          sha256: 'a'.repeat(64),
          objectKey: `materials/${ids.thread}/${ids.asset}`,
        },
      ],
    },
  })
  expect(executionCommandSchema.safeParse(row.command).success).toBe(true)
}
```

**不能改变的事实**：ready/pending files、old immutable key、link position、accepted exact input 两份持久记录均保持；不修改历史 migration、不 mock dbmate。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/assets-migration.test.ts。聚焦回归要求：Delete one migrated command_inbox row: the row-count assertion must fail. Persist an uppercase UUID where this lowercase-source fixture expects unchanged lowercase JSON: raw equality must fail even if current strict schema canonicalizes it. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f075"></a>

#### F075 — 清理序列复用现有 settleTestCleanup，而不是首个 DELETE 失败就跳过余项

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`afterAll cleanup`。

**现在（连续原文）** — [`tests/integration/database.test.ts:6–24`](../tests/integration/database.test.ts#L6)

```ts
afterAll(async () => {
  try {
    if (threadIDs.length === 0) return
    await db
      .deleteFrom('product.command_outbox')
      .where('thread_id', 'in', threadIDs)
      .execute()
    await db
      .deleteFrom('product.messages')
      .where('thread_id', 'in', threadIDs)
      .execute()
    await db
      .deleteFrom('product.threads')
      .where('thread_id', 'in', threadIDs)
      .execute()
  } finally {
    await close()
  }
})
```

##### F075：为什么不好

此 hook 的 try/finally 只保证 pool destroy；第一个 DELETE 失败后 messages/threads 的删除均不再尝试。相同 fail-fast 链在 command-publication、execution-events、public-sources 等套件重复；fixture-ownership 已专门证明 sibling cleanup 应继续。不是要求忽略外键错误，而是保留所有失败并尝试所有具名 owned cleanup。

**Handover 实际对照** — [`apps/server/src/db/notifications.spec.ts:55–89`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/notifications.spec.ts#L55-L89)

参考实际 try/finally 由创建 listener 的 test 调用 listening.stop；本项目已有更强的多资源聚合 helper，因此不照搬参考单资源串行清理。

```ts
    let came = 0
    const listening = listenOn({
      env,
      log: silent,
      channel: CHANNEL,
      heard: (payload) => heard.push(payload),
      again: () => {
        came += 1
      },
    })

    try {
      await listening.listening
      await sql`select pg_notify(${CHANNEL}, 'first')`.execute(db)
      await until(() => heard.length === 1)
      expect(heard).toEqual(['first'])

      // What a database restart does to it, done on purpose.
      const [pid] = await listeners()
      expect(pid).toBeDefined()
      await sql`select pg_terminate_backend(${pid})`.execute(db)

      // Nothing sent in the gap can be replayed, so what is asked is that it is listening again
      // and that it said so — which is the only reason anybody can go and look.
      await until(() => came === 1)
      expect(came).toBe(1)

      await sql`select pg_notify(${CHANNEL}, 'second')`.execute(db)
      await until(() => heard.length === 2)

      expect(heard).toEqual(['first', 'second'])
    } finally {
      await listening.stop()
    }
  })
```

##### F075：应该怎么改

从 ./database-fixture 增加 settleTestCleanup import。按已存在的 FK 删除顺序生成固定表回调；close 是最后一项。其他同构套件采用其自己的表清单，不能混入全库删除。只计一个共享 lifecycle 改进点。

##### F075：改完之后的形状（拟议，未实施）

替换 afterAll hook；新增现有 settleTestCleanup 的 named import。表名、threadIDs与close仍是该文件现有绑定。

```ts
afterAll(async () => {
  await settleTestCleanup([
    ...(
      ['product.command_outbox', 'product.messages', 'product.threads'] as const
    ).map((table) => async () => {
      if (!threadIDs.length) return
      await db.deleteFrom(table).where('thread_id', 'in', threadIDs).execute()
    }),
    close,
  ])
})
```

**不能改变的事实**：只删除本套件 threadIDs；保持真实 SQL、FK 顺序和错误聚合；不吞失败，不将 cleanup 改为 mocks。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/database.test.ts。聚焦回归要求：Extend tests/integration/fixture-ownership.test.ts with a first DELETE failure and proof that later deletion callbacks plus close were attempted. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f076"></a>

#### F076 — fixture 的 abort 等待需与同文件 late-quarantine 场景一样处理已发生的 abort

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`fixture aborted waiter`。

**现在（连续原文）** — [`tests/integration/execute-run.test.ts:136–140`](../tests/integration/execute-run.test.ts#L136)

```ts
  const input = await started.promise
  const aborted = deferred<void>()
  input.signal.addEventListener('abort', () => aborted.resolve(), {
    once: true,
  })
```

##### F076：为什么不好

fixture 在 await started.promise 之后才注册 listener；abort 是一次性 event，若在该 await 恢复前已触发，cancel() 后续等待 aborted.promise 没有补偿读取。同文件 late old-fence 测试已在相同 listener 后使用 if (input.signal.aborted) resolve，是可复用的正确本地模式。

**Handover 实际对照** — [`apps/server/src/db/notifications.spec.ts:64–66`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/notifications.spec.ts#L64-L66)

参考先等待 readiness 再发送测试事件，说明 test 必须区分准备与事件发生；没有直接 AbortSignal business analogue，本项目同文件约 408–414 行是更直接实现参照。

```ts
    })

    try {
```

##### F076：应该怎么改

直接补一条 aborted 状态检查，不抽全局 abort framework，也不改 production cancellation。deferred resolve 本身幂等，listener/状态双路径安全。

##### F076：改完之后的形状（拟议，未实施）

在所列原文件的同一词法上下文替换此局部段落；它不是可单独编译的完整模块。

```ts
const input = await started.promise
const aborted = deferred<void>()
input.signal.addEventListener('abort', () => aborted.resolve(), {
  once: true,
})
if (input.signal.aborted) aborted.resolve()
```

**不能改变的事实**：保留 durable cancellation、真实 renew polling、issued turn settlement 与 fence；不把 abort 当作远端暂停成功。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/execute-run.test.ts。聚焦回归要求：Focused fixture regression: abort between started resolution and waiter installation, then ensure cancellation waiter resolves without a timeout. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f077"></a>

#### F077 — 失去 fence 的慢 cleanup 测试必须在 assertion 失败后也释放 sandbox gate

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`true fence loss during cleanup excludes text, history and terminal writes`。

**现在（连续原文）** — [`tests/integration/execute-run.test.ts:282–316`](../tests/integration/execute-run.test.ts#L282)

```ts
test('true fence loss during cleanup excludes text, history and terminal writes', async () => {
  const f = await fixture()
  await f.cancel()
  f.end.resolve()
  await f.closing.promise
  await db
    .updateTable('execution.conversations')
    .set({ fence: sql`fence + 1` })
    .where('thread_id', '=', f.lease.threadID)
    .execute()
  expect(await renewExecutionLease(db, f.lease, f.leaseMs)).toBe('lost')
  expect(await appendExecutionText(db, f.lease, 'stale')).toBe(false)
  expect(
    await completeExecutionRun(db, f.lease, {
      text: 'stale',
      history: ['stale'],
    }),
  ).toBe(false)
  expect(await failExecutionRun(db, f.lease, 'execution-error')).toBe(false)
  expect(await cancelExecutionRun(db, f.lease)).toBe(false)
  f.closed.resolve()
  expect(await f.run).toBe('lost')
  const state = await f.snapshot()
  expect(state.events.map((event) => event.kind)).toEqual(['run-started'])
  expect(state.conversation.history).toEqual([])
  // Release only this deliberately fenced fixture, not another worker's rows.
  await db
    .updateTable('execution.conversations')
    .set({ lease_until: sql`clock_timestamp() - interval '1 second'` })
    .where('thread_id', '=', f.lease.threadID)
    .execute()
  expect(
    await claimExecutionRun(db, { ownerID: 'reaper', leaseMs: f.leaseMs }),
  ).toBeNull()
})
```

##### F077：为什么不好

此 test 在 f.closing.promise 后连续执行五个 fenced assertions，再才 resolve f.closed。任何 SQL/assertion failure 会留下 executeRun 正等待人为挂起的 close，且 renew 循环仍可能运行。相邻 reason matrix 已有 finally 释放 end/closed 并 join run，当前孤立场景没有。

**Handover 实际对照** — [`apps/server/src/db/notifications.spec.ts:55–89`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/notifications.spec.ts#L55-L89)

参考真实 connection-loss test 的 finally 总会 stop listening；对应本项目慢 pause owner 的非正常 test exit。

```ts
    let came = 0
    const listening = listenOn({
      env,
      log: silent,
      channel: CHANNEL,
      heard: (payload) => heard.push(payload),
      again: () => {
        came += 1
      },
    })

    try {
      await listening.listening
      await sql`select pg_notify(${CHANNEL}, 'first')`.execute(db)
      await until(() => heard.length === 1)
      expect(heard).toEqual(['first'])

      // What a database restart does to it, done on purpose.
      const [pid] = await listeners()
      expect(pid).toBeDefined()
      await sql`select pg_terminate_backend(${pid})`.execute(db)

      // Nothing sent in the gap can be replayed, so what is asked is that it is listening again
      // and that it said so — which is the only reason anybody can go and look.
      await until(() => came === 1)
      expect(came).toBe(1)

      await sql`select pg_notify(${CHANNEL}, 'second')`.execute(db)
      await until(() => heard.length === 2)

      expect(heard).toEqual(['first', 'second'])
    } finally {
      await listening.stop()
    }
  })
```

##### F077：应该怎么改

把 mutation 与 stale-write assertions 放进 try；finally resolve 两个 gate 并 await run。后续 lost result、events/history 和精确 fixture lease expiry/reaper assertions仍保留。

##### F077：改完之后的形状（拟议，未实施）

在所列原文件的同一词法上下文替换此局部段落；它不是可单独编译的完整模块。

```ts
test('true fence loss during cleanup excludes text, history and terminal writes', async () => {
  const f = await fixture()
  let failed = false
  let primary: unknown
  try {
    await f.cancel()
    f.end.resolve()
    await f.closing.promise
    await db
      .updateTable('execution.conversations')
      .set({ fence: sql`fence + 1` })
      .where('thread_id', '=', f.lease.threadID)
      .execute()
    expect(await renewExecutionLease(db, f.lease, f.leaseMs)).toBe('lost')
    expect(await appendExecutionText(db, f.lease, 'stale')).toBe(false)
    expect(
      await completeExecutionRun(db, f.lease, {
        text: 'stale',
        history: ['stale'],
      }),
    ).toBe(false)
    expect(await failExecutionRun(db, f.lease, 'execution-error')).toBe(false)
    expect(await cancelExecutionRun(db, f.lease)).toBe(false)
  } catch (cause) {
    failed = true
    primary = cause
  } finally {
    f.end.resolve()
    f.closed.resolve()
    try {
      await f.run
    } catch (cleanup) {
      if (failed)
        throw new AggregateError(
          [primary, cleanup],
          'Fenced fixture settlement failed',
        )
      throw cleanup
    }
  }
  if (failed) throw primary
  expect(await f.run).toBe('lost')
  const state = await f.snapshot()
  expect(state.events.map((event) => event.kind)).toEqual(['run-started'])
  expect(state.conversation.history).toEqual([])
  // Release only this deliberately fenced fixture, not another worker's rows.
  await db
    .updateTable('execution.conversations')
    .set({ lease_until: sql`clock_timestamp() - interval '1 second'` })
    .where('thread_id', '=', f.lease.threadID)
    .execute()
  expect(
    await claimExecutionRun(db, { ownerID: 'reaper', leaseMs: f.leaseMs }),
  ).toBeNull()
})
```

**不能改变的事实**：不减少 stale append/complete/fail/cancel/renew 覆盖；只释放本 fixture，不修改新 worker 权威；owned execution 完全 settled 后结束 test。 primary assertion/SQL failure与run settlement failure同时发生时保留两个原因。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/execute-run.test.ts。聚焦回归要求：Intentionally make one stale-write assertion fail; verify no executeRun/poll loop survives teardown, then restore assertion. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f078"></a>

#### F078 — canonical inbox 的 oracle 不再对 actual 与 expected 同时运行被测 parser

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`typed asset replay normalizes property order and UUID case but preserves exact facts: persisted command`。

**现在（连续原文）** — [`tests/integration/execution-store.test.ts:861–861`](../tests/integration/execution-store.test.ts#L861)

```ts
    expect(startCommandSchema.parse(row.command)).toEqual(parsed)
```

##### F078：为什么不好

此“typed asset replay normalizes property order and UUID case”test 的 parsed 来自 startCommandSchema.parse(command)，最后又 parse(row.command) 与它比较。parser 若 UUID normalization 错误，两边可同错；若 SQL 保存非 canonical UUID casing，parse actual 会掩盖存储形状。replay 和 conflict tests仍有价值，但不能单独证明 canonical stored facts。

**Handover 实际对照** — [`apps/server/src/db/sign-in.spec.ts:99–111`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/sign-in.spec.ts#L99-L111)

参考 DB test 直接比较 credentials 查询 raw columns 与独立 kind/email input；本项目需要另外保护 JSON canonicalization，不能只比较 parser 的另一个输出。

```ts
describe('signing in with a code', () => {
  it('creates the account on the first correct code, and a session with it', async () => {
    const result = await submit(await sendCode())

    expect(result.kind).toBe('signed-in')
    const keys = await db
      .selectFrom('credentials')
      .select(['kind', 'subject'])
      .where('subject', 'like', `%${RUN}%`)
      .execute()
    expect(keys).toEqual([{ kind: 'email', subject: EMAIL }])
    expect(await sessions()).toBe(1)
  })
```

##### F078：应该怎么改

只增强最后 persistence assertion：用原 lowercase base IDs 和显式 lowercase asset IDs 形成 expected，先断言 raw JSON 再断言 parsed。继续保留此前 parsed replay调用，它测试公开 API 接受 typed normalized input，与 oracle 责任不同。

##### F078：改完之后的形状（拟议，未实施）

在所列原文件的同一词法上下文替换此局部段落；它不是可单独编译的完整模块。

```ts
const expected: StartCommand = {
  version: 1,
  kind: 'start',
  commandID: base.commandID,
  threadID: base.threadID,
  runID: base.runID,
  input: {
    messageID: base.input.messageID,
    text: ' exact text ',
    assets: [
      { ...first, assetID: first.assetID.toLowerCase() },
      { ...second, assetID: second.assetID.toLowerCase() },
    ],
  },
}
expect(row.command).toEqual(expected)
expect(startCommandSchema.parse(row.command)).toEqual(expected)
```

**不能改变的事实**：精确 text 空格、asset order、opaque object keys、digest/length 与 conflict 没有 inbox acceptance 保持；不派生 expected 于 production schema。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/execution-store.test.ts。聚焦回归要求：Temporarily remove UUID canonicalization at persistence or alter schema transform; independent raw expected must detect the regression. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f079"></a>

#### F079 — Postgres proxy 创建 owner 必须把 listen error 接到 setup Promise

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`postgresProxy listen admission`。
- **是否改变合同**：把listen失败显式接入setup rejection；不是已复现绑定失败。正常TCP/blackhole路径不变。

**现在（连续原文）** — [`tests/integration/postgres-proxy-fixture.ts:41–44`](../tests/integration/postgres-proxy-fixture.ts#L41)

```ts
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing proxy port')
```

##### F079：为什么不好

listen Promise 只有 resolve；TCP listen error 不会 reject 它，调用方也尚未拿到 close capability。异常地址分支同样在 close 返回之前 throw。失败 setup 的资源责任因此没有闭合。正常回执黑洞/COMMIT tests 的 proxy 行为不需改。

**Handover 实际对照** — [`apps/server/src/db/notifications.spec.ts:55–89`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/notifications.spec.ts#L55-L89)

参考 test 等待 listening.listening 后操作，并在 finally stop listener；本 fixture 需在尚未交出 close 前独立处理 startup rejection。

```ts
    let came = 0
    const listening = listenOn({
      env,
      log: silent,
      channel: CHANNEL,
      heard: (payload) => heard.push(payload),
      again: () => {
        came += 1
      },
    })

    try {
      await listening.listening
      await sql`select pg_notify(${CHANNEL}, 'first')`.execute(db)
      await until(() => heard.length === 1)
      expect(heard).toEqual(['first'])

      // What a database restart does to it, done on purpose.
      const [pid] = await listeners()
      expect(pid).toBeDefined()
      await sql`select pg_terminate_backend(${pid})`.execute(db)

      // Nothing sent in the gap can be replayed, so what is asked is that it is listening again
      // and that it said so — which is the only reason anybody can go and look.
      await until(() => came === 1)
      expect(came).toBe(1)

      await sql`select pg_notify(${CHANNEL}, 'second')`.execute(db)
      await until(() => heard.length === 2)

      expect(heard).toEqual(['first', 'second'])
    } finally {
      await listening.stop()
    }
  })
```

##### F079：应该怎么改

仅在 listen admission 阶段注册一次 error handler，成功时移除；失败销毁已记录 socket。无法获得地址时关闭 listener 再拒绝，不把代理升级成通用 TCP framework。

##### F079：改完之后的形状（拟议，未实施）

在所列原文件的同一词法上下文替换此局部段落；它不是可单独编译的完整模块。

```ts
try {
  await new Promise<void>((resolve, reject) => {
    const failed = (cause: Error) => reject(cause)
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', failed)
      resolve()
    })
  })
} catch (cause) {
  for (const socket of sockets) socket.destroy()
  throw cause
}
const address = server.address()
if (!address || typeof address === 'string') {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve, reject) =>
    server.close((cause) => (cause ? reject(cause) : resolve())),
  )
  throw new Error('Missing proxy port')
}
```

**不能改变的事实**：保留真实 TCP forwarding、blackhole 不丢请求只丢回执、socket ownership、unknown COMMIT 覆盖；不 retry bind。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/postgres-proxy-fixture.ts。聚焦回归要求：Focused local TCP bind/listen failure test should reject setup rather than hang; no PostgreSQL mutation or provider required. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f080"></a>

#### F080 — 并发fixture接入应先收齐sibling结果，再按owner关闭Redis/SQL资源

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`beforeEach Redis connect`。
- **是否改变合同**：测试setup失败结算方式改变；新增native error listener仅阻止EventEmitter未处理异常，不能把命令/promise失败吞掉。

**现在（连续原文）** — [`tests/integration/redis.test.ts:19–19`](../tests/integration/redis.test.ts#L19)

```ts
  await Promise.all([commands.connect(), reader.connect()])
```

相关现状：[`tests/scripts/deployment-boundaries.test.ts:93–126`](../tests/scripts/deployment-boundaries.test.ts#L93)

```ts
test('authentication storage belongs to the server and remains private from workers', async () => {
  const server = new pg.Client({ connectionString: serverURL })
  const worker = new pg.Client({ connectionString: workerURL })
  await Promise.all([server.connect(), worker.connect()])
  try {
    await server.query('BEGIN')
    const userID = crypto.randomUUID()
    await server.query(
      'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
      [userID, 'Boundary fixture', `${userID}@boundary.example.test`],
    )
    await server.query(
      'INSERT INTO auth.session (id, token, "expiresAt", "updatedAt", "userId") VALUES ($1, $2, now() + interval \'1 hour\', now(), $3)',
      [crypto.randomUUID(), crypto.randomUUID(), userID],
    )
    await server.query('ROLLBACK')
    for (const statement of [
      'SELECT * FROM auth."user"',
      'DELETE FROM auth."user"',
      'SELECT * FROM auth.session',
      'DELETE FROM auth.session',
      'SELECT * FROM auth.account',
      'DELETE FROM auth.account',
      'SELECT * FROM auth.verification',
      'DELETE FROM auth.verification',
    ])
      await denied(worker.query(statement), { code: '42501' })
    await denied(server.query('CREATE TABLE auth.forbidden (id int)'), {
      code: '42501',
    })
  } finally {
    await Promise.all([server.end(), worker.end()])
  }
})
```

##### F080：为什么不好

Promise.all 在首个 connect rejection 就结束，另一个已经发出的 native connect 仍可继续。当前 setup 没有 own failure branch；afterEach 无法表达“已发出的两个初始化均已结算后才关闭”。execution-transport 的 beforeEach 也在 try 外执行同样 Promise.all。此处不是并发本身有问题，而是失败聚合与关闭边界。 同构缺口也出现在deployment-boundaries.test.ts的paired SQL clients：两个connect在try/finally之前，首个失败时peer可能未settle且cleanup未进入。两处合为一个责任问题，不按native backend重复计数。

**Handover 实际对照** — [`apps/server/src/db/across-instances.spec.ts:48–50`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/across-instances.spec.ts#L48-L50)

参考实际 afterAll 同时关闭 two pools；它证明两个 sibling resource 必须由同一 owner 关闭，但没有直接 Redis initialization 失败 analogue。

```ts

afterAll(async () => {
  await Promise.all([one.destroy(), two.destroy()])
```

##### F080：应该怎么改

两个 connect 保持并发，allSettled 收齐结果，发现 failure 后 destroy 已打开的客户端并抛 aggregate。把相同连接阶段处理应用到 execution-transport，不改变其连接后的实际 Redis marker admission。 由于本 beforeEach 原来没有 Redis error event listener，示例也明确安装无私有日志的 event listener；失败由 native connect rejection 聚合，不让 EventEmitter error 先变成无人处理的进程异常。 SQL角色fixture保留所有授权断言，接入移入try，allSettled收齐两端；close也收齐，并与primary failures聚合。第二组paired fixture及single-client同合同迁移。

##### F080：改完之后的形状（拟议，未实施）

在所列原文件的同一词法上下文替换此局部段落；它不是可单独编译的完整模块。

```ts
// Native connect/command promises report failures; do not emit raw fixture errors.
commands.on('error', () => {})
reader.on('error', () => {})
const connected = await Promise.allSettled([
  commands.connect(),
  reader.connect(),
])
const failures = connected.flatMap((result) =>
  result.status === 'rejected' ? [result.reason as unknown] : [],
)
if (!failures.length) return
if (reader.isOpen) reader.destroy()
if (commands.isOpen) commands.destroy()
throw new AggregateError(failures, 'Redis fixture connection failed')
```

同类实际consumer：deployment-boundaries.test.ts完整paired authentication test；沿用该文件已存在的pg/serverURL/workerURL/denied绑定。不是另一条独立发现。

```ts
test('authentication storage belongs to the server and remains private from workers', async () => {
  const server = new pg.Client({ connectionString: serverURL })
  const worker = new pg.Client({ connectionString: workerURL })
  let failed = false
  let primary: unknown
  try {
    const connections = await Promise.allSettled([
      server.connect(),
      worker.connect(),
    ])
    const failures = connections.flatMap((connection) =>
      connection.status === 'rejected' ? [connection.reason as unknown] : [],
    )
    if (failures.length)
      throw new AggregateError(failures, 'SQL fixture connection failed')
    await server.query('BEGIN')
    const userID = crypto.randomUUID()
    await server.query(
      'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
      [userID, 'Boundary fixture', `${userID}@boundary.example.test`],
    )
    await server.query(
      'INSERT INTO auth.session (id, token, "expiresAt", "updatedAt", "userId") VALUES ($1, $2, now() + interval \'1 hour\', now(), $3)',
      [crypto.randomUUID(), crypto.randomUUID(), userID],
    )
    await server.query('ROLLBACK')
    for (const statement of [
      'SELECT * FROM auth."user"',
      'DELETE FROM auth."user"',
      'SELECT * FROM auth.session',
      'DELETE FROM auth.session',
      'SELECT * FROM auth.account',
      'DELETE FROM auth.account',
      'SELECT * FROM auth.verification',
      'DELETE FROM auth.verification',
    ])
      await denied(worker.query(statement), { code: '42501' })
    await denied(server.query('CREATE TABLE auth.forbidden (id int)'), {
      code: '42501',
    })
  } catch (cause) {
    failed = true
    primary = cause
  } finally {
    const closed = await Promise.allSettled([server.end(), worker.end()])
    const failures = closed.flatMap((connection) =>
      connection.status === 'rejected' ? [connection.reason as unknown] : [],
    )
    if (failures.length) {
      if (failed) failures.unshift(primary)
      throw new AggregateError(failures, 'SQL fixture settlement failed')
    }
  }
  if (failed) throw primary
})
```

**不能改变的事实**：不取消真实 Redis/PEL tests；不重连，不 flush 数据库；所有已发出的 sibling connect settled 后才退出 setup。 SQL角色隔离/grant断言完整保留，只有两端成功才读取role facts；primary与两端cleanup原因均保留。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/redis.test.ts。聚焦回归要求：Run a test-only setup failure with one accepted Redis connect and one refused connect; verify both promises settle and neither client stays open. 本次未运行。 同时验证tests/scripts/deployment-boundaries.test.ts的一有效role URL、一refused URL场景；授权/grant事实仍通过原native部署runner验收。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f081"></a>

#### F081 — SSE 顺序断言先证明两种事件都存在，避免 -1 充当正确先后

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`reconstruction retains text before an unrelated-run boundary: SSE order assertion`。

**现在（连续原文）** — [`tests/integration/run-scoped-observation.test.ts:254–256`](../tests/integration/run-scoped-observation.test.ts#L254)

```ts
    expect(text.indexOf('TEXT_MESSAGE_START')).toBeLessThan(
      text.indexOf('TEXT_MESSAGE_CONTENT'),
    )
```

##### F081：为什么不好

indexOf 找不到 START 时返回 -1，而 CONTENT 存在时 -1 < offset 是 true。当前 preceding delta substring 可证明 text 出现，但不能证明 START frame；所以“reconstruction retains text”场景可能漏掉真实协议开始帧仍通过此顺序 assertion。

**Handover 实际对照** — [`apps/server/src/db/watching.spec.ts:59–73`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/watching.spec.ts#L59-L73)

参考 actual watcher 测试断言完整 seen/moment 对象，存在性与值共同受保护；无直接 AG-UI/SSE protocol analogue。

```ts
  it('reaches somebody watching on another', async () => {
    const conversationId = randomUUID()
    const arriving = seen(conversationId)

    await liveThrough(machineSide, watchers()).say({
      conversationId,
      watched: { seen: 'moment', moment: { said: 'thinking', text: 'let me look at the file' } },
    })

    expect(await arriving).toEqual({
      seen: 'moment',
      moment: { said: 'thinking', text: 'let me look at the file' },
    })
  })
```

##### F081：应该怎么改

用两个局部 offset 明确存在性与顺序；没有必要为三行创建 SSE assertion framework。额外保留原 delta canary 与 RUN_FINISHED assertions。

##### F081：改完之后的形状（拟议，未实施）

在所列原文件的同一词法上下文替换此局部段落；它不是可单独编译的完整模块。

```ts
const startOffset = text.indexOf('TEXT_MESSAGE_START')
const contentOffset = text.indexOf('TEXT_MESSAGE_CONTENT')
expect(startOffset).toBeGreaterThanOrEqual(0)
expect(contentOffset).toBeGreaterThanOrEqual(0)
expect(startOffset).toBeLessThan(contentOffset)
```

**不能改变的事实**：保留 run-scoped SQL bounds、historical cursor/reconnect、所有 session/owner isolation；仅加强 protocol shape 证据。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/run-scoped-observation.test.ts。聚焦回归要求：Drop only TEXT_MESSAGE_START from the reconstructed SSE stream; strengthened assertion must fail while existing delta assertions still pass. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f082"></a>

#### F082 — runtime submit 的身份 setup rejection 不应跳过自己打开的数据库关闭

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`submit identity setup`。

**现在（连续原文）** — [`tests/integration/runtime.test.ts:92–95`](../tests/integration/runtime.test.ts#L92)

```ts
  const { db, close } = openTestDatabase()
  const login = await signedTestIdentity(db)
  await close()
  const headers = login.headers
```

##### F082：为什么不好

submit 打开 pool 后直接 await signedTestIdentity，再 close；官方插件/context/user/session 任一步拒绝时 close 永远不可达。thread-lifecycle 顶层 setup 已使用“primary + cleanup”aggregate 模式，本处可采用同样有证据的 ownership 形状。

**Handover 实际对照** — [`apps/server/src/db/watching.spec.ts:24–42`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/watching.spec.ts#L24-L42)

参考 machine/browser 两个 native pool 有清晰 afterAll destroy owner；这里 pool 生命周期短于 suite，故需函数内 setup failure ownership。

```ts

const watching = watchers()
const listening = listenForLive(env, log, (happening) => {
  watching.show(happening)
})

const live = liveThrough(browserSide, watching)

beforeAll(async () => {
  // Nothing arrives before the connection is up, and a test that raced it would fail for a reason
  // that has nothing to do with what it is about.
  await listening.listening
})

afterAll(async () => {
  await listening.stop()
  await machineSide.destroy()
  await browserSide.destroy()
})
```

##### F082：应该怎么改

仅替换 submit 的 identity/pool 阶段；成功仍先关闭 fixture pool，再用真实 cookie 发 HTTP。失败关闭 pool，若关闭也失败保留两个原因。不要从此处发 sign-out，因为会改变后续测试的身份语义。

##### F082：改完之后的形状（拟议，未实施）

在所列原文件的同一词法上下文替换此局部段落；它不是可单独编译的完整模块。

```ts
const { db, close } = openTestDatabase()
let login: Awaited<ReturnType<typeof signedTestIdentity>>
try {
  login = await signedTestIdentity(db)
} catch (cause) {
  try {
    await close()
  } catch (cleanup) {
    throw new AggregateError(
      [cause, cleanup],
      'Runtime identity setup failed',
      {
        cause,
      },
    )
  }
  throw cause
}
await close()
const headers = login.headers
```

**不能改变的事实**：保留 official Better Auth 登录、真实 HTTP→Redis→Pi→SQL integration 和 primary failure；不新增 mock 身份，不重试 session 创建。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/runtime.test.ts。聚焦回归要求：Force official identity setup rejection in a focused fixture test and verify pool close is attempted; retain the original rejection if close succeeds. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f083"></a>

#### F083 — runtime answer polling 证明 assistant 消息，而非响应任意位置含有 canary

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`answer`。

**现在（连续原文）** — [`tests/integration/runtime.test.ts:116–128`](../tests/integration/runtime.test.ts#L116)

```ts
async function answer(url: string, threadID: string) {
  const deadline = performance.now() + 5000
  while (performance.now() < deadline) {
    const result = await (
      await fetch(`${url}/api/threads/${threadID}/messages`, {
        headers: identities.get(threadID)!,
      })
    ).text()
    if (result.includes('reply: hello')) return result
    await Bun.sleep(20)
  }
  throw new Error('No stored answer')
}
```

##### F083：为什么不好

HTTP→leased Pi journey 的 helper 只 result.includes(reply: hello)。同一字符串出现在 user text、title、error/detail 或别的字段也会结束 polling；status 未被检查。test 名承诺 stored public answer，应观察消息角色与 canonical text，不是 JSON serialization 子串。

**Handover 实际对照** — [`apps/server/src/db/watching.spec.ts:59–73`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/watching.spec.ts#L59-L73)

参考跨实例 live test 等实际 arriving，再对 seen/moment/said/text 完整对象作独立 expected；不是只检查某个词出现。

```ts
  it('reaches somebody watching on another', async () => {
    const conversationId = randomUUID()
    const arriving = seen(conversationId)

    await liveThrough(machineSide, watchers()).say({
      conversationId,
      watched: { seen: 'moment', moment: { said: 'thinking', text: 'let me look at the file' } },
    })

    expect(await arriving).toEqual({
      seen: 'moment',
      moment: { said: 'thinking', text: 'let me look at the file' },
    })
  })
```

##### F083：应该怎么改

仍 fetch 实际 messages endpoint并返回原 response text给既有 private-header assertion；只对 200 JSON 中 assistant + exact answer 判定。此处类型断言只描述已有 public fields，不替代生产 boundary parsing。

##### F083：改完之后的形状（拟议，未实施）

完整替换现有answer函数；它继续返回原JSON文本供隐私断言。

```ts
async function answer(url: string, threadID: string) {
  const deadline = performance.now() + 5000
  while (performance.now() < deadline) {
    const response = await fetch(`${url}/api/threads/${threadID}/messages`, {
      headers: identities.get(threadID)!,
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    const snapshot = JSON.parse(text) as {
      messages: { role: string; text: string }[]
    }
    const final = snapshot.messages.find(
      (message) =>
        message.role === 'assistant' && message.text === 'reply: hello',
    )
    if (final !== undefined) return text
    await Bun.sleep(20)
  }
  throw new Error('No stored assistant answer')
}
```

**不能改变的事实**：真实 HTTP/认证/Redis/SQL/Pi loopback未缩减；保留 5s 有限 polling及原 privacy/history/cleanup assertions，不用 mocks代替完整 journey。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/runtime.test.ts。聚焦回归要求：Return a snapshot containing the canary only in a user message; helper must continue polling. A 401/500 must fail clearly, not count as a stored answer. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f084"></a>

#### F084 — 会话到期三种场景创建的官方身份也应加入本套件清理账本

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`threadIDs / afterAll / session lifetime identities`。

**现在（连续原文）** — [`tests/integration/thread-lifecycle.test.ts:47–70`](../tests/integration/thread-lifecycle.test.ts#L47)

```ts
const threadIDs: string[] = []
afterAll(async () => {
  shutdown.abort()
  await settleTestCleanup([
    ...(
      [
        'product.execution_events',
        'product.command_outbox',
        'product.messages',
        'product.assets',
        'product.threads',
      ] as const
    ).map((table) => async () => {
      if (threadIDs.length)
        await db.deleteFrom(table).where('thread_id', 'in', threadIDs).execute()
    }),
    () =>
      db
        .deleteFrom('auth.user')
        .where('id', 'in', [login.user.id, foreign.user.id])
        .execute(),
    close,
  ])
})
```

##### F084：为什么不好

顶层 login/foreign 被 afterAll 删除，但 test.each expiry/logout/revocation 在约 321 行另外调用 signedTestIdentity(db)，实际保存 auth.user 和官方 session；这些用户不在当前两项清理清单中。thread 删除不会删除 user。fixture 生命周期的叙述因而只覆盖了两名主角。

**Handover 实际对照** — [`apps/server/src/db/sign-in.spec.ts:22–32`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/sign-in.spec.ts#L22-L32)

参考 beforeEach 为每个 test 派生 RUN/EMAIL，后续 people/sessions 查询按这些键定位自己的身份；本项目对应的是显式 owned-user cleanup，不照搬其不删行策略。

```ts
/** A fresh address per test, so no test depends on the database being empty when it starts. */
/** A request key is unique per asker, so a fresh one per test keeps them out of each other's way. */
let RUN = ''
let EMAIL = ''

beforeEach(() => {
  // One fresh id per test, and everything the test touches is named from it. That is what lets a
  // count below be a count of this test's rows rather than of the whole table.
  RUN = randomUUID()
  EMAIL = `mina-${RUN}@example.com`
})
```

##### F084：应该怎么改

保留官方签名/session 路径。新增本地 ownedIdentity，并把三个 session-lifetime cases 的 signedTestIdentity(db) 调用换为 ownedIdentity()。新 helper 有真实责任：登记清理身份，而非纯转发。顶层两名身份纳入同一 Set。

##### F084：改完之后的形状（拟议，未实施）

替换现有threadIDs/afterAll声明，并新增同模块ownedIdentity；主login/foreign的setup仍保持原序。

```ts
const threadIDs: string[] = []
const userIDs = new Set([login.user.id, foreign.user.id])
afterAll(async () => {
  shutdown.abort()
  await settleTestCleanup([
    ...(
      [
        'product.execution_events',
        'product.command_outbox',
        'product.messages',
        'product.assets',
        'product.threads',
      ] as const
    ).map((table) => async () => {
      if (threadIDs.length)
        await db.deleteFrom(table).where('thread_id', 'in', threadIDs).execute()
    }),
    () =>
      db
        .deleteFrom('auth.user')
        .where('id', 'in', [...userIDs])
        .execute(),
    close,
  ])
})

async function ownedIdentity() {
  const identity = await signedTestIdentity(db)
  userIDs.add(identity.user.id)
  return identity
}
```

原 session-lifetime test.each callback中的本地身份创建；将原signedTestIdentity(db)这一行替换，后续cookie/expiry/logout/revocation流程不变。

```ts
const identity = await ownedIdentity()
```

**不能改变的事实**：维持真实 Better Auth、Origin/CSRF、session 到期/注销/撤销三种独立覆盖；先 thread 后 user，最后 close。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/thread-lifecycle.test.ts。聚焦回归要求：Assert no auth.user rows for all five created identities remain after suite teardown, with auth sessions removed via existing FK behavior. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f085"></a>

#### F085 — archive/send/replay barrier 在失败路径也收齐已发出的真实 writer

- **优先级**：P2 / 测试边界。
- **适用置信度**：高（静态证据；实际失败后果未运行复现）。
- **符号**：`real PG barrier serializes archive against send and exact replay under the thread lock`。

**现在（连续原文）** — [`tests/integration/thread-lifecycle.test.ts:295–316`](../tests/integration/thread-lifecycle.test.ts#L295)

```ts
test('real PG barrier serializes archive against send and exact replay under the thread lock', async () => {
  const query = await ownedThread()
  const accepted = intent(query)
  await acceptMessageIntent(db, accepted)
  const barrier = await threadBarrier(query.threadID)
  try {
    const archiving = archiveThread(db, query)
    await waitForBlockedThreadWriters(1)
    const sending = acceptMessageIntent(db, intent(query))
    const replaying = acceptMessageIntent(db, accepted)
    await waitForBlockedThreadWriters(3)
    barrier.release()
    await barrier.done
    await archiving
    expect((await sending).kind).toBe('conflict')
    expect((await replaying).kind).toBe('conflict')
    expect((await snapshotOwnedMessages(db, query))?.messages).toHaveLength(1)
  } finally {
    barrier.release()
    await barrier.done
  }
})
```

##### F085：为什么不好

archiving/sending/replaying 在 try 内启动，但 finally 只 join blocker。waitForBlockedThreadWriters 的超时或中途 assertion failure 可使实际 writer 在 test 返回后继续执行，污染后续 global scheduler/test narrative。三次 blocked observation 是有价值的竞争证据，不应删掉。 AFTER的allSettled仅保证drain；应尽早给issued writer安装rejection观察，避免在barrier observation等待期间产生未处理rejection。

**Handover 实际对照** — [`apps/server/src/db/across-instances.spec.ts:311–354`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/db/across-instances.spec.ts#L311-L354)

参考 afterRelationshipRemoval 同时拥有 removing、answer、waiting 三种工作，并在 release 后等 removing 和 waiting；本 finding 加强本项目异常路径 join，不照搬参考也缺 finally 的形式。

```ts

async function afterRelationshipRemoval<Answer>(
  relation: { readonly machineId: string; readonly spaceId: string },
  act: () => Promise<Answer>,
): Promise<Answer> {
  const changed = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const removing = two.transaction().execute(async (tx) => {
    await tx
      .updateTable('space_machines')
      .set({ removed_at: sql<Date>`clock_timestamp()` })
      .where('space_id', '=', relation.spaceId)
      .where('machine_id', '=', relation.machineId)
      .where('removed_at', 'is', null)
      .execute()
    changed.resolve()
    await release.promise
  })

  await changed.promise
  const completed = Promise.withResolvers<void>()
  const answer = act().finally(completed.resolve)
  const waiting = waitForRelationshipLock()
  await Promise.race([completed.promise, waiting])
  release.resolve()
  await removing
  await waiting
  return answer
}

async function waitForRelationshipLock(): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await sql<{ blocked: boolean }>`
      select exists (
        select 1 from pg_stat_activity
         where cardinality(pg_blocking_pids(pid)) > 0
           and query like '%space_machines%'
      ) as blocked
    `.execute(one)
    if (waiting.rows[0]?.blocked === true) return true
    await new Promise<void>((resume) => setImmediate(resume))
  }
  return false
}
```

##### F085：应该怎么改

仅加 owned writer list；finally 先释放并 join blocker，再 allSettled join 每个已发 writer。正常路径保留各自 outcome assertions。失败路径的 allSettled 用于 drain，不用其结果伪装正常 test 成功。 catch只附加即时观察，不替换writers中原promise或正常路径的await；finally仍收齐原promise。这不是把未验证的rejection改为成功。

##### F085：改完之后的形状（拟议，未实施）

在所列原文件的同一词法上下文替换此局部段落；它不是可单独编译的完整模块。

```ts
test('real PG barrier serializes archive against send and exact replay under the thread lock', async () => {
  const query = await ownedThread()
  const accepted = intent(query)
  await acceptMessageIntent(db, accepted)
  const barrier = await threadBarrier(query.threadID)
  const writers: Promise<unknown>[] = []
  try {
    const archiving = archiveThread(db, query)
    writers.push(archiving)
    void archiving.catch(() => {})
    await waitForBlockedThreadWriters(1)
    const sending = acceptMessageIntent(db, intent(query))
    const replaying = acceptMessageIntent(db, accepted)
    writers.push(sending, replaying)
    void sending.catch(() => {})
    void replaying.catch(() => {})
    await waitForBlockedThreadWriters(3)
    barrier.release()
    await barrier.done
    await archiving
    expect((await sending).kind).toBe('conflict')
    expect((await replaying).kind).toBe('conflict')
    expect((await snapshotOwnedMessages(db, query))?.messages).toHaveLength(1)
  } finally {
    barrier.release()
    try {
      await barrier.done
    } finally {
      await Promise.allSettled(writers)
    }
  }
})
```

**不能改变的事实**：保留真实 PG lock、先 archive 入队再 send/replay、archive 后两者 conflict、单条已接受 message；不替换 barrier 为 sleep/mock。

**实施时的验证要求**：未来实施：sh scripts/database-check.sh；bun run typecheck；bun run lint；bun run fmt:check。现有覆盖：tests/integration/thread-lifecycle.test.ts。聚焦回归要求：Force blocked-writer observation to fail after starting archive; prove all issued SQL settles before the next test starts. 本次未运行。

**当前验证状态**：完整分段body阅读；源和引文范围/hash静态核对。AFTER是提案，未实施、未类型检查、未运行；不宣称已复现功能缺陷。

<a id="f086"></a>

#### F086 — readiness polling同时拥有monotonic预算和每次请求截止

- **优先级**：P2 / 边界与验收。
- **适用置信度**：高（静态证据；拟议实现未验证）。
- **符号**：`same-origin deployment readiness test`。

**现在（连续原文）** — [`tests/scripts/deployment-web.test.ts:4–18`](../tests/scripts/deployment-web.test.ts#L4)

```ts
test('same-origin native auth and private API routes are proxied by Caddy', async () => {
  const deadline = Date.now() + 15000
  let response: Response | undefined
  while (Date.now() < deadline) {
    response = await fetch(`${origin}/api/auth/get-session`).catch(
      () => undefined,
    )
    if (response?.status === 200) break
    await Bun.sleep(100)
  }
  expect(response?.status).toBe(200)
  expect(await response!.json()).toBeNull()
  const privateRoute = await fetch(`${origin}/api/threads`)
  expect(privateRoute.status).toBe(401)
}, 20000)
```

##### F086：为什么不好

Date.now受wall-clock跃迁影响；fetch没有signal，单次silent accepted connection可占满runner timeout而跳过意图的15s预算。private-route请求也缺request截止。静态owner缺口，不是已复现部署挂起。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F086：应该怎么改

改performance.now、按remaining budget对每次fetch设置signal，最终private request也有界。保留get-session null与private401合同；并不证明signed-in/revoked覆盖。

##### F086：改完之后的形状（拟议，未实施）

所列原文件的局部replacement；必要的新模块/调用段落另列，不是全库可直接应用补丁。

```ts
test('same-origin native auth and private API routes are proxied by Caddy', async () => {
  const deadline = performance.now() + 15000
  let response: Response | undefined
  while (performance.now() < deadline) {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()))
    response = await fetch(`${origin}/api/auth/get-session`, {
      signal: AbortSignal.timeout(Math.min(1000, remaining)),
    }).catch(() => undefined)
    if (response?.status === 200) break
    if (response?.body) await response.body.cancel()
    await Bun.sleep(100)
  }
  expect(response?.status).toBe(200)
  expect(await response!.json()).toBeNull()
  const privateRoute = await fetch(`${origin}/api/threads`, {
    signal: AbortSignal.timeout(1000),
  })
  try {
    expect(privateRoute.status).toBe(401)
  } finally {
    if (privateRoute.body) await privateRoute.body.cancel()
  }
}, 20000)
```

**不能改变的事实**：只观察、不auth bypass/paid commands；wall-clock不改变elapsed budget。错误响应/body也需drain/cancel，不能每次poll留body。

**实施时的验证要求**：聚焦loopback用Date.now跃迁与silent connection验证有限退出；proxy-deadline.test.ts是本地先例。后续隔离deployment-check.sh仍验same-origin真实Caddy。

**当前验证状态**：源body完整阅读，范围/hash静态核对。AFTER未实施、未编译、未类型检查、未功能验证；未运行Docker/VM/provider旅程。

<a id="f087"></a>

#### F087 — daemon probe需要在Docker client超时前登记可定位身份

- **优先级**：P2 / 边界与验收。
- **适用置信度**：高（静态证据；拟议实现未验证）。
- **符号**：`anonymous inventory docker run`。

**现在（连续原文）** — [`tests/scripts/production-runtime.test.ts:157–179`](../tests/scripts/production-runtime.test.ts#L157)

```ts
        const installed = execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '--network',
            'none',
            '--label',
            `vid.check.owner=${owner}`,
            '--user',
            'root',
            '--entrypoint',
            'bun',
            image,
            '--eval',
            inventory,
          ],
          {
            encoding: 'utf8',
            timeout: 600000,
          },
        )
```

##### F087：为什么不好

两个anonymous docker run --rm probe不归当前finally中main-entrypoint container ID。execFileSync timeout结束client不证明daemon container停止；--rm也不证明still-running probe关闭。是静态ownership缺口，不是已复现孤儿container。

**Handover 对照边界**：未提供可核实的同构参考实现；本项基于当前原文和 AFTER 的局部对照，不宣称 Handover 有完全对应的能力。

##### F087：应该怎么改

为两个probe采用预登记随机name、精确owner label和create/start；无论operation结果都按label/immutable ID关闭。保留operation与cleanup双原因；daemon/create仍未知时报告unknown，不声称已清理，不扩大全局搜索/删除。

##### F087：改完之后的形状（拟议，未实施）

在production-runtime.test.ts现有docker/removeOwned辅助函数旁新增helper；不是exported框架。

```ts
function runOwnedProbe(
  image: string,
  owner: string,
  options: readonly string[],
  script: string,
): string {
  const name = `${owner}-probe-${crypto.randomUUID()}`
  let result: PromiseSettledResult<string>
  try {
    docker(
      'create',
      '--name',
      name,
      '--label',
      `vid.check.owner=${owner}`,
      '--network',
      'none',
      ...options,
      '--entrypoint',
      'bun',
      image,
      '--eval',
      script,
    )
    result = { status: 'fulfilled', value: docker('start', '-a', name) }
  } catch (reason) {
    result = { status: 'rejected', reason }
  }
  try {
    const [id, label] = docker(
      'inspect',
      '--format',
      '{{.Id}} {{index .Config.Labels "vid.check.owner"}}',
      name,
    )
      .trim()
      .split(' ')
    assert.equal(label, owner)
    assert.ok(id)
    removeOwned(id, owner)
  } catch (cleanup) {
    if (result.status === 'rejected')
      throw new AggregateError(
        [result.reason, cleanup],
        'Owned probe or settlement failed',
      )
    throw cleanup
  }
  if (result.status === 'rejected') throw result.reason
  return result.value
}
```

同文件inventory与worker export probe现有调用位置分别替换；下面两个段落属于各自已有作用域。

```ts
const installed = runOwnedProbe(image, owner, ['--user', 'root'], inventory)

// Replace the worker-export probe's complete assert.match expression.
assert.match(
  runOwnedProbe(
    image,
    owner,
    ['--workdir', '/app/apps/agent'],
    `const { spawnSync } = await import('node:child_process');
const child = spawnSync('node', ['--input-type=module', '--eval', "await import('@earendil-works/pi-coding-agent'); await import('e2b'); console.log('node-native-ok', process.release.name)"], { encoding: 'utf8' });
if (child.status !== 0) throw new Error(child.stderr || String(child.error));
console.log(child.stdout);`,
  ),
  /node-native-ok node/,
)
```

**不能改变的事实**：只删exact-labelled owned资源；timeout沿用现有有界Docker命令。inspect失败不误判不存在、不发替代create；不把Docker socket交给app。

**实施时的验证要求**：未来用隔离native probe超过CLI deadline，核对精确label/name资源是否settled；若inspect也未知则报告未证明clean，不作成功断言。本审查不分配container。

**当前验证状态**：源body完整阅读，范围/hash静态核对。AFTER未实施、未编译、未类型检查、未功能验证；未运行Docker/VM/provider旅程。

<a id="f088"></a>

#### F088 — 上传 fixture 只保证初始可用状态；重放和冲突应由命名测试自己拥有

- **优先级**：P3 / 测试叙述与职责。
- **适用置信度**：高：已完整读两份 storage tests；不是功能缺陷。
- **符号**：`uploadedAsset`。

**现在（连续原文）** — [`tests/storage/assets.test.ts:92–118`](../tests/storage/assets.test.ts#L92)

```ts
async function uploadedAsset() {
  const f = await fixture()
  const assetID = crypto.randomUUID(),
    bytes = new TextEncoder().encode('asset bytes')
  const headers = new Headers(f.login.headers)
  headers.set('content-type', 'text/plain')
  headers.set('x-asset-id', assetID)
  headers.set('x-file-name', 'note.txt')
  const path = `/api/threads/${f.threadID}/assets`
  const uploaded = await f.request(path, 'POST', bytes, headers)
  expect(uploaded.status).toBe(201)
  const dto = assetResponseSchema.parse(await uploaded.json())
  expect(dto.asset.byteLength).toBe(bytes.length)
  expect(JSON.stringify(dto)).not.toContain('objectKey')
  expect((await f.request(path, 'POST', bytes, headers)).status).toBe(200)
  expect(
    (
      await f.request(
        path,
        'POST',
        new TextEncoder().encode('different'),
        headers,
      )
    ).status,
  ).toBe(409)
  return { f, assetID, bytes }
}
```

##### F088：为什么不好

uploadedAsset 看起来只是建立一个可用附件，但内部额外发起精确重放和不同内容重放并断言 200/409。大量下载、过期会话、二进制、历史对象测试调用它，因此每个测试都隐式执行另一条重放/冲突旅程。当前上传成功和 schema 解析是 fixture 的有效前置保证；问题不是 fixture 不能断言，而是把独立产品承诺藏进准备阶段。completedAsset 也有类似附带验证，归入同一项，不重复计数。

**Handover 实际对照** — [`apps/server/src/server/avatar-api.spec.ts:8–43`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/apps/server/src/server/avatar-api.spec.ts#L8-L43)

只对比 fixture/断言归属：emptyBucket 返回 fixture 能力，具体生成一次与第二次重放的断言在命名测试内。Handover 用内存 bucket；本项目必须保留真实 S3 runner，不复制它的 mock 边界。

```ts
function emptyBucket() {
  const kept = new Map<string, StoredObject>()
  let writes = 0
  const objects: ObjectStore = {
    find: async (key) => kept.get(key),
    put: async (key, object) => {
      writes += 1
      kept.set(key, object)
    },
    close: () => undefined,
  }

  return { objects, kept, writes: () => writes }
}

function avatarApp(bucket: ReturnType<typeof emptyBucket>, exists = true) {
  return mounted(avatarApi({ objects: bucket.objects, exists: async () => exists }))
}

describe('a stored avatar', () => {
  it('is generated into the bucket once, then served from those bytes', async () => {
    const bucket = emptyBucket()
    const app = avatarApp(bucket)
    const path = `/avatars/users/${randomUUID()}`

    const first = await app.request(path)
    const firstSvg = await first.text()
    const second = await app.request(path)

    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toContain('image/svg+xml')
    expect(firstSvg).toContain('<svg')
    expect(await second.text()).toBe(firstSvg)
    expect(bucket.writes()).toBe(1)
    expect(bucket.kept.size).toBe(1)
  })
```

##### F088：应该怎么改

保留 fixture 中上传成功与 public schema 解析的前置保证。把额外 replay/conflict 和 DTO 可见性断言移到明确命名的上传行为测试。下面完整替换 uploadedAsset，并补一条拥有这些断言的测试；保留现有其他 storage case，不删其并发、未知 PUT 和权限证据。专门测试里多写几行 headers，比把所有 fixture 变成隐式综合旅程更可读。

##### F088：改完之后的形状（拟议，未实施）

```ts
async function uploadedAsset() {
  const f = await fixture()
  const assetID = crypto.randomUUID()
  const bytes = new TextEncoder().encode('asset bytes')
  const headers = new Headers(f.login.headers)
  headers.set('content-type', 'text/plain')
  headers.set('x-asset-id', assetID)
  headers.set('x-file-name', 'note.txt')

  const path = `/api/threads/${f.threadID}/assets`
  const uploaded = await f.request(path, 'POST', bytes, headers)
  expect(uploaded.status).toBe(201)
  const asset = assetResponseSchema.parse(await uploaded.json()).asset

  return { f, assetID, bytes, asset }
}

test('owned uploads replay exactly and reject changed bytes without disclosing storage keys', async () => {
  const { f, assetID, bytes, asset } = await uploadedAsset()
  const headers = new Headers(f.login.headers)
  headers.set('content-type', 'text/plain')
  headers.set('x-asset-id', assetID)
  headers.set('x-file-name', 'note.txt')
  const path = `/api/threads/${f.threadID}/assets`

  const replay = await f.request(path, 'POST', bytes, headers)
  const conflict = await f.request(
    path,
    'POST',
    new TextEncoder().encode('different'),
    headers,
  )

  expect(asset.byteLength).toBe(bytes.length)
  expect(JSON.stringify(asset)).not.toContain('objectKey')
  expect(replay.status).toBe(200)
  expect(conflict.status).toBe(409)
})
```

**不能改变的事实**：真实 HTTP/SQL/S3 上传、精确重放和 changed-byte conflict 不变；fixture 仍保证初次 201 和 schema 合法；unique asset identity 不变；未知 PUT、并发 winner、历史不可变位置与 app 无删除权限的专门测试保留。AFTER 增加返回的 public asset 不暴露 objectKey，不把失败吞成可用 fixture。

**实施时的验证要求**：未来运行 tests/scripts/storage-check.sh 所拥有的真实 storage suite；核对 tests/storage/assets.test.ts 原有全部 cases 仍运行，再确认命名 replay test 独立证明 201 -> 200 与 changed bytes ->409。不要以测试拆分替代真正 S3、SQL 和 auth。

**当前验证状态**：静态逐页阅读、源范围与冻结 SHA 核对；建议未实施，AFTER 未编译/运行。

<a id="f089"></a>

#### F089 — 可执行CI TypeScript应进入现有compiler/lint边界

- **优先级**：P2 / 边界与验收。
- **适用置信度**：高（静态证据；拟议实现未验证）。
- **符号**：`compiler source include set`。

**现在（连续原文）** — [`tsconfig.json:30–36`](../tsconfig.json#L30)

```json
  "include": [
    "apps/**/*.ts",
    "packages/**/*.ts",
    "tests/**/*.ts",
    "scripts/**/*.ts",
    "deploy/**/*.ts"
  ],
```

##### F089：为什么不好

workflow执行.github/verify-api.ts，但根tsconfig没有.github，type-aware lint roots也不包含它。这里实际负责文件删除、子进程结算和生成物对照；仅被Prettier读取不是类型验收。

**Handover 实际对照** — [`package.json:31–43`](https://github.com/zihanyang-dev/handover/blob/901e1afb55c3973adac1626915015a6160e52356/package.json#L31-L43)

reference根package的check/lint显式包含rules与辅助执行roots。只比较实际检查边界，不引入其pnpm或生成pipeline。

```json
    "generate": "pnpm --filter @handover/server generate && pnpm --filter @handover/web generate && pnpm --filter @handover/cli generate",
    "typecheck": "tsc -p apps/server --noEmit && tsc -p apps/web --noEmit && tsc -p apps/cli --noEmit && tsc -p packages/universal --noEmit && tsc -p e2e --noEmit && tsc -p rules --noEmit && tsc -p . --noEmit",
    "lint": "oxlint --type-aware --tsconfig apps/server/tsconfig.json apps/server && oxlint --type-aware --tsconfig apps/web/tsconfig.json apps/web && oxlint --type-aware --tsconfig apps/cli/tsconfig.json apps/cli && oxlint --type-aware --tsconfig packages/universal/tsconfig.json packages && oxlint --type-aware --tsconfig e2e/tsconfig.json e2e && oxlint --type-aware --tsconfig rules/tsconfig.json rules",
    "format": "prettier --check .",
    "format:write": "prettier --write .",
    "test": "pnpm test:db && vitest run --project '!agents'",
    "test:agents": "vitest run --project agents",
    "test:binary": "node --env-file=.env.e2e apps/server/scripts/migrate.ts && playwright test -c e2e --grep 'the compiled binary'",
    "coverage": "vitest run --coverage.enabled --coverage.provider=v8 --coverage.reporter=text",
    "check": "pnpm generate && git diff --exit-code apps/server/generated apps/web/generated apps/cli/generated && pnpm typecheck && pnpm lint && pnpm format && pnpm unused && pnpm duplication && pnpm build && pnpm test",
    "test:e2e": "node --env-file=.env.e2e apps/server/scripts/migrate.ts && playwright test -c e2e --grep-invert 'as it looks today|the compiled binary'",
    "unused": "knip",
    "duplication": "jscpd apps packages e2e",
```

##### F089：应该怎么改

在根include加入.github/**/*.ts，lint roots加入.github；保留当前generated/vendor排除和read-only generation比较。不换包管理器、不重写CI。

##### F089：改完之后的形状（拟议，未实施）

tsconfig.json完整include数组值，不是完整tsconfig；既有compilerOptions/exclude不改。

```json
[
  "apps/**/*.ts",
  "packages/**/*.ts",
  "tests/**/*.ts",
  "scripts/**/*.ts",
  "deploy/**/*.ts",
  ".github/**/*.ts"
]
```

package.json scripts对象中的完整lint属性replacement；其他scripts不变。

```ts
lint: 'oxlint --type-aware --deny-warnings apps packages tests scripts deploy .github',
```

**不能改变的事实**：严格compiler flags与readonly generation合同不变；无权限、产物、网络或付费执行变化。

**实施时的验证要求**：实施后运行sh scripts/check.sh；用compiler file-set/config断言证明.github TS被纳入，仍核对现有generation drift。

**当前验证状态**：源body完整阅读，范围/hash静态核对。AFTER未实施、未编译、未类型检查、未功能验证；未运行Docker/VM/provider旅程。

## 6. 实施顺序与不做什么

### 6.1 分批实施，而非一次架构重写

1. **低风险视觉收束**：先决定100列；整理局部类型表达式、固定identity比较、metadata/encoding段落、非completion卫语句和长SQL clause。一次只做能逐字比较输入/输出的小批；不要全库重排掩盖行为diff。
2. **同一事实一个家**：工具定义/allowlist、input cap/schema名集合、固定lease identity等，确认全部消费者后集中；移除被替代定义，不保留旧转发壳。native/foreign或generated内容必须核对，而不是认为类型通过就够。
3. **owner与adapter接口**：能力合同、receipt返回词汇、预body授权位置、取消signal等，作为独立纵向变更；先用现有反例/生命周期测试锁住合同。多个AFTER针对同函数时按共同设计合并，不把提案片段直接串接。
4. **测试叙述与oracle**：fixture回归归属、named batches、native latch、diff validator独立期望。保留真实SQL/S3/Redis/官方Pi边界；测试更短不能靠更多mock或删除难测失败类别。
5. **合同变化另开决定**：Unicode准入、逐publication停止粒度、信号/退出码/cleanup异常归属。这些不是排版，必须先确认兼容和恢复方式；不会在“代码美化”提交中偷偷改变。

每批验收都是：读完整diff → 严格types/lint/format → 对应behavior regression → 所涉及的原生边界验证。`sh scripts/check.sh`、`sh scripts/database-check.sh test/verify`、storage与部署runner各有独立覆盖；本报告没有调用它们，更没有默许付费Cloud/模型/VM试验。

### 6.2 明确不建议

- 不迁移为Handover的本地机器check-in拓扑，不为了短handler放弃Redis durable receipt或SQL fence。
- 不先铺service/repository/interface目录，再找事情填；不为省三行引入generic state machine/budget/lifecycle框架。
- 不把每个single-use表达式都抽helper；让真实策略有名字，简单字面量可以留在原段落。
- 不按固定文件行数判罪；同owner内的凝聚流程可以长，拆坏事务/reader ownership更糟。
- 不删除未知后果隔离、历史identity/namespace、auth与bounds，也不以美观为由引入重试、退款、盲删或新identity。
- 不将报告中静态风险写成已复现漏洞；未类型检查的AFTER不能直接当可合并补丁。

### 6.3 一个应保留的正面实例

`decideMessageReplay`没有把授权、持久化和重放裁决混成框架。它明确区分未接受/conflict/返回durable identity；asset order与text空格都属于精确事实。这里的条件长度可以承担真实责任，不需要为了短函数名再拆一层。

[`apps/server/src/conversation/submission.ts:47–70`](../apps/server/src/conversation/submission.ts#L47)

```ts
// Call only after locking the requested thread. Replay IDs belong to the durable
// message, not the retry's candidates; authorization must precede this decision.
export function decideMessageReplay(
  intent: MessageIntent,
  message: AcceptedMessageFacts | null,
): SubmitIntentOutcome | null {
  if (message === null) return null
  if (
    message.threadID !== intent.threadID ||
    message.role !== 'user' ||
    message.text !== intent.text ||
    JSON.stringify(message.assetIDs ?? []) !==
      JSON.stringify(intent.assetIDs ?? []) ||
    message.commandID === null ||
    message.runID === null
  )
    return { kind: 'conflict' }
  return {
    kind: 'accepted',
    messageID: intent.messageID,
    commandID: message.commandID,
    runID: message.runID,
  }
}
```

也应保留原request-body reader的收尾owner、锁内terminal赢家裁决、S3单次尝试和独立test DB capability。下文读过却不建议改的文件不是漏审，而是不为了数量改坏已有边界。

## 7. 覆盖附录：全部冻结手写文件

完整阅读以连续区间证据为准；hash/line count检查本身不代表已阅读。下表合并代理完整body读取记录，未将outline、grep或截断read当覆盖。没有独立建议的文件不强行填一个问题。

| 文件                                                                                                                                                    | 行数 | 完整body读取区间                                                                                  | 审查结果/关联项                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs)                                                                                                 |   50 | 1–50                                                                                              | 已读；无独立改动建议。必要现有合同保留。 已记录具体保留理由。 保留实际parser驱动的cycle/unresolved/type-only owner规则，不换词汇扫描。 |
| [`.dockerignore`](../.dockerignore)                                                                                                                     |   16 | 1–16                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`.github/python/check.sh`](../.github/python/check.sh)                                                                                                 |   33 | 1–33                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`.github/verify-api.ts`](../.github/verify-api.ts)                                                                                                     |   42 | 1–42                                                                                              | [F027](#f027)                                                                                                                          |
| [`.github/workflows/ci.yaml`](../.github/workflows/ci.yaml)                                                                                             |  130 | 1–130                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`.gitignore`](../.gitignore)                                                                                                                           |   14 | 1–14                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`.oxlintrc.json`](../.oxlintrc.json)                                                                                                                   |   53 | 1–53                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`.prettierrc.json`](../.prettierrc.json)                                                                                                               |    5 | 1–5                                                                                               | [F028](#f028)                                                                                                                          |
| [`.yamllint.yaml`](../.yamllint.yaml)                                                                                                                   |    8 | 1–8                                                                                               | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/package.json`](../apps/agent/package.json)                                                                                                 |   18 | 1–18                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/commands.test.ts`](../apps/agent/src/commands.test.ts)                                                                                 |   53 | 1–53                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/commands.ts`](../apps/agent/src/commands.ts)                                                                                           |  124 | 1–124                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/db/command-acceptance.ts`](../apps/agent/src/db/command-acceptance.ts)                                                                 |  145 | 1–145                                                                                             | [F010](#f010)                                                                                                                          |
| [`apps/agent/src/db/event-outbox.ts`](../apps/agent/src/db/event-outbox.ts)                                                                             |   36 | 1–36                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/db/event-publication.ts`](../apps/agent/src/db/event-publication.ts)                                                                   |   84 | 1–84                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/db/execution-leases.ts`](../apps/agent/src/db/execution-leases.ts)                                                                     |  265 | 1–200, 201–265                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/db/run-writes.ts`](../apps/agent/src/db/run-writes.ts)                                                                                 |  253 | 1–200, 201–253                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/events.ts`](../apps/agent/src/events.ts)                                                                                               |   46 | 1–46                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/execute-run.sources.test.ts`](../apps/agent/src/execute-run.sources.test.ts)                                                           |   82 | 1–82                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/execute-run.test.ts`](../apps/agent/src/execute-run.test.ts)                                                                           | 1213 | 1–200, 201–400, 401–600, 601–800, 801–1000, 1001–1200, 1201–1213                                  | [F029](#f029)                                                                                                                          |
| [`apps/agent/src/execute-run.ts`](../apps/agent/src/execute-run.ts)                                                                                     |  560 | 1–200, 201–400, 401–560                                                                           | [F001](#f001), [F002](#f002), [F011](#f011), [F012](#f012), [F030](#f030), [F031](#f031), [F032](#f032)                                |
| [`apps/agent/src/harness/file-tools.ts`](../apps/agent/src/harness/file-tools.ts)                                                                       |   91 | 1–91                                                                                              | [F033](#f033)                                                                                                                          |
| [`apps/agent/src/harness/files.test.ts`](../apps/agent/src/harness/files.test.ts)                                                                       |  297 | 1–200, 201–297                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/harness/files.ts`](../apps/agent/src/harness/files.ts)                                                                                 |  115 | 1–115                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/harness/pi-history.ts`](../apps/agent/src/harness/pi-history.ts)                                                                       |  154 | 1–154                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/harness/pi.test.ts`](../apps/agent/src/harness/pi.test.ts)                                                                             | 1511 | 1–200, 201–400, 401–600, 601–800, 801–1000, 1001–1200, 1201–1400, 1401–1511                       | [F034](#f034), [F067](#f067)                                                                                                           |
| [`apps/agent/src/harness/pi.ts`](../apps/agent/src/harness/pi.ts)                                                                                       |  364 | 1–200, 201–364                                                                                    | [F003](#f003), [F013](#f013), [F014](#f014), [F035](#f035), [F036](#f036)                                                              |
| [`apps/agent/src/harness/web-search.test.ts`](../apps/agent/src/harness/web-search.test.ts)                                                             |  477 | 1–200, 201–400, 401–477                                                                           | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/harness/web-search.ts`](../apps/agent/src/harness/web-search.ts)                                                                       |  251 | 1–200, 201–251                                                                                    | [F037](#f037), [F038](#f038), [F039](#f039), [F040](#f040)                                                                             |
| [`apps/agent/src/main.ts`](../apps/agent/src/main.ts)                                                                                                   |   38 | 1–38                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/run-loop.test.ts`](../apps/agent/src/run-loop.test.ts)                                                                                 |  199 | 1–199                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/run-loop.ts`](../apps/agent/src/run-loop.ts)                                                                                           |  100 | 1–100                                                                                             | [F041](#f041), [F042](#f042)                                                                                                           |
| [`apps/agent/src/sandbox/e2b.test.ts`](../apps/agent/src/sandbox/e2b.test.ts)                                                                           |  342 | 1–200, 201–342                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/sandbox/e2b.ts`](../apps/agent/src/sandbox/e2b.ts)                                                                                     |  215 | 1–200, 201–215                                                                                    | [F015](#f015)                                                                                                                          |
| [`apps/agent/src/sandbox/native-command.test.ts`](../apps/agent/src/sandbox/native-command.test.ts)                                                     |  304 | 1–200, 201–304                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/sandbox/native-files.test.ts`](../apps/agent/src/sandbox/native-files.test.ts)                                                         |   80 | 1–80                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/sandbox/reference.test.ts`](../apps/agent/src/sandbox/reference.test.ts)                                                               |   36 | 1–36                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/sandbox/reference.ts`](../apps/agent/src/sandbox/reference.ts)                                                                         |   15 | 1–15                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/worker-health.test.ts`](../apps/agent/src/worker-health.test.ts)                                                                       |   26 | 1–26                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/worker-health.ts`](../apps/agent/src/worker-health.ts)                                                                                 |   23 | 1–23                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/agent/src/worker.test.ts`](../apps/agent/src/worker.test.ts)                                                                                     |   43 | 1–43                                                                                              | [F068](#f068)                                                                                                                          |
| [`apps/agent/src/worker.ts`](../apps/agent/src/worker.ts)                                                                                               |  328 | 1–200, 201–328                                                                                    | [F016](#f016), [F043](#f043), [F044](#f044), [F045](#f045), [F046](#f046), [F047](#f047)                                               |
| [`apps/server/package.json`](../apps/server/package.json)                                                                                               |   20 | 1–20                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/assets/files.test.ts`](../apps/server/src/assets/files.test.ts)                                                                       |  118 | 1–118                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/assets/files.ts`](../apps/server/src/assets/files.ts)                                                                                 |  109 | 1–109                                                                                             | [F048](#f048)                                                                                                                          |
| [`apps/server/src/assets/http.ts`](../apps/server/src/assets/http.ts)                                                                                   |  123 | 1–123                                                                                             | [F049](#f049)                                                                                                                          |
| [`apps/server/src/assets/uploads.ts`](../apps/server/src/assets/uploads.ts)                                                                             |   97 | 1–97                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/conversation/command-publication.ts`](../apps/server/src/conversation/command-publication.ts)                                         |   42 | 1–42                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/conversation/event-stream.ts`](../apps/server/src/conversation/event-stream.ts)                                                       |  356 | 1–200, 201–356                                                                                    | [F050](#f050)                                                                                                                          |
| [`apps/server/src/conversation/execution-events.ts`](../apps/server/src/conversation/execution-events.ts)                                               |   62 | 1–62                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/conversation/execution-receipts.test.ts`](../apps/server/src/conversation/execution-receipts.test.ts)                                 |   55 | 1–55                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/conversation/execution-receipts.ts`](../apps/server/src/conversation/execution-receipts.ts)                                           |   43 | 1–43                                                                                              | [F051](#f051)                                                                                                                          |
| [`apps/server/src/conversation/http.ts`](../apps/server/src/conversation/http.ts)                                                                       |  130 | 1–130                                                                                             | [F017](#f017)                                                                                                                          |
| [`apps/server/src/conversation/public-run-events.test.ts`](../apps/server/src/conversation/public-run-events.test.ts)                                   |  198 | 1–198                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/conversation/public-run-events.ts`](../apps/server/src/conversation/public-run-events.ts)                                             |  169 | 1–169                                                                                             | [F052](#f052), [F053](#f053)                                                                                                           |
| [`apps/server/src/conversation/submission.test.ts`](../apps/server/src/conversation/submission.test.ts)                                                 |  102 | 1–102                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/conversation/submission.ts`](../apps/server/src/conversation/submission.ts)                                                           |   82 | 1–82                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/db/accepted-start.ts`](../apps/server/src/db/accepted-start.ts)                                                                       |   15 | 1–15                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/db/assets.ts`](../apps/server/src/db/assets.ts)                                                                                       |  173 | 1–173                                                                                             | [F018](#f018)                                                                                                                          |
| [`apps/server/src/db/cancellations.ts`](../apps/server/src/db/cancellations.ts)                                                                         |  143 | 1–143                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/db/command-publication.ts`](../apps/server/src/db/command-publication.ts)                                                             |  103 | 1–103                                                                                             | [F019](#f019)                                                                                                                          |
| [`apps/server/src/db/conversations.ts`](../apps/server/src/db/conversations.ts)                                                                         |  266 | 1–200, 201–266                                                                                    | [F054](#f054), [F055](#f055), [F056](#f056)                                                                                            |
| [`apps/server/src/db/execution-events.ts`](../apps/server/src/db/execution-events.ts)                                                                   |  295 | 1–200, 201–295                                                                                    | [F057](#f057)                                                                                                                          |
| [`apps/server/src/db/legacy-thread-ownership.ts`](../apps/server/src/db/legacy-thread-ownership.ts)                                                     |   78 | 1–78                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/db/sessions.ts`](../apps/server/src/db/sessions.ts)                                                                                   |   18 | 1–18                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/db/submissions.ts`](../apps/server/src/db/submissions.ts)                                                                             |  231 | 1–200, 201–231                                                                                    | [F058](#f058), [F059](#f059)                                                                                                           |
| [`apps/server/src/db/thread-access.ts`](../apps/server/src/db/thread-access.ts)                                                                         |   34 | 1–34                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/http.test.ts`](../apps/server/src/http.test.ts)                                                                                       |   33 | 1–33                                                                                              | [F069](#f069)                                                                                                                          |
| [`apps/server/src/http.ts`](../apps/server/src/http.ts)                                                                                                 |  559 | 1–200, 201–400, 401–559                                                                           | [F004](#f004), [F005](#f005), [F020](#f020)                                                                                            |
| [`apps/server/src/identity/authentication.ts`](../apps/server/src/identity/authentication.ts)                                                           |  130 | 1–130                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/main.ts`](../apps/server/src/main.ts)                                                                                                 |   19 | 1–19                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/request-body.test.ts`](../apps/server/src/request-body.test.ts)                                                                       |  324 | 1–200, 201–324                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/request-body.ts`](../apps/server/src/request-body.ts)                                                                                 |  110 | 1–110                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/src/server.ts`](../apps/server/src/server.ts)                                                                                             |  287 | 1–200, 201–287                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`apps/server/tsconfig.json`](../apps/server/tsconfig.json)                                                                                             |    4 | 1–4                                                                                               | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`compose.yaml`](../compose.yaml)                                                                                                                       |  298 | 1–200, 201–298                                                                                    | [F006](#f006)                                                                                                                          |
| [`config/.env.example`](../config/.env.example)                                                                                                         |   91 | 1–91                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`deploy/Caddyfile`](../deploy/Caddyfile)                                                                                                               |   12 | 1–12                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`deploy/database.sql`](../deploy/database.sql)                                                                                                         |   49 | 1–49                                                                                              | 已读；无独立改动建议。必要现有合同保留。 已记录具体保留理由。                                                                          |
| [`deploy/docker/application.Dockerfile`](../deploy/docker/application.Dockerfile)                                                                       |   56 | 1–56                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`deploy/docker/checks.Dockerfile`](../deploy/docker/checks.Dockerfile)                                                                                 |   16 | 1–16                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`deploy/storage/server-policy.json`](../deploy/storage/server-policy.json)                                                                             |   20 | 1–20                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`deploy/storage/worker-policy.json`](../deploy/storage/worker-policy.json)                                                                             |   20 | 1–20                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`package.json`](../package.json)                                                                                                                       |   43 | 1–43                                                                                              | [F070](#f070)                                                                                                                          |
| [`packages/config/package.json`](../packages/config/package.json)                                                                                       |   11 | 1–11                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/config/src/env.test.ts`](../packages/config/src/env.test.ts)                                                                                 |  618 | 1–200, 201–400, 401–600, 601–618                                                                  | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/config/src/env.ts`](../packages/config/src/env.ts)                                                                                           |  211 | 1–200, 201–211                                                                                    | [F007](#f007), [F021](#f021)                                                                                                           |
| [`packages/contract/package.json`](../packages/contract/package.json)                                                                                   |   17 | 1–17                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/contract/src/execution-schema.test.ts`](../packages/contract/src/execution-schema.test.ts)                                                   |  102 | 1–102                                                                                             | [F071](#f071)                                                                                                                          |
| [`packages/contract/src/execution.test.ts`](../packages/contract/src/execution.test.ts)                                                                 |  326 | 1–200, 201–326                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/contract/src/execution.ts`](../packages/contract/src/execution.ts)                                                                           |  261 | 1–200, 201–261                                                                                    | [F008](#f008), [F009](#f009)                                                                                                           |
| [`packages/contract/src/failure-reason.ts`](../packages/contract/src/failure-reason.ts)                                                                 |    8 | 1–8                                                                                               | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/contract/src/file-name.test.ts`](../packages/contract/src/file-name.test.ts)                                                                 |   87 | 1–87                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/contract/src/file-name.ts`](../packages/contract/src/file-name.ts)                                                                           |   15 | 1–15                                                                                              | [F022](#f022)                                                                                                                          |
| [`packages/contract/src/http.test.ts`](../packages/contract/src/http.test.ts)                                                                           |  352 | 1–200, 201–352                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/contract/src/http.ts`](../packages/contract/src/http.ts)                                                                                     |  233 | 1–200, 201–233                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/contract/src/inbound.test.ts`](../packages/contract/src/inbound.test.ts)                                                                     |  204 | 1–200, 201–204                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/contract/src/sources.test.ts`](../packages/contract/src/sources.test.ts)                                                                     |   60 | 1–60                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/contract/src/web-source.test.ts`](../packages/contract/src/web-source.test.ts)                                                               |   80 | 1–80                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/contract/src/web-source.ts`](../packages/contract/src/web-source.ts)                                                                         |   58 | 1–58                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/database/migrations/20260601000000_product.sql`](../packages/database/migrations/20260601000000_product.sql)                                 |   38 | 1–38                                                                                              | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/migrations/20260602000000_execution.sql`](../packages/database/migrations/20260602000000_execution.sql)                             |   61 | 1–61                                                                                              | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/migrations/20260603000000_public_execution_events.sql`](../packages/database/migrations/20260603000000_public_execution_events.sql) |   25 | 1–25                                                                                              | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/migrations/20261004000000_identity.sql`](../packages/database/migrations/20261004000000_identity.sql)                               |   64 | 1–64                                                                                              | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/migrations/20261004001000_account_identity.sql`](../packages/database/migrations/20261004001000_account_identity.sql)               |   10 | 1–10                                                                                              | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/migrations/20261004010000_thread_identity.sql`](../packages/database/migrations/20261004010000_thread_identity.sql)                 |   21 | 1–21                                                                                              | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/migrations/20261004020000_thread_workspace.sql`](../packages/database/migrations/20261004020000_thread_workspace.sql)               |    6 | 1–6                                                                                               | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/migrations/20261004030000_product_files.sql`](../packages/database/migrations/20261004030000_product_files.sql)                     |   44 | 1–44                                                                                              | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/migrations/20261004040000_assets.sql`](../packages/database/migrations/20261004040000_assets.sql)                                   |   79 | 1–79                                                                                              | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/migrations/20261004050000_native_sandbox.sql`](../packages/database/migrations/20261004050000_native_sandbox.sql)                   |   27 | 1–27                                                                                              | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/migrations/20261005000000_receipt_publication.sql`](../packages/database/migrations/20261005000000_receipt_publication.sql)         |   20 | 1–20                                                                                              | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/migrations/20261005010000_message_sources.sql`](../packages/database/migrations/20261005010000_message_sources.sql)                 |    7 | 1–7                                                                                               | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/migrations/20261006000000_relational_integrity.sql`](../packages/database/migrations/20261006000000_relational_integrity.sql)       |   47 | 1–47                                                                                              | 已读；历史迁移保持不可变，保留原schema/identity/retained位置演进证据。                                                                 |
| [`packages/database/package.json`](../packages/database/package.json)                                                                                   |   22 | 1–22                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/database/src/connection.ts`](../packages/database/src/connection.ts)                                                                         |   33 | 1–33                                                                                              | 已读；无独立改动建议。必要现有合同保留。 已记录具体保留理由。 保留native pg Pool/public hooks与当前max8，不加未经测量的新开关。        |
| [`packages/object-storage/package.json`](../packages/object-storage/package.json)                                                                       |   11 | 1–11                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/object-storage/src/index.ts`](../packages/object-storage/src/index.ts)                                                                       |    1 | 1–1                                                                                               | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`packages/object-storage/src/objects.test.ts`](../packages/object-storage/src/objects.test.ts)                                                         |   72 | 1–72                                                                                              | [F072](#f072)                                                                                                                          |
| [`packages/object-storage/src/objects.ts`](../packages/object-storage/src/objects.ts)                                                                   |  102 | 1–102                                                                                             | 已读；无独立改动建议。必要现有合同保留。 保留assigned key、IfNoneMatch、maxAttempts:1与bounded stream owner。                          |
| [`scripts/assign-legacy-threads.ts`](../scripts/assign-legacy-threads.ts)                                                                               |   41 | 1–41                                                                                              | [F023](#f023)                                                                                                                          |
| [`scripts/check-lifecycle.sh`](../scripts/check-lifecycle.sh)                                                                                           |   42 | 1–42                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`scripts/check.sh`](../scripts/check.sh)                                                                                                               |   36 | 1–36                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`scripts/database-check.sh`](../scripts/database-check.sh)                                                                                             |  141 | 1–141                                                                                             | [F024](#f024)                                                                                                                          |
| [`scripts/generate-api.test.ts`](../scripts/generate-api.test.ts)                                                                                       |   64 | 1–64                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`scripts/generate-api.ts`](../scripts/generate-api.ts)                                                                                                 |   86 | 1–86                                                                                              | [F060](#f060)                                                                                                                          |
| [`scripts/generate-database.sh`](../scripts/generate-database.sh)                                                                                       |   18 | 1–18                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`scripts/reconcile-deliveries.ts`](../scripts/reconcile-deliveries.ts)                                                                                 |   85 | 1–85                                                                                              | 已读；无独立改动建议。必要现有合同保留。 已记录具体保留理由。                                                                          |
| [`scripts/sandbox-check.sh`](../scripts/sandbox-check.sh)                                                                                               |  130 | 1–130                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/integration/administration.test.ts`](../tests/integration/administration.test.ts)                                                               |  113 | 1–113                                                                                             | [F073](#f073)                                                                                                                          |
| [`tests/integration/assets-migration.test.ts`](../tests/integration/assets-migration.test.ts)                                                           |  601 | 1–200, 201–400, 401–600, 601–601                                                                  | [F074](#f074)                                                                                                                          |
| [`tests/integration/authentication-fixture.ts`](../tests/integration/authentication-fixture.ts)                                                         |   72 | 1–72                                                                                              | 已读；无独立改动建议。必要现有合同保留。 已记录具体保留理由。 保留官方Better Auth生成/签名真实session，不造cookie旁路。                |
| [`tests/integration/command-publication.test.ts`](../tests/integration/command-publication.test.ts)                                                     |  352 | 1–200, 201–352                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/integration/command-relay.test.ts`](../tests/integration/command-relay.test.ts)                                                                 |   92 | 1–92                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/integration/connection.test.ts`](../tests/integration/connection.test.ts)                                                                       |  164 | 1–164                                                                                             | 已读；无独立改动建议。必要现有合同保留。 已记录具体保留理由。                                                                          |
| [`tests/integration/conversation-http.test.ts`](../tests/integration/conversation-http.test.ts)                                                         | 1859 | 1–200, 201–400, 401–600, 601–800, 801–1000, 1001–1200, 1201–1400, 1401–1600, 1601–1800, 1801–1859 | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/integration/database-fixture.ts`](../tests/integration/database-fixture.ts)                                                                     |   95 | 1–95                                                                                              | 已读；无独立改动建议。必要现有合同保留。 已记录具体保留理由。                                                                          |
| [`tests/integration/database.test.ts`](../tests/integration/database.test.ts)                                                                           |  197 | 1–197                                                                                             | [F075](#f075)                                                                                                                          |
| [`tests/integration/delivery-reconciliation.test.ts`](../tests/integration/delivery-reconciliation.test.ts)                                             |  235 | 1–200, 201–235                                                                                    | 已读；无独立改动建议。必要现有合同保留。 已记录具体保留理由。                                                                          |
| [`tests/integration/execute-run.test.ts`](../tests/integration/execute-run.test.ts)                                                                     |  509 | 1–200, 201–400, 401–509                                                                           | [F076](#f076), [F077](#f077)                                                                                                           |
| [`tests/integration/execution-events.test.ts`](../tests/integration/execution-events.test.ts)                                                           |  566 | 1–200, 201–400, 401–566                                                                           | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/integration/execution-store.test.ts`](../tests/integration/execution-store.test.ts)                                                             |  865 | 1–200, 201–400, 401–600, 601–800, 801–865                                                         | [F078](#f078)                                                                                                                          |
| [`tests/integration/execution-transport.test.ts`](../tests/integration/execution-transport.test.ts)                                                     |  817 | 1–200, 201–400, 401–600, 601–800, 801–817                                                         | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/integration/fixture-ownership.test.ts`](../tests/integration/fixture-ownership.test.ts)                                                         |  123 | 1–123                                                                                             | 已读；无独立改动建议。必要现有合同保留。 已记录具体保留理由。                                                                          |
| [`tests/integration/history-budget.test.ts`](../tests/integration/history-budget.test.ts)                                                               |  221 | 1–200, 201–221                                                                                    | 已读；无独立改动建议。必要现有合同保留。 已记录具体保留理由。                                                                          |
| [`tests/integration/identity.test.ts`](../tests/integration/identity.test.ts)                                                                           |  351 | 1–200, 201–351                                                                                    | 已读；无独立改动建议。必要现有合同保留。 已记录具体保留理由。                                                                          |
| [`tests/integration/postgres-proxy-fixture.ts`](../tests/integration/postgres-proxy-fixture.ts)                                                         |   76 | 1–76                                                                                              | [F079](#f079)                                                                                                                          |
| [`tests/integration/public-sources.test.ts`](../tests/integration/public-sources.test.ts)                                                               |  298 | 1–200, 201–298                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/integration/redis.test.ts`](../tests/integration/redis.test.ts)                                                                                 |  148 | 1–148                                                                                             | [F080](#f080)                                                                                                                          |
| [`tests/integration/relational-integrity.test.ts`](../tests/integration/relational-integrity.test.ts)                                                   |  397 | 1–200, 201–397                                                                                    | [F061](#f061)                                                                                                                          |
| [`tests/integration/run-scoped-observation.test.ts`](../tests/integration/run-scoped-observation.test.ts)                                               |  319 | 1–200, 201–319                                                                                    | [F081](#f081)                                                                                                                          |
| [`tests/integration/runtime.test.ts`](../tests/integration/runtime.test.ts)                                                                             |  986 | 1–200, 201–400, 401–600, 601–800, 801–986                                                         | [F062](#f062), [F082](#f082), [F083](#f083)                                                                                            |
| [`tests/integration/submission.test.ts`](../tests/integration/submission.test.ts)                                                                       |  541 | 1–200, 201–400, 401–541                                                                           | [F063](#f063)                                                                                                                          |
| [`tests/integration/thread-lifecycle.test.ts`](../tests/integration/thread-lifecycle.test.ts)                                                           |  783 | 1–200, 201–400, 401–600, 601–783                                                                  | [F084](#f084), [F085](#f085)                                                                                                           |
| [`tests/integration/worker-health.test.ts`](../tests/integration/worker-health.test.ts)                                                                 |  580 | 1–200, 201–400, 401–580                                                                           | 已读；无独立改动建议。必要现有合同保留。 已记录具体保留理由。                                                                          |
| [`tests/sandbox/e2b.test.ts`](../tests/sandbox/e2b.test.ts)                                                                                             |  617 | 1–200, 201–400, 401–600, 601–617                                                                  | [F025](#f025)                                                                                                                          |
| [`tests/sandbox/native-restart.test.ts`](../tests/sandbox/native-restart.test.ts)                                                                       |  127 | 1–127                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/sandbox/restart-check.sh`](../tests/sandbox/restart-check.sh)                                                                                   |   82 | 1–82                                                                                              | [F026](#f026)                                                                                                                          |
| [`tests/scripts/architecture.test.ts`](../tests/scripts/architecture.test.ts)                                                                           |  200 | 1–200                                                                                             | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/scripts/ci-policy.test.ts`](../tests/scripts/ci-policy.test.ts)                                                                                 |   58 | 1–58                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/scripts/database-project.test.ts`](../tests/scripts/database-project.test.ts)                                                                   |   42 | 1–42                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/scripts/deployment-boundaries.test.ts`](../tests/scripts/deployment-boundaries.test.ts)                                                         |  328 | 1–200, 201–328                                                                                    | [F080](#f080)                                                                                                                          |
| [`tests/scripts/deployment-check.sh`](../tests/scripts/deployment-check.sh)                                                                             |  178 | 1–178                                                                                             | [F064](#f064)                                                                                                                          |
| [`tests/scripts/deployment-web.test.ts`](../tests/scripts/deployment-web.test.ts)                                                                       |   18 | 1–18                                                                                              | [F086](#f086)                                                                                                                          |
| [`tests/scripts/process-diagnostics.test.ts`](../tests/scripts/process-diagnostics.test.ts)                                                             |   74 | 1–74                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/scripts/production-runtime.test.ts`](../tests/scripts/production-runtime.test.ts)                                                               |  244 | 1–200, 201–244                                                                                    | [F065](#f065), [F087](#f087)                                                                                                           |
| [`tests/scripts/proxy-deadline.test.ts`](../tests/scripts/proxy-deadline.test.ts)                                                                       |   21 | 1–21                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/scripts/reconciliation-cli.test.ts`](../tests/scripts/reconciliation-cli.test.ts)                                                               |   31 | 1–31                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/scripts/storage-initialization.test.ts`](../tests/scripts/storage-initialization.test.ts)                                                       |  225 | 1–200, 201–225                                                                                    | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tests/storage/assets.test.ts`](../tests/storage/assets.test.ts)                                                                                       | 1083 | 1–200, 201–400, 401–600, 601–800, 801–1000, 1001–1083                                             | [F066](#f066), [F088](#f088)                                                                                                           |
| [`tests/storage/objects.test.ts`](../tests/storage/objects.test.ts)                                                                                     |   88 | 1–88                                                                                              | 已读；无独立改动建议。必要现有合同保留。                                                                                               |
| [`tsconfig.json`](../tsconfig.json)                                                                                                                     |   38 | 1–38                                                                                              | [F089](#f089)                                                                                                                          |

### 7.1 实际参考读取范围

参考完整读取与用于cross-check的局部范围分开列出；不声明参考仓库全库审计。下列并集也包含逐项直接引证区间。

| 参考路径                                          | 已记录读取/引证区间 |
| ------------------------------------------------- | ------------------- |
| `.github/workflows/check.yml`                     | 1–26                |
| `.prettierrc`                                     | 1–6                 |
| `AGENTS.md`                                       | 1–87                |
| `Dockerfile`                                      | 1–48                |
| `apps/cli/src/agents/agent.ts`                    | 1–162               |
| `apps/cli/src/agents/claude-code.spec.ts`         | 1–166               |
| `apps/cli/src/agents/claude-code.ts`              | 1–401               |
| `apps/cli/src/agents/codex-app-server.ts`         | 1–178               |
| `apps/cli/src/agents/codex.ts`                    | 1–539               |
| `apps/cli/src/agents/known-agents.ts`             | 1–55                |
| `apps/cli/src/answering.ts`                       | 1–499               |
| `apps/cli/src/checking-in.ts`                     | 1–403               |
| `apps/cli/src/main.ts`                            | 1–405               |
| `apps/cli/src/sleeping.ts`                        | 14–31               |
| `apps/server/scripts/generate.ts`                 | 1–44                |
| `apps/server/scripts/run-command.ts`              | 1–47                |
| `apps/server/src/conversation/busy.ts`            | 23–32               |
| `apps/server/src/db/across-instances.spec.ts`     | 1–441               |
| `apps/server/src/db/connection.ts`                | 1–49                |
| `apps/server/src/db/conversation.spec.ts`         | 1–150               |
| `apps/server/src/db/conversation.ts`              | 1–939               |
| `apps/server/src/db/notifications.spec.ts`        | 1–90                |
| `apps/server/src/db/sign-in.spec.ts`              | 1–215               |
| `apps/server/src/db/watching.spec.ts`             | 1–117               |
| `apps/server/src/env.ts`                          | 1–171               |
| `apps/server/src/identity/handshake.spec.ts`      | 1–47                |
| `apps/server/src/object-store.spec.ts`            | 1–30                |
| `apps/server/src/object-store.ts`                 | 1–114               |
| `apps/server/src/server/avatar-api.spec.ts`       | 1–87                |
| `apps/server/src/server/conversation-api.spec.ts` | 1–550               |
| `apps/server/src/server/conversation-api.ts`      | 1–561               |
| `apps/server/src/server/route.ts`                 | 1–486               |
| `compose.yml`                                     | 1–56                |
| `deploy/compose.yml`                              | 1–111               |
| `docs/code-style.md`                              | 1–548               |
| `package.json`                                    | 1–47                |
| `rules/clocks.spec.ts`                            | 1–52                |
| `rules/contract.spec.ts`                          | 1–56                |
| `rules/generated.spec.ts`                         | 1–61                |
| `rules/imports.spec.ts`                           | 1–68                |

## 8. 复核、拒绝候选与验证边界

- **未计入：取消后的拒绝断言应纳入测试的 awaited completion**。父审查读到当前Bun1.4.2实际test.d.ts:936 `rejects: Matchers<unknown>`，1421 `toThrow(...): void`。建议await matcher没有合适的thenable静态合同，会与type-aware await-thenable冲突；未提供runner假绿复现，因此不计为有效改进点。不能套用Jest/Vitest经验断言Bun此写法不受监督。
- **未计入：把固定native pool预算改为新增跨进程配置开关**。没有connection压力测量或未覆盖部署需求证明。当前max8是已显式选择的预算；新增跨process/schema/Compose/administration开关增加维护面，不能仅因为参考有参数就判为必须改善。保留默认native Pool选择。
- **未计入：MIME verifier 的不存在分支先退出，再显示真正验证动作**。这里只有一层exists ternary和一个短验证动作，没有复杂嵌套。强行统一early-return增加行数且缺少独立阅读痛点；不是每个合法ternary都应改成卫语句，因此不按此处凑一条。
- **未计入：为未关闭的native GET增加caller-abort验收候选**。50ms timer从server生产body开始，但不证明SDK已进入body iteration；在read若不settle时finally也不会立即执行。该候选不能作为独立stream-abort验收证据，需先有可观察stage和failure-path owner。保留未来调查线索，不计入本次独立建议数。
- sanitizer实体表与净化/截断阶段收束合为一个改动；Redis与SQL并发fixture接入合为一个owner问题，不按backend凑数。两段terminal循环保留completed先、cancelled后覆盖顺序，不采用未经证明的一遍交错loop。
- 重叠范围复核：contract搬迁与terminal adapter receipt词汇是独立设计点，但实施时共享一个contract diff；PUT header/attempt证明与stream-abort时序不同，后者因提案证据不足已拒绝。未证明的malformed runtime诊断候选也未计入。
  静态证据文件：`/tmp/handover-review-inventory.json`、`/tmp/handover-review-all-coverage.json`、`/tmp/handover-review-validation.json`、`/tmp/handover-review-final-checks.json`。这些是本机复核产物，不是业务依赖或提交目标。
- 所有BEFORE与reference片段由固定行区间机械提取并验证边界；171个authored文件的SHA-256与冻结清单逐一核对。外部原始原因和真实config秘密没有被作为报告数据读取。
- AFTER做了语法/100列格式复核，局部属性、case和成员使用标明的上下文wrapper；这不是typecheck。shell片段按原上下文做`sh -n` / `bash -n`，没有运行其SSH/Docker/网络命令。具体检查计数见下段。
- 本次没有运行项目tests、lint、typecheck、Docker/VM、OAuth/模型/媒体供应商旅程，也没有实施任何AFTER。业务正确性由未来实施阶段按各项列出的验证要求承担。

### 8.1 实际机械检查结果

- 冻结版本：当前仓库01b1f17760a8fd12c7cb18ac4100ac6721d6c6bb；reference 901e1afb55c3973adac1626915015a6160e52356，fresh git rev-parse核对
- 冻结source/hash与body coverage：171/171文件，32162行；连续≤200行page记录与SHA-256逐一核对，0错误
- 独立建议与必填字段：89项，IDs唯一，BEFORE/reference/additional-source范围合法，0占位补丁
- AFTER语法与100列格式：115个TypeScript/JSON/YAML片段，{'json': 3, 'typescript': 111, 'yaml': 1}；全部解析，0未解析；未类型检查
- shell语法：6个sh/Bash片段通过对应shell -n；仅解析，没有执行正文
- 行为验收：未运行项目tests/lint/typecheck、Docker/VM、OAuth/paid provider/model旅程；AFTER未实施
- 报告完整性与格式：89个编号与章节完整；171个coverage row各一次；284个code fence保留，BEFORE/reference/AFTER逐块与固定输入精确一致；表格连续，local links/anchors有效；Markdown解析与formatter稳定检查通过
- pi-lens主动LSP限制：已对报告请求active path probe；报告超过5000行限制，结果too_large，未确认LSP检查通过。Markdown/片段独立解析与机械验证不受此限制；不将0 diagnostics当LSP clean。

**交付计数**：89个独立项；171/171冻结手写文件、32,162行完整阅读。未实施业务改动，未改用户UI；只交付本静态对照报告。
