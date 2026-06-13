+++
date = '2026-06-01T10:20:00+08:00'
draft = false
title = '从股票观点系统到 Agent 应用（六）：Harness 与可靠自动化'
categories = ['AI 大模型']
tags = ['Agent', 'Harness']
series = ['viewpoint_miner']
+++

前五篇我们逐步搭建了五组能力：

1. 第 1 篇用数据管道和规则引擎把原始观点转成交易信号
2. 第 2 篇用 MCP Server 把数据能力暴露为 Agent 可调用的工具
3. 第 3 篇用 Skills 固化常见分析工作流
4. 第 4 篇用 RAG 语义搜索处理"北向资金"这类模糊查询
5. 第 5 篇为 RAG 对话增加上下文预算和记忆管理

每一层都在解决问题，但少了一环：**谁来触发这些能力？**

把 `node cron.js` 改为定时执行，只是自动化，不会因此自动变成 Agent。Agent 还涉及基于状态选择工具、观察结果并调整下一步；Harness 的作用是为这些能力提供调度、边界、日志和失败处理。

Phase 4 要做的就是这最后的闭环。

---

## 系统总览：管道即定时器

先看全局。Harness 自动化的完整管道是这样的：

![Harness 自动化管道](/images/viewpoint_miner/harness-pipeline.svg)

```
cron 08:00 → 同步观点 → 提取信号 → 生成 embedding → 变更检测 → 护栏 → 推送
启动时   → 根据最近运行状态判断是否需要补跑
```

整个管道由 4 个模块构成，`cron.js` 是调度中枢，其余 3 个 lib 各司其职：

| 模块 | 文件 | 职责 | 行数 |
|---|---|---|---|
| 调度中枢 | `cron.js` | 注册 node-cron 任务，串联同步→提取→检测→推送 | 455 |
| 护栏 | `lib/guardrails.js` | 静默时段 / 频率限制 / 置信度阈值 / 冷却期 | 199 |
| 变更检测 | `lib/change-detector.js` | 每日摘要统计 / 增量信号变化 / 格式化输出 | 213 |
| 推送器 | `lib/notifier.js` | 多渠道发送与通知日志 | 260 |

三个支持模块合计约 650 行，但解决的问题比代码量重得多。下面逐个拆解。

---

## Guardrails：四道护栏

护栏是整个自动化的安全网。自动化最怕的不是没数据，而是**过度推送**——凌晨三点弹通知、同一条信号重复推十次、低质量猜测被当确定信号发送。

`checkGuardrails()` 用四道短路口依次拦截：

![护栏决策树](/images/viewpoint_miner/guardrails-decision-tree.svg)

### 第一道：静默时段

```javascript
function isQuietTime(quietStart = '22:00', quietEnd = '07:00', now = new Date()) {
  const current = now.getHours() * 60 + now.getMinutes();
  const start = /* 22:00 → */ 1320;
  const end   = /* 07:00 → */ 420;
  // 跨午夜：current >= 1320 || current <= 420
  return start <= end
    ? current >= start && current <= end
    : current >= start || current <= end;
}
```

把时间转换成分钟数，然后处理跨午夜的特殊情况。22:00 到次日 07:00 之间，任何推送请求都会被拦截。不需要依赖日期库，8 行代码解决。

### 第二道：每日频率限制

```sql
SELECT COUNT(*) FROM notification_log
WHERE channel = ? AND status = 'sent'
AND date(sent_at) = date(?)
```

从 `notification_log` 表统计今天已发送的条数。每条渠道独立计数——console 发了 3 条不会影响 dingtalk 的配额。摘要类通知每日上限 3 条，信号提醒类上限 5 条。

### 第三道：置信度阈值

```javascript
if (confidence < minConfidence) {
  return { allowed: false, reason: `置信度 ${confidence.toFixed(2)} < 阈值 ${minConfidence}` };
}
```

