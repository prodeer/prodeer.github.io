+++
date = '2026-05-24T10:00:00+08:00'
draft = false
title = '从股票观点系统到 Agent 应用（四）：本地 RAG 与语义检索'
categories = ['AI 大模型']
series = ['viewpoint_miner']
+++

一个已有数据但"读不懂"的系统，如何一步步获得语义搜索和 AI 对话能力？
<!--more-->

网站投入使用后，积累了几千条观点。这个数据量不大，用 SQL LIKE 查询完全足够。它每天自动抓取多位股评作者的观点，用纯规则引擎提取交易信号（建仓、减仓、止盈、止损等），然后以时间线的方式呈现给用户。

但有个痛点：**搜索只能靠关键词匹配。**

搜"茅台"能找到提到茅台的观点，但搜"白酒龙头"却找不到——尽管很多观点讨论的就是茅台。搜"看空"能匹配到原文有"看空"二字的，但"不乐观""谨慎""风险较大"这些表述就搜不到。

更具体地说，关键词搜索在以下场景完全失效：

| 维度 | 关键词 LIKE | 语义搜索 |
|---|---|---|
| "北向资金买什么" | 只匹配含"北向资金"+"买"的记录 | 有机会召回"外资流入""北上加仓"等近义表达 |
| "某某最近在看什么" | 需要知道作者写了哪些股票名 | 可按语义相似度召回相关讨论，再结合作者过滤 |
| "市场情绪如何" | 很难靠单一关键词表达 | 可召回"情绪回暖""恐慌释放""分歧加大"等候选材料 |
| 排序 | 按时间排序，相关性未知 | 按语义相似度排序，最相关的排前面 |
| 误匹配 | 容易被同词异义和否定表达干扰 | 仍可能混淆否定、反讽和相近话题，需要评测与阈值过滤 |

![关键词 vs 语义搜索](/images/viewpoint_miner/keyword-vs-semantic.svg)

语义搜索不是替代关键词搜索，而是补充词面匹配。它把文本映射成向量后寻找相近内容，但"向量接近"不等于真正理解，更不等于结论正确。

于是，RAG（Retrieval-Augmented Generation，检索增强生成）进入了我的视野。

---

## 项目背景

先交代一下技术栈和系统现状，方便后文理解：

| 维度 | 选型 |
|------|------|
| 后端 | Express + better-sqlite3 |
| 前端 | 原生 JS（无框架），单页应用 |
| 数据库 | SQLite；当前版本共 10 张表，包含业务、向量、通知与会话数据 |
| Embedding | m3e-base（768 维中文向量模型），Python 子进程 |
| MCP Server | 27 个工具，通过 stdio 与 Agent 客户端通信 |
| 交易信号提取 | 纯规则引擎，不依赖 LLM |
| LLM 推理 | oMLX 本地推理，Qwen3.5-9B-MLX-4bit（4bit 量化） |

关键数字：**2177 条观点**已经建好了向量索引，占内存 **6.4 MB**。

## RAG 是什么？为什么选它？

RAG 的核心思路用一句话概括：**先检索，再生成。**

传统搜索是"搜到什么给你看什么"；RAG 是"搜到相关内容后，让 LLM 读一遍，再用自己的话回答你"。

为什么不用纯 LLM？因为：
1. **我的数据是私有的**——股评作者的观点不在训练集里，LLM 不知道
2. **实时性**——今天的观点，LLM 昨天还没见过
3. **可追溯性**——回答可以附上检索来源，便于用户核对；RAG 只能降低无依据生成的概率，不能保证事实正确

为什么不用 Fine-tuning？因为：
1. **目标不同**——微调更适合改变行为或输出风格，不适合把持续变化的观点当作可更新知识库
2. **数据在变**——RAG 可以增量更新索引，不需要每次重新训练
3. **成本可控**——embedding 可以本地增量生成，但检索后的 LLM 生成仍有计算成本，并不是"推理成本为零"

所以 RAG 是最务实的选择。

## 架构全景：从数据到智能的三层设计

![RAG 架构图：三层阶段递进 + 内部数据流](/images/viewpoint_miner/rag-architecture.svg)


整个 RAG 能力分为三个阶段：

| 阶段 | 能力 | 核心价值 |
|------|------|---------|
| Phase 0 | Embedding 索引 + MCP 工具 | 数据有了向量表示，但只在 MCP 客户端可用 |
| Phase 1 | 语义搜索 Web UI | 用户在浏览器里就能语义搜索，还能看"相关观点" |
| Phase 2 | RAG Chat 对话界面 | AI 读了检索结果后用自己的话回答，附引用来源 |

