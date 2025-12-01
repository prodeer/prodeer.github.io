+++
date = '2025-12-01T09:00:00+08:00'
draft = false
title = '深入理解 Eino（一）：为什么需要一个 Go Agent Framework？'
categories = ['AI 大模型']
tags = ['Eino', 'Agent']
series = ['深入理解 Eino']
mermaid = true
+++

转组后要做技术分享，加上技术团队也一直反复强调拥抱 AI，借着这个机会，学习如何用 Go 原生的方式写 AI Agent，工具就是字节跳动开源的 **Eino**。

<!--more-->

## 1. 背景：LLM 应用开发正在从「调用模型」走向「构建智能系统」

2023 年以前，大多数大模型应用的开发模式非常简单：

```text
用户输入 → Prompt Template → LLM API → 返回结果
```

例如：

```go
response, err := client.ChatCompletion(ctx, messages)
```

开发者主要关注：
- Prompt 怎么写
- 模型效果怎么样
- Token 消耗多少

这种模式本质上还是：**软件调用一个外部 AI 服务。**

但是随着 GPT-4、Claude、DeepSeek 等模型能力提升，应用形态发生变化。现在的 AI 应用越来越像一个智能系统。

例如一个企业知识助手：

```
用户问题 → 判断问题类型 → 查询知识库 → 调用企业 API → 分析结果 → 生成回答
```

一个自动化 Agent：

```
用户目标 → Planner 制定计划 → 调用工具 → 观察结果 → 调整计划 → 完成任务
```

这时候问题出现：**传统 LLM SDK 已经无法满足需求。**

## 2. LLM 应用工程化遇到的问题

### 2.1 Prompt 开始变成复杂逻辑

早期：

```text
你是一个客服助手，请回答用户问题
```

后来：

```text
如果用户询问订单：    查询订单系统
如果用户询问退款：    调用退款 API
如果用户投诉：       转人工
否则：              使用知识库回答
```

Prompt 开始承担业务逻辑、流程控制、状态管理，最终导致 **Prompt 变成了一种不可维护的程序语言。**

### 2.2 Chain 越来越复杂

最开始：`Question → LLM → Answer`

后来：`Question → Rewrite Query → Retriever → Reranker → Prompt Builder → LLM → Answer`

再后来：

```
User → Agent ─┬─ Search API
              ├─ Database
              ├─ Code Interpreter
              └─ Browser
```

调用关系开始变成有分支、有循环、有条件判断、有状态。传统函数调用方式 `step1(); step2(); step3()` 已经无法表达。

### 2.3 Agent 需要 Runtime

这是关键变化。很多人认为 Agent = LLM + Prompt + Tool。

实际上生产环境中的 Agent：

```
Agent = LLM + Planning + Execution Loop + Tool Runtime + Memory + State Management + Observation + Evaluation
```

例如一个 Agent 请求「帮我分析今年销售下降原因」，内部发生的是：

```
Agent Runtime → Planner → 决定步骤 → Executor → Tool Calls → Observation → 继续规划 → Final Answer
```

这个过程已经类似**一个运行中的智能程序**。因此需要新的抽象：**Agent Framework。**


## 3. Agent Framework 的核心能力是什么？

一个成熟 Agent Framework 通常包含：

```
Agent Application → Agent Runtime → [Planner / Executor / Memory / Knowledge] → [Tools / Models]
```

具体包括：

- **Model Layer**：Chat Model、Embedding Model、Multimodal Model
- **Prompt Layer**：Prompt Template、Message Management、Context Assembly
- **Tool Layer**：Database、API、Search、Code Execution、File System
- **Memory Layer**：短期（对话历史）、长期（用户偏好、历史事实）
- **Knowledge Layer**：企业文档、向量数据库、RAG Pipeline
- **Runtime Layer**：节点调度、状态流转、生命周期、Trace、Error Handling——**Agent 的操作系统**


## 4. Eino 是什么？

CloudWeGo Eino 是一个面向 Go 语言的大模型应用开发框架，**2025 年初正式开源**，字节内部豆包、抖音、扣子已跑两年多。

Eino 官方对自己的定义是「The ultimate LLM/AI application development framework in Go」，吸收 LangChain / Google ADK 经验，但按 Go 惯例重做。它不是一个 SDK，也不是 Chain 库，而是 **Components + Orchestration + ADK** 三层叠起来的 Agent Runtime。

它的目标是：**让 Go 开发者使用工程化方式构建 LLM 应用和 Agent。**

简单理解：**Eino = Go 版本的 Agent Application Framework。**


- **组件层**：原子能力，全是接口 + 泛型
- **编排层**：把组件连成图，编译期做类型对齐 + 流式推导
- **应用层（ADK）**：在图之上封装 ReAct / 多 Agent / 中断恢复
- **横切机制**：日志、Trace、鉴权、人工审批，不入侵业务代码

---

## 5. Eino 的核心设计思想

Eino 最大的特点是 **三支柱 + 一横切**，而不是简单的「Component + Graph」。

### 5.1 Component：能力组件化

Eino 不希望写 `doEverything()` 这种大函数，而是拆成独立的组件：

```
ChatModel / Retriever / Tool / Parser / Memory / Embedding / Indexer / DocumentLoader / ChatTemplate
```

