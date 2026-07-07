# Mona 笔记知识库开发计划(执行手册)

> 日期:2026-07-07
> 范围:指导开发者按阶段实施 [2026-07-06-notes-knowledge-base-design.md](./2026-07-06-notes-knowledge-base-design.md)
> 本次执行:MVP = 阶段 1(双链+MOC+反链+嵌套标签+Frontmatter)+ 阶段 4 基础(向量索引+Vault QA)
> 设计原则:最小改动、复用 KB、不破坏现有数据

---

## 一、现状基线(已确认)

| 项 | 当前状态 |
|----|---------|
| `src-tauri/src/notes.rs` | 1718 行单文件 |
| `webui/src/components/notes/NotesView.tsx` | 1851 行 |
| `webui/src/components/notes/NoteAgentPanel.tsx` | 1128 行 |
| 编辑器 | Tiptap v3 + `MarkdownEditor.tsx` |
| frontmatter 字段 | 11 个(id/notebookId/title/source/tags/contextLevel/agentChatId/appliedAgentMessageIds/createdAt/updatedAt) |
| notes_search | 纯子串匹配(Rust 端 `String::contains`) |
| KB 模块 | 完整:chunker/embedding/vectorstore/search,硬编码 `<project_path>/.llm-wiki/vectorstore.db` |
| Notes HTTP 路由 | **不存在**(全走 Tauri IPC) |
| 技能触发机制 | 只有 `always: true` 和 on-demand,**无 cron/on_chat_complete** |
| embedding 配置存储 | localStorage `mona-kb-embed-draft` |

---

## 二、本次 MVP 范围(本次执行)

### 2.1 必做(阶段 1 核心)

| # | 能力 | 文件 |
|---|------|------|
| 1 | frontmatter 新增 `type` 字段(note/moc/daily/template) | notes.rs + notes-data.ts |
| 2 | frontmatter 新增 `aliases` 字段(数组,双链别名匹配) | notes.rs + notes-data.ts |
| 3 | `[[xxx]]` 双链解析 + 扫描 + 缓存到 links.json | notes.rs 新增 links 模块 |
| 4 | 反向链接面板(已链接 + 未链接提及) | 新组件 BacklinksPanel.tsx |
| 5 | MOC 笔记类型(列表图标 + 导航) | NoteList.tsx + NotesView.tsx |
| 6 | 嵌套标签 `#a/b` 解析 + 树形显示 | notes-data.ts + NoteList.tsx |
| 7 | 重命名笔记时同步所有 `[[xxx]]` 引用 | notes.rs |
| 8 | Tiptap `[[xxx]]` 输入补全 + 点击跳转 + 悬浮预览 | NoteEditor.tsx + MarkdownEditor.tsx |

### 2.2 必做(阶段 4 基础)

| # | 能力 | 文件 |
|---|------|------|
| 9 | KB `search_wiki_hybrid` 新增 `markdown_dir`/`vectorstore_db` 可选参数 | mona/kb/search.py |
| 10 | KB `vectorstore` 新增 `db_path` 可选参数 | mona/kb/vectorstore.py |
| 11 | 新增 `mona/notes_kb/` 模块(indexer.py + search.py) | 新建 |
| 12 | 新增 notes HTTP 路由 `/api/notes-kb/*` | mona/api/server.py |
| 13 | `notes_search` Agent 工具智能降级 | mona/agent/tools/notes.py |
| 14 | 前端 KB 标记触发索引 + 相关笔记面板 | NotesView.tsx + 新组件 |

### 2.3 不做(留作后续阶段)

- ✗ Graph View(阶段 2)
- ✗ Dataview(阶段 2)
- ✗ 快速切换 Ctrl+O(阶段 2)
- ✗ Templater(阶段 3)
- ✗ Agent 主动整理 + diff 审核(阶段 5)
- ✗ Agent 记忆沉淀 + cron/on_chat_complete 触发器(阶段 6,需新建机制)
- ✗ `![[xxx]]` 嵌入引用(可后续)
- ✗ `[[xxx#^id]]` 块引用(可后续)

---

## 三、详细执行步骤

### 步骤 1:Rust 端 frontmatter 扩展

**文件**:`src-tauri/src/notes.rs`

**改动**:

