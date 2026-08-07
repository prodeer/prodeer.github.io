---
title: "DeerFlow 实践（二）：可审计技术选型多 Agent 工作流"
date: 2026-07-31
category: ai
tags: ["DeerFlow", "Agent", "LangGraph", "MCP", "多 Agent", "技术选型"]
description: "第二个专用 Agent，我选择从 Deep Research 入手，目标是处理开放式、存在争议的技术问题，例如“RAG 是否应该改用 GraphRAG”“某模型是否真的更擅长长上下文”，或者“某个技术..."
---



第二个专用 Agent，我选择从 Deep Research 入手，目标是处理开放式、存在争议的技术问题，例如“RAG 是否应该改用 GraphRAG”“某模型是否真的更擅长长上下文”，或者“某个技术方案是否适合生产环境”。

我把它定位为：**EvidenceGraph，可审计的多 Agent 技术研究与决策系统**。它既能完成多轮检索、多源综合和长文产出，也会把研究过程转化为一条可核验、可恢复、可评测的证据链。

每次成功运行会交付五个产物：

- `report.md`：面向人的结论报告；
- `claim-ledger.json`：每条事实性主张及其核验状态；
- `evidence-bundle.json`：来源、精确引文、定位信息和内容哈希；
- `conflict-matrix.json`：来源之间的冲突、严重程度与处理结果；
- `run-manifest.json`：模型、配置、调用、恢复记录和产物哈希。

它与常见 Deep Research 实现的差异，不是“搜得更多”或“报告更长”，而是把 Claim 当成核心对象：引用必须落实到 Claim 级，跨源分歧必须显式进入冲突矩阵，质量等级由确定性代码计算，证据不足时可以暂停并交给人工决策。报告只是证据链面向人的一个视图。

```text
来源 -> 原文摘录 -> Claim -> 核验结论 -> 技术建议
```

换句话说，EvidenceGraph 不是普通“深度研究”，而是一条由五类 LLM 专家、确定性控制器、Evidence MCP 和人工复核共同组成的研究论证流水线。

<!--more-->

## 1. 整体架构

### 1.1 五层结构总览

![EvidenceGraph 可审计技术选型 Agent 架构](/images/ai/deer-flow-evidence-auditor-architecture.svg)

从上到下，EvidenceGraph 分成五层：

| 层次 | 一句话职责 |
|---|---|
| 专用 Agent 入口 | 接入 DeerFlow 的线程、Run、SSE 和 Artifact 能力，并由独立 Factory 创建专用 Graph |
| 多 Agent 研究图 | 让 Planner、Researcher、Claim Extractor、Verifier 和 Writer 分工完成语义任务 |
| 确定性控制层 | 负责去重、引用校验、质量分级、路由、预算和原子发布 |
| Evidence MCP | 负责公开来源的发现、抓取、规范化、哈希、缓存与网络安全 |
| 状态与产物层 | 用 Checkpoint 保存可恢复状态，并以五个 Artifact 提交完整审计结果 |

`evidence-auditor` 使用独立的 LangGraph Factory，不进入默认 Lead Agent 链，但会复用 DeerFlow 已有的 Gateway、Thread、Checkpointer、Sandbox、MCP Cache、Stream 和 Artifact 路由。这样既保留了平台能力，又让技术选型拥有明确的状态机和交付契约。

### 1.2 数据流：从输入到五个产物

一次完整运行的数据流如下：

```text
用户输入
  -> Intake 提取候选方案、约束和语言
  -> Planner 拆解 3-5 个研究问题
  -> Send 并行启动 Researcher 分支
  -> 来源规范化与去重
  -> Claim Extractor 生成 Claim、EvidenceLink 和 Conflict
  -> Send 并行启动 Verifier 批次
  -> 确定性质量门禁计算 A-D 等级
  -> 必要时 interrupt() 进入人工决策或定向补充研究
  -> Writer 仅使用已核验 Claim 生成报告
  -> 先写报告与三份证据 JSON
  -> 最后写 run-manifest.json 作为提交标记
  -> 向用户暴露五个 Artifact
```

这里有两条关键约束：Writer 不能修改证据等级和引用关系；Artifact 只有在全部写入成功后才会一起出现。前者防止写作阶段重新“解释”证据，后者防止用户拿到无法审计的半成品。

## 2. 核心设计：先定义输入与产出