每个组件：
- 独立
- 可替换（换模型只改构造那一行）
- 可组合（通过 Graph 连起来）

类似微服务的思想，粒度是「LLM 应用的最小能力单元」。

### 5.2 Orchestration：Graph / Chain / Workflow

组件解决「有什么能力」，编排解决「怎么运行」。

Eino 提供三种编排原语：

- **Chain**：线性流水线，适合 `Prompt → Model → Parser`
- **Graph**：通用有向图，支持分支、回边、循环。ReAct Agent 的核心就是带环的图
- **Workflow**：字段级映射的 DAG，适合结构化数据按字段路由

三者最终都编译成 `Runnable[I, O]`——一个有类型的、可执行的单元。编译期自动做类型校验、流式推导、并发控制。**如果图里有类型不匹配，编译阶段就会报错，不会等到线上请求来了才 panic。**

### 5.3 ADK + 横切：生产就绪的 Agent Runtime

ADK 层在图之上封装了可以直接用的 Agent 模式：
- `ChatModelAgent`：绑定 Tool 的 ReAct 循环
- `MultiAgent`（Host–Specialist）：宿主 Agent 派发到专家 Agent
- `Runner`：跑 Agent、发事件流、管 Checkpoint
- `Interrupt / Resume`：任意节点暂停等人审批，持久化后恢复（HITL）

横切机制贯穿所有层：
- **Callback 五点**：OnStart / OnEnd / OnError / OnStartStream / OnEndStream
- **Aspect**：在不支持 Callback 的实现上也能注入
- **Option 分发**：编译后的 Runnable 接收 Option 并下发给指定节点

> 一句话收口：**Component 解决「有什么」，Orchestration 解决「怎么跑」，ADK + Callback 解决「跑起来像不像生产系统」。**

---

## 6. 为什么 Eino 选择 Graph？

这是 Eino 和很多简单 LLM SDK 的最大区别。

传统 Pipeline `A → B → C` 无法表达：
- **循环**：`Planner → Tool → (回边) → Planner`
- **条件**：`Classifier → Search / Database`
- **动态路径**：Agent 天然需要分支、循环、动态决策

Graph 更符合 Agent Runtime 的本质。

---

## 7. Eino 与 LangChain / LangGraph 对比

| 维度           | LangChain      | LangGraph      | Eino                        |
| -------------- | -------------- | -------------- | --------------------------- |
| 语言           | Python/JS      | Python         | Go                          |
| 定位           | LLM Framework  | Agent Runtime  | LLM/Agent Framework         |
| 核心           | Chain          | StateGraph     | Graph + Component + ADK     |
| 类型系统       | 动态类型        | 动态类型        | 泛型 `Runnable[I,O]` + 编译期校验 |
| 流处理         | 回调/Generator | 回调           | StreamReader 四种范式统一     |
| 回调/可观测    | Callbacks      | 有限           | 5 点 Callback + Aspect 贯穿   |
| 适合场景       | 快速原型        | 复杂 Agent     | Go 工程体系 / 生产后端         |
| 企业 Go 服务   | 弱             | 弱             | 强                           |

**Eino 的三个硬差异化**：
1. **类型安全**：泛型 `Runnable[I,O]` + 编译期类型匹配，大型工程重构成本远低于 Python 动态类型
2. **流式统一**：`StreamReader[T]` 四种范式（Invoke / Stream / Collect / Transform），组件只需关心自己的那一种
3. **回调贯穿**：5 点 Callback + Aspect 注入，可观测性不入侵业务代码

对于 Go 后端，Eino 的思维模型更接近：**微服务架构 + 工作流引擎 + AI Runtime**。

---

## 8. 一个简单 Eino 应用模型

例如一个知识问答 Agent：

{{< mermaid >}}
graph LR
    START((Input)) --> RET[Retriever]
    RET --> MODEL[ChatModel]
    MODEL --> END((Output))
{{< /mermaid >}}

在 Eino 中用真实 API 是这样表达的（以下代码来自官方示例风格，可运行）：

```go
import (
    "github.com/cloudwego/eino/compose"
    "github.com/cloudwego/eino/schema"
)

// 1. 建图：指定输入输出类型
g := compose.NewGraph

// 2. 添加节点
g.AddRetrieverNode("retriever", myRetriever)
g.AddChatModelNode("model", myChatModel)

// 3. 连线
g.AddEdge(compose.START, "retriever")
g.AddEdge("retriever", "model")
g.AddEdge("model", compose.END)

// 4. 编译 → 得到 Runnable
r, err := g.Compile(ctx)
if err != nil {
    // 编译期类型不匹配会在这里报错
    panic(err)
}

// 5. 执行
out, err := r.Invoke(ctx, "今年销售下降的原因是什么？")
```

最终 Graph 执行：`Invoke(ctx, input)` 一路经过 Retriever → ChatModel，返回 `*schema.Message`。

---

## 9. 总结

Eino 出现的原因，不是因为调用 LLM 很复杂。

真正的问题是：**当 AI 应用从一次请求一次回答，发展成具备规划、执行、记忆、工具调用能力的智能系统时，需要一个新的运行模型。**

Eino 的核心思想：

```
Component + Orchestration + ADK + Engineering Practices
```

它帮助 Go 开发者从**调用模型**升级到**构建 Agent 系统**。
