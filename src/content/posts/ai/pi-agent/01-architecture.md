---
title: "学习 Pi-Agent（一）：一个极简 Agent 框架的架构解析"
date: 2026-07-25
category: ai
tags: ["Pi-Agent", "Agent"]
description: "Pi-Agent 火了，我也来学一把。但我不想写成“源码翻译”，结合源码和公开资料，我想回答两个问题：  - **Pi-Agent 是什么，为什么值得学习？** - **Pi-Agent 的整体架构为..."
---



Pi-Agent 火了，我也来学一把。但我不想写成“源码翻译”，结合源码和公开资料，我想回答两个问题：

- **Pi-Agent 是什么，为什么值得学习？**
- **Pi-Agent 的整体架构为什么这样设计？**

<!--more-->

## 1. Pi-Agent 是什么，为什么值得学习？

先交代背景：Pi 是一款极简、可扩展的终端编码 Agent，由 libGDX 作者 Mario Zechner 用 **TypeScript** 编写，MIT 协议开源，GitHub 上已有 6 万多 Star。它住在终端里，没有 GUI 和 IDE 插件——这个形态决定了它后续所有的设计选择。

> 说明：Pi 本身是 TypeScript 项目。但本文是从一个 Go 后端开发者的视角来拆解它，下文的伪代码和类比（Go Runtime、Reactor 模式）只是为了讲清运行逻辑，并不代表 Pi 用 Go 实现。

### 1.1 当前 Agent 框架的问题

市面上的 Agent 框架普遍存在一类共同问题：**抽象过重，学习成本高**。为了追求“万能”，许多框架内置了 Planner、Memory、Retriever、Workflow 等一大堆概念，把“Agent 怎么跑起来”藏进多层抽象里。

结果是，开发者能快速调用 `agent.run()`，但一旦遇到复杂场景或性能瓶颈，就完全不知道底层发生了什么。**Agent 到底是怎么“跑起来”的？** 这个问题被隐藏在层层封装之下。

### 1.2 为什么 Pi-Agent 值得学习？

Pi-Agent 没有试图成为“万能 Agent”，而是选择了一条更精巧的道路。它有三大价值：

- **价值 1：足够小、足够透明**。核心循环只有几百行，让“读完”成为可能。它的系统提示词加工具定义不到 1000 个 token（对比 Claude Code 动辄数万 token），而且所有 prompt 源码公开可见，你甚至能用一个 `SYSTEM.md` 文件把整个系统提示词整体替换掉。上下文窗口是 Agent 最稀缺的资源，Pi 把它留给了你的代码。

- **价值 2：架构完整**。麻雀虽小，五脏俱全。它包含了 LLM 抽象、Agent Loop、Tool System、Session 和 Event Stream 等所有关键组件。

- **价值 3：SDK 思维**。Pi 的目标不是做一个好用的 CLI 工具，而是提供一个可复用的 SDK。它将系统清晰地分为模型层、Agent 引擎层和产品层，每一层都可以独立复用。


## 2. Pi-Agent 整体架构：三层堆栈 + 一个正交 UI

### 2.1 总体结构

这里有三个容易混淆的数字，先厘清：

- **三层堆栈**：`pi-ai` → `pi-agent-core` → `pi-coding-agent`，这是一条 SDK 复用链，每一层都能独立使用。
- **四个核心包**：三层堆栈再加上正交的 UI 库 `pi-tui`。
- **五个 workspace 包**：再加上一个外围的、实验性的 `pi-orchestrator`（v0.80.x 新增，负责多 Agent 编排）。它站在 `pi-coding-agent` 之上，本身不实现任何 Agent 内核逻辑，不在本文的学习主线内，下文不展开。

Pi-Agent 的代码组织非常清晰，四个核心包形成了一个分层的架构：

![Pi Agent 的总体架构](/images/ai/pi-sdk-architecture.png)


- `pi-ai`：位于最底层，负责与各种 LLM 提供商交互，屏蔽底层 API 的差异。
- `pi-agent-core`：核心层，实现了 Agent 的运行循环（Loop）、工具系统（Tool System）和会话管理（Session）。
- `pi-coding-agent`：产品层，基于 core 和 ai 构建了一个具体的编程助手应用。
- `pi-tui`：一个独立的终端 UI 层，通过事件流与 core 通信，实现了 UI 与逻辑的解耦。

值得强调的是分层的**唯一硬规则：依赖方向单向向上，底层对上层一无所知**。`pi-ai` 里没有任何一个 `import` 指向上层的包。你可能会注意到 `pi-coding-agent` 竟然直接依赖了最底层的 `pi-ai`——这不算破坏分层，因为 `Message`、`Model`、`Tool` 这些是全系统的“原子类型”，必须在一处（`pi-ai`）定义、各层引用。分层的规则从来不是“只能依赖相邻层”，而是“方向不能反向”。

