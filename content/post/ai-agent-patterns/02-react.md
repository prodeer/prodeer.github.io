+++
date = '2026-06-18T09:00:00+08:00'
draft = false
title = 'AI Agent 设计模式（二）：ReAct——根据观察决定下一步'
categories = ['AI 大模型']
tags = ['Agent', 'ReAct', 'Tool Calling', '设计模式']
series = ['AI Agent 设计模式']
mermaid = true
+++

排查一个陌生 API 的超时问题时，我们通常无法提前写出完整路径。先检查健康状态，发现服务正常；再读取日志，发现连接池耗尽；然后检查数据库连接，才定位到根因。

ReAct 模式处理的就是这种情况：下一步动作取决于刚刚获得的观察。

<!--more-->

## 模式意图

> 在行动与环境反馈之间建立循环，让 Agent 根据最新观察动态选择下一步动作，直到达到完成或停止条件。

ReAct 由 Reasoning 和 Acting 两个词组合而来。工程上不需要把它理解成输出模型全部隐藏思维过程，更有用的结构是 `decide -> act -> observe -> update`。

![AI Agent React 设计模式](/images/ai/ai-agent-react-pattern.png)

## 问题场景：排查 API 超时

固定排查脚本可以覆盖常见问题，但遇到未知故障时，每一次检查都会改变后续选择：

1. 健康检查失败，就先恢复服务；
2. 健康检查成功但错误率上升，就查看日志；
3. 日志显示连接池等待，再检查数据库；
4. 证据足够后输出诊断，否则在预算内继续。

这里无法在运行前确定完整路径，却可以在每一步之后确定下一步。这是 ReAct 最典型的适用条件。

## 基本结构

{{< mermaid >}}
stateDiagram-v2
    [*] --> Decide
    Decide --> Act: select action
    Act --> Observe: environment result
    Observe --> Update: record new state
    Update --> Decide: more work needed
    Decide --> Complete: goal reached
    Decide --> Stop: budget or risk limit
    Complete --> [*]
    Stop --> [*]
{{< /mermaid >}}

主要参与者包括：

- **Current State**：目标、已有观察和剩余预算；
- **Decision Maker**：选择下一动作或宣布完成；
- **Action/Tool**：对环境执行一次操作；
- **Observation**：动作产生的外部反馈；
- **Stop Policy**：限制循环次数、成本和风险。

## 运行过程

{{< mermaid >}}
sequenceDiagram
    participant A as Agent
    participant H as Health Tool
    participant L as Log Tool
    participant D as DB Tool
    A->>H: check service health
    H-->>A: healthy, latency high
    A->>L: inspect timeout logs
    L-->>A: pool wait exceeded
    A->>D: inspect connection pool
    D-->>A: max connections reached
    A->>A: enough evidence, finish
{{< /mermaid >}}

最小循环并不复杂：

```python
while budget.remains():
    decision = model.decide(state.summary())
    if decision.action == "finish":
        return decision.answer
    observation = tools.execute(decision.tool_call)
    state.record(observation)
return state.partial_result()
```

重点不是 `while`，而是 Observation 真的来自环境，并且能改变下一次 Decision。

## 核心特点

### 路径在运行时形成

固定 Workflow 预先确定主要路径，ReAct 的动作序列则随观察变化。同一个问题在不同环境状态下可能产生完全不同的轨迹。

### 它擅长局部适应

ReAct 每次回答“现在做什么”。它能快速利用新信息，但也容易被最近观察吸引，忽略长期目标。

### 循环必须有外部边界

模型自己说“完成”不是唯一停止条件。工具次数、时间、重复动作和风险策略都应该参与终止判断。

### 决策轨迹应结构化

系统可以保存动作、参数、观察和简短决策理由，不需要依赖完整 Chain-of-Thought。结构化轨迹更容易审计和检测循环。

## 优点与代价

{{< mermaid >}}
flowchart LR
    W[固定 Workflow] -->|低适应性<br/>高可预测性| P[预定路径]
    R[ReAct] -->|高适应性<br/>较低可预测性| D[动态路径]
    D --> C1[能够应对未知观察]
    D --> C2[可能重复、漂移或超预算]
{{< /mermaid >}}

ReAct 的优点是适应开放环境，不必穷举所有分支。代价是路径难以预测，循环可能重复调用工具、累积上下文或放大错误观察。

## 适用与不适用场景

适合使用 ReAct：

- 下一步明显依赖当前环境反馈；
- 工具调用结果无法在运行前预测；
- 探索空间有限，并且可以定义预算和停止条件。

不适合使用 ReAct：

- 步骤和分支可以由代码完整表达；
- 动作必须严格复现或满足固定合规流程；
- 错误探索代价很高，环境又缺少安全隔离。

## 与相关模式的区别

| 模式 | 主要控制尺度 |
|---|---|
| Workflow | 预先定义完整路径 |
| ReAct | 根据一次观察选择下一动作 |
| Plan-and-Execute | 用计划维持长任务的全局结构 |
| Autonomous Loop | 管理整次长期运行的持续、恢复与终止 |

ReAct 可以只出现在 Workflow 的某一个探索节点中，也可以作为 Plan 中某个步骤的执行方式。它不是所有 Agent 的默认主循环。

## 模式小结

| 维度 | ReAct |
|---|---|
| 意图 | 根据环境反馈动态决定下一步 |
| 识别信号 | Action 与 Observation 交替出现 |
| 主要优点 | 适应未知环境和动态分支 |
| 主要代价 | 路径不稳定、循环和上下文成本 |
| 使用原则 | 只在必须运行时决策的局部使用 |
