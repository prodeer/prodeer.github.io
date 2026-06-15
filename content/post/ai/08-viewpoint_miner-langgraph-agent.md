+++
date = '2026-06-15T14:00:00+08:00'
draft = false
title = '从股票观点系统到 Agent 应用（八）：LangGraph 旁路重构与影子运行'
categories = ['AI 大模型']
tags = ['Agent', 'LangGraph', 'Human-in-the-loop']
series = ['viewpoint_miner']
+++

第 7 篇结尾，我把这个系列称为“一条更务实的 Agent 学习路线”。写下那句话时，我觉得系统已经有规则提取、MCP、Skills、RAG、Memory、Harness 和可靠性边界，能补的模块基本都补齐了，这个系列也该结束了。

但结束之后，我又问了自己一个更直接的问题：

> 如果不看文章里用了多少 Agent 术语，只看项目真正运行时的行为，它算一个合格的 Agent 吗？

我按目标、环境感知、工具调用、状态与记忆、规划决策、执行反馈、失败恢复和安全边界逐项检查。重构前的答案并不理想：**它是一个 Agent-ready 的投研数据应用，但还不是一个合格的独立 Agent。**

这个结论让我重新打开代码。问题不在于 MCP 工具不够多，也不在于 RAG 不会回答，而是项目内部没有一次可以追踪的“观察 → 决策 → 验证 → 根据结果继续或停止”。我真正需要补的不是又一个 AI 功能，而是一层受控的 Agent 执行状态。

<!--more-->

---

## 我先给项目做了一次 Agent 体检

我没有用“是否调用 LLM”作为判断标准。一个任务专用 Agent 不一定非要开放式 ReAct，但至少应该有明确目标、可持续的状态、基于结果的分支，以及从执行结果回到下一步决策的反馈。

按这个标准看，重构前的项目更像下面这样：

| 维度 | 已有能力 | 我看到的缺口 |
|------|----------|--------------|
| 目标 | 用户提问、定时任务都有局部目标 | 没有一次独立 Agent 运行的目标与完成状态 |
| 环境感知 | SQLite 数据、语义检索、RAG 上下文 | 检索结果只进入固定回答流程 |
| 工具调用 | 27 个 MCP Tools | 工具由外部 Agent 使用，项目内部不做动态选择 |
| 状态与记忆 | RAG 会话、摘要、通知日志 | 没有跨节点的 Agent 状态和步骤轨迹 |
| 规划决策 | Skills 提供推荐工具链 | 项目内部仍按预先写好的顺序执行 |
| 执行反馈 | 规则提取、护栏和通知有结果 | 没有验证结果后继续、停止或转人工的分支 |
| 失败恢复 | cron 有补跑和通知降级 | 没有 Agent 事件租约、步骤错误和运行级重试 |
| 安全边界 | 通知护栏、MCP 参数校验 | 模型产物还没有独立草案与审批层 |

把这些能力串起来，重构前的实际链路是：

```text
定时器 → 固定顺序抓取 → 规则提取 → 生成向量 → 通知
用户提问 → 固定语义检索 → 拼接上下文 → LLM 回答
外部 Agent → MCP 工具 → 查询或写入数据库
```

自动运行不等于自主决策，能被 Agent 调用也不等于项目本身就是 Agent。我最后给它的定位是：

```text
投研数据应用
+ 自动化工作流
+ RAG 助手
+ MCP 工具服务器
= Agent 工具与业务底座
```

这不是否定前七篇做的工作。恰恰相反，正因为数据、工具和自动化底座已经存在，我才可以把问题收窄到一个明确缺口：**项目内部还没有目标驱动、带状态和反馈的执行循环。**

---

## 要不要用 LangChain 重构整个项目

得出这个结论后，我自然想到：既然要补 Agent loop，是不是应该用 LangChain 这类主流技术栈，把项目整体重构一遍？

我的答案是：可以引入，但不能为了框架把整个项目“LangChain 化”。

LangChain 解决不了观点数据是否准确、行情是否及时、规则是否误判，也不能替我决定金融动作的审批边界。全面改写反而会让我重新包装一遍已经稳定的抓取、游标、去重、SQLite 和通知逻辑。