### 2.1 输入的约束结构

一个典型输入如下：

> 在必须支持持久化状态、人工审批、私有化部署和故障恢复的前提下，对比 LangGraph、AutoGen 和 CrewAI。请从状态持久化、Human-in-the-loop、多 Agent 编排、部署方式和恢复能力五个维度进行评估，给出推荐方案，并标出来源之间的证据冲突。证据截止日期为 2026-07-30。

它实际包含五类约束：

| 输入项 | 作用 |
|---|---|
| 候选方案 | 确定比较对象，当前版本支持 2 到 4 个 |
| 硬性约束 | 决定哪些能力是推荐方案的准入条件 |
| 评估维度 | 决定研究问题、Claim 分类和报告结构 |
| 证据截止日期 | 固定研究时点；当前 v1 以运行日期写入 Manifest |
| 输出语言 | 决定报告和最终回复使用的语言 |

当前 v1 还没有实现任意历史日期的严格时间切片。要真正支持这一能力，来源端还需要提供完整的发布日期、版本快照和可重复获取机制。

### 2.2 五个产物的契约

五个文件统一写入 `/mnt/user-data/` 下的 `outputs/evidence/{workflow_id}/` 目录：

| 产物 | 内容 | 主要使用者 |
|---|---|---|
| `report.md` | 推荐、逐维度比较、风险和适用边界 | 决策者 |
| `claim-ledger.json` | Claim、重要程度、核验结论和理由 | 审核者、评测程序 |
| `evidence-bundle.json` | 来源元数据、精确引文、Locator 和内容哈希 | 审核者、追溯工具 |
| `conflict-matrix.json` | 冲突类型、严重程度、涉及对象和处理结果 | 审核者、人工复核 |
| `run-manifest.json` | 模型、配置哈希、调用记录、恢复信息和产物哈希 | 运维、复现与审计 |

四个 JSON 都有版本化 Schema。前端为已知 Schema 提供格式化预览，同时保留源码视图、原文件和下载入口；未知 JSON 使用通用格式化视图。可审计不只是“文件存在”，还意味着人能够实际查看它。

### 2.3 为什么这样做

先定义输入和产物，等于先定义 Agent 的完成条件。

对模型而言，它知道每个阶段必须提交什么结构，而不是用一段自然语言宣布“研究完成”；对 Graph 而言，它可以检查外键、计算覆盖率、执行质量路由；对评测系统而言，它可以直接读取 Claim、EvidenceLink 和 Conflict，而不必从报告中反向猜测；对恢复流程而言，稳定 ID 和版本化状态也让已有结果可以继续复用。

这五个文件最终形成三个层次：`report.md` 负责阅读，三份证据 JSON 负责核验，`run-manifest.json` 负责证明它们属于同一次运行。报告可以重写，证据关系和运行记录不能随写作漂移。

## 3. 多 Agent 研究图

### 3.1 五个 LLM 专家的角色

研究图包含五类职责明确的专家：

- **Planner**：把输入拆成 3 到 5 个相对独立的问题，并建立带权重的评价维度；
- **Researcher**：按分支调用 Evidence MCP，搜索、获取并读取官方文档、仓库、论文等来源；
- **Claim Extractor**：从原文摘录中抽取可核验 Claim，建立 EvidenceLink 并识别显式冲突；
- **Verifier**：独立判断每条证据是支持、限定还是反驳 Claim，不增加新事实；
- **Writer**：只使用通过核验的 Claim，生成推荐、逐维度比较、风险和下一步行动。

这里不是让五个 Agent 轮流写总结。每个角色只接收完成当前职责所需的上下文，并通过提交工具交付结构化结果。

### 3.2 并行与合并机制

Planner 生成子问题后，Graph 通过 LangGraph `Send` 并行启动 Researcher；Claim 抽取完成后，再通过 `Send` 并行启动多个 Verifier Batch。研究与核验是两处主要的并行点。

并行结果不能简单追加。来源、Claim、EvidenceLink、Conflict、核验决策和调用记录都有稳定 ID，并由 Reducer 按 ID 合并：首次出现时保留顺序，再次出现时更新同一个对象。这样即使分支重试、人工补充研究或从 Checkpoint 恢复，也不会把同一条证据重复写入状态。

