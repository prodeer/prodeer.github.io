---
title: "DeerFlow 实践（三）：受治理营销策略规划 Agent"
date: 2026-08-04
category: ai
tags: ["DeerFlow", "Agent", "LangGraph", "Marketing Hub", "MCP", "治理", "营销策略"]
description: "前两篇分别讲了网页原型生成和可审计技术选型，它们的重点是**放大模型能力**：一个用 Manifest 把完成标准数字化，一个用 Evidence Chain 把引用变成可追溯的结构。  第三篇我想换..."
---



前两篇分别讲了网页原型生成和可审计技术选型，它们的重点是**放大模型能力**：一个用 Manifest 把完成标准数字化，一个用 Evidence Chain 把引用变成可追溯的结构。

第三篇我想换一个方向。在营销场景里，问题不再只是“模型能不能写”，而是**模型能不能不乱动**。

为此，我设计了一个“受治理营销策略规划 Agent”，编号 `marketing-strategy-planner`。它不是自由执行型智能体，而是一个**LLM 生成 + 确定性治理 + 人工审批**的工作流 Agent。

用户输入一句话，比如“为刚完成 KYC 但未首存的 18 万用户设计激活策略，预算 20 万”，Agent 会生成一份可校验、可仿真、可审计的策略草案。只有用户明确选择“提交审批”，它才会登记一条 `pending_approval` 记录；选择取消则只保留运行产物。无论走哪条分支，它都不会发券、发消息或发布策略。

<!--more-->

## 1. 为什么营销 Agent 必须受治理

做营销策略，模型的“思考任务”并不难：给定人群、预算和目标 KPI，设计触达旅程、选择动作模板、设置频次和转化目标，这是模型擅长的组合问题。

真正困难的是两个边界：

1. **策略一旦执行就有真金白银的后果**：发券、Push、补贴都会影响真实用户和真实预算，一次幻觉就可能变成一次资损事故。
2. **营销系统包含敏感数据**：用户级明细不能进入 Agent 上下文，模型也不能为了补充依据去查询某个具体用户。

营销场景给 Agent 出的题目因此是反过来的：

> **不是“如何让 Agent 做得更多”，而是“如何让 Agent 做得更少，且一切可解释”。**

这也决定了它不能沿用通用 Agent 的自由工具调用模式。模型可以提出策略，但不能决定策略是否安全，更不能把策略直接执行出去。

## 2. 五条设计原则

在实现之前，我先给这套 Agent 定下五条原则：

1. **模型不是执行者**：LLM 只生成或修订候选草案，不持有营销执行工具。
2. **安全不依赖 Prompt**：预算、频次、Consent 和旅程结构由确定性代码检查。
3. **创作发生在受控组合空间**：人群、字段、操作符和动作模板都来自受控上下文。
4. **仿真通过不等于可以上线**：仿真只是数字预演，不是生产许可。
5. **人工审批不可跳过**：校验和仿真全部通过后，流程仍然必须暂停并等待人作出决定。

这五条原则可以浓缩成一句话：**模型负责创造力，系统负责边界，人负责最终放行。**

## 3. 总体架构与固定状态机

[![marketing-strategy-planner 受治理营销策略规划架构](/images/ai/deer-flow-marketing-strategy-planner-architecture.svg)](/images/ai/deer-flow-marketing-strategy-planner-architecture.svg)

整个 Agent 可以分成三个世界：

| 世界 | 职责 | 主导者 |
|---|---|---|
| 模型世界 | 生成和修订 `StrategyDraft` | Planner / Reviser LLM |
| 系统世界 | 加载上下文、校验、仿真、审批编排和产物持久化 | LangGraph + 确定性代码 |
| 人工世界 | 决定提交审批还是取消 | 用户 |

模型世界和系统世界之间不是“互相商量”，而是明确的控制关系：模型只能提交候选草案，系统有权拒绝草案并给出结构化错误。

入口使用一套专用 LangGraph 状态机，不进入 DeerFlow 默认 Lead Agent 链：



![Mermaid 图表](/images/mermaid/mermaid-7d45b716-1.svg)



循环有两个硬上限：

- `max_revision_rounds = 2`：最多修订两轮；
- `max_agent_calls = 3`：Planner 和 Reviser 的模型调用总数最多三次。

Planner 和 Reviser 都通过 DeerFlow 的 `SubagentExecutor` 启动，默认 `max_turns=12`，单次超时 120 秒。Reviser 必须保留原目标，只修复确定性错误，并且不能削弱预算、频次、Consent 或抑制控制。

模型可以迭代，但每次迭代的验收标准始终掌握在确定性代码手中。

