---
title: "DeerFlow 实践（四）：从可观测到可治理——Langfuse + 治理中心的双引擎设计"
date: 2026-08-05
category: ai
tags: ["DeerFlow", "Agent", "Langfuse", "LangGraph", "RBAC", "Human-in-the-loop", "可观测性", "治理"]
description: "三个 Agent 做完了，一个问题越来越明显：**专用 Agent 可以在自己的工作流里增加校验和人工确认，但平台仍然需要一套跨 Agent 的统一治理能力。**  只接 Langfuse 并不能解决..."
---



三个 Agent 做完了，一个问题越来越明显：**专用 Agent 可以在自己的工作流里增加校验和人工确认，但平台仍然需要一套跨 Agent 的统一治理能力。**

只接 Langfuse 并不能解决这个问题。Trace 可以告诉我模型调用了什么、工具耗时多久、哪一步失败，却不能回答：这个身份原本有没有权使用该工具？高风险调用是否经过人工审批？审批结果是否被可信地恢复到原工作流？

因此，我给 DeerFlow 增加了两套职责互补的系统：

- **治理中心**是决策与证据引擎，负责 RBAC、Guardrail、审批、恢复和 append-only 审计；
- **Langfuse**是运行分析引擎，负责把模型、工具与脱敏后的治理事件组织为同一条可查询 Trace。

它们不是主备关系。治理中心决定“能不能执行”，Langfuse 解释“整条链路发生了什么”。这篇文章记录的，就是 DeerFlow 从 Agent 可观测走向最小治理闭环的过程。

<!--more-->

## 1. 可观测不等于可治理

普通 Agent Trace 主要回答三类问题：模型收到了什么、调用了哪些工具、每一步用了多长时间。这对调试和性能分析很重要，但它观察的是**已经发生或正在发生的行为**。

治理面对的是另一组问题：

- 这个身份是否有权看到并调用该工具？
- 已经有权限的高风险操作，是否还需要人承担决策责任？
- 决策之后，恢复执行使用的授权是否仍然有效？
- 谁在何时依据什么策略作出了什么决定？
- 即使线程被删除，证据是否仍然存在？

因此，RBAC、审批和审计必须分开建模：

| 能力 | 核心问题 | 结果 |
|---|---|---|
| RBAC | 这个身份是否有权使用该工具？ | allow / deny |
| 审批 | 已有权限，但这次操作是否需要人工确认？ | approve / reject / expire |
| 审计 | 谁在何时依据什么策略做了什么，结果如何？ | 不可变事件 |
| Langfuse | 模型、工具与治理事件如何组成一条运行链路？ | Trace / Span / Score |

这里最重要的边界是：**审批不能覆盖 RBAC 拒绝。**“无权操作”和“有权但风险较高”不是一个问题。如果 RBAC deny 可以通过找人审批变成 allow，权限硬边界就被错误降级成了普通工作流节点。

## 2. 双引擎总体架构

整条执行链以 Gateway 注入的可信 Principal 为起点。模型只能在 RBAC 过滤后的工具空间中规划；实际工具调用还要依次经过 RBAC、Guardrail 和审批策略。

[![DeerFlow 治理中心与 Langfuse 双引擎总体架构](/images/ai/deer-flow-langfuse-governance-dual-engine.svg)](/images/ai/deer-flow-langfuse-governance-dual-engine.svg)

这张图包含两个不同方向的数据流：

1. **控制流**必须经过治理中心，任何 Langfuse 故障都不能改变 RBAC、审批 CAS、超时拒绝或工作流恢复结果；
2. **观测流**在治理事件持久化成功后投影到 Langfuse，用于分析而不参与授权。

我把设计原则归纳为六句话：**权限最小化、风险显式化、恢复可信化、决策幂等化、证据不可变、敏感数据最少化。**

## 3. RBAC：在模型看见前和工具执行前各拦一次

