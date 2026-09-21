# 架构

本文件描述当前实现。设计背景见 [四应用方案](proposals/2026-09-21-four-app-architecture.md)，实验记录见 `docs/probes/`，代码约束见 [代码美学](code-style.md)。

## 1. 四个应用，各自拥有生命周期

```text
浏览器 → web → server → 命令 outbox → Redis Streams → agent → 模型
                ↑                                  ↓
           会话事件 / SSE ← 产品投影 ← 结果 outbox ← 执行记录
                                                   ↓
                                               独立沙箱
                                                   ↓
                                                gateway → 媒体厂商
```

| 应用    | 拥有的责任                                 | 不拥有的事实             |
| ------- | ------------------------------------------ | ------------------------ |
| web     | 页面、交互状态、同源 API 代理              | 执行状态的权威记录       |
| server  | 会话权限、用户输入、公开消息、SSE          | pi 历史、执行租约、沙箱  |
| agent   | 运行、控制、检查点、工作区、模型与沙箱适配 | 用户权限、公开消息格式   |
| gateway | 厂商凭据、模型白名单、下载来源限制         | 会话、任务调度、计费策略 |

server 和 agent 始终是独立应用。关闭浏览器或重启 server 不会取消 agent 的任务；agent 暂时不可用时，server 仍能保存输入。gateway 独立是为了隔离不可信沙箱与长期凭据。

## 2. 目录与依赖

```text
apps/
  web/src/
    features/conversation/       页面交互与会话视图
  server/
    migrations/                 产品数据迁移
    src/
      main.ts                   入口
      env.ts                    配置解析
      bootstrap.ts              应用装配和生命周期
      modules/conversation/
        domain/                 会话、消息、可见状态规则
        application/            用例与消费方端口
        infrastructure/         PostgreSQL、命令 outbox
        presentation/           HTTP、SSE、执行事件接入
        index.ts                模块公开用例
  agent/
    migrations/                 执行数据迁移
    scripts/                    skill 发布
    src/
      main.ts
      env.ts
      bootstrap.ts
      domain/                   Run、Checkpoint、Progress
      application/              执行、续租、控制、调度与端口
      infrastructure/           pi、Docker、工作区、持久化、结果 outbox
      presentation/commands/    执行命令接入
  gateway/src/
    providers/                  厂商配置
    transport/                  转发与下载限制
packages/
  contract/src/public/          浏览器活动协议
  contract/src/execution/       server 与 agent 的消息协议
  queue/                        Redis 传输与 outbox 轮询
  object-storage/               S3 字节与签名链接
  turn-token/                   沙箱访问令牌
skills/                         沙箱里的说明与脚本
deploy/                         部署配置与生成的 schema
scripts/database/               迁移执行与 schema 生成
tests/                          跨应用行为验证
```

依赖方向是：`presentation → application → domain`，`infrastructure → application/domain`。端口由消费方声明，实现由装配根注入。domain 不引用框架、共享 wire 协议或数据库；application 不引用适配器。

跨应用只能通过协议通信，不能 import 对方源码。共享包不依赖应用。server 内不同模块通过 `index.ts` 的公开接口交互，不能穿透彼此内部目录。`bun run boundaries` 用 dependency-cruiser 检查这些规则以及循环依赖，包含 type-only import。

agent 当前就是一个执行领域，不再套一层只有一个成员的 `modules/agent`。gateway 是技术边界，没有业务领域规则时不添加空的 DDD 分层。`index.ts` 仅再导出，不承载实现。

以后增加 project、billing、payment、template、memory，先判断事实归属，再在 server 下增加实际需要的模块。每个模块拥有自己的规则、用例、适配器和数据；跨模块业务流程显式调用公开用例。执行检查点仍属于 agent，不能因名称里有 memory 就搬进产品记忆模块。尚无消费者的模块和共享框架不提前创建。

## 3. 数据权威

