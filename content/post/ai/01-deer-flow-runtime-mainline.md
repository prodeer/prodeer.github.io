+++
date = '2026-07-01T09:20:00+08:00'
draft = false
title = 'DeerFlow 学习笔记（一）：追一遍请求，我看懂了 DeerFlow 的运行主线'
categories = ['AI 大模型']
tags = ['DeerFlow', 'Agent', 'Harness', 'LangGraph', '源代码']
series = ['DeerFlow 学习笔记']
mermaid = true
+++

刚开始读 DeerFlow 时，我一直在找“Agent 的主循环”到底写在哪。后来发现，这个问题本身就有偏差：DeerFlow 的核心不是某个巨大的循环，而是把一次请求变成一套配置明确、状态可恢复的运行实例。

## 什么情况下值得考虑 DeerFlow

  如果需求只是一次模型调用、简单问答，或者绑定两三个工具完成短流程，直接使用模型 SDK 或轻量 Agent 框架通常更合适。DeerFlow 的价值不在于让模型“能调用工具”，而在于管理一套需要长期运行的 Agent 系统。

  当你的场景同时出现下面几类问题时，可以考虑 DeerFlow：

  - Web、IM、定时任务等多个入口需要复用同一套运行逻辑；
  - 任务需要工具、Skill、MCP、子 Agent 或文件执行能力；
  - 对话需要中断恢复、长期记忆和跨线程状态；
  - 工具执行需要权限控制、Sandbox 和危险操作治理；
  - 运行过程需要流式展示、追踪、取消和产物交付；
  - 不同用户、模型和运行模式需要动态装配不同能力。

  换句话说，只有“让模型做点事”时，DeerFlow 可能太重；当问题变成“怎样可靠地运行、约束和运营 Agent”时，它才开始体现价值。

## 我追的不是函数，而是一次 Run

Web、IM Channel 和定时任务的入口并不相同，但它们最终都要进入 Gateway 管理的 Run 生命周期。Run 建立身份和线程上下文，然后才轮到 Lead Agent 根据当次配置装配模型、工具、Prompt、中间件和 `ThreadState`。

{{< mermaid >}}
flowchart LR
    A[Web / IM / Scheduler] --> B[Gateway]
    B --> C[Run]
    C --> D[Lead Agent 装配]
    D --> E[模型与工具循环]
    E --> F[Checkpoint / Run Events]
    F --> G[Frontend / Channel]
{{< /mermaid >}}

这张图帮我纠正了一个认识：`create_agent` 只是最后的构建原语。DeerFlow 真正做的工作，大多发生在调用它之前和运行结束之后。

构建前，它需要解析当前模型和 Agent 配置，筛选工具，拼出有顺序要求的中间件链，并确定状态结构。运行后，Gateway 还要处理事件、取消、恢复和结果交付。单独看其中任何一层，都不足以解释 DeerFlow 为什么是一个 Harness。

## 三个让我停下来想的地方

第一，Agent 是一次装配结果，不是一个固定对象。同一个 `lead_agent` 入口，在不同模型、工具开关、用户 Skill 和运行模式下，会得到不同的能力组合。

第二，入口可以多，运行事实最好只有一套。Channel 和 Scheduler 没有各自复制一套 Agent Runtime，而是复用 Run。这样身份、事件、checkpoint 和收尾逻辑才不会逐渐分叉。

第三，前端看到的不是模型原始输出，而是运行事实的投影。消息、工具调用、子任务和 Artifacts 都来自同一次 Run，只是由不同 UI 组件解释。

我现在会用下面这条线索阅读类似项目：

```text
输入从哪里进入
  -> 谁生成运行上下文
  -> Agent 在哪里被装配
  -> 状态如何写回
  -> 结果由谁呈现
```

它比统计项目里有多少 Agent、多少中间件更不容易过时。

## 我的想法

DeerFlow 给我的第一个启发，是把“调用模型”与“运营一次 Agent 运行”分开。模型循环只解决下一步做什么；Harness 还要解决能力从哪里来、动作是否允许、状态能否恢复，以及外部系统如何理解这次运行。

后面几篇都会沿着这条主线展开，而不是再按目录逐个介绍文件。

源码锚点：

- `backend/app/gateway/`
- `backend/packages/harness/deerflow/agents/lead_agent/agent.py`
- `backend/packages/harness/deerflow/agents/factory.py`