+++
date = '2025-12-09T09:00:00+08:00'
draft = false
title = '深入理解 Eino（三）：Chain vs Graph--Agent 为什么需要 Graph？'
categories = ['AI 大模型']
tags = ['Eino', 'Chain', 'Graph', '编排']
series = ['深入理解 Eino']
mermaid = true
+++

Eino 同时有 Chain 和 Graph，都能编排流程。Chain 解决的是“固定流程编排”，Graph 解决的是“动态智能系统运行”。理解两者的边界，是理解 Agent Runtime 架构的关键。

这篇讲清两者的本质区别，以及为什么 Agent 这个场景必须有 Graph。

<!--more-->

## 1. 从 Chain 到 Graph：LLM 应用架构的演进

大模型应用的发展，大致经历了三个阶段：

```text
LLM API 直接调用
        ↓
Chain 线性工作流
        ↓
Graph Agent Runtime
```

**第一阶段：直接调用 LLM**

```go
resp, _ := model.Generate(ctx, messages)
```

适合 Chat、翻译、总结。但业务逻辑一旦进 Prompt（“如果是订单就查订单系统…”），Prompt 就成了不可维护的程序语言。

**第二阶段：Chain 出现**

把“Query Rewrite → Retriever → Prompt → LLM”拆成顺序组件，这就是 Chain。它解决了 Prompt 膨胀问题，但前提是**下一步永远已知**。

**第三阶段：Graph Agent Runtime**

Agent 的下一步由模型决定，可能分支、可能循环、可能回退。Chain 表达不了，Graph 上场。

## 2. 什么是 Chain

Chain 本质是一条**只能向前走的线性序列**：

```text
A → B → C
```

输出 A 是 B 的输入，B 的输出是 C 的输入。Eino 里真实写法：

```go
chain, _ := compose.NewChain.
    AppendChatTemplate(tmpl).
    AppendChatModel(cm).
    Compile(ctx)

out, _ := chain.Invoke(ctx, map[string]any{"query": "北京天气"})
```

Chain 的特点（来自 Eino 编译模型）：
- **拓扑强制线性**：无分支、无循环、无扇出
- **单节点执行**：同一时刻只有一个节点在跑，不并发
- **整体 I/O**：`Runnable[I, O]`，首尾类型在编译期定死
- **底层就是 Graph**：Chain 是在 Graph 的 Pregel 模式上实现的，只是框架帮你禁掉了非线性的边

### Chain 的优势

- **流程清晰**：RAG、摘要、翻译这种固定流水线一眼看懂
- **样板代码少**：`AppendXxx` 链式调用，比 Graph 少写一半 `AddEdge`
- **可测试**：每个节点独立测，耗时可预测（Retriever 100ms + LLM 2s = 2.1s）
- **类型安全**：编译期校验相邻节点 I/O 泛型匹配

> Chain 没有过时，它只是适用面窄。

## 3. Chain 的边界在哪里

Chain 隐含一个假设：**控制流是开发者写死的**。

但 Agent 的控制流是模型在运行时决定的：

```text
用户：分析今年收入下降原因
─────────────────────────────
情况A：查数据库 → 分析趋势 → 报告
情况B：搜市场新闻 → 分析行业 → 报告
情况C：查数据库 → 发现异常 → 调财务API → 再分析 → 报告
```

这三件事 Chain 做不了：

1. **无法表达条件分支**（分类后走不同路）
2. **无法表达循环**（Think → Tool → Observe → Think…）
3. **无法承载动态路由**（下一跳由 LLM 输出决定，不是代码写死）

有人会说“Chain 里套 if 不就行了”——但那个 if 是你**预见的**分支；Agent 的分支是模型**临场生成**的，你预见不完。

## 4. 什么是 Graph

Graph = 节点 + 边，但 Eino 的 Graph 比“流程图”多三样东西：

- **Branch（条件路由）**：`AddBranch` 消费节点输出（常是 Stream 首帧）决定下一跳，不是静态边
- **回边（Cycle）**：`tools → chatModel` 形成 Pregel 循环，靠 `WithMaxRunSteps` 限步
- **State**：`WithGenLocalState` + `StatePre/PostHandler` 在节点间安全传状态