1. `ParsedFrontmatter` 结构新增字段:
```rust
pub struct ParsedFrontmatter {
    // 已有字段...
    pub note_type: Option<String>,      // 新增:type (note/moc/daily/template)
    pub aliases: Option<Vec<String>>,   // 新增:别名数组
}
```

2. `parse_frontmatter_lines` 增加对 `type` 和 `aliases` 的解析:
- `type: moc` → note_type = Some("moc")
- `aliases: [a, b]` 或 block array → aliases = Some(vec)

3. `OperationNote` 新增字段:
```rust
pub struct OperationNote {
    // 已有字段...
    #[serde(rename = "type", default = "default_note_type")]
    pub note_type: String,           // 默认 "note"
    #[serde(rename = "aliases", default)]
    pub aliases: Vec<String>,
}
fn default_note_type() -> String { "note".to_string() }
```

4. `serialize_frontmatter` 新增输出 `type` 和 `aliases` 字段(只在非默认值时输出,保持向后兼容)

5. 加载笔记时,如果 frontmatter 没有 `type` 字段,默认填 `"note"`

### 步骤 2:Rust 端双链扫描模块

**新增文件**:`src-tauri/src/notes_links.rs`

**职责**:扫描 vault 所有 .md 文件,提取 `[[xxx]]` 链接,构建关系图,缓存到 `<vault>/.mona/links.json`

**核心结构**:
```rust
use std::collections::HashMap;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Default)]
pub struct LinksGraph {
    pub version: u32,
    pub nodes: HashMap<String, LinkNode>,        // note_id → node
    pub out_links: HashMap<String, Vec<LinkEdge>>, // note_id → 出链
    pub in_links: HashMap<String, Vec<String>>,    // note_id → 入链 note_ids
    pub title_to_id: HashMap<String, String>,      // title/alias → note_id
    pub last_scan_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LinkNode {
    pub title: String,
    pub path: String,
    pub aliases: Vec<String>,
    pub note_type: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LinkEdge {
    pub target_id: String,
    pub target_title: String,
    pub anchor: Option<String>,    // #标题 锚点
    pub is_embed: bool,             // ![[xxx]]
}
```

**核心函数**:
```rust
pub fn scan_vault_links(vault_path: &Path, notes: &[OperationNote]) -> LinksGraph
pub fn save_links_graph(vault_path: &Path, graph: &LinksGraph) -> Result<()>
pub fn load_links_graph(vault_path: &Path) -> Result<LinksGraph>
pub fn get_backlinks(graph: &LinksGraph, note_id: &str) -> Vec<LinkEdge>
pub fn get_unlinked_mentions(graph: &LinksGraph, note: &OperationNote, all_notes: &[OperationNote]) -> Vec<MentionResult>
pub fn rename_sync(vault_path: &Path, old_title: &str, new_title: &str, notes: &mut [OperationNote]) -> Result<usize>
```

**`[[xxx]]` 解析正则**:`\[\[([^\]|#]+)(?:\|([^\]]+))?(?:#([^\]]+))?\]\]`
- 捕获组 1:目标标题
- 捕获组 2:显示别名(可选)
- 捕获组 3:锚点(可选)

**`![[xxx]]` 解析**:在 `[[xxx]]` 基础上,前面有 `!`

**触发时机**:
- vault 加载时全量扫描(`notes_load_state` 末尾调用)
- 笔记保存时增量更新当前笔记的出链(`notes_save_state` 中调用)
- 笔记重命名时全量同步

### 步骤 3:Rust 端新增 Tauri 命令

**文件**:`src-tauri/src/notes.rs` + `src-tauri/src/lib.rs`

新增 5 个命令:

```rust
#[tauri::command]
pub async fn notes_links_get_graph(state: State<'_, NotesState>) -> Result<LinksGraph, String>

#[tauri::command]
pub async fn notes_links_get_backlinks(state: State<'_, NotesState>, note_id: String) -> Result<Vec<LinkEdge>, String>

#[tauri::command]
pub async fn notes_links_get_mentions(state: State<'_, NotesState>, note_id: String) -> Result<Vec<MentionResult>, String>

#[tauri::command]
pub async fn notes_links_rename_sync(state: State<'_, NotesState>, note_id: String, new_title: String) -> Result<RenameResult, String>

#[tauri::command]
pub async fn notes_moc_list(state: State<'_, NotesState>) -> Result<Vec<MocItem>, String>
```

