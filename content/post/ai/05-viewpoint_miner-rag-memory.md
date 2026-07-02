+++
date = '2026-05-28T10:00:00+08:00'
draft = false
title = '构建炒股 Agent（五）：给 RAG 装上记忆 —— 在有限的窗口里装下更多对话'
categories = ['AI 大模型']
series = ['viewpoint_miner']
+++

上一篇我们实现了 RAG Chat，系统已经能"读懂"观点并用自然语言回答用户问题。但用着用着，两个问题浮出水面：服务一重启，对话全没了；聊久了，AI 开始"忘事"——前五轮还聊茅台，第十轮就忘了你在说什么。

更深层的问题是：检索回来的观点太长，对话历史也太长，它们争抢的是同一个东西——LLM 的上下文窗口。给谁多、给谁少，需要一套统一的预算管理。

这篇文章记录的是：如何从"发现瓶颈"到"统一方案"的完整过程。
<!--more-->

---

## 起点：两个看似无关的问题

系统上线后，我先后发现了两个问题，起初以为是两件独立的事：

### 问题一：对话没有记忆

`routes/chat.js` 里的会话存储是这样的：

```javascript
const sessionStore = new Map(); // sessionId → [{ role, content }]
```

- 每次请求时把用户消息和 AI 回答 `push` 进历史数组
- 保留最近 20 轮（40 条消息），超了就 `splice` 截断
- 构建给 LLM 的消息时拼接：`[systemMsg, ...history, userMsg]`

问题很直接：

1. **纯内存** — 服务重启，所有会话丢失
2. **无跨会话记忆** — 新 sessionId = 白纸一张
3. **20 轮后直接截断** — 旧消息被丢弃，浪费了上下文窗口里本可以压缩利用的信息

### 问题二：长观点撑爆上下文窗口

`rag-chat.js` 的 `retrieveContext()` 拼接 RAG 上下文时，取的是**完整观点内容**，不做任何截断：

```javascript
// 改造前：直接用完整内容
return `[观点${idx + 1}] (相似度:${(r.score * 100).toFixed(0)}%)
作者: ${vp.author_name}
...
内容: ${vp.content}`;  // 完整观点，可能几百字甚至上千字
```

在 Qwen3.5-9B-4bit + `max_tokens=2048` 的约束下，如果 top-K=5 条中有 2 条超长观点，就可能占掉 70%+ 的窗口，导致对话历史和 system prompt 被挤掉。

### 两个问题的交汇点

两个问题各自解决的方向不同，但它们在代码里的交汇点就是构建 LLM 消息的那一行：

```javascript
const messages = [systemMsg, ...history, { role: 'user', content: message }];
```

`systemMsg` 装的是 RAG 检索结果（分块/截断管的），`history` 装的是对话历史（记忆管的）。两者争抢的是同一个东西——**LLM 的上下文窗口**。

在有限的窗口下：

```
上下文窗口 2048 tokens
├── System Prompt + RAG Context  ← 分块/截断决定这部分的体积
├── 对话历史                      ← 记忆决定这部分的体积
└── 当前用户消息 + AI 回答空间
```

**记忆越多 → 留给 RAG context 的空间越少**。如果保留 20 轮对话原文（约 4000+ tokens），RAG 只能塞 2-3 条观点，检索再准也白搭。

**观点越长 → 留给对话历史的空间越少**。如果 5 条观点全文拼进去占 1500 tokens，对话历史只剩几百 token，AI 基本没有"记忆"。

所以，这两个问题如果分别优化、各自膨胀，就会在有限的窗口里互相挤压，最终谁也发挥不了作用。

---

## 发现：它们本质上是同一个问题

仔细想想，对话历史的"摘要压缩"和 RAG 检索结果的"分块截断"，其实是同一件事的两个面：

```
            输入信息太多
           ┌─────┴─────┐
       对话历史太长      观点内容太长
           │              │
       摘要压缩          分块截断
           │              │
       旧对话 → 200 token   5条×500字 → 5条×200字
           │              │
           └─────┬─────┘
          腾出空间给对方
```