| 事实                                     | 权威位置                                  |
| ---------------------------------------- | ----------------------------------------- |
| 谁能访问、用户说了什么、公开回复是什么   | PostgreSQL `product` schema，server 写入  |
| 输入是否进入执行、运行归属、检查点是什么 | PostgreSQL `execution` schema，agent 写入 |
| 工作区文件、发布产物的字节               | 对象存储，检查点和公开消息引用具体版本    |
| 哪些命令或结果需要发送                   | 各 owner 的事务 outbox                    |
| 浏览器收到哪里                           | SSE 的会话 revision 游标                  |

两个 schema 共用本地 PostgreSQL 实例，但不存在跨 schema 外键。运行时连接分别设置 `vid_product` 和 `vid_execution` 角色；真实数据库测试验证交叉读取被拒绝。部署迁移使用有 DDL 权限的连接。生产应为两个应用配置各自的登录身份并授予相应角色，不能把开发用的超级用户当作生产隔离方案。

共享包按消费者使用的能力划分：

| 包               | 内容                                         | 消费方                               |
| ---------------- | -------------------------------------------- | ------------------------------------ |
| `contract`       | 公开活动 schema、跨进程执行命令与进度 schema | web、server、agent，各自使用对应入口 |
| `queue`          | Redis Streams 收发、ACK 与 outbox 轮询       | server、agent                        |
| `object-storage` | S3 读写、列举对象与下载签名                  | server、agent                        |
| `turn-token`     | 执行凭证签名与校验                           | agent、gateway                       |

`packages/store` 已删除；原有产品和执行持久化分别回到 server、agent。共享对象存储包不知道会话、运行或检查点。原 `packages/store/schema.sql` 的部署结构快照现在位于 [`deploy/database/schema.sql`](../deploy/database/schema.sql)，仍由迁移生成。

## 4. 发送、执行与回传

1. 浏览器为输入生成 `commandID`。server 校验消息及会话权限，在同一事务写入用户消息和命令 outbox，随后返回 202。同 ID 同内容重放不重复写入；同 ID 不同内容返回 409。
2. server 的发送循环把 outbox 发到 Redis Streams。发送失败保留待发记录；发送成功但数据库提交前崩溃会重发，因此接收方必须幂等。
3. agent 解析命令并写入自己的 inbox。消费 ACK 表示命令已持久化，不表示长任务完成。
4. 调度器锁定会话并认领一次运行。数据库唯一索引和会话锁保证同一 thread 同时只有一个运行，不同 thread 可以并发。
5. agent 恢复最后一次检查点和工作区，租用沙箱，运行 pi。pi 只输出内部执行进度；AG-UI 不进入 agent。
6. 每条进度在执行数据库中分配会话内顺序号并写入结果 outbox。产物先上传到不可变对象 key，再发布引用该 key 的事件。
7. server 接收结果，按事件 ID 去重，按会话顺序号投影。缺少前序事件时暂不 ACK；公开消息、会话 revision、可重放事件在同一事务提交。
8. server 把产品事件翻译成 AG-UI，经 SSE 发送给浏览器。模型诊断留在内部记录，公开失败文案由 presentation 决定。

传输语义是 **at-least-once 加幂等消费**，不承诺端到端 exactly-once。命令和结果都保留数据库记录；Redis 是传输媒介。Redis 数据丢失后的恢复需要从 outbox 重放，当前没有自动重建工具。不能在生产使用无持久化的 Redis 并假设 ACK 过的消息仍然存在。

## 5. 补充输入、Stop 与中断

正在接收输入的运行会获得后续消息，由控制循环调用 `steer`。执行收尾先停止输入投递，再封口，未投递输入留给下一轮；flush 仍受 Stop 控制。开始执行前已取消的运行不调用模型。

Stop 是持久化命令，指向明确的 `turnID`。延迟抵达的 Stop 不会取消后续运行。当前 HTTP Stop 面向已经在产品投影中启动的运行；尚未开始的排队输入没有单独的取消接口。

运行归属包含 worker 身份和租约。续租失败会中断模型；写进度与完成提交必须在事务内检查归属。租约过期的运行标记为 `interrupted`，不会自动重跑。尚未开始投递的后续输入可以继续排队，已记录投递意图的输入不会自动再次交给模型。

