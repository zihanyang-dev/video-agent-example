# 验证

验证实际行为，不用类型、目录或 SDK 声明冒充产品能力。正式安装、运行、生成和检查使用固定 Docker 镜像；本地依赖只供 IDE。

```sh
sh scripts/check.sh
sh scripts/database-check.sh test
sh scripts/database-check.sh verify
sh tests/scripts/deployment-check.sh
```

CI 分基本检查与必要集成两个 job，入口见 [development.md](development.md#检查与-ci)。API 文档离线核对；集成覆盖 PG/Redis、迁移生成、真实 S3 权限和打包入口的启动/TERM。当前没有 UI 或浏览器验收。

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

## Review 与证据

读实际文件、函数体、调用方和 diff，检查是否有死代码、纯转发层、重复事实或可简化分支，并确认删除不改变授权和恢复语义。缓存图和 lint 不替代阅读；清单也不证明完整审查。

报告可复现缺陷或有具体依据的静态风险。修改后重跑相关检查和项目完整检查，写明实际命令、结果与未覆盖范围，不规定额外的 reviewer 数量或制造流程文件。

检查不读取真实 `config/.env`、宿主 home 或 Docker socket，不调用付费供应商，不删除未知容器/卷。脚本只收尾自己证明拥有的资源。数据库时间失效不能通过放宽 fencing、重试或提高预算隐藏。更多操作边界见 [development.md](development.md) 和 [e2b-local.md](e2b-local.md)。