- **对话历史的摘要压缩** ≈ 对"对话"做分块，保留精华
- **观点内容的截断** ≈ 对"检索结果"做压缩，保留精华

因此，不应该分别做，而是**统一做一个"上下文预算管理器"**——在有限的上下文窗口里，给 RAG context 分多少 token、给对话历史分多少 token，整体规划。

---

## 方案：三层架构 + 统一预算

从 RAG 系统的角度，Memory 通常分为三个层次：

| 层次 | 含义 | 改造前 | 改造后 |
|------|------|--------|--------|
| **1. 工作记忆** | 当前对话的最近 N 轮，直接放入 LLM context | 内存 Map，20 轮硬截断 | SQLite 持久化 + 预算控制 |
| **2. 短期/会话记忆** | 整个会话的压缩摘要，跨轮可用 | 无 | LLM 生成摘要，持久化到 chat_sessions.summary |
| **3. 长期/用户记忆** | 跨会话的用户偏好、反复出现的关注点 | 无 | 暂未实现（后续可扩展） |

改造后的数据流：

```
对话进来
  │
  ▼
getSessionMessages(sid) ── SQLite 读取全部历史
  │
  ▼
truncateHistory() ── 按 800 token 预算截断
  │  ├─ 超预算的旧消息 → summarizeMessages() → 写入 chat_sessions.summary
  │  └─ 最近的 N 条 → 保留原文
  │
  ▼
[摘要] + [最近消息] + [当前用户消息]
  │
  ▼
[systemPrompt:200] + [ragContext:1000] + [history:800] + [user:200] + [response:1800]
  │
  ▼
LLM
```

下面逐步展开每个环节的实现。

---

## 第一步：上下文预算管理器

新建 `lib/context-budget.js`，统一管理 LLM 上下文窗口的 token 分配。

### 预算分配

基于 Qwen3.5-9B-4bit 约 4K 的上下文窗口：

```javascript
const DEFAULT_BUDGET = {
  systemPrompt: 200,    // 系统提示词
  ragContext:   1000,   // RAG 检索结果（观点内容）
  history:      800,    // 对话历史（超了就摘要压缩）
  userMessage:  200,    // 当前用户消息
  responseSpace: 1800,  // AI 回答空间
};
// 总计 ≈ 4000 tokens
```

为什么这么分？核心思路是**给 RAG context 和对话历史各留够空间，同时保证 AI 有足够的回答空间**。回答空间给得最大（1800 token），因为如果 AI 的回答被截断，用户体验最差。

### Token 估算

精确的分账需要知道每段文本占多少 token。但本地模型没有 tokenizer API，我们用一个简化的估算公式：

```javascript
function estimateTokens(text) {
  if (!text) return 0;
  // 中文字符数
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  // 非中文字符数
  const nonCjkLen = text.length - cjkCount;
  // 中文 1.5 token/字，非中文约 0.5 token/字符
  return Math.ceil(cjkCount * 1.5 + nonCjkLen * 0.5);
}
```

这个估算的误差在 ±20%，但对于预算控制足够——我们不需要精确到个位，只需要知道"这段文本大概占多少预算"。

### 观点截断：短观点让额度给长观点

多条观点共享 `ragContext` 预算时，不能简单平均分配——短观点用不了那么多，长观点又不够用。采用两轮分配策略：

```javascript
function truncateViewpoints(viewpoints, totalTokens) {
  // 每条观点的元数据（作者、日期、股票、动作）大约占 50 token
  const METADATA_TOKENS = 50;
  const availableTokens = totalTokens - (METADATA_TOKENS * viewpoints.length);

  // 第一步：短观点先拿到需要的量
  for (const vp of viewpoints) {
    const contentTokens = estimateTokens(vp.content);
    const itemBudget = perItem - METADATA_TOKENS;
    if (contentTokens <= itemBudget) {
      // 短观点，不需要截断，省下的预算留给长观点
      results.push({ ...vp, wasTruncated: false });
      remainingBudget -= contentTokens + METADATA_TOKENS;
    } else {
      longItems.push(vp);
    }
  }

  // 第二步：剩余预算分配给长观点
  const perLong = Math.floor(remainingBudget / longItems.length) - METADATA_TOKENS;
  for (const vp of longItems) {
    results.push({
      truncatedContent: truncateToTokens(vp.content, perLong),
      wasTruncated: true,
    });
  }
}
```

