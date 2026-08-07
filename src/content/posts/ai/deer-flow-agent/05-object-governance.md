---
title: "DeerFlow 实践（五）：迈向全对象治理——Agent 版本、KB 与 A2UI"
date: 2026-08-05
category: ai
tags: ["DeerFlow", "Agent", "Agent Version", "Knowledge Base", "A2UI", "RBAC", "治理"]
description: "上一篇完成工具级最小治理闭环后，我原以为平台已经有了一条足够完整的安全链：模型只能看到 RBAC 允许的工具，高风险调用会进入审批，恢复执行还要重新验证 Grant，最后由治理数据库和 Langfus..."
---



上一篇完成工具级最小治理闭环后，我原以为平台已经有了一条足够完整的安全链：模型只能看到 RBAC 允许的工具，高风险调用会进入审批，恢复执行还要重新验证 Grant，最后由治理数据库和 Langfuse 分别保存事实、解释运行。

继续开发 Agent 版本、知识库和 A2UI 后，问题又向前走了一步：**工具只是 Agent 的“手”，只管住手，并不能解释一次行为的全部来源。**

- Agent 版本定义“谁在运行”；
- KB 决定“它读过什么”；
- A2UI 规定“它如何与人交互”；
- Tool 最终完成“它能够做什么”。

如果审批只绑定 Tool 名称和参数，就仍然回答不了几个关键问题：发起调用的 Agent 是否已经换了版本？它依据的知识在审批后是否发生变化？用户提交的结构化动作是否真的来自那张 A2UI 面板？

因此，这篇不再新增一个垂直 Agent，而是继续扩展 DeerFlow 平台本身：为 Agent 配置建立不可变版本，为知识建立 Collection 与 ACL，为交互建立受限 A2UI 协议，并尝试把三类对象纳入上一章的双引擎治理框架。

这里所说的“全对象治理”，不是宣称平台已经治理了所有对象，而是把治理边界从单次 Tool Call 推向所有**会改变 Agent 身份、认知、交互和行动结果的核心对象**。

<!--more-->

## 1. 当“工具治理”不够用时

工具治理最擅长回答的是：

> 当前 Principal 能否以这组参数调用这个 Tool？

这对执行安全至关重要，但一次 Agent 行为不是凭空产生的。Tool Call 之前还有一条更长的因果链：用户通过某个界面提交输入，某个版本的 Agent 读取一组知识，再规划并调用工具。



![Mermaid 图表](/images/mermaid/mermaid-e7d6554d-1.svg)



这也说明 A2UI 为什么不会天然绕过治理：它提交的是输入，不是执行结果。真正产生副作用的动作仍然需要 Agent 调用后端 Tool，并经过原有治理 Runtime。

真实运行中，点击“提交订单”后，前端只会把按钮 ID 和表单值封装成 `a2ui_action`。Agent 收到这条隐藏 HumanMessage 后继续运行，再生成一张新的配送追踪 Surface。原点餐面板不会在浏览器里直接变成订单，也不会因为按钮名称叫“提交订单”就自动调用支付或下单接口。

[![提交订单动作进入新一轮 Agent Run 后生成的配送追踪面板](/images/ai/deer-flow-a2ui-02.png)](/images/ai/deer-flow-a2ui-02.png)

配送面板里的“取消订单”同样只代表一个结构化 action。Agent 根据当前订单状态生成新的取消确认 Surface，向用户展示退款金额、取消影响和最终确认按钮。

[![取消订单动作生成的二次确认面板，此时订单尚未真正取消](/images/ai/deer-flow-a2ui-03.png)](/images/ai/deer-flow-a2ui-03.png)

第三张图尤其能说明这条边界：**出现“确认取消订单”按钮，不等于取消操作已经执行。** 用户再次提交后，Agent 仍然需要决定是否调用订单 Tool；真正的取消请求还要经过后端权限、Guardrail、审批策略和业务幂等校验。A2UI 负责让意图变得结构化，不负责替后端授予执行权限。

### 4.4 当前安全边界仍然只完成了一半

当前前后端都会验证 `a2ui_action` 的结构、ID 格式、标量值、字段数量和总字节数，但服务端还没有根据原始面板状态验证：

