# 外部 Harness 与 Sandbox 边界再调研

> 历史研究：以下“未修改生产/未调用付费模型”指当时的实验阶段，不描述当前源码。后续已选择 Pi 1.0.1 与 OpenAI Agents SDK 0.19.0 的独立 worker 内 harness；Pi durable、Codex/Claude 等探针保留但未作为生产 runtime。当前实现、真实请求失败和恢复验收边界见 [native-agent-runtime.md](native-agent-runtime.md)。

## 结论与状态

此次调研撤回“为了持久化原生会话，把完整 harness 放入业务 sandbox”的方案。**Agent loop、原生会话和受信配置留在现有 Agent worker；sandbox 是命令、文件与任务的隔离环境。** 新 harness 不应被迫随 sandbox 安装、挂起、销毁和恢复。

这不是宣称所有 SDK 已经具有相同的远端环境接口，也不是新框架选型完成。本轮核查了正式发布包、发布标签、公开接口和官方示例，并完成 Pi 1.0.1 的受控 loopback 模型/工具与进程 SIGKILL 探针（见第 8 节），以及发布版 Runtime 核查和 Pi durable 的受控故障探针（见第 9 节）；没有调用付费模型或真实 E2B，没有修改生产代码或安装新项目依赖。

主要证据：本项目 Pi **1.0.1**；从 npm 获取并验证 SHA-512 integrity 的 Claude Agent SDK **0.3.292**、Codex SDK **0.160.1**；Codex 对应 `rust-v0.160.1` 发布标签。上游 `main`、示例和实验接口另外标记，不冒充这些版本的生产保证。

## 1. 之前的错误

三个不同问题被混成了一个：

1. 原生会话需要持续保存，而不是整轮成功后再返回 history。
2. 会话文件不能只依赖随部署消失的 worker 临时文件系统。
3. 模型生成的代码和 workspace 文件操作需要在隔离环境执行。

前两项要求执行服务有独立状态存储，第三项要求工具远端执行；**它们不推出 harness 必须进入 sandbox，也不推出 transcript 必须与 workspace 同卷。** 把原生状态放在 worker 挂载的持久盘，与放在 worker 临时 rootfs 上，故障语义不同。

## 2. 正确的责任边界

```text
产品服务
  接受、归属、授权、预算、取消、交付
          │
          ▼
现有 Agent worker
  Pi / Claude / Codex 原生 loop、会话、compaction、输入控制
          ├── 原生会话的独立持久存储
          ├── 受信 Skills / 配置 / 业务 MCP 接入
          │
          └── 原生远端执行接口或受限工具接入
                         │
                         ▼
                被授权的 Sandbox
                  命令、文件、进程 / 外部任务
                         │
                         └── workspace 的独立持久存储 / 恢复点
```

本文的“执行服务”指现有 Agent worker 承担的受信执行职责，不是建议另建一个服务。具体部署按被验证的 runtime 决定，不因为改名多建一层转发服务。业务 sandbox 不能获得执行服务的数据库、会话目录、operator home 或长期凭据。

受信 harness 读取自己的会话、配置和 Skills，不等于给模型任意访问宿主机的能力。模型命令、模型控制的文件路径以及隐式运行路径必须分别审查。remote 接口失效时应失败关闭，不能回落到宿主机。

环境变更只改变工具使用的授权环境，不替换原生对话身份。切换 provider 应集中在环境接入处，而不是三个 harness 分别直接持有 E2B 分配、TTL、快照和删除策略。保留原生能力差异，不创造一个万能 harness/sandbox 协议。

## 3. 原生接口核查

### Pi：已经有明确的远端工具边界

本项目 1.0.1 的公开导出包括：

- `ReadOperations`、`WriteOperations`、`EditOperations`、`BashOperations`；
- 工具 factory 的 `operations` 参数；
- `SessionManager.create(cwd, sessionDir)` 与 `open()`。

随包 `examples/extensions/ssh.ts` 明确示范：Pi 留在本地，read/write/edit/bash 转到远端。由此可以保留原生工具逻辑与 Agent loop，仅接入实际文件/命令操作；会话目录仍在执行服务的独立持久文件系统上。

**示例不能原样当生产适配器。** 它在未配置 SSH 时回落本地；只覆盖部分工具；停止本地 SSH 客户端不证明远端进程已停止。路径转换、输出限制、取消收尾、用户 `!` 命令及扩展/Skills 的宿主执行必须核查。我们当前自定义 sandbox 工具也不因存在 factory 就自动合格，应比较它承担的业务语义与原生 factory，做必要的最小替换。

Pi 的普通 `SessionManager` 接口不等于可任意注入 Postgres/S3 后端。持续 JSONL 是会话持久化，不是未完成工具、排队 steer 和付费副作用的 durable execution；这些仍在核心验证门槛中。

### Claude：正式包已提供远端 MCP 与原生名称转向

0.3.292 的 `Options` 有：

- `mcpServers`：接入外部工具；
- `tools`：选择内置工具，`[]` 可关闭内置集合；
- `disallowedTools`：禁止工具；
- `toolAliases`：把模型发出的工具名称转到另一工具。

发布包的注释直接举例：`{ Bash: 'mcp__workspace__bash' }`，供宿主把 Bash 放到远端 sandbox 执行。**这条接口无需把 Claude Code 子进程搬进业务 sandbox，也无需自己重写 Claude loop。**

不过 `toolAliases` 只作用于模型发出的名称查找；SDK 明确要求配合禁止本地工具，因为 harness 内部可能直接持有工具对象。`allowedTools` 只是自动批准列表，不是工具可见性白名单。具体禁止/alias 组合还要验证，不根据字段存在断言安全或兼容。

