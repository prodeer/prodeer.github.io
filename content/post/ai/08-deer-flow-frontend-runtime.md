+++
date = '2026-07-10T21:10:00+08:00'
draft = false
title = 'DeerFlow 学习笔记（八）：聊天窗口背后，前端如何翻译 Agent 运行状态'
categories = ['AI 大模型']
tags = ['DeerFlow', 'Agent', '前端', 'React', 'Artifacts', '源代码']
series = ['DeerFlow 学习笔记']
mermaid = true
+++

如果只看最终回答，DeerFlow 的前端很像普通聊天应用。但 Agent 运行过程中还有推理片段、工具调用、澄清、子任务、待办事项和文件产物。前端真正困难的地方，是把这些异步事件组织成用户能理解的过程。

## 消息先变成语义，再变成组件

DeerFlow 没有让 React 组件直接逐条猜测原始消息。纯函数先把消息折叠成 human、assistant、processing、clarification、subagent 等语义组，页面再选择对应的展示方式。

{{< mermaid >}}
flowchart LR
    A[LangGraph 消息流] --> B[Thread hook]
    B --> C[纯函数语义分组]
    C --> D[回答]
    C --> E[工具过程]
    C --> F[澄清 / 子任务]
    B --> G[ThreadState]
    G --> H[Todos / Goal / Artifacts]
{{< /mermaid >}}

这个分层让我印象很深。乱序 ToolMessage、历史回填和终态边界都可以在纯函数里测试，组件只负责渲染已经明确的语义。相比把各种判断塞进一个超大消息组件，这种做法更容易维护流式 UI。

## 状态不必都放进一个 Store

消息流由 thread hook 管理，Artifacts Provider 只保存文件面板的选择和开关，Sidecar 有自己的 UI 状态，Settings 则使用外部 Store。`ChatBox` 负责协调这些状态，而不是把它们全部提升到一个全局容器。

这背后是一条很实用的判断：服务端事实和界面偏好不应该共用同一种状态管理。

- messages、todos、goal 和 artifacts 列表来自线程事实；
- 当前选中的文件、右侧面板是否打开属于界面状态；
- 通知和 token 展示方式属于本地偏好；
- model override 只有确实与线程相关的部分才按 thread 保存。

当所有内容都被称为“聊天状态”时，线程切换、恢复和多标签页同步都会变得含糊。明确所有权后，谁负责重置、谁负责持久化也更容易判断。

## Artifact 是第二种交付方式

Agent 的结果不一定适合塞进一条 Markdown 消息。代码、报告和网页文件会进入 Artifacts 面板，按类型选择源码查看、预览或下载。上传文件则从另一个方向进入线程和 Sandbox。

这让我觉得 DeerFlow 的产品形态不只是 Chat：左侧对话负责协作过程，右侧 Artifact 负责可继续使用的结果。前端是在翻译 Runtime 的语义，而不是给模型输出套一个气泡。

## 读完这一轮后的变化

八篇读下来，我对 Agent Harness 的理解从“模型外面包一组工具”变成了“为不稳定的模型行为提供可约束、可恢复、可运营的运行环境”。

最值得我带走的不是某个类，而是四个边界：Prompt 与代码约束分开，能力存在与能力披露分开，线程状态与长期记忆分开，服务端事实与前端 UI 状态分开。具体文件会继续变化，这些边界更值得长期观察。

源码锚点：

- `frontend/src/core/messages/`
- `frontend/src/components/workspace/messages/`
- `frontend/src/components/workspace/artifacts/`
- `frontend/src/components/workspace/chats/chat-box.tsx`

上一篇：[面对不同模型，配置层应该负责到哪里]({{< relref "07-deer-flow-config-models.md" >}})  
回到开头：[追一遍请求，我看懂了 DeerFlow 的运行主线]({{< relref "01-deer-flow-runtime-mainline.md" >}})
