# Agent 基础设施调研与最佳实践（2026-10）

> **历史研究记录，非现行运行合同。** 以下路径、测试计数、结论和待实施方案属于原生 session 替换前的讨论，保留其当时语境与来源，不表示当前 SDK/部署已验收。现行双引擎职责、恢复限制与未完成验收见 [架构](architecture.md) 和 [原生 Agent 运行时](native-agent-runtime.md)。
>
> 本文“业界顶格／不再投入”“零正确性 bug”“唯一架构分叉”“永久出局／零改动”和工期／容量估计是当时讨论判断，不是经实测的通用安全、可移植性或架构保证。后续[边界再调研](agent-harness-boundary-research.md#11-必要保障与过度防护先修正需求再选择实现)收窄恢复与选型要求，[逐条重构记录](handover-refactoring.md)撤回有宿主探测的 Pi 原生工具替换；浏览器/MCP 拓扑并未在本文验收，产物回对象存储的方向应为 export_file 而非 import_file。旧建议保留作历史，不作为现行行动清单。

两轮架构讨论的记录：沙盒安全、pi 耦合策略、失败语义与崩溃恢复、持久执行框架评估（pi-durable / DBOS）、浏览器架构、引擎可替换性。每条结论都附当时验证过的依据。

## 架构定位：我们是标准形状，不是野路子

2026 年"云端通用 agent"已收敛出两条标准路径：

1. **Cloudflare Agents SDK + PiHarness**（2026-10 发布，beta）——pi-durable 跑在 Durable Object 里，pi 官方托管形态。
2. **自托管参考实现 `zen8labs/pi-cloud-agent`**（MIT）——"每个 agentic 产品都在重造同样的 80%：持久队列、隔离机器、凭证代理、可重放日志"。其形状与我们几乎一致：Postgres `SKIP LOCKED` 队列、append-only 事件日志 + SSE、会话 checkpoint 与沙盒 checkpoint 分离、E2B 作可插拔 provider。

我们与之唯一的架构分叉：**pi 运行在宿主 worker**（SDK 拨入沙盒）vs **pi 运行在沙盒内**（回调出站，controller 从不拨入）。两种信任区划分都成立——我们的沙盒更黑（连 controller 都不用访问），他们的 provider 更可换。维持现状。

## 沙盒安全态势：已达业界顶格，不再投入

- E2B = Firecracker microVM，隔离第一梯队（与 Anthropic 同方案）。
- harness/compute 分离、沙盒零凭证，与 OpenAI《Running Agents Safely》/Anthropic containment 实践对齐。
- `allowInternetAccess: false` + `allowPublicTraffic: false`：**比行业默认更严**（OpenAI 托管默认是"出站全开+告警"）。E2B 的域名白名单等 2026 新特性对我们无增量（我们全关）。
- 结论：姿态正确。真正的安全边界不在沙盒配置，而在**工具暴露面**。

## web_search：审查通过，与浏览器分工互补

宿主侧 Tavily 直连。值得保持的设计：沙盒永不直连搜索 API（模型/搜索双供应商、沙盒全黑）；3 次/轮预算在**序列化前**预扣；401/403/429/432/433 永久禁用工具；输出净化（控制字符/零宽字符/think 块/标签/长度截断）；sources 只含 title+url，"found ≠ read ≠ cited"。无改动项。

**与浏览器工具的分工（不是替代关系）**：web_search 负责**找 URL**（便宜、快、可靠、结构化）；浏览器负责**读页面**（深度阅读、JS 渲染、交互、商品页提取）。典型行为：web_search 拿候选 → browser 打开最相关的几个深读。不让浏览器承担搜索的三个理由：① 自托管 Steel 用机房 IP，搜索引擎 bot 拦截激进、必遇 CAPTCHA（这正是 SerpAPI/Tavily 品类存在的原因）；② SERP 页面的 a11y 快照比 API 返回的 JSON 贵几十倍 token；③ 页面加载慢且选择器脆。与 lobe-chat 的 `web-crawler` 架构互证（搜索 provider 检索 + 爬虫链抓正文的两层结构）。

## pi 耦合策略：反腐层已建，三个小修复收尾

**耦合点 1（运行时依赖）已建好**：`execute-run.ts` 的端口（`AgentHarness`/`SandboxSessionPort`/`SandboxTools`/`FileTools`）把编排逻辑与 pi 隔离，`harness/pi.ts` 是唯一适配器。换引擎 = 写一个 ~400 行新适配器。

**耦合点 2（历史数据）是唯一真耦合**，三个小修复：

1. 历史 blob 加信封 `{ engine: 'pi', version, payload }`——换引擎时老对话钉在旧引擎寿终正寝，无需迁移。
2. 工具定义改中立形状（名字 + JSON Schema + execute），适配器各自映射。
3. `HistoryLimitError` 从 execute-run 端口层挪到 harness 内部。

**升级纪律**：精确锁版本、升级前读 CHANGELOG、1511 行 harness 测试 + 跨版本历史 fixture 测试、格式不兼容时软着陆（开新会话）。

**换内置工具**：pi 自 0.60.0 起内置工具的 operations 支持远程委托（`BashOperations.exec` 等）。我们手写的 execute/read/write（~100 行）是唯一真正重造的轮子，换成内置工具 + operations 适配器，预算执行挪进 operations 层。

## 失败语义与崩溃恢复：分类学 + 一个真空洞

### 失败分类学（2026 共识）

| 操作类型  | 结果确定                  | 结果未知                   |
| --------- | ------------------------- | -------------------------- |
| 纯读/幂等 | 安全重放                  | 安全重放                   |
| mutative  | 终端错误 → replan，不重试 | **绝不重放**（可能已成功） |

核心洞察：「没做成」和「做成了但回执丢了」从外面看一模一样。恢复决策需要语义判断（归模型），机械发现与状态修复归基础设施。

### 我们的实现：干净，但有一个洞

逐行审查 + 测试盘点（单测 4775 行 + 集成测试 11441 行，含并发抢占/lease 过期/fence 竞态）：**0 个正确性 bug，1 个结构性缺口**——

`sandbox_recovery_required` 全仓库 3 处设置、4 处拦截、**0 处清除**。worker 崩溃 → 对话永久死锁，且历史回滚到上个完整 turn，**模型不知道发生过任何事**。

复审（2026-10-06，含社区最佳实践对照）另发现两个运维级缺口并已修复：`event_outbox` pending 查询的部分索引（`20261006010000_event_outbox_pending.sql`）、published 行的保留窗口清扫（`sweepPublishedEvents`，默认 30 天，未发布行永不清理）。

### 恢复路径设计（待实施，1-2 天）

产品哲学已定（coding agent 方式做视频，拒绝 LangGraph 式流水线编排），恢复协议三层：

1. **机器层**：reconciler 发现崩溃 → 沙盒保留（`onResume: 'reboot'` 重连，代码已有）→ 清标记。
2. **呈报层**：把「上个 run 中断」写进模型可见处。
3. **模型层**：模型重读 skill（流程显式写在文档里）+ 勘察沙盒（只读工具是安全探针）→ 把观察到的文件映射回流程步骤 → 接着做。**文件系统是状态，skill 是地图。**

skill 编写纪律：每步产出一个命名文件、路径约定死（`scenes/01.mp4`……），勘察就变成一次 `ls`。

## 框架评估：都不接，触发条件写死

### pi-durable：不接

实际给的：per-entry 持久化 transcript + task checkpoint 续跑、submission 幂等、compaction、fork/subagent、prompt-cache session 亲和、env 抽象。

硬约束：**存储只有 SQLite/JSONL/Memory，无跨进程锁**（"one process owns a storage at a time"）。我们多 worker 抢 run 的架构用它 = 先自写 Postgres 存储后端（500–1000 行 + conformance），再重接 execute-run（300–500 行），还要吞 experimental API 变动。**总计 1–2 周，替不掉现有控制面任何一行**；mutative 工具进去全标 unsafe，行为收敛到我们已有的「呈报+勘察」。

**重新评估触发条件**：① 单 turn 推理贵到「崩一次丢一整个 turn 的 token」肉疼；② 历史逼近 4MB 上限、compaction 成刚需。

### DBOS / Temporal / LangGraph：永久出局

两条独立理由：① 工作流框架 checkpoint 的是「步骤」，看不见模型驱动的循环内部——编排逻辑在模型脑子里，不在代码里；② 产品哲学已定为纯模型编排（skill 教步骤），没有确定性流水线可编排。除非未来产品长出以确定性多级流水线为主的形态（转码→质检→发布），否则不翻案。

## 浏览器架构（url2video）：Steel + MCP 通用层

决策链：自研 `browse(url)` 工具（×，浏览器管理巨坑）→ 云浏览器类别调研（Browserbase 不开源、Anchor/Kernel/Hyperbrowser）→ **Steel**（`steel-dev/steel`，Apache 2.0，单容器自托管，4C8G 约 8–10 并发会话，worker CONCURRENCY 天然节流）。

拓扑：**harness 持 CDP 连接**（沙盒保持全黑）→ Steel 内网部署、无公网入口 → 渲染产物走已有 import_file 通道回对象存储。

集成方式经三轮修正后定为：**建通用 MCP 接入层 `harness/mcp.ts`（建一次，浏览器是首个租户）**——

```text
run 开始 → MCP manager 拉起 server（stdio/HTTP）→ listTools → allowlist 过滤
        → 包装成 AgentTool（预算/超时/大结果→对象存储，全在这一个拦截点）
run 结束 → 统一清理
```

依据：pi 官方自带 `pi-mcp` client（独立包，stdio + Streamable HTTP + OAuth，含 AgentTool 包装模式）；平台方向是「后面会接很多 MCP」，基础设施成本摊薄；MCP 是协议不是 SDK，天然引擎中立（换 Claude/GPT SDK 时工具层零改动）。浏览器 MCP 选型：playwright-mcp（a11y 快照，省 token）为默认候选，chrome-devtools-mcp 备选，两者都支持连 Steel 的 CDP 端点。

## 探索出的最佳实践清单

1. **双信任区 + 全黑沙盒**：harness（凭证/模型/策略）与 sandbox（无凭证/无网络）分离；所有网络能力经宿主侧工具代理。
2. **工具调用是唯一的网络闸门**：不按任务类型设防（agent 行为不可预判），每个工具声明自己的网络需求，宿主在调用点执行。
3. **永不重放结果未知的 mutative 操作**：「没做成」与「做成了但回执丢了」不可区分。
4. **语义重试归模型，机械恢复归基础设施**：崩溃恢复 = 修沙盒 + 呈报 + 模型决定；基础设施永不自动重放。
5. **持久执行标准件**：SKIP LOCKED 队列 + fencing token + 事务性 outbox + inbox 幂等 + 单次锁定决策拥有终态/历史/事件。
6. **不变量焊在测试里**：防腐化靠测试（并发/崩溃注入），不靠注释和审查自觉。
7. **skill 是恢复地图，文件系统是状态**：流程知识住 skill 文档，产物按命名约定落盘，崩溃恢复 = 重读地图 + 勘察现场。
8. **MCP 作为工具接入统一协议层**：包装层统一做预算/超时/资产拦截；每接一个新 MCP 只是加配置。
9. **引擎反腐层 + 历史信封**：端口隔离运行时依赖，信封隔离数据格式依赖，换引擎成本 = 一个适配器。
10. **框架采用看触发条件，不看焦虑**：pi-durable 的两个触发条件（turn 变贵、历史逼近上限）写死；DBOS 类随产品哲学永久出局。

## 行动清单（按序）

| #   | 事项                                                           | 量级   |
| --- | -------------------------------------------------------------- | ------ |
| 1   | 沙盒恢复路径：reconciler 清标记 + 重连/冷启动 + 中断呈报       | 1–2 天 |
| 2   | 引擎解耦三小项：历史信封、中立工具形状、HistoryLimitError 挪位 | <1 天  |
| 3   | 不变量专项测试（fence 丢失终态写、outbox 崩溃、取消竞态）      | 1 天   |
| 4   | pi 1.0.1 → 1.0.4 升级演练                                      | 半天   |
| 5   | 内置工具替换：pi-native operations 适配器                      | 1–2 天 |
| 6   | `harness/mcp.ts` 通用层 + Steel + playwright-mcp 首个集成      | 2–3 天 |
