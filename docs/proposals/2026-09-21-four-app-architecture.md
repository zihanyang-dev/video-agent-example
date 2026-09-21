# 目标架构：四个独立应用，清晰的模型与数据归属

> 本方案已进入实现；当前目录、数据流与明确限制以 [架构文档](../architecture.md) 为准。

状态：已实施，本文保留设计依据。方案提出时的代码基线：`6a7cd59`。日期：2026-09-21。

本文替代合并 agent 的方案，并修订早期持久会话提案中的数据写入和共享包边界。本文确定组织与依赖原则；未来具体业务上下文需要根据模型、规则和一致性要求识别，不按功能菜单预先拆分。

## 1. 固定的架构决定

1. 保留 `apps/web`、`apps/server`、`apps/agent`、`apps/gateway`，各自可独立构建、启动和部署。
2. server 按领域模块组织，每个模块内部划分领域、应用、基础设施和入站适配责任。
3. agent 是独立的执行应用，拥有执行领域与完整的执行用例；当前只有一个主要执行边界，直接在应用内分层。
4. gateway 保持专注的技术与信任边界；web 按交互功能组织；二者不机械复制后端 DDD 层次。
5. packages 默认只承载真实共享的协议与技术能力；领域模型、应用用例、业务 repository 留在各自应用内。
6. 跨应用只通过显式协议协作。共享数据库实例不授予跨应用读写业务表的权力。
7. 每个持久事实只有一个权威写入方。其他应用可以保存带来源与版本的投影。

采用当前 Bun、TypeScript、Hono 与已有测试基础。此次架构选择不要求同时迁移框架、消息中间件或数据库。

## 2. 四个应用的职责

| 应用    | 拥有的责任                                                         | 不应拥有的责任                                   |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| web     | 页面、用户操作、交互状态与服务端视图展示                           | 权限和业务状态的最终裁决                         |
| server  | 产品规则、身份授权、用户输入、会话视图、面向产品的查询与 API       | 模型循环、沙箱生命周期、执行检查点的内部结构     |
| agent   | 执行调度、运行状态、补充输入的应用、检查点、工具和沙箱、执行工作区 | 产品套餐政策、用户成员关系、直接修改产品侧会话表 |
| gateway | 媒体凭据、出站范围、请求身份验证、供应商连接和协议适配             | 会话历史、运行状态机、产品计费政策               |

server 接受用户意图；agent 决定已接受执行命令如何推进并报告结果。产品授权由 server 裁决，agent 校验内部执行命令的来源和范围，gateway 执行出站授权边界。

传输凭据不能替代需要及时变化的业务授权。未来增加可撤销的消费授权时，通过明确协议获取和确认有效性；不能让 gateway 导入 server 代码或直接访问业务表。

## 3. 数据归属

| 数据                                 | 权威拥有方 | 其他应用如何使用                              |
| ------------------------------------ | ---------- | --------------------------------------------- |
| 用户输入、会话关系、产品侧权限       | server     | 通过内部执行命令传递必要事实                  |
| 运行状态、租约、已应用输入位置       | agent      | server 消费事件形成运行进度投影               |
| 模型上下文、执行检查点               | agent      | 不作为通用共享模型公开                        |
| 沙箱工作区版本、恢复清单             | agent      | 产品只获得显式发布的产物引用                  |
| 公开聊天历史、活动卡片、产物展示记录 | server     | web 通过 API 和 SSE 获取                      |
| 已提交执行结果与不可变输出引用       | agent      | 作为结果事实发送给 server，由其接受为产品记录 |
| 公共产物下载权限与链接               | server     | 基于产品权限和已接受的产物引用签名            |
| 长期媒体凭据与出站限制               | gateway    | 其他应用通过受限调用使用                      |

server 的“停止请求已接受”和 agent 的“运行已取消”是两个不同事实。server 保存的运行进度是投影，不能独立推进 agent 的状态机。

初期允许一个 Postgres 实例，使用分开的 schema 和数据库角色，例如 `product` 与 `execution`。应用只写自己拥有的 schema；通过权限限制读取对方业务表。应用内部模块继续遵守表归属。

