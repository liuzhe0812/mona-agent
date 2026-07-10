# Mona Hoard — Agent 记忆基础设施设计方案

> 日期:2026-07-07
> 范围:在 Mona 桌面端新增"Hoard"(收藏/记忆)模块,作为 Agent 的跨信息源统一记忆层
> 灵感来源:karakeep(GitHub karakeep-app/karakeep)的"万物收藏"理念
> 核心定位:**不是复刻 karakeep,而是构建 Mona 独有的 Agent 记忆基础设施**
> 不在范围:
> - 不集成 karakeep 代码或引入 Docker/Meilisearch/Puppeteer 依赖
> - 不做完整页面归档(monolith)、视频归档(yt-dlp)、OCR
> - 不做协作列表、跨设备同步
> - 不做被动浏览轨迹索引(仅索引用户主动收藏的内容)
> 前置决策:
> - [2026-07-06 笔记知识库设计](./2026-07-06-notes-knowledge-base-design.md):笔记模块走 Obsidian 模式,作为长期记忆
> - [2026-07-03 笔记"知识"功能移除](./2026-07-03-notes-knowledge-removal-design.md):已移除二级知识概念

---

## 一、设计哲学

### 1.1 核心问题:Mona 的信息源是孤岛

当前 Mona 的浏览器、笔记、邮件、KB 各自为政:

| 信息源 | 现状 | 缺失 |
|--------|------|------|
| 浏览器 | [browser/storage.rs](../src-tauri/src/browser/storage.rs) 有 bookmarks/visit_history 表 | 无内容抓取、无 AI 标签、无全文搜索 |
| 邮件 | [email.rs](../src-tauri/src/email.rs) 本地 SQLite + .eml | 邮件里的链接/附件没有沉淀到知识库 |
| 笔记 | Obsidian vault + 双链 + 向量索引([notes_kb](../mona/notes_kb/)) | 只覆盖用户主动写的内容 |
| KB | 项目化 chunker+embedding([mona/kb/](../mona/kb/)) | 只覆盖用户主动 ingest 的项目 |

后果:用户"看过但找不到"、Agent 跨模块检索要多跳、邮件正文里的关键链接和笔记、浏览器历史之间无法关联。

### 1.2 核心洞察:Agent 缺的不是工具,是记忆

Mona 是 Agent 平台,不是工具集合。Agent 的价值不在于"能调用多少工具",而在于"对话时能想起多少上下文"。

当前 Agent 只有两条记忆路径:
- **会话历史**(短期):当前对话上下文
- **notes_kb / kb**(长期):用户主动整理的知识

缺失的是**被动记忆层** —— 用户在日常使用中接触过、但没主动整理的内容。这些内容散落在浏览器、邮件、对话里,Agent 想不起来,只能让用户重复提供。

### 1.3 Hoard 的定位:Agent 的被动记忆基础设施

| 模块 | 定位 | 数据生命周期 | 触发方式 |
|------|------|-------------|----------|
| **hoard(本方案)** | Agent 被动记忆,碎片素材 | 可清理,6 个月未访问归档 | 收藏触发 |
| [notes_kb](../mona/notes_kb/) | 用户主动整理的深度知识 | 永久 | 用户写笔记 |
| [kb](../mona/kb/) | 项目化 Wiki | 永久 | 用户主动 ingest |
| browser/storage | 浏览器原生数据 | 浏览器自己的 | 浏览器行为 |
| email.sqlite3 | 邮件本地缓存 | 邮件客户端的 | 收发邮件 |

**Hoard 是上层索引层,不替代任何模块**。它从各模块"借"数据,加工成 Agent 可用的记忆。

### 1.4 与 karakeep 的本质差异

| 维度 | Karakeep | Mona Hoard |
|------|----------|------------|
| 定位 | 内容保险箱 | Agent 语义记忆 |
| 目标 | 防 link rot,原样保留 | 让 Agent 能"想起来" |
| 重心 | 归档完整性 | 可检索性 + 跨源关联 |
| 用户场景 | 主动收藏"以后要看" | Agent 主动召回辅助回答 |
| 原文归档 | ✅ monolith 整页快照 | ❌ 不归档(体积/成本) |
| 视频归档 | ✅ yt-dlp | ❌ 不做 |
| OCR | ✅ | ❌ 第一版不做 |
| Agent 入口 | MCP/CLI(外部调用) | 原生工具 + 对话上下文注入 |
| 跨源关联 | ❌ 单一来源 | ✅ URL 精确匹配关联浏览器/邮件/笔记/对话 |
| 对话上下文 | ❌ 无 | ✅ RAG 式自动召回 |