截断时保持句子完整性——在句号、换行处断开，不会把一句话切成两半：

```javascript
function truncateToTokens(text, maxTokens) {
  const targetChars = Math.floor(maxTokens / 1.2);
  const truncated = text.substring(0, targetChars);
  // 在句号/换行处断开
  const sentenceEnd = truncated.lastIndexOf(/[。！？\n；]/);
  if (sentenceEnd > targetChars * 0.6) {
    return truncated.substring(0, sentenceEnd + 1) + '...';
  }
  return truncated + '...';
}
```

### 对话历史截断：保留最近的

对话历史的截断策略和观点不同——观点是"每条都可能有用"，对话历史是"越近越重要"。所以从最近的消息开始保留：

```javascript
function truncateHistory(messages, maxTokens) {
  const reversed = [...messages].reverse();
  const kept = [];
  let totalTokens = 0;

  for (const msg of reversed) {
    const tokens = estimateTokens(msg.content);
    if (totalTokens + tokens > maxTokens && kept.length > 0) break;
    kept.unshift(msg);
    totalTokens += tokens;
  }

  return { messages: kept, removedCount: messages.length - kept.length };
}
```

---

## 第二步：会话持久化

从内存 Map 迁移到 SQLite。新增两张表：

```sql
-- 聊天会话表
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,                        -- sessionId
  summary TEXT DEFAULT NULL,                  -- 旧对话的压缩摘要
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- 聊天消息表
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant')),
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
```

为什么不用 Redis？因为 SQLite 单文件方案和现有架构一致——项目已经用 better-sqlite3 管理所有数据，不需要为了会话存储引入新依赖。2000 条观点的 embedding 索引只占 6.4 MB 内存，对话消息的数据量更小，SQLite 完全够用。

CRUD 操作封装为三个函数：

```javascript
function getOrCreateSession(sid) {
  const db = getDb();
  let session = db.prepare('SELECT id, summary FROM chat_sessions WHERE id = ?').get(sid);
  if (!session) {
    db.prepare('INSERT INTO chat_sessions (id) VALUES (?)').run(sid);
    session = { id: sid, summary: null };
  }
  return session;
}

function getSessionMessages(sid) {
  const db = getDb();
  return db.prepare(
    'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id'
  ).all(sid);
}

function saveMessage(sid, role, content) {
  const db = getDb();
  db.prepare(
    'INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)'
  ).run(sid, role, content);
  db.prepare(
    "UPDATE chat_sessions SET updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(sid);
}
```

改造后的效果：**服务重启不丢数据**，且查询效率与内存 Map 相当（SQLite 对小数据量的读取是微秒级）。

---

## 第三步：摘要压缩——让旧对话不占窗口

对话历史超出 `history` 预算时，不是直接丢弃旧消息，而是压缩成一段摘要。

### 摘要生成：LLM 优先，简单拼接降级

```javascript
async function summarizeMessages(messages) {
  if (messages.length === 0) return '';

  const conversationText = messages.map(m =>
    `${m.role === 'user' ? '用户' : '助手'}: ${m.content.substring(0, 200)}`
  ).join('\n');

  const summaryPrompt = `请用3-5句话总结以下对话的关键信息，
保留用户关注的股票、作者、观点倾向：

${conversationText}

摘要：`;

  // 优先用 LLM 生成摘要
  if (ragChat.isConfigured()) {
    try {
      const summary = await ragChat.chatOnce([
        { role: 'system', content: '/no_think\n你是摘要助手，只输出摘要，不要多余内容。' },
        { role: 'user', content: summaryPrompt },
      ]);
      if (summary && summary.trim()) return summary.trim();
    } catch (e) {
      console.warn('[chat] 摘要生成失败，使用简单拼接:', e.message);
    }
  }

  // 降级：简单拼接关键信息
  const userMsgs = messages.filter(m => m.role === 'user');
  const topics = userMsgs.map(m => m.content.substring(0, 50)).join('；');
  return `之前对话涉及：${topics}`;
}
```