跨应用使用外部 ID 引用，不建立依赖对方表的 ORM 关系或跨 schema 级联删除。删除和清理通过明确命令完成。对象存储可以共享服务，但工作区和公开产物采用明确的命名空间与权限范围。

## 4. 目录结构

这是一份可增长的结构地图，只有实际代码出现时才建立对应目录。当前 server 的 conversation 模块是起点，未来增加或拆分模块依据领域分析。

```text
apps/
  web/
    src/
      app/                              # 路由、页面组装与应用级 provider
      features/                         # 按交互功能组织 UI、状态与调用
      components/                       # 应用内复用的展示组件
      main.tsx

  server/
    src/
      main.ts                           # 进程启动与关闭
      bootstrap.ts                      # 配置与具体依赖装配
      modules/
        conversation/
          domain/                       # 会话规则与产品侧模型
          application/                  # 接受输入、请求停止、应用结果、查询
            ports/                      # 存储、执行命令等用例所需能力
          infrastructure/
            persistence/                # 本模块 SQL、映射和原子提交
            execution/                  # 调用 agent 的协议适配
          presentation/
            http/                       # HTTP 请求与响应转换
            events/                     # agent 结果事件的入站适配
          index.ts                      # 模块公开应用 API
      platform/                         # 确有复用的连接管理与遥测设施
    migrations/                         # server 拥有的数据变更
    scripts/

  agent/
    src/
      main.ts
      bootstrap.ts
      domain/                           # Run、执行规则、输入与检查点关系
      application/                      # 执行、steer、取消、恢复、提交
        ports/                          # harness、sandbox、状态存储等
      infrastructure/
        persistence/                    # 执行状态、检查点、inbox/outbox
        harness/                        # pi 与模型 SDK 适配
        sandbox/                        # Docker 实现
        workspace/                      # 工作区版本与对象存储适配
        messaging/                      # 发布执行事件、读取通知
      presentation/
        commands/                       # 内部命令解析与执行用例调用
    migrations/                         # agent 拥有的数据变更
    scripts/

  gateway/
    src/
      main.ts
      bootstrap.ts
      policy/                           # 出站约束与调用凭据验证
      providers/                        # 供应商协议适配
      transport/                        # 网关 HTTP 接入与转发

packages/
  contract/
    src/
      public/                           # server / web 的公开协议
      execution/                        # server / agent 的命令与事件
      gateway/                          # 调用方 / gateway 的内部协议
  queue/                                # 实际共用的传输机制，不拥有 Run
  object-storage/                       # 共用对象读写与签名，不拥有产物模型
  turn-token/                           # 共用凭据协议实现，保留现有名称

skills/                                 # 模型能力说明与脚本，独立版本化
tests/
  e2e/                                  # 跨应用协作场景
scripts/database/                       # 迁移执行与 schema 生成
.dependency-cruiser.cjs                  # 依赖边界检查配置
deploy/
docs/
  decisions/
  proposals/
```

测试默认与实现同位置；树中省略 `.test.ts`。application 内优先按具名用例组织，大用例有多个协作文件时再建子目录。domain 内按领域概念组织，不建立全局 entities/services/repositories 分类树。

server 有多个产品模型边界，因此使用 modules；agent 当前围绕执行能力内聚，直接分层。将来 agent 出现真实独立的模型边界，再引入模块层次。结构的对称性不作为目标。

## 5. 各层职责与源码依赖

| 层                | 责任                                       | 禁止混入                          |
| ----------------- | ------------------------------------------ | --------------------------------- |
| domain            | 模型、不变量、状态转移、业务结果           | SQL、HTTP、Redis、AG-UI、pi 类型  |
| application       | 用例协调、权限执行、提交边界、外部作用顺序 | 具体驱动、供应商线格式、HTTP 编码 |
| application/ports | 用例所需的最小外部能力                     | 全能 CRUD 接口、SDK 的完整镜像    |
| infrastructure    | 实现端口，翻译数据库及外部系统模型         | 擅自修改产品或执行政策            |
| presentation      | 解析外部输入、调用用例、转换输出           | 直接修改数据库和领域状态          |
| bootstrap         | 选择具体实现并装配实例                     | 业务流程与规则                    |

源码依赖只允许：