**关键差异**:karakeep 为人类用户服务(归档完整性),Mona hoard 为 Agent 服务(语义可检索 + 跨源关联)。

### 1.5 核心原则

1. **记忆不是链接,是语义层**:Agent 记住的是"这条内容讲了什么"(summary),不是 URL
2. **不复制原数据,只建索引**:hoard 不拷贝邮件附件/浏览器书签,只记录"这个 URL 出现在哪封邮件/哪个 tab"
3. **复用现有基础设施**:chunker/embedding/vectorstore/providers 全部复用,不引入新依赖
4. **三种触发,优先级清晰**:用户主动(1.0)> Agent 自动(0.8)> 不做被动沉淀
5. **不归档原文,需要时实时抓取**:Agent 需要原文时用 [http.py](../mona/agent/tools/http.py) 实时获取
6. **永久内容走笔记**:用户觉得必须永久保存的,右键"存为笔记"进入 vault,那是长期记忆层

---

## 二、目标能力全景

### 2.1 核心能力(6 项)

| # | 能力 | 描述 |
|---|------|------|
| 1 | 统一收藏 | 浏览器/邮件/笔记/对话的链接和片段统一入库 |
| 2 | 自动语义化 | HTTP 抓取元数据 + LLM 生成摘要 + LLM 自动标签 |
| 3 | 混合检索 | FTS5 关键词 + sqlite-vec 向量 + RRF 融合 |
| 4 | 跨源关联 | URL 精确匹配,串联浏览器/邮件/笔记/对话 |
| 5 | Agent 工具 | `hoard_search` 检索 + `hoard_capture` 入库 |
| 6 | 上下文注入 | 对话开始时 RAG 式自动召回 top 3 注入 system prompt |

### 2.2 不做的事(明确边界)

| 能力 | 原因 |
|------|------|
| 浏览轨迹被动索引 | 噪音大,用户决策已定:只索引主动收藏 |
| 整页归档(monolith) | 体积爆炸,违反自包含红线 |
| 视频归档(yt-dlp) | 外部依赖,场景窄 |
| OCR | 第一版不做,后续按需评估 |
| 协作列表 | 单机产品,无协作场景 |
| 跨设备同步 | 桌面端,无同步需求 |
| RSS 自动订阅 | 范围外,后续可单独立项 |

---

## 三、信息源与触发方式

### 3.1 信息源(5 类)

| # | 信息源 | 现有基础 | 采集内容 | 触发方式 |
|---|--------|----------|----------|----------|
| 1 | 浏览器书签 | [browser/storage.rs](../src-tauri/src/browser/storage.rs) bookmarks 表 | url / title / folder | 用户主动收藏 |
| 2 | 浏览器当前页 | 浏览器 CDP 能力 | url / title / 截图 | 用户右键"收藏到 Mona" |
| 3 | 邮件链接/附件 | [email.rs](../src-tauri/src/email.rs) + [email_intel.py](../mona/agent/tools/email_intel.py) | 邮件正文 URL / 附件文件 / 发件人上下文 | 用户右键收藏 / Agent 自动 |
| 4 | 笔记片段 | [notes.py](../mona/agent/tools/notes.py) | 用户在笔记中选中的文本片段 | 用户右键"收藏为片段" |
| 5 | 对话提及 | Agent loop 本身 | 对话中 Agent 引用的 URL/文件/邮件 ID | Agent 自动调用 `hoard_capture` |

**关键设计**:不复制原数据,只建索引。邮件附件不拷贝到 hoard,只记录"这个链接出现在哪封邮件里"。

### 3.2 触发方式(2 种,已砍掉被动沉淀)

#### 触发 1:用户主动收藏(高信号,source_strength=1.0)

- **浏览器**:地址栏星标按钮 / 右键菜单"收藏到 Mona"
- **邮件**:正文链接右键"收藏" / 附件右键"加入记忆库"
- **笔记**:选中文本右键"收藏为片段"
- 走 Tauri IPC 命令 `hoard_add`,立即触发完整采集管道

#### 触发 2:Agent 主动收藏(中信号,source_strength=0.8)

- Agent 在对话中识别到用户提到 URL、文件路径、邮件 ID 时,自动调用 `hoard_capture` 工具
- 不需要用户指令,Agent 在 loop 中决定
- 用户可在 UI 删除 Agent 自动入库的内容

**Agent 自动收藏的判断标准**(写入工具 schema description):

