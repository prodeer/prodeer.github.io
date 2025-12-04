+++
date = '2025-12-04T09:00:00+08:00'
draft = false
title = '深入理解 Eino（二）：Core 深入--Graph 是如何运行的？'
categories = ['AI 大模型']
tags = ['Eino', 'Graph', '编排', '状态机']
series = ['深入理解 Eino']
mermaid = true
+++

Graph 是 Eino 编排能力的核心，也是它对标 LangGraph 的招牌。如果说 Component 是 Eino 的“能力抽象”，那么 Graph 就是 Eino 的“运行时模型”。理解 Graph，是理解 Eino Agent Runtime 的关键。
<!--more-->

## 1. 为什么 Agent Framework 需要 Graph？

传统 LLM 应用是 `Input → LLM → Output` 的一次性函数调用，但 Agent 应用不是。

一个真实的 Agent 请求（例如“帮我分析公司今年收入下降原因”）内部可能是：

```
问题分析 → 制定计划 → 选择工具 → 执行动作 → 观察结果 → 调整计划 → 输出答案
```

它的特点是：
- **非固定流程**：不同问题走不同路径
- **有状态**：需要记住之前调用了哪些工具、得到了什么结果
- **有循环**：根据工具返回结果，可能回到 Planner 重新规划
- **有分支**：根据中间结果决定下一步是查数据库、搜索网络还是直接回答

传统的 `func A() { B(); C(); }` 无法表达这种动态计算图。因此，Eino 选择了 **Graph（有向图）** 作为 Agent 的运行时模型。

## 2. Graph 的本质：有向执行图

从计算机科学角度，Graph 定义为 `G = (V, E)`：
- **V (Vertex)**：节点集合，代表一个执行单元（如 ChatModel、Retriever、Tool）
- **E (Edge)**：边集合，代表数据流转关系

例如一个典型的 RAG 流程：

{{< mermaid >}}

graph LR
    Q[Query] --> R[Retriever]
    R --> P[Prompt Builder]
    P --> M[ChatModel]
    M --> A[Answer]
{{< /mermaid >}}

这里的节点是 `Retriever`、`Prompt Builder`、`ChatModel`，边则是它们之间的数据依赖关系。

## 3. Eino Graph 的核心组成

Eino 的 Graph 不仅仅是数据结构，它包含四个关键要素：**Node、Edge、State、Runtime**。

### 3.1 Node：强类型的执行单元

Node 是 Graph 中最基本的执行单位。在 Eino 中，Node 通常由一个 **Component** 或 **Lambda** 构成。

例如：
- **ChatModel Node**：输入 `[]*schema.Message`，输出 `*schema.Message`
- **Tools Node**：输入 `[]*schema.ToolCall`，输出 `[]*schema.Message`
- **Retriever Node**：输入 `string`，输出 `[]*schema.Document`

Eino 通过 Go 泛型在编译期强制保证：**上游节点的输出类型必须与下游节点的输入类型匹配**。如果不匹配，`Compile()` 阶段就会直接报错。

### 3.2 Edge：静态的数据流

Edge 定义了节点之间的连接关系。在 Eino 中，最简单的边是线性连接：

```go
g.AddEdge(compose.START, "retriever")
g.AddEdge("retriever", "prompt")
g.AddEdge("prompt", "model")
g.AddEdge("model", compose.END)
```

### 3.3 Branch：动态的路由决策

这是 Graph 区别于普通 Pipeline 的关键。Eino 使用 `GraphBranch` 来处理条件分支。

例如，在 ReAct Agent 中，我们需要判断模型输出是否有 ToolCall：
- 如果有 ToolCall → 走 `ToolsNode`
- 如果没有 → 走 `END`

这在代码中体现为 `AddBranch`，而不是 `AddEdge`。

### 3.4 State：Graph 的“内存”

Agent 最大的挑战是状态管理。Eino 引入了 **Graph State** 来解决这一问题。

State 是 Graph 级别的上下文，用于在节点之间共享数据（如对话历史、中间变量、工具调用结果）。它通过 `compose.WithGenLocalState` 在编译时注入，并通过 `WithStatePreHandler` / `WithStatePostHandler` 在节点执行前后读写。

## 4. Graph 生命周期：从定义到执行

一个 Eino Graph 的完整生命周期分为三步：**定义 → 编译 → 执行**。

### 4.1 定义 (Definition)

首先创建 Graph，并指定其输入/输出类型：

```go
// 定义一个 Graph，输入是 map[string]any，输出是 *schema.Message
g := compose.NewGraph
```

然后添加节点（注意是具体的 Node 类型）：

```go
g.AddChatTemplateNode("template", tmpl)
g.AddChatModelNode("model", cm)
g.AddToolsNode("tools", toolsNode)
g.AddLambdaNode("converter", compose.InvokableLambda(takeFirstMessage))
```

### 4.2 编译 (Compile) —— Eino 的核心魔法

这是 Eino 最关键的步骤。`Compile()` 不仅仅是将节点连接起来，它做了四件非常重要的事情：