默认阈值 0.6。这意味着那些"如果有机会可以关注一下"（confidence=0.4）的信号不会触发推送，只有"建仓 36 附近"（confidence=0.85）这种明确信号才会。阈值存储在 `notification_preferences` 表里，可按渠道分别配置。

### 第四道：冷却期

```javascript
function pastCooldown(stockId, action, cooldownMinutes = 60, now) {
  const cutoff = new Date(now.getTime() - cooldownMinutes * 60 * 1000);
  const cutoffStr = cutoff.toISOString().slice(0, 19).replace('T', ' ');

  // 精确按 (股票, 动作) 去重：notification_log.signal_refs 存储 JSON 数组
  // 通过 SQLite JSON1 解析判断是否已推送过同类信号
  const lastSent = db.prepare(
    `SELECT MAX(sent_at) as last FROM notification_log
     WHERE status = 'sent' AND type = 'signal_alert'
     AND json_extract(signal_refs, '$') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM json_each(notification_log.signal_refs)
       WHERE CAST(json_extract(value, '$.stock_id') AS INTEGER) = ?
         AND json_extract(value, '$.action') = ?
     )
     AND sent_at >= ?`
  ).get(stockId, action, cutoffStr).last;

  return !lastSent;
}
```

同一只股票、同一个动作的信号，60 分钟内不会重复推送。避免"xx 建仓"刚推送完，另一条内容相近的建仓观点又触发一次。

> **一次本地架构审查发现的问题**：初版没有按 `stock_id` 和 `action` 过滤，只查全局最近一条通知。结果只要 60 分钟内发过任意信号，后续无关信号也会被拦截。现在通过 `signal_refs` JSON 数组记录每批 `(stock_id, action)`，再用 SQLite JSON1 精确匹配。它是开发阶段发现并修复的正确性问题，不应包装成"线上事故"。

### 设计要点：短路求值顺序

四道关卡的顺序不是随机的：

```
静默时段 → 频率限制 → 置信度 → 冷却期
  (0 DB)    (1 DB)    (0 DB)   (1 DB)
```

静默时段放在最前，可以在夜间直接拒绝请求；冷却查询放在最后，只对通过前三道检查的候选信号执行。中间的频率限制和置信度检查分别控制渠道总量与单条质量，因此这不是严格按 DB 成本排序，而是兼顾业务语义与查询成本。

另外，`checkGuardrails` 返回 `{allowed, reason}`。调用方需要显式记录这个结果；返回 reason 本身不会自动形成审计日志。

---

## Change Detector：增量与全景

护栏告诉你"能不能发"，变更检测告诉你"发什么"。两种模式覆盖不同场景：

### 模式 A：每日摘要（getDailySummary）

一把 SQL 聚合出全日概况：

```sql
-- 1. 今日新增观点数
SELECT COUNT(*) FROM viewpoints WHERE date(created_at) = date(?)

-- 2. 按动作类型分组统计
SELECT action, COUNT(*) FROM trade_actions
WHERE date(created_at) = date(?) GROUP BY action

-- 3. 高置信度信号 TOP 10（confidence >= 0.7）
SELECT ta.*, s.name, a.name, v.content
FROM trade_actions ta
JOIN stocks s ..., viewpoints v ..., authors a ...
WHERE date(ta.created_at) = date(?) AND ta.confidence >= 0.7
ORDER BY ta.confidence DESC LIMIT 10

-- 4. 活跃股票 TOP 5
SELECT s.name, COUNT(*) as signal_count,
       SUM(CASE WHEN action IN ('建仓','加仓','买回') THEN 1 ELSE 0 END) as buy,
       SUM(CASE WHEN action IN ('减仓','踢出','卖出','清仓',...) THEN 1 ELSE 0 END) as sell
FROM trade_actions ... GROUP BY s.id ORDER BY signal_count DESC LIMIT 5

-- 5. 活跃作者 TOP 5
SELECT a.name, COUNT(*) ...
```