DeerFlow 当前实现的是工具级 RBAC，覆盖 Lead Agent、原生 Subagent 和 `DeerFlowClient`。它不是在工具执行前临时加一个判断，而是同时作用在两个层面。

### 3.1 第一层：过滤模型可见的工具空间

Agent 构建时，RBAC 会在 deferred catalog 组装前过滤工具 Schema。被拒绝的工具不会进入模型上下文，也不会被 `tool_search` 重新发现。

这层解决的是“模型不应规划自己无权执行的能力”。如果只在执行时拒绝，模型仍可能围绕一个不可用工具反复计划、调用和纠错，既浪费 Token，也会把权限边界暴露成运行时试错。

### 3.2 第二层：执行时重新鉴权

模型产生 Tool Call 后，系统使用同一个 Provider 和 Principal 再检查一次。这样可以覆盖运行期间身份、角色或策略变化，也能防止调用路径绕过可见性过滤。

两层必须复用同一套身份解释和策略 Provider，否则会出现“模型看得见但执行不了”或“模型看不见但动态路径能执行”的漂移。

固定执行顺序是：

```text
RBAC → Guardrail → Approval → Tool
```

RBAC 和 Guardrail deny 都返回受控 `ToolMessage`，而不是把异常直接抛回模型。相关安全事件会进入运行级收集器，并在 Run 收尾时写入审计。

## 4. 审批：治理“有权但高风险”的调用

审批规则可以按工具、角色、Agent、参数、成本和目标域名匹配：

- 单条规则内部是 AND，多条规则之间是 OR；
- 多条规则同时命中时合并成一次审批，取最高风险等级和最短 TTL；
- 参数缺失、类型不匹配、正则异常、成本不是有限数或 URL 无法解析时，不直接放行；
- 无法确定的条件被标记为 `condition_indeterminate=true`，并进入人工审批。

最后一条是典型的 fail-restrictive 设计。对于高风险动作，“无法判断”不能等同于“没有命中”。

### 4.1 统一的审批契约

工具调用、Evidence Auditor 的工作流复核和 Marketing Strategy 的提交审批都使用 `human_input_request` v1，并携带统一治理元数据：

```text
GovernanceMetadata {
  request_type: tool_call | workflow_review | submission
  risk_level: low | medium | high | critical
  default_reject_option_id
  policy_ids[]
  policy_sha256
  expires_at
  arguments_preview
  arguments_sha256
  condition_indeterminate
}
```

`arguments_preview` 只用于治理中心向审批人展示经过脱敏和截断的参数；真正用于授权关联的是规范化参数的 SHA-256。策略本身也会生成 `policy_sha256`。

工具审批请求 ID 同时绑定线程、Tool Call、参数哈希和策略哈希。参数或策略变化后，旧请求和旧 Grant 都不能继续匹配。

### 4.2 决策状态和恢复状态必须分开

审批记录同时保存两个状态维度：

```text
ApprovalStatus = pending | decided | expired | cancelled

ResumeStatus =
  waiting | pending | dispatching | dispatched | failed | cancelled
```

这不是字段拆分上的洁癖，而是在表达两个不同事实：

> **用户已经批准，不等于工作流已经成功恢复。**

只有把两种状态分开，系统才能区分“审批仍在等待”“已经决定但尚未派发”“恢复任务正在抢占”“恢复派发失败”和“已成功创建恢复 Run”。

## 5. 可信恢复：批准之后仍然不能直接执行

LangGraph `interrupt()` 会把审批请求保存在 checkpoint 中。Run 进入 `interrupted` 后，`GovernanceInterruptProjector` 扫描持久化 interrupt，为每个请求幂等创建 `pending` 审批，并写入 `approval.created` 审计事件。IM 渠道只发送只读通知，真正的决策仍在 Web 治理中心完成。

### 5.1 决策必须使用数据库 CAS

用户或管理员提交决定时，Repository 只允许：

```text
status = pending → status = decided
```

