---
title: "学习 Pi-Agent（二）：Agent Loop —— 驱动 LLM 自主执行的引擎"
date: 2026-07-27
category: ai
tags: ["Pi-Agent", "Agent"]
description: "上一篇把 Pi 的分层目录拆完了，但目录不等于运行时。真正让 Pi 从「会聊天的 CLI」变成「能改代码的助手」的，是 pi-agent-core里那个不停转的 Agent Loop。  这一篇钻进..."
---



上一篇把 Pi 的分层目录拆完了，但目录不等于运行时。真正让 Pi 从「会聊天的 CLI」变成「能改代码的助手」的，是 pi-agent-core里那个不停转的 Agent Loop。

这一篇钻进 `pi-agent-core` 的心脏，回答三个问题：**循环为什么存在？它靠什么信号停转？内核和产品层的增强怎么分开？**

<!--more-->

![Pi Agent Loop](/images/ai/pi-agent-loop.png)


## 1. 先分清：大模型的三种用法

在聊 Agent Loop 之前，先厘清「用大模型」到底有几种模式。这决定了 Agent 和你后端程序有什么本质不同：

| 维度 | 直接调用 | Workflow | Agent Loop |
|---|---|---|---|
| 决策者 | 用户 | 你的代码 | **模型** |
| 模型调用次数 | 1 次 | N 次（代码控制） | 不确定（模型控制） |
| 核心工作 | 写提示词 | 设计流程 | 定义工具和循环 |
| 模型角色 | 执行者 | 流水线环节 | 自主决策者 |
| 典型场景 | 翻译、摘要 | 文档流水线、RAG | 编程助手、自动化任务 |

关键区别在最后一列：**Agent 模式下，步骤之间的流转不再由你写死，而是由模型的输出内容驱动。** 你的代码只做两件事——把用户输入和工具结果喂给模型；如果输出里有工具调用请求就执行，没有就认为任务完成。

至于「什么时候该停」，那是**人类定义的规则**，不是模型自己判断的。这一点后面会反复出现，是理解整个 Loop 的钥匙。

## 2. 什么是 Agent Loop

### 2.1 从 HTTP Server Loop 说起

作为后端工程师，其实你早就写过循环驱动的系统了。一个 HTTP Server 的本质是：

```go
for {
    conn := accept()   // 等待请求
    handle(conn)       // 处理
}
```

Agent Runtime 的骨架几乎一模一样：

```go
for {
    response := llm()      // 等待模型决策
    if toolCall {
        execute()          // 执行工具
        continue
    }
    break
}
```

两者都是**事件驱动循环**。区别只在于：HTTP Loop 等待的是「网络请求」，Agent Loop 等待的是「模型的决策」。

理解了这个类比，Agent Loop 就不再神秘——它不是什么魔法，就是一个 `while` 循环，只不过循环体里坐着一个会思考的大脑。

### 2.2 Agent Loop 的基本形态

一次完整执行的流转是这样的：

```
用户目标 → LLM 推理 → {输出里有工具调用?} → 有→ 执行工具 → 结果写回消息历史 → LLM 推理
                                             ↓ 没有
                                          任务完成，返回
```

用最简伪代码表示，它就是十几行：

```typescript
async function simpleLoop(messages, model, tools) {
    while (true) {
        const response = await callModel(model, messages, tools);  // ← Pi 在这里夹 prepareNextTurn
        messages.push(response);
        if (response.stopReason !== "toolUse") return messages;    // ← 但真正判停看 toolCalls.length
        for (const toolCall of response.toolCalls) {
            messages.push(await executeTool(toolCall));        
        }
    }
}
```

这段代码体现了 Agent 最核心的分工：**LLM 负责决策，Runtime 负责执行。** 

这十几行是所有 Agent 的内核，后面我们会看到 Pi 是怎么在它之上「叠加」产品能力的。

## 3. Trace 与 Turn：两个必须分清的概念

- **Trace**：从用户按下回车到 Agent 发出 `agent_end` 的**整个过程**，包含多个 Turn。
- **Turn**：**一次模型调用 + 这次调用触发的所有工具执行**，由一对 `turn_start` / `turn_end` 事件包裹。