在 `lib.rs` 的 `invoke_handler` 中注册这 5 个命令。

### 步骤 4:前端类型扩展

**文件**:`webui/src/components/notes/notes-data.ts`

```typescript
export type NoteType = "note" | "moc" | "daily" | "template";

export interface OperationNote {
  // 已有字段...
  type?: NoteType;          // 默认 "note"
  aliases?: string[];       // 默认 []
}

export interface LinkEdge {
  targetId: string;
  targetTitle: string;
  anchor?: string;
  isEmbed: boolean;
}

export interface BacklinkItem {
  sourceId: string;
  sourceTitle: string;
  sourcePath: string;
  snippet: string;
  line: number;
}

export interface MentionResult {
  noteId: string;
  title: string;
  snippet: string;
  matchedText: string;
}

export interface MocItem {
  id: string;
  title: string;
  path: string;
  linkCount: number;
}
```

**嵌套标签解析**:
```typescript
export function parseTagHierarchy(tags: string[]): TagNode[] {
  // 把 ["工作/项目A", "工作/项目B", "学习/Python"] 解析为树
}

export interface TagNode {
  name: string;
  fullPath: string;
  count: number;
  children: TagNode[];
}
```

### 步骤 5:前端 BacklinksPanel 组件

**新增文件**:`webui/src/components/notes/BacklinksPanel.tsx`

```typescript
interface BacklinksPanelProps {
  noteId: string;
  onJumpToNote: (noteId: string) => void;
}

export function BacklinksPanel({ noteId, onJumpToNote }: BacklinksPanelProps) {
  // 加载 backlinks + mentions
  // 分两区显示:
  //   反向链接 (N) - 列出引用此笔记的笔记 + snippet
  //   未链接提及 (M) - 列出提到此笔记标题但未加 [[ ]] 的位置
  // 点击项跳转到来源笔记
}
```

样式:右侧抽屉或底部面板,可折叠。参考 Obsidian 的反链面板布局。

### 步骤 6:前端 NoteEditor 双链集成

**文件**:`webui/src/components/notes/NoteEditor.tsx` + `webui/src/components/common/MarkdownEditor.tsx`

**改动**:

1. **`[[` 触发补全**:
   - 监听 Tiptap 编辑器输入
   - 检测到 `[[` 时弹出笔记标题搜索框(复用 GlobalSearchDialog 的模糊匹配逻辑)
   - 选中后插入 `[[笔记标题]]`
   - 支持别名匹配

2. **点击跳转**:
   - `[[xxx]]` 渲染为可点击链接
   - Ctrl/Cmd+Click 跳转到目标笔记
   - 目标不存在时提示创建

3. **悬浮预览**:
   - 鼠标悬停在 `[[xxx]]` 上 500ms
   - 显示目标笔记的首段预览(只读)
   - 不打开笔记

4. **MOC 图标**:
   - `NoteList.tsx` 中 `type === "moc"` 的笔记显示书签图标
   - 侧边栏导航区列出所有 MOC

### 步骤 7:前端嵌套标签

**文件**:`webui/src/components/notes/NoteList.tsx` + `notes-data.ts`

**改动**:
- 标签筛选区按 `parseTagHierarchy` 渲染树形结构
- 点击父标签时自动包含所有子标签
- 折叠/展开图标

### 步骤 8:Python 端 KB 重构

**文件**:`mona/kb/search.py` + `mona/kb/vectorstore.py`

**改动**:

1. `search_wiki_hybrid` 新增可选参数:
```python
async def search_wiki_hybrid(
    project_path: Path,
    query: str,
    embedding_config: EmbeddingConfig | None = None,
    count: int = 10,
    markdown_dir: Path | None = None,     # 新增:默认 = project_path / "wiki"
    vectorstore_db: Path | None = None,    # 新增:默认 = project_path / ".llm-wiki" / "vectorstore.db"
) -> dict[str, Any]:
    wiki_dir = markdown_dir or (project_path / "wiki")
    vs_db = vectorstore_db or (project_path / ".llm-wiki" / "vectorstore.db")
    # 后续逻辑用 wiki_dir 和 vs_db,不再用 project_path 拼路径
```