- `surfaceId` 是否属于当前用户和线程；
- `toolCallId` 是否对应一条真实的 `render_a2ui` ToolMessage；
- `sourceComponentId` 是否确实存在；
- 该组件声明的 action 是否与提交值一致；
- 当前 surface revision 是否已经提交或过期。

因此，现阶段建立的是**渲染侧白名单边界和结构化输入边界**，还不是端到端可信 action。恶意客户端仍可能构造一个结构合法、但并非来自真实面板的提交。

下一阶段需要在服务端保存 Surface Registry 或从 checkpoint 恢复权威 Envelope，再校验 `surfaceId + revision + component + action`。同时增加业务幂等键、过期时间和重放保护：

```text
a2ui_action_key = SHA256(
  thread_id
  + surface_id
  + surface_revision
  + source_component_id
  + action
  + values_sha256
)
```

审计事件还应记录 `surfaceId`、`sourceComponentId`、`action`、`values_sha256` 和验证结果，但不投影原始表单值。对于发布、删除、付款等高风险 action，治理中心可以增加 A2UI 专用审批规则。

## 5. 全对象治理的核心：统一能力描述符

版本、KB、A2UI 和 Tool 分别建立数据模型后，治理复杂度不会线性增加。真正困难的是它们会组合在同一次 Run 里。

### 5.1 四类漂移与交叉风险

**版本漂移**：审批时是 v3，恢复时已经是 v4。即使 Tool 参数不变，Agent 的系统指令、工具集合或行为规则可能已经变化。

**知识污染**：Agent 根据 KB Snapshot A 生成操作并获得批准，执行前文档被替换成 Snapshot B。审批人看到的依据与恢复 Run 使用的依据不再相同。

**交互伪造与重放**：客户端提交结构合法的 `a2ui_action`，但它并不来自服务器生成的组件；或者同一批准按钮被重复提交。

**权限交叉**：用户有 KB viewer 权限、Agent 有 `knowledge_search` 权限、A2UI 允许提交某个 action，并不自动意味着最终 Tool Call 应该放行。四类权限必须在同一个上下文中裁决。

如果分别为每类对象增加一套完全独立的 Grant，组合数量会迅速失控。更可行的方向，是把它们收敛为统一的能力描述符。

### 5.2 CapabilityDescriptor

一个能力描述符至少需要表达七组信息：

```text
CapabilityDescriptor
├── subject
│   ├── user_id / role
│   └── agent_id / agent_version_id / agent_snapshot_sha256
├── resource
│   ├── type: tool | collection | document | a2ui_surface
│   └── id
├── operation
│   └── call | search | read | render | submit
├── revision
│   ├── kb_snapshot_id
│   └── surface_revision
├── integrity
│   ├── arguments_sha256
│   ├── content_sha256
│   └── values_sha256
├── policy
│   ├── policy_ids[] / policy_sha256
│   └── risk_level / expires_at
└── evidence
    ├── thread_id / run_id / trace_id
    └── approval_id / audit_event_id
```

它不是把所有字段强行塞进每一次请求。不同对象只填写自己相关的部分，但 Runtime、审计和 Langfuse 使用同一套命名与关联规则。

例如，一次基于知识库的高风险工具调用可以形成这样的裁决上下文：

```json
{
  "subject": {
    "user_id": "user-123",
    "agent_id": "research-assistant",
    "agent_version_id": "version-7",
    "agent_snapshot_sha256": "..."
  },
  "resources": [
    {
      "type": "knowledge_collection",
      "id": "collection-42",
      "revision": "kb-snapshot-9"
    },
    {
      "type": "tool",
      "id": "publish_report",
      "arguments_sha256": "..."
    }
  ],
  "interaction": {
    "surface_id": "publish-confirmation",
    "surface_revision": 3,
    "action": "confirm_publish",
    "values_sha256": "..."
  }
}
```

审批 Grant 对这份规范化描述符计算哈希。恢复 Run 重新构造描述符，只要 Agent 版本、知识快照、A2UI revision、action 或 Tool 参数任一发生变化，旧 Grant 就不能匹配。

### 5.3 双引擎在全对象治理中仍然不变

对象增加后，上一篇建立的职责分离仍然成立：

