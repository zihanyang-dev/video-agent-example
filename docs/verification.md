# 验证

验证实际行为，不用类型、目录或 SDK 声明冒充产品能力。正式安装、运行、生成和检查使用固定 Docker 镜像；本地依赖只供 IDE。

```sh
sh scripts/check.sh
sh scripts/database-check.sh test
sh scripts/database-check.sh verify
sh scripts/deployment-check.sh
```

CI 分基本检查与必要集成两个 job，入口见 [development.md](development.md#检查与-ci)。API 文档离线核对；数据库入口覆盖 PG/Redis 与迁移生成，部署入口依次覆盖 production-runtime、storage-initialization、隔离 Compose 的 S3/角色轮换/API 代理及启动/TERM。入口声明覆盖范围，不代表这些层已在当前源码全部验收；部署所需公开 policy 随固定初始化镜像打包，不再使用用户主机源码 bind；合成部署输入也不继承操作员的 service 凭据。当前没有 UI 或浏览器验收。

## 必须保护的行为

- 身份：未登录、到期、撤销、Origin/CSRF、真实 cookie、跨用户拒绝和注销先持久撤销。
- 会话：稳定意图、精确重放与冲突，锁后最新授权、归档、取消、SSE 每批重新授权。
- 执行：接受后 ACK、重领、poison、ordinal 缺口、游标、租约过期、fencing 与晚到结果。
- 沙箱：持久引用、下一轮恢复、未知创建/暂停结果隔离、使用公开取消/暂停 API 和有界本地收尾；不自动付费重放。
- 资产：有界读取/上传、摘要、归属、稳定重试、未知 PUT 保留、显式交付与终态原子接受。
- 历史：保留原身份、旧对象键和前向迁移；旧 owner 只通过已核实的显式映射赋权。
- 部署：原生 SQL/Redis/IAM 权限、已有结构升级、密码轮换、坏输入、凭据隔离、冻结依赖和 API 代理。
- 工程：严格类型、type-aware lint、格式、真实依赖边界负向探针、生成复现和精确资源清理。

模型、Cloud、媒体执行和 VM 持久化需要单独授权及实际证据；本地 fixture 不认证这些能力。本地通过不能替代 GitHub 执行；历史计数不能升级为当前绿色。

## 上一轮部署与跨 harness 验收

本节记录 milestone 全项目审查修复之前的源码快照；后续认证 body、native join、损坏回执、迁移与交付修复都不借用这次真实模型验收认证。新源码需重新执行无凭据完整工程门禁；本次没有重新授权或重复购买模型/VM 验收。

该轮已审查源码的完整 `scripts/deployment-check.sh` 通过：Node 24.21.0 宿主控制器、Node 24.21.0 / Bun 1.4.2 固定运行镜像，6 项 Node 检查及 32 次分阶段 Bun 测试执行通过。覆盖冻结生产依赖、打包/启动/TERM、SQL/Redis/S3 角色边界、旧数据与凭据轮换、权限重新初始化和 API 代理。早先 Node 26 控制器的通过记录另行保留，不用它冒充固定版本结果；本地通过仍不认证远程 GitHub CI。

真实模型 `gpt-6.1-sol` 与官方本地 E2B Embed 上，同一 thread `6b0858cc-5983-4fc0-a6c6-cedc1eda1219` 的四轮接续已通过：

| 轮次 | Harness | 完成工具 | 模型预留 | 导出字节 | fence |
| ---- | ------- | -------: | -------: | -------: | ----: |
| 1    | Pi      |        5 |        6 |       79 |     1 |
| 2    | OpenAI  |        5 |        6 |      111 |     2 |
| 3    | Pi      |        6 |        7 |      124 |     3 |
| 4    | Pi      |        4 |        5 |       96 |     4 |

- 全程为默认生产 server/worker 入口，无诊断 preload；实际 SQL 角色分别为 server/worker。每轮只提交一次，共 20 个完成的原生工具调用；24 次模型预留不是重试数或计费审计。resumes/effects 均为 0，原额度与 deadline 未重置。
- 两次切换通过内部受信 `requestHarness` 保存意图，建立两个新 native 段；第四轮复用第三轮。三段业务 context 的 cutoff、输入与成功输出 provenance、digest 和实际公开 SDK history 均核对；没有公开 HTTP 切换 API 或自动路由策略。
- 同一 sandbox 的既有文件连续读取，四份 HTTP 下载字节/摘要与独立预期一致。第三、四轮准确回忆首轮仅在对话提供的随机信息；检查的工具参数/结果与导出不包含它。这不是任意 guest 文件的取证扫描或对抗性指令优先级认证。
- 四轮 live SSE 共 36 条文本增量；首段文本比对应 SQL 终态事务开始分别早 1013/1082/1591/858 ms。客户端与 PG 使用同一 VM kernel realtime，终态事件 `created_at` 为事务开始时间，不冒称测量了 commit timestamp；这个更强排序排除了只在完成后重放。
- 第一、第四轮的全量重放和 terminal cursor 重连不改变运行、事件、预算、deadline、binding 或 native history。10 个 anonymous 401/foreign 404 检查通过；Better Auth fixture 登录不是 OAuth。

验收后 server/worker 已正常退出；按容器 ID/归属标签移除已退出的自有探针和运行凭据副本，仅对本次已核对归属的 paused sandbox 取得 kill ACK，不宣称物理抹除。已知暂存文件中的模型 key 已退役，测试 PG/Redis/S3 停止；原 SQL/native/object 数据与旧证据保留，未知 sandbox 未触碰。

证据与独立审计保留在 `/tmp/harness-final-acceptance/`，包括 `deployment-node24-full.log`、`real-http-report.json`、`final-sql-audit.log`、`independent-real-audit.md` 和补充审计。这些本机文件不是公开长期归档。测试 PostgreSQL 使用保留原卷的同机回环监听；探针无模型/E2B/搜索凭据，native state 仅只读挂载。最初根目录 SDK module resolution 失败发生在所有驱动语句之前，无任务接受；修正探针的公开 workspace module resolution 后才提交唯一四轮链，不是未知任务重试。

## 历史真实模型验证边界

以下独立场景只证明各自当时的源码和运行范围，不认证之后的简化、跨 harness 接续或 milestone 修复。

历史 OpenAI 场景使用 `gpt-6.1-sol`、官方本地 E2B Embed、production server/worker，以及真实 PostgreSQL、Redis、S3、HTTP 和官方 AG-UI 客户端。认证使用 Better Auth 的独立 fixture 签发会话，不是真实 OAuth 交换。

完整的核心文件／对话链路已在一个新的 thread 中连续通过四轮：

- 同一 OpenAI native session、同一 sandbox，SQL fence 为 1→2→3→4；每轮仅提交一次，没有重置原预算、重放未知动作或切换模型。
- 四轮分别有 5／5／6／4 次完成的真实工具调用，共 20 次，覆盖 `import_file`、`execute`、`read`、`write`、`export_file`；SQL 模型调用计数分别为 6／6／7／5。native history 的实际参数、配对结果和读取字节均核验，不以模型声称成功代替工具证据。
- 下一轮实际读取上一轮的文件，四个导出分别为 79／111／124／96 字节，HTTP 下载与独立计算的内容及 SHA-256 一致。第三、四轮还回忆了只在首轮对话中出现、从未进入 guest 工具参数、输出或导出的随机信息。
- 四轮真实 SSE 均在提交后立即建立，文本增量共 40 条。客户端首个文本接收时间早于 PostgreSQL 终态事务时间，排除了只在完成后重放的情况；随后收到正确终态。silent tool 阶段持续超过 10 秒，连接未超时。
- 第一、第三轮完成后的官方 AG-UI 重放与终态游标重连，不增加执行、事件或模型计数。生产 HTTP 的线程、消息、资产、下载和 SSE 各自验证 anonymous 401／foreign 404，共 10 个拒绝结果。
- 前三轮带临时只读诊断观察，不修改请求、响应或 SDK state；移除后恢复默认 `bun apps/agent/src/main.ts`，第四轮在正常 production 入口通过，前三轮的预算、deadline、事件、消息和资产保持不变。

此前失败记录仍独立保留：初次 SSE 连接失败后的补充验收不能追认为原尝试全程成功；旧 thread 的第二轮也没有重跑或重置。随后新的同类测试明确捕获模型 HTTP 200 后的 `Sandbox file not found`，官方 SDK 对照实验验证 `/home/user` 文件保留而 `/tmp` 文件在 reboot 后消失。验收工作目录改为已验证的持久路径，prompt 澄清这一环境边界；没有增加恢复层或迁移旧失败任务的文件。

随后独立 Pi 四轮也通过 production HTTP 链路：同一 thread 的对话、workspace 文件、导出字节/摘要、streaming、重放和隔离均核验，最后在默认 worker 入口通过。Pi 允许原生工具批处理，没有强套 OpenAI 的逐步交替或 `tools + 1` 模型调用计数。原始证据分别保留于 `/tmp/real-e2e-enabled.dv6rf7cm/real-http-full-chain-report.json`、`real-http-final-audit-report.json` 和 `real-http-pi-full-chain-report.json`；这些本机 receipts 不是公开长期归档。

SSE comment 不产生业务事件、游标或模型调用，不是任务进度或成功信号。两条独立历史链路不认证之后更改的跨 harness 代码；上节接续有各自当时源码的独立实际验收证据，不认证之后的 milestone 修复。web_search、媒体处理、UI 逐工具显示、真实 OAuth、Cloud、销毁后重建、节点或卷丢失、HA、掉电恢复，以及取消／故障恢复的所有真实模型组合仍需分别验收。

## Review 与证据

读实际文件、函数体、调用方和 diff，检查是否有死代码、纯转发层、重复事实或可简化分支，并确认删除不改变授权和恢复语义。缓存图和 lint 不替代阅读；清单也不证明完整审查。

报告可复现缺陷或有具体依据的静态风险。修改后重跑相关检查和项目完整检查，写明实际命令、结果与未覆盖范围，不规定额外的 reviewer 数量或制造流程文件。

检查不读取真实 `config/.env`、宿主 home 或 Docker socket，不调用付费供应商，不删除未知容器/卷。脚本只收尾自己证明拥有的资源。数据库时间失效不能通过放宽 fencing、重试或提高预算隐藏。更多操作边界见 [development.md](development.md) 和 [e2b-local.md](e2b-local.md)。
