+++
date = '2026-05-21T10:00:00+08:00'
draft = false
title = '构建炒股 Agent（三）：Skills —— 把工具链变成 AI 的专业技能'
categories = ['AI 大模型']
series = ['viewpoint_miner']
+++

第 2 篇搭好了 MCP Server，并按业务能力整理了 27 个工具。一切就绪——直到实际用起来：

> 用户："分析一下北方稀土最近的信号。"

LLM 看到 27 个工具。它需要先判断：是调 `list_stocks` 还是 `search_stocks`？找到了 stock_id 之后，是调 `get_stock_viewpoints`（可能返回 363 条）还是 `get_stock_summary`（太简略）还是 `summarize_stock_signals`（刚刚好）？

LLM 通常能选对。但万一选错了——比如调了 `get_stock_viewpoints` 拿到 363 条原文，里面真正有价值的信号可能只有十几条。LLM 要在 300 多条废话里翻 13 条有用信息，**既稀释注意力，又浪费 token**。

这不是简单的"模型够不够聪明"，而是工具选择也有成本。同一个目标往往存在多条可行路径，但它们在调用次数、返回体积和副作用上差异很大。与其每次让模型重新规划，不如把经过验证的推荐路径写下来。

**Skill 就是这个"有人告诉你怎么做"的层。**

---

## 什么是 Skill？

在我使用的 WorkBuddy/Codex 类 Agent 环境里，Skill 是一组以 **Markdown 指令文件**为入口的工作流约定。它不是 MCP 协议的一部分，不同 Agent 产品的加载、匹配和执行方式也可能不同。这里的 Skill 包含：

- **名字和描述**：Agent 进行候选 Skill 匹配的重要依据
- **触发语列表**：用户的哪些说法应该激活这个 Skill
- **工具链**：按什么顺序、调哪些 MCP 工具、传什么参数
- **响应模板**：拿到 JSON 后怎么用自然语言呈现
- **边界处理**：搜不到怎么办、数据太少怎么办、匹配到多个怎么办

Agent 载入 Skill 后，可以先匹配场景，再参考预设链路选择工具。Skill 是强提示和操作手册，不是不可绕过的状态机；模型仍可能偏离步骤，运行时校验依然必要。

![Skills 架构图](/images/viewpoint_miner/skills-architecture.svg)

核心思路一句话：**Skill 把开放式工具选择缩小为场景匹配 + 推荐路径。** 它能降低选择成本，但不能保证工具链永远不出错；参数、权限、外部服务和模型执行都可能失败。

---

## 五个 Skill 的设计拆解

Viewpoint Miner 项目里有 5 个 Skill，每个 Skill 对应一类用户意图，有自己的工具链和边界策略。

### Skill 1：stock-analyst（股票分析师）

**触发语**：分析 XX 股票、XX 有什么信号、XX 最近怎么样了、帮我看看 XX

这是最常用的 Skill。工具链看起来简单，但每个选择都有原因：

```
1. search_stocks(q="北方稀土")     → stock_id = 10
2. summarize_stock_signals(10)      → { dominant_direction, buy/sell counts, recent_5 }
3. [可选] build_stock_context(10)  → 更丰富的上下文包
4. [可选] get_latest_trade_signals(10, limit=20) → 更多信号历史
```

为什么第 2 步选 `summarize_stock_signals` 而不是 `get_stock_viewpoints`？

`get_stock_viewpoints` 返回的是原始观点全文——LLM 虽然够聪明，自己能筛，但它不省钱啊！`summarize_stock_signals` 在服务端做了聚合：统计买卖比例、计算 dominant_direction、只返回最近 5 条信号的摘要。**LLM 拿到的是"消化好的信息"而不是"原始食材"。**

Skill 文件还规定了响应格式：

```
{股票名}({代码})：共 {N} 条有效信号，{偏多/偏空/中性}

买入类 {B} 条，卖出类 {S} 条，观察类 {W} 条

最近信号：
- {日期} {作者}：{动作} @ {价格}（{内容节选}）
```

这不是为了束缚表达，而是提高输出信息密度的一致性。模板能提醒模型包含价格、作者等字段，但仍需校验，不能保证模型绝不遗漏或过度展开。