Checkpoint 中只保留来源引用和最长 2,000 字符的有界摘录，不保存完整网页正文。完整内容交给 MCP Cache 管理，避免并行分支把 Graph State 撑大。

### 3.3 关键挑战：结构化通信

多 Agent 协作不能依赖自然语言默契。如果 Researcher 只说“我找到了三个来源”，下游仍然需要猜 URL、版本和引文；如果 Verifier 只说“这个结论基本可信”，质量门禁也不知道它核验的是哪条 Claim。

因此，每个专家必须通过专用提交工具返回 Pydantic 校验过的结构，包括 `ResearchPlan`、`SourceRecord`、`EvidenceExcerpt`、`Claim`、`EvidenceLink`、`Conflict`、`VerificationDecision` 和 `ReportDraft`。

其中最关键的是 `EvidenceLink`：

```json
{
  "claim_id": "claim-langgraph-recovery",
  "source_id": "source-langgraph-durable",
  "exact_quote": "...",
  "locator": "offset:1200",
  "relation": "supports",
  "directness": "direct"
}
```

它让系统可以像检查数据库外键一样检查证据关系：Claim 和 Source 必须真实存在，精确引文和 Locator 必须随 Link 一起提交，Verifier 返回的也必须是 Link ID。

**通用原则**：自然语言适合表达语义，不适合承担协议。只要下游需要统计、路由、恢复或审计，就应该使用带版本的结构化契约。

## 4. 确定性控制层

### 4.1 控制层接管了什么

模型擅长拆解问题、理解语义和形成建议，但不应该自行决定引用是否存在、覆盖率是否达标，或者运行是否可以发布。控制层因此接管了这些职责：

- 来源去重与规范化；
- Claim、Source、EvidenceLink 和 Conflict 的引用检查；
- 调用次数、递归 Step、研究轮次和人工审核次数上限；
- 核心 Claim 覆盖率与独立权威来源组统计；
- A-D 质量分级和后续路由；
- Artifact 的完整提交。

控制层不替模型做研究，而是决定模型结果能否进入下一个阶段。其策略是保守而明确的：有歧义就不猜，没有证据就降级，未满足发布条件就进入人工决策。

### 4.2 质量门禁：A-D 分级

质量等级不是模型自评，而是由代码根据 Claim、EvidenceLink、核验决策和 Conflict 计算：

```text
D：存在未支持的核心 Claim，或核心覆盖率低于 70%
C：核心覆盖率未达到配置阈值，或仍有未解决的高风险冲突
B：覆盖率和冲突达标，但独立权威来源组不足
A：覆盖率、冲突和独立来源均达到发布标准
```

当质量不足或存在高风险冲突时，Graph 通过 `interrupt()` 暂停，提供四种人工决策：带不确定性发布、排除争议 Claim、定向补充研究或取消。当前版本最多增加一轮定向研究，避免 Agent 在“再找一点资料”中无限循环。

### 4.3 关键挑战：引用完整性兜底

即使输出已经结构化，模型仍可能把 `source_id`、`conflict_id` 和真正需要的 `EvidenceLink.link_id` 混在一起。

控制器采用了一组保守修复规则：

- 某个 `source_id` 在当前 Claim 下只对应一条 Link 时，可以确定性转换为该 `link_id`；
- 存在多个候选 Link 时不猜；
- `conflict_id` 和悬空 ID 直接丢弃；
- `supported` 没有任何有效支持 Link 时，降级为 `unsupported`。

系统宁可降低质量等级并进入人工审核，也不会为了让流程继续而编造证据。结构化输出是第一道防线，确定性引用检查才是最后的完整性保障。

## 5. 基础设施：MCP 与 Checkpoint

### 5.1 Evidence MCP：边界与安全

独立包 `deerflow-evidence-mcp` 只暴露三个工具：

```text
search_sources -> fetch_source -> read_source
```

MCP 负责来源发现、抓取、正文规范化、哈希、缓存、重试、超时和网络安全；Graph 负责权威性分类、Claim 抽取、证据核验、冲突判断、推荐和人工审核。这个边界把“如何可靠取得资料”与“资料说明了什么”分开了。

Evidence MCP 支持两种模式：

- `fixture`：使用版本化的 2026-07-30 离线语料，用于测试和可重复演示；
- `live`：通过 DDGS、GitHub REST 和 OpenAlex 发现公开资料。

