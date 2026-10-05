# 文件与依赖

目录按应用自身的责任划分，不按三个应用的名字做镜像。server 拥有产品功能，agent 是执行进程，web 是呈现。

## server

```text
apps/server/src/
  main.ts                   读取配置和进程信号
  server.ts                 HTTP/连接/后台任务的启动与关闭
  http.ts                   HTTP 分发、身份与通用请求边界
  identity/                 官方认证库接入、会话和注销
  conversation/             会话、消息、取消、命令投递与公开事件
  assets/                   统一资产的上传、规则和授权读取
  db/                       产品查询、锁与原子变化
```

执行是会话的一轮，所以会话命令的发送、结果接收归 conversation。HTTP 身份入口不藏进 conversation；文件功能不分成 materials/artifacts 两套模块。SQL 集中在 db，但调用方式是具名事务函数，不是 repository/service 框架。

## agent

```text
apps/agent/src/
  main.ts                   读取配置和进程信号
  worker.ts                 连接、后台循环、活跃任务与关闭
  execute-run.ts            执行一个已领取任务、取消与收尾
  run-loop.ts               并发预算、领取与等待运行
  commands.ts               Redis 命令接收、持久接受后 ACK
  events.ts                 执行 outbox 的 Redis 投递
  db/                       租约、环境引用、私有历史和 outbox
  harness/                  官方 pi、历史与明确工具
  sandbox/                  环境操作及具体 E2B 实现
```

agent 没有用户侧 conversation 或资产领域。它接受已授权任务并执行；相关流程先用清楚的文件表达，不为两三个文件再建 execution、conversation 或 transport 目录。

文件导入与交付是 harness 的工具行为：只使用已分配引用，guest 路径由 Agent 决定。没有独立 assets/workspace 模块。沙箱原生保存整个执行环境，数据库保存原生引用。

worker 与 server 只共享协议，不共享产品权限代码。私有执行数据库的权限边界不等于产品目录必须出现 execution。

## web

```text
apps/web/src/
  main.tsx / http.ts / style.css
  identity/                 登录、会话和隐私清理
  conversations/            Chat、消息、运行观察与局部交互
  assets/                   文件选择、上传与展示
```

组件、查询、hooks 与相关测试围绕功能相邻，不按 components/hooks/types/utils 横切。Chat 是界面名称，threadID 是会话身份，页面不引入 workspace 或 project 实体。

## 共享包

| 包               | 责任                                                             |
| ---------------- | ---------------------------------------------------------------- |
| `contract`       | `http.ts` 公开合同、`execution.ts` 内部执行合同；schema 推导类型 |
| `config`         | 按进程配置 schema 与 defaults                                    |
| `database`       | 唯一迁移、生成 DB 类型与 schema                                  |
| `object-storage` | 两个可信进程实际复用的有界对象字节操作                           |

合同文件按完整协议聚合，不为每个 schema 或常量建文件。执行合同只是进程 wire 的名称，不能进入 browser 的公开 HTTP 导入图。

Redis 直接使用官方 SDK；不维护另一套 messaging SDK。存储包不决定用户归属，不是第二套资产业务。共享代码只有跨进程合同或真实非平凡复用才留下。

## 边界

- 应用不互相 import 源码；共享包不依赖应用。
- 纯规则不导入 HTTP、Redis、Kysely 或 SDK。HTTP 可以直接调用具名事务操作。
- 应用 SQL 位于各自 db；迁移位于 packages/database/migrations。
- SDK 参数只在具体适配与装配出现，消费者只要求实际使用的能力。
- class 只为真实资源身份与生命周期存在，不为命名空间或转发存在。
- 不创建通用 service/repository、provider registry、插件引擎、生命周期框架或 common/utils。

## 部署、测试与文档

- `deploy/`：原生 PostgreSQL SQL/psql、Redis config/ACL、Caddy 与固定镜像。
- `config/.env`：唯一运维输入，各进程显式选择字段。
- `profiles/`：显式加载的受控指令，不预设任务目录。
- `scripts/`：可信、有界、有资源所有权的验证/生成控制器。
- 相邻单元测试与真实 SQL/Redis、对象存储、VM、浏览器测试各自保护实际行为。
- 文档描述使用方式与稳定设计，不保存重构过程；generated 核对来源与复现，不手改。

小行为保持内聚，有明确边界才拆文件；没有消费者不建 barrel、空占位或备用实现。