正常退出停止接收和认领，等待在途运行结束并发送结果。强制终止由租约过期处理。这不是任意指令位置的恢复：只能恢复到最后一次成功提交的检查点。

## 6. 完成、工作区与未知结果

模型结束不等于任务完成。执行必须先等待进度写入、保存工作区，再原子提交模型历史、工作区版本和终态事件。

模型失败也尝试保存已产生的历史和文件。工作区保存失败则保留旧检查点，并将本次运行记为失败。清理沙箱失败只记录诊断，不改写已经提交的结果。公开投影在任务结束时关闭未完成文本与仍在运行的步骤，不留下永久转圈的历史。

工作区按运行和版本写入新前缀，产物也使用不可变 key；修改同名文件不会覆盖已发布版本。skill 内容单独加载，不写进工作区快照。签名链接在 server 每次展示时生成，不把过期 URL 当作持久记录。

媒体调用仍由 skill 执行，其 `succeeded / failed / unknown` 是外部调用结果，与运行状态不同。强制崩溃可能丢失最后一次工作区保存之后的厂商 job ID；当前没有独立的厂商操作台账。不能把运行 `failed` 理解成外部付费调用一定没有发生，也不能据此自动重放付费操作。

## 7. SSE 与公开协议

首次连接读取同一数据库快照中的公开消息、活动运行和 revision；后续只读取该 revision 之后的事件。断线重连用 `Last-Event-ID` 接续，不重新追加已经显示的快照。

未结束的文本在快照中恢复为流式状态，可以继续接收 delta。用户消息 ID 与浏览器乐观消息一致，回显替换原消息。产物只公开签名链接，工具调用与 pi 原生事件不透传。

推理可以在运行期间显示，终态时从公开消息投影和浏览器移除；内部结果和事件日志仍会保留它。当前没有事件保留期限和自动清理策略，不能宣称推理从所有持久化介质中删除。

SSE 当前按连接轮询产品事件表，适合当前规模。以后需要降低连接数带来的查询压力，可增加通知作为唤醒机制；游标和重放依据继续留在数据库，避免产生第二套公开事实。

## 8. 沙箱与 gateway

pi 运行在 agent 进程，沙箱提供远程文件系统和 shell。只启用确实被代理的 bash/read/write/edit，启动时验证来源；不启用会访问宿主机文件系统的 grep/find/ls。

沙箱环境显式构造，不继承宿主机凭据。模型 key 留在 agent，媒体厂商 key 留在 gateway。Docker 沙箱网络为 internal；gateway 连接内外两张网络，限制可用模型及每一跳下载 origin。

skill 是沙箱里的数据和脚本；extension 是服务进程里的代码。只加载编译进应用的 extensionFactories，不从用户工作区加载服务端扩展代码。两次 shell 调用不共享 cd/export 状态。

## 9. 迁移与验证

迁移按时间排序，记录沿用 `public.applied_migrations`；已应用迁移只前向修正。首次拆分保留旧公开消息、产物 key、pi entries 和工作区前缀。升级时先停止旧 server/agent，再迁移并启动新版本；这次迁移不支持新旧二进制混跑。旧 Redis 队列中的未完成工作需在切换前排空，本次没有兼容消费者。

`bun run schema` 在临时数据库重放迁移并生成 `deploy/database/schema.sql`；`schema:check` 比较生成结果。`bun run check` 包含类型、代码风格、依赖边界、schema 和行为测试。

测试使用真实 PostgreSQL、Redis、MinIO 验证持久化与传输；运行控制用可控 harness 验证失败与取消，真实 pi 适配器使用本地模拟模型验证协议。测试不会调用付费模型或媒体生成服务。

当前登录仍是开发占位，产品功能仍以视频会话为核心。计费、支付、产品记忆、对象及事件保留策略、厂商操作台账均未实现；目录结构为这些责任留下明确归属，不用空目录冒充已完成的能力。