> 这里有一个容易忽略的细节：buy/sell 分类用的是中文动作关键词的 IN 列表，而不是依赖外键或枚举。因为信号提取引擎的 action 字段存的就是"建仓""减仓"这些中文值——这一点在 #1 篇的提取引擎部分定下来的。

格式化的摘要长这样：

```
📊 每日信号摘要 (2026-05-22)

📈 今日新增观点 32 条，交易信号 21 条

【信号分布】
  建仓: 8 条
  加仓: 5 条
  减仓: 4 条
  清仓: 2 条
  卖出: 2 条

【活跃股票 Top 5】
  🟢 贵州茅台(600519): 5条信号 (买3/卖2)
  🔴 宁德时代(300750): 4条信号 (买1/卖3)
  ...

【高置信度信号】
  建仓 贵州茅台 ~1500 [张三]
  减仓 宁德时代 ~350 [李四]
  ...

【活跃作者】
  张三: 6 条信号
  李四: 5 条信号
```

### 模式 B：增量变化（getSignalChanges）

对比上次通知时间以来的新信号：

```javascript
const lastNotifyTime = changeDetector.getLastNotificationTime('signal_alert');
const since = lastNotifyTime || new Date(Date.now() - 24*60*60*1000).toISOString();
const changes = changeDetector.getSignalChanges(since);
```

直接从 `trade_actions` 表按时间窗查询，不做复杂的 diff 算法——上次通知时间就是从 `notification_log` 取最近一次 `sent` 时间，简单可靠。

---

## Notifier：多渠道抽象

有了内容和护栏裁决结果，最后一步是送达。`notifier.js` 注册了四个 channel，其中三个具备实际发送能力，wechatmp 仍是占位实现：

```javascript
async function send(channel, type, content, options) {
  let result;
  switch (channel) {
    case 'console':  result = await sendConsole(content);         break;
    case 'wechatmp': result = await sendWechatmp(content, opts);  break; // 当前仅输出日志
    case 'dingtalk': result = await sendDingtalk(content, opts);  break;
    case 'feishu':   result = await sendFeishu(content, opts);    break;
    default: throw new Error(`未知通知渠道: ${channel}`);
  }
  // 统一记录到 notification_log
  db.prepare(`INSERT INTO notification_log ...`).run(channel, type, content, ...);
  return result;
}
```

四个渠道的实际状态：

| 渠道 | 实现方式 | 配置要求 | 状态 |
|---|---|---|---|
| Console | `console.log` 打印 | 无 | 默认启用 |
| 微信小程序 | 当前仅写日志并输出到 console | 仍需平台集成 | 占位，不算真实送达 |
| 钉钉 | Webhook POST，Markdown 格式 | `DINGTALK_WEBHOOK` 环境变量 | 可用 |
| 飞书 | Webhook POST，文本卡片 | `FEISHU_WEBHOOK` 环境变量 | 可用 |

关键设计决策：

1. **统一记录层**：不管哪个 channel，`send()` 最后都会写入 `notification_log`，记录 channel + type + content + status。这是护栏（频率限制、冷却期）的数据源。

2. **Webhook 超时保护**：钉钉和飞书调用都设了 10 秒超时，避免外部服务挂掉阻塞整个管道。

3. **broadcast 模式**：`sendDailyDigest()` 和 `sendSignalAlert()` 内部先过护栏再发，不是无脑群发——每个渠道独立走 `checkGuardrails`，互不影响。

4. **摘要不检查置信度**：摘要推的是统计概况，不涉及单条信号的质量判断，所以 `minConfidence` 设为 0。

---

## 定时调度：cron.js 中枢

管道各组件是零件，`cron.js` 是装配图。它挂载在 server.js 启动流程上：