相同决定可以幂等返回，冲突决定不能覆盖先到结果。这样两个审批人同时操作时，不会发生“后一次点击悄悄改写前一次责任认定”。

### 5.2 并行 Interrupt 必须一次精确恢复

同一 checkpoint 可能同时产生多个 interrupt。系统不会用一个响应统一覆盖，而是等待该 Run 的所有审批都进入终态，再按 `interrupt_id` 构造映射：

```python
resume_values = {
    approval["interrupt_id"]: human_input_response,
    # ...
}

Command(resume=resume_values)
```

恢复批次先进入 `dispatching`，成功创建恢复 Run 后才标记为 `dispatched`，避免并发请求重复执行工具。

### 5.3 Grant 只能由服务端注入

Gateway 会清除公共请求中的 `gateway_managed` 和 `governance_grants`。只有治理服务内部创建恢复 Run 时，才能把审批结果转换为 Grant：

```text
governance_grants[request_id] = {
  option_id,
  arguments_sha256,
  decided_by
}
```

恢复后的工具节点仍会重新执行 `RBAC → Guardrail → Approval`。`ToolApprovalMiddleware` 只有在 request ID 和参数哈希都匹配时才接受 Grant；参数变化、策略变化或 Grant 缺失都会重新中断或拒绝。

因此，客户端无法通过伪造 `Command(resume=...)` 绕过审批，用户的一次 approve 也不是一张可以反复使用的通行证。

### 5.4 过期也必须恢复工作流

TTL 到期后，系统会自动采用请求声明的 `default_reject_option_id`，写入 `approval.expired`，再以明确的拒绝响应恢复原图。

如果只把数据库状态改成 expired，却不继续恢复 checkpoint，工作流会永久挂起。**超时拒绝是一种明确决策，不是“不处理”。**

## 6. Append-only 审计：把治理事实留在 Langfuse 之外

审批表保存当前状态，审计表保存状态如何变化。审批生命周期事件直接写入审计；RBAC、Guardrail、Provider 异常和恢复 Run 中的 Grant 决策，则由运行级收集器汇总写入。

审计默认只保存分析和追责需要的最小信息：

- actor、owner、role、thread、run 和 approval 归属；
- action、target、outcome、policy ID 和 reason code；
- 风险等级、参数哈希、等待时长等受控元数据；
- 不保存 Prompt、模型上下文、原始工具参数、Token、API Key 或 Secret。

普通 allow 事件默认不记录，避免高容量噪声；需要更严格的部署可以通过配置开启。

审计记录也不与线程做级联删除。删除会话时可以取消仍在等待的审批，但不能让“删会话”变成“删证据”。

当前 append-only 主要由 Repository 接口和应用路径保证。严格合规环境还应增加数据库角色限制、归档、签名链或 WORM 存储，这部分属于后续强化边界。

## 7. Langfuse 联动点：先把一次 Run 准确找回来

DeerFlow 已经在 Graph 根调用处挂载 Langfuse Callback，因此 LangGraph 节点、模型和工具会自动形成 observations。每次 Run 同时注入以下关联字段：

| Langfuse / Metadata 字段 | DeerFlow 来源 |
|---|---|
| `langfuse_session_id` | `thread_id` |
| `langfuse_user_id` | Gateway 解析后的有效 `user_id` |
| `langfuse_trace_name` | `assistant_id`，默认 `lead-agent` |
| `langfuse_tags` | model / environment |
| `deerflow_run_id` | 服务端 `RunRecord.run_id` |
| `deerflow_thread_id` | LangGraph thread ID |
| `deerflow_assistant_id` | Agent ID |
| `deerflow_trace_id` | 可选的 HTTP / 日志请求关联 ID |

其中最容易混淆的是三个 ID：

- `deerflow_run_id` 标识一次 Agent Run，是 Insights 与治理投影的核心关联字段；
- `deerflow_trace_id` 用于串联 HTTP Header、日志和 Langfuse 元数据，不是 Langfuse 原生 Trace ID；
- Langfuse 原生 Trace ID 使用 Run ID 确定性生成。

