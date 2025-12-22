+++
date = '2025-12-22T09:00:00+08:00'
draft = false
title = '深入理解 Eino（六）：RAG 实战--从 Retriever 到 Knowledge Layer'
categories = ['AI 大模型']
tags = ['Eino', 'RAG', 'Retriever', '向量检索', 'Go']
series = ['深入理解 Eino']
mermaid = true
+++

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

{{< mermaid >}}
graph LR
    Q[用户问题] --> V[问题转向量]
    V --> R[检索相关文档]
    R --> P[资料拼进 Prompt]
    P --> L[LLM 生成]
    L --> A[基于资料作答]
{{< /mermaid >}}

关键在第二步和第三步之间：检索回来的是“原始文档片段”，要拼进 Prompt 才能被 LLM 用。这就是 Eino 用 Chain 串 Retriever + Lambda + ChatModel 的原因。

## 3. RAG 在 Agent 架构中的位置

把 RAG 当成独立 Chatbot 是早期做法；在 Agent 里，RAG 是 **Knowledge Tool**，由 Planner 决定是否调用。

{{< mermaid >}}
graph TD
    AG[Agent Runtime] --> TL[Tool Layer]
    AG --> KL[Knowledge Layer]
    TL --> EXT[External API]
    KL --> RP[RAG Pipeline]
    RP --> RET[Retriever]
    RP --> RER[Reranker]
    RP --> VDB[Vector DB]
    RP --> DOC[Document Store]
{{< /mermaid >}}

Agent 不是每次都查知识，而是：
```
Need Knowledge?
  ├─ Yes → 调用 Knowledge Tool（内部跑 RAG）
  └─ No  → 直接答 / 调别的 Tool
```


## 4. RAG Pipeline 的完整流程

生产级 RAG 不是“Document → Embedding → Search → LLM”，而是：

{{< mermaid >}}
graph LR
    D[Documents] --> P[Processing/Parse]
    P --> C[Chunking]
    C --> E[Embedding]
    E --> V[Vector DB]
    Q[Query] --> EQ[Embed Query]
    EQ --> R[Retrieve TopK]
    R --> RK[Rerank]
    RK --> CB[Context Build]
    CB --> M[LLM]
{{< /mermaid >}}

离线侧（写）：Load → Transform(Split) → Embed → Index(Store)
在线侧（读）：Embed Query → Retrieve → Rerank → Assemble → Generate


## 5. Document Processing：知识进入系统

来源可能是 PDF / Word / Markdown / 网页 / 数据库表。Eino 里对应 `DocumentLoader` 组件，接口是 `Load(ctx) ([]*schema.Document, error)`。

例如本地文件 Loader：
```go
loader, _ := file.NewLoader(&file.Config{Path: "/data/knowledge/*.md"})
docs, _ := loader.Load(ctx)
```

解析阶段要把标题、章节、段落、代码块保留进 `schema.Document.MetaData`，后面检索过滤和引文展示都用得到。

## 6. Chunking：为什么必须切片

Embedding 模型有长度上限，100 页文档不能直接向量化。切片策略直接决定召回质量：

- **Fixed Size**：按 token 数切，简单但容易切断语义
- **Recursive Char Split**：按 `\n\n` → `\n` → `. ` 递归切，通用首选
- **Markdown Header Split**：按 `#` 层级切，技术文档友好
- **Semantic Split**：先 Embedding 找边界再切，效果最好但贵

经验值：Chunk 300~1000 tokens，Overlap 10%~15%。太大噪声多，太小上下文断。

Eino 里用 `DocumentTransformer`：
```go
splitter, _ := transformer.NewRecursiveCharSplitter(ctx, &transformer.RecursiveCharSplitterConfig{
    ChunkSize: 600, ChunkOverlap: 80,
    Separators: []string{"\n\n", "\n", ". ", " "},
})
chunks, _ := splitter.Transform(ctx, docs)
```


## 7. Embedding：文本变向量

`Embedding` 组件接口是 `EmbedStrings(ctx, []string) ([][]float64, error)`。同一模型用于写和读，维度必须一致，否则相似度无意义。

```go
emb, _ := openai.NewEmbedding(ctx, &openai.EedingConfig{Model: "text-embedding-3-small"})
vecs, _ := emb.EmbedStrings(ctx, []string{"Go 服务如何实现优雅关闭"})
```

为什么不用关键词：query“服务停止时如何避免请求丢失”和 doc“Graceful Shutdown 实现”字面不重叠，但向量近邻。

## 8. Vector Database 与 Indexer

向量库（Milvus / Qdrant / VikingDB / ES / pgvector）存的是 `schema.Document` 的 Content + Vector + MetaData。

写入走 `Indexer` 组件，接口 `Store(ctx, docs, opts) ([]string, error)`：
```go
indexer, _ := milvus2.NewIndexer(ctx, &milvus2.IndexerConfig{
    ClientConfig: &milvusclient.ClientConfig{Address: addr},
    Collection: "kb", Dimension: 1024, MetricType: milvus2.COSINE,
    Embedding: emb,
})
ids, _ := indexer.Store(ctx, chunks)
```


注意：Indexer 和 Retriever 是互补的读写两端，用同一个 Embedder。

## 9. Retriever：RAG 的第一核心组件

Eino 的 `Retriever` 接口只有一个方法：
```go
type Retriever interface {
    Retrieve(ctx context.Context, query string, opts ...Option) ([]*schema.Document, *error)
}
```
调用：
```go
docs, _ := retriever.Retrieve(ctx, "如何优雅停止服务？", retriever.WithTopK(5))
```
返回按 score 降序。

常见策略：
- **Dense Vector**：纯向量相似
- **Hybrid Search**：BM25 + 向量，ES/VikingDB 原生支持
- **Metadata Filter**：`retriever.WithFilter("department=payment")`
- **Multi-Query / RRF 融合**：多个改写 query 召回后按 Reciprocal Rank Fusion 合并


## 10. 为什么需要 Reranker

Retriever 的 TopK 是“粗排”，向量距离不等于相关度。Reranker（Cross-Encoder）把 `query + doc` 拼起来过一次小模型，输出精确相关分。

{{< mermaid >}}
graph LR
    RET[Retriever Top20] --> RR[Reranker]
    RR --> T5[Top5 → LLM]
{{< /mermaid >}}

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