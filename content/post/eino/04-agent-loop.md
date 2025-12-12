+++
date = '2025-12-12T09:00:00+08:00'
draft = false
title = '深入理解 Eino（四）：Agent 实现原理--Tool Calling 到 Agent Loop'
categories = ['AI 大模型']
tags = ['Eino', 'Agent', 'Tool Calling', 'ReAct']
series = ['深入理解 Eino']
mermaid = true
+++

Agent 的核心不是“让 LLM 输出更聪明的文本”，而是让模型具备**感知、决策、执行、反馈、再决策**的闭环能力。本篇深入分析 Eino 中 Agent 的核心机制：Tool Calling、Planner、Executor 以及 Agent Loop。

<!--more-->

> 注：OpenAI 文档称 Function Calling，Eino 及本系列统一称 Tool Calling，下文不另区分。


## 1. 为什么 Tool Calling 是 Agent 的分水岭

早期理解：

```text
Agent = LLM + Prompt
```

这只覆盖了“会说话的模型”。真正让 LLM 从“回答问题”变成“操作世界”的，是 **Tool Calling**。

普通 Chat：

```
用户：北京今天天气怎么样？
LLM：北京今天可能晴朗，气温约 20-30 度。（瞎猜）
```

Agent：

```
用户：北京今天天气怎么样？
  ↓
LLM 判断：需要实时数据 → 输出 ToolCall{get_weather, {city:北京}}
  ↓
ToolsNode 执行 get_weather → {temp:25, cond:晴}
  ↓
结果回写 Messages → 再喂给 LLM
  ↓
LLM：北京今天晴，25 度，适合出门。
```

模型本身**不执行任何外部代码**，它只输出“我想调哪个工具、参数是什么”。真正发 HTTP、查 DB、跑命令的是 **Agent Runtime 里的 ToolsNode**。这一步分开，是 Agent 工程化的起点。

## 2. Tool Calling 的本质：结构化意图

Tool Calling 的链路是：

```text
用户文本
  ↓
ChatModel（绑定了 ToolInfo）
  ↓
输出 schema.ToolCall{Name, ArgumentsInJSON}
  ↓
ToolsNode 按 Name 查 Registry，解析 JSON，调 InvokableRun
  ↓
ToolResult 包装成 schema.Message(Role=Tool) 回写 State
  ↓
ChatModel 下一轮带着新 Message 继续推理
```

模型输出示例：

```json
{
  "tool_calls": [
    {
      "function": {
        "name": "get_weather",
        "arguments": "{\"city\":\"北京\"}"
      }
    }
  ]
}
```

先理清一个常见误解：**不是 LLM 在执行工具，是 Agent 在 LLM 的指挥下执行**。LLM 只是个文字生成器，它发不了网络请求。整个流程是：

1. Agent 把所有工具的 `ToolInfo`（名称、描述、参数 schema）打包，连同对话发给 LLM
2. LLM 根据用户意图，决定要不要调工具、调哪个、传什么参数，返回一个 `tool_call`
3. Agent 解析 `tool_call`，执行对应工具的 `InvokableRun`
4. Agent 把工具结果包成 `ToolMessage` 灌回对话
5. LLM 拿到结果，生成最终回答（或继续调下一个工具）

关键：LLM 靠工具的**名称和描述**决定调哪个，你不用写任何 if-else 规则。这就是 Function Calling 最颠覆的地方。

Eino 里让模型“知道有这些工具”的调用是：

```go
// 老接口（部分示例还在用）
chatModel.BindTools([]*schema.ToolInfo{weatherInfo})
// 新推荐：返回新实例，避免并发修改
toolableModel, _ := chatModel.(model.ToolCallingChatModel).WithTools([]*schema.ToolInfo{weatherInfo})
```

`BindTools` / `WithTools` **不是执行**，是把 `ToolInfo` 塞进发给模型的请求里。



## 3. 从单次调用到 Agent Loop

上面的流程如果只跑一遍，就是“单轮工具调用”。但真实 Agent 是**循环**的：LLM 可能需要调好几个工具，每次拿到结果再决定下一步。这就是 Agent Loop：