### 2.2 pi-ai：LLM 抽象层

#### 为什么需要 LLM 抽象？

目前 LLM Provider 五花八门：OpenAI、Anthropic、Gemini，还有本地部署的 Ollama。它们的 API 接口、参数、认证方式各不相同。

如果你的 Agent 核心代码直接绑定了 OpenAI 的 SDK，那么将来切换到其他模型时，将面临巨大的重构工作。因此，Pi 引入了 `pi-ai` 这一层，作为 Agent 与 LLM 之间的稳定接口。

#### pi-ai 解决了什么问题？

它主要做了三件事：

- **第一，统一接口。** 为所有 Provider 提供了统一的 `Chat()` 和 `Stream()` 方法。无论背后是哪个模型，Agent Core 都只需要调用这两个接口。

- **第二，Context 管理。** Agent 与 LLM 的对话是一个持续的过程，涉及 System Message、历史记录、工具调用结果等。`pi-ai` 负责将这些复杂的上下文组装成模型需要的格式，并维护整个对话窗口。

- **第三，Token 追踪。** 自动记录每次调用的 Token 消耗，为成本控制和上下文窗口管理提供了基础。

这一层的设计哲学是：**让上层（Agent Core）永远不需要关心“我在跟谁说话”。**

### 2.3 pi-agent-core：Agent Runtime 核心

从运行时角度看，Agent 的本质是一个 **“感知-思考-行动”** 的循环系统。用公式表示就是：

```
Agent = LLM + Loop + Tool + State
```

- **LLM**：大脑，负责推理和决策。
- **Loop**：循环引擎，驱动整个过程的持续进行。
- **Tool**：手脚，让 Agent 能够影响外部世界。
- **State**：状态，记录 Agent 当前所处的阶段和上下文。

而这个公式中的所有元素，都在一个 **Runtime** 中运行。

什么是 Runtime？就像 Go Runtime 负责调度 Goroutine、管理内存一样，Agent Runtime 负责调度“智能”——管理 LLM 调用和 Tool 执行的生命周期。当你调用 `agent.Run()` 时，实际上启动了一个 Agent Runtime，它内部维护着一个事件循环，不断判断：下一步是让 LLM 继续思考，还是执行一个工具调用？

### 2.4 工具系统：Agent 的手脚

Pi-Agent 默认提供了四个核心工具：`read`、`write`、`edit`、`bash`（另有 `grep`、`find`、`ls` 三个辅助工具）。

#### 为什么只有四个？

这不是功能简陋，而是一种深思熟虑的设计。**Tool 定义了 Agent 的能力边界。** 这四个工具恰好构成了一个 Observe-Change-Act 的完整闭环，优雅地映射了人类程序员的工作模式——先看代码，再改代码，最后运行验证：



![Mermaid 图表](/images/mermaid/mermaid-f782b4e1-1.svg)



- **`Tool`**：LLM 视角，只知道工具“长什么样”。这是 LLM 需要的全部信息，**没有 `execute` 字段**，因为 LLM 不需要知道工具怎么执行。
- **`AgentTool`**：Agent 视角，用**继承**在 `Tool` 之上加了 Agent 循环需要的“怎么执行”。
- **`ToolDefinition`**：产品视角，再加上产品层关心的“怎么显示”。

关键在于：**底层类型从不被修改，上层只用继承和联合类型往上叠。** 这样 `pi-ai` 才能作为最小、稳定的地基被独立发布和复用，而上层需求的变化永远不会震垮地基。


### 2.5 pi-coding-agent：产品层

有了核心引擎，为什么还需要一个 `pi-coding-agent` 层？

因为 **Agent Engine 不等于产品**。就像 gRPC Framework 不等于一个具体的微服务一样。

`pi-coding-agent` 的作用是将 `pi-agent-core` 这个通用引擎，与特定的业务场景（编程助手等）结合起来。它做的事情包括：

- 注入特定的 **System Prompt**，告诉 Agent 它是一个编程助手。
- 管理 **Session**，持久化对话历史。这里有个精巧的设计：Pi 把会话存成**树结构（DAG）**而不是线性日志。线性日志只能追加、回退等于删除，而树结构让每条历史消息都能成为分叉起点——用 `/tree` 跳到任意节点开新分支，同一起点可以并行尝试多种修复方案，所有分支共存于一个文件里。调试时永远“回得去”。
- 加载 **Extension**，比如自定义的代码检查工具。
- 提供 **CLI** 入口，方便用户启动。

