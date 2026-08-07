---
title: "深入理解 Eino（六）：RAG 实战--从 Retriever 到 Knowledge Layer"
date: 2025-12-22
category: ai
tags: ["Eino", "RAG", "Retriever", "向量检索", "Go"]
description: "RAG（Retrieval-Augmented Generation）是目前企业 Agent 最常见的知识增强方式。但真正生产级 Agent 中，RAG 并不是“向量数据库 + Prompt”的简单组..."
---



RAG（Retrieval-Augmented Generation）是目前企业 Agent 最常见的知识增强方式。但真正生产级 Agent 中，RAG 并不是“向量数据库 + Prompt”的简单组合，而是一套完整的 Knowledge Layer。理解 RAG，是理解 Agent 如何连接企业数据的重要一步。这篇讲 Eino 的 Retriever 怎么用，以及怎么从一个检索器搭成“知识层”。

<!--more-->

## 1. 为什么 Agent 需要 Knowledge Layer？

大模型本身具备强大的语言能力，但它存在一个根本问题：

> 模型不知道你的私有数据。

企业内部的产品文档、技术规范、客户资料、业务流程、数据报表，都不在训练数据里。直接问“我们公司退款流程是什么”，LLM 只能回“我不知道”。

传统解法——微调/重训——成本高、周期长、更新慢。RAG 的思路是：**不让模型记住所有知识，回答时动态查找相关知识再生成**。这就是 Knowledge Layer 存在的理由。


## 2. RAG 的本质

RAG = Retrieval-Augmented Generation，检索增强生成。

先把 RAG 拆成清晰的五步：



![Mermaid 图表](/images/mermaid/mermaid-eb7f1130-3.svg)



Eino 里 Reranker 通常实现为 `DocumentTransformer`（输入 `[]*schema.Document`，输出重排后 `[]*schema.Document`），可挂进 Graph 的 Lambda 或 Transformer 节点。

## 11. Context Builder：拼 Prompt

检索结果不能直接全塞，要控制 token、去重、按引用编号。典型拼法：
```go
var sb strings.Builder
sb.WriteString("Reference materials:\n")
for i, d := range docs {
    sb.WriteString(fmt.Sprintf("[%d] %s\n", i+1, d.Content))
}
msgs := []*schema.Message{
    schema.SystemMessage("你是技术助手，只能基于参考资料回答。"),
    schema.UserMessage("问题：" + question + "\n\n" + sb.String()),
}
```
`ChatTemplate` 组件（`FString/Jinja2`）就是干这个参数化装配的。

## 12. Eino 中 RAG 的 Component 思想

Eino 不提供“RAG 大对象”，而是把链路拆成可替换组件：

| 阶段 | 组件接口 | 方法 |
|---|---|---|
| 加载 | `DocumentLoader` | `Load` |
| 切分 | `DocumentTransformer` | `Transform` |
| 向量化 | `Embedding` | `EmbedStrings` |
| 写入 | `Indexer` | `Store` |
| 召回 | `Retriever` | `Retrieve` |
| 精排 | `DocumentTransformer`（Reranker 实现） | `Transform` |

编排时：
- Chain：`compose.NewChain().AppendRetriever(r).AppendChatModel(m)`
- Graph：`g.AddRetrieverNode("retriever", r)` + `g.AddChatModelNode(...)` + Lambda 做 Context Build

换 Embedding 模型 / 换向量库，只改构造那一行，上游不变。

## 13. RAG vs Memory

| 维度 | Memory | RAG |
|---|---|---|
| 目标 | 记住用户 | 查外部知识 |
| 对象 | User State / History | Documents |
| 来源 | 对话抽取 | 企业文档/网页 |
| 更新 | 动态持续 | 定时重建索引 |
| Eino 组件 | Session/State | Loader/Transformer/Embedding/Indexer/Retriever |

Memory 答“用户是谁”，RAG 答“公司规范是什么”。两者可共用 Embedding+VectorDB，但边界不能糊。

## 14. Agent 中的 Knowledge Tool 设计

不要每次都跑 RAG，把它包成 Tool 让 Planner 决策：

```go
searchDoc := tool.NewInvokableTool(
    schema.ToolInfo{Name: "search_document", Desc: "查企业内部文档", ParamsOneOf: ...},
    func(ctx context.Context, args string) (string, error) {
        q := parse(args)
        docs, _ := retriever.Retrieve(ctx, q, retriever.WithTopK(3))
        return format(docs), nil
    },
)
```
挂进 `react.NewAgent` 的 `ToolsConfig.Tools`，Agent 自己决定要不要调 `search_document`。这就是 Knowledge Layer 接入 Agent 的标准姿势。

## 15. 企业级 Knowledge Layer 架构

生产不是单脚本，而是服务化：

```text
Document Service（权限/版本）
  → Chunk Service（切分策略中心化）
  → Embedding Service（模型统一管控）
  → Indexer Service（写 VectorDB + MetaDB）
  → Retrieval Service（Retriever + Rerank + 过滤）
  → Agent Knowledge Tool
```

拆开是为了解决：多租户、权限过滤（metadata 层）、增量更新、审计、模型热切换。

## 17. 总结

RAG 不是 `VectorDB + Prompt`，而是：

```
Loader → Transformer → Embedding → Indexer → Retriever → Reranker → ContextBuilder → LLM
```

在 Eino 里这条链路全部 Component 化，Graph/Chain 编排，Agent 通过 Knowledge Tool 按需调用。

Agent Runtime 的三块拼图：
- **Memory**：记住用户
- **Knowledge Layer**：理解世界（本文）
- **Tool Layer**：操作世界