2. `vectorstore.py` 四个函数新增 `db_path` 参数:
```python
async def upsert_chunks(project_path: Path, page_id: str, chunks: list[dict], db_path: Path | None = None) -> None
async def search_chunks(project_path: Path, query_embedding: list[float], top_k: int = 30, db_path: Path | None = None) -> list[dict]
async def delete_page(project_path: Path, page_id: str, db_path: Path | None = None) -> None
async def count_chunks(project_path: Path, db_path: Path | None = None) -> int
```
默认值 `None` 时走原逻辑(`_db_path(project_path)`),保持向后兼容。

### 步骤 9:Python 端 notes_kb 模块

**新增文件**:
- `mona/notes_kb/__init__.py`
- `mona/notes_kb/indexer.py`
- `mona/notes_kb/search.py`

**`indexer.py`**:
```python
from pathlib import Path
from mona.kb.chunker import chunk_markdown, ChunkingOptions
from mona.kb.embedding import EmbeddingConfig, fetch_embedding
from mona.kb import vectorstore

def _db_path(vault_path: Path) -> Path:
    return vault_path / ".mona" / "vectorstore.db"

async def index_note(vault_path: Path, note_id: str, content: str, cfg: EmbeddingConfig) -> int:
    if not cfg.enabled:
        return 0
    chunks = chunk_markdown(content, ChunkingOptions())
    if not chunks:
        await vectorstore.delete_page(vault_path, note_id, db_path=_db_path(vault_path))
        return 0
    enriched = []
    for c in chunks:
        emb = await fetch_embedding(c.text, cfg)
        if emb:
            enriched.append({
                "chunk_index": c.index, "chunk_text": c.text,
                "heading_path": c.heading_path, "embedding": emb,
            })
    if enriched:
        await vectorstore.upsert_chunks(vault_path, note_id, enriched, db_path=_db_path(vault_path))
    return len(enriched)

async def unindex_note(vault_path: Path, note_id: str) -> None:
    await vectorstore.delete_page(vault_path, note_id, db_path=_db_path(vault_path))
```

**`search.py`**:
```python
from pathlib import Path
from mona.kb.search import search_wiki_hybrid
from mona.kb.embedding import EmbeddingConfig

async def search_notes_hybrid(vault_path: Path, query: str, cfg: EmbeddingConfig, count: int = 10):
    return await search_wiki_hybrid(
        project_path=vault_path,
        query=query,
        embedding_config=cfg,
        count=count,
        markdown_dir=vault_path,            # 直接扫 vault 根目录的 .md
        vectorstore_db=vault_path / ".mona" / "vectorstore.db",
    )
```

### 步骤 10:HTTP 路由注册

**文件**:`mona/api/server.py`

新增路由(gateway HTTP server,前端走 `getGatewayHttpBase()`):

```python
# 双链
app.router.add_get("/api/notes-links/graph", handle_notes_links_graph)
app.router.add_get("/api/notes-links/backlinks/{note_id}", handle_notes_links_backlinks)
app.router.add_get("/api/notes-links/mentions/{note_id}", handle_notes_links_mentions)
app.router.add_post("/api/notes-links/rename-sync", handle_notes_links_rename_sync)
app.router.add_get("/api/notes-moc/list", handle_notes_moc_list)

# 向量索引
app.router.add_post("/api/notes-kb/reindex-notebook", handle_notes_kb_reindex_notebook)
app.router.add_post("/api/notes-kb/reindex-note", handle_notes_kb_reindex_note)
app.router.add_post("/api/notes-kb/unindex-note", handle_notes_kb_unindex_note)
app.router.add_post("/api/notes-kb/search", handle_notes_kb_search)
app.router.add_get("/api/notes-kb/related/{note_id}", handle_notes_kb_related)
```

handler 实现放在 `mona/api/notes_kb_handlers.py`(新文件)或直接在 server.py 内部函数。

**handler 逻辑**:
- 从请求体读 `vault_path`(前端传)或从某个 state 取
- 从请求体读 `embedding_config`(前端透传 `embedDraft`)
- 调用 `mona.notes_kb.indexer` / `search` 模块

### 步骤 11:Agent 工具升级

**文件**:`mona/agent/tools/notes.py`

`NotesSearchTool.execute` 改造:

