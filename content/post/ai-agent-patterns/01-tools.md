+++
date = '2026-06-17T21:30:00+08:00'
draft = false
title = 'AI Agent 设计模式（一）：Tools——让模型获得受控行动能力'
categories = ['AI 大模型']
tags = ['Agent', 'Tools', 'Function Calling', '设计模式']
series = ['AI Agent 设计模式']
mermaid = true
+++

语言模型擅长解释“订单为什么还没发货”，但它并不知道订单状态，因为这些数据并不在模型的参数里。模型需要读取业务系统，甚至可能需要修改地址或发起退款。

**Tools 模式**正是为了解决这一问题。它让模型获得外部能力。该模式最重要的特点不是“可以调用函数”，而是**将行动意图与真实执行严格分开**：模型负责“想做什么”（选择动作），系统负责“能不能做”（验证后执行）。

<!--more-->

## 模式意图

> 将外部系统的能力包装成模型可以选择的结构化动作，同时由确定性运行时保留验证、授权和执行权。

Tools 模式可以让 Agent 读取数据库、搜索网页、发送消息，或者调用已有的业务 API。对模型而言，它看到的是标准化的名称、描述和参数；对系统而言，它依然是一个受严格控制的软件接口。

![AI Agent Tools 设计模式](/images/ai/ai-agent-tools-pattern.png)


## 问题场景：客服查询订单

用户问：“我的订单为什么还没发货？”模型只根据语言猜测没有意义。系统提供两个工具：

- `get_order_status(order_id)`：读取订单状态；
- `request_refund(order_id, reason)`：发起退款，执行前需要确认。

这两个动作风险不同。Tools 模式不仅描述“有哪些动作”，还需要让 Runtime 决定当前身份能否调用、是否需要审批，以及结果怎样返回模型。

## 基本结构

该模式包含四个核心参与者，形成了一个完整的闭环：

- **模型**：根据任务提出工具调用；
- **工具描述**：告诉模型工具用途和参数；
- **Runtime**：校验、授权、执行并记录结果；
- **外部系统**：保存真实状态或产生副作用。

模型不是外部系统的直接客户端。这个中间层正是 Tools 模式的能力边界。

{{< mermaid >}}
flowchart LR
    U[用户问题] --> M[模型]
    M -->|Tool Call| R[Agent Runtime]
    R -->|校验与授权| T[Tool Adapter]
    T --> S[订单系统]
    S --> T
    T -->|结构化结果| R
    R -->|Observation| M
    M --> A[最终回答]
{{< /mermaid >}}


## 运行过程

一个最小的运行流程如下：模型输出调用请求，Runtime 进行安全拦截，执行后返回结构化数据，最后模型基于数据生成自然语言回答。

{{< mermaid >}}
sequenceDiagram
    participant M as Model
    participant R as Runtime
    participant T as Tool
    M->>R: get_order_status(order_id)
    R->>R: Schema + permission check
    R->>T: execute validated call
    T-->>R: shipped = false
    R-->>M: structured observation
    M-->>R: explain result to user
{{< /mermaid >}}

对应的伪代码示例：

```python
call = model.choose_action(question, tool_schemas)
tool = registry.get(call.name)
arguments = tool.validate(call.arguments)
policy.authorize(user, tool, arguments)
result = tool.execute(arguments)
answer = model.respond(question, result)
```

> 注：真正的工具系统会增加超时、重试、幂等和审计，但它们是执行边界的工程展开，不改变模式的基本结构。

## 核心特点

### 能力通过显式接口暴露

模型不能随意操作环境，只能从提供的工具集合中选择。系统能力越明确，动作越容易验证和测试。

### 选择具有不确定性，执行应保持确定性

模型可能选错工具或填错参数，因此 Runtime 必须重新校验。外部系统不能因为“模型通常会遵守 Schema”就放弃服务端约束。

### 工具结果是数据，不是新的指令

网页、数据库字段和第三方结果都可能错误或包含恶意文本。它们应该作为带来源的 Observation 返回，而不是获得与系统指令相同的可信度。

## 优点与代价

{{< mermaid >}}
flowchart TB
    T[Tools 模式]
    T --> B1[获得实时信息]
    T --> B2[复用已有业务能力]
    T --> B3[动作可以审计]
    T --> C1[工具选择可能错误]
    T --> C2[引入权限与副作用]
    T --> C3[工具过多增加上下文]
{{< /mermaid >}}

Tools 的价值在于让语言模型连接确定性能力。代价则来自两个世界的交界：模型输出概率性意图，业务系统要求精确参数和可靠语义。

## 适用与不适用场景

适合使用 Tools：

- 任务需要读取模型参数之外的实时状态；
- 需要调用已有 API、数据库或计算服务；
- 模型适合判断“做哪类动作”，代码适合执行动作。

不必使用 Tools：

- 输入已经包含任务所需全部信息；
- 调用路径固定，由应用代码直接调用更简单；
- 动作风险极高，又无法在执行前验证或审批。

## 与相关模式的区别

| 模式 | 关注点 |
|---|---|
| Tools | Agent 可以做什么 |
| ReAct | 得到工具结果后，下一步做什么 |
| RAG | 怎样检索并组织外部知识 |
| MCP | 工具如何通过一种协议被发现和调用 |

Tools 可以单独出现在固定 Workflow 中，并不天然需要 ReAct。MCP 是实现工具互操作的一种协议，也不等于 Tools 模式本身。

## 模式小结

Tools 的本质，是在 LLM 的“概率世界”与业务系统的“确定世界”之间建立一座桥梁。这座桥的名字，叫 Runtime（运行时）。

| 维度 | Tools |
|---|---|
| 意图 | 扩展模型能够使用的外部能力 |
| 识别信号 | 模型输出结构化动作，Runtime 执行 |
| 主要优点 | 实时、可扩展、可审计 |
| 主要代价 | 权限、副作用、参数和结果治理 |
| 使用原则 | 模型有选择权，系统保留执行权 |
