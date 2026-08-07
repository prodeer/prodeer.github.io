---
title: "学习 Pi-Agent（三）：Agent Loop 的两端——模型适配与工具执行"
date: 2026-08-01
category: ai
tags: ["Pi-Agent", "Agent"]
description: "Agent Loop 是一个极简循环：调用模型，发现工具请求就执行，再把结果交给模型。循环本身并不复杂，真正麻烦的是它省略的两个黑盒： - `streamSimple()` 怎么把 Claude、GP..."
---



Agent Loop 是一个极简循环：调用模型，发现工具请求就执行，再把结果交给模型。循环本身并不复杂，真正麻烦的是它省略的两个黑盒：
- `streamSimple()` 怎么把 Claude、GPT、Gemini 接到同一条循环上？
- `executeToolCalls()` 又怎么把模型生成的参数变成一次可控的真实操作？

两个问题本质上是同一件事：**在系统边界上吸收不确定性，让 Agent Loop 只处理稳定协议。**

<!--more-->

## 1. Agent Loop 的简单，是边界层换来的

先回到[上一篇](/post/ai/pi-agent/02-agent-loop/)的极简循环：

```typescript
while (true) {
    const response = await streamSimple(model, context, options);
    const toolCalls = getToolCalls(response);
    if (toolCalls.length === 0) break;

    const results = await executeToolCalls(toolCalls);
    context.messages.push(...results);
}
```

如果只看这几行，模型调用像普通 RPC，工具调用也像本地函数调用。但真实世界并没有这么规整：

- Anthropic、OpenAI、Google 的请求结构、流式事件和思考参数并不相同；
- ToolCall 是模型生成的非确定性数据，工具名可能不存在，参数可能缺失或类型错误；
- 文件系统、进程和网络都会失败，执行还可能被中止或拦截。

Pi 在 Loop 两端各放了一道边界：模型侧把 Provider 方言翻译成统一事件，工具侧把行动意图变成 `ToolResultMessage`。

[![Agent Loop 的模型边界与工具边界](/images/ai/pi-agent-model-tool-boundaries.svg)](/images/ai/pi-agent-model-tool-boundaries.svg)

`convertToLlm` 也在这条链路上，上一篇已经介绍过，这里不再展开。本文关心的是它两侧更一般的设计：**边界内可以千差万别，跨过边界后必须只剩一种语言。**

## 2. 模型边界：把 Provider 方言翻译成统一事件

### 2.1 统一模型调用，不等于找到所有 API 的交集

多模型抽象很容易先设计一个 `BaseProvider`，再要求每家模型继承它。但各家 API 的共同实现其实很少：

| 差异 | Anthropic | OpenAI | Google |
|---|---|---|---|
| 消息内容 | `content[]` 内容块 | 字符串或内容数组 | `parts[]` |
| 工具结果 | 通常放进 user 内容块 | 独立的 tool 消息 | function response part |
| 思考参数 | thinking 配置与 token 预算 | reasoning effort | thinking config |
| 流式响应 | Anthropic 事件类型 | Responses/Completions 事件 | Google SDK Chunk |

强行复用实现，最后往往只剩空方法和 Provider 特判。Pi 的选择是：**不统一翻译过程，只统一输入和输出。**

当前源码用 `StreamFunction` 表达这个契约：

```typescript
export type StreamFunction<
    TApi extends Api = Api,
    TOptions extends StreamOptions = StreamOptions,
> = (
    model: Model<TApi>,
    context: Context,
    options?: TOptions,
) => AssistantMessageEventStream;
```

三个参数进入，一条 `AssistantMessageEventStream` 出来。源码还规定：请求、模型或运行时故障应编码进事件流，不能直接向外抛出。

这意味着翻译器有两个方向的工作：

1. **请求方向**：把统一 `Context`、工具描述和选项翻译成 Provider 的私有请求。
2. **响应方向**：把 SSE、SDK Chunk 或其他私有响应翻译成统一事件。

### 2.2 Loop 实际只认识 12 种事件

截至本文核对的版本，`AssistantMessageEvent` 是 12 种联合类型：

```text
start

text_start      → text_delta      → text_end
thinking_start  → thinking_delta  → thinking_end
toolcall_start  → toolcall_delta  → toolcall_end

done | error
```

文字、思考和工具调用都遵循“开始—增量—结束”的结构，最后以 `done` 或 `error` 收口。每个增量事件携带当前 `partial` 消息，因此上层不需要知道 OpenAI 的 delta 长什么样，也不需要知道 Anthropic 的 content block 如何编号。