### 6.3 仿真：让预算决定动作上限

校验通过后，草案进入 `simulate_strategy`。这一步不触达任何真实用户，只用聚合数据和确定性算法估算策略后果。

仿真会计算目标人群、对照组、可触达人数、预计动作次数、预计成本，以及频次和预算分别抑制了多少动作。当前 Mock 的关键假设包括：固定 85% 的 Eligibility rate、约 8% 的频次抑制，以及由总预算决定的动作数量上限。

一次真实运行中，18 万目标人群、20 万预算、包含 20 元 Coupon 的策略得到：

```json
{
  "status": "passed",
  "audience_size": 180000,
  "eligible_users": 137700,
  "estimated_actions": 9985,
  "estimated_cost_cny": 199999.55,
  "frequency_suppressed": 11016,
  "budget_suppressed": 116699
}
```

[![从 18 万目标用户到 9,985 次营销动作的预算漏斗](/images/ai/deer-flow-marketing-budget-funnel.svg)](/images/ai/deer-flow-marketing-budget-funnel.svg)

按抑制前的 126,684 次潜在动作和 20.03 元综合单价计算，不受预算约束的成本约为 253.7 万元。预算封顶后，只剩 9,985 次动作，预计成本被控制在 199,999.55 元。

仿真不只回答“能触达多少人”，也暴露“有多少动作会被预算拦下”。如果大部分潜在动作都被抑制，人工审核者可以据此判断目标和预算是否匹配。

> **模型可以设计如何花钱，但系统决定了钱能不能花出去。**

## 7. 人工审批：可恢复，但不可跳过

校验和仿真全部通过后，流程仍然只得到一份草案。`approval` 节点会调用 `interrupt()` 挂起原图，并生成一个结构化 `human_input_request`：

- 来源标识为 `marketing-strategy-approval`；
- 风险等级为 `high`；
- 治理元数据包含 TTL，默认拒绝选项为 `cancel`；
- 用户只能选择“提交审批”或“取消”。

默认拒绝是一项治理策略，不代表任意运行异常都会自动转换成 cancel。只有托管审批流程按该治理元数据处理过期请求时，才会使用默认拒绝选项。

这道暂停也不是前端临时保存的弹窗状态。审批请求保存在 LangGraph checkpoint / run 状态中，前端会从 `values.__interrupt__` 恢复审批卡片；用户作出决定后，再通过 `Command.resume` 恢复原图。治理收件箱中的托管决策还会通过 `joinRun` 等待同一个 run 继续执行。

因此，即使页面刷新，用户继续的仍然是原来的工作流，而不是一轮新的普通对话。

### 7.1 提交审批不等于批准上线

用户选择“提交审批”后，Graph 才调用 `submit_for_approval`。Marketing MCP 会再次执行权威校验和仿真，然后写入：

```text
status = pending_approval
publication = null
```

`submission_id` 根据 `requester + 规范化草案` 的哈希生成；审批记录中另有只针对规范化草案的 `draft_sha256`。相同请求人重复提交相同草案时会命中同一个记录，从而保持幂等。

用户选择“取消”时不会产生审批记录，但流程仍然写入五份产物，并在 Manifest 中记录 `approval_decision=cancel`。

无论哪条分支，都不存在策略发布、发券、Push 或邮件发送。

## 8. 审计、可观测性与真实运行

前面定义的五份产物分别回答两个问题：Agent 建议了什么，以及这份建议是否经过完整治理。`run-manifest.json` 还会记录 workflow、thread、run、模型、修订轮次、Agent 调用次数、审批决定和提交结果。

流程事件同样会进入前端：`task_started` / `task_completed` 展示专家任务的模型和状态，而 `hide_task_from_ui=True` 避免把专家系统提示词和完整上下文直接刷到界面上。用户看到的是结构化进度，不是一串内部 Prompt。

在 7 月 30 日使用 `glm-5-2` 的四次端到端运行中，流程表现如下：

| 运行 | 目标 | 人群 | 预算 | 修订轮次 | Agent 调用 | 审批决定 |
|---|---|---|---|---|---|---|
| A | KYC 完成未首存用户激活 | new_kyc_no_ftd（18 万） | 20 万 | 2 | 3 | cancel |
| B | KYC 完成未首存用户激活 | new_kyc_no_ftd（18 万） | 20 万 | 1 | 2 | submit_for_approval |
| C | 注册后 KYC 引导 + 首存转换 | new_kyc_no_ftd + inactive_30d（27.2 万） | 50 万 | 1 | 2 | submit_for_approval |
| D | 注册未 KYC 用户激活 + 首存 | new_kyc_no_ftd（18 万） | 36 万 | 1 | 2 | submit_for_approval |

