# 笔记向量索引设计方案（复用 KB 三件套，跳过 LLM 编译）

> 日期：2026-07-06
> 范围：笔记模块检索能力升级
> 前置决策：[2026-07-03 笔记模块"知识"功能删除与 Obsidian 范式对齐](./2026-07-03-notes-knowledge-removal-design.md) 已落地，二级知识概念已移除，`knowledgeBaseEnabled` 与 `contextLevel` 保留
> 不在范围：独立 KB RAG 功能（`webui/src/components/knowledge/` 与 `mona/kb/` 的项目级 RAG 链路本身不动）

---

## 一、背景与动机

### 1.1 当前状态

2026-07-03 删除「知识」二级概念后，笔记模块的「知识库」入口只剩下一个标记：

- 用户在笔记本上右键「标记为知识库」→ 写入 `vault.json` 的 `knowledgeBaseEnabled`
- 该笔记本出现在聊天面板的「知识库选择器」中（`ThreadShell.tsx`，id 形如 `notebook:<id>`）
- Agent 通过 `notes_search_all` 检索 → **纯内存子串匹配**，无打分、无向量、无 RRF 融合

### 1.2 核心问题

「标记为知识库」是 UI 承诺，但检索质量撑不起这个承诺：

| 维度 | 现状 | 期望 |
|------|------|------|
| 检索方式 | `String::contains` 子串匹配 | 关键词 + 向量 + RRF 混合 |
| 打分 | `rank: 0.0` 全部相同 | 文件名/标题/正文差异化打分 |
| 语义匹配 | 无 | 有（embedding） |
| 与 KB 的检索能力差距 | 巨大 | 复用同一套逻辑 |

### 1.3 设计目标

让「标记为知识库」名副其实：标记后，笔记复用 KB 的混合检索能力；不重新引入任何二级概念，不让 LLM 重写笔记内容。

---

## 二、核心原则

### 原则 1：只索引，不编译

用户手写的笔记已经是结构化 markdown（标题、标签、frontmatter 都齐全），让 LLM 重写会：
- 浪费 token
- 破坏用户原本清晰的逻辑
- 引入幻觉

LLM 完全不参与内容改写。只做「切片 + 向量化 + 入库 + 检索」这四件机械操作。

### 原则 2：复用 KB 现有代码

KB 模块的三件套是纯函数式实现，不绑定 KB 项目概念：

| KB 文件 | 作用 | 是否可复用 |
|--------|------|-----------|
| `mona/kb/chunker.py` | markdown 切片（按 heading + 字数） | ✓ 完全复用 |
| `mona/kb/embedding.py` | 调 OpenAI/Gemini/Ollama 取向量 | ✓ 完全复用 |
| `mona/kb/vectorstore.py` | sqlite-vec 存取 chunks | ✓ 扩展 db_path 参数后复用 |
| `mona/kb/search.py` 的 `search_wiki_hybrid` | 关键词 + 向量 + RRF 混合 | ✓ 重构暴露参数后复用 |

只做最小重构（暴露 `markdown_dir` 和 `vectorstore_db` 参数），KB 现有调用走默认值不变。

### 原则 3：vault 自包含

向量索引文件放在 `<vault>/.mona/vectorstore.db`，与 `vault.json` 同级：
- vault 整体备份/同步（Git/iCloud）时索引一起走
- 跨 vault 切换自动用新库，零污染
- 删除 vault 即删除索引，无残留

### 原则 4：增量优先

- 标记 KB 时：批量首次索引整个笔记本
- 笔记保存时：只更新单条笔记的向量
- 删除笔记时：移除对应向量
- 不做实时 watch，不做全量重建（除非用户手动触发）

---

## 三、架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                        用户操作                              │
│  ① 右键「标记为知识库」  ② 编辑保存笔记  ③ 聊天选 notebook   │
└──────────┬─────────────────┬──────────────┬────────────────┘
           │                 │              │
           ▼                 ▼              ▼
┌─────────────────┐ ┌──────────────┐ ┌────────────────────┐
│ toggleNotebook  │ │ saveNote     │ │ ThreadShell       │
│ KnowledgeBase   │ │ (notes-store)│ │ onKbSelected      │
└────────┬────────┘ └──────┬───────┘ └─────────┬──────────┘
         │                 │                    │
         ▼                 ▼                    ▼
┌──────────────────────────────────────────────────────────────┐
│  HTTP 路由（新增 3 个，在 mona/api/server.py 注册）           │
│  POST /api/notes-kb/reindex-notebook                        │
│  POST /api/notes-kb/reindex-note                            │
│  POST /api/notes-kb/search                                  │
└────────┬─────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  mona/notes_kb/（新增模块）                                   │
│  ├── indexer.py   index_note / index_notebook / unindex_note │
│  └── search.py    search_notes_hybrid                        │
└────────┬─────────────────────────────────────────────────────┘
         │ 复用
         ▼
