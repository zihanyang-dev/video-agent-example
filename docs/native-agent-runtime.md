# 原生 Agent runtime：实现与验收边界

本文描述当前原生替换，不把历史实验、控制 fixture 或未完成的真实供应商验收算作 production acceptance。旧研究和改造计划保留作决策证据，不再是运行合同。

## 责任与格式

```text
持久接受的产品命令
  → SQL conversation / run 当前权威
  → worker 内 SQL 绑定的 Pi 或 OpenAI 原生 loop
  → 本轮授权的模型 HTTP / 远端 guest / 文件交付
  → SQL 终态 + public outbox
```

- SQL 保存接受/冲突、cancel、owner/run/fence、原始 deadline、模型请求/effect/lifecycle 预留和公共终态，以及窄的已完成业务上下文；不保存通用原生 transcript。
- Pi 1.0.1 SessionManager 保存原生 JSONL。OpenAI Agents SDK 0.19.0 保存公开 Session items 和 opaque RunState；直接客户端版本与项目 lock 的 SDK 依赖统一为 7.19.0。
- accepted run 的 engine/native session 首次绑定后不随配置或当前 conversation 指针改变；平台受信选择只供下一未绑定新任务建立独立接续段。两个 engine 仍独立创建、恢复和 compaction，不把一个 Runner 塞进另一 harness。
- worker 的 `/state/native` 是私有持久数据，不是 guest workspace。仅 worker 挂载，镜像创建私有目录；恢复原生备份不能从公共消息补造模型历史。
- 旧 SQL history 保留在 `legacy_history`，旧会话要求显式 offline import。历史 migrations 和供应商证据保留，不自动“迁移”成另一格式。

## 接续、预算与最终回执

接续不是精确恢复中断的 HTTP。已完成的原生工具结果保留；允许重新计算的纯推理仍在原始额度内：每请求最多 16 次模型预留、最多 2 次安全恢复，deadline 不重置。未知模型请求不退款。新回合的工具闭包、signal 和授权来自当前 request，不来自旧 snapshot。

每次模型实际 HTTP、compaction 请求与对象 PUT 必须在 IO 前获得当前授权。effect 在变更 dispatch 前持久预留，只在原生结果 durable 后确认；已证明完全未 dispatch 的本地拒绝可以结算它自己的 effect，不推广到 SDK AbortError 或网络超时。文件读取成功不代表后续 PUT 仍获授权。

原生最终回执先落盘，再进入 SQL 完成事务。启动持有 physical storage owner 后优先核对只读 final，避免“结果已完成而确认丢失”被 deadline/额度耗尽误判。SQL 锁内仍由 durable cancel 优先，不复活 terminal，也不新增模型/工具调用。Pi 同 run 已交付资产保存可信 native custom receipt；恢复不解析模型文本，不重新 PUT。平台 input、asset、completion envelope 损坏时拒绝恢复，不将它当作“尚未接纳”或“没有完成”而重新调用模型。Pi 文件在 SDK open/traversal 前验证 header、ID/parent 元数据与所有枝的有限 lineage，拒绝 cycle、重复 ID 和孤儿；消息/provider 内容与 compaction 语义仍归 SDK，不声称通用 native payload 校验。OpenAI 公开 `completed` 收尾不等于成功 final：native cancelled 或非 string `finalOutput` 不写完成回执；SDK 明确返回的空字符串仍合法。

## Physical owner 与未知结果

- SQL expiry 不证明旧进程停止；没有基于过期时间的 native takeover。OpenAI 文本 iterator 结束或抛错后仍 await 公开 `completed`，因为 session persistence/compaction 可能继续；10 秒内不能确认 native writer 收尾时走已有 fail-stop，而不是提前释放资源。
- 同一真正持久目录上的 POSIX kernel flock 挡住另一个 worker process。成功获取后的 FileHandle 由模块强引用，调用方或 failed worker 被 GC 不会隐式解锁；正常停止确认 writers 已 join 后才显式关闭，关闭失败仍保留引用，fail-stop 时保留到实际进程退出。内核在 fd 关闭或进程退出时释放锁。不同 host、不同卷或不同 statePath 的独立 lock 不构成跨地域 fencing。
- 已知 guest 的中断恢复先 drop memory/cold-settle 旧 writer，再 reboot；allocation/close 未确认、未结算 mutative effect 和未知 paid job 不盲目重放。
- quarantine 只记录 physical uncertainty，不能提前替当前 owner 写另一个 terminal 或释放 cleanup 权威。产品 cancel 可保持 cancelled，同时 workspace 留 quarantine。
- 未知 terminal COMMIT 先核对同一 SQL/native 身份；单独 SQL ACK 丢失不证明 guest 被改坏。
- 只有 lease、PID kill、TTL 或 pause 不能认证外部付费 job 停止/退款。需要实际供应商 durable job ID、status/cancel 语义和独立结算证据。

