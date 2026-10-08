# 文件与依赖

目录按实际责任划分：server 拥有产品功能，agent 是执行进程，不要求两者目录对称。

## server

```text
apps/server/src/
  main.ts                   读取配置和进程信号
  server.ts                 HTTP/连接/后台任务的启动与关闭
  http.ts                   HTTP 分发、身份与路由合同
  request-body.ts           有界请求字节收集与 JSON 解析
  identity/                 官方认证库接入、会话和注销
  conversation/             会话、消息、取消、命令投递与公开事件
  assets/                   统一资产的上传、规则和授权读取
  db/                       产品查询、锁与原子变化
```

执行是会话的一轮，所以会话命令的发送、结果接收归 conversation。HTTP 身份入口不藏进 conversation；文件功能不分成 materials/artifacts 两套模块。SQL 集中在 db，但调用方式是具名事务函数，不是 repository/service 框架。

## agent

```text
apps/agent/prompt.md        worker 的系统提示词
apps/agent/src/
  main.ts                   读取配置和进程信号
  worker.ts                 连接、后台循环、活跃任务与关闭
  worker-health.ts          进程存活与就绪探针
  contract.ts               三层协作的进程内消费契约，不是 wire 协议
  execution/                持久执行路径，相邻测试随 owner 放置
    commands.ts             Redis 命令接收、inbox 接受后 ACK
    run-loop.ts             并发预算、领取与 owned run 收尾
    execute-run.ts          一轮执行、取消、暂停与未知结果隔离
    events.ts               execution outbox 的 Redis 投递
    wait-for-poll.ts         调度与续租共用的有界等待
    db/                     inbox、权威/预算、fenced terminal 与 outbox
  harness/                  引擎无关能力与具体 harness 适配
    files.ts                已分配资产导入与交付准备
    web-search.ts           有界搜索、净化与每轮预算
    pi/
      adapter.ts            实现 AgentHarness，拥有原生 session 与资源
      session.ts            SDK JSONL、可信资产/最终回执与 durable checkpoint
      tools.ts              六个工具的原生 schema、描述与结果包装
    openai/
      adapter.ts            独立 Agent/Runner/RunState loop 与 compaction
      session.ts            公开 Session items 与 atomic native saves
      tools.ts              本轮 capability 的公开 SDK 工具
  native-state-lock.ts      持久目录的单 host kernel ownership
  sandbox/                  环境操作及具体 E2B 实现
```

agent 没有用户侧 conversation 或资产领域。`execution/` 聚合完整的持久执行 owner：命令接受 → lease 领取 → 执行/隔离 → 终态与 outbox → 结果投递。这里已经有稳定的一组一起变化的流程和 SQL，不再把它们散落在进程入口旁；也不拆成 application/infrastructure/transport 多层或独立 recovery 框架。

`worker.ts` 仍拥有连接、能力绑定、后台任务和停机生命周期，不移进 execution；harness/sandbox 仍拥有具体 SDK 行为。模块直接导入实际文件，旧路径没有 compatibility re-export，目录没有 barrel。`contract.ts` 是能力声明而非转发入口，与共享 wire schema 的归属不同。

`harness/` 根目录放共享业务能力，`pi/` 和 `openai/` 各自拥有独立 SDK 状态/loop；不创建跨 engine transcript、通用恢复协议或空引擎实现。文件能力只使用已分配引用并准备输出，guest 路径由 Agent 决定；execution 在 fenced 成功终态提交资产引用，不实现搜索或资产字节搬运。沙箱供应商保存执行环境，数据库保存原生引用与效果事实；私有模型状态位于 worker native-state 卷，不进入 SQL/guest。独立 workspace 备份仍未验收，见 [原生 runtime](native-agent-runtime.md)。

execution 不导入具体 harness、sandbox adapter 或 agent SDK。根目录 `contract.ts` 声明 `AgentHarness` 等实际消费契约，具体 adapter 同时承担防腐职责；不再叠加 manager/service。沙箱只收到运行关联字段和不透明原生引用，不收到用户文本、历史或 SQL owner。`harness/web-search.ts` 实现搜索能力，`harness/pi/tools.ts` 只将它暴露为 Pi 工具，不再实现另一套搜索。技能加载与部署见 [Agent Skills](agent-skills.md)。

worker 与 server 只共享协议，不共享产品权限代码。私有执行数据库的权限边界不等于产品目录必须出现 execution。

## 共享包

| 包               | 责任                                                                |
| ---------------- | ------------------------------------------------------------------- |
| `contract`       | `http.ts` 公开合同、`execution.ts` 内部执行合同；schema 推导类型    |
| `config`         | 按进程配置 schema 与 defaults                                       |
| `database`       | 唯一迁移、生成 DB 类型与 schema，以及实际共用的有界 PostgreSQL 连接 |
| `object-storage` | 两个可信进程实际复用的有界对象字节操作                              |

合同文件按完整协议聚合，不为每个 schema 或常量建文件。执行合同只是进程 wire 的名称，不能进入 browser 的公开 HTTP 导入图。

Redis 直接使用官方 SDK；不维护另一套 messaging SDK。存储包不决定用户归属，不是第二套资产业务。共享代码只有跨进程合同或真实非平凡复用才留下。

## 边界

- 应用不互相 import 源码；共享包不依赖应用。
- 纯规则不导入 HTTP、Redis、Kysely 或 SDK。HTTP 可以直接调用具名事务操作。
- SQL 位于明确 owner 的 db：server/src/db 与 agent/src/execution/db；迁移位于 packages/database/migrations。
- SDK 参数只在具体适配与装配出现，消费者只要求实际使用的能力。
- class 只为真实资源身份与生命周期存在，不为命名空间或转发存在。
- 不创建通用 service/repository、provider registry、插件引擎、生命周期框架或 common/utils。

## 部署、测试与文档

- `deploy/`：原生 PostgreSQL SQL/psql、Redis config/ACL、Caddy 与固定镜像；`deploy/storage/{server,worker}-policy.json` 是公开的两角色权限政策，不是私有凭据，保留各自的权限边界。
- `config/.env`：唯一运维输入，各进程显式选择字段。
- `scripts/`：可信、有界、有资源所有权的验证/生成控制器。
- 相邻单元测试与 SQL/Redis、对象存储、VM 和部署测试各自保护实际行为。
- 现行手册描述使用方式与稳定设计；重构过程、研究与验收 receipts 以显式历史标签保留为证据，不当作现行运行合同，分类见 [文档索引](README.md)。generated 核对来源与复现，不手改。

小行为保持内聚，有明确边界才拆文件；没有消费者不建 barrel、空占位或备用实现。