0.3.290 的 changelog 刚修复 alias 与 wildcard/deny 规则的交互。这强化了固定版本和负向测试要求。不能靠 `PreToolUse` 里执行一次远端命令、再让内置 Bash 执行一次来“转发”；也不把 `spawnClaudeCodeProcess` 迁移子进程当作控制面/执行面分离。

代价必须明说：远程 MCP 工具不自动继承 Claude 原生文件 checkpoint、PTY/后台任务及所有 Skills 预处理语义。子 agent、Skills、hooks、命令预处理等隐式路径也须证明没有宿主执行或权限绕过，不能只测试顶层 Bash。

### Codex：已有独立 executor，但不是通用接口

`rust-v0.160.1` 发布标签的 `exec-server` 是进程/文件 RPC 服务，不是 Agent loop。其 API 包括 `process/start/read/write/terminate` 与 `fs/*`；对应环境 provider 读取 `CODEX_EXEC_SERVER_URL`。选中 remote 时，该 provider 的源码不默认加入 local environment。

因此有一条原生分离路径：**Codex harness 在外，exec-server 在隔离环境，原生会话留在 harness 所在主机。** 0.160.1 TypeScript SDK 提供 `env` 和 CLI config，但没有 Pi 式的 JavaScript operations 注入或公开 ThreadStore 后端参数。SDK 通过 `codex exec` 启动 CLI；env 传递能力不等于已经验证该 SDK 全部工具在 remote 下正确工作。

必须保留的限制：

- exec-server 是 Codex 专用协议/二进制，仍有版本和环境适配耦合；不能包装后宣称三个 harness 共用完全等价的原生 executor。
- 外部环境的实际隔离必须由基础设施落实；`externalSandbox` 名字本身不提供隔离。
- 发布 README 写明连接关闭会终止该连接托管的进程；不能据此承诺 worker 崩溃后长命令仍继续。重连/保留 session 与具体断连清理的实现需进一步对齐验收。
- Caller-chosen process ID 与拒绝重复 ID 有其连接/session 范围，不等于跨进程 exactly-once 或付费任务 ledger。
- 文件操作、patch、搜索、图片、子 agent 和连接失效须分别做 fail-closed 验证，不能拿一个远程 shell 成功证明全部原生工具。

### 能力小结

| Harness        | 外部 loop 的原生接入依据            | 状态持久化依据                        | 尚未证明                                         |
| -------------- | ----------------------------------- | ------------------------------------- | ------------------------------------------------ |
| Pi 1.0.1       | 工具 operations 与随包 SSH 示例     | 指定 sessionDir 的原生 JSONL          | 全工具隔离、未完成输入/工具恢复、跨节点单 writer |
| Claude 0.3.292 | 外部 MCP、toolAliases、工具禁用     | 原生配置目录；另有 alpha SessionStore | 内部路径隔离、远程工具完整性、镜像故障保证       |
| Codex 0.160.1  | 发布标签中的 exec-server 与环境选择 | 原生 JSONL + SQLite metadata          | SDK 全链路 remote、断连/长任务、物理 fencing     |

## 4. 会话到底放哪里

**优先验证的基线候选：外部执行服务挂载独立持久文件存储，SDK 直接保存自己的原生状态。** 它不绑定 sandbox provider，也不是新增私有 transcript 数据库。

- Pi：显式 sessionDir 与具体会话文件定位；不再正常使用 in-memory manager/history 往返。
- Claude：租户隔离的 `CLAUDE_CONFIG_DIR`，保留所启用能力需要的原生文件；固定宿主 context 路径，不能把 guest 的 cwd 字符串误当宿主目录。
- Codex：独立 `CODEX_HOME`；必要 SQLite 目录若另配也须持久化。原生 ThreadStore 文档将 JSONL 作为 canonical history、SQLite 作为可查询 metadata，不把 ID 当备份。

这是候选而非已验收部署。要证明挂载能跨容器/节点重建、写入/flush 的故障范围、加密/保留策略与旧 writer 的实际停止。原生状态含 SQLite 时，不能随意选 NFS/FUSE、复制一个活跃数据库文件或把 S3 挂载当普通可靠磁盘；存储须满足该发行版的实际文件系统要求。只保留 `*.jsonl` 而漏掉必要子会话/元数据也不合格。

独立状态不要求把所有数据塞到现有业务 PostgreSQL。产品数据库仍保存授权、定位与交付事实；原生状态用各引擎的格式。Credentials 与原生状态的存储授权分开，不复制 operator home。

### 原生远端存储 backend 的真实边界

Claude 0.3.292 确实发布了 `SessionStore`，但类型将它标为 **alpha**，而且是本地成功写入后的**镜像**：

- 本地写入仍然必须开启；不是 diskless runtime。
- 默认 `sessionStoreFlush='batched'` 在轮末或阈值 flush；`eager` 是后台尽早提交，不是同步 commit barrier。
- append 最终失败会丢弃该批次、发 `mirror_error`，子进程继续。因此不能只用它承诺 worker 丢失后零缺口恢复。
- S3/Redis/Postgres adapters 位于官方 `examples/`，README 明确：未发布、不是受维护生产代码、未进入该 repo 的 CI。不是安装一个现成生产存储驱动。

Codex Rust 有 ThreadStore trait，但不能因此宣称 TypeScript SDK 能传入自己的数据库实现。Pi durable/Cloudflare adapter 是另外的 runtime/storage 选择，仍需兼容性、成熟度和单恢复 owner 验证，不因普通 sessionDir 的位置问题默认引入。

本轮因此不选 per-event 对象存储同步，也不选新的 SQL replay engine。若执行服务的原生磁盘存储不能满足实际目标，再依据缺口评估已有 backend/runtime；不能靠镜像隐藏未知丢失窗口。

## 5. 社区实现的交叉核对

