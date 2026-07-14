+++
date = '2026-06-13T20:30:00+08:00'
draft = false
title = '从股票观点系统到 Agent 应用（七）：Grounding、权限、循环与降级'
categories = ['AI 大模型']
tags = ['Agent', 'Grounding', '安全']
series = ['viewpoint_miner']
+++

> 前六篇完成了规则提取、MCP、Skills、RAG、Memory 和 Harness。最后一篇不再增加功能，而是回答一个更重要的问题：这些模块组合起来以后，怎样知道 Agent 的结果可信、行为可控、失败时不会悄悄给出错误答案？

<!--more-->

---

## 先定义边界：本地运行不等于线上系统

Viewpoint Miner 目前是本地个人项目。它有定时任务、通知和数据库，但没有经过生产流量、多人权限、SLA 或真实故障演练。因此这篇只讨论**代码审查中能验证的机制和缺口**。

对 Agent 可靠性的理解，可以拆成五个问题：

```text
回答有没有证据？      → Grounding 与引用
动作是否被允许？      → 权限、参数和副作用边界
任务是否持续推进？    → 循环检测与硬上限
依赖失败后会怎样？    → 故障隔离与显式降级
怎么知道改进有效？    → 分层评测与回归集
```

这五层分别约束生成、行动、运行和迭代，不能只靠一句 System Prompt 解决。

---

## 一、Grounding：有引用不等于有事实校验

RAG Chat 会先检索观点，再把作者、日期、股票、交易动作和原文片段一起放进上下文。回答返回时还会附带 `sources`：

```javascript
const sources = results.map((r, index) => ({
  index: index + 1,
  viewpointId: r.viewpointId,
  authorName: r.authorName,
  score: r.score,
}));
```

它解决的是**可追溯性**：用户可以回到原观点核对。但这里有三层不能混淆：

1. 检索命中，只说明向量相近，不说明材料正确或足以回答问题。
2. 展示来源，只说明回答旁边有引用，不说明每个结论都受到引用支持。
3. System Prompt 要求“不编造”，只能约束模型，不能提供确定性保证。

因此，“减少幻觉”更准确的工程目标是：降低无依据回答的概率，并让错误容易被发现。至少要分别评测：

| 环节 | 要观察什么 |
|------|------------|
| 检索 | Recall@K、无关结果比例、过滤条件是否正确 |
| 生成 | 回答中的主张是否能被引用片段支持 |
| 拒答 | 没有足够材料时，模型是否明确说不知道 |
| 展示 | 用户能否从来源 ID 打开原文并核对 |

交易信号提取使用规则引擎而不是 LLM，能把生成式错误转化为可复现的规则错误，但并不会消灭错误。否定、条件句、指代和“先卖后买”仍可能误判，所以置信度只是启发式过滤，不是事实概率。

---

## 二、权限边界：schema 只解决“参数长什么样”

MCP Server 使用 Zod 校验参数：

```javascript
server.tool('get_stock_viewpoints', '获取某只股票的观点', {
  stock_id: z.number().int().positive(),
  limit: z.number().int().positive().optional(),
});
```

这能拒绝负数 ID、错误类型和缺失字段，但不能回答：

- 当前用户是否有权调用这个工具？
- `sync_author_viewpoints` 是否允许访问外部接口并写库？
- `send_test_notification` 是否需要用户确认？
- 一段很长的 `analyze_trade_text` 是否会耗尽资源？

所以工具还要按副作用分级：

| 类型 | 示例 | 建议策略 |
|------|------|----------|
| 只读查询 | `search_stocks`、`get_stock_summary` | 可自动执行，限制返回数量 |
| 本地写入 | `extract_trade_actions`、`index_viewpoint_embedding` | 保证幂等和事务边界 |
| 外部访问 | `sync_author_viewpoints` | 超时、重试上限、来源白名单 |
| 外部通知 | `send_test_notification` | 显式确认、频率限制、审计日志 |

`trade_actions.status` 提供了 pending/confirmed/corrected/rejected 状态，但当前自动通知链路没有证明发送前强制过滤 `confirmed`。所以它只能称为“人工审核入口”，不能直接称为严格的 Human-in-the-Loop。若要做到未经确认不发送，查询条件、审核人和审核时间都要进入强制执行路径。

本地部署也需要说明信任边界。当前 HTTP API 没有鉴权，只适合绑定到可信本机环境；一旦监听到局域网或公网，就要增加认证、CSRF/来源控制，并避免把 webhook 明文暴露给非授权请求。

---

## 三、循环检测：批处理幂等不等于 Agent 防死循环

项目已经有几种批处理保护：

