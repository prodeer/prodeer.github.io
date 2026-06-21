+++
date = '2026-06-21T10:30:00+08:00'
draft = false
title = 'AI Agent 设计模式（五）：Memory——让历史信息影响未来行为'
categories = ['AI 大模型']
tags = ['Agent', 'Memory', 'Context Engineering', '设计模式']
series = ['AI Agent 设计模式']
mermaid = true
+++

用户第一次安排会议时说明：“工作日不要约在 9 点以前，外部会议默认留 15 分钟缓冲。”下次安排日程时，如果助手仍然从头询问，说明历史没有真正影响未来行为。

Memory 模式让信息跨轮次或跨任务延续。它关注的不是保存多少聊天记录，而是什么值得留下、什么时候取回、何时应该更新或忘记。

<!--more-->

## 模式意图

> 从过去交互或运行中保留有价值的信息，并在未来相关任务中选择性取回，使 Agent 的行为具有连续性。

Memory 是一种状态模式。它增加的核心能力不是知识搜索，而是“过去发生过什么”能够改变当前决策。

![AI Agent Memory 设计模式](/images/ai/ai-agent-memory-pattern.png)

## 问题场景：个人日程助手

日程助手可能需要记住：

- 用户长期偏好下午开会；
- 当前项目持续到月底；
- 上次会议因为时区理解错误而取消；
- 公司要求外部会议必须使用指定平台。

这些信息的寿命和来源不同。长期偏好可以跨任务使用，项目日期会过期，取消原因属于一次经历，公司规则则更适合由配置管理。

## 基本结构

{{< mermaid >}}
flowchart LR
    E[Interaction / Event] --> W[Memory Writer]
    W --> S[(Memory Store)]
    G[Current Goal] --> Q[Memory Retriever]
    S --> Q
    Q --> C[Selected Context]
    C --> A[Agent Decision]
    A --> E
{{< /mermaid >}}

主要参与者包括：

- **Memory Source**：用户陈述、运行事件或明确配置；
- **Writer**：判断是否写入以及怎样表示；
- **Store**：保存内容、作用域、来源和有效期；
- **Retriever**：按当前目标选择相关记忆；
- **Update Policy**：处理冲突、过期和删除。

## 运行过程

{{< mermaid >}}
stateDiagram-v2
    [*] --> Candidate
    Candidate --> Active: valuable and allowed
    Candidate --> Rejected: temporary or unsafe
    Active --> Retrieved: relevant to current task
    Retrieved --> Active
    Active --> Superseded: newer information
    Active --> Expired: no longer valid
    Active --> Deleted: user or retention policy
    Superseded --> [*]
    Expired --> [*]
    Deleted --> [*]
{{< /mermaid >}}

最小读取过程可以表示为：

```python
memories = store.search(current_goal, subject=user_id)
memories = [m for m in memories if not m.expired]
context = rank_and_limit(memories, token_budget)
answer = agent.run(current_goal, memory=context)
```

写入通常比读取更危险。一次错误读取影响当前任务，错误写入则可能持续影响未来任务。

## 核心特点

### 信息跨运行延续

当前消息上下文结束后，信息仍能在未来任务中被取回，这是长期 Memory 与普通上下文的主要区别。

### 记忆具有作用域

同一条信息可能只属于用户、团队、项目或某个线程。作用域错误会让个人偏好污染其他用户，也可能造成隐私泄露。

### 记忆需要生命周期

Memory 不是只增不减的日志。它需要来源、置信度、有效期、替代关系和删除机制。旧信息与当前明确指令冲突时，当前指令通常应优先。

### 记忆是选择后的历史

聊天记录是原始历史，Memory 是从历史中筛选出来、准备影响未来行为的信息。两者不应直接画等号。

## 四类常见记忆

| 类型 | 例子 | 主要作用 |
|---|---|---|
| Working | 当前正在安排哪场会议 | 完成当前任务 |
| Episodic | 上次因时区错误取消 | 利用过去经历 |
| Semantic | 用户偏好下午开会 | 保存稳定事实或偏好 |
| Procedural | 外部会议使用指定平台 | 影响做事方法 |

Working Memory 常与当前状态一起结束，后三类更可能跨运行存在。固定组织规则通常应优先放入配置，而不是依赖模型自动形成记忆。

## 优点与代价

{{< mermaid >}}
flowchart TB
    M[Memory]
    M --> B1[减少重复询问]
    M --> B2[保持个性化和连续性]
    M --> B3[利用历史经验]
    M --> C1[错误会持续传播]
    M --> C2[信息会过期或冲突]
    M --> C3[带来隐私和删除责任]
{{< /mermaid >}}

Memory 改善连续性，却可能让错误理解被反复强化。它的质量不能只用“召回相关”衡量，还要检查是否应该写入、是否正确覆盖、是否能够删除。

## 适用与不适用场景

适合使用：

- 用户会反复使用系统，并期待偏好延续；
- 任务需要利用过去运行的经验或决定；
- 信息能够明确归属、更新和删除。

不适合使用：

- 一次性、匿名或高隐私任务；
- 所需状态仅存在于当前请求；
- 信息其实是稳定配置，可由数据库字段直接管理；
- 无法建立可靠的作用域和删除机制。

## 与相关模式的区别

| 概念 | 回答的问题 |
|---|---|
| Context Window | 当前模型调用看到了什么 |
| Checkpoint | 中断后从哪里继续 |
| Memory | 未来任务还应该知道什么 |
| RAG | 当前问题需要哪些外部知识 |

Memory 和 RAG 都可能使用向量检索，但产品语义不同。Memory 关注主体、历史和纠错；RAG 关注知识来源、召回和证据。

## 模式小结

| 维度 | Memory |
|---|---|
| 意图 | 让历史信息影响未来任务 |
| 识别信号 | 存在跨运行写入、检索和更新 |
| 主要优点 | 连续性、个性化、经验复用 |
| 主要代价 | 污染、过期、冲突和隐私 |
| 使用原则 | 少而可信，比多而混乱更有价值 |
