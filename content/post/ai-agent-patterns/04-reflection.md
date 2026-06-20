+++
date = '2026-06-20T10:00:00+08:00'
draft = false
title = 'AI Agent 设计模式（四）：Reflection——用评价反馈改进结果'
categories = ['AI 大模型']
tags = ['Agent', 'Reflection', 'Evaluator', '设计模式']
series = ['AI Agent 设计模式']
mermaid = true
+++

模型第一次生成一段代码时，可能能够运行，却没有处理空输入，也不符合项目规范。直接要求“再写得好一点”缺少明确方向；如果先按测试、接口和安全规则检查，再根据问题修订，反馈才真正参与了生成过程。

Reflection 模式把评价结果送回生成环节，形成“生成—评价—修订”的质量闭环。

<!--more-->

## 模式意图

> 使用明确的评价标准检查候选结果，将发现的问题转成反馈，并在有限轮次内修订结果。

Reflection 的重点不是重复生成，而是第二次生成获得了新的质量信息。没有评价标准和具体反馈，多调用一次模型并不自动构成 Reflection。

![AI Agent Reflection 设计模式](/images/ai/ai-agent-reflection-pattern.png)


## 问题场景：生成并审查代码

用户要求实现一个解析配置文件的函数。第一次结果可能存在这些问题：

- 正常输入可以工作，但缺少异常处理；
- 返回结构与接口约定不一致；
- 测试只覆盖成功路径；
- 使用了项目不允许的依赖。

Evaluator 根据测试结果和项目规则生成反馈，Revision 再有针对性地修改。这个场景的关键是评价标准可观察，而不是让模型凭感觉判断“代码是否优雅”。

## 基本结构

{{< mermaid >}}
flowchart LR
    I[Input + Criteria] --> G[Generator]
    G --> C[Candidate]
    C --> E[Evaluator]
    E -->|通过| O[Output]
    E -->|具体反馈| R[Revision]
    R --> C
{{< /mermaid >}}

主要参与者包括：

- **Generator**：产生候选结果；
- **Criteria/Rubric**：定义什么算合格；
- **Evaluator**：发现问题并提供证据；
- **Revision**：根据反馈修改或补充；
- **Stop Policy**：控制通过阈值和最大轮次。

Evaluator 可以是另一次模型调用、测试程序、规则检查器或人工评审。独立性越强，成本通常也越高。

## 运行过程

{{< mermaid >}}
sequenceDiagram
    participant G as Generator
    participant T as Tests / Rules
    participant E as Evaluator
    G->>T: candidate code
    T-->>E: failed cases + lint result
    E-->>G: handle empty input, remove dependency
    G->>T: revised code
    T-->>E: all required checks pass
    E-->>G: accept
{{< /mermaid >}}

最小伪代码：

```python
candidate = generator.create(task)
for _ in range(max_revisions):
    feedback = evaluator.check(candidate, criteria)
    if feedback.passed:
        return candidate
    candidate = generator.revise(candidate, feedback)
return candidate, feedback.unresolved
```

循环结束时不一定合格。达到最大轮次后，系统应保留未解决问题，而不是把“停止修订”当成“评价通过”。

## 核心特点

### 反馈必须改变下一次生成

“请检查答案”只是提示技巧。Reflection 要求评价输出成为下一轮输入，并且足够具体，能够影响内容或方法。

### 生成和评价是不同职责

同一模型可以承担两个职责，但使用独立上下文、外部测试或不同模型，通常更容易发现原生成过程的盲点。

### 质量必须可以描述

格式正确、测试通过、引用存在等标准容易检查；“足够有创意”或“绝对正确”很难成为稳定 Rubric。评价标准的清晰程度决定模式效果。

### 修订存在收益递减

每轮都可能找到新的措辞问题，却不一定改善任务结果。Reflection 必须有通过阈值、最大轮次或最小改善幅度。

## 优点与代价

{{< mermaid >}}
flowchart TB
    R[Reflection]
    R --> B1[发现明显遗漏]
    R --> B2[利用测试和规则反馈]
    R --> B3[结果更符合标准]
    R --> C1[增加模型与评测成本]
    R --> C2[自评可能延续原错误]
    R --> C3[可能陷入无休止润色]
{{< /mermaid >}}

Reflection 适合改善可评价的结果，但不能把模型自信转换成事实正确。虚假引用、错误数据和高风险判断仍需要外部证据或人工负责。

## 适用与不适用场景

适合使用：

- 输出质量可以用测试、规则或 Rubric 描述；
- 初稿常有可修复的遗漏或不一致；
- 结果质量值得额外调用成本；
- 修订确实能够改变结果，而不只是换一种措辞。

不适合使用：

- 输出可由确定性程序直接验证并生成；
- 任务没有稳定评价标准；
- 低价值结果不值得增加延迟；
- 高风险结论最终仍必须由人审批。

## 与相关模式的区别

| 概念 | 触发原因 | 下一步 |
|---|---|---|
| Retry | 执行失败，如超时 | 用相同方法再执行 |
| Reflection | 结果质量不足 | 根据反馈修改方法或结果 |
| Replan | 全局假设或路径失效 | 修改未完成计划 |
| Human Review | 责任或判断不能自动化 | 交给人决定 |

Reflection 可以触发 Replan，但两者不是同一模式。前者关注质量反馈，后者关注任务结构。

## 模式小结

| 维度 | Reflection |
|---|---|
| 意图 | 根据评价反馈改进候选结果 |
| 识别信号 | Generator、Evaluator、Revision 闭环 |
| 主要优点 | 减少遗漏，使结果满足明确标准 |
| 主要代价 | 额外成本、自评偏差、收益递减 |
| 使用原则 | 先定义怎样算好，再决定是否反思 |
