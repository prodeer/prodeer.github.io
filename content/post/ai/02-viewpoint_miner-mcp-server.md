+++
date = '2026-05-19T10:00:00+08:00'
draft = false
title = '从股票观点系统到 Agent 应用（二）：MCP Server 与工具设计'
categories = ['AI 大模型']
series = ['viewpoint_miner']
+++

第一篇结束时，系统能跑了，但得打开浏览器手动点。

我开始琢磨：能不能再往前推一步？

<!--more-->

现在的工作流是这样的：每天定时脚本跑完，数据进了库，信号提完了，然后我打开网页看一眼。但这一眼，往往是在写代码的时候、会议间隙、或者临睡前刷手机——每次都要切到浏览器，点几下才能看到想看的东西。

如果能让 AI 替我看呢？

但让 Agent 使用我的数据系统，不是扔给模型一个 API 地址就行。需要由运行时向模型描述可用工具、校验调用参数、执行真实操作，再把结果送回模型；MCP 解决的是客户端与工具服务之间的标准化边界。

这是我想搭成的最终架构：

![agent 架构图](/images/viewpoint_miner/agent-architecture.png)

上面是整体架构图，下面逐层拆解怎么落地。

**四层整合方案**
1. MCP Server：把现有 REST API 包装成 LLM 能调用的工具集
2. RAG：让 Agent 能理解观点内容的语义，而不是只做关键词匹配
3. Skills：把多步操作封装成“一键分析 XX 股票”这样的专业技能
4. Harness：调度、护栏、推送、记忆——让 Agent 可靠运行的工程化保障

本篇先讲 MCP——把数据系统变成 AI 能调用的工具集。

---

MCP（Model Context Protocol）是一个开放协议，用统一方式连接 AI 应用与外部工具、资源和提示模板。本项目只使用其中的 Tools 能力：MCP Server 声明工具名、描述和参数 schema，外部 Agent 负责把这些信息交给模型、决定是否执行调用并处理结果。模型本身并不直接讲 MCP 协议。

举个例子。以前查"北方稀土有没有人喊减仓"，我得：切浏览器 → 打开系统 → 搜索股票 → 点进去 → 找信号标签 → 回到编辑器。现在直接跟 WorkBuddy 说一句就行，AI 替我调系统、查数据、汇总结果。
这就是 MCP 要解决的问题。

---

## 架构：从 REST 到 MCP 的思维转变

REST API 和 MCP 工具看起来很像——都是"请求-响应"，都有参数和返回值。但设计哲学完全不同：

| | REST API | MCP 工具 |
|---|---|---|
| **调用边界** | HTTP 客户端与服务端 | MCP Client 与 MCP Server |
| **参数描述** | OpenAPI 或应用自定义文档 | 协议返回的工具 schema；本项目用 Zod 定义 |
| **返回值** | JSON、文本、流等 HTTP body | MCP content / structuredContent 等协议结果 |
| **发现机制** | OpenAPI、文档或约定 | Client 通过协议查询工具列表 |
| **错误处理** | HTTP 状态码 + error body | MCP 协议错误或工具执行结果 |
| **调用决策** | 由调用方代码决定 | 仍由 Agent 运行时和模型共同决定，MCP 不负责规划 |

关键区别不在于"人还是 AI"，而在于接口契约。REST 也可以被 Agent 调用，MCP 工具也可能被普通程序调用。MCP 的价值是把发现、schema 和调用方式统一起来；工具描述仍应做到不看源码也能理解，但描述清楚不代表模型一定会选对。

对这个项目而言，REST API 服务 Web 页面，MCP Server 服务 Agent 客户端。两套入口可以复用同一业务层，差别主要在协议和消费方式。

---

## 工具设计：27 个工具怎么组织

下面这张图展示了完整的架构：

![MCP 工具业务分组](/images/viewpoint_miner/mcp-tool-hierarchy.svg)

图里按业务能力把 27 个工具分组。它是项目自己的导航方式，不是 MCP 规定的协议层级，也不会让模型天然形成"从高层逐级下钻"的执行顺序。

| 分组 | 数量 | 代表工具 | 副作用 |
|------|------|----------|--------|
| 查询与文本分析 | 12 | `search_stocks`、`get_stock_viewpoints`、`analyze_trade_text` | 只读或纯计算 |
| 同步与提取 | 4 | `sync_author_viewpoints`、`sync_and_extract_stock` | 网络请求并写数据库 |
| 聚合与上下文 | 3 | `summarize_stock_signals`、`build_stock_context` | 只读聚合 |
| 语义搜索 | 4 | `semantic_search_viewpoints`、`index_viewpoint_embedding` | 查询或更新向量索引 |
| 通知 | 4 | `get_daily_digest`、`send_test_notification` | 部分工具会产生外部通知 |