```
Trace（agent_start → agent_end）
├── Turn 1：调模型 → 返回 toolUse（读文件）→ 执行 read
├── Turn 2：带结果再调模型 → 返回 toolUse（改文件）→ 执行 edit
└── Turn 3：带结果再调模型 → 返回 stop（无工具调用）→ 结束
```

最容易搞错的一点：**一个 Turn 只有一次模型调用。** 假设模型一口气要求三个工具（`read` + `grep` + `find`），它们**都在同一个 Turn 里**执行——因为都是同一次模型调用的产物；但把结果喂回去、再调模型的那一刻，就已经进入下一个 Turn 了。

用后端类比：Trace 像一次 HTTP 请求的生命周期，Turn 像其中一次「接收请求 → 查 DB → 返回」的处理单元。一个 Trace 多个 Turn，和一个请求里多次查库是同一类颗粒度。

## 4. 循环靠什么信号停转

循环怎么转清楚了，那它**什么时候停**？先说结论：实际驱动 `while` 继续转的，既不是 `stopReason === "toolUse"`，也不是任何「任务完成度」启发式，而是**「本次响应里有没有未终止的 toolCall 块」**。`stopReason` 只是 `Anthropic/OpenAI` 给的辅助信号，Pi 在 `agent-loop.ts` 里只拿它当参考。

### 4.1 stopReason：五种取值，两种是框架注入的

整个循环的「油门和刹车」集中在一个字段上：`stopReason`。但先纠正一个直觉误区：**模型不会告诉你「我要停了」。** 模型只是个 token 预测器，它并不「知道」任务做完没有。

`stopReason` 的值其实来自两个不同的地方：

| stopReason | 含义 | 来源 |
|---|---|---|
| `toolUse` | 模型输出了工具调用，API 检测到后返回 | 模型 API |
| `stop` | 生成自然终止，没有工具调用 | 模型 API |
| `length` | token 数达到上限被截断 | 模型 API |
| `error` | 调用异常（网络断了、API 报错） | **框架流式层注入** |
| `aborted` | 用户主动中止（`AbortSignal` 触发） | **框架流式层注入** |

后两种是关键：模型 API 根本不会返回它们，是 Pi 的流式层在 `catch` 块里替模型「兜底」——API 抛异常时，根据 `AbortSignal` 是否触发，分别标记为 `aborted`（用户中止）或 `error`（故障），好让循环能 fail fast。

```typescript
// packages/ai/src/ 流式层 catch 块
output.stopReason = options?.signal?.aborted ? "aborted" : "error";
```

### 4.2 真正驱动循环的规则

这里有个反直觉的细节：**实际驱动循环的并不是 `stopReason === "toolUse"`，而是「输出里有没有 `toolCall` 块」。**

```typescript
// 简化逻辑（实际见 agent-loop.ts）
const toolCalls = message.content.filter(c => c.type === "toolCall");
let hasMoreToolCalls = false;
if (toolCalls.length > 0) {
    const executedBatch = await executeToolCalls(...);
    hasMoreToolCalls = !executedBatch.terminate;  // 全部工具都 terminate 才停
}
```

两个边界情况能说明为什么要这么设计：

- 即使 `stopReason === "length"`（被截断），只要 `content` 里还有 `toolCall` 块，循环**仍会执行工具**；
- 反之即使 `stopReason === "toolUse"`，只要所有工具结果都设了 `terminate: true`，循环**也会停**。

所以真正的判据是 `toolCalls.length > 0 && !terminate`，`stopReason` 只是参考信号之一。

### 4.3 四条退出路径

内层循环的条件是 `while (hasMoreToolCalls || pendingMessages.length > 0)`，一共有四条退出路径：

| 退出路径 | 触发条件 | 说明 |
|---|---|---|
| 正常退出 | `stop`/`length` + 无 followUp + 无 pending | 最常见 |
| 硬停止 | `error` / `aborted` | 立即退出，不检查 followUp（fail fast） |
| 外部钩子停 | `shouldStopAfterTurn()` 返回 true | 上下文快满、达到最大 Turn 数等 |
| 工具终止 | 一批工具结果**全部** `terminate: true` | 用 `every` 而非 `some`——保守策略 |

### 4.4 为什么不让代码判断「任务完成」

你可能会问：为什么不写得更聪明一点，让代码自己判断任务做完没有？