> 当用户在对话中表达对某 URL/文件/邮件的**关注意图**时调用(如"记一下""收藏下""这个有用""回头要看"),或当 Agent 判断某内容对**未来对话有潜在价值**时调用。不要为用户随口提及、负面评价、临时示例的 URL 调用。

第一版通过 prompt 约束 LLM 判断,后续根据实际调用情况调整。

### 3.3 不做被动沉淀(已决策)

用户决策:**浏览轨迹不索引,只索引收藏的**。因此:
- 不扫描 visit_history
- 不需要 cron 定期采集浏览轨迹
- cron 只做一件事:对未向量化的 hoard 跑 embedding(后台补全)

---

## 四、数据模型

### 4.1 Hoard 实体:记忆的五层结构

```
┌─────────────────────────────────────────────────────────┐
│ 层 1: 锚点(URL / 片段 ID)                              │
│   - 链接型内容:url                                      │
│   - 片段型内容:无 url,用 source_ref 标识              │
├─────────────────────────────────────────────────────────┤
│ 层 2: 元数据(title / description / 截图)              │
│   - HTTP 抓取 og:title / og:description                │
│   - CDP 截图(浏览器场景)                              │
├─────────────────────────────────────────────────────────┤
│ 层 3: 语义摘要(LLM 生成的 200-500 字)  ← 核心        │
│   - "这篇文章讲了什么"                                  │
│   - "这个工具能干什么"                                  │
│   - 这是 Agent 真正"记得"的东西                         │
├─────────────────────────────────────────────────────────┤
│ 层 4: 检索锚点(LLM 标签 + 用户标签)                   │
│   - 自动标签:[React, 前端, 性能优化]                   │
│   - 用于 FTS5 关键词召回                                │
├─────────────────────────────────────────────────────────┤
│ 层 5: 来源上下文(跨源关联)                            │
│   - "在浏览器收藏过" / "在邮件 msg_123 出现过"          │
│   - "在 note_abc 笔记里讨论过"                          │
│   - "上周三对话中 Agent 提到过"                         │
└─────────────────────────────────────────────────────────┘
```

### 4.2 SQLite 表设计

```sql
-- 主表:hoard 实体
CREATE TABLE IF NOT EXISTS hoards (
  id TEXT PRIMARY KEY,                  -- uuid
  url TEXT,                              -- 可空(笔记片段无 url)
  title TEXT NOT NULL,                   -- 标题(HTTP 抓取或用户输入)
  content TEXT,                          -- 抓取的正文 / 笔记片段文本
  summary TEXT,                          -- LLM 生成摘要(200-500 字)
  tags TEXT,                             -- JSON 数组,LLM 自动 + 用户手动
  source TEXT NOT NULL,                  -- 'browser'|'email'|'note'|'chat'|'manual'
  source_ref TEXT,                       -- 来源标识:tab_id / email_id / note_id / session_id
  source_strength REAL DEFAULT 1.0,      -- 主动=1.0, Agent=0.8
  asset_path TEXT,                       -- 截图/附件路径(相对 app_data)
  created_at INTEGER NOT NULL,           -- 创建时间(unix timestamp)
  last_accessed_at INTEGER,              -- 最后被 Agent 召回时间
  embedded INTEGER DEFAULT 0             -- 是否已向量化(0/1)
);

CREATE INDEX IF NOT EXISTS idx_hoards_url ON hoards(url);
CREATE INDEX IF NOT EXISTS idx_hoards_source ON hoards(source);
CREATE INDEX IF NOT EXISTS idx_hoards_created_at ON hoards(created_at DESC);

-- 全文搜索虚拟表(SQLite FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS hoards_fts USING fts5(
  title,
  content,
  summary,
  tags,
  content='hoards',
  content_rowid='rowid'
);

-- 跨源关联表:同一 URL 出现在多个信息源
CREATE TABLE IF NOT EXISTS hoard_relations (
  hoard_id TEXT NOT NULL,                -- hoard 主记录 ID
  related_type TEXT NOT NULL,            -- 'email'|'note'|'browser'|'chat'
  related_id TEXT NOT NULL,              -- email_id / note_id / session_id
  related_meta TEXT,                     -- JSON:邮件主题/笔记标题/对话摘要
  created_at INTEGER NOT NULL,
  PRIMARY KEY (hoard_id, related_type, related_id)
);

CREATE INDEX IF NOT EXISTS idx_relations_url ON hoard_relations(related_type, related_id);
```

### 4.3 向量存储(复用 sqlite-vec)