比层级更重要的是显式标注副作用：查询工具可以自动执行，涉及同步、写库和通知的工具应该有权限策略或用户确认。工具粒度也不是越原子越好；对高频任务提供 `summarize_stock_signals` 这样的聚合工具，能减少调用轮次和上下文消耗。

---

## 三类最值得学习的工具

### 1. 查询工具：返回有限、可解释的数据

`get_stock_viewpoints` 支持分页，`get_latest_trade_signals` 支持 limit。对 Agent 来说，返回上百条原文通常不是能力更强，而是把筛选成本转移给模型，因此查询工具必须有明确边界和默认上限。

- `search_stocks`：先把自然语言股票名解析成内部 ID
- `get_stock_viewpoints`：需要原文时分页读取
- `get_latest_trade_signals`：只返回近期信号

### 2. 聚合工具：在服务端完成确定性计算

`summarize_stock_signals` 和 `summarize_author_style` 把计数、分组等工作放到 SQL/JavaScript 中完成，再把紧凑结果交给模型。能由数据库稳定计算的内容，不应让 LLM 读取大量原文后心算。

### 3. 副作用工具：把风险写进契约

`sync_author_viewpoints` 会访问外部接口并写库，`extract_trade_actions` 会刷新派生数据，`send_test_notification` 会产生外部消息。这类工具除了 schema，还应说明幂等性、超时、影响范围和是否需要确认。

---

## LLM 如何选择工具？

理解了分层结构之后，最关键的问题来了：**LLM 到底是怎么选工具的？**

答案是：模型根据工具名、描述、schema 和当前上下文提出调用，Agent 运行时再做权限检查并执行。MCP 没有定义"优先选上层"的策略。

下面这张图展示了 LLM 的决策路径：

![LLM 决策路径](/images/viewpoint_miner/llm-select-tool.png)

以"分析北方稀土近期信号"为例，一个预期链路是：

1. 调 `search_stocks(q="北方稀土")` 得到 `stock_id`
2. 调 `summarize_stock_signals(stock_id)` 获取聚合结果
3. 用户要求原文时，再调 `build_stock_context` 或分页读取观点

这只是期望路径，不是模型必然行为。第 3 篇会把它写进 Skill，并为"股票不存在、没有信号、匹配到多个股票"等情况定义处理方式。

---

## 与 WorkBuddy 的集成

MCP Server 本身只是一个 JSON-RPC 进程，由于我 vibecoding 用的是 Workbuddy，所以这里介绍怎么集成到 WorkBuddy里。

![MCP 协议交互流程](/images/viewpoint_miner/mcp-protocol-flow.svg)

WorkBuddy 通过 `~/.workbuddy/mcp.json` 发现它，配置本身很简单：

```json
{
  "mcpServers": {
    "stock-viewpoints": {
      "command": "node",
      "args": ["/path/to/viewpoint_miner/mcp-server.js"],
      "cwd": "/path/to/viewpoint_miner"
    }
  }
}
```

配置好之后，WorkBuddy 启动时自动拉起 MCP 进程，读取全部工具列表（名字 + 描述 + 参数 schema），注入到 LLM 的可用工具集中。

---

## 工具数量：27 是多还是少？

一个常见问题是：27 个工具是不是太多了？会不会让 LLM 困惑？

工具数量和语义重叠都会影响选择质量。27 个工具对能力较强的模型未必构成问题，但不能仅凭主观体验下结论；更稳妥的做法是记录工具选择正确率、无效调用次数和平均调用轮次。

1. **尽量减少语义重叠。** `search_stocks` 是模糊搜索，`get_stock_summary` 是精确汇总，`get_stock_viewpoints` 是观点列表。职责不同能降低混淆，但仍要用调用日志验证。

2. **参数 schema 帮助校验，但不能替代路由。** 用户只提供股票名，而分析工具要求 `stock_id`，描述中应明确提示先调用 `search_stocks`；模型仍可能跳步或传错参数，运行时必须拒绝非法调用。

当工具集继续扩大时，可以按场景只暴露相关工具，或用 Skill 提供推荐链路。不要用"模型通常能选对"代替评测。

---

## 小结

这篇文章从架构层面拆解了 MCP Server 的设计：

1. **协议边界**：模型提出调用，Agent Client 执行策略，MCP Server 提供工具，三者职责分开。
2. **工具粒度**：保留必要的原子查询，同时为高频任务提供服务端聚合工具。
3. **副作用治理**：同步、写库和通知类工具需要超时、幂等、权限和确认机制。
4. **可评测性**：记录选错工具、参数校验失败和多余调用，才能判断工具描述是否有效。


但 MCP 只负责能力暴露与调用边界。如何根据用户目标选择一条更稳定的工具链，是下一篇 Skills 要解决的问题。

---