```text
presentation   -> application -> domain
infrastructure -> application/ports
infrastructure -> domain
bootstrap      -> 各层的装配入口
main           -> bootstrap 与进程生命周期
```

跨应用层面的源码依赖是 `apps -> packages`，禁止 `apps -> 其他 apps` 和 `packages -> apps`。双向运行时消息通过共享协议表达，不构成应用源码相互导入。

纯领域代码可以使用经审查的纯计算依赖；不强制继承 Entity、ValueObject 等基类。端口放在实际消费方，领域真正需要的抽象可以由领域拥有，不机械地把所有接口搬到 application。

数据库原子操作由 infrastructure 实现，其提交范围由用例和不变量决定。应用层不直接接收驱动 transaction 类型。简单只读查询可以通过查询端口获得结果，不必加载完整领域对象。

## 6. 完整数据流

```text
web -> server 接受用户输入
          |
          v
     server 本地事务：用户输入 + 待投递执行命令
          |
          v
     命令传输 -> agent 去重接受 -> 执行用例
                                      |
                            harness / sandbox / gateway
                                      |
                                      v
                         agent 本地事务：检查点 + 运行状态 + 待投递事件
                                      |
                                      v
     server 消费执行事件 <- 事件传输 <-+
          |
          v
     server 本地事务：事件去重 + 公开视图 + SSE 事件记录
          |
          v
       SSE -> web
```

这条路径有两个独立的提交边界，公开视图最终一致。API 返回 202 表示输入已持久接受；投递或执行失败必须可查询。agent 提交成功与 server 页面显示成功之间可能有延迟，不能承诺跨应用即时原子一致。

对实时文本可按短时间窗合并进展，具体频率由延迟和数据库负载测试确定。模型与原始工具事件不直接绕过 server 发布到产品 SSE；AG-UI 编码归 server 的展示边界。

## 7. 独立应用需要承担的可靠性成本

- 命令和执行事件采用至少一次投递：事务 outbox 保证本地状态与待发记录一起提交，消费方以 inbox 或唯一约束去重。
- 已处理消息的去重记录与实际状态更新同事务提交；传输 ACK 在消费提交后发生。
- 协议定义稳定消息 ID、目标、因果关联、版本和所需的顺序位置。同一目标的乱序事件不得回退已知状态；缺口需要重放或从来源补齐。
- server 对输入“已接受”的确认，和 agent 对输入“已应用”的确认分开。应用确认必须与可恢复检查点一致。
- Stop 定向运行，通过独立于新任务槽位分配的控制消费路径进入 agent，不能被满负载阻塞。
- agent 独立持有租约与执行代次。持久状态提交验证代次，旧执行者不能覆盖新结果。
- agent 的终态事件在结果和检查点提交后产生。结果未知的外部动作不能自动重做为整轮重试。
- server 为公开视图分配自己的游标，首次快照与游标一致，后续 SSE 从游标之后读取。

队列只提供传输；不会自动保证外部动作恰好一次，也不会自动恢复 pi 内存。持久步骤、安全暂停与供应商幂等能力仍需分别验证。

server 的结果消费者和 outbox relay 由 server 应用拥有；agent 的命令消费者和 relay 由 agent 拥有。初期可作为各应用受控的后台循环运行，规模需要时再增加同应用的独立运行入口，不新增业务服务。

Redis 与 Postgres 的具体分工单独评估。保留现有 Redis 传输也可以满足上述结构，关键是权威状态与可靠投递记录归各应用拥有。

## 8. 模块协作与共享包

同应用模块通过公开应用 API 协作，依赖保持无环。需要隔离语义时，由调用方定义端口，再在适配器中调用对方；避免只有转发意义的包装。

模块内部模型、repository、表结构不作为公共接口。跨模块读视图可以由具名查询组装；不能借查询路径直接写别人的状态。

`contract` 使用显式子路径导出，避免一个入口导出所有公开和内部协议。schema 是线格式的唯一来源，类型从 schema 推导。协议不导入任一应用的内部类型，不包含 ORM 实体或 pi session。

`queue` 可以共享 Redis Streams 等实现，但消息内容由协议定义，调度与重试政策由消费方用例决定。`object-storage` 共享字节读写和签名能力，工作区清单、产物版本及权限留在应用中。