下面逐层展开。

---

## Phase 0：RAG 的"地基" — embedding 模型

选 embedding 模型时只有两个要求：**中文效果好、能离线跑。**

候选：

| 模型 | 维度 | 优势 | 劣势 |
|---|---|---|---|
| OpenAI `text-embedding-3-small/large` | 维度可配置 | 托管服务，接入简单 | 有调用成本，数据需发送到服务端 |
| bge-large-zh 系列 | 约 1024 | 中文检索常用基线 | 本地资源占用较高 |
| m3e-base | 768 | 体积相对小，可离线运行 | 需要自己部署，效果必须用本项目语料验证 |

选了 m3e-base。理由很实际：

1. 模型体积约 **420MB**，可以在 CPU 上运行；实际冷启动在我的环境中达到 40-60 秒，不能写成固定 5 秒
2. **768 维**向量比 1024 维占用更少，但维度更小不直接等于检索更快或效果更好
3. **ModelScope 国内镜像**可用，不受 HuggingFace 网络限制

模型路径通过环境变量控制：

```python
_default_model_path = os.path.expanduser('~/.cache/modelscope/Jerry0/m3e-base')
model_name = os.environ.get('EMBEDDING_MODEL_PATH', _default_model_path)
```

模型下载后可以从本地缓存加载。迁移机器时还要确认依赖版本、目录权限和模型文件完整性，不能只假设复制缓存目录就一定可用。

---

### Embedding 生成：Python 子进程的 stdin/stdout 协议

为什么用 Python 子进程而不是 HTTP 服务？因为本地单机部署不需要额外端口，Node.js 可以直接通过 stdin/stdout 通信。但子进程仍需要启动超时、退出清理、异常检测和必要时重启，并不等于"不需要进程管理"。

通信协议极简——JSON Lines：

```
Node.js → Python:  {"id": 1, "text": "白酒龙头近期承压"}
Python → Node.js:  {"id": 1, "embedding_b64": "base64编码的float32向量"}
```

Python 端（`embedding-service.py`）核心只有 20 行：

```python
from sentence_transformers import SentenceTransformer
model = SentenceTransformer(model_name)

# 就绪信号
print(json.dumps({"status": "ready", "dim": model.get_sentence_embedding_dimension()}))

# 主循环：逐行读 JSON，编码后返回
for line in sys.stdin:
    req = json.loads(line)
    vec = model.encode(req['text'], normalize_embeddings=True)
    packed = struct.pack(f'{len(vec)}f', *vec)
    print(json.dumps({"id": req['id'], "embedding_b64": base64.b64encode(packed).decode()}))
```

注意 `normalize_embeddings=True`——归一化后，余弦相似度 = 向量点积，省去了分母的计算。

---

### 向量存储与索引：SQLite BLOB + 内存 Float32Array

没有用 Pinecone、Milvus 这些向量数据库，因为数据量小（2000+ 条）、查询场景简单（只做 top-K 相似度搜索），杀鸡不需要牛刀。

Pinecone、Milvus 或 HNSW 一类方案主要解决更大规模、过滤和运维需求。当前只有几千条向量，线性扫描实现简单且延迟可接受；是否比近似索引更快需要 benchmark，不能仅凭数据规模下结论。数据增长后，查询是 O(N)，逐条扩容数组还可能带来额外拷贝成本。

**持久化**：SQLite 的 BLOB 字段存 base64 解码后的 float32 向量。

**内存索引**：启动时从 SQLite 加载所有向量，拼成一个扁平 `Float32Array`。搜索时用 `for` 循环批量算点积：

索引结构：

```javascript
let viewpointEmbeddings = new Map();  // viewpointId → Float32Array
let embeddingArray = null;            // 扁平 Float32Array，所有向量拼接
let idArray = null;                   // viewpointId 数组，与 embeddingArray 对应
```

三层变量各司其职：
- `viewpointEmbeddings` Map：按 ID 快速查找单个向量，用于增删操作
- `embeddingArray` 扁平数组：批量相似度计算的连续内存布局，最大化 CPU 缓存命中
- `idArray`：与扁平数组位置一一对应，用来把索引位置映射回 viewpoint ID

加载索引时，从 SQLite 读 BLOB，解码为 Float32Array，拼成扁平数组：

