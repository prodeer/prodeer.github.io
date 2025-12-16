+++
date = '2025-12-16T09:00:00+08:00'
draft = false
title = '深入理解 Eino（五）：Memory 设计--Agent 如何拥有长期记忆？'
categories = ['AI 大模型']
tags = ['Eino', 'Memory', 'Agent']
series = ['深入理解 Eino']
mermaid = true
+++

如果说 Tool 让 Agent 具备“行动能力”，那么 Memory 让 Agent 具备“连续性”。没有 Memory 的 Agent，本质上只是一次性的函数调用；有 Memory 的 Agent，才开始接近一个长期运行的智能系统。

<!--more-->

## 1. 为什么 Agent 需要 Memory

传统单次 LLM 调用：

```
User → Model → Answer
```

模型只看到当前 Context，看不到“昨天你说你叫张伟”。LLM 本身**无状态**，连续性必须由外层系统提供。

在 Eino 里，“记忆”不是某个神秘组件自动生效，而是三层协作：

1. **Graph State（短期）**：`WithGenLocalState` 生成的 `*state` 在单次 Agent 运行的若干轮 ReAct 循环中存活，存 `Messages` 和 Working State。
2. **Session / Store（跨轮）**：调用侧在多次 `Run/Invoke` 之间把 `[]*schema.Message` 持久化到 JSONL / Redis / SQL，下次取出来拼进输入。
3. **Modifier + Checkpoint（工程化）**：`react.AgentConfig.MessageModifier` 做历史压缩，`Runner` + `CheckpointSaver` 做中断恢复。

> 一句话：**Eino 不替你“记”，它给你 State + Message 原语 + Runner 生命周期，Memory 是业务层用这些原语拼出来的。**

## 2. Memory ≠ 聊天记录

常见误区：Memory = Conversation History。

两者关系：

- **Conversation History**：原始 `[]*schema.Message`，最近发生了什么（User/Assistant/Tool 交替）。解决“本轮上下文连续”。
- **Memory（广义）**：从历史中**提取、结构化、检索**后的知识。包括用户画像、长期偏好、事件摘要、语义向量。

例如 History 里有一句“我长期用 Go 写后端”，Memory 层应把它抽成：

```json
{ "profile": { "name": "张伟", "stack": ["Go", "Kubernetes"] } }
```

History 是原料，Memory 是加工品。

## 3. 三种记忆，三种问题

先把“记忆”拆开，不同记忆解决不同问题：

| 记忆类型 | 存什么 | 核心问题 |
|---|---|---|
| 短期记忆 | 当前对话上下文 | 上下文窗口会爆 |
| 长期记忆 | 用户偏好、历史 | 跨会话怎么取回 |
| 知识记忆 | 外部文档 | 怎么找到相关的（RAG） |

短期记忆最反直觉：它的问题不是“存哪”，是“扔什么”。每轮都把全部历史塞进 Prompt，上下文窗口迟早撑爆，而且 LLM 对超长上下文会“注意力稀释”——前面的信息反而被遗忘。

{{< mermaid >}}
graph LR
    subgraph Short[短期记忆 / 单次运行内]
        S1[Conversation Messages<br/>State.Messages]
        S2[Working State<br/>goal/steps/tool_results]
    end
    subgraph Long[长期记忆 / 跨 Session]
        L1[Session 原始历史<br/>JSONL/Redis/SQL]
        L2[Profile 结构化<br/>User Table]
        L3[Semantic 向量<br/>Embedding + VectorDB]
        L4[Episodic 事件摘要<br/>按时间归档]
    end
    Short -->|运行结束落盘| L1
    L1 -->|抽取| L2
    L1 -->|切片嵌入| L3
    L1 -->|周期性摘要| L4
    L2 -->|注入 Prompt| Short
    L3 -->|Retrieve| Short
{{< /mermaid >}}

## 4. 短期记忆：State 就是短期记忆

在 Eino ReAct Graph 里，短期记忆的载体就是 Graph 的 Local State：

```go
type reactState struct {
    Messages []*schema.Message
}

g := compose.NewGraph[map[string]any, *schema.Message](
    compose.WithGenLocalState(func(ctx context.Context) *reactState {
        return &reactState{Messages: []*schema.Message{}}
    }),
)

// ChatModel 节点执行前，把本轮 input 追加进 State，再整体喂给模型
g.AddChatModelNode("model", cm,
    compose.WithStatePreHandler(func(ctx context.Context, in []*schema.Message, st *reactState) ([]*schema.Message, error) {
        st.Messages = append(st.Messages, in...)
        return st.Messages, nil
    }),
    compose.WithStatePostHandler(func(ctx context.Context, out *schema.Message, st *reactState) (*schema.Message, error) {
        st.Messages = append(st.Messages, out)
        return out, nil
    }),
)
```