原 `packages/store` 应拆解：server 的会话模型与持久化回到 server；agent 的检查点与持久化回到 agent；实际共用的对象存储适配单独保留。不能用一个共享 store 抹平数据归属。

## 9. 工程检查

在现有 TypeScript、Oxlint 和行为测试外，增加 dependency-cruiser 检查源码依赖。这些是目标规则，尚未实施：

1. 无生产源码循环依赖，无跨 app 源码导入，无 packages 反向依赖。
2. domain 不依赖外层、I/O 实现或传输协议；application 不依赖具体 infrastructure。
3. presentation 不直接依赖持久化实现；bootstrap 装配例外单独限定。
4. 跨模块只访问公开 API；浏览器不导入服务端实现或内部协议子路径。
5. 生产代码不依赖测试辅助，公共包不隐式读取应用环境。

数据库角色约束跨应用读写；import 检查无法证明表归属，SQL 与迁移仍需评审。各应用拥有自己的迁移目录和 schema，部署流程以明确顺序执行；协议和迁移采用兼容扩展后收缩的方式支持独立发布。

验证按职责组织：领域规则用纯测试；应用用例验证产品结果；基础设施验证实际数据库、消息和文件边界；少量 e2e 验证跨应用流程。保留 agent 效果评估与确定性的工程测试之间的区分。

## 10. 迁移映射与顺序

| 当前位置                                   | 目标                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| server `api/routes.ts`                     | presentation 负责协议，接受输入等协调提取到 application                       |
| server `conversation/thread.ts`            | 领域规则回 server 模块，Thread 不再由共享存储定义                             |
| agent `turn.ts`                            | agent application 的执行用例，拆出具体 I/O 与生命周期规则                     |
| agent `harness/harness.ts`                 | application 消费的端口，移除 AG-UI 生命周期依赖                               |
| agent `harness/pi.ts`、`sandbox/docker.ts` | agent infrastructure 中的具体实现                                             |
| agent `in-flight.ts`                       | 进程内执行句柄登记与持久执行所有权分别归属                                    |
| agent `projection.ts`、`delivery.ts`       | 工具观察解析留 agent；执行事实由 agent 提交；产品视图和 AG-UI 转换移至 server |
| `packages/store`                           | 按 server / agent 的事实归属拆解，只保留真正共享的技术能力                    |
| `packages/queue`、`contract`               | 分离传输实现与跨应用协议，保持明确导出                                        |

实施依次进行：建立行为基线与依赖规则；在各应用内分层；定义命令和结果协议；迁移运行与产品数据归属；实现 outbox/inbox 并切换消费者；移除 agent 直接写产品历史的路径；收紧数据库权限并删除旧共享模型。

旧数据回填需要固定迁移水位和校验，切换后每份事实只有一个权威写入方。目录整理不能宣称已经解决跨进程一致性，可靠性改造也不以简单搬文件代替。

完成证据：四个应用可以独立启动；依赖图符合约束；跨应用表访问被权限拒绝；重复、乱序、重启与暂停消费不会丢失已接受的输入或回退状态；页面只显示有持久依据的完成结果。

## 11. 设计依据

- [DDD Bounded Context](https://martinfowler.com/bliki/BoundedContext.html)：模型边界与上下文关系。本文不把应用进程等同于限界上下文。
- [Microsoft 应用架构指南](https://learn.microsoft.com/en-us/dotnet/architecture/modern-web-apps-azure/common-web-application-architectures)：内层抽象、依赖倒置与启动装配。
- [Vertical Slice Architecture](https://www.jimmybogard.com/vertical-slice-architecture/)：围绕用例和变化组织代码，控制多余的转发层。本方案仍保留领域依赖约束。
- [dependency-cruiser](https://github.com/sverweij/dependency-cruiser)：通过通用工具验证 TypeScript 的依赖规则。

这是对当前项目的明确选择：保留独立 agent，接受显式消息和最终一致性的工程成本，换取运行时与产品应用清楚的责任边界。架构质量由边界能否执行、变化能否局部化以及失败行为能否解释来验证。