```javascript
function loadIndex() {
  const rows = db.prepare('SELECT viewpoint_id, embedding FROM viewpoint_embeddings').all();
  const vectors = [];
  idArray = [];
  for (const row of rows) {
    const vec = b64ToVec(row.embedding.toString('base64')); // BLOB → base64 → Float32Array
    vectors.push(vec);
    idArray.push(row.viewpoint_id);
  }
  embeddingArray = new Float32Array(vectors.length * dim);
  for (let i = 0; i < vectors.length; i++) {
    embeddingArray.set(vectors[i], i * dim);
  }
}
```

2177 条 × 768 维 = 6.4 MB 连续内存。一个现代 CPU 的 L3 缓存（通常 8-32 MB）完全装得下。

---

### 增量索引：索引怎么保持新鲜？

全量索引通过 `node scripts/build-embeddings.js` 完成，支持三种模式：

```bash
node scripts/build-embeddings.js              # 增量：只索引未生成的
node scripts/build-embeddings.js --force      # 强制重建全部
node scripts/build-embeddings.js --limit 100  # 测试模式，只跑前 100 条
```

日常增量则由 `cron.js` 每日同步脚本自动处理——同步新观点后，自动调用 `indexViewpoint` 生成 embedding：

```javascript
// cron.js 中的同步钩子
for (const v of newViewpoints) {
  await semanticSearch.indexViewpoint(v.id, v.content);
}
```

`addToIndex` 同时更新三层存储：

```javascript
function addToIndex(viewpointId, vec) {
  // 1. SQLite 持久化
  const b64 = vecToB64(vec);
  db.prepare('INSERT OR REPLACE INTO viewpoint_embeddings ...').run(...);

  // 2. 内存索引：替换已有 OR 追加新
  const old = viewpointEmbeddings.get(viewpointId);
  if (old) {
    const idx = idArray.indexOf(viewpointId);
    embeddingArray.set(vec, idx * dim);  // 原地替换
  } else {
    // 扩容扁平数组，追加到末尾
    const newArray = new Float32Array((oldLen + 1) * dim);
    newArray.set(embeddingArray);
    newArray.set(vec, oldLen * dim);
    embeddingArray = newArray;
    idArray.push(viewpointId);
  }
  viewpointEmbeddings.set(viewpointId, vec);
}
```

这样每天的 cron 任务跑完后，新观点自动进入向量索引，无需人工干预。

### MCP Server：27 个工具，但浏览器不会自动获得这些能力

已有的 27 个 MCP 工具中，包含 `semantic_search_viewpoints`、`index_viewpoint_embedding` 等语义搜索工具。浏览器前端使用的是 HTTP API，不会因为 MCP Server 存在就自动获得这些能力。

所以 Phase 1 的核心任务就是：**把 MCP 工具的能力，通过 Web API 暴露给前端。**

---

## Phase 1：语义搜索 Web UI——让浏览器"看懂"观点

Phase 1 的核心是打通一条从"用户输入"到"语义结果"的完整管线：

![RAG 搜索流程图](/images/viewpoint_miner/rag-search-flow.svg)


### 后端：三条 API 暴露语义搜索能力

新建 `routes/search.js`，注册三条 API：

| 路由 | 方法 | 功能 |
|------|------|------|
| `/api/search/semantic` | POST | 语义搜索观点 |
| `/api/search/semantic/stats` | GET | 索引统计（条数、内存、就绪状态） |

同时给已有的 `routes/viewpoints.js` 加一条：

| 路由 | 方法 | 功能 |
|------|------|------|
| `/api/viewpoints/:id/related` | GET | 获取某条观点的相关观点 |

关键设计决策：**服务未就绪时返回 503 而不是阻塞等待。**

```javascript
router.post('/semantic', async (req, res) => {
  const stats = semanticSearch.getStats();
  if (!stats.ready) {
    return res.status(503).json({
      error: '语义搜索服务正在启动中，请稍后重试',
      ready: false,
    });
  }
  // ... 执行搜索
});
```

为什么？因为本机冷启动可能需要 40-60 秒，如果第一个请求同步等待，用户体验很差。更好的做法是服务器启动时预热，未就绪时返回 503，让前端展示"服务加载中"并稍后重试。

**服务器预热**——在 `server.js` 的 `app.listen` 回调中触发：

```javascript
app.listen(PORT, () => {
  const semanticSearch = require('./lib/semantic-search');
  semanticSearch.init().then(() => {
    console.log(`[语义搜索] 服务就绪: ${stats.total} 条向量, 内存 ${stats.memoryMB} MB`);
  }).catch(err => {
    console.warn(`[语义搜索] 服务启动失败: ${err.message}`);
  });
});
```

### 前端：搜索模式切换 + 相关观点面板

**搜索模式切换**：在搜索框上方加了一排按钮，用户可以在"关键词"和"语义"两种模式间切换。