我真正需要的是可控编排，而不是更多模型封装。于是我把选择收窄到 LangGraph：用显式状态图表达节点、条件分支和停止状态，原有 scraper、规则引擎、数据库、RAG 和 MCP 继续沿用。

我也放弃了另一条看起来更“Agent”的路线：把 27 个 MCP Tools 全部交给模型做开放式选择。当前任务的输入是一条已入库观点，输出只能是草案或无动作，没有必要让模型在整个工具空间里探索。对金融观点场景，可审查的路径比自由度更重要。

最终我只新增了两项核心依赖：

```text
@langchain/langgraph 1.4.7
@langchain/core      1.2.3
```

LangGraph 只负责 Agent 编排层。这是我给这次重构划下的第一条范围边界。

不过在写 Graph 之前，我先确认了 Agent 的产物应该放在哪里。工作台已经把规则提取的正式信号 `trade_actions` 和我决定跟踪的计划 `trade_plans` 分开，模型结果不应该混进任何一边。

直接写正式信号会污染主数据，直接创建计划又会越过我的决策。因此我增加了独立的 `agent_signal_drafts`：Agent 只提交草案，后续必须经过人工审核。

---

## 我最担心的是：重构会不会影响观点同步

确定用 LangGraph 以后，我最先担心的不是 Graph 怎么画，而是它会不会影响作者和股票观点的同步。

这条同步链路已经承担分页、`rec_time` 增量游标、去重、股票关联和 SQLite 事务。如果为了 Agent 把它们交给 LLM，模型超时可能拖住事务，分析失败甚至可能连带回滚已经抓到的观点。这样的重构即使更“智能”，对我也是倒退。

所以我的约束很明确：**同步链路完全保留，Agent 只能在观点成功入库后工作。**

最终我没有把 LangGraph 放进主链路，而是增加一条可选旁路：

![LangGraph 旁路架构](/images/viewpoint_miner/langgraph-sidecar.svg)

新观点仍然先由原链路可靠入库；只有我明确开启 Agent 时，同一个短事务才会多写一条幂等事件。

```javascript
function enqueueViewpointEvent(db, viewpointId, source = 'unknown', options = {}) {
  if (!options.force && !isAgentEnabled(options.env)) return null;

  db.prepare(`
    INSERT OR IGNORE INTO agent_events
      (event_type, entity_type, entity_id, source, status)
    VALUES ('viewpoint_created', 'viewpoint', ?, ?, 'pending')
  `).run(viewpointId, source);
}
```

我用三个约束把这条旁路和主链路隔开。

### 第一层：默认关闭

```env
AGENT_ENABLED=false
```

我把开关默认设为 `false`。关闭时帮助函数直接返回，连 Agent 表都不会查询。我要的不是“先创建事件，只是暂时不消费”，而是部署代码后对原链路保持零写入。

### 第二层：事件和观点在同一个短事务里

我让事件只在观点成功入库时出现，并用唯一键 `(event_type, entity_type, entity_id)` 避免同一观点重复入队。但这个事务里只写数据，不等待 LLM。

我不愿意在同步事务里 `await` 模型：模型的 60 秒超时会变成 SQLite 的长事务，模型失败还可能连带回滚已经抓到的观点。于是我让 Worker 只消费已提交的数据，把同步失败和分析失败拆成两个失败域。

### 第三层：Agent 是独立进程

```bash
AGENT_ENABLED=true npm run agent:worker
```

我也没有让 Web Server 顺手启动 Worker。这样 Web 重启不会重复启动消费者，模型延迟也不会阻塞 HTTP 请求。需要调试时，我可以显式处理一批事件，或者为旧观点补事件：

```bash
npm run agent:once -- 20
npm run agent:backfill -- 50
```

我特意没有把 Backfill 藏在启动流程里。历史数据是否重跑、一次重跑多少，应该由我明确决定，而不是一次普通启动顺便触发。

---

## 我主动收窄了状态图的自由度

确定旁路之后，我先给 Graph 写下一个足够窄的目标：

```text
分析新观点是否产生自选股票的有效操作变化，
并生成可审计、待人工审批的信号草案。
```