```python
trace_id = langfuse.create_trace_id(
    seed=f"deerflow-run:{run_id}"
)
```

确定性 Trace ID 很关键。审批决定可能在几分钟甚至几小时后由另一个 HTTP 请求产生，此时已经没有原请求的 OpenTelemetry Context。只要审计事件保存了 Run ID，异步投影仍然能回到原始 Trace。

## 8. 治理专用 Span / Score

通用 Agent Trace 主要回答“模型和工具做了什么”，治理观测需要回答另一组问题：

- 为什么这个操作被拦截？
- 命中了哪条策略？
- 谁作出了审批决定？
- 审批等待了多久？
- 恢复是否成功派发？
- 恢复执行时使用的 Grant 是否仍然有效？

因此，治理事件不能只作为普通日志附着在 Tool Span 上。DeerFlow 会把已经持久化的治理审计事件投影成独立 observation，并创建可聚合 Score。

### 8.1 写入顺序：数据库是事实源

写入顺序固定为：

```text
治理事件发生
    ↓
append-only 审计写入成功
    ↓
best-effort 投影到 Langfuse
    ↓
投影失败只记录告警，不回滚治理结果
```

对应实现可以概括为：

```python
audit_row = await audit_repository.append(event)

try:
    project_to_langfuse(audit_row)
except Exception:
    logger.warning("governance telemetry projection failed")
```

Langfuse 是脱敏后的可观测投影，不是审批 API 的同步依赖，更不是合规台账。它发生故障时，RBAC、审批 CAS、过期拒绝和工作流恢复结果都不能改变。

### 8.2 Trace 归属：原始 Run 与恢复 Run 各自证明什么

每个 governance observation 都携带：

```json
{
  "deerflow_run_id": "run-id",
  "thread_id": "thread-id",
  "approval_id": "approval-id",
  "audit_event_id": "audit-event-id",
  "actor_role": "admin"
}
```

一次审批恢复通常涉及两个 Run：



![Mermaid 图表](/images/mermaid/mermaid-00e664d5-0.svg)



原始 Run 描述审批的完整生命周期；恢复 Run 证明工具重放时重新验证了服务端 Grant。只有把两条 Trace 关联起来，才能区分“用户点了批准”和“工具最终获得有效授权并执行”。

### 8.3 Span 命名与 observation 类型

治理 observation 统一命名为：

```text
governance.<audit_event_type>
```

典型节点包括：

| Observation | 含义 |
|---|---|
| `governance.approval.created` | 策略命中并创建审批 |
| `governance.approval.notification` | 审批通知进入发送队列 |
| `governance.approval.decided` | 用户或管理员完成决策 |
| `governance.approval.expired` | TTL 到期并采用默认拒绝 |
| `governance.approval.cancelled` | 审批被取消 |
| `governance.approval.resumed` | 恢复 Run 已派发 |
| `governance.approval.tool_decision` | 恢复执行时 Grant 验证结果 |
| `governance.rbac.execution` | 工具执行前的 RBAC 结果 |
| `governance.rbac.provider_error` | RBAC Provider 异常 |
| `governance.guardrail.execution` | Guardrail 执行结果 |

RBAC、Guardrail 和最终工具授权使用 Langfuse `guardrail` observation 类型；审批创建、决策、通知、过期和恢复使用普通 `span`。

### 8.4 Span 只投影最小必要内容

一个治理 Span 的结构类似：

```json
{
  "input": {
    "action": "approve_tool_call",
    "target": "web_search",
    "resource_type": "tool"
  },
  "output": {
    "outcome": "approved",
    "policy_ids": ["governance-smoke-test"],
    "reason_codes": [],
    "details": {
      "risk_level": "high",
      "arguments_sha256": "...",
      "tool_call_id": "call-id"
    }
  }
}
```