- **OpenAI Agents SDK** 的官方 runtime-boundary 明确将 Runner 的 turns/history/RunState 与 sandbox 的 workspace/process/provider state 分开，并要求分别定义 resume/cleanup。这支持责任分离，但不是 Pi/Claude/Codex 三个原生 SDK 已经通用化的证明。
- **Vercel `@ai-sdk/harness-pi` 的 main README** 明确：Pi 运行在宿主 Node，sandbox 是 remote filesystem + shell，无需 guest bridge。它是直接的外部 Pi 先例；本轮仅核查 README，未验证其持久化实现或发布兼容性，不据此选框架。
- **同仓库 Claude adapter 的 main README** 却明确在 guest bridge 中安装 SDK 与 Claude CLI。它不符合本次边界，不能因为一个库列出三个 harness 就整套采纳。

搜索摘要中混入了 Claude Managed Agents、MCP connector、OpenAI Agents API、普通 SDK 与社区 adapter。它们不是同一个产品或能力。上述结论以实际发布文件/源文档为准，不接受搜索生成的统一架构建议。

## 6. 分开存储后如何恢复

| 故障                | 要恢复的权威状态                                 | 不能误做的事                                      |
| ------------------- | ------------------------------------------------ | ------------------------------------------------- |
| worker/执行服务崩溃 | 原生会话存储、输入接受事实、执行权；核对远端任务 | 重开 session 后盲重放未知工具；假定旧 worker 已停 |
| sandbox pause/重启  | workspace、环境连接与存活任务                    | 重新创建 Agent 对话；把冷启动称进程恢复           |
| sandbox 确认销毁    | 独立 workspace 卷/恢复点，随后重绑工具环境       | 新建空目录假装恢复；把会话日志当文件备份          |
| 独立状态存储丢失    | 其实际备份/恢复策略                              | 拿任意 workspace 快照推导完整原生会话             |
| 工具成功但回执丢失  | 原 operation/job 身份与实际远端结果              | 再发一次付费请求或把预算清零                      |

两份持久状态没有跨系统原子事务，这是必须暴露的事实，不是把它们放回同一 VM 就能消掉的缺口。恢复点比 transcript 旧时，需要明确判断可否继续；SQL fence 不能物理阻止旧远端任务。

MCP 解决工具连接，不自动解决 durable execution。后台命令、跨部署长任务、取消和外部 paid job 仍需原生/provider 的具体身份与实际故障验证，不另起通用任务管理器补承诺。

## 7. 下一步与选择门槛

1. **先验证 Pi 外部纵向链路。** 固定 1.0.1，用受控模型，SDK 留在受信进程，工具指向自有隔离环境，会话保存到独立状态目录。分别杀 harness、断工具连接、重建环境；检查原生 ID、已完成结果与未知操作。
2. **验证部署存储，而非路径字符串。** 验证写入窗口、容器更换/节点迁移、单 writer 与旧进程实际停止；workspace 销毁重建是独立验收。
3. **Claude/Codex 分别做固定版本接入验证。** Claude 验证 alias/禁用工具/子 agent/Skills；Codex 验证 native remote executor 的实际工具覆盖和断连行为。与 Pi 不同的能力如实暴露。
4. **然后才选生产路径与必要依赖。** 某原生 SDK 不能满足外部执行边界时，报告缺口并决定替代接入或暂不提供该能力，不默认把整个 harness 塞进 guest。

停工条件：任何本地执行 fallback、会话与 sandbox 生命周期重新绑定、镜像被当零丢失存储、两个 owner 重放同一任务、或者为了统一三种 SDK 新建框架。

## 8. Pi 外部 Worker 的第一轮实证

固定镜像使用 Bun 1.4.2、Node 24.21.0 和项目 Pi 1.0.1；Docker `--network none`，仅容器内 loopback。当前 adapter/tools 与安装版 session-manager 的 SHA-256 与工作区文件逐项核对。探针复用实际工具定义，工具调用通过 HTTP 到受控端点；native 模式只用公开 SDK 构造持续会话，没有改供应商代码。

故障过程：模型要求写文件 → 工具返回并保存 → 模型要求第二个工具 → 端点保存受控副作用但不发回执 → 在工具期间调用原生 steer 并取得 `queued` → 确认检查点后 SIGKILL worker（退出 137）→ 新进程打开文件 → 另一个新进程显式提交继续输入。

| 检查                       | 实际结果                                                                             | 能证明的范围                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 当前 adapter 原生保存断言  | **预期失败**：会话文件数量 0，而非 1                                                 | 原生会话并未在未完成整轮时保存；不声称否定产品数据库的一切事实                  |
| native SessionManager 模式 | **通过**：1 个 JSONL、原始用户输入与完成工具结果已落盘，同 session ID 重开           | 原生状态不必等原 prompt 完成才保存；进程 SIGKILL 的这个检查点可恢复             |
| 只 open，不提交新输入      | 没有新模型请求或远端工具请求，session 非 streaming                                   | open 没有自动续跑原执行；不是完整 durable resume                                |
| 已返回 `queued` 的 steer   | **耐久性断言失败**：崩溃前 pending=1、steering 有该输入；重开 pending=0、steering=[] | SDK 的 queued 回执不是产品持久接受，普通 session 文件没保住尚未进入消息树的输入 |
| 副作用已完成、回执未发     | JSONL 缺该工具结果；显式继续时模型上下文得到 `No result provided`                    | SDK 不自动查原 operation 的实际结果；该文本既不证明失败，也不授予重试许可       |
| 已完成工具的继续上下文     | 原工具 ID 与 `Written` 结果仍在；SDK 没有自动重发已记录的两个工具调用                | 仅证明本受控回复及 SDK 重开行为，不保证真实模型不会再提出相同命令               |

探针 native 模式 **1 pass / 0 fail、23 个断言**；当前路径和 queued steer 各有 **1 个预期红测试**，没有隐藏或改成通过。探针类型检查、项目规则的 type-aware lint 与 formatter 通过，未放宽规则/超时；未跑项目全套生产测试，不宣称生产改造完成。