围绕这个目标，我只保留两种结果：生成一份待审草案，或者确认没有新动作后结束。执行路径如下：

```text
load_context
      ↓
   analyze
      ├─ 没有候选动作 ─────────────→ complete_no_action
      ↓
verify_evidence
      ↓
detect_change
      ├─ 没有有效变化 ─────────────→ complete_no_action
      ↓
persist_draft → await_approval
```

我让 `load_context` 从数据库加载观点、作者、关联股票，以及同作者在这些股票上的历史正式动作。`analyze` 只负责生成结构化候选；后面的验证、变化检测和写草案，我仍然保留为确定性代码。

我给 Graph 设置了 `recursionLimit: 12`。当前图本身没有回边，这个上限暂时更像一道保险，所以我不能把它包装成“已经实现循环检测”。

我也认真想过要不要做 ReAct，让模型自己从 30 个 MCP Tools 中选。最后没有做，因为这个目标根本不需要搜索整个工具空间：输入就是一条已经入库的观点，输出只能是草案或无动作。对我来说，让每条写路径和停止条件都能在代码审查里看见，比展示模型会自主选工具更重要。

这个选择也限制了我能如何描述它：**这是一个任务专用、带可选 LLM 分析节点的 Agent 编排层，不是通用自主 Agent。** 默认 `rules` 模式下，分析本身仍然是确定性的；我用 LangGraph 得到的是状态、分支、轨迹和审批停点。

---

## 我没有让分析器决定信任边界

我希望先用规则跑通整个链路，再逐步比较模型效果，因此保留了三种分析模式：

```env
AGENT_ANALYZER=rules
AGENT_ANALYZER=llm
AGENT_ANALYZER=hybrid
```

`rules` 直接复用我在第 1 篇实现的交易动作提取器，离线、稳定，也是默认值。

`llm` 调用现有 OpenAI-compatible 或 Ollama 接口。我要求模型只返回结构化 JSON；模型不可用或 JSON 不合法时，本次运行直接失败，不拿空结果冒充成功。

`hybrid` 是我给本地模型不稳定准备的折中：先调 LLM，失败后回退规则引擎，并把降级原因写进摘要。它提高了可用性，但我仍然要让调用方知道这次结果其实来自规则，而不是模型。

我要求模型返回的核心结构类似这样：

```json
{
  "signals": [
    {
      "stockCode": "600519",
      "action": "加仓",
      "priceLow": 50,
      "priceHigh": 50,
      "confidence": 0.9,
      "evidence": "贵州茅台50元加仓",
      "rationale": "明确的当前加仓动作"
    }
  ],
  "summary": "检测到加仓动作"
}
```

但我很快意识到，JSON Schema 校验通过只能说明字段长得对，不能说明内容是真的。因此我又增加 `verify_evidence` 做第二层检查：

- 动作必须在白名单内
- 股票要能映射到当前观点的关联股票
- `evidence` 必须逐字存在于原文
- 证据不匹配时，置信度最高只能保留到 `0.49`
- 置信度低于 `0.75` 的草案进入 `needs_review`

这里我没有把规则写成简单的“股票代码必须匹配”。当观点只关联了一只股票时，即使模型返回的代码没有命中，我也会回落到这只关联股票，并用数据库中的真实代码覆盖。因为上游已经完成股票关联，单股票观点可以这样容错；多股票观点则不能猜。

我还在 Prompt 中把观点原文明确标记为不可信数据，要求模型不要执行其中的指令。但我不敢把安全性押在 System Prompt 上。真正让我愿意保留模型结果的，是后面的白名单、关联关系、原文证据和草案隔离。

---

## 我只想在“真的有变化”时被打扰

观点里再次出现“加仓”，不代表我需要再审一遍相同内容。我让 `detect_change` 找到同一作者、同一股票最近的正式动作，再比较动作和价格：

```javascript
const sameAction = previous.action === signal.action;
const samePrice = Number(previous.price_low || 0) === Number(signal.priceLow || 0)
  && Number(previous.price_high || 0) === Number(signal.priceHigh || 0);

return !(sameAction && samePrice);
```