Hoard 使用独立的 vectorstore.db,与 notes_kb 分库:

```
<app_data>/mona/hoard/
  hoard.sqlite3        -- 主表 + FTS5 + relations
  vectorstore.db       -- sqlite-vec 向量索引(复用 mona/kb/vectorstore.py)
  assets/              -- 截图/附件
```

**分库原因**:
- hoard 是可清理的(6 个月未访问归档),notes 是永久资产,生命周期不同
- 向量索引的 page_id 用 hoard.id,与 notes_kb 的 note_id 不冲突
- 独立清理不影响 notes_kb

### 4.4 记忆形态示例

用户在浏览器收藏 `https://react.dev/learn/server-components`:

```json
{
  "id": "hoard_abc123",
  "url": "https://react.dev/learn/server-components",
  "title": "React Server Components",
  "content": "...(抓取的正文,chunker 切分后向量化)...",
  "summary": "官方文档,讲解 React Server Components 的设计原理、与 Client Components 的区别、数据获取模式、以及从传统 SSR 迁移的注意事项。强调 RSC 不是 SSR 的替代,而是补充。",
  "tags": ["React", "RSC", "前端架构", "官方文档"],
  "source": "browser",
  "source_ref": "tab_abc123",
  "source_strength": 1.0,
  "asset_path": "hoard/assets/hoard_abc123.png",
  "created_at": 1720345600,
  "last_accessed_at": 1720345600,
  "embedded": 1
}
```

跨源关联记录(hoard_relations 表):

```json
[
  {"hoard_id": "hoard_abc123", "related_type": "email", "related_id": "msg_456", "related_meta": {"subject": "前端架构评审 2024"}},
  {"hoard_id": "hoard_abc123", "related_type": "note", "related_id": "note_xyz", "related_meta": {"title": "React 技术栈调研"}},
  {"hoard_id": "hoard_abc123", "related_type": "chat", "related_id": "session_789", "related_meta": {"summary": "讨论 RSC 性能方案"}}
]
```

---

## 五、采集管道

### 5.1 管道流程

```
收藏触发
   │
   ▼
┌─────────────────────────────────────────┐
│ 步骤 1: 创建 hoard 记录(立即)         │
│   - 写入 hoards 表,embedded=0          │
│   - 立即返回 hoard_id 给前端           │
└─────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────┐
│ 步骤 2: 元数据抓取(异步)              │
│   - 链接型:HTTP 抓取 og:title/desc     │
│   - 浏览器场景:CDP 截图                │
│   - 片段型:跳过,直接用用户输入        │
└─────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────┐
│ 步骤 3: LLM 摘要 + 标签(异步)         │
│   - 复用 mona/providers OpenAI/Ollama   │
│   - 输入:title + content(截断到 2048)  │
│   - 输出:summary(200-500 字) + tags    │
│   - 写回 hoards 表                      │
└─────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────┐
│ 步骤 4: 向量化(异步)                  │
│   - 复用 mona/kb/chunker.py 分块        │
│   - 复用 mona/kb/embedding.py 向量化    │
│   - 写入 vectorstore.db                 │
│   - 更新 hoards.embedded=1              │
└─────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────┐
│ 步骤 5: 跨源关联(异步)                │
│   - 若有 url,扫描 email/note/chat      │
│   - URL 精确匹配,写入 hoard_relations  │
└─────────────────────────────────────────┘
```

### 5.2 复用现有模块

| 步骤 | 复用模块 | 改动 |
|------|----------|------|
| 元数据抓取 | [mona/agent/tools/http.py](../mona/agent/tools/http.py) | 加超时(10s)/反爬降级 |
| 截图 | 浏览器 CDP(已有 [browser.py](../mona/agent/tools/browser.py) `browser_get_cdp_port`) | 复用,无改动 |
| LLM 摘要+标签 | [mona/providers/](../mona/providers/) OpenAI/Ollama | 写一个 prompt 模板 |
| 分块 | [mona/kb/chunker.py](../mona/kb/chunker.py) `chunk_markdown` | 零改动 |
| 向量化 | [mona/kb/embedding.py](../mona/kb/embedding.py) `fetch_embedding` | 零改动 |
| 向量库 | [mona/kb/vectorstore.py](../mona/kb/vectorstore.py) | 新建 hoard 专用 db_path |

### 5.3 降级策略