边界：本次会话目录和模拟 workspace 仍位于同一自有测试容器的不同目录；工具端点不是 E2B，也不执行真实付费任务。它证明 SDK 进程级行为，**不证明持久卷、跨容器/节点恢复、宿主隔离、物理 fencing、断电 fsync 或云环境销毁重建**。相关验收仍未完成。

第一阶段门槛目前仅部分通过。下一步需验证可靠输入与未完成工具的现成 runtime/原生接入，而不是把 `SessionManager.open()` 包成私有 replay engine、盲目重发输入/副作用或为了补这些缺口将 harness 搬回 guest。

## 9. 现成 Runtime 的发布版与故障验证

> 本节保留当时的探针结果。**第 11 节修正选型门槛的解释**：纯生成的未知模型请求不再默认要求零重复计费；beforeTool 的调用次数不等于真实操作边界授权；产品准确冲突也不要求每个原生 SDK 重复实现。原始红测试不改写，不把政策重分类算作代码修复或验收通过。

### Pi durable 1.0.4：补上耐久输入，但不是现有 SDK 的存储插件

已核查 npm 正式包并验证 integrity。它依赖 `pi-ai` 与 Chord，不依赖 `pi-coding-agent`，自己拥有 generation、工具任务、inbox 和新的会话存储。不能把采用它描述成“给现有 SessionManager 换后端”；工具执行签名、会话格式、Skills/MCP/CLI 接入与历史迁移都需另验。它仍明确标为 **Experimental，API 可在发行版之间无通知变化**。

在独立探针镜像中固定 durable/pi-ai/Chord **1.0.4**，用公开 faux provider、JSONL `{ fsync: true }` 与受控文件副作用。分别以 **Bun 1.4.2** 和 **Node 24.21.0** 运行 worker，checkpoint 后 SIGKILL；镜像运行时 `--network none`，没有真实模型请求。

| 行为                                                         | 两个 runtime 的实际结果                                                       | 判断                                                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 工具执行中 durably submit steer，崩溃后重开并 resume         | steer 仍为 queued；恢复后进入模型上下文并完成；原 requestId 找回原 submission | 两个正向探针各 15 断言通过；确实补上普通 AgentSession 的输入队列丢失缺口                                                                |
| 默认 unsafe 工具已写副作用、未返回时崩溃                     | 工具执行次数仍为 1，记录 `interrupted` 后继续 generation                      | 不直接重跑是有价值的保证，但不是查询/结算了原副作用；不证明模型不会新发一次操作                                                         |
| safe 工具初次允许、恢复时撤销授权，只把检查放在 beforeTool   | 工具 execute 运行 2 次，beforeTool 只运行 1 次                                | 两个 fresh-auth 门槛测试为红；该 hook 位于 intent 前，不覆盖 execute 恢复阶段。当前授权必须在真实操作边界核验，不能只靠注册时/hook 检查 |
| 模型调用已进入 provider、未保存结果时崩溃，普通 retry 已关闭 | 恢复再次调用 provider；次数 2，同一 provider sessionId                        | 两个未知模型请求拒绝重发的门槛测试为红；sessionId 是会话/cache affinity，不是外部请求幂等保证。默认恢复不能满足“不盲重发未知付费请求”   |
| 同 requestId、同 input 类型但改 content                      | 返回原 submission，不报告内容冲突                                             | 平台仍须保留原请求与准确冲突校验，不把原生 requestId dedup 当完整产品接受合同                                                           |

这是 **2 个正向通过、4 个保留的门槛红测试**，不是全套能力验收，也不把 SDK 按设计的 replay 行为误称 upstream bug。红测试包含接口行为与当时的产品策略假设；第 11 节重新核定哪些是必要不变量。不能通过去掉实际授权或标所有工具 safe 让它们“绿”。探针 typecheck、项目规则的 type-aware lint 和 formatter 通过。受控 marker 在测试 worker 的临时目录内，仅用于观测 callback 重入；不是远端 sandbox 或付费 provider 的安全验收，也不证明断电、跨容器持久卷、跨节点 owner 或流式片段恢复。

其他已确认限制：同一 storage 仅一个 process owner，发布包没有跨进程锁；不能靠产品 SQL fence 证明旧 writer/远端任务已停。它的原生工具和 extensions 也不等价于当前 coding-agent 的完整能力。`main` README 中的 Cloudflare storage helper 和 context-retention 配置与 1.0.4 发布文件有差异；本次没有使用未发布入口或修改厂商代码。

**目前不选择它进入生产。** 继续核定第 11 节收窄后的要求：在真实操作边界授权、限制跨恢复重试/消耗、保留必要原生能力及业务副作用身份。纯生成的未知请求是否允许重算属于显式策略，不默认要求供应商提供计费 exactly-once；如果需要自己重写 generation/replay/Skills 框架，则不符合本次门槛。

### Cloudflare agents 0.27.0 PiHarness：存储与唤醒适配，不是第二套 Agent replay

核查了正式包 `dist/harness/pi/index.js` 的 startup/wake 路径。它在 Durable Object storage 上适配 Pi durable，启动后调用原生 resume；生命周期 job 负责在有 live tasks 时保留 wake/heartbeat，等待其 idle，不自行 admit/replay 原输入。这个责任切分有参考价值。

但它是 **Beta、Cloudflare 平台路径、仍继承 Pi durable 的执行语义**。不能用外层 alarm 消除未知 paid request 或工具的风险，也不能直接放进现有 Bun worker 当通用恢复库。本轮没有运行 Durable Object 的 eviction/alarm 验收或任何云部署。其 Skills helper 也是另一种接口，不直接等于当前原生文件 Skills 能力。