一个 ReAct Agent 的 Graph 骨架：

{{< mermaid >}}
graph TD
    START((START)) --> TMPL[ChatTemplate]
    TMPL --> CM[ChatModel]
    CM --> BR{StreamGraphBranch<br/>有 ToolCall?}
    BR -- 有 --> TOOLS[ToolsNode]
    BR -- 无 --> END((END))
    TOOLS --> CONV[Lambda: 结果回写Messages]
    CONV --> CM
{{< /mermaid >}}

真实代码：

```go
g := compose.NewGraph
g.AddChatTemplateNode("tmpl", tmpl)
g.AddChatModelNode("model", cm)
g.AddToolsNode("tools", toolsNode)
g.AddLambdaNode("conv", compose.InvokableLambda(takeOne))
g.AddEdge(compose.START, "tmpl")
g.AddEdge("tmpl", "model")
g.AddBranch("model", branch)          // 条件路由
g.AddEdge("tools", "conv")
g.AddEdge("conv", "model")            // 回边 → 循环
g.AddEdge("model", compose.END)
r, _ := g.Compile(ctx, compose.WithMaxRunSteps(10))
out, _ := r.Invoke(ctx, map[string]any{"query": "北京周末天气"})
```

## 5. Chain 与 Graph 的本质区别

不是“谁替代谁”，而是**关注点不同**：

| 维度 | Chain | Graph |
| --- | --- | --- |
| 拓扑 | 线性序列 | 有向图（DAG 或含环 Pregel） |
| 分支 | 无 | `AddBranch` 动态路由 |
| 循环 | 无 | 支持回边 + MaxRunSteps |
| 并发 | 单节点 | 支持扇出/扇入 |
| State | 无（可挂 Callback） | `WithGenLocalState` 一等公民 |
| 字段映射 | 整体 I/O | 整体 I/O（Workflow 才做字段级） |
| 底层 | 编译成线性 Graph Runner | Graph Runner |
| 适用 | 固定流水线 | Agent / 动态系统 |

一句话：**Chain 是 Graph 在“线性拓扑”这个约束下的特例**。

## 6. Eino 中三者的关系（Chain / Graph / Workflow）

不是并列三层，而是：

```text
        Runnable[I, O]
             ↑ 编译产物
   ┌─────────┼─────────┐
 Chain     Graph     Workflow
（线性）  （任意DAG/环）（字段级DAG）
```

- **Chain**：`Template → Model → Parse` 这种最简流水线
- **Graph**：ReAct、多 Agent、带分支循环的任何东西
- **Workflow**：节点是不同 struct，需要把 A.Output 映射到 B.Input.FieldX 时用（RAG 里较少，结构化 ETL 多）

Graph 里可以把一个 Chain 或 Workflow 包成 `AddGraphNode` 当子图用——所以**Chain 是 Graph 的节点，不是 Graph 的兄弟**。

## 7. 为什么 Agent 必须需要 Graph

Agent 的四个天然特征，Chain 只能覆盖第零个：

1. **自主规划**：下一步是模型定的，不是代码定的 → 需要 Branch
2. **工具调用循环**：LLM ↔ Tool 来回多轮 → 需要回边
3. **状态累积**：Messages、ToolResults、Plan 进度跨节点存活 → 需要 State
4. **动态路径**：分类结果决定走 Search 还是 SQL → 需要运行时路由

缺任意一个，都不是生产级 Agent，只是“智能函数”。

## 8. 工程上怎么选

**用 Chain**：流程固定
- RAG：`问题 → 搜索 → 回答`
- 文档总结：`文档 → 摘要 → 输出`

**用 Graph**：流程不确定
- 自动研究 Agent：`提出问题 → 决定搜索方式 → 分析结果 → 继续搜索 → 行成结论`
- 自动化 Agent：`目标 → 规划 → 执行 → 修正`

## 9. 小结

Chain 解决**如何把几个 AI 能力连接起来**，Graph 解决**如何运行一个具有自主性的智能系统**。

Eino 的核心价值，不是提供更多 API，而是提供：
```
Component + Graph + Runtime
```
让 Go 开发者可以使用工程化方式构建 Agent。