循环里 `ToolsNode` 的结果经 Lambda 包成 `ToolMessage` 也追加进 `st.Messages` → 下一轮 ChatModel 看到完整累积历史。

**这就是 ReAct 多轮工具调用的“短期记忆”实现**：不落盘、随 Graph 运行生灭、并发安全由 StatePre/PostHandler 保证。

ADK 的 `ChatModelAgent` 单轮无 Tool 时更简单：Agent 自身不存历史，**多轮靠调用侧把上一轮返回的 AssistantMessage 追加进下一次的 `history` 再传给 `runner.Run(ctx, history)`**。

### 4.1 Eino 的三种短期记忆策略

Eino 针对短期记忆提供三种策略，本质是三种“扔什么、留什么”的策略：

| 策略 | 做法 | 代价 |
|---|---|---|
| `BufferMemory` | 全留 | 对话一长就爆 |
| `WindowMemory` | 只留最近 N 轮 | 早期信息丢失 |
| `SummaryMemory` | 旧消息压成摘要 | 压缩有损 + 额外 LLM 调用 |

```go
bufMem := memory.NewBufferMemory(ctx, &memory.BufferMemoryConfig{MaxMessages: 20})
winMem := memory.NewWindowMemory(ctx, &memory.WindowMemoryConfig{WindowSize: 6})
summaryMem := memory.NewSummaryMemory(ctx, &memory.SummaryMemoryConfig{
    Model: chatModel, MaxSummaryLen: 500,
})

agent, _ := compose.NewAgent.
    WithChatModel(chatModel).
    WithMemory(winMem).
    Compile(ctx)
```

设计取舍：Buffer 简单但不可扩展；Window 适合“只关心最近”的场景（客服）；Summary 既不丢历史又不爆窗口，但每次总结要调一次 LLM。没有银弹，按场景选。

## 5. 长期记忆：Session + Store 模式

Eino 官方示例（quickstart/chatwitheino）给出的长期记忆最小实现是业务层三个概念：

- **Session**：一次对话会话，持 `ID + []*schema.Message`，`Append(msg)` 写内存+落盘
- **Store**：管理多个 Session，`GetOrCreate(id)` / `List()` / `Delete(id)`
- **Memory 能力**：本质就是“Session 持久化 + 下次加载”

最小可运行骨架（JSONL 版）：

```go
type Session struct {
    ID       string
    filePath string
    messages []*schema.Message
}

func (s *Session) Append(m *schema.Message) error {
    s.messages = append(s.messages, m)
    b, _ := json.Marshal(m)
    f, _ := os.OpenFile(s.filePath, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0644)
    defer f.Close()
    _, err := fmt.Fprintf(f, "%s\n", b)
    return err
}

func (s *Session) GetMessages() []*schema.Message { return s.messages }

type Store struct {
    dir   string
    cache map[string]*Session
}

func (st *Store) GetOrCreate(id string) *Session {
    if s, ok := st.cache[id]; ok { return s }
    s := &Session{ID: id, filePath: filepath.Join(st.dir, id+".jsonl")}
    // 启动时从文件读回历史
    st.cache[id] = s
    return s
}
```

调用侧闭环：

```go
sess := store.GetOrCreate(userID)
history := sess.GetMessages()              // 1. 加载长期历史
history = append(history, schema.UserMessage("我叫张伟"))
events := runner.Run(ctx, history)         // 2. 带历史跑 Agent
// 消费 events，拿到 assistantMsg
sess.Append(schema.UserMessage("我叫张伟"))
sess.Append(assistantMsg)                  // 3. 本轮落盘
```

**关键点**：Eino 框架不强制你用哪种存储，Redis/MySQL/Milvus 只是把 `Append/GetMessages` 换个后端。Memory 的“长期”属性来自 Store 的持久化，不是某个框架接口。

### 5.1 Profile Memory（结构化）

用户画像：`name/role/stack/preference`。存 SQL/Redis，按 userID 直查，注入 System Prompt。

### 5.2 Semantic Memory（向量）

把“用户喜欢源码级分析”这类句子做 Embedding 存 Milvus/Qdrant，查询时按 query 向量召回 Top-K，拼进 Context。Eino 里用 `Embedding` Component + `Indexer`/`Retriever` 做，和 RAG 共用一套基建。

### 5.3 Episodic Memory（事件摘要）