Live 模式只接受公开 HTTP/HTTPS 文本资源，并拒绝本地和私网地址；每次重定向都会重新校验，最多允许 3 次重定向，同时设置 15 秒超时、5 MB 正文上限和 MIME 类型检查。Evidence MCP 不是一个无限制的 URL 下载器，而是研究图与外部网络之间的安全边界。

### 5.2 Checkpoint：恢复的事务性

有 Checkpoint 不等于失败 Run 可以变成成功。已经崩溃的 Run 仍然保留为 `error`；恢复会创建新的 Run，记录 `recovery_from_run_id`，并以 `input=None` 从 Checkpoint 继续，而不是重放原始用户消息。

稳定的 Workflow ID、Source ID 和 Reducer 让恢复后的 Graph 能识别已有结果，MCP Cache 则避免再次抓取已经缓存的来源。这防止了研究分支重复生成，也避免恢复前后混入不同版本的正文。

Artifact 发布同样使用事务思路：系统先写 `report.md`、`claim-ledger.json`、`evidence-bundle.json` 和 `conflict-matrix.json`，最后才写包含各文件 SHA-256 的 `run-manifest.json`。Manifest 是提交标记，只有全部写入成功，五个 Artifact 才会一起暴露给用户。

### 5.3 两种失败：执行失败与收尾失败

实际运行中出现过一种很有代表性的情况：Researcher 已经成功搜索、抓取和读取来源，但模型最后没有调用 `submit_researcher_result`，而是停在自然语言总结或递归上限。

这需要区分两种失败：

- **执行失败**：没有取得可验证证据；
- **收尾失败**：已经取得有效证据，但模型没有完成结构化提交动作。

研究工具因此增加了一层有界 Trace。它只记录已通过 MCP 返回且能被 `SourceRecord` 校验的来源，每个保留来源最多留下一段 2,000 字符的摘录。如果提交动作缺失但 Trace 已有有效来源和读取结果，确定性代码可以构造 `ResearchBranchResult`；如果没有有效证据，分支仍然失败，不会伪造数据保活。

同一问题还暴露了一个框架语义细节：`SubagentConfig.max_turns` 限制的是 LangGraph recursion steps，而不是 LLM 对话轮数。Planner、Extractor、Verifier 和 Writer 使用 12 个 Step，Researcher 因为需要顺序完成 search、fetch、read 和 submit，使用 32 个 Step。已经通过提交工具校验的结果会保持有效，即使随后一条多余的结束消息触及上限。

## 6. 真实跑通与未来规划

在一次完整端到端运行中，这个 Agent 用 3 分 51 秒完成了 5 个 Researcher 分支，最终得到：

- Evidence Grade A；
- 核心 Claim 覆盖率 100%；
- 3 个独立权威来源组；
- 5 个 Artifact 全部可下载，四个 JSON 均能通过解析。

这证明了输入、并行研究、Claim 核验、质量门禁和 Artifact 发布可以组成完整闭环，但它只是一次成功演示，不是性能或质量基准。

仓库已经准备了 18 个质量用例和 6 个可靠性用例，并实现引用有效性、引用覆盖率、支持精度、冲突召回、决策准确率和恢复成功率等指标。候选 Agent 与 Lead Agent 基线会使用相同模型、离线语料和预算，并通过成对 Bootstrap 计算置信区间。

目前这组配对模型评测还没有真正运行，因此不能声称 EvidenceGraph 比通用 Agent 提升了多少。下一步重点有三个：

1. 跑完离线 Eval 和可靠性测试，用真实数字验证编排带来的收益；
2. 补齐来源版本快照和发布日期约束，实现严格的历史时间切片；
3. 继续细分文档、代码仓库和论文的来源策略，但保持统一的 Source 与 EvidenceLink 契约。

## 小结

EvidenceGraph 最终形成了一条职责明确的研究论证流水线：LLM 专家负责拆解问题、研究资料、抽取 Claim、核验证据和撰写建议；LangGraph 负责并行编排、状态流转和人工中断；确定性代码负责引用完整性、质量分级、轮次上限和原子发布；Evidence MCP 负责安全、可靠、可缓存地取得来源；Artifact 协议负责让结果可以复查、恢复和评测。

**模型负责研究和判断，Graph 负责约束、核验和恢复；报告可以重写，证据链必须可追溯。**
