+++
date = '2026-07-02T20:10:00+08:00'
draft = false
title = 'DeerFlow 学习笔记（二）：我从 Prompt 和中间件学到的两层约束'
categories = ['AI 大模型']
tags = ['DeerFlow', 'Agent', 'Prompt Engineering', 'Middleware', '安全', '源代码']
series = ['DeerFlow 学习笔记']
mermaid = true
+++

我以前写 Agent，习惯把所有要求都塞进 system prompt：工具怎么用、什么时候提问、哪些命令危险，似乎只要说明得足够完整，模型就会照做。DeerFlow 的实现让我意识到，这其实混淆了“引导行为”和“保证边界”。

## Prompt 只负责模型应该知道的事

DeerFlow 会把身份、工具使用方式、子任务协议和 Skill 索引放进相对稳定的 system prompt。日期、Memory 等会随请求变化的数据，则由动态上下文中间件按轮注入。

{{< mermaid >}}
flowchart TD
    A[稳定行为协议] --> D[模型上下文]
    B[日期 / Memory / 请求数据] -->|按轮注入| D
    D --> E[模型决定下一步]
    E --> F[Middleware 校验与改写]
    F --> G[工具执行或返回]
{{< /mermaid >}}

这种拆分首先有缓存收益：稳定前缀不必因为日期或记忆变化而整体失效。但我觉得更重要的是信任边界清楚了。Prompt 是模型可见的说明，动态上下文是当次运行的数据，两者的生命周期并不相同。

## 重要规则为什么还要写成代码

模型知道规则，不等于系统能保证规则。DeerFlow 把读前写检查、危险命令处理、并发限制、工具错误修复等能力放进 Middleware，在模型调用前后或工具执行前后介入。

我最初把中间件理解成可随意追加的插件列表。实际阅读后，顺序本身就是逻辑：某个中间件要先看到原始请求，另一个要包住工具执行，还有一些 after-model 钩子会按反向顺序返回。新增中间件时，真正要回答的不是“放在哪个文件”，而是：

- 它约束的是模型输入、模型输出，还是工具动作？
- 它需要看到谁处理前的数据？
- 同步与异步路径是否保持同样语义？
- 配置关闭时，整条链是否仍然成立？

这也是为什么关键限制不能只写在 Prompt 里。Prompt 可以解释原因和期望，Middleware 才能在运行时执行一致的判断。

## 我的结论

我现在更愿意把 Agent 约束分成两层：

```text
Prompt：告诉模型“应该怎样做”
Middleware：保证系统“实际允许怎样做”
```

软约束适合表达策略和语境，硬约束适合处理权限、并发、文件和危险动作。二者不是替代关系。只写代码会让模型不断撞墙，只写 Prompt 则会把系统安全寄托在一次概率输出上。

源码锚点：

- `backend/packages/harness/deerflow/agents/lead_agent/prompt.py`
- `backend/packages/harness/deerflow/agents/middlewares/dynamic_context_middleware.py`
- `backend/packages/harness/deerflow/agents/lead_agent/agent.py`

上一篇：[追一遍请求，我看懂了 DeerFlow 的运行主线]({{< relref "01-deer-flow-runtime-mainline.md" >}})  
下一篇：[DeerFlow 怎样控制工具带来的上下文膨胀]({{< relref "03-deer-flow-tools-extension.md" >}})