**边界处理**同样重要——Skill 明确写了三种情况：

- **股票搜不到**：提示用户试试代码（如 "600111"）
- **没有信号**：报告"暂无有效交易信号"，解释可能是关注度低或置信度过滤
- **匹配到多个**：列出候选项，让用户选

这些边界策略如果不写进 Skill，LLM 就要自己临场发挥——结果不可控。

另外还有一个细节：如果 summarize_stock_signals返回空数组，Skill 会自动降级为 get_stock_viewpoints(limit=10)，并提示用户"信号置信度不足，已展示近期观点供参考"。这叫**容错设计**——Skill 不只是告诉 LLM 走哪条路，还告诉它"这条路断了怎么绕"。

---

### Skill 2：author-analyst（作者分析师）

**触发语**：分析 XX 的操作风格、XX 最近在看什么、XX 是什么风格、XX 擅长什么

这个 Skill 的核心价值在于**帮 LLM 做它不擅长的事：统计推断**。

```
1. list_authors / get_author_summary  → 定位作者
2. summarize_author_style(author_id)  → 风格指标 + 覆盖股票 + 常见操作
```

第 2 步返回的数据里有一个关键字段：`avg_actions_per_stock`。这是服务端预计算的——每个作者在每只股票上的平均操作次数。Skill 把它翻译成 LLM 能直接用的判断规则：

```
avg_actions_per_stock >= 2.5  →  标记为偏高频，作为短线倾向线索
avg_actions_per_stock < 2.5   →  标记为偏低频，作为波段倾向线索
```

如果这个判断逻辑不在 Skill 里，LLM 拿到 `avg_actions_per_stock: 3.2` 后没有解释基准。需要注意，2.5 是项目启发式阈值，不是金融领域定理；它应该根据作者样本分布和人工标注校准，也不能仅凭操作次数推断真实持仓周期。

这是 Skill 设计中的一个重要模式：**把领域知识的解读规则写进 Skill，而不是期望 LLM 自己推断。**

---

### Skill 3：signal-scanner（信号扫描器）

**触发语**：信号总览、最近有什么交易信号、市场信号概况、所有关注股票的情况

这个 Skill 比较特殊——它是唯一一个**同时使用 HTTP API 和 MCP 工具**的 Skill。

```
方案 A（常规）：
  1. GET /api/dashboard/signals          → 全局信号统计
  2. GET /api/dashboard/recent-signals   → 最近高置信度信号
  3. GET /api/dashboard/author-stats     → 作者排名

方案 B（针对性搜索）：
  1. search_trade_signals(q="加仓")      → 按关键词搜信号
```

为什么搞两套方案？因为"信号总览"有两种不同的用户心理：

- **Option A** 对应"我想看看全局"——需要全量统计、排名、分布。Dashboard HTTP API 是一次查询返回所有关注股票的聚合数据，比 LLM 逐个调 `summarize_stock_signals` 高效得多。
- **Option B** 对应"XX 方向有什么"——针对性的关键词搜索，LLM 只需要调一个 MCP 工具。

这里有个设计细节值得注意：Skill 明确写了 **"Server not running → fall back to MCP tools"**。当提供 Dashboard API 的信号扫描服务未启动导致请求失败时，Skill 指示 LLM 退而用 `list_stocks` + 逐个 `summarize_stock_signals`。这种**降级策略**如果不写在 Skill 里，LLM 大概率会因为 HTTP 失败直接报错。

---

### Skill 4：semantic-searcher（语义搜索）

**触发语**：搜索关于 XX 的观点、有没有人提到 XX、XX 话题有什么观点

前三个 Skill 都是结构化查询（按股票、作者、信号类型），但用户的很多问题是开放式的。语义搜索 Skill 把 RAG 管道封装成了一个 Step-by-step 的工作流：

```
1. semantic_search_viewpoints(query="北向资金流入") → 余弦相似度 Top-K
2. [可选] build_semantic_context(query, stock_id)   → 结构化+RAG混合上下文
3. [健康检查] get_semantic_stats                    → 索引覆盖率和内存占用
```