为什么需要降级？因为 LLM 可能未配置或超时，系统不能因此挂掉。

### 摘要的增量更新

当对话继续进行，又有旧消息被裁剪时，不是重新对所有历史做摘要，而是**把新增的旧消息追加到已有摘要上**：

```javascript
async function buildHistoryMessages(sid) {
  const budget = contextBudget.getBudget();
  const allMessages = getSessionMessages(sid);
  const session = getOrCreateSession(sid);

  // 先尝试直接截断到预算内
  const { messages: truncated, trimmed, removedCount } =
    contextBudget.truncateHistory(allMessages, budget.history);

  if (!trimmed) return truncated;

  // 有旧消息被裁剪了，需要压缩
  const removedMessages = allMessages.slice(0, removedCount);
  const keptMessages = allMessages.slice(removedCount);

  // 合并已有摘要 + 新被裁剪的消息
  let newSummary;
  const oldSummary = session.summary || '';
  if (oldSummary) {
    const appendText = removedMessages.map(m =>
      `${m.role === 'user' ? '用户' : '助手'}: ${m.content.substring(0, 100)}`
    ).join('\n');
    newSummary = await summarizeMessages([
      { role: 'user', content: `已有摘要：${oldSummary}\n\n新增对话：\n${appendText}` },
    ]);
  } else {
    newSummary = await summarizeMessages(removedMessages);
  }

  // 持久化摘要
  updateSessionSummary(sid, newSummary);

  // 返回：摘要 + 保留的最近消息
  const result = [];
  if (newSummary) {
    result.push({ role: 'system', content: `[之前对话摘要]\n${newSummary}` });
  }
  result.push(...keptMessages);
  return result;
}
```

这样，无论对话多长，给 LLM 的历史消息永远控制在预算内：

```
原来：[消息1] [消息2] ... [消息20] [消息21]  ← 超预算
         │                              │
         ▼                              ▼
压缩后：[摘要：用户关注茅台和白酒行业...] [消息18] [消息19] [消息20] [消息21]
        ↑ ~200 token                          ↑ ~600 token
```

20 轮对话原文约 4000 token，压缩后只要 ~800 token，同样窗口能承载更多轮次。

---

## 第四步：集成——RAG 截断也接入预算

`rag-chat.js` 的 `retrieveContext()` 也接入 context-budget，长观点按预算截断：

```javascript
async function retrieveContext(query, options = {}) {
  // ... 语义检索 ...

  // 用 context-budget 管理截断
  const budget = contextBudget.getBudget();

  // 获取完整观点内容
  const fullViewpoints = db.prepare(`
    SELECT v.id, v.content, v.published_at, a.name AS author_name
    FROM viewpoints v JOIN authors a ON v.author_id = a.id
    WHERE v.id IN (${ids.map(() => '?').join(',')})
  `).all(...ids);

  // 按 ragContext 预算截断长观点
  const viewpointData = results.map(r => ({
    viewpointId: r.viewpointId,
    content: (vpMap.get(r.viewpointId) || {}).content || r.content,
  }));
  const truncated = contextBudget.truncateViewpoints(viewpointData, budget.ragContext);
  const truncatedMap = new Map(truncated.map(t => [t.viewpointId, t]));

  // 拼 context（使用截断后的内容）
  const contextParts = results.map((r, idx) => {
    const truncInfo = truncatedMap.get(r.viewpointId) || {};
    const contentText = truncInfo.truncatedContent || vp.content || r.content;
    const truncNote = truncInfo.wasTruncated
      ? '\n(内容过长已截断，完整观点请查看原文)' : '';

    return `[观点${idx + 1}] (相似度:${(r.score * 100).toFixed(0)}%)
作者: ${vp.author_name}
日期: ${pubDate}
股票: ${stocks.join(', ') || '未关联'}
交易动作: ${actionStr}
内容: ${contentText}${truncNote}`;
  });
}
```

被截断的观点会追加提示 `"(内容过长已截断，完整观点请查看原文)"`，让用户知道信息可能不完整。