![RAG 架构图](/images/viewpoint_miner/rag-web-demo.png)


切换模式后，如果搜索框里有内容，会立刻以新模式重新搜索。两种搜索的体验差异非常大：

- 关键词搜索：精确匹配，搜"茅台"只能找到含"茅台"的观点
- 语义搜索：理解意图，搜"白酒龙头"也能找到讨论茅台的观点

### 踩坑记录

#### 1. better-sqlite3 的 NODE_MODULE_VERSION 不匹配

报错：
```
Error: The module was compiled against a different Node.js version using NODE_MODULE_VERSION 137
```

原因：managed node（v22.22.2, MODULE_VERSION=127）与 better-sqlite3 编译时的系统 node（v24.4.1, MODULE_VERSION=137）不兼容。

解决：**必须用系统 node 启动服务器**：
```bash
/opt/homebrew/bin/node server.js
```

#### 2. Python embedding service 找不到 sentence_transformers

`python3` 默认解析到 managed Python 3.13，而 `sentence_transformers` 装在系统 Python 3.9 下。

解决：硬编码系统 Python 路径，并支持环境变量覆盖：
```javascript
const pythonCmd = process.env.PYTHON_CMD || '/usr/bin/python3';
```

#### 3. Embedding service 启动超时

默认 30 秒超时，但 m3e-base 模型加载需要 40-60 秒。

解决：超时时间增加到 120 秒。

#### 4. 并发 init 导致多个 Python 子进程

多个请求同时触发 `init()` 时，可能启动多个 Python 子进程。

解决：加入 `initPromise` 锁：
```javascript
async function init() {
  if (ready) return;
  if (initPromise) return initPromise; // 防止并发
  initPromise = (async () => {
    await startEmbeddingService();
    loadIndex();
  })();
  return initPromise;
}
```

---

## Phase 2：RAG Chat 对话界面——让系统"开口说话"

### Phase 1 vs Phase 2：到底有什么区别？

这是我最常被问到的问题。用一个类比来解释：

**Phase 1 是图书管理员**——你问他"有没有关于白酒行业观点的书"，他给你搬来一摞书，你自己读。

**Phase 2 像研究助手**——你问"大家对白酒行业怎么看"，系统先找相关材料，再让 LLM 组织摘要，并把检索来源一并展示。来源列表提供追溯入口，但不代表每个生成结论都自动完成了逐句引用校验。

技术上的区别：

| 维度 | Phase 1 语义搜索 | Phase 2 RAG Chat |
|------|-----------------|-----------------|
| 输出 | 原始观点列表（原文） | LLM 生成的回答（总结/对比/分析） |
| 处理方式 | 只做向量相似度匹配 | LLM 基于检索材料重新组织语言 |
| 交互方式 | 单次搜索 | 多轮对话（有上下文记忆） |
| 引用 | 展示原文与相似度 | 返回来源列表并要求回答标注作者，仍需用户核对支持关系 |
| 适合场景 | "我想看关于 X 的原始观点" | "帮我总结/对比/分析 X" |

用更直观的流程图：

```
Phase 1（语义搜索）：
  用户输入 → Embedding → 向量搜索 → 返回相似观点列表

Phase 2（RAG Chat）：
  用户输入 → Embedding → 向量搜索 → 拼装上下文 → LLM 生成回答 → 流式返回
                                         ↑                ↓
                                    （检索增强）      （引用溯源）
```

Phase 2 在 Phase 1 的基础上多了两个关键环节：**上下文拼装**和 **LLM 生成**。

### 后端：检索 → 拼 Prompt → 调 LLM → 流式返回

核心模块 `lib/rag-chat.js`，只做四件事：

**① 检索上下文**——`retrieveContext(query)`

```javascript
async function retrieveContext(query, options = {}) {
  // 1. 语义检索 top-K 相关观点
  const results = await semanticSearch.searchSimilar(query, { limit: cfg.topK, minScore: cfg.minScore });

  // 2. 获取完整观点内容（搜索只返回前 200 字）
  // 3. 获取关联股票和交易动作
  // 4. 拼装结构化上下文
  return { context: "结构化的观点文本...", sources: [...] };
}
```

拼出来的上下文长这样：

```
[观点1] (相似度:78%)
作者: 张三
日期: 2025/6/3
股票: 贵州茅台(600519)
交易动作: 贵州茅台:减仓(1800)
内容: 白酒龙头近期承压，短期看空至1700...

[观点2] (相似度:72%)
作者: 李四
...
```

**② System Prompt**——约束 LLM 的行为

