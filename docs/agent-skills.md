# Agent Skills

使用 Pi 1.0.1 的公开 `loadSkills` 与原生渐进加载，不维护自己的 frontmatter parser、skill registry、检索服务或加载工具。

## 加载路径

配置 `AGENT_SKILLS_PATH` 为可信资源包的绝对路径。空值表示禁用；只扫描该目录，不加载 worker 的个人目录、项目配置、任意上级目录、扩展或凭据。资源诊断使本轮在推理前失败，不自动忽略无效 bundle。

```text
原生 loader 扫描可信目录
→ 模型上下文只包含 name、description、SKILL.md 路径
→ 模型用已分配的 read 读取沙盒中的正文
→ 按需读取 references、执行 scripts
```

显式 `/skill:name` 使用 Pi 的原生命令展开，在 worker 读取已分配的 `SKILL.md`。`disable-model-invocation: true` 隐藏自动发现摘要，但仍允许显式命令；它不是资产或网络授权。

自动路径中的文件读取、列目录、grep/find 和脚本执行均通过已分配的沙盒工具。SDK 资源发现与显式展开可以读取可信 worker bundle，不开放宿主文件工具。

## 一份资源包，两处部署

当前 harness 在 worker，计算工具在远程沙盒。完整 bundle 必须由部署方以同一版本、同一绝对路径发布到两处，例如：

```text
/opt/agent/skills/v1/
  render-clip/
    SKILL.md
    references/
    scripts/
    assets/
```

- worker：提供原生发现和显式展开；只读内容由平台发布。
- E2B template：提供正常文件读取和脚本执行；不能包含模型、搜索、数据库或对象存储长期凭据。
- 配置：在 `config/.env` 设置 `AGENT_SKILLS_PATH=/opt/agent/skills/v1`，并选择包含该 bundle 的 `E2B_TEMPLATE`。
- 原有持久沙盒不会因为更换 template 自动更新资源。切换 bundle 前，必须明确处理现有环境；不得自动重建、覆盖用户文件或清除恢复隔离。

基础 worker 镜像与默认 E2B `base` template 不包含业务 skills。需要部署方扩展 worker 镜像和自己的 E2B template；应用不会每轮上传 bundle、执行 chmod 或声称校验了两端一致性。只读权限、相同字节、依赖和版本路径必须在实际部署中验证，不仅依靠路径相同。

仓库没有预置业务 skill，本次不编造媒体供应商、脚本或模板。

## 内容与检索

`description` 写清适用任务和触发条件。`SKILL.md` 是短入口：流程、约束和进一步资料的相对路径；长参数表和示例放到 references，脚本放到 scripts。相对路径以该 skill 目录为基准。

原生目录摘要负责第一轮选择，不默认 grep 全部正文。选择后可以使用沙盒内正常文件工具检索资料。所有 skill 正文不提前注入上下文；不为尚不存在的大型 skill 库建设向量索引或通用搜索框架。

## 验证范围

本地 HTTP 模型 fixture 与真实 Pi SDK 验证摘要进入请求、正文随后通过 assigned read 进入上下文、资料与脚本按需分派，以及显式命令展开和无效 bundle 在推理前拒绝。fixture 指定工具调用，不证明真实模型的 skill 选择质量。

这些测试不验证实际 E2B VM 中的只读权限、两端版本一致性或脚本依赖。部署验收应另行验证以上条件；没有这些证据时保持 `AGENT_SKILLS_PATH` 为空。