### DBOS 5.2.11：通用耐久步骤，不是三个原生 harness 的现成恢复接头

已核查正式包与 README：PostgreSQL workflow、step、queue、通知等是其职责。它可以成为具体业务 workflow 的候选，但 **`runStep(() => session.prompt())` 仍只有整个 opaque prompt 的完成检查点**，不能据此承诺其中模型回合/工具副作用已分别保存。

本轮未验证 DBOS 与 Pi/Claude/Codex 的细粒度接入或 Bun 兼容，不宣称 DBOS 做不到，也不以“支持 AI Agent”替代证据。默认叠在原生 durable scheduler 外面恢复同一任务，反而会产生双 owner；因此没有安装项目依赖或把它定成答案。

### 这一轮的选择结论

现在有实证依据区分：普通 coding-agent 的原生会话保存、Pi durable 的耐久 Agent 执行、Cloudflare 的宿主存储/唤醒，以及 DBOS 的通用 workflow。它们不是可以互换的名字。

后续顺序以第 11 节为准：先分清纯推理、原生输入投递、真实副作用与执行权风险；不要为了纯推理零重复计费先构建 memo/拒发协议。未知 allocation 是否可容忍 TTL 有界空 VM orphan 属于另一个成本策略，尚未核定，本轮不由纯模型例外推导允许重试 create/PUT/pause/COMMIT。授权在实际 env/tool/外部操作边界重新检查，不依赖再次跑 beforeTool。Claude 按用户最新要求暂不测。只补必要的授权、预算与具体业务 IO 接入，不在这些库外自造通用执行恢复器。核心与能力门槛未通过，生产纵向替换仍不开始。

本轮来源和完整 receipts 入口为 `/tmp/agent-execution-core-current`：`sources.json`、发布包内容、隔离 `probe/`、独立 `bun.lock`、六组日志/receipts；最终冻结依赖重跑为 `frozen-*.log` 与 `frozen-receipts/`。正式包版本经容器核对；所有自有容器已逐项清理。probe 安装只发生在自有镜像内，项目依赖/lock 和已有修改未动。规范 `main` spec 已取回但未完整审阅，本节不以它宣称实现/版本验收完成。

资源记录：第一次清理临时 base tag 时 Docker 同时删除了旧无标签探针镜像 `521a296…` 的本地引用；旧历史 receipts 不改写，也不再把该引用作为当前可运行入口。当前固定镜像记录在 `frozen-image`，其原 1.0.1 adapter/tools/session-manager 摘要重新核对一致；冻结依赖后的六组探针与检查已重新运行。保留自有镜像标签供复现，所有自有容器清理；没有操作生产/共享 sandbox。

## 10. 多 harness 是先决条件，不让其他引擎套在 Pi durable 内

**Pi durable 至多是 Pi 分支的候选，不是整个平台的执行核心。** 它支持多种 model provider，不等于支持 Claude Agent SDK 或 Codex 的原生 harness。把 `query()`/`thread.run()` 注册为它的一次工具或任务，只保存外层调用状态，不会获得内层模型回合、未完成工具、输入队列与 native session 的恢复保证；再由外层重放还可能形成两个恢复 owner。

目标仍是在现有 Agent worker 中选择并接入各自的原生 harness：

| 分支                     | 原生执行/状态路径                                                                                 | 本次判断                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Pi coding-agent 1.0.1    | AgentSession / SessionManager                                                                     | 会话保存已测，queued steer 与未完成执行有缺口                                       |
| Pi durable 1.0.4（候选） | 自己的 Harness / submissions / native tasks / storage                                             | 与 coding-agent 不是同一格式或 extension API；只评估 Pi，不代管其他 SDK             |
| Claude SDK 0.3.292       | query / 流式 SDKUserMessage / resume / 原生配置目录                                               | 要验证自己的接受、取消和崩溃窗口，不转换为 Pi transcript                            |
| Codex 0.160.1            | 原生 app-server 的 thread / turn / queue、ThreadStore（CLI 入口标 experimental；本次显式 opt-in） | TypeScript SDK 的 exec/resume 接入面不足以代表这些原生能力；已有下面的实际 CLI 探针 |

复用的是产品接受/准确冲突、当前授权、预算、取消与交付事实，以及被授权的 workspace 与业务 MCP 能力。**不共用私有 transcript、执行 checkpoint、工具 replay、steer 队列或恢复调度器。** 平台投递原始输入与对账接受事实，不负责重新跑原生 Agent 的内部步骤。产品持久接受、写入 subprocess stdin、原生 queue ACK、原生执行完成是不同边界，不能统一成一个“submit 成功”。

遇到某分支不能可靠确认原输入接受或未知操作时，该分支应安全停止并报告缺口，不能补一个私有引擎、悄悄降成有限历史 prompt，或把其他分支的通过算到它头上。跨引擎切换也不冒充 native resume；在选择 Pi 纵向替换之前，就要核查 Claude/Codex 的最低目标可行性，而不是以后再为它们补桥。

### Codex 的进一步发布版核查与真实 CLI 探针

从 `rust-v0.160.1` 取回 app-server 协议和处理代码，保留 blob/hash。正式接口确实有：

- `thread/queue/add/list/update/delete/reorder/start`，原生 `queuedSubmission.id` 与 `clientUserMessageId`；
- `turn/start`、`turn/steer` 的 `clientUserMessageId`，steer 的 `expectedTurnId` 活跃 turn 前提；
- 按原生 thread 读取/恢复，与输入启动分别处理。这不是 TypeScript SDK `resumeThread()` 的同义包装。

随后下载并校验 npm 发布 **0.160.1-linux-arm64** 的完整 SHA-512 integrity，在自有 Docker 容器运行其真实 `codex-cli 0.160.1 app-server --stdio`，不是模拟 CLI。固定 Bun 1.4.2，仅容器 loopback，运行时 `--network none`，独立 CODEX_HOME/空测试 workspace，不提供真实凭据。