```javascript
const SYSTEM_PROMPT = `/no_think
你是"股票观点分析助手"，专门帮助用户理解和分析股票市场观点。

回答规则：
- 必须基于检索到的观点回答，不要编造不存在的观点
- 引用观点时标注来源作者（如：据[张三]观点...）
- 如果检索到的观点不足以回答问题，如实说明
- 对于投资建议类问题，提醒用户"以上仅为观点汇总，不构成投资建议"
- 用中文回答，简洁有条理`;
```

注意开头的 `/no_think`——这是给 Qwen3.5 模型的指令，要求它不要进入"思考模式"。原因后面踩坑部分会讲。

**③ 流式调用 LLM**——`streamChat(messages, onChunk, onDone, onError)`

使用 Node.js 原生 `http`/`https` 模块，不依赖 OpenAI SDK，因为要兼容本地 oMLX 推理服务：

```javascript
const body = JSON.stringify({
  model: cfg.model,
  messages,
  max_tokens: cfg.maxTokens,
  temperature: cfg.temperature,
  stream: true,
  // Qwen3.5: 禁用思考模式以加速响应
  extra_body: { chat_template_kwargs: { enable_thinking: false } },
});
```

**④ Chat API 路由**——`routes/chat.js`

```
POST /api/chat          → SSE 流式对话
GET  /api/chat/config   → LLM 配置状态（不暴露 key）
DELETE /api/chat/history/:sessionId → 清空会话
```

这一版会话历史先存在内存 `Map`，每会话保留最近 20 轮；第 5 篇会继续把它改成 SQLite 持久化和统一上下文预算。这里不直接引入 Redis，因为本地单机部署没有这个必要。

SSE 事件类型：

| 事件 | 数据 | 用途 |
|------|------|------|
| `sources` | `{sources: [...]}` | 先发引用信息 |
| `chunk` | `{content: "..."}` | 逐块返回 LLM 输出 |
| `done` | `{sessionId: "..."}` | 生成完成 |
| `error` | `{error: "..."}` | 出错 |

### 前端：SSE 流式对话 + 引用溯源

![RAG Chat demo](/images/viewpoint_miner/rag-ai-demo.png)

**Chat 面板**：新增"AI 对话"Tab，包含消息区域、输入框、发送按钮和快捷建议。

**SSE 流式渲染**：用 `ReadableStream` 逐块读取 SSE 事件，实时更新 AI 气泡内容：

### 踩坑记录

#### 1. Qwen3.5 的 reasoning_content 字段

问题：Qwen3.5 模型默认开启"思考模式"，SSE 返回的 `delta` 里有两个字段：`content`（正式输出）和 `reasoning_content`（思考过程）。如果只取 `content`，前期只有 `reasoning_content` 有内容，用户会看到空白气泡等待很久。

解决：两个字段都取，优先 `content`：
```javascript
const content = delta.content || delta.reasoning_content;
```

#### 2. /no_think 在 oMLX 中不起作用

问题：在 System Prompt 开头加了 `/no_think`，但 oMLX 的实现不识别这个指令，模型依然会先"思考"30-60 秒才输出正式内容。

解决：通过 oMLX 的 `extra_body` 参数禁用思考模式：
```javascript
extra_body: { chat_template_kwargs: { enable_thinking: false } }
```
`/no_think` 保留作为兼容层（万一换成其他推理框架可能有效）。

#### 3. 本地 LLM 的上下文窗口限制

问题：无论模型宣称的最大窗口多大，本地可用显存/内存、首 token 延迟和输出预算都会限制实际可用上下文。默认 top-K=8、完整观点和对话历史叠加后，输入会快速膨胀。

早期临时方案是降低 top-K、限制输出 token，并只保留最近对话；当前代码默认 top-K=8、`max_tokens=2048`，由第 5 篇引入的 context-budget 对检索内容和历史分别限额。参数应结合真实延迟和召回评测调整，而不是固定照抄。

---

## 写在最后

从"关键词搜索"到"AI 对话"，整个改造的核心增量代码其实不多，关键不是代码量，而是**分层设计**：

1. **数据层**（embedding + 索引）先行，保证"能搜"
2. **搜索层**（API + 前端）让用户"能看"
3. **生成层**（RAG Chat）让系统"能说"

每一层都独立可用、可测试。

语义搜索让系统从精确查询扩展到相似内容召回。RAG 不是魔法，它是一条需要分别评测的工程链路：检索错了，生成没有可靠依据；检索对了，模型仍可能遗漏、曲解或过度概括。至少要分别观察 Recall@K、无答案问题的拒答表现和回答对引用的忠实度。

---