| 场景 | 降级 |
|------|------|
| HTTP 抓取失败(403/超时) | 只存 url + 用户输入 title,content 为空,summary 由 LLM 基于 title 生成 |
| LLM 调用失败 | summary 为空,tags 为空,只做向量化(content 本身向量化) |
| Embedding 未配置 | 跳过向量化,只用 FTS5 全文搜索 |
| 截图失败 | asset_path 为空,不影响其他步骤 |

每个步骤独立失败,不阻塞其他步骤。`embedded` 字段标记是否完成向量化,cron 定期补全。

### 5.4 LLM Prompt 模板

摘要 + 标签生成:

```
你是 Mona 的记忆助手。请为以下内容生成摘要和标签。

## 标题
{title}

## 正文(截断到 2048 字)
{content}

## 任务
1. 生成 200-500 字的中文摘要,概括内容核心
2. 生成 3-8 个标签,覆盖主题、技术栈、内容类型

## 输出格式(JSON)
{
  "summary": "...",
  "tags": ["标签1", "标签2", ...]
}
```

---

## 六、检索与记忆访问

### 6.1 混合检索架构

```
用户查询 / Agent 查询
        │
        ▼
┌───────────────────────────────────────────────────┐
│ 查询解析                                          │
│   - query:自然语言                                │
│   - filters:source / tags / date_range(可选)    │
└───────────────────────────────────────────────────┘
        │
        ├──────────────┬──────────────┐
        ▼              ▼              ▼
┌───────────┐  ┌───────────┐  ┌───────────┐
│ FTS5      │  │ 向量检索  │  │ 结构化    │
│ 关键词召回│  │ 语义召回  │  │ 过滤      │
│ top 20    │  │ top 20    │  │ source/   │
│           │  │           │  │ tags/date │
└─────┬─────┘  └─────┬─────┘  └─────┬─────┘
      │              │              │
      └──────────────┴──────────────┘
                     │
                     ▼
            ┌─────────────────┐
            │ RRF 融合        │
            │ + 时间衰减      │
            │ × source_strength│
            └────────┬────────┘
                     │
                     ▼
            ┌─────────────────┐
            │ Top N 返回      │
            │ 附带 related    │
            └─────────────────┘
```

### 6.2 评分公式

```
final_score = RRF_score(fts, vector)
              × time_decay(created_at, now)
              × source_strength
              × (1 + access_bonus(last_accessed_at))
```

- `RRF_score`:复用 [mona/kb/search.py](../mona/kb/search.py) 的 RRF 融合逻辑
- `time_decay`:`exp(-Δt / 90天)`,3 个月半衰期
- `source_strength`:用户主动=1.0,Agent 自动=0.8
- `access_bonus`:最近 7 天被召回过,+0.2 加成

### 6.3 跨源关联查询

`hoard_search` 返回结果时,附带 `related_sources` 字段:

```json
{
  "id": "hoard_abc123",
  "title": "React Server Components",
  "url": "https://...",
  "summary": "...",
  "tags": ["React", "RSC"],
  "source": "browser",
  "created_at": "2024-12-20T10:00:00Z",
  "related_sources": [
    {"type": "email", "id": "msg_456", "subject": "前端架构评审"},
    {"type": "note", "id": "note_abc", "title": "前端技术栈 2024"},
    {"type": "chat", "id": "session_xxx", "summary": "讨论 RSC 性能方案"}
  ]
}
```

Agent 拿到结果后,可以继续调用 [email_read](../mona/agent/tools/email_intel.py) 读那封邮件,调用 [notes_read](../mona/agent/tools/notes.py) 读那条笔记。**孤岛被打通**。

### 6.4 三种调用层次

#### 层次 1:Agent 显式工具(核心)

新增两个工具,注册到 [mona/agent/tools/](../mona/agent/tools/),由 ToolLoader 自动发现:

| 工具 | 用途 | 调用时机 |
|------|------|----------|
| `hoard_search` | 检索收藏库,支持 query + source/tags/date 过滤 | Agent 主动调用,类似 [kb_search](../mona/kb/tool.py) |
| `hoard_capture` | 把一条 url/片段入库 | Agent 在对话中识别到值得记的内容时 |

#### 层次 2:对话上下文自动注入(RAG)

在 [agent/loop.py](../mona/agent/loop.py) 的对话开始阶段,自动用当前对话主题检索 hoard,top 3 注入 system prompt:

```
[相关记忆]
- 上周你浏览过《React Server Components 深度解析》(浏览器,3 次访问)
- 2024-12-03 的邮件《前端架构评审》提到过这个主题
- 笔记《前端技术栈 2024》中讨论过相关内容
```