过程：原生 thread/start → turn/start 向受控 HTTP provider 发出一次请求并被挂住 → queue/add 原始输入 → 确认 queue/list → SIGKILL app-server（137）→ 新进程 initialize → 按原 thread ID queue/list。仅查看持久队列，没有调用 thread/resume、queue/start 或 daemon recovery，没有 paid provider、模型工具或真实远端 executor。

| 检查                                  | 实际结果                                                                  | 范围                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 已排队输入存活于 SIGKILL              | 原 queue ID、client ID、完整 input 在新进程中仍在；受控模型请求次数保持 1 | 正向探针 15 断言通过；证明这个 checkpoint 的原生 queue 保存/读取，不是整个原 turn 自动恢复 |
| 同 clientUserMessageId、同 input 重投 | 返回新的 queuedSubmission ID                                              | 原接受回执重放门槛红测试；该字段不能直接视为幂等键                                         |
| 同 clientUserMessageId、改 input 重投 | 接受并返回新的 queuedSubmission，未报告冲突                               | 准确冲突门槛红测试；平台不能删掉自己的准确接受/对账职责                                    |

最初在 idle thread 上测试“queue/add 后一定仍在队列”失败：实际 add 会触发 native drain，立即 list 已为空。保留原始日志；这是探针前提错误，不当作队列数据丢失。改为等待明确 active 模型请求后再提交，未放宽断言或 timeout。最终为 **1 个正向通过、2 个产品门槛红测试**，不称 upstream bug。探针 typecheck 与项目规则的 type-aware lint 通过；没有放宽规则、权限或 timeout，完整生产检查未运行。

还发现 `daemon_continuation.rs`：恢复检查最后 turn/权限与环境，当前只接受匹配的 **local executor**；关闭旧 turn 后发起带“先检查状态再重复行动”提示的 **new continuation turn**。这不是恢复原外部 operation 的结果，也不能默认用于本项目 remote sandbox。`daemon_thread_recovery.rs` 是 handoff snapshot/cold resume 路径，不能仅凭存在它就承诺所有 SIGKILL 都自动继续。

CLI 对临时 CODEX_HOME 的 helper/PATH、PATH 中缺 bubblewrap（使用 bundled fallback）与 model metadata fallback 有诊断，其中 stderr 的 bubblewrap 记录为 ERROR；日志保留。本次没有执行模型命令，不以 bundled bubblewrap 声明或 queue 成功证明宿主隔离。独立卷、跨节点、queue drain 与原生历史提交的故障窗口、完整 remote 工具、付费结果对账仍未验收。

### Claude 的公开接口复核

正式 0.3.292 声明有 streamed user `uuid`、`user_message_uuid(s)` 回复关联、`interrupt_receipt_v1` 的 `still_queued`，以及 `resume_reason` 输出字段。输入可合并为一个 turn，队列数量/UUID 回执不能当作一输入一执行或跨进程耐久证明。

尤其不能把声明中提及 hosted session 的救援逻辑/环境变量，直接当成 standalone SDK 可依赖的公开恢复入口。官方 Context7 文档明确 **V2 send/stream Session API 从 0.3.142 起移除**；本次固定版使用 query/AsyncIterable，而非旧教程。Claude 的 SIGKILL、queued UUID、原生工具未知结果与 alias 隔离尚未实测，不将 Codex/Pi receipts 转给它。

### 当前选择与后续

还没有选出满足目标的完整生产路径。**因此不能先以 Pi durable 为中心重构公共合同，再逼其他引擎适配它。** 第 11 节收窄要求；Claude 按用户最新要求暂不测，也不把未验收的 Claude 能力当作 Pi/Codex 架构立项的全面阻塞。继续核查 Pi/Codex 的必要恢复、remote 生命周期与输入接受窗口。纯生成的零重复计费拒发探针降为条件项，不能由它主导整个架构。

新证据入口 `/tmp/multi-harness-core-current`：发布二进制、integrity、固定标签源码、探针、初始前提失败日志及最终 receipts。生产代码/依赖/协议未修改，不创建额外服务，不进行云部署。

## 11. 必要保障与过度防护：先修正需求，再选择实现

用户要求继续调研，同时确认没有为不需要防护的场景增加复杂度。本节修正第 9/10 节的默认选型门槛，**不删改历史红测试、撤掉授权，或声称原实现已经修复**。Claude 不测；本轮不新增 production recovery engine、provider 依赖或部署。

### 社区实际承诺比“所有调用 exactly-once”更窄

重新取回官方 main 文档，保留 blob SHA/正文 hash；仅作为模式依据，不算本项目固定版兼容验收：

1. **LangGraph**：Context7 官方索引明确，已完成 task 的 checkpoint 结果复用，已开始但未完成的 task 可再次执行；节点从边界重入，不从机器指令恢复。sync/async/exit durability 是性能和丢失窗口的选择，不是要求每个 token 同步提交。写操作需幂等或核对，不能由模型 task 保存结果推导外部 effects exactly-once。
2. **Temporal / OpenAI Agents**：正式项目的集成 README 标 GA，模型自动作为 activity，未知/未完成 activity 可以重做；IO 工具明确接 activity，不是外包一个完整 prompt。README 还说明 streaming activity 的失败片段可能已经发布，retry 会发布第二个序列，消费者处理 RETRY transition。Sandbox 部分另标 Pre-release。它说明可接受的重复计算/展示边界，并不证明三个现成 harness 都能直接采用。
3. **OpenAI Agents 的模型 retry 文档**：普通 retry 显式 opt-in、有最大次数和 backoff；abort、可能不安全的 streaming replay、local-side-effect veto、stateful conversation 的未知重放分别处理。**不因所有请求都可能收费而禁止所有 retry，也不把所有 network error 当安全 retry。** 这些 runtime-only retry 不是进程级 durable recovery；两者不能混称。
4. **Rivet Sandbox Agent**：取回的官方文档仍明确新 runtime session + 最近 50 events/12000 chars 默认 continuation。说明有多 harness 产品选择较弱恢复承诺；不说明本项目应冒充完整 native resume。`agentOS` 网页取回受 SSRF 阻止，尝试旧 monorepo 文档路径 404；另一个 agentos repo README 是 Core VM runtime，不能把搜索摘要的 ACP 救援能力移植给它。该候选未作完整实现结论。