```javascript
function registerCronJobs() {
  // 每天 08:00 执行（Asia/Shanghai 时区）
  cron.schedule('0 8 * * *', () => {
    runDailySync();
  }, {
    timezone: 'Asia/Shanghai',
  });
  // 启动时检查：距上次同步超过 24 小时则补跑
  checkAndCatchupSync();
}
```

`runDailySync()` 的执行流：

```
1. syncAllAuthors(db)           → 同步所有作者最新观点（增量，从最新 rec_time 开始）
2. extractAllStarredStocks(db)   → 基于版本号增量提取关注股票的交易动作
3. semanticSearch.init()         → 为新观点生成 m3e-base embedding
4. guardrails.initDefaultPref()  → 首次运行初始化通知偏好表
5. changeDetector.getSignalChanges()  → 获取上次通知以来的新增信号
6. notifier.sendSignalAlert()    → 过护栏 → 格式化 → 推送
```

> **关于步骤 2**：初版每次全量重跑并用 `INSERT OR IGNORE` 写入，规则变化后旧结果无法刷新。现在用 `trade_extract_version` 选择待处理观点，并在事务中 DELETE + INSERT。这里的版本号、删除、插入和版本更新必须原子提交，否则中途失败会留下半成品。

当前 `checkAndCatchupSync()` 名义上是补同步检查，但实际读取的是 `notification_log` 中最近一次成功的 `signal_alert`。如果同步成功却没有新信号，或者通知被护栏拦截，这个时间不能代表最近同步时间。更可靠的做法是增加 `sync_runs` 表，记录每次任务的开始、结束、状态和新增数量，再基于最后一次成功同步决定是否补跑。

---

## 全线串联：Agent 的工程运行底座

回顾整个系列，前六篇文章串起来的是一条完整链路：

```
爱股票 API
  ↓ (数据管道 #1)
SQLite 原始观点数据
  ↓ (信号引擎 #1)
trade_actions 交易信号
  ↓ (SQL 聚合 #1)
Dashboard 可视化
  ↓ (MCP Server #2)
LLM 可调用的 27 个工具
  ↓ (Skills #3)
预设工作流（stock-analyst / signal-scanner ...）
  ↓ (RAG #4)
语义搜索 / 上下文构建
  ↓ (Harness #6)
定时触发 → 护栏裁决 → 变更检测 → 多渠道推送
```

每一层都可以独立使用，串起来后形成从采集到通知的自动化闭环。它为 Agent 提供数据、工具和运行底座，但是否构成 Agent 还取决于是否存在“观察 → 决策 → 行动 → 再观察”的动态循环。

这里的 `cron` 执行固定流程，属于 workflow automation；MCP Client 根据用户目标动态选择工具时，才更接近 Agent loop。两者可以组合，但概念不能混用。

---

## 小结

Phase 4 Harness 让这个系统从"有人用的时候才干活"变成了"到时间就自己干活并通知你"。

四个模块的职责边界清晰：

- **Guardrails** 回答"能不能发"（四道短路口：静默→频率→置信度→冷却）
- **Change Detector** 回答"发什么"（摘要模式 + 增量模式）
- **Notifier** 回答"发到哪"（3 个实际通道 + 1 个占位通道，统一日志）
- **cron.js** 回答"什么时候发"（node-cron 08:00 定时触发 + 启动时补同步检查）

这个设计的一个核心原则：**信号处理与内容生成模块决定通知候选内容，护栏决定发送策略**。两个角色不混淆——上游不能绕过静默时段和频率限制，护栏也不负责重新理解观点语义。

---

系统搭建阶段到此形成闭环：从一条观点文本开始，到固定时间完成采集、提取、检索和通知。这个过程展示的是 Agent 应用的工程底座，而不是仅靠定时器定义 Agent。

最后一篇会把跨模块的可靠性问题收束到一起：grounding、权限与副作用、循环检测、降级和评测。它们不需要再拆成多篇重复解释同一段代码。