```python
async def execute(self, query: str, limit: int = 5, **kwargs) -> str:
    # 1. 尝试混合检索(若 embedding 已配置)
    cfg = await self._get_embedding_config(ctx)  # 新增辅助方法
    if cfg and cfg.enabled:
        try:
            vault_path = await self._get_vault_path(ctx)
            results = await search_notes_hybrid(vault_path, query, cfg, count=limit)
            if results["results"]:
                return self._format_hybrid_results(results)
        except Exception:
            pass  # 降级
    # 2. 降级:原 Tauri 子串匹配
    return await tauri_invoke("notes_search_all", {"query": query, "limit": limit})
```

新增只读工具 `notes_get_backlinks`、`notes_find_related`(可选,本次 MVP 可不做)。

### 步骤 12:前端相关笔记面板 + KB 标记触发

**文件**:`webui/src/components/notes/NotesView.tsx` + 新组件 `RelatedNotesPanel.tsx`

**改动**:

1. **KB 标记触发索引**:
   - `toggleNotebookKnowledgeBase` 启用时,若 `embedDraft.enabled`,调用 `/api/notes-kb/reindex-notebook`
   - 禁用时调用 `/api/notes-kb/unindex-notebook`

2. **笔记保存触发增量**:
   - `saveNote` 完成后,若所属 notebook 标记为 KB 且 embedding 已配置,异步调用 `/api/notes-kb/reindex-note`

3. **RelatedNotesPanel 组件**:
   - 笔记打开时调用 `/api/notes-kb/related/{note_id}`
   - 右侧显示 top 5 相似笔记

---

## 四、验证清单

### 4.1 后端验证

```bash
# Python lint
python -m ruff check mona/notes_kb/ mona/kb/ mona/api/server.py mona/agent/tools/notes.py

# Rust build
cd src-tauri && cargo check
```

### 4.2 前端验证

```bash
cd webui && npx tsc --noEmit
```

### 4.3 功能验证

- [ ] 新建笔记,frontmatter 默认 `type: note`
- [ ] 手动改 `type: moc`,笔记列表显示 MOC 图标
- [ ] 在笔记 A 写 `[[笔记 B]]`,B 的反链面板显示 A
- [ ] 重命名 B,A 中的 `[[B]]` 自动更新
- [ ] 嵌套标签 `#工作/项目A` 在标签树正确分层
- [ ] 编辑器输入 `[[` 弹出补全
- [ ] 点击 `[[xxx]]` 跳转
- [ ] 笔记本标记 KB 后,触发向量索引构建
- [ ] 笔记保存后,增量更新向量
- [ ] 聊天选 `notebook:xxx` 提问,Agent 走混合检索

---

## 五、风险与对策

| 风险 | 对策 |
|------|------|
| notes.rs 继续膨胀 | 双链扫描拆到 `notes_links.rs` 独立文件 |
| 现有笔记无 type 字段 | 加载时默认填 "note",写回时只在非默认时输出 |
| 嵌套标签破坏旧数据 | 兼容扁平标签,只是显示时按 `/` 分层 |
| 向量索引失败 | 失败时 toast 提示但笔记正常保存 |
| embedding 未配置 | 隐藏相关笔记面板,KB 标记仍生效(只是退回子串) |
| Tiptap `[[` 补全冲突 | 用 Tiptap 的 suggestion 插件机制,不干扰其他输入 |
| 重命名同步漏改 | 全量扫描前先备份 links.json,失败可回滚 |

---

## 六、本次执行边界

**本次会执行**:
- 步骤 1-7(阶段 1 完整):双链 + MOC + 反链 + 嵌套标签 + Frontmatter
- 步骤 8-12(阶段 4 基础):向量索引 + Vault QA 智能降级

**本次不执行**(留作后续):
- Graph View(需要 d3/cytoscape 依赖,工作量大)
- Dataview(需要查询引擎,工作量大)
- 快速切换 Ctrl+O(独立功能,可后做)
- Templater(独立功能,可后做)
- Agent 主动整理 + diff 审核(阶段 5,工作量大)
- Agent 记忆沉淀 + 触发器机制(阶段 6,需要新建基础设施)

---

## 七、执行顺序

1. 后端 Rust:frontmatter 扩展 → 双链扫描模块 → Tauri 命令 → cargo check
2. 后端 Python:KB 重构 → notes_kb 模块 → HTTP 路由 → ruff check
3. 前端:类型扩展 → BacklinksPanel → NoteEditor 双链 → 嵌套标签 → KB 触发 → tsc
4. 验证:全量 lint + 手动测试
