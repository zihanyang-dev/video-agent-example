# video-agent-example

一个会话式 Agent 后端示例：server 管理身份、消息和资产，agent 使用 pi 与可恢复 sandbox 执行任务。当前不包含 UI。视频是场景，不是平台核心的默认语义。

**less is more**：执行属于会话，上传与交付统一为资产，Agent 自主组织沙箱文件。原生平台负责环境保存、恢复、缓存和按需加载；应用负责身份、权威事实、可靠投递与资源归属。

## 文档

1. [架构](docs/architecture.md)
2. [文件与依赖](docs/directory-structure.md)
3. [代码规范](docs/code-style.md)
4. [开发与部署](docs/development.md)
5. [技术选择](docs/technology-stack.md)
6. [验证](docs/verification.md)
7. [本地 sandbox](docs/e2b-local.md)

## 工程入口

```sh
sh scripts/check.sh
sh scripts/database-check.sh test
sh scripts/database-check.sh verify
sh tests/scripts/deployment-check.sh
```

正式安装、运行、迁移、生成和检查使用 Docker；本地依赖只供 IDE。运维输入是 `config/.env`，各进程显式选择字段。VM 检查需要专用环境；模型/云端调用与删除数据卷需要明确授权。