- 爬虫最多翻 200 页，并在 `nextBefore === before` 时停止。
- `(viewpoint_id, stock_id, action, price_low, price_high)` 唯一约束减少重复信号。
- `trade_extract_version` 只选择未处理或旧版本观点，并在事务中刷新结果。
- 通知按 `(stock_id, action)` 做 60 分钟冷却。

这些机制保护的是数据管道。它们不能阻止 Agent Client 连续调用同一个 MCP 工具。真正的工具循环检测应放在 Agent 运行时，同时观察调用和进度：

```javascript
const MAX_TOOL_STEPS = 12;
const MAX_SAME_CALL = 3;

const signature = `${toolName}:${canonicalJson(args)}`;
if (step >= MAX_TOOL_STEPS) stop('max_steps');
if (repeatedCount(signature) >= MAX_SAME_CALL && !stateAdvanced()) {
  stop('tool_loop_detected');
}
```

只比较工具名和参数也不够。轮询任务可能合理地重复调用同一工具，所以还要判断结果摘要、分页游标或任务状态是否推进。停止后应把原因告诉用户，而不是静默返回一个不完整答案。

当前 Viewpoint Miner 是 MCP Server，不包含外部 Agent Client 的推理循环。因此文章只能给出这一层的设计要求，不能声称项目已经实现 Agent 级循环检测。

---

## 四、降级：先隔离故障，再明确告诉用户

真实代码中已经有几处故障隔离：

- 单个作者同步失败后继续处理其他作者。
- embedding 初始化失败时跳过向量生成，保留结构化查询和规则提取。
- 钉钉或飞书发送失败会记录到 `notification_log`。
- LLM 摘要失败时降级为用户消息片段拼接。

但“没有崩溃”不等于“降级正确”。例如简单拼接摘要会丢掉助手结论和上下文关系，如果界面仍把它当成正常摘要，用户无法判断信息质量已经下降。

更完整的返回结构应该把状态带到调用端：

```javascript
return {
  text: fallbackSummary,
  degraded: true,
  reason: 'llm_unavailable',
  limitations: ['仅保留用户消息片段', '可能遗漏历史结论'],
};
```

同时要区分两类信息：用户看到影响范围和可操作建议，运维日志保留错误类型、堆栈和关联 ID。只给用户看堆栈不可用，只写一句“失败”也无法排障。

当前还有几个值得继续修的边界：

1. 用独立 `sync_runs` 记录同步成功时间，不能用最后一次通知时间代替。
2. 会话摘要增加 `summarized_through_message_id`，避免重复压缩同一批历史。
3. 观点优先使用上游消息 ID 去重，避免秒级 `rec_time` 冲突。
4. Python embedding 子进程增加健康检查、退出清理和受控重启。
5. SQLite 增加备份与迁移版本，不把 DELETE + INSERT 误称为“可回滚”。

---

## 五、评测：按链路分层，而不是只看最终回答

Agent 出错时，最终表现可能都是“回答不对”，根因却完全不同。最小评测矩阵应该覆盖：

| 层次 | 样例 | 指标或断言 |
|------|------|------------|
| 规则提取 | 否定、条件句、过去时、先卖后买 | precision/recall，动作与价格是否正确 |
| 检索 | 同义表达、无答案问题、股票过滤 | Recall@K、无关结果率 |
| Skill 路由 | 股票/作者歧义、推送/查询冲突 | 命中率、混淆对、澄清率 |
| 工具调用 | 缺参数、非法 ID、副作用工具 | 校验失败率、确认是否执行 |
| RAG 回答 | 有依据、依据不足、来源冲突 | 引用支持率、拒答率 |
| Harness | 静默时段、冷却、渠道失败 | 是否跳过、是否记录原因、是否误伤其他任务 |

当前项目已有 guardrails、context-budget 和 cron extraction 的回归测试，这是一个起点；规则提取、检索质量、Skill 路由和回答忠实度仍需要独立数据集。每次修 bug 都应该把触发它的输入加入回归集，否则相同问题很容易换一种形式回来。

---

## 小结：可靠性来自可验证的边界

这个系列最后得到的不是“给 LLM 接上几个工具就是 Agent”，而是一条更务实的学习路线：

1. 能用规则稳定解决的窄任务，先建立可测试基线。
2. 用 MCP 标准化工具边界，但把调用决策和权限留在 Agent 运行时。
3. 用 Skill 缩小规划空间，并用 badcase 回归验证路由。
4. 用 RAG 提供材料和来源，不把引用列表当成事实保证。
5. 用上下文预算管理检索、历史和输出空间，同时承认摘要会损失信息。
6. 用 Harness 管理调度、护栏和通知，但不把固定 cron 流程等同于 Agent。
7. 最后用权限、循环检测、显式降级和分层评测把整条链路约束起来。

可靠性不是一个模块，而是每一层都能回答三个问题：失败会怎样、用户是否知道、我们如何通过测试证明它已经修好。
