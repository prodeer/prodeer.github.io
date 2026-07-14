+++
date = '2026-07-05T22:15:00+08:00'
draft = false
title = 'DeerFlow 学习笔记（四）：拆完子任务流程后，我重新理解了 Agent 状态'
categories = ['AI 大模型']
tags = ['DeerFlow', 'Agent', 'Subagent', '状态管理', '并发', '源代码']
series = ['DeerFlow 学习笔记']
mermaid = true
+++

我最初关注子 Agent，是因为它看起来能并行完成更多工作。真正读到执行器和 `ThreadState` 后，我发现更难的问题不是启动任务，而是让父子任务共享必要环境、隔离各自对话，并把结果可靠地合回主线程。

## 委派不是再调用一次 Agent

Lead Agent 通过 `task` 工具发起任务。执行器在常驻的隔离事件循环中运行子 Agent，父侧通过共享结果对象持续取得进度。这样既能桥接同步工具接口和异步运行时，也避免为每次任务创建短命事件循环。

{{< mermaid >}}
sequenceDiagram
    participant L as Lead Agent
    participant T as task tool
    participant E as Subagent Executor
    participant S as ThreadState
    L->>T: 提交子任务
    T->>E: 后台启动
    E-->>T: 增量状态与结果
    T-->>L: 轮询回传
    L->>S: 合并 delegation / message
{{< /mermaid >}}

子 Agent 会继承 sandbox、身份和 trace 等运行环境，但不会继承整段父对话。这个选择很实用：它获得完成任务所需的边界，又不会把父线程不断膨胀的上下文复制过去。

系统还从多处限制递归和并发。这里给我的启发是，Prompt 中的“不要继续委派”只能算提示，工具白名单和中间件截断才是实际防线。

## State 的重点是合并规则

如果只看字段名，`ThreadState` 很像给前端准备的一包附加数据。真正决定系统能否并行和恢复的，是字段背后的 reducer。

两个节点同时写入时，列表应该追加、按 ID 更新，还是整体替换？空列表表示“没有变化”还是“主动清空”？同一个 sandbox 被写成两个值时，是选一个还是直接报错？这些选择决定了恢复后的事实是否可信。

我尤其在意三类状态：

- 子任务账本要在摘要或恢复后仍能解释结果来自哪里；
- 延迟工具的提升状态要绑定目录版本，不能沿用过期 schema；
- 已完成的目标或任务不能被迟到事件降回进行中。

这让我重新理解了 Agent State：它不是内存里的字典，而是一份并发写入协议。

## 我的想法

引入子 Agent 前，应该先设计结果如何回流、失败如何表示、状态如何幂等合并。并发数反而是后面的参数。

DeerFlow 把这些问题放进执行器、状态契约和 reducer，而不是让每个工具各自处理。代价是状态定义变复杂，但恢复和前端展示有了共同事实来源。我认为这比“能同时跑几个 Agent”更值得学习。

源码锚点：

- `backend/packages/harness/deerflow/subagents/executor.py`
- `backend/packages/harness/deerflow/tools/builtins/task_tool.py`
- `backend/packages/harness/deerflow/agents/thread_state.py`
