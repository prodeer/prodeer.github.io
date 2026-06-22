+++
date = '2026-06-22T11:00:00+08:00'
draft = false
title = 'AI Agent 设计模式（六）：RAG——在生成前取得外部知识'
categories = ['AI 大模型']
tags = ['Agent', 'RAG', '语义检索', '设计模式']
series = ['AI Agent 设计模式']
mermaid = true
+++

员工询问：“今年出差住宿标准是多少？”模型训练数据不包含公司的最新制度，即使碰巧回答正确，也无法说明依据是哪一版文件。

RAG 模式不要求模型记住全部知识，而是在回答前检索相关材料，把外部知识放进当前生成上下文。

<!--more-->

## 模式意图

> 根据当前问题从外部知识源检索相关内容，再让模型基于检索上下文生成结果。

RAG 是 Retrieval-Augmented Generation，即检索增强生成。它将知识的存储和更新留在模型参数之外，适合处理私有、持续变化或需要引用来源的信息。

![AI Agent Rag 设计模式](/images/ai/ai-agent-rag-pattern.png)

## 问题场景：企业制度问答

公司有差旅、报销、采购和安全制度，文件会定期更新。员工的问题往往不会复述原文，例如“去上海开会一晚最多能报多少”，而制度写的是“一级城市住宿限额”。

关键词搜索可能漏掉语义相关内容，直接让模型回答又缺少私有知识。RAG 的工作是先找到当前有效的制度片段，再用这些材料组织答案，并保留来源。

## 基本结构

RAG 通常包含摄取和查询两条管线：

{{< mermaid >}}
flowchart LR
    subgraph I[知识摄取]
        D[Documents] --> P[Parse / Chunk]
        P --> X[Index]
    end
    subgraph Q[在线查询]
        U[Question] --> R[Retriever]
        X --> R
        R --> C[Retrieved Context]
        C --> G[Generator]
        U --> G
        G --> A[Answer + Source]
    end
{{< /mermaid >}}

主要参与者包括：

- **Knowledge Source**：文档、网页、数据库或业务记录；
- **Indexer**：解析、切分并建立检索索引；
- **Retriever**：根据查询召回相关内容；
- **Context Builder**：过滤、排序并控制上下文预算；
- **Generator**：基于问题和检索内容生成结果。

## 运行过程

{{< mermaid >}}
sequenceDiagram
    participant U as User
    participant R as Retriever
    participant K as Knowledge Base
    participant M as Model
    U->>R: 上海住宿能报多少?
    R->>K: semantic + metadata search
    K-->>R: 2026 差旅制度 / 一级城市限额
    R->>M: question + selected passages
    M-->>U: answer + document reference
{{< /mermaid >}}

最小过程可以表示为：

```python
query = rewrite(user_question)
chunks = retriever.search(query, filters={"status": "active"})
context = rerank_and_limit(query, chunks)
answer = model.generate(user_question, context)
return attach_sources(answer, context)
```

向量数据库不是模式的必要条件。全文检索、SQL、知识图谱甚至文件目录都可以作为 Retriever，只要存在“检索后生成”的结构。

## 核心特点

### 知识与模型参数分离

更新制度不需要重新训练模型，只需更新知识源和索引。这使 RAG 适合频繁变化或组织私有的信息。

### 生成依赖当前检索上下文

模型回答时看到的是一个经过选择的证据窗口，而不是整个知识库。检索质量直接限制回答质量。

### 可以建立来源路径

检索结果带文档、章节和版本，回答就有机会附上可核对来源。但“有引用”不自动等于“引用支持结论”，仍需要校验。

### 它是两阶段系统

摄取阶段决定文档怎样被解析、切分和更新；查询阶段决定怎样召回、重排和生成。很多 RAG 问题并不来自模型，而来自其中一个检索阶段。

## 优点与代价

{{< mermaid >}}
flowchart TB
    R[RAG]
    R --> B1[接入私有和新知识]
    R --> B2[知识可以独立更新]
    R --> B3[结果可以保留来源]
    R --> C1[检索失败限制回答]
    R --> C2[增加索引和评测系统]
    R --> C3[引用仍可能被误用]
{{< /mermaid >}}

RAG 降低模型脱离材料回答的概率，却不能保证事实正确。如果检索没有找到正确文档、过滤了当前版本，或者生成器错误解释片段，答案仍然会错。

## 适用与不适用场景

适合使用：

- 知识不在模型训练数据中；
- 内容持续变化，需要独立更新；
- 回答需要引用或追溯来源；
- 数据量较大，无法全部放进上下文。

不适合使用：

- 输入已经包含全部所需信息；
- 数据很少且结构明确，直接查询即可；
- 任务主要改变行为或风格，而不是补充知识；
- 没有能力维护知识更新和检索评测。

## 与相关模式的区别

| 概念 | 核心作用 |
|---|---|
| Search Tool | 执行一次搜索动作 |
| RAG | 将检索结果系统地用于生成 |
| Memory | 取回与用户或过去运行相关的历史 |
| Fine-tuning | 改变模型行为、能力或输出分布 |

一个应用可以使用搜索工具而没有 RAG，例如把搜索结果直接展示给用户。RAG 也不一定是 Agent，固定的“检索—生成”问答流程就是典型 RAG Workflow。

## 模式小结

| 维度 | RAG |
|---|---|
| 意图 | 用外部检索内容增强当前生成 |
| 识别信号 | Retrieval 发生在 Generation 之前 |
| 主要优点 | 私有知识、新鲜度、可追溯来源 |
| 主要代价 | 摄取、检索、版本和评测复杂度 |
| 使用原则 | 先保证检索正确，再讨论生成效果 |
