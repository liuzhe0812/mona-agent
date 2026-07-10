# Mona 三信息源统一检索方案 — KB / Notes / Hoard

> 日期:2026-07-07
> 范围:统一 Mona 三个信息源(KB / Notes / Hoard)的检索能力,新建 Hoard 模块,并修复 KB/Notes 的检索缺陷
> 前置决策:
> - [2026-07-07 Hoard Agent 记忆基础设施设计](./2026-07-07-hoard-agent-memory-design.md)(本方案取代其检索部分)
> - [2026-07-06 笔记知识库设计](./2026-07-06-notes-knowledge-base-design.md)
> 核心目标:
> - 没配置 embedding:三个信息源统一用 **SQLite FTS5 + BM25**
> - 配置了 embedding:三个信息源统一升级为 **FTS5 + vector + RRF 融合**
> - 不做 RAG 自动注入(避免幻觉)
> - 修复 `kb_search` 工具不调 hybrid 的 bug
> - Notes 从内存子串匹配升级为 FTS5

---

## 一、现状问题

### 1.1 三个信息源的检索能力参差不齐

| 信息源 | 数据存储 | 当前检索方式 | 问题 |
|--------|----------|-------------|------|
| KB | `<KB_ROOT>/<project>/wiki/*.md` | 文件扫描 + 自实现 token 计分([search.py:104](../mona/kb/search.py#L104)) | 每次搜索遍历所有文件;无 BM25;中文分词弱 |
| Notes | `<vault>/**/*.md` | 内存子串匹配([notes.rs:1534](../src-tauri/src/notes.rs#L1534)) | 全部加载到内存;`String::contains` 子串匹配;无排序;无分词 |
| Hoard | 不存在 | — | 需新建 |

### 1.2 KB 模块的两个入口检索不一致

`mona/kb/` 对外暴露两个入口:

| 入口 | 文件 | 检索函数 | 是否读 embedding |
|------|------|----------|----------------|
| HTTP API | [kb/api.py:441](../mona/kb/api.py#L441) `handle_kb_search` | `search_wiki_hybrid` | ✅ 读 |
| Agent Tool | [kb/tool.py:37](../mona/kb/tool.py#L37) `KbSearchTool` | `search_wiki` | ❌ **不读**(bug) |

同一个 KB 项目,前端搜能用到向量,Agent 搜用不到。这是 bug,需修复。

### 1.3 Notes 曾有 FTS5 但被删了

[notes.rs:510-513](../src-tauri/src/notes.rs#L510-513) `drop_legacy_tables` 里 `DROP TABLE IF EXISTS notes_fts` —— 迁移到 vault 文件模式时把 FTS5 表扔了,降级为内存子串匹配。

### 1.4 没有 embedding 时三条路径全弱

当前 `EmbeddingConfig.enabled` 默认 `False`,用户不配置时:
- KB:纯 token 计分(自实现,弱)
- Notes:Rust 侧 substring(更弱)
- Hoard:不存在

---

## 二、目标架构

### 2.1 统一检索层

三个信息源在没 embedding 时都用 FTS5 + BM25,配置 embedding 时都升级为 FTS5 + vector + RRF:

```
┌─────────────────────────────────────────────────────────────────┐
│ Agent 工具层                                                     │
│   kb_search │ notes_search │ hoard_search                       │
└──────┬──────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 统一检索函数(复用 mona/kb/search.py 的 hybrid 架构)           │
│                                                                  │
│  没配置 embedding:                                               │
│    FTS5 + BM25 → 结构化过滤 → 返回                               │
│                                                                  │
│  配置了 embedding:                                               │
│    FTS5 + BM25 ──┐                                              │
│    vector search ┤→ RRF 融合 → 结构化过滤 → 返回                │
└──────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 数据源(各自独立的 SQLite + FTS5 索引)                          │
│                                                                  │
│  KB:      <KB_ROOT>/<project>/.llm-wiki/fts.sqlite3             │
│  Notes:   <vault>/.mona/fts.sqlite3                             │
│  Hoard:   <app_data>/mona/hoard/hoard.sqlite3                   │
│                                                                  │
│  向量库(配置 embedding 时才有)                                 │
│  KB:      <KB_ROOT>/<project>/.llm-wiki/vectorstore.db          │
│  Notes:   <vault>/.mona/vectorstore.db                          │
│  Hoard:   <app_data>/mona/hoard/vectorstore.db                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 三个信息源的职责边界

| 信息源 | 数据来源 | 数据形态 | 生命周期 | Agent 工具 |
|--------|----------|----------|----------|-----------|
| KB | 用户主动 ingest 外部资料 | LLM 重写的结构化 wiki | 永久 | `kb_search` |
| Notes | 用户手写 / Agent 创建 | markdown + 双链(Obsidian 风格) | 永久 | `notes_search` |
| Hoard | 浏览器/邮件/笔记/对话收藏 | URL + LLM 摘要 + 标签 + 跨源关联 | 可清理(6 个月归档) | `hoard_search` / `hoard_capture` |

三者不重叠:KB 是"外部资料深度消化",Notes 是"用户原创内容",Hoard 是"跨源碎片记忆"。

---

## 三、检索方案对比

### 3.1 没配置 embedding 时

| 信息源 | 检索方式 | 索引位置 | 改动 |
|--------|----------|----------|------|
| KB | FTS5 + BM25 | `<project>/.llm-wiki/fts.sqlite3` | 新建 FTS5 索引;`search_wiki` 改查 FTS5 |
| Notes | FTS5 + BM25 | `<vault>/.mona/fts.sqlite3` | 新建 FTS5 索引;Rust 侧 `search_notes_in_memory` 改 FTS5 查询 |
| Hoard | FTS5 + BM25 + 结构化过滤 | `<app_data>/mona/hoard/hoard.sqlite3` | 新建(FTS5 原生支持) |

**统一查询语句**:

```sql
-- KB
SELECT path, title, type, tags, bm25(wiki_fts) AS score
FROM wiki_fts
WHERE wiki_fts MATCH ?
ORDER BY score
LIMIT ?;

-- Notes
SELECT note_id, title, notebook_id, bm25(notes_fts) AS score
FROM notes_fts
WHERE notes_fts MATCH ?
ORDER BY score
LIMIT ?;

-- Hoard(带结构化过滤)
SELECT h.id, h.title, h.summary, h.tags, h.source, bm25(hoards_fts) AS score
FROM hoards_fts
JOIN hoards h ON h.rowid = hoards_fts.rowid
WHERE hoards_fts MATCH ?
  AND h.source IN (?)
  AND h.created_at >= ?
ORDER BY score
LIMIT ?;
```

### 3.2 配置了 embedding 时

三个信息源统一走 `search_wiki_hybrid` 的架构(复用 [mona/kb/search.py:128](../mona/kb/search.py#L128)):

```
查询
  │
  ├─→ Phase 1: FTS5 + BM25 → keyword_results (top 20)
  │
  ├─→ Phase 2: query → fetch_embedding → vectorstore.search_chunks
  │             → vector_results (top 20)
  │
  └─→ Phase 3: RRF 融合 → final_results (top N)
```

| 信息源 | FTS5 索引 | 向量库 | embedding 配置 |
|--------|----------|--------|---------------|
| KB | `<project>/.llm-wiki/fts.sqlite3` | `<project>/.llm-wiki/vectorstore.db` | 全局 `EmbeddingConfig` |
| Notes | `<vault>/.mona/fts.sqlite3` | `<vault>/.mona/vectorstore.db` | `<vault>/.mona/embedding.json` |
| Hoard | `<app_data>/mona/hoard/hoard.sqlite3` | `<app_data>/mona/hoard/vectorstore.db` | `<app_data>/mona/hoard/embedding.json` |

### 3.3 检索方案:LIKE 子串匹配 + 简单评分(已验证)

**方案调整说明**:原计划用 FTS5 + BM25,但实测发现 FTS5 所有内置分词器对中文支持极差:
- `trigram`:2 字中文词(渲染/前端/架构/优化/设计)全部 0 命中,前缀匹配也无效
- `unicode61`:中文完全不分词(连 4 字词也 0 命中)
- `porter`:同上

引入 jieba 等外部分词器违反"完全自包含"红线。故改用 **LIKE 子串匹配 + 简单评分**:
- 零依赖,中文支持完美(子串匹配不分词)
- 数据量级下(几千到几万条)SQLite LIKE 性能足够
- 三个信息源统一实现

**评分公式**:

```
score = (title_hit * 3 + summary_hit * 2 + tags_hit * 2 + content_hit * 1)
        × time_decay(created_at, now)
        × source_strength
```

- `title_hit`:标题命中 = 1,否则 0
- `summary_hit`:摘要命中 = 1,否则 0
- `tags_hit`:标签命中 = 1,否则 0
- `content_hit`:正文命中 = 1,否则 0
- `time_decay`:时间衰减函数,半年内 = 1.0,每年衰减 0.2
- `source_strength`:用户主动 = 1.0,Agent = 0.8

**查询语句**(以 Hoard 为例):

```sql
SELECT id, title, summary, tags, source, url,
       (CASE WHEN title LIKE ? THEN 3 ELSE 0 END
        + CASE WHEN summary LIKE ? THEN 2 ELSE 0 END
        + CASE WHEN tags LIKE ? THEN 2 ELSE 0 END
        + CASE WHEN content LIKE ? THEN 1 ELSE 0 END) AS relevance_score
FROM hoards
WHERE title LIKE ? OR summary LIKE ? OR tags LIKE ? OR content LIKE ?
ORDER BY relevance_score * source_strength DESC
LIMIT ?;
```

**FTS5 保留**:配置 embedding 时,向量检索仍是核心能力。FTS5 方案在 embedding 可用后可再评估是否引入。

---

## 四、KB 模块改造

### 4.1 检索函数改造(LIKE + 评分)

**`search_wiki`([search.py:85](../mona/kb/search.py#L85))**:

当前:文件扫描 + token 计分
改为:文件扫描 + LIKE 子串匹配 + 简单评分(标题命中权重 3,内容命中权重 1)

不新建 FTS5 索引,直接在文件扫描时用 LIKE 匹配。理由:
- KB wiki 页面数量有限(每个项目几十到几百个),文件扫描成本可接受
- LIKE 子串匹配对中文支持完美
- 避免引入索引维护复杂度

```python
def search_wiki(project_path: Path, query: str, count: int = 10) -> list[dict]:
    """LIKE substring search with simple scoring."""
    md_dir = project_path / "wiki"
    if not md_dir.exists():
        return []
    pattern = f"%{query}%"
    results = []
    for md_file in md_dir.rglob("*.md"):
        text = md_file.read_text(encoding="utf-8")
        frontmatter, body = parse_frontmatter(text)
        title = frontmatter.get("title", md_file.stem)
        title_hit = 1 if query.lower() in title.lower() else 0
        content_hit = 1 if query.lower() in body.lower() else 0
        if title_hit or content_hit:
            score = title_hit * 3 + content_hit * 1
            results.append({"path": str(md_file), "title": title, "score": score, ...})
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:count]
```
    ...
```

**`search_wiki_hybrid`([search.py:128](../mona/kb/search.py#L128))**:

当前:Phase 1 用文件扫描 + token 计分
改为:Phase 1 用 LIKE + 评分(与 search_wiki 一致)

```python
async def search_wiki_hybrid(...) -> dict:
    # Phase 1: LIKE + 评分(替换 token 计分)
    keyword_results = search_wiki(project_path, query, count * 3)

    # Phase 2: vector search(不变)
    ...

    # Phase 3: RRF fusion(不变)
    ...
```

### 4.4 修复 `KbSearchTool` bug

**[kb/tool.py:37](../mona/kb/tool.py#L37)**:

当前:直接调 `search_wiki`(纯关键词,不读 embedding)
改为:调 `search_wiki_hybrid`(读 embedding 配置,有则 hybrid,无则 LIKE)

```python
class KbSearchTool(Tool):
    async def execute(self, query: str, count: int = 5, **kwargs) -> str:
        project_path = self._resolve_project_path()
        if project_path is None:
            return "No knowledge base project found."

        # 读取 embedding 配置(与 notes_search 一致)
        embedding_config = self._load_embedding_config()
        result = await search_wiki_hybrid(
            project_path, query, embedding_config, count=count
        )
        ...
```

---

## 五、Notes 模块改造

### 5.1 检索改造(LIKE + 评分)

Notes 当前已经是子串匹配([notes.rs:1534](../src-tauri/src/notes.rs#L1534) `String::contains`),只需增加评分排序:

当前:全部加载到内存,`String::contains` 子串匹配,**无评分排序**
改为:全部加载到内存,LIKE 子串匹配 + **简单评分排序**(标题命中权重 3,内容命中权重 1)

**不新建 FTS5 索引**,继续用内存子串匹配,但增加评分。理由:
- Notes 当前已用子串匹配,中文支持没问题
- 笔记数量有限(几百到几千),内存扫描成本可接受
- 只需在现有 `search_notes_in_memory` 基础上加评分排序

**Rust 侧改造**([notes.rs:1514](../src-tauri/src/notes.rs#L1514)):

```rust
fn search_notes_in_memory(
    notes: &[OperationNote],
    notebook_filter: Option<&str>,
    query: &str,
    limit: usize,
) -> Vec<NoteSearchResult> {
    let q = query.to_lowercase();
    let mut results: Vec<NoteSearchResult> = notes
        .iter()
        .filter(|n| {
            notebook_filter.map_or(true, |nb| n.notebook_id == nb)
        })
        .filter_map(|n| {
            let title_l = n.title.to_lowercase();
            let content_l = n.plain_text.clone().unwrap_or_default().to_lowercase();
            let title_hit = title_l.contains(&q);
            let content_hit = content_l.contains(&q);
            if title_hit || content_hit {
                let score = (if title_hit { 3 } else { 0 }) + (if content_hit { 1 } else { 0 });
                Some(NoteSearchResult { note: n.clone(), score })
            } else {
                None
            }
        })
        .collect();
    results.sort_by(|a, b| b.score.cmp(&a.score));
    results.into_iter().take(limit).collect()
}
```

### 5.2 Python 侧

Python 侧 `notes_search` 工具的 fallback 自动受益 —— 它调 Tauri `notes_search_all`,Rust 侧改了评分,Python 自动获得评分排序结果。

---

## 六、Hoard 模块(新建)

### 6.1 定位

Hoard 是 Agent 的跨源碎片记忆层,不是内容存储库。它存储:
- URL + LLM 摘要 + 标签(链接型)
- 文本片段 + LLM 摘要 + 标签(片段型)
- 跨源关联(同一 URL 出现在浏览器/邮件/笔记/对话)

**不存储**:原文(需要时实时抓取)、邮件附件(只记关联)

### 6.2 数据模型

**文件**:`<app_data>/mona/hoard/hoard.sqlite3`

```sql
-- 主表
CREATE TABLE IF NOT EXISTS hoards (
  id TEXT PRIMARY KEY,
  url TEXT,
  title TEXT NOT NULL,
  content TEXT,                          -- 抓取的正文 / 笔记片段
  summary TEXT,                          -- LLM 生成摘要
  tags TEXT,                             -- JSON 数组
  source TEXT NOT NULL,                  -- 'browser'|'email'|'note'|'chat'|'manual'
  source_ref TEXT,                       -- tab_id / email_id / note_id / session_id
  source_strength REAL DEFAULT 1.0,      -- 主动=1.0, Agent=0.8
  asset_path TEXT,                       -- 截图路径(相对 app_data)
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  embedded INTEGER DEFAULT 0             -- 配置 embedding 时才用
);

CREATE INDEX IF NOT EXISTS idx_hoards_url ON hoards(url);
CREATE INDEX IF NOT EXISTS idx_hoards_source ON hoards(source);

-- 跨源关联表
CREATE TABLE IF NOT EXISTS hoard_relations (
  hoard_id TEXT NOT NULL,
  related_type TEXT NOT NULL,            -- 'email'|'note'|'browser'|'chat'
  related_id TEXT NOT NULL,
  related_meta TEXT,                     -- JSON
  created_at INTEGER NOT NULL,
  PRIMARY KEY (hoard_id, related_type, related_id)
);
```

### 6.3 信息源与触发方式

| 信息源 | 触发方式 | source | source_strength |
|--------|----------|--------|-----------------|
| 浏览器 | 用户右键"收藏到 Mona" | `browser` | 1.0 |
| 邮件链接/附件 | 用户右键"收藏" | `email` | 1.0 |
| 笔记片段 | 用户右键"收藏为片段" | `note` | 1.0 |
| 对话提及 | Agent 自动 `hoard_capture` | `chat` | 0.8 |

**不做浏览轨迹被动索引**(已决策)。

### 6.4 采集管道

```
收藏触发
   │
   ▼
步骤 1: 创建 hoard 记录(立即返回 hoard_id)
   │
   ▼
步骤 2: 元数据抓取(异步,HTTP og:title/desc + CDP 截图)
   │
   ▼
步骤 3: LLM 摘要 + 标签(异步,复用 mona/providers)→ 更新 hoards 表
   │
   ▼
步骤 4: 跨源关联(异步,URL 精确匹配 → hoard_relations)
   │
   ▼
步骤 5: 向量化(仅配置 embedding 时,复用 chunker + embedding + vectorstore)
```

**降级策略**:
- HTTP 抓取失败:只存 url + title,summary 由 LLM 基于 title 生成
- LLM 调用失败:summary 为空,只索引 title + content
- Embedding 未配置:跳过步骤 5,只用 LIKE 检索
- 截图失败:asset_path 为空

### 6.5 检索

**没配置 embedding**:LIKE 子串匹配 + 简单评分 + 结构化过滤

```sql
SELECT id, title, summary, tags, source, url,
       (CASE WHEN title LIKE ? THEN 3 ELSE 0 END
        + CASE WHEN summary LIKE ? THEN 2 ELSE 0 END
        + CASE WHEN tags LIKE ? THEN 2 ELSE 0 END
        + CASE WHEN content LIKE ? THEN 1 ELSE 0 END) AS relevance_score
FROM hoards
WHERE (title LIKE ? OR summary LIKE ? OR tags LIKE ? OR content LIKE ?)
  AND source IN (?)        -- 可选
  AND created_at >= ?      -- 可选
ORDER BY relevance_score * source_strength DESC
LIMIT ?;
```

**配置了 embedding**:LIKE + vector + RRF(复用 `search_wiki_hybrid` 架构)

### 6.6 Agent 工具

**`hoard_search`**:

```python
class HoardSearchTool(Tool):
    name = "hoard_search"
    description = (
        "搜索 Mona 记忆库(Hoard),召回用户在浏览器、邮件、笔记、对话中收藏过的内容。"
        "返回标题、摘要、标签、来源和相关联的其他信息源。"
        "适用场景:用户问'之前看过的''上周聊到的''邮件里提到的'等需要回忆历史内容的问题。"
    )
    _scopes = {"core", "subagent"}
    read_only = True

    async def execute(self, query: str, source: str = None,
                      date_from: str = None, date_to: str = None,
                      count: int = 5, **kwargs) -> str:
        # 1. LIKE 子串匹配 + 评分检索
        # 2. 配置 embedding 时:vector 检索 + RRF 融合
        # 3. 结构化过滤(source/date)
        # 4. 评分 × source_strength
        # 5. 附带 related_sources(跨源关联)
        # 6. 更新 last_accessed_at
        ...
```

**`hoard_capture`**:

```python
class HoardCaptureTool(Tool):
    name = "hoard_capture"
    description = (
        "把一条 URL 或文本片段收藏到 Mona 记忆库(Hoard),供未来对话召回。"
        "触发条件:当用户在对话中表达对某 URL/文件/邮件的**关注意图**时调用"
        "(如'记一下''收藏下''这个有用''回头要看'),"
        "或当 Agent 判断某内容对**未来对话有潜在价值**时调用。"
        "不要为用户随口提及、负面评价、临时示例的 URL 调用。"
        "入库后 source_strength=0.8(低于用户主动收藏的 1.0),用户可在 UI 删除。"
    )
    _scopes = {"core"}
    read_only = False

    async def execute(self, source: str = "chat", url: str = None,
                      title: str = None, content: str = None,
                      source_ref: str = None, **kwargs) -> str:
        # 1. 创建 hoard 记录(source_strength=0.8)
        # 2. 异步触发采集管道
        # 3. 返回 hoard_id
        ...
```

### 6.7 跨源关联

URL 精确匹配(已决策,第一版不做语义关联):

```sql
-- 收藏时,若有 url,扫描其他信息源是否有同一 url
INSERT INTO hoard_relations (hoard_id, related_type, related_id, related_meta, created_at)
SELECT ?, 'email', email_id, ?, ?
FROM emails WHERE body LIKE '%' || ? || '%'   -- 邮件正文包含该 url
UNION
SELECT ?, 'note', note_id, ?, ?
FROM notes WHERE content LIKE '%' || ? || '%'  -- 笔记内容包含该 url
```

`hoard_search` 返回结果时附带 `related_sources`:

```json
{
  "id": "hoard_abc123",
  "title": "React Server Components",
  "url": "https://...",
  "summary": "...",
  "related_sources": [
    {"type": "email", "id": "msg_456", "subject": "前端架构评审"},
    {"type": "note", "id": "note_abc", "title": "前端技术栈 2024"}
  ]
}
```

Agent 拿到结果后,可继续调 `email_read` / `notes_read` 读原文。**孤岛被打通**。

### 6.8 不做的事

| 能力 | 原因 |
|------|------|
| 原文归档(monolith) | 体积爆炸,违反自包含红线 |
| 视频归档(yt-dlp) | 外部依赖,场景窄 |
| OCR | 第一版不做 |
| 浏览轨迹被动索引 | 用户决策:只索引主动收藏 |
| RAG 自动注入 | 用户决策:避免幻觉 |
| 语义关联(非 URL 匹配) | 第一版只做 URL 精确匹配 |

---

## 七、文件结构

### 7.1 新增文件

```
mona/hoard/
  __init__.py
  models.py        -- 数据模型 + SQLite 操作(hoard.sqlite3 + relations)
  ingest.py        -- 采集管道:抓取 → 摘要 → 标签 → 向量化(可选)
  search.py        -- LIKE + 评分检索(+ embedding 时 RRF 融合)
  prompts.py       -- LLM 摘要/标签 prompt 模板
mona/agent/tools/
  hoard.py         -- Agent 工具:hoard_search / hoard_capture
mona/api/
  hoard_handlers.py -- HTTP handlers
```

### 7.2 改动文件

```
mona/kb/search.py            -- search_wiki 改 LIKE + 评分;search_wiki_hybrid 的 Phase 1 改 LIKE
mona/kb/tool.py              -- KbSearchTool 改调 search_wiki_hybrid(修 bug)
mona/agent/tools/notes.py    -- notes_search fallback 自动受益(Rust 侧改了)
mona/api/server.py           -- 注册新路由
mona/config/schema.py        -- 新增 HoardConfig
src-tauri/src/notes.rs       -- search_notes_in_memory 加评分排序
src-tauri/src/hoard.rs       -- 新建:Tauri 命令(hoard_add / hoard_list / hoard_delete)
src-tauri/src/lib.rs         -- 注册 hoard 模块
```

### 7.3 前端

```
webui/src/
  lib/hoard-api.ts            -- Hoard API 客户端
  components/hoard/
    HoardView.tsx             -- 收藏列表/详情主视图
    HoardListItem.tsx
    HoardDetail.tsx           -- 摘要 + 标签 + 关联来源
  components/notes/           -- 集成右键"收藏为片段"
  components/email/           -- 集成右键"收藏"
  components/browser/         -- 集成右键"收藏到 Mona"
  views/                      -- 主界面新增 Hoard 入口
```

---

## 八、数据目录总览

```
<app_data>/mona/
  hoard/
    hoard.sqlite3              -- Hoard 主表 + relations
    vectorstore.db             -- Hoard 向量库(配置 embedding 时)
    embedding.json             -- Hoard embedding 配置
    assets/                    -- 截图

<KB_ROOT>/<project>/
  raw/                         -- 原始资料
  wiki/                        -- LLM 重写的 wiki 页面
  .llm-wiki/
    vectorstore.db             -- KB 向量库(已有)
    purpose.md

<vault>/
  *.md                         -- 笔记文件
  <notebook>/*.md
  .mona/
    vectorstore.db             -- Notes 向量库(已有)
    embedding.json             -- Notes embedding 配置(已有)
    links.json                 -- 双链图缓存
```

---

## 九、实施路线(分 4 阶段)

### 阶段 1:KB + Notes 检索改造(基础设施)

**目标**:三个信息源中的两个统一到 LIKE + 评分

- [ ] KB:`search_wiki` 改 LIKE + 评分(替换 token 计分)
- [ ] KB:`search_wiki_hybrid` 的 Phase 1 改 LIKE
- [ ] KB:修复 `KbSearchTool` 调 `search_wiki_hybrid`(修 bug)
- [ ] Notes:`search_notes_in_memory` 加评分排序(标题命中权重 3,内容命中权重 1)

**验收**:
- KB 项目搜索结果按评分排序,中文查询命中准确
- Notes 搜索结果按评分排序
- `kb_search` 工具配置 embedding 时走 hybrid

### 阶段 2:Hoard 核心模块

**目标**:Hoard 可收藏、可检索

- [ ] Rust 侧 `hoard.rs`:SQLite 表初始化 + CRUD Tauri 命令
- [ ] Python 侧 `mona/hoard/models.py`:数据模型 + SQLite 操作
- [ ] Python 侧 `mona/hoard/ingest.py`:采集管道(HTTP 抓取 + LLM 摘要/标签)
- [ ] Python 侧 `mona/hoard/search.py`:LIKE + 评分检索
- [ ] Agent 工具 `mona/agent/tools/hoard.py`:`hoard_search` + `hoard_capture`
- [ ] HTTP handlers + 路由注册
- [ ] 前端右键菜单集成(浏览器/邮件/笔记)

**验收**:
- 浏览器收藏链接 → 30 秒内 Hoard 视图可见摘要和标签
- Agent 对话中 `hoard_search` 能搜到收藏内容
- Agent 对话中 `hoard_capture` 自动入库

### 阶段 3:跨源关联 + 配置 embedding 升级

**目标**:跨源关联打通 + 配置 embedding 时三个信息源都升级

- [ ] `hoard_relations` 表 + URL 精确匹配关联逻辑
- [ ] `hoard_search` 返回 `related_sources`
- [ ] 跨源跳转(hoard → 邮件/笔记)
- [ ] Hoard 向量化(配置 embedding 时):chunker + embedding + vectorstore + RRF
- [ ] 前端 Hoard 详情面板展示关联来源
- [ ] 设置页 Hoard embedding 配置

**验收**:
- 收藏链接 → 邮件正文有同一链接 → `hoard_search` 能同时召回
- 配置 embedding 后,Hoard 检索升级为 hybrid

### 阶段 4:UI 完善与治理

**目标**:完整的收藏管理体验

- [ ] Hoard 主视图(列表 + 详情 + 搜索 + 标签过滤)
- [ ] 列表项支持编辑标签/删除/手动添加摘要
- [ ] 6 个月归档 cron + 归档恢复 UI
- [ ] Agent 自动入库的内容在 UI 标记,可一键删除
- [ ] Hoard 统计面板(总数 / 来源分布 / 标签云)

**验收**:用户能完整管理收藏库

---

## 十、配置

### 10.1 HoardConfig

```python
class HoardConfig(Base):
    """Hoard(Agent 记忆库)配置。"""
    enabled: bool = True
    embedding: EmbeddingConfig = EmbeddingConfig()
    auto_summary: bool = True
    auto_tags: bool = True
    auto_screenshot: bool = True
    archive_after_days: int = 180
    agent_auto_capture: bool = True
```

### 10.2 Embedding 配置独立性

三个信息源的 embedding 配置独立,用户可分别配置:

| 信息源 | 配置文件 | 默认行为 |
|--------|----------|----------|
| KB | 全局 `EmbeddingConfig` | 不启用 |
| Notes | `<vault>/.mona/embedding.json` | 不启用 |
| Hoard | `<app_data>/mona/hoard/embedding.json` | 不启用 |

如果用户只配置 Notes 的 embedding(用 Ollama 本地模型),Hoard 和 KB 仍走 FTS5 only。

---

## 十一、风险与边界

### 11.1 已识别风险

| 风险 | 缓解 |
|------|------|
| SQLite 版本 < 3.34(trigram 不可用) | 实施前验证;降级为 `unicode61` + 手动中文分词 |
| FTS5 索引体积 | trigram 索引约为原文 3 倍;笔记/hoard 量级可接受;KB wiki 有限 |
| 索引不一致(笔记/wiki 变更未触发更新) | 所有 CRUD 路径都触发 FTS5 更新;提供手动重建 |
| Agent 自动入库噪音 | source_strength=0.8 降权;UI 可删除;prompt 约束 |
| 存储膨胀 | 6 个月归档;不归档原文;截图压缩 |

### 11.2 明确不做的事

| 能力 | 原因 |
|------|------|
| RAG 自动注入 | 用户决策:避免幻觉 |
| 浏览轨迹被动索引 | 用户决策:只索引主动收藏 |
| 原文归档(monolith) | 体积/成本 |
| 语义关联(非 URL 匹配) | 第一版只做 URL 精确匹配 |
| OCR / 视频归档 | 范围外 |

---

## 十二、验证清单

### 12.1 KB 检索改造

1. ✅ KB 项目搜索结果按 BM25 排序
2. ✅ 中文查询"前端性能"能命中标题为"React 渲染优化"的 wiki 页面(trigram)
3. ✅ `kb_search` 工具配置 embedding 时走 hybrid(修 bug)
4. ✅ FTS5 索引在 wiki 页面变更时自动更新

### 12.2 Notes 检索改造

5. ✅ Notes 搜索结果按 BM25 排序
6. ✅ 搜索不再全量加载笔记到内存
7. ✅ 笔记保存后,FTS5 索引自动更新
8. ✅ 首次打开旧 vault 自动建索引

### 12.3 Hoard 模块

9. ✅ 浏览器收藏链接 → 30 秒内可见摘要和标签
10. ✅ 邮件正文同一 URL → `hoard_relations` 自动关联
11. ✅ 笔记选中文本右键收藏 → 片段型 hoard 创建成功
12. ✅ Agent `hoard_search` 返回结果含 `related_sources`
13. ✅ Agent `hoard_capture` 自动入库(source_strength=0.8)
14. ✅ Embedding 未配置时,Hoard FTS5 检索正常
15. ✅ Embedding 配置后,Hoard 升级为 hybrid
16. ✅ 用户可在 UI 删除 Agent 自动入库的内容

---

## 附:关键决策记录

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 没配置 embedding 的检索 | FTS5 + BM25 | 零依赖,成熟,比 token 计分和 substring 都强 |
| 配置了 embedding 的检索 | FTS5 + vector + RRF | 复用现有 `search_wiki_hybrid` 架构 |
| 分词器 | trigram | 中文支持好,英文兼容 |
| RAG 自动注入 | 不做 | 用户决策:避免幻觉 |
| 浏览轨迹索引 | 不做 | 用户决策:只索引主动收藏 |
| Agent 自动入库 | 允许,降权 0.8 | 让 Agent 有主动记忆能力,用户可删除 |
| 跨源关联 | URL 精确匹配 | 第一版简单可靠 |
| 原文归档 | 不做 | 体积/成本 |
| KB/Notes/Hoard 检索 | 统一方案 | 体验一致,Agent 能力均衡 |
| `kb_search` bug | 修复 | 改调 `search_wiki_hybrid` |
