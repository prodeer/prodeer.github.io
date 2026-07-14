+++
date = '2026-07-03T11:40:00+08:00'
draft = false
title = 'DeerFlow 学习笔记（三）：DeerFlow 怎样控制工具带来的上下文膨胀'
categories = ['AI 大模型']
tags = ['DeerFlow', 'Agent', '工具调用', 'MCP', 'Skills', 'Context Engineering', '源代码']
series = ['DeerFlow 学习笔记']
mermaid = true
+++

工具少的时候，给模型绑定一个函数列表就够了。工具多起来以后，问题会变成：同名工具听谁的、哪些工具当前可用、完整 schema 是否值得一直占用上下文。DeerFlow 的工具层主要在解决这些装配问题。

## 能执行，不代表现在就要全部展示

DeerFlow 会合并配置工具、内置工具、MCP 工具和 ACP 工具，并按明确优先级处理同名项。更值得我借鉴的是 deferred tools：执行层保留完整工具，模型开始时只看到较轻的索引，需要时再通过搜索提升具体工具。

{{< mermaid >}}
flowchart LR
    A[配置 / 内置 / MCP / ACP] --> B[合并与策略过滤]
    B --> C[轻量工具索引]
    C --> D{任务需要?}
    D -->|需要| E[搜索并提升完整 schema]
    D -->|不需要| F[不占用更多上下文]
    E --> G[模型调用工具]
{{< /mermaid >}}

这不是简单地“少传几个 token”。延迟披露把能力存在与模型可见性拆开了：系统可以提前连接和校验工具，但只在任务需要时付出上下文成本。

## MCP 和 Skill 不是同一种扩展

我原来容易把 MCP 与 Skills 都归为“插件”。读完后更准确的区分是：MCP 给 Agent 新动作，Skill 给 Agent 一套完成任务的方法。

MCP 最终要执行远程工具，因此要处理连接、schema 缓存、认证和失败。Skill 最终会加载 `SKILL.md`，还要处理发现、启用、允许使用的工具以及用户隔离。两者形式不同，但都使用了相似的策略：先给模型一个便宜的目录，再按需展开完整内容。

这种渐进式披露同时带来一个代价：运行时必须知道模型当前已经看见了什么。工具目录版本变化、Skill 被用户禁用或缓存失效时，不能只更新后端对象，还要保证对话状态不会继续引用旧能力。

## 我的想法

工具系统的关键指标不该只是“接了多少工具”，还应包括：

- 模型每轮真正看见多少 schema；
- 工具名称冲突是否有稳定规则；
- 用户和运行模式能否限制能力；
- 缓存更新后，状态与目录是否仍一致。

DeerFlow 让我看到，扩展性不是不断往列表里追加函数，而是控制能力在什么时间、以什么成本、对什么用户可见。

源码锚点：

- `backend/packages/harness/deerflow/tools/tools.py`
- `backend/packages/harness/deerflow/tools/builtins/tool_search.py`
- `backend/packages/harness/deerflow/mcp/`
- `backend/packages/harness/deerflow/skills/`