动作和价格都相同时，我让本次 Graph 直接走 `complete_no_action`，不再制造一条需要我处理的草案。

不过读完实现后，我也给自己记下了一个明确边界：历史比较读取的是正式 `trade_actions`，不是之前生成的 Agent 草案。现有测试只能证明“与历史正式信号相同”时不会再产草案；如果我多次手工运行同一观点，不同 `run_id` 之间仍可能出现内容相同的草案。正常事件入口有唯一键兜底，手工运行接口以后还需要跨运行幂等策略。

我还发现 Graph 的目标里写了“自选股票”，`load_context` 也读取了 `is_starred`，但当前查询并没有用它过滤。现在实际分析的是观点关联的全部股票。这个差异不会破坏影子隔离，但在开放正式 apply 之前，我要么补上过滤，要么把目标改成“关联股票”。

---

## 我需要知道每一次运行发生了什么

过去 RAG 请求失败时，我只能从日志里猜它卡在哪一步。我不想让新的 Agent 旁路继续靠猜，所以新增了五张表：

| 表 | 保存什么 |
|----|----------|
| `agent_events` | 观点入库后的幂等事件、领取状态和重试次数 |
| `agent_runs` | 目标、分析器、影子模式、最终状态和错误 |
| `agent_steps` | 每个节点的输入、输出、耗时和错误 |
| `agent_signal_drafts` | 与正式信号隔离的候选动作 |
| `agent_approvals` | 审批决定、审批人、修正内容和备注 |

为了让记录方式保持一致，我让每个节点都经过同一个 `tracedNode()` 包装：

```javascript
function tracedNode(repository, nodeName, handler) {
  return async state => {
    const started = Date.now();
    try {
      const output = await handler(state);
      repository.recordStep({
        runId: state.runId, nodeName, status: 'completed', output,
        durationMs: Date.now() - started
      });
      return output;
    } catch (error) {
      repository.recordStep({
        runId: state.runId, nodeName, status: 'failed', error: error.message,
        durationMs: Date.now() - started
      });
      throw error;
    }
  };
}
```

这里我选择的是项目自己的运行审计，并没有接入 LangGraph 原生 Checkpointer。`await_approval` 也不是 `interrupt()` 后跨进程 `Command(resume)`，而是把业务状态设为 `waiting_approval`，审批接口再更新数据库。

两种方式都能表达“等待人”，但恢复语义不同。当前实现已经能支撑我的草案审核和运行追踪，我不能因此写成“实现了 LangGraph 持久化中断恢复”。

---

## 我不想让 Worker 失败后假装还在运行

把 Worker 拆成独立进程后，我马上想到下一个问题：它领取事件后突然退出怎么办？如果不处理，数据库会一直显示 `processing`，而我只能看到一个永远不会结束的任务。

因此我让事件被领取时从 `pending` 或 `failed` 改成 `processing`，同时写入 `locked_at` 并增加 `attempts`。每次批处理前，Worker 会回收超过 10 分钟的租约：

```text
processing（租约超时）
        ↓
failed + 清空 locked_at + 立即重新入队
```

我把默认上限设为 3 次。模型调用失败、JSON 解析失败或节点异常都会写进 `last_error`，下一次领取前保留现场。

这当然不是完整的分布式队列，但我的项目就是单机 SQLite。与其先引入更重的基础设施，我更想先解决最危险的状态：进程已经崩溃，事件却永远停在“处理中”。

---

## 我为什么把影子模式写死

当 Graph 已经能生成草案后，我面临的是这次重构里最重要的选择：要不要让批准后的结果进入正式信号？我的答案是暂时不要。

配置里虽然预留了：

```env
AGENT_WRITE_ENABLED=false
```

但 Phase 1 即使我把它改成 `true`，状态接口也只会返回：

```json
{
  "mode": "shadow",
  "write_enabled": false,
  "write_requested": true
}
```

Worker 调用 Graph 时，我同样固定传入 `shadowMode: true`。我不想依赖一句“默认建议不要写”，所以代码里根本没有正式 apply 节点。