Skill 还给出了**何时该用语义搜索、何时不该用**的判断指引：

> 语义搜索擅长：主题探索、趋势检测、跨股票分析、关键词搜索无结果时的兜底  
> 语义搜索不擅长：精确的股票/代码查询（直接用 `search_stocks` 更快）

这个区分很重要。没有它，LLM 可能对"分析茅台"这种精确查询也用语义搜索——慢、消耗 embedding 计算、结果还不一定准。

---

### Skill 5：harness-automation（自动化通知）

**触发语**：推送今日摘要、发送信号提醒、测试通知渠道、查看通知历史

这个 Skill 处理的不是"查询"，而是"推送链路"。它的工具链串起了第 2 篇讲的整个通知架构：

```
1. get_daily_digest            → 今日信号摘要
2. get_signal_changes(since)   → 新增信号变化
3. send_test_notification(ch)  → 推送到指定渠道
   └─ 经过护栏：静默时段检查 / 频率限制 / 冷却期 / 置信度阈值
```

注意第 3 步的注释——"经过护栏"。Skill 不需要告诉 LLM 护栏的具体逻辑（那些在 `guardrails.js` 里），但需要让 LLM **知道护栏存在**。这样 LLM 在推送失败时不会困惑——它知道可能是静默时段或频率限制导致的。

这个 Skill 还展示了一个设计细节：**渠道表格**。

| 渠道 | 状态 | 说明 |
|------|------|------|
| console | 默认启用 | 输出到控制台日志 |
| wechatmp | 占位实现 | 当前只写日志并输出到 console，不代表已完成微信推送 |
| dingtalk | 需配置 Webhook | 钉钉群机器人 |
| feishu | 需配置 Webhook | 飞书机器人 |

渠道的状态信息写在 Skill 里而不是代码里，因为它是**配置层面的知识**——LLM 需要知道哪些渠道可以立即用，哪些需要用户先配 Webhook。

---

## Skill 设计的五个原则

做了这五个 Skill 之后，我总结出几条规律：

### 1. 触发语决定覆盖率，不是精确度

触发语不需要穷举用户的每一种说法。`"分析 XX 的操作风格"` 覆盖了 `"XX 的风格是什么"`、`"XX 最近在做什么"`、`"XX 擅长什么"` 等变体。LLM 做的是**语义匹配**，不是正则匹配。

关键是触发语要覆盖**意图类别**，而不是具体措辞。五个 Skill 覆盖当前最常见的五种意图：个股分析、作者分析、全局扫描、主题搜索和推送操作。新需求出现后仍需要扩展或调整边界。

### 2. 工具链写"推荐路径"，不是"所有路径"

stock-analyst 的工具链是 `search_stocks → summarize_stock_signals`，只有 2 步。但实际上 LLM 还可以走 `get_stock_viewpoints`、`get_trade_actions`、`build_stock_context`。为什么 Skill 不把所有可能的工具都列上？

因为 LLM 的困难不只是"不知道有哪些工具"，还包括"不知道哪个组合更便宜、更稳定"。Skill 提供的是**推荐路径**。深水区工具（如 `build_stock_context`）放在 "Deep dive (optional)" 里作为可选项，是否有效需要通过实际调用日志验证，不能用"成功率基本 100%"代替数据。

### 3. 边界处理写进 Skill，LLM 不需要临场发挥

每个 Skill 都有 "Edge Cases" 章节，目的是让 Agent 在常见异常下优先采用预期处理方式。它能提高一致性，但最终行为仍受工具返回值和模型执行影响。

比如 semantic-searcher 的边界处理写了三条：
- 无结果 → 建议降低 min_score 或换关键词
- 索引为空 → 引导用户先 build embeddings
- 置信度都低 → 建议降级到关键词搜索

如果没有这些，LLM 在搜索无结果时可能给出没有证据的猜测。Skill 把常见异常映射到可操作建议，但错误类型仍应由工具返回结构化状态，而不是让模型仅凭自然语言错误消息推断。

### 4. references/ 子目录：避免 SKILL.md 变成工具文档