┌──────────────────────────────────────────────────────────────┐
│  mona/kb/ 现有三件套（最小重构）                              │
│  ├── chunker.py     chunk_markdown(content, opts)            │
│  ├── embedding.py   fetch_embedding(text, cfg)              │
│  ├── vectorstore.py upsert_chunks(db_path, page_id, chunks) │
│  │                  search_chunks(db_path, vec, top_k)      │
│  │                  delete_page(db_path, page_id)            │
│  └── search.py     search_wiki_hybrid(markdown_dir=,         │
│                     vectorstore_db=, query, cfg, count)     │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  存储                                                        │
│  <vault>/.mona/vectorstore.db   ← sqlite-vec，每笔记多 chunk │
│  <vault>/.mona/vault.json       ← 现有，存 knowledgeBaseEnabled│
│  <vault>/*.md                   ← 用户笔记，只读不动          │
└──────────────────────────────────────────────────────────────┘
```

---

## 四、数据流详解

### 4.1 标记笔记本为知识库（首次索引）

```
用户右键「标记为知识库」
  ↓
NotesView.toggleNotebookKnowledgeBase(notebookId, enable=true)
  ↓
1. 写入 vault.json: notebooks[id].knowledgeBaseEnabled = true
2. 同步 useKbStore.setNotebookKbList(...) → 聊天选择器显示该项
3. 检查 useKbStore.embedDraft（全局 embedding 配置）
   ├─ 未配置：toast 提示「未配置 Embedding，将仅使用关键词检索」
   └─ 已配置：调 POST /api/notes-kb/reindex-notebook
               body: { vaultPath, notebookId, embeddingConfig }
  ↓
后端 mona/notes_kb/indexer.py::index_notebook(vault_path, notebook_dir, cfg)
  ↓
遍历 notebook_dir 下的 *.md：
  1. 解析 frontmatter（手写解析，复用 notes.rs 的逻辑约定）
  2. 读取 contextLevel
     ├─ "none"   → 跳过
     ├─ "summary"→ 只取首段（frontmatter 后第一个 ## 或 --- 之前）
     └─ "full"   → 全文
  3. 调 chunker.chunk_markdown(content) → 切片
  4. 对每个 chunk 调 embedding.fetch_embedding → 取向量
  5. 调 vectorstore.upsert_chunks(vault/.mona/vectorstore.db, note_id, chunks)
  ↓
返回 { indexed: N, skipped: M, failed: K }
  ↓
前端 toast 成功
```

### 4.2 笔记保存时增量索引

```
用户编辑笔记 → 点保存
  ↓
notes-storage.saveNote(note)
  ↓
1. 调 Tauri notes_save_state 写入 .md
2. 检查该 note 所在 notebook 是否 knowledgeBaseEnabled
3. 检查 useKbStore.embedDraft.enabled
4. 若都为真：调 POST /api/notes-kb/reindex-note
              body: { vaultPath, noteId, content, embeddingConfig }
  ↓
后端 mona/notes_kb/indexer.py::index_note(vault_path, note_id, content, cfg)
  ↓
1. 调 vectorstore.delete_page(db_path, note_id)  ← 先删旧
2. chunk + embed + upsert（同上）
  ↓
返回 { chunks: N }
  ↓
前端静默（不打扰用户）
```

### 4.3 删除笔记时清理

```
用户删除笔记
  ↓
notes-storage.deleteNote(noteId)
  ↓
1. 调 Tauri 删除 .md
2. 调 POST /api/notes-kb/unindex-note（新增）
   body: { vaultPath, noteId }
  ↓
后端 mona/notes_kb/indexer.py::unindex_note(vault_path, note_id)
  ↓
调 vectorstore.delete_page(db_path, note_id)
```

### 4.4 聊天检索路由分发

```
用户在聊天选 notebook:xxx，提问
  ↓
ThreadShell.onKbSelected(kbId, query)
  ↓
判断 kbId 前缀：
  ├─ "notebook:" → 调 POST /api/notes-kb/search
  │                 body: { vaultPath, notebookId, query, embeddingConfig }
  └─ 其他       → 调 KB 现有 GET /api/kb/{id}/search
  ↓
后端 mona/notes_kb/search.py::search_notes_hybrid(vault_path, query, cfg)
  ↓
调 mona/kb/search.py::search_wiki_hybrid(
    markdown_dir=vault_path,           # 直接扫 vault 根 .md
    vectorstore_db=vault/.mona/vectorstore.db,
    query=query, embedding_config=cfg, count=10
)
  ↓
返回 { mode: "hybrid"|"keyword"|"vector", results: [...] }
  ↓
前端按 mode 展示结果
```

### 4.5 取消知识库标记

```
用户右键「取消知识库」
  ↓
1. 写入 vault.json: knowledgeBaseEnabled = false
2. 从 useKbStore.notebookKbList 移除
3. 调 POST /api/notes-kb/unindex-notebook
   body: { vaultPath, notebookId }
  ↓
后端遍历该 notebook 下所有 .md，对每个 note_id 调 delete_page
```

---

## 五、contextLevel 与索引的映射

复用现有字段，语义不变：

| contextLevel | 索引行为 | 检索返回 |
|--------------|---------|---------|
| `full` | 索引全文 | 完整 chunk 片段 |
| `summary` | 只索引 frontmatter 后第一个 H1 段落（用户手写的摘要） | 摘要片段 |
| `none` | 跳过索引 | 不出现在结果中 |

实现：

```python
def _filter_by_context_level(content: str, level: str) -> str:
    if level == "none":
        return ""
    if level == "summary":
        return _extract_first_section(content)  # 首个 ## 之前的内容
    return content  # full
```

`_extract_first_section` 逻辑：跳过 frontmatter → 取到第一个 `## ` 或 `---` 之前的内容。

---

## 六、Embedding 配置归属

### 决策：全局共享，不复制

KB 现有的 embedding 配置存储在 `kb-store.embedDraft`（localStorage 持久化），key 为 `mona-kb-embed-draft`。

- 笔记模块**不另存一份**配置
- 前端调用 notes-kb 接口时，把当前 `embedDraft` 作为请求体字段一起传给后端
- 后端 `mona/notes_kb/` 完全无状态，配置由调用方注入

理由：用户配一次同时用于 KB 和笔记；避免双份配置不一致；后端无状态。

---

## 七、改动清单

### 7.1 新增文件

| 文件 | 行数预估 | 职责 |
|------|---------|------|
| `mona/notes_kb/__init__.py` | 1 | 包标记 |
| `mona/notes_kb/indexer.py` | ~80 | 笔记切片+向量化+入库，支持 contextLevel 过滤 |
| `mona/notes_kb/search.py` | ~30 | 封装 search_wiki_hybrid，注入 vault 路径 |

### 7.2 重构现有文件（最小侵入）

| 文件 | 改动 | 行数 |
|------|------|------|
| `mona/kb/search.py` | `search_wiki_hybrid` 新增 `markdown_dir` 和 `vectorstore_db` 可选参数，默认值维持原行为 | +10 |
| `mona/kb/vectorstore.py` | `upsert_chunks` / `search_chunks` / `delete_page` / `count_chunks` 新增可选 `db_path` 参数，默认 `_db_path(project_path)` | +20 |

### 7.3 新增 HTTP 路由

在 `mona/api/server.py` 注册（gateway HTTP server，前端走 `getGatewayHttpBase()`）：

| 方法 | 路径 | 职责 |
|------|------|------|
| POST | `/api/notes-kb/reindex-notebook` | 批量索引某笔记本 |
| POST | `/api/notes-kb/reindex-note` | 单条笔记增量 |
| POST | `/api/notes-kb/unindex-note` | 删除单条笔记向量 |
| POST | `/api/notes-kb/unindex-notebook` | 删除整笔记本向量 |
| POST | `/api/notes-kb/search` | 混合检索 |

请求体均包含 `vaultPath` 和 `embeddingConfig`（配置由前端注入）。

### 7.4 前端改动

| 文件 | 改动 |
|------|------|
| `webui/src/lib/kb-api.ts` | 新增 5 个 API 方法 |
| `webui/src/components/notes/NotesView.tsx` | `toggleNotebookKnowledgeBase` 触发 reindex/unindex |
| `webui/src/components/notes/notes-storage.ts` | `saveNote` 后调 reindex-note；`deleteNote` 后调 unindex-note |
| `webui/src/components/chat/ThreadShell.tsx` | `onKbSelected` 按 `notebook:` 前缀路由分发 |

### 7.5 Agent 工具升级

`mona/agent/tools/notes.py` 的 `NotesSearchTool.execute`：

1. 尝试调 `search_notes_hybrid`（若 embedding 已配置且 vault 有 vectorstore.db）
2. 失败或无配置 → 降级到现有 `tauri_invoke("notes_search_all")` 子串匹配

Agent 工具签名不变，向后兼容。

---

## 八、关键代码骨架

### 8.1 `mona/notes_kb/indexer.py`

```python
"""Notes vectorstore indexer - reuses KB chunker/embedding/vectorstore."""

from pathlib import Path
from mona.kb.chunker import chunk_markdown, ChunkingOptions
from mona.kb.embedding import EmbeddingConfig, fetch_embedding
from mona.kb import vectorstore


def _db_path(vault_path: Path) -> Path:
    return vault_path / ".mona" / "vectorstore.db"


def _filter_by_context_level(content: str, level: str) -> str:
    if level == "none":
        return ""
    if level == "summary":
        return _extract_first_section(content)
    return content


def _extract_first_section(content: str) -> str:
    # 跳过 frontmatter，取到第一个 ## 或 --- 之前
    ...


async def index_note(
    vault_path: Path,
    note_id: str,
    content: str,
    context_level: str,
    embedding_config: EmbeddingConfig,
) -> int:
    if not embedding_config.enabled:
        return 0
    filtered = _filter_by_context_level(content, context_level)
    if not filtered.strip():
        await vectorstore.delete_page(_db_path(vault_path), note_id)
        return 0
    chunks = chunk_markdown(filtered, ChunkingOptions())
    enriched = []
    for c in chunks:
        emb = await fetch_embedding(c.text, embedding_config)
        if emb:
            enriched.append({
                "chunk_index": c.index,
                "chunk_text": c.text,
                "heading_path": c.heading_path,
                "embedding": emb,
            })
    if enriched:
        await vectorstore.upsert_chunks(_db_path(vault_path), note_id, enriched)
    else:
        await vectorstore.delete_page(_db_path(vault_path), note_id)
    return len(enriched)


async def unindex_note(vault_path: Path, note_id: str) -> None:
    await vectorstore.delete_page(_db_path(vault_path), note_id)


async def index_notebook(
    vault_path: Path,
    notebook_dir: Path,
    embedding_config: EmbeddingConfig,
) -> dict:
    stats = {"indexed": 0, "skipped": 0, "failed": 0}
    for md_file in notebook_dir.rglob("*.md"):
        try:
            content = md_file.read_text(encoding="utf-8")
            note_id, level = _parse_frontmatter(content)
            n = await index_note(vault_path, note_id, content, level, embedding_config)
            if n > 0:
                stats["indexed"] += 1
            else:
                stats["skipped"] += 1
        except Exception:
            stats["failed"] += 1
    return stats
```

### 8.2 `mona/kb/search.py` 重构（关键差异）

```python
async def search_wiki_hybrid(
    project_path: Path,
    query: str,
    embedding_config: EmbeddingConfig | None = None,
    count: int = 10,
    # 新增：支持复用给 notes_kb
    markdown_dir: Path | None = None,
    vectorstore_db: Path | None = None,
) -> dict[str, Any]:
    wiki_dir = markdown_dir if markdown_dir is not None else (project_path / "wiki")
    # 后续 vectorstore 调用全部走 vectorstore_db if provided else _db_path(project_path)
    ...
```

KB 现有调用 `search_wiki_hybrid(project_path, query, cfg)` 完全不变（两个新参数走默认值）。

### 8.3 `mona/kb/vectorstore.py` 重构（关键差异）

```python
async def upsert_chunks(
    project_path: Path,
    page_id: str,
    chunks: list[dict[str, Any]],
    db_path: Path | None = None,  # 新增
) -> None:
    actual_db = db_path if db_path is not None else _db_path(project_path)
    ...
```

四个函数（`upsert_chunks` / `search_chunks` / `delete_page` / `count_chunks`）统一加 `db_path` 可选参数。

---

## 九、风险与降级

| 风险 | 对策 |
|------|------|
| 大 vault 首次索引慢 | 增量优先；批量索引时前端显示进度 toast；支持后台异步 |
| embedding 服务不可用 | 沿用 KB 现有降级：`fetch_embedding` 返回 None → `mode="keyword"`，笔记仍可子串搜索 |
| 索引与笔记内容不一致 | 用 `updatedAt` 做指纹；后端可选检测 mtime 与 vectorstore 时戳，过期才重索引 |
| 跨 vault 切换污染 | vectorstore.db 在 vault 内，切 vault 自动用新库 |
| 删除笔记后残留向量 | `deleteNote` 必须调 `unindex_note` |
| token 成本 | 只在首次启用 KB 标记时全量索引；后续增量；用户可手动「重建索引」 |
| 用户未配置 embedding | UI 明确提示「仅关键词检索」，不静默失败 |

---

## 十、验证清单

### 10.1 功能验证

- [ ] 单元：`notes_kb.indexer.index_note` 输入样例 .md → 检查 vectorstore 表行数与 chunk_text 正确
- [ ] 单元：`_filter_by_context_level` 对三种 level 返回正确内容
- [ ] 集成：toggle KB 标记后，聊天选该 notebook 提问 → 应返回混合检索结果
- [ ] 集成：编辑笔记保存后，再搜新内容 → 应能命中（增量索引生效）
- [ ] 集成：删除笔记后，再搜 → 不应再命中
- [ ] 集成：取消 KB 标记 → 该 notebook 笔记不再出现在搜索结果

### 10.2 降级验证

- [ ] 断网/embedding 服务挂掉 → `notes_search` 仍能子串匹配
- [ ] embedding 未配置 → toggle KB 时提示，仍可用关键词检索
- [ ] vectorstore.db 不存在 → search 返回空，不报错

### 10.3 contextLevel 验证

- [ ] `contextLevel=none` 的笔记 → 标记 KB 后仍不应被搜到
- [ ] `contextLevel=summary` 的笔记 → 只返回首段片段
- [ ] `contextLevel=full` 的笔记 → 返回完整匹配片段

### 10.4 兼容性验证

- [ ] KB 项目（`~/MonaKB/<proj>/`）的检索行为完全不变
- [ ] KB 的 embedding 配置 UI 仍正常工作
- [ ] 笔记的现有编辑/移动/标签功能不受影响

---

## 十一、不做的事（避免过度工程）

- ✗ 不为笔记单独写 chunker —— 复用 `mona/kb/chunker.py`
- ✗ 不让 LLM 重写笔记内容 —— 路线 3 核心原则
- ✗ 不引入 GraphRAG —— Karpathy 已证明小规模不需要
- ✗ 不改笔记的 frontmatter schema —— 复用现有 `contextLevel` 字段
- ✗ 不在 vault 内建 `raw/wiki/output` 三层结构 —— 那是 LLM Wiki 模式，不是索引模式
- ✗ 不做实时向量同步（watch 文件系统）—— 笔记保存触发增量即可
- ✗ 不为笔记单独写 embedding 配置 UI —— 复用 KB 现有 UI
- ✗ 不引入知识图谱可视化 —— 笔记间的 `[[wiki link]]` 双链是未来可选项，本期不做

---

## 十二、与 LLM Wiki 模式的边界

本方案与 Karpathy 的 LLM Wiki 模式有清晰边界：

| 维度 | LLM Wiki 模式 | 本方案 |
|------|--------------|--------|
| 适用对象 | 外部导入的原始资料（PDF/网页/视频） | 用户手写的笔记 |
| LLM 介入 | ingest 阶段重写为结构化 wiki | 不介入，只做索引 |
| 目录结构 | raw/wiki/output 三层 | vault 扁平结构 |
| 知识积累 | 每次操作让 wiki 更丰富 | 索引随笔记更新 |
| 适用场景 | 资料消化 + 问答 | 个人记录 + 检索 |

**两者不冲突**：KB 模块（`mona/kb/`）走 LLM Wiki 模式，处理导入资料；笔记模块走本方案，处理用户手写内容。用户可以同时用两者。

---

## 十三、后续可选演进（不在本期）

1. **`[[wiki link]]` 双向链接**：在笔记间引入 Obsidian 风格的双向链接，前端 Graph View 可视化
2. **跨系统检索**：聊天时同时检索 KB 项目 + 笔记 vault，统一排序
3. **基于向量检索的「相关笔记」推荐**：当前笔记打开时，右侧面板显示语义相关笔记
4. **笔记间实体抽取**：从笔记中抽取实体（人名/项目/概念），构建轻量图谱

这些都是在索引能力跑通后的增量演进，本期不涉及。

---

## 十四、实施顺序建议

1. **第一步：后端核心**（`mona/notes_kb/` 三个文件 + `mona/kb/` 重构）
   - 可独立测试，不依赖前端
   - 单元测试覆盖 index_note / search_notes_hybrid

2. **第二步：HTTP 路由**（`mona/api/server.py` 注册 5 个路由）
   - 用 curl/Postman 验证端到端

3. **第三步：前端集成**
   - `kb-api.ts` 新增 API 方法
   - `NotesView.tsx` toggle 触发索引
   - `notes-storage.ts` 保存触发增量
   - `ThreadShell.tsx` 路由分发

4. **第四步：Agent 工具升级**
   - `notes.py` 的 `NotesSearchTool` 智能降级

5. **第五步：验证清单全跑**

每一步可独立验证，避免大爆炸式集成。