这是"被动记忆" —— Agent 不需要主动调工具,相关内容就在上下文里。**这是区别于 karakeep 的核心:karakeep 要用户去搜,Mona 让 Agent 自己想起来**。

#### 层次 3:跨源关联跳转

通过 `hoard_search` 返回的 `related_sources`,Agent 可以跨模块跳转读取详细内容。

---

## 七、Agent 工具 Schema

### 7.1 hoard_search

```python
_HOARD_SEARCH_PARAMETERS = tool_parameters_schema(
    query=StringSchema("搜索查询,自然语言或关键词"),
    source=StringSchema("来源过滤:browser|email|note|chat|manual(可选)"),
    tags=ArraySchema("标签过滤,匹配任意一个(可选)"),
    date_from=StringSchema("起始日期 ISO 格式如 2025-01-01(可选)"),
    date_to=StringSchema("结束日期 ISO 格式如 2025-12-31(可选)"),
    count=IntegerSchema("返回结果数量(1-20,默认 5)", minimum=1, maximum=20),
    required=["query"],
)

class HoardSearchTool(Tool):
    name = "hoard_search"
    description = (
        "搜索 Mona 记忆库(Hoard),召回用户在浏览器、邮件、笔记、对话中收藏过的内容。"
        "返回标题、摘要、标签、来源和相关联的其他信息源。"
        "适用场景:用户问'之前看过的''上周聊到的''邮件里提到的'等需要回忆历史内容的问题。"
    )
    _scopes = {"core", "subagent"}

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, query: str, source: str = None, tags: list = None,
                      date_from: str = None, date_to: str = None,
                      count: int = 5, **kwargs) -> str:
        # 1. FTS5 关键词检索
        # 2. 向量语义检索(embedding 配置存在时)
        # 3. RRF 融合 + 时间衰减 + source_strength
        # 4. 结构化过滤(source/tags/date)
        # 5. 附带 related_sources
        # 6. 更新 last_accessed_at
        ...
```

### 7.2 hoard_capture

```python
_HOARD_CAPTURE_PARAMETERS = tool_parameters_schema(
    url=StringSchema("要收藏的 URL(链接型必填,片段型可空)"),
    title=StringSchema("标题(可选,不填则自动抓取)"),
    content=StringSchema("片段文本(片段型必填,链接型可空)"),
    source=StringSchema("来源:browser|email|note|chat|manual", default="chat"),
    source_ref=StringSchema("来源标识:email_id / note_id / session_id(可选)"),
    note=StringSchema("用户备注(可选)"),
    required=["source"],
)

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

    @property
    def read_only(self) -> bool:
        return False

    async def execute(self, source: str = "chat", url: str = None, title: str = None,
                      content: str = None, source_ref: str = None,
                      note: str = None, **kwargs) -> str:
        # 1. 创建 hoard 记录(source_strength=0.8)
        # 2. 异步触发采集管道(抓取 → 摘要 → 标签 → 向量化)
        # 3. 返回 hoard_id
        ...
```

---

## 八、文件结构(新增)

### 8.1 Python 侧

```
mona/hoard/
  __init__.py
  models.py        -- 数据模型 + SQLite 操作(hoardsqlite3 + FTS5 + relations)
  ingest.py        -- 采集管道:抓取 → 摘要 → 标签 → 向量化
  search.py        -- 混合检索(FTS5 + vector + RRF + 时间衰减)
  prompts.py       -- LLM 摘要/标签 prompt 模板
mona/agent/tools/
  hoard.py         -- Agent 工具:hoard_search / hoard_capture
mona/api/
  hoard_handlers.py -- HTTP handlers(hoard_add / hoard_list / hoard_delete / hoard_search)
  server.py         -- 注册路由(改动)
mona/config/
  schema.py         -- 新增 HoardConfig(改动)
```

### 8.2 Rust 侧

```
src-tauri/src/
  hoard.rs         -- Tauri 命令(hoard_add / hoard_list / hoard_delete / hoard_get)
  lib.rs           -- 注册 hoard 模块(改动)
```

### 8.3 前端

```
webui/src/
  lib/hoard-api.ts        -- Hoard API 客户端
  components/hoard/
    HoardView.tsx         -- 收藏列表/详情主视图
    HoardListItem.tsx     -- 列表项
    HoardDetail.tsx       -- 详情面板(摘要 + 标签 + 关联来源)
    HoardCaptureButton.tsx -- 浏览器/邮件/笔记右键菜单集成
  views/
    主界面新增"Hoard"入口(图标 tab)
```