不同事件只携带与自己有关的字段。例如 `approval.decided` 会投影 `option_id` 和 `wait_ms`，`approval.tool_decision` 则携带风险等级、Tool Call ID 与参数哈希，不会为了让数据看起来完整而复制其他事件的内容。

Langfuse 投影明确排除：

- Prompt 和模型上下文；
- 原始工具参数及参数预览；
- 审批备注；
- Token、API Key 和 Secret；
- 可能携带凭据的原始错误响应。

参数关联只保留规范化 SHA-256。这样既能判断恢复时参数是否发生变化，也不会把敏感值复制到另一个系统。

### 8.5 Score：把事件变成可聚合指标

Span 负责记录事件，Score 负责提供可聚合的治理指标。当前实现的映射包括：

| 审计事件 | Score | 类型 | 示例 |
|---|---|---|---|
| `approval.created` | `governance.approval_required` | Boolean | `1` |
| `approval.created` | `governance.risk` | Categorical | `high` |
| `approval.decided` | `governance.decision` | Categorical | `approved` |
| `approval.decided` | `governance.wait_ms` | Numeric | `25508` |
| `approval.expired` | `governance.decision` | Categorical | `expired` |
| `approval.resumed` | `governance.resume_dispatched` | Boolean | `1` |
| `approval.tool_decision` | `governance.grant_decision` | Categorical | `approved` |
| `rbac.execution` | `governance.rbac_allowed` | Boolean | `0` / `1` |
| `rbac.provider_error` | `governance.rbac_provider_healthy` | Boolean | `0` |
| `guardrail.execution` | `governance.guardrail_allowed` | Boolean | `0` / `1` |

Score ID 由审计事件 ID 和 Score 名称确定性生成：

```python
score_id = uuid5(
    NAMESPACE_URL,
    f"deerflow-governance:{audit_event_id}:{score_name}",
)
```

同一审计事件重试投影时会命中同一个 Score ID，不会制造重复指标。

### 8.6 一次批准需要四组证据

一次 approve 在 Langfuse 中不是单一字段，而是四组相互印证的证据：

```text
governance.approval.created
  score: approval_required = true
  score: risk = high

governance.approval.decided
  output.outcome = approved
  score: decision = approved
  score: wait_ms = 25508

governance.approval.resumed
  output.outcome = dispatched
  score: resume_dispatched = true

governance.approval.tool_decision
  output.outcome = approved
  score: grant_decision = approved
```

这四组证据分别证明：请求确实需要审批、用户作出了批准、Gateway 成功派发恢复 Run、恢复执行接受了匹配的服务端 Grant。

只有 `decision=approved`，不能证明治理闭环已经完成，更不能证明工具最终执行成功。工具结果仍应回到恢复 Run 的 Tool Observation 中核对。

## 9. Insights 如何读回一条完整治理链

Langfuse v2 的子 observation 不一定重复根 Trace 的 `userId`。如果在所有 observation 查询中直接加入 `userId`，往往只能得到根 Agent 节点，工具、中间件和治理 Span 会被隐藏。

因此，Agent Insights 使用两阶段查询：

```text
1. userId + 时间窗口
   → 找到当前用户拥有、且 deerflow_run_id 匹配的根 observation

2. traceId
   → 加载该 Trace 的全部子 observation

3. deerflow_run_id
   → 再次做精确 Run 过滤
```

第一阶段建立所有者边界，第二阶段恢复完整 Trace，第三阶段防止同一 Session 中其他 Run 混入。

另一个容易误判的字段是 `statusMessage`。治理节点可能携带：

```text
statusMessage = "approved"
```

它只是状态说明，不代表错误。Insights 只有在 Langfuse 明确返回 `level=ERROR` 时才把节点标记为失败，避免“审批通过”在运行图里显示成红色异常。

## 10. 双引擎能形成哪些治理指标

有了治理 Score，可以直接围绕 Run、工具、策略和风险等级聚合：