---

## 改造前 vs 改造后

### 代码变更一览

| 文件 | 改动 |
|------|------|
| `lib/context-budget.js` | **新增** — 上下文预算管理器（~200 行） |
| `schema.sql` | **新增** — `chat_sessions` + `chat_messages` 两张表 |
| `lib/rag-chat.js` | **改造** — `retrieveContext()` 集成 `truncateViewpoints()` |
| `routes/chat.js` | **重写** — 内存 Map → SQLite 持久化 + 摘要压缩 + 预算集成 |

### 数据库变更

已在运行中的 `data.db` 创建了 `chat_sessions` 和 `chat_messages` 表。数据库从 7 张表扩展到 9 张：

| 表 | 用途 |
|----|------|
| chat_sessions | 会话元数据 + 压缩摘要 |
| chat_messages | 会话消息（user/assistant 交替） |

### 运行效果对比

| 场景 | 改造前 | 改造后 |
|------|--------|--------|
| 服务重启 | 所有对话丢失 | SQLite 持久化，重启不丢 |
| 长观点 | 全文塞入，可能撑爆窗口 | 按预算截断，句子级断开 |
| 对话 20+ 轮 | 硬截断，旧信息丢失 | 摘要压缩，关键信息保留 |
| RAG + 历史 | 各自膨胀，互相挤压 | 统一预算，各占各的份额 |
| 跨会话 | 无记忆 | 摘要持久化，新会话可加载 |

---

## 关于分块（Chunking）的思考

上面的改造是"最小改动"方案——不做 embedding 层面的分块，只在检索结果拼接时做截断。这对当前数据够用，因为爱股票 API 返回的每条消息本身就是短文本（几十到几百字），天然就是"1 条观点 = 1 个 chunk"。

但如果未来接入了长文档数据源（研报 PDF、长篇分析），就需要在 embedding 索引层面做分块。三个层次的方案：

| 方案 | 做法 | 优势 | 局限 |
|------|------|------|------|
| **A. 检索截断** | 只在 `retrieveContext()` 中截断长观点 | 零侵入，不改索引 | 长观点后半段不可检索 |
| **B. 滑动窗口分块** | 超阈值观点切分为多个 chunk，各生成 embedding | 解决 embedding 稀释问题 | embedding 数量膨胀 |
| **C. 语义分块** | 按话题转换点切分，元数据增强 embedding | 检索精度最高 | 实现复杂度最大 |

当前采用方案 A。如果后续检索质量不够，可以逐步升级到方案 B 和 C。这也是上下文预算管理器的价值——不管分块策略怎么变，预算管理逻辑不用改，因为它是"分完块之后怎么把结果塞进窗口"的问题，和"怎么分块"是解耦的。

---

## 写在最后

从"对话没记忆"和"长观点撑爆窗口"两个表面问题，到发现它们争抢同一个瓶颈，再到统一做一个预算管理器——这个过程比写代码本身更有价值。

RAG 系统里，检索和记忆不是两个独立模块，而是共享同一个有限资源的两个竞争者。如果分别优化、各自膨胀，它们会在上下文窗口里互相踩踏。只有统一做预算，让每个模块知道自己的份额，系统才能真正稳定运行。

这个原则不只适用于 RAG——任何需要在有限上下文里装多种信息的 LLM 应用，都可以参考这个"预算管理"的思路。

---

*本系列其他文章：*

1. [构建炒股 Agent（一）：从投资观点到交易信号 —— 构建一个 NLU 规则引擎](/post/ai/01-viewpoint_miner-rule-engine/)
2. [构建炒股 Agent（二）：MCP Server —— 让 LLM 直接调用你的数据系统](/post/ai/02-viewpoint_miner-mcp-server/)
3. [构建炒股 Agent（三）：Skills —— 把工具链变成 AI 的专业技能](/post/ai/03-viewpoint_miner-skills/)
4. [构建炒股 Agent（四）：让 LLM 读懂投资观点 —— 本地化 RAG 语义搜索的完整实现](/post/ai/04-viewpoint_miner-rag/)