### 8.4 数据目录

```
<app_data>/mona/hoard/
  hoard.sqlite3        -- 主表 + FTS5 + relations
  vectorstore.db       -- sqlite-vec 向量索引
  assets/              -- 截图/附件
```

---

## 九、与现有模块的集成点

### 9.1 浏览器集成

- 浏览器右键菜单新增"收藏到 Mona"
- 地址栏新增星标按钮
- 复用 [browser/storage.rs](../src-tauri/src/browser/storage.rs) 的 bookmarks 表数据(已收藏的书签可一键导入 hoard)
- 复用浏览器 CDP 能力做截图

### 9.2 邮件集成

- 邮件正文链接右键"收藏"
- 邮件附件右键"加入记忆库"
- 入库时 `source=email`, `source_ref=email_id`, `related_meta` 记录邮件主题
- 反向:hoard 检索结果可以跳转到原邮件

### 9.3 笔记集成

- 笔记选中文本右键"收藏为片段"
- 入库时 `source=note`, `source_ref=note_id`, `related_meta` 记录笔记标题
- 反向:hoard 检索结果可以跳转到原笔记
- 与 notes_kb 的关系:notes_kb 索引整个 vault,hoard 只索引用户选中的片段,两者互补

### 9.4 Agent Loop 集成

- [agent/loop.py](../mona/agent/loop.py) 对话开始时,自动检索 hoard top 3 注入 system prompt
- Agent 工具 `hoard_search` / `hoard_capture` 由 ToolLoader 自动发现

### 9.5 KB 模块关系

| 维度 | KB([mona/kb/](../mona/kb/)) | Hoard(本方案) |
|------|------------------------------|----------------|
| 数据来源 | 用户主动 ingest 项目 | 浏览器/邮件/笔记/对话收藏 |
| 数据形态 | 完整 wiki 页面 | 碎片(链接 + 片段) |
| 生命周期 | 永久 | 可清理(6 个月归档) |
| 向量库 | 项目独立 db | hoard 独立 db |
| Agent 工具 | [kb_search](../mona/kb/tool.py) | `hoard_search` |

两者并行,不冲突。KB 是"项目化深度知识",Hoard 是"跨源碎片记忆"。

---

## 十、配置

### 10.1 HoardConfig

```python
# mona/config/schema.py 新增
class HoardConfig(Base):
    """Hoard(Agent 记忆库)配置。"""
    enabled: bool = True
    # Embedding 配置(复用 notes_kb 的配置或独立配置)
    embedding: EmbeddingConfig = EmbeddingConfig()
    # 自动摘要/标签
    auto_summary: bool = True
    auto_tags: bool = True
    # 截图(仅浏览器场景)
    auto_screenshot: bool = True
    # 清理策略
    archive_after_days: int = 180  # 6 个月未访问自动归档
    # Agent 自动收藏
    agent_auto_capture: bool = True  # 允许 Agent 调用 hoard_capture
    # 上下文注入
    context_injection_count: int = 3  # 对话开始时注入 top N
```

### 10.2 Embedding 配置复用

Hoard 的 embedding 配置独立于 notes_kb,但默认值相同。用户可以在设置页分别配置:
- notes_kb 用 OpenAI text-embedding-3-small
- hoard 用 Ollama nomic-embed-text(本地,无 API 成本)

如果用户不配置 hoard 的 embedding,降级为只用 FTS5 全文搜索。

---

## 十一、实施路线(分 4 阶段)

### 阶段 1:核心管道(最小可用)

**目标**:用户能从浏览器/邮件/笔记右键收藏,Agent 能检索

- [ ] Rust 侧 `hoard.rs`:SQLite 表初始化 + CRUD Tauri 命令
- [ ] Python 侧 `mona/hoard/models.py`:数据模型 + SQLite 操作
- [ ] Python 侧 `mona/hoard/ingest.py`:采集管道(HTTP 抓取 + LLM 摘要/标签 + 向量化)
- [ ] Python 侧 `mona/hoard/search.py`:FTS5 + 向量混合检索 + RRF
- [ ] Agent 工具 `mona/agent/tools/hoard.py`:`hoard_search` + `hoard_capture`
- [ ] HTTP handlers `mona/api/hoard_handlers.py` + 路由注册
- [ ] 前端右键菜单集成(浏览器/邮件/笔记)

**验收**:浏览器收藏一个链接 → 30 秒内可在 Hoard 视图看到摘要和标签 → Agent 对话中能搜到

### 阶段 2:跨源关联 + 上下文注入