- 不同工具的审批触发率；
- 高风险审批占比；
- 批准、拒绝、取消和过期分布；
- P50 / P95 审批等待时间；
- RBAC 拒绝率和 Provider 健康度；
- 批准后恢复派发成功率；
- Grant 验证失败率；
- 不同策略 ID 的触发趋势。

Langfuse 由此不再只展示模型 Token 和工具耗时，而能承担治理系统的运行分析界面。但合规调查、权限认定和事件追责仍然必须查询 append-only 审计数据库。

两套引擎的职责可以归纳为：

| 场景 | 权威来源 |
|---|---|
| 是否允许执行 | RBAC / Guardrail / Approval Runtime |
| 审批当前状态 | 治理审批表 |
| 谁在何时作出什么决定 | append-only 审计表 |
| 模型、工具和治理事件的时序 | Langfuse Trace |
| 延迟、拒绝率和风险趋势 | Langfuse Score / Insights |

## 11. 为什么这只是“最小治理闭环”

这套系统至少覆盖了一次高风险动作的完整生命周期：

```text
身份识别
→ 策略判断
→ 执行前阻断
→ 人工决策
→ 可信恢复
→ 再次校验
→ 执行或拒绝
→ 持久化证据
→ 可查询与可观测
```

普通工具拦截器往往只能回答“这次调用是否阻止”，缺少持久化审批箱、跨进程恢复、所有者隔离、管理员代办、TTL、冲突决策、多 interrupt 精确恢复、防伪造 Grant 和线程生命周期之外的审计证据。

之所以仍称为“最小”，是因为当前 RBAC 只治理工具，还没有覆盖模型、Skill、Sandbox、MCP Server 和普通 API 权限。

## 12. 实现过程中最容易踩的坑

### 12.1 工具可见性和执行授权必须使用同一边界

工具过滤必须发生在 deferred catalog 组装前，否则 `tool_search` 可能重新暴露被拒工具。两层 RBAC 必须复用同一个 Provider 和 Principal，审批也不能覆盖 deny。

### 12.2 不要相信客户端携带的治理上下文

Principal 必须来自 Gateway 认证上下文。客户端传入的 `user_role`、`is_internal`、`gateway_managed` 和 Grant 都不能成为授权依据。

### 12.3 哈希必须绑定参数和策略

参数哈希需要使用稳定 key 排序、固定分隔符和明确 Unicode 处理的规范化 JSON。参数预览只是给人看，不能参与授权判断；参数哈希和策略哈希变化都必须让旧 Grant 失效。

### 12.4 不要破坏等待中的 Checkpoint

LangGraph interrupt ID 与任务和 checkpoint 相关。等待审批期间如果为了更新标题等旁路信息写入 successor checkpoint，恢复映射可能彻底失效。并行 interrupt 也必须按 ID 收集全部响应后一次恢复。

### 12.5 幂等不只属于审批决定

审批决策需要 CAS，恢复批次也要有 `dispatching` 抢占状态，Langfuse Score 还要有确定性 ID。否则重复请求可能分别造成覆盖决定、重复工具执行和重复指标。

### 12.6 “非致命”不等于“绝不会丢”

当前运行期 RBAC / Guardrail 事件在 Run 的 `finally` 阶段批量、非致命写入。如果进程在收尾前崩溃，最后一批事件仍可能丢失。严格合规场景应升级为 transactional outbox。

### 12.7 本地可用不等于生产可靠

- memory backend 只适合本地开发，进程重启后审批、审计和恢复状态都会丢失；
- 多 Gateway 实例下，自动过期扫描需要 CAS、行锁或 `SKIP LOCKED`；
- append-only 还应在数据库权限层禁止 `UPDATE / DELETE`；
- Langfuse 投影失败目前只记录告警，生产环境可以增加 outbox、重试和积压监控。

## 13. 平台边界：当前能力与演进方向

至此，DeerFlow 已经完成了一个**最小但可验证的治理闭环**。它不是一堆功能的堆叠，而是对 Agent 执行路径的一次系统性约束：