按时间归档“2026-07-01 讨论过 Eino Agent Runtime”，定期用 LLM 做 consolidation 摘要（参考 Nanobot-Eino 的 MEMORY.md/HISTORY.md 双文件法）。

## 6. Memory 在 Agent Runtime 中的位置与注入机制

Memory 不是外挂，是贯穿 Agent Runtime 三层：

```text
                 Agent Runtime
                      │
        ┌─────────────┼─────────────┐
        │             │             │
   Graph State    Session Store   Modifier/Checkpoint
   (短期/运行内)   (长期/跨轮)     (压缩/恢复)
        │             │             │
        └─────────────┼─────────────┘
                      │
               Build Context → Model
```

单次 `Invoke/Run` 的生命周期：

```
加载 Session 历史
   ↓
MessageModifier 裁剪/摘要
   ↓
拼入 State.Messages
   ↓
Graph 执行（ReAct 循环，State 累积）
   ↓
提取新事实（可选 Extractor）
   ↓
写回 Session / Profile / Vector
```

Memory 的工作点是**每轮 think 之前**：把历史消息注入到发给 LLM 的 messages 里。LLM 永远只看到你拼进 `[]*schema.Message` 的东西。典型拼装顺序：

```go
final := []*schema.Message{
    schema.SystemMessage("你是助手。用户信息：" + profileStr),
    // ← Profile Memory 注入 System
}
final = append(final, retrievedMemories...) // ← Semantic Memory 作为历史消息或系统附录
final = append(final, sessionHistory...)   // ← Conversation History
final = append(final, schema.UserMessage(query))
```

`react.AgentConfig.MessageModifier` 就是干这个的：

```go
MessageModifier: func(ctx context.Context, in []*schema.Message) []*schema.Message {
    // 截断到最近 20 轮、插入 profile、做 token 预算
    return compact(in)
},
```

一行 `WithMemory` 把这个注入逻辑挂上。Agent 每轮自动取历史、对话后自动存新消息。

## 7. 长期记忆：Eino 之外的设计

Eino 的三模式主要管**短期**（当前会话）。长期记忆（跨会话的“用户叫张三、偏好靠窗”）需要你自己落地：

```go
type UserPreference struct {
    UserID string `gorm:"index"`
    Key    string
    Value  string
}
```

用 PostgreSQL/MySQL + GORM 存，每次会话开始时加载偏好塞进 SystemPrompt。Eino 没有内置长期记忆模块，因为它高度业务相关——存什么、怎么取，每个应用不一样。

### 7.1 记忆架构的选型

| 记忆类型 | 存储 | 实现 |
|---|---|---|
| 短期 | 内存 / Redis | Eino Buffer/Window/Summary |
| 长期 | SQL 数据库 | 自定义 struct + GORM |
| 知识（RAG） | 向量数据库 | Milvus / Qdrant / pgvector |

原型阶段直接用 Eino Memory，不需要数据库；生产环境按上表选。

### 7.2 设计要点：记忆是“留什么”而非“存哪”

总结一下 Memory 设计的核心认知：**难点不在存储，在选择**。短期记忆难在“扔什么不疼”，长期记忆难在“哪些值得跨会话留”，知识记忆难在“怎么找到相关的”。Eino 给短期记忆提供了三种现成策略，长期和知识要你自己设计——因为那部分和业务深度绑定。

## 8. Memory vs RAG

第 3 节已经区分了三类记忆，这里单独对比最容易混淆的 Memory 和 RAG：

| 维度 | Memory | RAG |
|---|---|---|
| 目标 | 记住用户 | 查外部知识 |
| 对象 | User State / History | Documents |
| 来源 | 对话抽取 | 企业文档/网页 |
| 更新 | 动态、持续 | 相对稳定、定时重建 |
| 存储 | SQL/Redis/Vector | Vector DB 为主 |
| Eino 组件 | Session/Store/State | Loader/Transformer/Embedding/Indexer/Retriever |

两者**可以共用 Embedding + VectorDB**，但语义边界不能糊：Memory 回答“用户是谁”，RAG 回答“公司规范是什么”。

## 9. 总结

Eino 里“Agent 拥有记忆”的真实含义是：

```
短期：Graph State.Messages（单次运行内 ReAct 循环累积）
长期：Session/Store 持久化 + Profile/Vector/Episodic 三层加工
工程：MessageModifier 压缩 + CheckpointSaver 恢复
```

**Agent 自身无状态，记忆是业务用 State+Session+Modifier 拼出来的**。理解这一层，你才不会在代码里找 `eino/memory.Get` 这种不存在的 API，也不会把“多轮对话”误解成“模型自动记住了”。