## Workspace 与恢复范围

已实现的是 E2B 2.52.0 的 assigned remote commands/files、同 ID filesystem-only pause/reboot、已知 guest owner 检查，以及受控长 command 续租。原生 SDK 留在 worker，不在 guest 运行第二服务。

以下目前不是已验收能力：

1. 销毁 guest/backing storage 后，从独立副本重建整个 workspace；显式 export_file 不等于工作目录、依赖、缓存和中间产物备份。
2. permanent backing-node/volume loss、跨节点 HA 或掉电恢复。正常宿主重启、同 ID reboot 与目录 fsync 不认证这些故障。
3. 外部媒体 Cloud job 的 durable correlation/cancel/recovery。默认 guest 网络拒绝公网；不能据通用 shell 工具宣布这些业务能力可用。
4. Pi 即时 steer 的持久接续。当前可靠接纳边界仍是 SQL 接受的后续输入队列。
5. OpenAI 的原生 Skills 自动发现。配置了 native Skills 时该 engine 明确拒绝，而不是引入自制 downloader/parser。

完整 production acceptance 仍须闭合这些用户要求，或明确获得用户对较小故障范围的确认，不能把它们藏在默认配置中。

## 历史 direct-token 兼容性失败与当前指派 endpoint

早期实际账户使用 ChatGPT direct-token OAuth，不是默认可互换的 Platform API key。对 `gpt-5.4` 的两个原生请求 HTTP 400；切换到账户当前模型 `gpt-6.1-sol` 后获得 HTTP 200。最新原生 Agents 0.19.0 / client 7.19.0 请求有合法 SSE、provider `response.completed` 与 SDK `response_done`，但没有原生最终 assistant run item，Runner 抛 `MaxTurnsExceededError`，未产生可验证 finalOutput。

这是当时 direct-token endpoint 的 native Runner 终止协议未兼容证据，不是认证成功或完整 E2E。不能增加 maxTurns 消耗更多请求、拼 delta 当 final、伪造协议帧或改用 Pi 生成包装来宣布第二 engine 成功。需要遵循标准完整 Responses 协议的已授权模型 endpoint/Platform API credential，或公开 SDK 的确切兼容修复，再重跑真实 streaming/tools/session/recovery acceptance。不会自动创建 API key、购买额度或输出凭据。

后续用户显式指派的模型 endpoint/key 与上述 direct-token 路径不同，Pi 和 OpenAI 先分别完成独立四轮生产角色 HTTP 场景，随后 milestone 审查修复前的源码快照另行完成同线程 Pi→OpenAI→Pi→Pi 四轮接续：两次新 native 段、最后复用、同 workspace 和已完成业务 context 均核对。证据与受限范围见 [verification.md](verification.md)，合同见 [harness-context.md](harness-context.md)。这些结果不改写原失败，也不认证之后的 milestone 修复；不等于跨 SDK 中断恢复、隐藏状态保真或对抗性指令优先级认证。

## 检查与证据

运行官方项目命令，使用根 `tsconfig.json`；不存在独立 `apps/agent/tsconfig.json`。Host 无 Bun 时，在自有 Bun 1.4.2 Docker 中使用源码副本；不得带入旧镜像中已经退役的源文件，也不绑定宿主临时目录。只清理本次确实拥有的容器/network/tag，不运行 global prune。

控制 SDK tests、实际 PostgreSQL、loopback E2B 控制 API、真实 provider 和真实 guest 是不同证据层。每次报告列出实际命令、退出码、源码版本与未验证范围；旧通过数不覆盖之后修改。

早期三个独立 review 覆盖 architecture、code-artistry、old-logic retirement；原始报告为 `/tmp/native-backend-independent-review-20261007.md`、`/tmp/native-agent-artistry-review.zh.md`、`/tmp/native-session-old-logic-retirement-review.md`。后续处置与 GC 锁缺陷修复证据见 [原生改动审查](native-agent-code-review.md#后续-gc-锁缺陷修复)；没有逐项 disposition 时，不能据后续检查推断这些早期 findings 全部关闭，也不能把“有报告”当作“全部问题已修复”。

部署、备份和人工核对见 [operations.md](operations.md)。
