# 文档索引

现行手册描述当前设计和操作合同；历史研究与实施记录保留决策、失败和验收来源，只证明各自记录的版本与范围，不替代当前验收。

## 现行手册

- 设计：[架构](architecture.md)、[技术栈](technology-stack.md)、[目录与依赖](directory-structure.md)。
- 开发：[开发与配置](development.md)、[代码风格](code-style.md)、[验证入口](verification.md)、[生成物](generation.md)。
- Agent：[原生 runtime 与验收边界](native-agent-runtime.md)、[统一已完成上下文](harness-context.md)、[Agent Skills](agent-skills.md)。
- 运维：[操作与备份](operations.md)、[部署停机](deployment-shutdown.md)、[投递调查与核对](delivery-reconciliation.md)、[本地 E2B](e2b-local.md)。

## 当前 milestone 审查

- [全项目审查报告](milestone-review.md)：逐责任架构/API/代码艺术判断、已复现缺陷、保留风险与最终验证状态。审查中报告不等于已提交、推送或 CI 通过。

## 历史研究与实施证据

- Handover 基线 `01b1f17760a8fd12c7cb18ac4100ac6721d6c6bb`：[冻结源码对照审查](handover-code-review.md)、[逐条重构与批次验收记录](handover-refactoring.md)。源码导航固定到该 commit，旧路径、行号、提案和原始计数不代表当前实现。
- 原生替换前的研究与计划：[基础设施研究](agent-infra-research.md)、[Session 改造计划](agent-session-refactoring.md)、[Harness 边界研究](agent-harness-boundary-research.md)。
- 原生替换的分批实现与后续修复证据：[原生改动审查](native-agent-code-review.md)。该记录不是运行合同；当前未验收范围见 [原生 runtime](native-agent-runtime.md)。

历史正文引用的本机 `/tmp` receipts 保留 provenance，不因此视为公开归档或可删除资源；长期保存位置与公开范围仍需 operator 决定。