这层协议会**阻止 Provider 细节向上扩散**：

- Loop 只检查统一消息里的 `toolCall`；
- TUI 只订阅文本和思考增量；
- Session 只保存统一消息。新增 Provider 时，这些模块无需修改。

### 2.3 当前源码正在从“全局注册表”迁移到 Provider 实例

这里需要做一次版本校正。学习资料中的 `compat.ts` 根据 `model.api` 查询全局注册表。这个实现和 `registerApiProvider()`、`streamSimple()` 仍能使用，但文件开头已经标明：**这是保留旧 API 的临时兼容入口。**

新代码改用 `createModels()` 和 Provider factory：

```text
Models
  └── Provider（模型目录、认证、请求路由）
        └── ProviderStreams（具体 API 翻译器）
              └── AssistantMessageEventStream
```

例如 `anthropicProvider()` 把模型目录、认证逻辑和 `anthropicMessagesApi()` 组装成一个 Provider；`Models.streamSimple()` 找到目标 Provider，应用认证与请求头，再委托给翻译器。

入口正在变化，但设计没有变：**路由层负责“该找谁”，翻译器负责“怎么说”，Agent Loop 只消费统一结果。** 写学习笔记时，区分稳定边界和过渡 API，比背住当前函数名更重要。

### 2.4 统一的是语义，不是底层参数

`ThinkingLevel` 是一个小样本：上层表达推理强度，Provider 再翻译成 token budget、reasoning effort 或 thinking config。缓存同理，上层表达保留策略，底层选择具体机制。它统一的是**调用者意图**，不是所有模型能力的最小交集。

## 3. 工具边界：把模型意图变成受控操作

模型边界解决“外部 API 不统一”，工具边界面对的问题更敏感：**模型输出本身不可信。**

这里的“不可信”不一定意味着恶意。模型可能把数组序列化成字符串、写错参数名，或者请求一个已删除的文件。ToolCall 只能视为行动意图，不能立即执行。

上一篇已经讲过工具的三层类型和并发调度，本文只看一次 ToolCall 真正落地前后的执行管道。

### 3.1 五步管道不是形式主义

当前 `agent-loop.ts` 把执行拆成准备、执行和收尾三个函数，展开后可以看成五步：

```text
1. prepareArguments   修正已知的模型参数怪癖
2. Schema 验证        拒绝不符合工具契约的输入
3. beforeToolCall     执行前应用产品策略
4. execute            调用工具，并流式报告进度
5. afterToolCall      审计、脱敏、修正结果或请求终止
```

五步之前还有工具查找；找不到时直接生成错误结果。各步失败最终都被收敛成相同形态。

### 3.2 参数预处理和 Schema 验证不能合并

以 `edit` 为例，它期望 `edits` 是数组，但某些模型可能传来：

```json
{
  "path": "src/main.ts",
  "edits": "[{\"oldText\":\"foo\",\"newText\":\"bar\"}]"
}
```

`prepareArguments` 会尝试把字符串化的数组解析回来，然后才进入 Schema 验证。看起来两步都在“处理参数”，职责却完全不同：

- **预处理是兼容层**：它知道模型经常以什么方式犯错，并修复有限、明确的偏差。
- **验证是契约层**：不管参数来自哪个模型，都必须满足工具 Schema。

把兼容逻辑塞进 Schema，验证规则会被模型怪癖污染；只做预处理不做验证，工具仍可能收到任意结构。两层分开后，兼容策略可以变化，契约保持稳定。

### 3.3 Hook 是策略插槽，不是天然的安全沙箱

参数验证通过后，`beforeToolCall` 可以阻止执行；`afterToolCall` 可以覆盖内容、错误标记、usage 或 `terminate`。这给产品层留下了审批、审计、脱敏和早停的插槽。

但要注意：**Hook 能实施策略，不等于 Pi 默认提供了权限系统。** Pi 默认继承当前进程的文件、网络与凭据权限。Hook 漏配或实现错误时不会自动形成隔离；真正的安全边界仍要靠容器、微型虚拟机或其他沙箱。

三者的边界是：

- Schema 保护工具免受错误参数影响；
- Hook 承载应用策略；
- Sandbox 限制进程能影响的外部世界。

### 3.4 Operations：工具能力不必绑定本机系统调用

Pi 的内置工具没有把所有系统调用都写死在执行逻辑里。以 `read` 为例，它依赖一个很小的 `ReadOperations`：

```typescript
export interface ReadOperations {
    readFile: (absolutePath: string) => Promise<Buffer>;
    access: (absolutePath: string) => Promise<void>;
    detectImageMimeType?: (
        absolutePath: string,
    ) => Promise<string | null | undefined>;
}
```