### 当前部署与代码中，哪些风险确实存在

- `compose.yaml` 声明一个 worker 服务，`CONCURRENCY` 默认 3 是进程内 fan-out，没有 replica/多区域声明。**没有查运行集群，不能由 YAML 证明实际上永远只有一个实例。** 初版可以明确单 worker、旧进程确认停止后重启、同一持久目录，再考虑横向接管；不需要先自建跨地域 leader election。
- 但 crash/部署并非假想：worker 会退出；native manager 目前 in-memory，成功才 snapshot；queue/steer 可丢；worker **没有 native-state volume**。连续原生会话持久化确实要做。
- E2B 当前 `onTimeout: kill`、默认运行期限 300000ms；失去 worker 续期后 guest 可能被销毁。保留 workspace 不是幻想的灾难场景。要明确 provider 的持久数据/快照恢复点；不必承诺任意未保存文件和内存进程都存活。
- 当前模型是 assigned `openai-completions`，tools 由 worker 单独在 guest 调用，不是已接入的 provider-hosted effects。`retry` 关闭；`maxTurnIterations=16` 是单次 invocation 的内存计数。价格 metadata 明确填 0 表示未知，**不是免费、不是已实现的美元预算或跨恢复成本账本**。
- 当前只有 execute/read/write、import/export、web_search；extensions 为空，仓库没有业务 skill/视频生成服务实现。视频 job 是目标业务例子，不是当前已部署事实。因此不能先为所有工具/未来供应商造通用付费 operation ledger；实际业务 MCP 接入时落实具体 job 契约。
- 文件写/任意 shell 与未知对象提交现在就可能有不可重复 effects。SQL owner/fence、取消、宿主隔离、远端失联不回退本地，以及已发写操作收尾仍是真正的必要保障。

### 一个实际的过度隔离已复现

本轮用**真实 Pi 1.0.1 + 当前 executeRun**、受控 loopback HTTP 401，已确认的 native sandbox reference，零 guest 工具调用，成功 pause 回执。SQL/E2B 为边界 doubles，没有真正 VM 或生产数据库。

期望：请求失败，保留可复用 workspace；不以该模型错误标记 sandbox recovery required。实际：quarantine 仍被调用，标记 recovery required。**6 断言的红测试失败在最后一条；前五条确认请求失败、1 次模型调用、0 次 guest 操作、reference 与 pause 都确认。** 根因是 `execution-error` 粗粒度地进入 `finishWithRecovery`，没有区分模型错误和 workspace 未知效果；不是因为所有 401 都需要恢复 VM。真实 SQL quarantine 路径还会使后续请求被拒，当前端口探针未运行数据库集成。

对照：受控文件 effect 完成、工具回执丢失，仍要求 recovery required 的探针 **6 断言通过**。这是 fake guest port 写自有 marker，不算真实远端验收。说明应收窄隔离原因，而非删除未知写保护。本轮保留这个红测试，没有改 production 或在文档里称已修复。

### 门槛修正

| 防护                                                               | 现在的判断                                                   | 最小处理，不造框架                                                                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯生成模型在 crash 后再算一次                                      | 不默认当不安全副作用；拒绝“每次推理零重复收费”作为统一硬门槛 | 明确允许重算的路径，继承逻辑请求的次数/期限/消耗上限；未知 attempt 不退款/清零；重复推理费用上限须明确，不声称免费                                                        |
| hosted tools / server-managed conversation / 已泄漏 partial stream | 不按上行泛化成纯生成                                         | 按具体 SDK/provider evidence 判断；UI 区分失败 attempt 与最终结果；没有安全契约则停止该操作                                                                               |
| 模型错误一律隔离 workspace                                         | 当前过度防护已有 red reproduction                            | 本轮 0 guest 操作、reference/pause 均确认、fixture 无旧后台工作的窄场景可仅失败请求；不能泛化给旧 job、丢失的工具上下文、未知 authority/cleanup                           |
| beforeTool 恢复时必须再调用一次                                    | hook 次数不是安全目标                                        | 当前授权/取消在真实 execute/IO 边界核验；保留 authority 不变量，不为重跑该 hook 改厂商 scheduler                                                                          |
| Codex 自己必须校验产品同 ID 内容冲突                               | 重复实现 owner 的要求不必要                                  | SQL 产品接受已拥有准确重放/冲突；单纯该 native API 的两项 red 不一票否决。**SDK ACK 丢失到 queue drain/history 的窗口仍需对账**，不能盲重投或把 SQL inbox 当 native dedup |
| worker crash / 原生 state 丢失 / 已接受 steer 丢失                 | 必须处理                                                     | 使用 native storage/input 能力，数据不放临时盘；不复制 transcript 或输入 replay scheduler                                                                                 |
| 任意命令/外部 job 的未知效果                                       | 必须处理，但不必所有工具都有通用 operation DSL               | arbitrary shell 不自动 replay；核查既有 workspace/job。业务服务支持的幂等/查询用原身份；缺契约则报告具体未知工作，不永久封死整个 thread 代替恢复                          |
| 取消、owner 失效、宿主执行与租户越权                               | 必须处理                                                     | 当前 IO authority、单 writer、停止/收尾与 fail-closed；不为“简化”移除                                                                                                     |
| 跨节点主动接管、突然断电零丢失、任意终端内存恢复                   | 不是第一版默认保证，也不是“不可能发生”                       | 声明支持的部署/故障范围、恢复点/备份；若要 HA 再采用基础设施现成 owner 机制，不先自写分布式恢复框架                                                                       |

