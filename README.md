# video-agent-example

一个会话式 Agent 后端示例：server 管理身份、消息和资产，agent 通过独立的 Pi 或 OpenAI Agents 原生适配器与可恢复 sandbox 执行任务。当前不包含 UI。视频是场景，不是平台核心的默认语义。

**less is more**：执行属于会话，上传与交付统一为资产，Agent 自主组织沙箱文件。原生平台负责环境保存、恢复、缓存和按需加载；应用负责身份、权威事实、可靠投递与资源归属。

## 文档

[文档总入口](docs/README.md)：现行设计、开发与运维手册、验证入口，以及明确标记的历史研究与审查证据。

## 工程入口

```sh
sh scripts/check.sh
sh scripts/database-check.sh test
sh scripts/database-check.sh verify
sh scripts/deployment-check.sh
```

正式安装、运行、迁移、生成和检查使用 Docker；本地依赖只供 IDE。运维输入是 `config/.env`，各进程显式选择字段。VM 检查需要专用环境；模型/云端调用与删除数据卷需要明确授权。
