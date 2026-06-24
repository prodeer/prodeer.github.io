+++
date = '2026-06-24T12:00:00+08:00'
draft = false
title = 'AI Agent 设计模式（八）：Autonomous Loop——在约束下持续推进目标'
categories = ['AI 大模型']
tags = ['Agent', 'Autonomous Agent', 'Agent Loop', '设计模式']
series = ['AI Agent 设计模式']
mermaid = true
+++

一次服务故障可能持续数小时。系统需要定期读取指标、判断是否恢复、必要时执行诊断，还可能等待工程师批准某个动作。它不能依赖一个始终保持连接的 HTTP 请求，也不能无限循环。

Autonomous Loop 模式让 Agent 围绕目标持续运行，同时用状态、预算和终止策略限制自主性。

<!--more-->

## 模式意图

> 在多轮甚至跨进程的运行中持续评估目标、选择工作并检查结果，直到完成、暂停、失败或被取消。

这个模式关注的是完整 Run 生命周期，而不只是某一步怎样决策。自主意味着系统可以在没有用户逐步指挥的情况下继续推进，不意味着它拥有无限时间和权限。

![AI Agent Autonomous-Loop 设计模式](/images/ai/ai-agent-autonomous-loop-pattern.png)

## 问题场景：长期故障跟踪

目标是“跟踪支付服务故障，确认恢复并生成事件摘要”。运行可能经历：

- 每隔一段时间读取错误率和延迟；
- 指标异常时收集诊断信息；
- 高风险操作前等待人工确认；
- Worker 重启后从上次状态继续；
- 指标稳定一段时间后宣布恢复；
- 超过时间预算后暂停并说明进度。

这里的重点不在单次监控查询，而在目标怎样跨多轮持续存在。

## 基本结构

{{< mermaid >}}
flowchart LR
    G[Goal] --> C[Run Controller]
    C --> S[(Run State)]
    S --> N[Select Next Work]
    N --> E[Execute]
    E --> V[Evaluate Progress]
    V --> S
    V -->|继续| N
    V -->|需人工| W[Waiting]
    W --> C
    V -->|终止| T[Completed / Failed / Cancelled]
{{< /mermaid >}}

主要参与者包括：

- **Goal**：持续运行要达到的目标；
- **Run State**：进度、事件、预算和当前状态；
- **Controller**：选择下一工作并执行状态转换；
- **Progress Evaluator**：判断目标是否推进；
- **Checkpoint**：保存可恢复状态；
- **Stop Policy**：定义完成、暂停、失败和取消。

## 运行过程

{{< mermaid >}}
stateDiagram-v2
    [*] --> Queued
    Queued --> Running
    Running --> Running: progress made
    Running --> Waiting: approval or external event
    Waiting --> Queued: resume signal
    Running --> Paused: budget reached
    Paused --> Queued: explicit resume
    Running --> Completed: goal satisfied
    Running --> Failed: terminal error
    Running --> Cancelled: cancel signal
    Completed --> [*]
    Failed --> [*]
    Cancelled --> [*]
{{< /mermaid >}}

最小控制逻辑可以表示为：

```python
while run.status == "running":
    if stop_policy.must_stop(run):
        return run.pause_or_finish()
    work = controller.next_work(run)
    result = executor.execute(work)
    run.record(result)
    checkpoint.save(run)
```

真正的长期运行通常由队列或调度器分批唤醒，不必让一个进程始终停留在 `while` 中。

## 核心特点

### 目标跨多轮持续存在

单次调用结束后，Run 仍有身份和状态。下一次 Worker 领取任务时，可以知道已经完成什么、还差什么。

### 运行具有正式生命周期

`waiting`、`paused`、`failed` 和 `cancelled` 代表不同语义。只有一个 `done` 布尔值，无法表达等待人工或预算耗尽。

### 自主性受到预算约束

时间、Token、工具次数、费用和风险都可以成为预算。Runtime 维护真实计数，模型不能自行扩大资源。

### 无进展也是一种信号

重复动作、相同错误和长期没有新增产物说明循环可能卡住。系统需要暂停、重新规划或请求人工，而不是只提高最大轮数。

## Autonomous Loop 与 ReAct 的尺度差异

{{< mermaid >}}
flowchart TB
    subgraph R[ReAct]
        R1[Decide] --> R2[Act]
        R2 --> R3[Observe]
        R3 --> R1
    end
    subgraph A[Autonomous Run]
        A1[Choose Task] --> A2[Execute Step]
        A2 --> A3[Checkpoint]
        A3 --> A4[Evaluate Goal]
        A4 --> A1
    end
    R -->|一次局部决策循环| X[较短控制尺度]
    A -->|完整运行生命周期| Y[较长控制尺度]
{{< /mermaid >}}

ReAct 可以成为 Autonomous Run 中某个步骤的执行方式，但长期运行也可以完全由固定 Workflow 推进。代码里有循环不代表系统就是自主 Agent。

## 优点与代价

| 优点 | 代价 |
|---|---|
| 可以处理长时间目标 | 状态和恢复机制更复杂 |
| 能暂停、等待和继续 | 需要预算、取消和所有权管理 |
| 运行轨迹可以观察 | 错误可能在长循环中放大 |
| 减少用户逐步指挥 | 必须设计明确的人类介入点 |

## 适用与不适用场景

适合使用：

- 任务持续时间超过一次请求或一次进程；
- 需要等待外部事件或人工审批；
- 运行可能暂停、恢复或由其他 Worker 接管；
- 可以定义目标进度、预算和终止状态。

不适合使用：

- 一次请求内即可完成；
- 固定定时任务用普通调度器已经足够；
- 无法判断是否取得进展或何时停止；
- 动作风险高，却没有权限和人工控制。

## 与相关模式的区别

| 概念 | 核心关注点 |
|---|---|
| Automation | 按预定规则自动执行 |
| ReAct | 根据一次观察选择下一动作 |
| Scheduler | 决定何时触发任务 |
| Autonomous Loop | 围绕目标持续、恢复并终止一次 Run |

自动化程度高不等于自主性高。一个每晚固定运行的脚本可以高度自动化，却没有运行时目标决策。

## 模式小结

| 维度 | Autonomous Loop |
|---|---|
| 意图 | 在约束下持续推进长期目标 |
| 识别信号 | Run 状态、进度评估、恢复与终止策略 |
| 主要优点 | 长任务持续性和可恢复性 |
| 主要代价 | 状态治理、预算、死循环和责任边界 |
| 使用原则 | 自主程度越高，停止与恢复设计越重要 |