- 在模型有机会规划之前，工具边界已经被 RBAC 收缩；
- 在执行真正发生之前，高风险动作已经被审批拦截；
- 在恢复执行之前，服务端 Grant 已经经过重新校验；
- 在整个生命周期结束后，证据仍然存在于审计表中，不受线程删除的影响。

这套机制已经足以支撑**单 Agent、单用户、工具级治理**的生产需求。换句话说，一个拥有真实工具的 Agent，现在可以被放进一个**需要审计、需要问责、不能随意执行**的环境中运行。

但它仍然有明显的边界。如果把 Agent 治理看作一个逐级上升的阶梯，那么当前实现处于**第二级**。

### 13.1 治理能力的五级演进

**第一级：可观测**  
能够看见模型在做什么——Token 消耗、工具调用、失败节点。这是 Langfuse 等可观测系统解决的问题，也是本文的前置条件。

**第二级：最小治理闭环（当前）**  
具备拦截、审批、可信恢复和不可变审计的能力。本文所记录的，正是这一级的完整设计与实现：从工具 Schema 过滤到 interrupt 精确恢复，再到脱敏后的治理 Score。

**第三级：全对象治理**  
将 RBAC 与审批的覆盖范围从“工具”扩展到模型、Skill、Sandbox、MCP Server 与普通 API。当前只有工具受到强管控，而 Agent 仍然可以切换模型、加载 Skill 或访问 Sandbox。这一级的完成，意味着 Agent 的**所有能力出口**都处于统一治理之下。

**第四级：强一致治理**  
用 transactional outbox 替代 Run 收尾时的非致命批量写入，在数据库层进一步强化 append-only（如禁止 UPDATE/DELETE、引入签名链或 WORM 存储）。这将把“观测可降级”升级为“观测不丢”，使治理系统在面对进程崩溃、网络分区或人为误操作时仍然保持事实一致性。

**第五级：结果导向治理**  
不只记录“是否被批准”，而是通过 `governance.execution_succeeded`、`governance.policy_indeterminate` 等指标，回答一个更关键的问题：**批准后是否真的产生了预期的业务结果？** 这一级标志着治理从“合规动作”走向“效果优化”，从“防坏事”走向“促好事”。

### 13.2 演进中的不变原则

需要强调的是，治理能力的增强往往伴随着系统复杂度的非线性上升。在向第三、第四级演进的过程中，必须守住一个基本原则：

> **观测永远不能拖慢治理，更不能成为执行路径上的同步依赖。**

这也是本文始终坚持将 Langfuse 作为**异步、脱敏、可降级的投影**，而非审批链路中的一环的原因。无论未来治理能力扩展到何种程度，这一事实源与观测源分离的架构都不会改变。

当前实现已经回答了“如何在一个 Run 内安全地完成一次高风险动作”的问题。接下来要回答的，是这个能力如何在多 Agent、多用户、多对象的复杂平台上持续成立，并且持续可解释。

## 小结

把 Langfuse 接进 Agent，只完成了“看见运行”的第一步。真正的治理，需要一条与观测流平行、但优先级更高的控制链：在模型看见工具前限制能力，在工具执行前重新鉴权，在高风险动作前暂停等待人工决策，在恢复执行时再次校验授权，并把每一次变化写成不可随会话删除的证据。

- **治理中心**作为决策与证据引擎，负责 RBAC、Guardrail、审批、恢复和审计，是所有执行路径上的硬边界；
- **Langfuse** 作为运行分析引擎，负责将模型、工具与脱敏后的治理事件组织为可查询的 Trace，是理解系统行为的窗口，而非授权依据；
- **双引擎**之间的关系被严格定义为：治理数据库保存事实，治理 Runtime 决定行动，Langfuse 解释运行。

这套双引擎设计不会让模型更聪明，但会让一个拥有真实工具的 Agent 更接近可以进入生产系统的工程组件。