1. **类型校验**：检查所有相邻节点的 I/O 泛型是否匹配，不匹配直接编译失败。
2. **流式推导**：自动处理流与非流的转换（concat/box/merge/copy）。
3. **并发安全**：为 State Handler 注入并发锁语义。
4. **Aspect 注入**：将 Callback 织入到不支持原生回调的组件中。

```go
runner, err := g.Compile(ctx, compose.WithMaxRunSteps(10))
if err != nil {
    // 这里会捕获类型错误、循环错误等
    panic(err)
}
```

### 4.3 执行 (Execution)

编译后得到一个 `Runnable` 接口，调用 `Invoke` 即可运行：

```go
result, err := runner.Invoke(ctx, inputMap)
```

## 5. 一次 Agent 请求内部发生了什么？

让我们跟踪一个用户请求 `“查询北京天气，并总结”` 在 Graph Runtime 中的执行过程：

#### Step 1: 初始化
`Invoke` 被调用，Runtime 创建一个初始 State，包含用户输入。

#### Step 2: ChatModel 节点执行
- **PreHandler**：从 State 中取出历史 Messages + 当前输入，拼装成完整的 Prompt。
- **Model 调用**：模型生成回复。假设模型决定调用 `get_weather` 工具。

#### Step 3: Branch 判断
`StreamGraphBranch` 消费模型输出的首帧，发现包含 `ToolCall`，决定将流程导向 `tools` 节点。

#### Step 4: Tools 节点执行
- 解析 ToolCalls，并发调用 `get_weather("北京")`。
- 获取结果（如 `{ "city": "北京", "temp": 25 }`）。

#### Step 5: 状态回写与循环
- **PostHandler**：将工具执行结果写回 State。
- Graph Runtime 发现存在回边（Tools → ChatModel），于是开启新一轮迭代。

#### Step 6: 最终输出
第二轮 ChatModel 节点执行，模型看到工具结果后，生成自然语言总结。Branch 判断无 ToolCall，流程走向 `END`，返回最终结果。


## 6. Graph 和 Agent Loop 的关系

很多人误以为 Agent Loop 是用户代码写的 `for` 循环：

```go
// 错误的心智模型
for {
    llm.Call()
}
```

在 Eino 中，**Loop 是由 Graph Runtime 控制的**。

{{< mermaid >}}

graph TD
    START --> CM[ChatModel]
    CM --> B{"Need Tool?"}
    B -- Yes --> T[ToolsNode]
    T -- 回边 --> CM
    B -- No --> END
{{< /mermaid >}}

Runtime 负责：
- 维护执行栈
- 管理 State 的生命周期
- 根据 Branch 结果决定下一个节点
- 通过 `WithMaxRunSteps` 防止无限循环


## 7. Graph Runtime 和传统工作流引擎的区别

| 维度 | 传统工作流 (Airflow/Temporal) | Agent Graph (Eino) |
| :--- | :--- | :--- |
| **流程定义** | 静态 DAG（提前定义好 A→B→C） | **动态 DAG**（由 LLM 决定下一步走 B 还是 C） |
| **分支逻辑** | 基于代码或配置的条件判断 | 基于 **LLM 输出的语义判断** (Branch) |
| **循环机制** | 通常需要外部触发器或特殊配置 | **原生支持回边**，形成推理循环 |
| **状态** | 主要是任务状态 (Success/Fail) | **业务状态 + 对话历史 + 中间结果** |

Agent Graph 更像是一个 **动态工作流引擎**。

---

## 8. Eino Graph 和 LangGraph 的设计区别

| 维度 | LangGraph (Python) | Eino (Go) |
| :--- | :--- | :--- |
| **核心抽象** | StateGraph + conditional_edges | Component + Graph + Branch |
| **类型安全** | 运行时检查 (dict) | **编译期泛型校验** |
| **流式处理** | 需手动处理 stream 合并 | **StreamReader[T] 自动推导与转换** |
| **分支时机** | 通常等待完整响应 | **StreamGraphBranch 消费首帧即可决策** |
| **工程化** | 适合研究与原型 | 适合 **高并发后端服务** |

Eino 的设计更贴近 Go 后端工程师的习惯：**显式、强类型、编译期错误优先**。

## 9. 总结

如果把 Agent 看作一个分布式系统，Eino Graph 的各个组件对应关系如下：

| Agent System | 分布式系统 |
| :--- | :--- |
| Graph | 服务拓扑 (Service Mesh) |
| Node | 微服务 (Microservice) |
| Edge | RPC 调用 |
| State | 分布式缓存 / Context |
| Runtime | 调度器 (Scheduler) |
| Callback | 调用链追踪 (Trace) |

一次 Agent 执行，本质上就是一次复杂的微服务调用链编排。

它的核心思想是：
```
Component (What) + Graph (How) + State (Memory) + Runtime (Control)
```

理解 Graph 的 Compile 机制、Branch 的动态路由、State 的生命周期，你才算真正掌握了 Eino。这也是我们后续手写 ReAct Agent 的理论基础。