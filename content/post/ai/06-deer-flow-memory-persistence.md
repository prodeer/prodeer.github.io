+++
date = '2026-07-08T19:05:00+08:00'
draft = false
title = 'DeerFlow 学习笔记（六）：DeerFlow 把哪些信息留到了下一次运行'
categories = ['AI 大模型']
tags = ['DeerFlow', 'Agent', 'Memory', '持久化', 'Scheduler', '源代码']
series = ['DeerFlow 学习笔记']
mermaid = true
+++

“持久化 Agent”听起来像把对话存进数据库，但 DeerFlow 同时维护了几种不同寿命的信息。把它们混在一起，很容易误以为 checkpoint、Memory 和 Run 记录是在重复保存同一件事。

## 三种状态，回答三个问题

{{< mermaid >}}
flowchart TD
    A[一次 Agent 运行] --> B[Checkpoint]
    A --> C[Run / Event]
    A --> D[Memory]
    B --> B1[这条线程如何继续?]
    C --> C1[这次运行发生了什么?]
    D --> D1[下次还应知道用户什么?]
    E[Scheduler] -->|创建普通 Run| A
{{< /mermaid >}}

Checkpoint 服务于图的恢复，保留消息和 `ThreadState`。Run/Event 属于应用层事实，方便查询状态、取消任务和追踪事件。Memory 则从对话中提炼较稳定的用户信息，跨线程参与后续运行。

这三层的保留周期和准确性要求并不一样。checkpoint 需要忠实恢复现场；Run 要能解释执行历史；Memory 反而应该克制，只留下以后仍有价值、且有足够置信度的事实。

## Memory 不是无限变长的聊天记录

DeerFlow 会过滤消息，把可能有价值的内容送进防抖更新队列，再由模型生成结构化更新。读取时也不是把整个记忆文件塞回 system prompt，而是根据预算选择内容，通过动态上下文注入当轮消息。

我很认同这种设计，因为长期记忆至少有三个风险：旧事实会过时，错误理解会被反复强化，内容越多越会挤压当前任务。置信度、纠错信号、陈旧性和 token budget 不是附加功能，而是记忆系统成立的前提。

自动更新和工具更新代表两种不同策略。前者让用户无感，后者让模型明确决定何时读写。DeerFlow 让两种模式互斥，也提醒我：记忆写入方式本身就是产品行为，不能在同一次运行里由两套机制争抢事实。

## Scheduler 为什么不另起一套 Runtime

定时任务只负责“何时触发”，真正执行仍然创建普通 Run。这样后台任务继续复用身份、checkpoint、事件和收尾逻辑。非交互模式也只接受内部可信调用，普通客户端不能靠传入同名字段绕过澄清流程。

Scheduler 还需要租约和 overlap 策略，因为服务可能重启，多个实例也可能同时看到到期任务。这些是调度层的问题，不应该渗入 Agent 本身。

## 我的结论

我从这部分学到的不是如何存更多数据，而是先问每份数据为谁服务：继续执行、运营追踪，还是跨线程个性化。只有目的明确，才能决定写入时机、清理策略和可信度。

后台运行也不应复制一套 Agent。让 Scheduler 复用 Run，看似多绕一层，实际上是在守住同一份运行事实。

源码锚点：

- `backend/packages/harness/deerflow/agents/memory/`
- `backend/packages/harness/deerflow/persistence/`
- `backend/app/gateway/services.py`
- `backend/app/scheduler/`

上一篇：[本地 Sandbox 到底保护了什么]({{< relref "05-deer-flow-sandbox-boundaries.md" >}})  
下一篇：[面对不同模型，配置层应该负责到哪里]({{< relref "07-deer-flow-config-models.md" >}})
