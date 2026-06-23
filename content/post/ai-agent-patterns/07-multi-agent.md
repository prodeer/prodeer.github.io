+++
date = '2026-06-23T21:30:00+08:00'
draft = false
title = 'AI Agent 设计模式（七）：Multi-Agent——通过角色边界分配工作'
categories = ['AI 大模型']
tags = ['Agent', 'Multi-Agent', 'Subagent', '设计模式']
series = ['AI Agent 设计模式']
mermaid = true
+++

一次软件发布评审同时涉及安全、性能和发布流程。让一个 Agent 在同一上下文里不断切换角色当然可行，但不同职责可能需要不同工具、权限和评价标准，也可能需要并行工作。

Multi-Agent 模式把任务分配给多个相对独立的 Agent，再通过交接或共享状态协调结果。

<!--more-->

## 模式意图

> 将复杂任务拆分给多个具有独立职责、上下文或能力边界的 Agent，并通过明确协议完成协调。

Multi-Agent 的价值不来自 Agent 数量，而来自边界。只是在同一个 Prompt 中写“现在扮演三个专家”，没有独立状态、工具或交接，仍然更接近单 Agent 角色提示。

![AI Agent Multi-Agent 设计模式](/images/ai/ai-agent-multi-agent-pattern.png)

## 问题场景：软件发布评审

发布前需要三类检查：

- Security Reviewer 检查权限、依赖漏洞和敏感信息；
- Performance Reviewer 分析压测和容量数据；
- Release Coordinator 汇总结果并判断是否满足发布门槛。

安全角色可以读取扫描报告，却不应该拥有发布权限；性能角色需要访问监控数据；协调角色只读取两类评审产物。职责与权限边界使拆分具有实际意义。

## 基本结构

{{< mermaid >}}
flowchart TB
    U[Release Goal] --> S[Coordinator]
    S --> SA[Security Agent]
    S --> PA[Performance Agent]
    SA --> A[(Review Artifacts)]
    PA --> A
    A --> S
    S --> O[Release Decision]
{{< /mermaid >}}

主要参与者包括：

- **Coordinator/Supervisor**：分配任务、收集结果并处理异常；
- **Specialist Agent**：在限定职责和工具内完成子任务；
- **Handoff**：描述目标、输入引用和期望输出；
- **Shared Artifact**：保存可复用、可验证的中间结果；
- **Conflict Policy**：处理角色间的不一致。

## 三种常见协作结构

{{< mermaid >}}
flowchart TB
    subgraph S[Supervisor]
        S0[Supervisor] --> S1[Agent A]
        S0 --> S2[Agent B]
    end
    subgraph P[Peer-to-Peer]
        P1[Agent A] <--> P2[Agent B]
        P2 <--> P3[Agent C]
    end
    subgraph B[Blackboard]
        B1[Agent A] --> BB[(Shared State)]
        B2[Agent B] --> BB
        BB --> B3[Agent C]
    end
{{< /mermaid >}}

- Blackboard 通过共享状态协作，适合产物驱动的并行任务，但需要处理版本和并发；
- Peer-to-Peer 灵活，却容易循环交接；
- Supervisor 结构控制清晰，但中心角色可能成为瓶颈。

## 运行过程

{{< mermaid >}}
sequenceDiagram
    participant C as Coordinator
    participant S as Security Agent
    participant P as Performance Agent
    participant A as Artifact Store
    C->>S: security review task
    C->>P: performance review task
    par independent reviews
        S->>A: security report
    and
        P->>A: performance report
    end
    A-->>C: artifact references
    C->>C: merge, resolve or escalate
{{< /mermaid >}}

交接应传递任务和产物引用，而不是复制全部聊天记录：

```python
handoff = {
    "objective": "检查发布包的安全风险",
    "input_refs": ["build-184", "scan-92"],
    "constraints": ["read_only"],
    "expected_output": "security_review",
}
```

这种结构让接收方知道要做什么，也限制了不相关上下文和指令传播。

## 核心特点

### 角色具有独立边界

每个 Agent 可以有独立 Prompt、上下文、工具、权限和状态。边界越真实，Multi-Agent 的意义越明确。

### 协作依赖通信协议

多个角色不会自动形成团队。任务怎样分配、产物怎样表示、冲突由谁处理，都需要显式协议。

### 并行是可能收益，不是必然收益

子任务真正独立时可以并行；如果所有步骤都依赖同一上下文或需要频繁交接，多 Agent 反而更慢。

### 独立性可以改善评价

让 Reviewer 不继承 Generator 的全部上下文和工具，有助于形成更独立的检查。但多个模型给出相同意见，也不等于事实获得证明。

## 优点与代价

| 优点 | 代价 |
|---|---|
| 职责和权限更清晰 | 通信与协调成本增加 |
| 上下文可以按任务隔离 | 信息可能在交接中丢失 |
| 独立任务可以并行 | 容易重复工作或争抢预算 |
| 可为角色配置不同能力 | 错误可能沿交接级联传播 |

## 适用与不适用场景

适合使用：

- 子任务可以明确拆分，并且存在真实并行收益；
- 不同职责需要不同工具或权限；
- 评价需要与生成保持较强独立性；
- 单一上下文已经成为干扰或容量瓶颈。

不适合使用：

- 任务很短，只有少量模型调用；
- 子任务高度共享上下文并频繁依赖彼此；
- 只是希望模型“更专业”，却没有实际边界；
- 系统无法定义稳定的交接和冲突策略。

## 与相关模式的区别

| 概念 | 区别 |
|---|---|
| 角色 Prompt | 同一 Agent 在不同提示下工作 |
| Tool | 为 Agent 增加动作，不增加独立决策主体 |
| Multi-Agent | 存在多个独立职责和运行边界 |
| Plan-and-Execute | 负责任务分解，不规定必须由多个 Agent 执行 |

计划中的多个步骤可以全部由一个 Executor 完成；多个 Agent 也可以在没有动态 Plan 的固定流程中协作。两种模式并不互相包含。

## 模式小结

| 维度 | Multi-Agent |
|---|---|
| 意图 | 在多个独立角色间分配和协调工作 |
| 识别信号 | 独立职责、上下文或权限，加上交接协议 |
| 主要优点 | 隔离、并行和专业化 |
| 主要代价 | 通信、冲突、重复和级联错误 |
| 使用原则 | 没有真实边界，就不要为了角色数量拆分 |