这很好地体现了分层设计的价值：`pi-agent-core` 保持通用性，而具体的产品逻辑在 `pi-coding-agent` 层实现。


### 2.6 pi-tui：为什么 UI 要解耦？

很多 Agent 产品将 UI 和 Runtime 深度耦合，导致难以扩展。Pi 则做得非常彻底：`pi-tui` 作为一个完全独立的库存在，运行时依赖只有 `marked` 和 `get-east-asian-width` 两个包，源码里零处 `import` 来自兄弟包 `pi-*`。

这意味着你可以有多种使用方式：

- **场景 1：纯 API 调用**。只引入 `pi-ai`，在你的应用中直接调用 LLM。
- **场景 2：定制化 Agent**。引入 `pi-agent-core`，自己实现一套 UI 或集成到现有系统中。
- **场景 3：开箱即用的产品**。直接使用 `pi-coding-agent`，获得一个完整的编程助手。

正因为 UI 与 Runtime 彻底解耦，Pi 才能以多种形态运行，赋予开发者最大的灵活性——这就是 SDK 设计的价值。


### 2.7 四种运行模式：分层架构的自然产物

Pi-Agent 支持四种运行模式，它们是分层架构解耦后的自然产物。

- **第一种：Interactive（交互式）**。标准的 CLI 对话模式（`pi`），用户实时输入、Agent 实时响应。这是最常见的开发调试方式。

- **第二种：print-JSON（打印/JSON）**。将 Agent 的每一步输出（思考、工具调用、结果）都打印出来（`pi -p "..."`）。非常适合 CI/CD 流水线或其他自动化脚本调用。

- **第三种：RPC（远程调用）**。通过 stdin/stdout 交换 JSON，把 Agent Runtime 服务化，供其他（哪怕不是 Node.js 写的）程序调用。

- **第四种：SDK（嵌入式）**。最高级的用法。在你自己的 Node.js/TypeScript 应用中直接引用 `pi-agent-core` 或 `pi-coding-agent`，像调用一个库函数一样运行 Agent。

这四种模式覆盖了从个人开发到企业服务的全部场景：Pi 可以从“开发者手边的工具”无缝演进为“生产系统里的 Agent 能力提供者”，项目长大了也不需要换框架。这正是分层架构的强大之处。


## 3. 从 Pi-Agent 看 Agent Runtime 的设计原则

通过这次架构拆解，我们可以总结出几条通用的 Agent Runtime 设计原则。

- **原则 1：分层，且严格控制依赖方向。** 清晰的层级划分（Model → Runtime → Application）是复杂系统的基础。但分层的硬规则不是“只能依赖相邻层”，而是**依赖方向单向向上、底层对上层一无所知**。配套的还有“类型层层递进”：底层定义最小类型（`Tool`），上层用继承和联合类型扩展（`AgentTool` → `ToolDefinition`），绝不修改底层——这样底层才能独立发布和复用。想验证一个分层是否健康，问一句就够了：“去掉上层，这一层还能编译、还能跑吗？”

- **原则 2：核心保持简单，用减法定义边界。** 不要试图打造“万能 Agent”。`pi-agent-core` 只做一件事：运行 Agent Loop。而 Pi 的“What we didn't build”告诉我们，**刻意的舍弃本身就是一种设计**——每一个“不做”都为核心的简单和上下文的干净让了路。

- **原则 3：工具是能力边界。** Tool 不仅仅是 API 的集合，它是 Agent 与物理世界交互的接口。四个核心工具形成了一个完整的 Observe-Change-Act 闭环，精心设计 Tool 就是设计 Agent 的能力上限。

- **原则 4：事件驱动 + Runtime 即操作系统。** Agent 的状态是动态变化的（Thinking、Calling、Running、Completed），事件驱动模型天然适合这种非确定性流程。而 Agent Runtime 就像操作系统管理进程一样管理 LLM 调用和 Tool 执行的生命周期——这是理解 Agent 运行时的最佳心智模型。

---

## 小结

1. Pi 是一个用 TypeScript 写的极简编码 Agent。它分了三层：`pi-ai`（模型层）、`pi-agent-core`（循环层）、`pi-coding-agent`（业务层）；`pi-tui` 是正交解耦的 UI 库；`pi-orchestrator` 是外围实验性的多 Agent 编排。
2. 分层的唯一硬规则是：**依赖方向单向向上，底层对上层一无所知**。
3. 类型也沿着层级递进：`Tool`（LLM 视角）→ `AgentTool`（Agent 视角）→ `ToolDefinition`（产品视角），底层永不被改。
4. Pi 最值得学的，是它用减法定义了“做一个 Agent 到底需要什么”。