默认实现调用本机文件系统，也可以注入另一套 Operations：

- 单元测试注入内存或 Mock 实现，不需要真的修改磁盘；
- 远程执行可以换成 SSH、Sandbox RPC；
- `read` 只获得读取所需能力，不必拿到完整 `fs`。

这是工具与副作用之间的窄边界：工具负责业务语义，Operations 决定动作在哪里发生。

### 3.5 错误为什么要变成消息

文件不存在、Schema 验证失败、Hook 阻止、`execute` 抛异常、`afterToolCall` 失败，这些路径最后都会形成一条 `ToolResultMessage`，其中 `isError: true`。

这么做的关键不在于“统一错误格式”，而在于**改变错误的接收者**：

- 异常交给调用栈，结果通常是当前循环被打断；
- 错误消息交给模型，结果可以成为下一步推理的 Observation。

例如 `read` 返回“文件不存在”后，模型可以先调用 `ls`；`edit` 返回“oldText 找不到”后，可以重新读取文件。框架无法为每种失败写死恢复流程，但模型可以结合上下文选择下一步。

当然，并非所有错误都应该继续。认证失效、上下文溢出、用户中止等模型调用级故障仍有自己的终止策略。**“错误即消息”适用于工具边界上可被模型观察和纠正的失败，不是吞掉一切异常。**

## 4. 一次失败的 read，如何走完整条链路

把两道边界放回同一次 Turn，流程就清楚了。假设用户说“读取 `src/config.ts` 并解释配置”，但文件已经被重命名。

[![一次失败的 read 如何变成下一步行动](/images/ai/pi-agent-failed-read-flow.svg)](/images/ai/pi-agent-failed-read-flow.svg)

这条链路经历了六步：

1. Provider 用自己的 function call 或 content block 表达工具请求。
2. API 翻译器把私有事件转换为统一的 `toolcall_start/delta/end`，最终消息中得到一个标准 `ToolCall`。
3. Loop 找到 `read`，预处理并验证参数，再调用工具。
4. `ReadOperations.access()` 因文件不存在而抛错。
5. `executePreparedToolCall()` 捕获异常，生成错误结果；`createToolResultMessage()` 再补上工具名、调用 ID、`isError` 和时间戳。
6. 下一轮调用中，错误被翻译成 Provider 认识的工具结果格式，模型改用 `ls` 查找真实文件名。

这里发生了两次反向翻译：Provider 私有响应变成行动意图，工具结果又变成 Provider 上下文。Loop 始终只处理 `AssistantMessageEvent`、`ToolCall` 和 `ToolResultMessage`。

这就是本文最想说明的一点：**边界层不仅隐藏格式差异，还把外部失败转换成系统可以继续推理的状态。**

## 5. 从两道边界提炼出的设计原则

### 原则一：复杂性应该被关在边界上

Provider 差异属于模型适配层，工具参数和副作用属于工具执行层。Loop 如果开始出现 `if provider === "anthropic"` 或 `if toolName === "read"`，通常说明边界已经泄漏。

健康的核心必须明确哪些事情不归它做。

### 原则二：先统一协议，再开放实现

模型侧统一 `StreamFunction` 和事件流，工具侧统一 ToolCall、执行管道和 ToolResultMessage；协议内部则允许不同 SDK、认证方式、文件系统和远程执行实现自由变化。

它只约束跨边界必须稳定的部分，不假装所有实现拥有相同过程。

### 原则三：错误也是上下文

Agent 系统可以把可恢复错误放回对话，让模型根据目标和历史决定下一步。

但错误消息必须具体、可行动。“读取失败”只会诱发盲目重试；“Offset 200 超过文件总行数 100”则直接告诉模型如何修正参数。Agent 的纠错能力，不只取决于模型，也取决于边界层提供了多高质量的 Observation。

## 小结

1. Loop 的简单来自模型侧和工具侧对复杂性的隔离。
2. 模型边界把 Provider 私有协议翻译成统一事件；当前入口正迁移到 `Models + Provider factory`，稳定的是协议。
3. 工具边界用五步管道把模型意图收敛为 `ToolResultMessage`。
4. Operations 解耦系统调用；Hook 承载策略，真正的权限隔离仍需要 Sandbox。
5. 可恢复错误成为消息后，模型才有机会在下一轮自我纠错。

模型调用、Loop 和工具执行已经连成完整链路，而共同载体始终是消息。下一篇继续拆 Pi 的消息系统与事件驱动设计。