**目标**:Agent 对话时能自动想起相关记忆

- [ ] `hoard_relations` 表 + URL 精确匹配关联逻辑
- [ ] `hoard_search` 返回 `related_sources`
- [ ] [agent/loop.py](../mona/agent/loop.py) 对话开始时 RAG 注入 top 3
- [ ] 前端 Hoard 详情面板展示关联来源
- [ ] 跨源跳转(hoard → 邮件/笔记)

**验收**:收藏一个链接 → 在邮件里出现同一链接 → Agent 对话中能同时召回两者

### 阶段 3:UI 完善与治理

**目标**:完整的收藏管理体验

- [ ] Hoard 主视图(列表 + 详情 + 搜索 + 标签过滤)
- [ ] 列表项支持编辑标签/删除/手动添加摘要
- [ ] 6 个月归档 cron + 归档恢复 UI
- [ ] 设置页 Hoard 配置(embedding / 自动摘要 / 清理策略)
- [ ] Agent 自动入库的内容在 UI 标记,可一键删除

**验收**:用户能完整管理收藏库,Agent 自动入库的内容可识别可删除

### 阶段 4:体验优化(可选)

- [ ] 浏览器书签批量导入 hoard
- [ ] 邮件附件预览(图片/PDF)
- [ ] 收藏时的实时进度反馈(抓取中 → 摘要中 → 已完成)
- [ ] Hoard 统计面板(总数 / 来源分布 / 标签云)

---

## 十二、风险与边界

### 12.1 已识别风险

| 风险 | 缓解 |
|------|------|
| 存储膨胀 | 6 个月归档策略;不归档原文;截图压缩 |
| LLM 调用成本 | 摘要/标签 prompt 截断到 2048 字;用户可关闭 auto_summary |
| Agent 自动入库噪音 | source_strength=0.8 降权;UI 可删除;prompt 约束判断标准 |
| 反爬站点抓取失败 | 降级为只存 url+title,summary 由 LLM 基于 title 生成 |
| 向量库与 notes_kb 冲突 | 独立 db_path,page_id 用 hoard.id 前缀 |

### 12.2 明确不做的事

| 能力 | 原因 |
|------|------|
| 整页归档(monolith) | 体积爆炸,违反自包含红线 |
| 视频归档(yt-dlp) | 外部依赖,场景窄 |
| OCR | 第一版不做,后续按需评估 |
| 协作列表 | 单机产品,无协作场景 |
| 跨设备同步 | 桌面端,无同步需求 |
| RSS 自动订阅 | 范围外 |
| 浏览轨迹被动索引 | 用户决策:只索引主动收藏 |
| 语义关联(非 URL 匹配) | 第一版只做 URL 精确匹配,语义关联留给 vector 搜索 |

---

## 十三、验证清单

实施完成后,以下场景应全部通过:

1. ✅ 浏览器收藏 `https://react.dev/learn/server-components` → 30 秒内 Hoard 视图可见摘要和标签
2. ✅ 邮件正文同一 URL 出现 → hoard_relations 自动关联
3. ✅ 笔记选中一段文本右键收藏 → 片段型 hoard 创建成功
4. ✅ Agent 对话中问"上周收藏的 React 文章" → `hoard_search` 返回结果
5. ✅ Agent 对话中提到某 URL → 自动调用 `hoard_capture` 入库(source_strength=0.8)
6. ✅ 对话开始时,system prompt 自动注入 top 3 相关记忆
7. ✅ Hoard 详情面板展示关联的邮件/笔记/对话
8. ✅ 用户可在 UI 删除 Agent 自动入库的内容
9. ✅ Embedding 未配置时,降级为 FTS5 全文搜索仍可用
10. ✅ 6 个月未访问的 hoard 自动归档

---

## 附:关键决策记录

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 浏览轨迹索引 | 不做,只索引主动收藏 | 噪音大,用户明确决策 |
| Agent 自动入库 | 允许,降权 0.8 | 让 Agent 有主动记忆能力,用户可删除 |
| 跨源关联 | URL 精确匹配 | 第一版简单可靠,语义关联留给 vector |
| 原文归档 | 不做 | 体积/成本,需要时实时抓取 |
| 向量库 | 独立 db_path | 生命周期不同,避免影响 notes_kb |
| 搜索引擎 | SQLite FTS5 + sqlite-vec | 零依赖,符合自包含红线 |
| 记忆形态 | 语义摘要为主,URL 为锚 | Agent 记住的是"讲了什么",不是"在哪" |