**这正是 Agent 和 Workflow 的本质区别。** Workflow 里你知道流程有几步，可以判断进度；但 Agent 模式下，你根本不知道模型要读几个文件、跑几次命令。唯一能稳定依赖的信号，就是「输出里还有没有工具调用」。

这既是局限，也是优雅——**不需要任何「完成度」判断逻辑**，把决策彻底外包给模型，代码只做最简单的信号判断。

## 5. 内核 + 叠加：Pi 的分层智慧

第 2 节那十几行的 `simpleLoop` 就是**内核**，也是所有 Agent 的最小公约数。但 Pi 的 `coding-agent` 是个交互式编程助手，光有内核不够，它在内核之上叠加了四个设计：

| 真实需求 | 叠加的设计 |
|---|---|
| 用户在 Agent 工作时又输入新指令 | **steering** 消息注入：紧急消息在 Turn 之间插队 |
| 系统在 Agent 完成后想追加任务 | **followUp** 外层循环：内层停了外层可重启 |
| 不同复杂度任务想用不同档次模型 | **prepareNextTurn** 钩子：每 Turn 结束可换模型/上下文 |
| 上下文窗口快满需触发压缩 | **shouldStopAfterTurn** 钩子：外部安全阀 |

**这四项都是 `coding-agent` 的功能选择，不是 Agent 的通用法则。** 如果你只想做一个「一问一答带工具」的简单 Agent，这整张表都是多余的——内核那十几行就够了。

> 这是 Pi 最值得学的设计思路：**先有一个能独立成立的极简内核，产品层的复杂需求全部以「可选叠加」的形式挂上去，而不是揉进内核里。** 做自己的 Agent 时，先搭内核，再按场景加叠加。

## 6. 深入 runLoop：双层循环结构

把内核和叠加合起来，Pi 真实的 `runLoop()` 是一个**双层循环**：



![Mermaid 图表](/images/mermaid/mermaid-aa16a44c-1.svg)



- **准备阶段始终顺序**：验证和 `beforeToolCall` 不能并行——万一工具 B 被拦截了，工具 C 就不该执行。
- **只有 execute 并行**：真正耗时的执行用 `Promise.all` 并发。
- **事件有序**：结果按调用顺序发出，保证 LLM 收到的上下文顺序正确。

此外，`edit` 工具内部还有第二道防线 `withFileMutationQueue`，对同一文件的编辑做串行化，避免并发写坏文件。

## 9. steering vs followUp：插队 vs 排队

前面反复出现的 steering 和 followUp，很容易混。它们的区别一句话能记住：

| 维度 | steering（叠加 1） | followUp（叠加 2） |
|---|---|---|
| 检查时机 | 进循环前 + 内层每圈 | 内层全部结束后 |
| 语义 | **紧急插队**——工具执行间隙插入 | **排队等叫号**——等当前任务完成 |
| 典型场景 | 用户在 Agent 工作时输入新指令 | 系统追加「顺便跑个测试」 |

注意：steering **在 Turn 边界注入，而非打断当前 Turn**。当前 Turn 完整跑完，新指令在下一个 Turn 开头「插队」——既不中断，又能及时响应。

## 小结

拆完 Pi 的 Agent Loop，可以提炼出四条通用原则：

**原则 1：ReAct 是骨架，停止规则由人定义。** 循环模式是 Reason → Act → Observe → Reason。模型输出决定「调什么工具」，但「什么时候停」是人类定义的规则——模型不再输出工具调用时，本轮结束。**这是 Agent 与 Workflow 的分水岭。**

**原则 2：把决策外包给模型输出模式。** 真正驱动循环的不是 `stopReason` 本身，而是「输出里有没有 `toolCall` 块且未全部 terminate」。代码只做最简单的信号判断，不去猜「任务完成度」。

**原则 3：内核十几行就够，复杂能力靠叠加。** steering、followUp、prepareNextTurn、shouldStopAfterTurn 全是产品层按需叠加的。做自己的 Agent 时，先搭内核，再按场景加叠加，不要一上来就把功能揉进循环里。

**原则 4：Event 是 Agent 系统的一等公民。** Agent 是长流程任务，一次请求可能思考几秒、调用多个工具、产出几十个事件。用事件流（`agent_start` / `turn_start` / `message_update` / `tool_result` / `turn_end` / `agent_end`）把过程暴露出来，UI 才能实时渲染，可观测性才能落地。