每个 Skill 目录下都有一个 `references/mcp-tools.md`，包含该 Skill 用到的工具的完整参数表。SKILL.md 本身只引用工具名，参数细节放在 references 里。

这个分离的价值在于：SKILL.md 保持简洁，聚焦于**工作流和决策逻辑**；参数细节放在 references。是否按需加载取决于 Agent 产品的 Skill 实现，不能假设所有运行时都会自动渐进读取。

### 5. 用 badcase 回归，而不是不断堆触发词

自然语言意图一定会重叠，例如"XX 最近怎么样"可能指股票，也可能指作者；"推送信号"同时包含"推送"和"信号"。遇到误路由时，不能只往 description 里继续堆关键词。

我会把每个 badcase 记录成最小评测集：用户输入、期望 Skill、实际 Skill、是否应该澄清。修改 Skill 后重新运行这些样例，至少观察命中率、混淆对和多余工具调用次数。没有回归集时，只能说"这次看起来选对了"，不能证明路由质量提高。

---

## 对比：有 Skill 和没有 Skill 的差异

假设用户说"北方稀土最近信号怎么样"。

**没有 Skill**，LLM 的行为：
1. 扫描 27 个工具名和描述
2. 选 `get_stock_viewpoints(stock_id=10)` —— 返回 363 条全文，消耗大量 token
3. 自己从 363 条中数买卖信号、判断偏向
4. 可能遗漏 `summarize_stock_signals` —— 因为工具名里的 "summarize" 和用户说的"信号怎么样"语义匹配不够强

**有 Skill**，LLM 的行为：
1. 匹配 stock-analyst 的触发语
2. 执行 `search_stocks → summarize_stock_signals`
3. 拿到预聚合的 JSON：dominant_direction="偏空"，buy=6，sell=7
4. 按响应模板组织：股票名、信号统计、最近信号列表

区别在于：**LLM 的决策从完全开放的选择题变成了带推荐步骤的操作题**。它仍要填参数、处理错误，并可能在信息不足时请求澄清。

---

## Skill 与 MCP 的关系：不是替代，是互补

有一个常见的误解：有了 Skill 是不是就不需要那么多 MCP 工具了？

不是。Skill 是 MCP 工具的**使用者**，不是替代者。Skill 做的是**编排和封装**，MCP 工具做的是**原子能力**。

正确的分层关系是：

```
用户意图 → Skill 匹配 → 工具链预设 → MCP 工具执行 → 数据返回 → 响应模板 → 自然语言输出
```

Skill 没有减少 MCP 工具的数量——27 个工具一个没少。Skill 减少的是 LLM 的**选择成本**。当用户说"分析北方稀土"时，LLM 不再面对 27 个工具平铺的菜单，而是直接拿到一张"按 1-2-3 步走"的说明书。

这引出一个架构权衡：底层查询可以保持高内聚，但高频且确定的多步计算适合封装为聚合工具，例如 `summarize_stock_signals`。Skill 负责跨工具、带判断的工作流。不要把"原子工具"当成教条，否则模型需要更多轮调用，也会增加失败面和 token 消耗。

---

看一下走 stock-analyst 链路的效果：

![Skill 生效示意](/images/viewpoint_miner/skill-stock-analyst-demo.png)

## 小结

这篇文章讲了 MCP 之上的一层抽象——Skill：

1. **Skill 的本质**：当前 Agent 产品中的 Markdown 工作流约定，告诉模型"这个场景下优先怎么做"
2. **五个 Skill**：stock-analyst（个股分析）、author-analyst（风格判断）、signal-scanner（全局扫描）、semantic-searcher（主题搜索）、harness-automation（推送链路）
3. **设计原则**：触发语覆盖意图类别；工具链写推荐路径；边界处理映射到可操作建议；用 badcase 回归验证修改
4. **Skill vs MCP**：Skill 编排，MCP 执行——不是替代关系，是分层互补

但到这里，工具底层对观点内容的检索仍以关键词和结构化字段为主。"减仓"能精确查询，"北向资金流出"与"外资撤离"这类语义近似表达却难以召回。下一篇会引入 RAG 语义搜索补上这一层。

---