Graph 生成的结果只进入 `agent_signal_drafts`。我可以在“信号箱 → Agent 草案”查看证据、理由、置信度、分析器和完整观点，再选择批准或拒绝：

![Agent 草案工作台](/images/viewpoint_miner/langgraph-agent-inbox.png)

即使我点击批准，也只会完成两件事：

1. 更新草案状态并记录 `agent_approvals`
2. 当同一运行没有其他待审草案时，把运行标记为完成

它不会写 `trade_actions`，不会创建 `trade_plans`，更不会连接券商。我给 MCP 新增的 3 个工具也只有状态查询、草案查询和影子运行，没有审批工具。我不希望外部 Agent 调一个工具，就冒充我完成 Human-in-the-loop。

做到这里，我对 Human-in-the-loop 的理解也更具体了：它不是页面上多放两个按钮，而是**审批前后的数据权限不同**。我现在只守住了“模型产物不进入正式业务表”，还没有实现批准后的安全应用路径。

---

## 哪些事情我现在仍然不敢做

代码现在更接近一个可运行的 Agent 层，但这不代表我已经准备好让它接管更多事情。下面这些边界，我必须继续写清楚。

### 默认分析器仍然是规则引擎

我把 LangGraph 接进执行链，不代表每次都会调用模型。默认仍是 `AGENT_ANALYZER=rules`，真实语义分析需要我显式切到 `llm` 或 `hybrid`。

### 没有真实观点评测集

我现有的测试使用固定 fixture，验证的是状态迁移、隔离和恢复。它不能回答历史回顾、条件计划、否定句和多股票观点的提取准确率。

所以下一步，我更应该先标注 100 到 300 条真实观点，对比 rules、llm 和 hybrid 的动作、价格、证据准确率与重复草案率，而不是急着做多 Agent 或 Supervisor。

### 没有行情与结果评估

我现在只能让 Agent 判断“作者是否表达了操作变化”。它不知道当前价格是否已经错过，也不能判断观点后来是否赚钱，我更不会据此让它建议用户跟随。

### 没有正式 apply 节点

我点击批准，只是留下人工决定，不会把草案变成正式信号。未来如果增加 apply，我至少还要补上独立权限、跨运行幂等、修正内容校验和失败回滚测试。

### 还不是 LangGraph 原生持久化恢复

我把运行轨迹保存在项目自己的表里，审批也是业务状态更新。后续如果真的需要暂停并恢复 Graph，我再引入 Checkpointer 和 `interrupt/resume`，现在不能提前把这部分写成已完成。

---

## 小结

这次重构对我来说，最重要的收获不是学会了几个 LangGraph API，而是重新划清了 Agent 在这个系统里应该负责什么。

如果现在再回答开头那个问题，我会给出一个分层结论：**它已经是一个合格的、任务专用的受控观点分析 Agent，但仍不是一个合格的自主投研或交易 Agent。** 前者需要明确目标、状态迁移、结果验证、失败恢复和人工审批，这些已经落到代码里；后者还要求经过真实数据验证的模型决策、行情反馈和安全 apply，而这些仍然没有完成。

我没有因为引入新框架，就重写已经稳定的同步、去重、规则提取和通知；模型只分析已经提交的数据。我让 Agent 产物先进入独立草案表，再用确定性节点验证证据和变化。我允许 Worker 失败和重试，但不允许它拖住 Web 与同步。我可以批准结果，但在没有 apply 节点之前，这个批准也不能越过正式业务边界。

所以现在让我描述这次重构，我不会说“用 LangGraph 重写了 Viewpoint Miner”，而会说我给原系统补了四层东西：

```text
确定性主链路
    +
默认关闭的事件旁路
    +
受控状态图与运行轨迹
    +
影子草案和人工审批
```

MCP、RAG、Workflow 和 Harness 仍然是我需要的重要基础，但它们不会自动长成 Agent。真正让我觉得系统向前迈了一步的，是一次运行终于有了目标、状态、分支、验证、失败记录和明确的停止边界。

而在金融场景里，我最看重的恰恰是最后这个边界：**我可以先让 Agent 学会提出一份可审计的草案，但在它学会证明自己之前，不会让它替我按下执行键。**