运行 A 已经通过校验和仿真，但在人工闸门被主动取消，最终 `approval_decision=cancel`，没有生成审批记录。其余三次运行生成了 `pending_approval` 记录，记录里的 `draft_sha256` 与对应草案一致。

这些运行建立在确定性 Mock 上，不能代表真实营销效果，但它们已经覆盖了“通过后提交审批”和“通过后人工取消”两条完整路径，也证明修订循环受到明确上限约束。

## 9. DeerFlow 复用能力与可替换边界

这套 Agent 没有从零实现一套运行时，而是复用了 DeerFlow 的基础设施：

- 打包 Agent 使用 `SOUL.md` 定义角色边界，通过 `config.yaml` 声明白名单；
- Gateway 使用 `resolve_agent_factory` 路由到专用 Graph Factory `make_marketing_strategy_agent`；
- Planner 和 Reviser 复用 `SubagentExecutor`；
- 人工审批复用 `human_input_request`、LangGraph checkpoint 和恢复协议；
- 产物写入复用线程隔离的 DeerFlow Sandbox；
- SSE 和任务事件复用 DeerFlow 的流式运行能力。

这里也要区分平台能力与 Agent 自己的协议：Sandbox 是 DeerFlow 提供的基础设施，但五份文件的格式、写入顺序和 `run-manifest.json` Schema 是这个专用 Agent 定义的。

可以替换的部分主要位于领域边界：

| 模块 | 当前实现 | 未来替换方向 |
|---|---|---|
| Marketing Hub | 确定性本地 Mock | 真实营销中台或风控服务 |
| 人群和模板 | 固定测试数据 | 企业内部 Segment、用户事实和模板目录 |
| 仿真器 | 固定比例和成本模型 | 历史转化率、渠道成本曲线、频次衰减模型 |
| 审批队列 | 本地 `approval-submissions/` | OA、风控或营销审批系统 |

只要这些系统继续遵守同一份输入输出契约，LangGraph 的主流程就不需要随领域实现一起重写。

## 10. 当前局限与后续规划

目前这套实现验证的是治理链路，不是营销效果本身：

1. **Marketing Hub 仍是 Mock**：人群、动作模板、策略上限和仿真参数都是固定数据。
2. **仿真模型较简单**：还没有接入历史转化率、季节性因素、渠道成本变化和频次衰减。
3. **外部闭环尚未接入**：Agent 只登记 `pending_approval`；外部审批、营销执行以及执行结果回流都不在当前系统中。

后续计划与这三点一一对应：

1. 接入历史效果和渠道成本曲线，提升仿真可信度；
2. 将本地审批目录替换为组织内审批系统，记录审批人、意见和审计日志；
3. 在外部审批和执行完成后，把真实效果回灌到仿真器，校准下一轮策略。

## 小结

`marketing-strategy-planner` 不是“更聪明的营销助手”，而是一个在严格边界内工作的受治理 Agent。它用五道防线保证可控性：

1. **工具闸门**：Marketing MCP 不提供任何营销执行能力；
2. **Schema 闸门**：策略必须是受控组合空间里的强类型对象；
3. **校验闸门**：确定性代码检查预算、频次、模板、旅程和抑制路径；
4. **仿真闸门**：预算封顶的仿真把策略后果变成可核查的数字；
5. **人工闸门**：仿真通过仍然只是草案，最终决定权始终在人。

这五道防线不是五句 Prompt，而是可以从工具集合、Schema、校验规则、Checkpoint 和产物哈希中逐项验证的工程机制。

如果要用一句话概括这个 Agent，我仍然会说：

> **模型负责提出方案，系统负责决定边界，人负责最终放行。**

## 附录：受治理 Agent Checklist

设计或评审类似 Agent 时，可以用下面这份清单自检：

- [ ] 是否从工具层移除了不可接受的执行能力？
- [ ] 模型输出是否结构化、带版本且可以确定性校验？
- [ ] 资金、合规和用户体验规则是否由代码实现？
- [ ] 修订、预算、配额和频次是否存在硬上限？
- [ ] 人工审批是否会真正暂停原工作流，并能从 Checkpoint 恢复？
- [ ] “提交审批”“审批通过”和“生产执行”是否被明确区分？
- [ ] 关键产物是否有稳定契约、内容哈希和运行元数据？
- [ ] 模型世界、系统世界和人工世界的权限是否清晰？

满足这些条件，一个 Agent 才谈得上“受治理”，而不仅仅是“智能”。