前述 pure-model 重算策略是新的选型建议，不是已经开启 retry；重复费用范围仍需确定。旧 safe/model/Codex red receipts 保留，**政策重分类 ≠ 测试绿了 ≠ 功能已完成**。

### 现在收敛哪条路线

优先 **现有 worker + 各 harness 原生持久状态/输入 + remote workspace + 具体业务 job 契约**。Pi coding-agent 与 Pi durable 只比较需要的 compaction、Skills/MCP、输入、恢复和运维能力；不再由纯推理零重复收费决定胜负。Pi durable 的 Experimental、与 coding-agent 不同的能力/格式和迁移成本仍是实际选择成本，不能因为去掉错误门槛就立刻选用。

不以缺少 Claude 探针阻塞 Pi/Codex 的设计，也不声称 Claude 已验收。只有原生接入明确无法提供所需长等待/后台唤醒/恢复，且能说明接入公开边界、替换哪个 owner，才选 Temporal/DBOS 类 workflow；不是默认在 opaque SDK 外增加一个 scheduler。

下一批只核查会影响取舍的几件事：Pi 候选的原生能力差异与迁移成本、恢复后的真实 IO 授权与重试上限、Codex 接受/queue drain 窗口、单 worker 持久目录与 workspace 恢复点。**本轮没有最终 runtime 选型，但撤回不必要硬门槛，已经缩小问题；不再优先建模型 exactly-once 拒发协议。**

本轮证据入口 `/tmp/agent-recovery-scope-current`：当前基线、官方 source manifests、scope probe/receipts/logs、源文件摘要与清理记录。探针 typecheck/type-aware lint 通过；诊断输出保留，生产完整 suite 未运行。

## 来源

- Pi：本项目安装的 1.0.1 `dist/core/tools/{read,write,edit,bash,index}.d.ts`、`dist/core/session-manager.{js,d.ts}`、`examples/extensions/ssh.ts`。证据保存安装版内容摘要，不以宿主 Pi 1.0.4 替代。
- [Claude 发布包 0.3.292](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.292)：`sdk.d.ts` 中 `Options.toolAliases/tools/disallowedTools/sessionStore/sessionStoreFlush`、`SessionStore` 与 flush 合同。
- [Claude SessionStore 官方参考 adapters](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores)、[changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)。main 文件以取回 blob SHA 记录，不是自动等于发行版。
- [Codex 0.160.1 exec-server](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/exec-server/README.md)、[环境 provider](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/exec-server/src/environment_provider.rs)、[ThreadStore](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/thread-store/README.md)、[TypeScript SDK 发布包](https://www.npmjs.com/package/@openai/codex-sdk/v/0.160.1)。
- [OpenAI Sandbox Runtime Boundary](https://github.com/openai/openai-agents-python/blob/main/.agents/references/sandbox-runtime-boundary.md)。
- [Vercel Pi harness](https://github.com/vercel/ai/blob/main/packages/harness-pi/README.md)、[Claude harness](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/README.md)：仅作部署差异的官方示例证据，未完成代码/发行版验收。
- Codex 发布标签的 [queue 协议](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)、[turn 协议](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server-protocol/src/protocol/v2/turn.rs)、[queue processor](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server/src/request_processors/thread_queue_processor.rs)、[daemon continuation](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server/src/request_processors/daemon_continuation.rs)。Claude 以发布 sdk.d.ts 为版本证据；[官方 session 文档](https://code.claude.com/docs/en/agent-sdk/sessions)、[V2 移除说明](https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview)通过 Context7 辅助核对，不代替固定版本故障测试。
- 第 11 节：[OpenAI 模型 retry 与 safety boundaries](https://github.com/openai/openai-agents-python/blob/main/docs/models/index.md#runner-managed-retries)、[维护者的 provider 边界](https://github.com/openai/openai-agents-python/blob/main/.agents/references/model-provider-boundaries.md)、[Temporal/OpenAI 官方集成](https://github.com/temporalio/ai-integrations/blob/main/python/openai_agents/README.md)、[LangGraph durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution) 与 [Functional API](https://docs.langchain.com/oss/python/langgraph/functional-api)（本轮通过官方 Context7 索引）、[Rivet restoration 源文档](https://github.com/rivet-dev/agents/blob/main/sandbox-agent/docs/content/docs/session-restoration.mdx)。main 资料是模式证据，不算本项目发行版/API 兼容证明。
- [Pi durable 1.0.4](https://www.npmjs.com/package/@earendil-works/pi-durable/v/1.0.4)：发布 README、`dist/harness/{submissions,tool,generation}.js`、公开类型与 storage exports；[Cloudflare agents 0.27.0](https://www.npmjs.com/package/agents/v/0.27.0)：发布 `dist/harness/pi/index.js` 的 lifecycle 路径；[DBOS 5.2.11](https://www.npmjs.com/package/@dbos-inc/dbos-sdk/v/5.2.11)：发布包与 README。

第 8 节及外部 harness 调研的原始文件、blob SHA、发布包 integrity 和安装版 SHA-256 入口为 `/tmp/harness-environment-boundary-current`；第 9 节 Runtime 发布包与探针入口为 `/tmp/agent-execution-core-current`。`probe/` 保存探索代码，`current.log`、`native.log`、`steer.log` 与 `receipts/` 保存完整结果，`probe-verification.json` 保存版本/摘要/清理核对。不包含实际凭据；只有受控 loopback 模型/工具与 crash receipts，没有云环境验收。