| 系统 | 在全对象治理中的职责 |
|---|---|
| 治理 Runtime | 基于 Principal、对象、操作、revision 和策略作出 allow / deny / interrupt |
| 治理数据库 | 保存版本、ACL、审批、Grant、对象哈希和 append-only 事件 |
| Langfuse | 把对象上下文与模型、检索、A2UI、Tool 组织进同一条 Trace |

Langfuse 可以解释“v7 Agent 检索了 KB Snapshot 9，渲染了 revision 3 的确认面板，用户提交后调用 publish_report”；但它不能因为 Trace 看起来正常就自行授权。事实源与观测投影的边界不能因为对象变多而改变。

## 6. 当前边界与下一步：站在第三级治理的门槛上

这次开发已经形成三个可运行 MVP，但它们的成熟度并不相同：

| 对象 | 当前阶段 | 已闭环 | 主要缺口 |
|---|---|---|---|
| Agent Version | 配置版本 MVP | 自动快照、哈希、历史、回滚、基础 UI | 依赖冻结、真实运行评测、事务性回滚、Trace / Grant 绑定 |
| Knowledge Base | 小数据检索 MVP | Collection、Document、ACL、BM25、Lead Agent 工具 | 导入切块、Agent 绑定、大规模检索、Snapshot、引用链 |
| A2UI | 安全收敛的交互 MVP | 能力协商、固定 Catalog、流式渲染、历史恢复、结构化提交 | 服务端 Surface 校验、业务幂等、审计指标、复杂控件 |

数据模型、主要 API、运行时接入和基础 UI 已经闭环，适合内部演示和小数据试用；但还不能把“功能可运行”直接等同于“治理已完成”。

如果继续沿用上一篇的五级划分，接下来的演进路径可以更具体地描述为：

### 第三级：全对象治理

- 显式建立 Agent 与 Collection 的绑定；
- 将 Agent Version、KB Snapshot 和 A2UI Revision 纳入统一能力描述符；
- 让 Grant 同时绑定对象版本和内容哈希；
- 在服务端验证 A2UI Surface、Component 与 Action；
- 为对象变更、读取、提交和拒绝建立 append-only 审计事件。

### 第四级：强一致治理

- 使用 Transactional Outbox 保证审计与投影可靠派发；
- 为 Agent 回滚和 KB 发布建立事务或 Saga；
- 在数据库权限层强化 append-only；
- 对关键证据增加签名链或 WORM 存储；
- 明确对象删除、归档和证据保留策略。

### 第五级：结果导向治理

- 对不同 Agent 版本执行真实回归数据集，而不是只检查录制输出；
- 统计知识命中、引用完整性和错误依据率；
- 统计 A2UI 渲染成功率、交互完成率、校验失败率和重复提交率；
- 将审批结果与最终 Tool 执行和业务结果关联。

这时治理系统回答的就不再只是“有没有按规则做”，还包括“这个版本是否更可靠、这份知识是否真正有用、这个交互是否帮助用户完成任务”。

## 7. 小结

这篇新增的不是三个互不相关的功能，而是三个新的治理维度：

- **Agent Version 决定谁在运行**：不可变快照和 SHA-256 让配置身份开始可追踪，但依赖冻结与真实回归仍未完成；
- **Knowledge Base 决定读取了什么**：Collection ACL 在检索前收缩候选知识，Tool Governance 再控制检索能力，但知识快照和引用证据仍需补齐；
- **A2UI 决定如何与人交互**：固定组件和结构化 action 把 UI 收敛为受控输入，按钮不直接执行函数，但服务端真实性校验和重放防护仍是下一步。

三者最后都必须服从同一个双引擎原则：**治理 Runtime 决定行动，治理数据库保存事实，Langfuse 解释运行。**

版本、知识、交互和工具看似属于平台的不同模块，但对治理来说，它们只是同一条因果链上的不同对象。全对象治理也不是继续堆功能，而是重新划定边界：一次授权必须明确绑定“谁、依据什么、通过什么交互、准备做什么”。

本文记录的三个 MVP 还不是终点。它们真正重要的意义，是让 DeerFlow 从一个能够组装 Agent 的框架，开始具备成为 Agent 平台所需要的对象身份、权限边界和证据基础。