{{< mermaid >}}
graph LR
    G[LLM 生成] --> C{有 tool_call?}
    C -->|有| X[执行工具]
    X --> F[结果灌回对话]
    F --> G
    C -->|没有| AN[生成最终回答]
    AN --> END[结束]
{{< /mermaid >}}

循环的退出条件：LLM 生成的回复里不再包含 `tool_call`--意味着它觉得信息够了，可以直接回答用户。

## 4. ReAct：给循环加上“思考”

ReAct（Reasoning + Acting）把这个循环结构化成 think-act-observe 三段：

```
思考：需要查北京和上海的天气
行动：调用 get_weather("北京")
观察：北京今天28度
思考：还需要上海的天气
行动：调用 get_weather("上海")
观察：上海今天32度
思考：上海比北京热4度
回答：上海今天更热，32度
```

“思考”让 LLM 把推理过程写出来，这能显著提升准确率（思维链效应）。ReAct 本质就是 Agent Loop + 显式推理。

## 5. Eino 怎么封装这个循环

Agent 的组装有两种方式：

- **react.NewAgent**：直接封装 ReAct 循环，传入 Model + ToolsConfig + MaxStep
- **compose.NewGraph** 手写：你自己搭 ChatModel + ToolsNode + Branch + State，参见第三篇的手写 ReAct Graph 示例

`react.NewAgent` 把循环 Graph 预编译好：

```go
reactAgent, _ := react.NewAgent(ctx, &react.AgentConfig{
    Model: chatModel,
    ToolsConfig: react.ToolsConfig{Tools: tools},
    MaxStep: 10,   // 最多转10圈
})
result, _ := reactAgent.Generate(ctx, []*schema.Message{
    schema.UserMessage("北京和上海今天哪个更热？"),
})
```

它的内部就是一个 Graph：think 节点调 LLM，act 节点执行工具，decide 节点判断“还有没有 tool_call / 到没到 MaxStep”。

## 6. Agent Runtime 控制 Loop 时到底管了什么

**真实 Runtime 做的是**：

1. **轮次调度（Pregel）**：每轮激活当前节点集，等全部完成，按 Branch 算下一轮节点集；`tools → model` 回边让下一轮再跑 model
2. **步数熔断**：`WithMaxRunSteps` 到达即强制 END，防模型死循环
3. **流式分支**：`StreamGraphBranch` 首帧判定，避免等完整生成
4. **State 并发**：`WithStatePreHandler/PostHandler` 注入读写锁语义
5. **错误边界**：Tool panic/超时 → 包成 ToolMessage(error=...) 回写 State，让模型自己决定重试/换工具/放弃，而不是整个 Graph 崩
6. **Callback 织入**：OnStart/OnEnd 在每轮每个节点触发，Trace 自动成形
7. **Option 分发**：`WithChatModelOption(WithTemperature(0))` 只下发到 model 节点，不影响 tools

## 7. 生产级 Agent Loop 需要注意的问题

- **最大步数**：`react.AgentConfig{MaxStep: 10}` 或 `WithMaxRunSteps(10)`
- **超时**：Tool 自身用 `ctx.WithTimeout`；Graph 层可用 `WithCtxSolver` 或 Runner 层 cancel
- **Token 膨胀**：MessageModifier 在每轮喂给模型前裁剪/摘要历史（`react.AgentConfig.MessageModifier`）
- **错误恢复**：Tool 返回 error 不崩溃，进 Messages 当观察值；也可在 ToolsNode 外包 Lambda 做 retry/fallback
- **Human-in-the-loop**：`adk.Interrupt(ctx, "confirm?")` 触发 → 图暂停 → `Runner.Resume(checkpointID)` 从 Checkpoint 恢复
- **MCP**：Tool 实现可以是 MCP Client 适配层，对上层仍是 `InvokableTool`，Registry 不变


## 8. 总结

Tool Calling 是 LLM 下令、Agent 执行，靠工具名和描述匹配意图；

单次调用扩展成 Agent Loop--LLM 生成、检查 tool_call、执行、灌回、重复，直到没有 tool_call；

ReAct 给循环加显式推理；`react.NewAgent` 把这个循环 Graph 预编译好，`MaxStep` 防死循环；`compose.NewAgent` 把模型+工具+记忆+回调拼成 Runnable。