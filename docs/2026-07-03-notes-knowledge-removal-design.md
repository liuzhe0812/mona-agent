# 笔记模块"知识"功能删除与 Obsidian 范式对齐 — 设计方案

> 日期：2026-07-03
> 范围：Mona 桌面端笔记模块（`webui/src/components/notes/` + `src-tauri/src/notes.rs`）
> 不在范围：独立的"知识库 RAG"功能（`webui/src/components/knowledge/` 与 `lib/kb-api.ts` 等）

---

## 一、背景与动机

### 1.1 当前"知识"功能的本质问题

经过完整代码盘点，Mona 笔记模块内置的"知识"功能存在三个核心缺陷：

1. **概念冗余**：在 `.md` 笔记之外又造了一层 `KnowledgeItem`（SQLite 存储），但 `content` 字段被强制等于 `summary`（[KnowledgeView.tsx#L402](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/notes/KnowledgeView.tsx)），实际只是"带分类的笔记摘要副本"，信息密度未增加，反而引入同步成本。

2. **AI 链路断裂**：知识项被设计成"AI 提取的产物"，但 AI 对话时检索的却是**笔记本体**而非知识项（[NoteAgentPanel.tsx#L290-L304](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/notes/NoteAgentPanel.tsx)）。知识项在 AI 闭环里是个"死端点"——只写不读。

3. **检索能力不足**：纯 `String::contains` 子串匹配 + `rank: 0.0`，无向量/BM25/分词，撑不起"知识库"语义。

4. **存储割裂**：笔记在 vault 的 `.md` 文件，知识项在 SQLite，破坏单一数据源原则。

5. **链接单向**：知识项 → 笔记有 `sourceNoteId`+`linkedNotes[]`，笔记侧无反向引用。

### 1.2 Obsidian 的成熟范式

Obsidian 没有从笔记中"提取知识卡片"这种二级概念，它的哲学是**笔记本身就是知识原子**，通过四种原语组织：

| Obsidian 机制 | 作用 |
|---|---|
| `[[双向链接]]` | 笔记间互引，天然双向 |
| 标签（扁平 / 嵌套 `#a/b`） | 笔记的多维分类 |
| Properties (YAML frontmatter) | 结构化元数据，可被查询 |
| Bases (1.9+) / Dataview 插件 | 对笔记本身做结构化视图查询 |
| 文件夹 + 链接解耦 | 物理组织与逻辑组织分离 |

### 1.3 设计目标

删除笔记内置的"知识"二级实体，把"知识组织"能力回归到笔记本身：
- 笔记的 `tags`、`contextLevel`、`knowledgeBaseEnabled` 这些 Obsidian 范式原语**全部保留并强化**
- 删除 `KnowledgeCategory` / `KnowledgeItem` / `KnowledgeLinkedNote` 数据模型与所有 UI
- 删除"提取知识点"AI 动作（`extractKnowledge`）
- 删除笔记视图顶部"笔记 / 知识"切换 Tab
- 保留并重命名 `formatKnowledgeBaseContext` → `formatNotebookBaseContext`，让 AI 上下文注入能力继续工作
- 删除 SQLite 中两张知识表，vault.json 中 `activeKnowledgeCategoryId` 字段

---

## 二、设计原则

1. **删除优先于重写**：不做"把知识项迁移成笔记"这种二次搬运——用户原始笔记已经在 vault 里，知识项是冗余副本，直接删除。
2. **保留 Obsidian 原语**：`tags`、`contextLevel`、`knowledgeBaseEnabled`、笔记检索、AI 上下文注入全部保留。
3. **不破坏独立 KB RAG**：`webui/src/components/knowledge/` 与 `kb-api.ts` 等是独立功能，本次完全不动。
4. **数据兼容**：vault.json 旧字段用 `#[serde(default)]` 平滑忽略；旧 SQLite 表保留 drop 脚本但不强制执行。
5. **一次提交完成**：所有改动作为一个原子提交，避免半删状态导致编译断裂。

---

## 三、删除范围（清单 A + B）

### 3.1 清单 A：完全删除的文件

| 文件 | 说明 |
|---|---|
| [webui/src/components/notes/KnowledgeView.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/notes/KnowledgeView.tsx) | 知识视图整体 UI（779 行） |
| [webui/src/providers/KnowledgeDialogProvider.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/providers/KnowledgeDialogProvider.tsx) | 候选知识点全局确认弹窗 |

### 3.2 清单 B：需修改的文件

#### B1. [webui/src/App.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/App.tsx)
- 删除：`KnowledgeDialogProvider` 的 import 与 `<KnowledgeDialogProvider>` 包裹（L38, L413, L430）
- 保留：`KnowledgeBaseView` 相关（独立 KB RAG 功能）

#### B2. [webui/src/components/notes/NotesView.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/notes/NotesView.tsx)
最大改动文件。删除项按类别：

**导入清理**：L37（KnowledgeView）、L42（ExtractedKnowledgeDraft）、L44-46（KnowledgeCategory/Item/LinkedNote）、L57-58（createKnowledgeCategory/ItemId）

**State 清理**：L77-78（knowledgeCategories/items）、L82-84（activeKnowledgeCategoryId/ItemId/ReturnItemId）、L85（viewMode）、L106-107 与 L112-113（PromptState/ConfirmState 中的 knowledge 变体）

**派生值 / effects**：L179-196（knowledgeReturnItem/knowledgeTags/shouldShowKnowledgeReturn）、L210-211/L215（load effect 内 set 知识 state）、L240-246/L267/L270-271（save effect 中 state 字段与依赖）、L513-514/L518（openOrCreateVault 内 set 知识 state）

**Handlers 删除**：L641-721（saveKnowledgeFromAgent）、L723-786（createKnowledgeCategoryManually/handleCreateKnowledgeCategory/renameKnowledgeCategory/handleRenameKnowledgeCategory）、L788-829（deleteKnowledgeCategory/handleDeleteKnowledgeCategory）、L831-867（moveKnowledgeItem/updateKnowledgeItem）、L869-890（deleteKnowledgeItem/handleDeleteKnowledgeItem）、L892-906（openSourceNote 中 setKnowledgeReturnItemId/setViewMode）、L908-914（returnToKnowledgeItem）

**Prompt/Confirm 配置**：L998-1004、L1017-1020、L1029-1030、L1039-1040、L1058-1066、L1078-1095、L1104-1105 中所有 knowledge 分支

**UI 片段**：L1115-1122（"笔记/知识" ModeButton 切换组）、L1198-1212（viewMode === "knowledge" 分支）、L1322-1327（NoteEditor 的 knowledgeReturnTitle/onReturnToKnowledge props）、L1358-1359（NoteAgentPanel 的 knowledgeCategories/knowledgeTags props）、L1365（onSaveKnowledge prop）

**辅助函数**：L1397-1418（ModeButton 组件）、L1626-1655（ensureKnowledgeCategoryPath）、L1657-1669（normalizeKnowledgeCategoryPath）、L1671-1684（hasSiblingCategoryName）、L1686-1696（createKnowledgeLinkedNote）、L1698-1721（getKnowledgeLinkedNotes）、L1723-1733（mergeKnowledgeLinkedNotes）、L1735-1745（mergeTags/normalizeKnowledgeTags/normalizeKnowledgeTitle）、L1747-1750（isKnowledgeItemLinkedToNote）、L1755-1761（serializeNotesState 类型签名中 knowledge 字段）

**保留**：
- L1287-1294（onSetContextLevel）
- L1299、L444-456、L1508/L1535/L1582-1585（onToggleKnowledgeBase / toggleNotebookKnowledgeBase 透传链路）
- L336-343（useKbStore 同步 notebookKbList）
- L1607（NoteList 的 knowledgeBaseEnabled 透传）

#### B3. [webui/src/components/notes/NoteAgentPanel.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/notes/NoteAgentPanel.tsx)
**删除**：
- 导入：L33（useKnowledgeDialog）、L49（createKnowledgeDraftFromCandidate）、L51（parseExtractedKnowledgeCandidates）、L53（ExtractedKnowledgeDraft）、L57（KnowledgeCategory）
- Props：L67-68（knowledgeCategories/knowledgeTags）、L74（onSaveKnowledge）、L84-85/L91（解构）
- Refs/hooks：L104（pendingKnowledgeStartIndexRef）、L109（processedSaveIdsRef）、L110-111（onSaveKnowledgeRef）、L114-121（useKnowledgeDialog）、L147-155（registerSaveHandler effect）、L157-173（已保存候选 effect）、L181/L188（clearKnowledgeCandidates 调用）、L222-251（候选解析 effect）
- runAction 内：L335-338（extractKnowledge 分支）、L351（buildAgentActionPrompt 的 knowledgeCategories/knowledgeTags 参数）、L355-357（失败回滚）、L361（依赖数组）
- UI：L547-551（KnowledgeCandidateDock 渲染）、L630-658（Dock 组件定义）、L763-774（isKnowledgeResult 分支）、L837-845（"提取知识点"按钮）、L1172-1178（isKnowledgeResult 判断）、L1278-1287（isKnowledgeJsonCandidate 辅助函数）

**保留**：L290-304（sendPromptToAgent 中的 knowledgeBaseEnabled 检查与 searchNotebookNotes + formatKnowledgeBaseContext 注入）、L295（formatKnowledgeBaseContext 动态 import）

#### B4. [webui/src/components/notes/notes-ai.ts](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/notes/notes-ai.ts)
**删除**：
- L1（KnowledgeCategory import）
- L3-18（ExtractedKnowledgeDraft / ExtractedKnowledgeCandidateDraft 接口）
- L31-34（NOTE_AI_ACTIONS 中 extractKnowledge 项）
- L61-62（buildAgentActionPrompt 的 knowledgeCategories/existingTags 参数）
- L77-132（extractKnowledge 分支）
- L387（ACTION_PROMPT_PATTERNS 中"提取知识点"模式）
- L428-461（parseExtractedKnowledgeCandidates / createKnowledgeDraftFromCandidate）
- L476-497（readKnowledgeCandidate）
- L499-508（extractJsonObject）
- L510-538（readRequiredString / readStringArray）
- L540-542（isRecord）
- L559-576（formatKnowledgeCategoryContext）
- L578-595（formatExistingTagContext）
- L597-616（formatKnowledgeCategoryPaths）

**保留并重命名**：
- L618-623（NoteSearchResult 接口）
- L625-639（formatKnowledgeBaseContext → **重命名为 formatNotebookBaseContext**）

#### B5. [webui/src/components/notes/notes-data.ts](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/notes/notes-data.ts)
**删除**：
- L4（NoteAiActionId 中的 "extractKnowledge"）
- L95-99（KnowledgeCategory 接口）
- L101-106（KnowledgeLinkedNote 接口）
- L108-120（KnowledgeItem 接口）

**保留**：L7-15（NoteContextLevel/LEVELS/LABELS）、L72（Notebook.knowledgeBaseEnabled）、L91-92（OperationNote.contextLevel）、L25-41（NoteTransformation）

#### B6. [webui/src/components/notes/notes-storage.ts](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/notes/notes-storage.ts)
**删除**：L8-9（KnowledgeCategory/Item import）、L20-21（NotesStorageState 中 knowledgeCategories/items）、L24（activeKnowledgeCategoryId）、L66-68（createKnowledgeItemId）、L70-76（createKnowledgeCategory）

**保留**：其余全部，特别是 `createBlankNote` 中 `contextLevel: "full"`（L58）与 `createCustomNotebook` 中 `knowledgeBaseEnabled: false`（L82）

#### B7. [webui/src/components/notes/NoteEditor.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/notes/NoteEditor.tsx)
**删除**：L13-14（knowledgeReturnTitle/onReturnToKnowledge props）、L27-28（解构）、L53-58（条件渲染）、L67-87（KnowledgeReturnBanner 组件）

#### B8. [src-tauri/src/notes.rs](file:///d:/liuzhe/Desktop/code/Mona/src-tauri/src/notes.rs)
**删除（struct）**：L21-22/L23-24/L27-28（NotesState 中 knowledge_* 字段）、L98-105（KnowledgeCategory）、L107-122（KnowledgeItem）、L124-131（KnowledgeLinkedNote）、L147（VaultMeta.active_knowledge_category_id）

**删除（DB/schema）**：L180-221（initialize_schema）、L223-249（ensure_column）、L251-268（seed_default_knowledge_categories）

**删除（load/save）**：L1204-1206（load_knowledge_categories/items 调用）、L1241-1254（active_knowledge_category_id 计算）、L1259-1260/L1263（NotesState 返回字段）、L1272-1273（save_knowledge_to_db 调用）、L1380（VaultMeta 构造中字段）、L1391-1446（save_knowledge_to_db）、L1448-1468（load_knowledge_categories）、L1470-1537（load_knowledge_items）、L1539-1541（parse_json_field）

**删除（validate_state）**：L1579-1623（category_ids 校验、循环检测）、L1625-1651（knowledge_item_ids 校验、linked_notes 校验）

**删除（migration 残留）**：L435-436（migrate 中读 activeKnowledgeCategoryId）、L579（迁移写入 VaultMeta 的 active_knowledge_category_id）

**保留**：
- L51-59（Notebook.knowledge_base_enabled）
- L82-90（OperationNote.context_level + default_context_level）
- L152-157（VaultNotebookMeta.knowledge_base_enabled）
- L1716-1827（NoteSearchResult / search_notes_in_memory / apply_context_levels_mem / notes_search / notes_search_all）
- L1038-1083（parse_note_file 中 context_level 解析）
- L873-913（serialize_frontmatter 中 contextLevel 输出）
- L765/L812（frontmatter 解析中 contextLevel 字段）
- L163-178（open_notes_db 仍保留——迁移时还要读旧 DB；但 initialize_schema / seed_default 调用要移除）

#### B9. [src-tauri/src/lib.rs](file:///d:/liuzhe/Desktop/code/Mona/src-tauri/src/lib.rs)
**无需修改**：L413-424 的 invoke_handler 中无 `knowledge_*` 专属命令

#### B10. [webui/src/lib/tauri.ts](file:///d:/liuzhe/Desktop/code/Mona/webui/src/lib/tauri.ts)
**无需修改**：所有 `notes_*` 命令均为通用命令

#### B11. [webui/src/components/notes/NoteList.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/notes/NoteList.tsx)
**无需修改**：仅有 `knowledgeBaseEnabled` 引用（L54/L83/L207/L335/L348/L412），属于保留项

#### B12. [webui/src/components/notes/NotebookSelect.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/notes/NotebookSelect.tsx)
**无需修改**：仅有 `onToggleKnowledgeBase` / `knowledgeBaseEnabled` 引用，属于保留项

### 3.3 清单 B 补充：ThreadShell 调用点

[webui/src/components/thread/ThreadShell.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/thread/ThreadShell.tsx) L436-438 动态 import `formatKnowledgeBaseContext`，重命名后需同步改为 `formatNotebookBaseContext`。

---

## 四、保留范围（清单 C）

| 保留项 | 当前位置 | 删除后状态 |
|---|---|---|
| `NoteContextLevel` 类型与常量 | notes-data.ts L7-15 | 独立工作，对齐 Obsidian "笔记本身是否参与检索" |
| `OperationNote.contextLevel` 字段 | notes-data.ts L91-92 / notes.rs L82-90 | 独立工作 |
| `Notebook.knowledgeBaseEnabled` | notes-data.ts L72 / notes.rs L58 | 独立工作，对齐"笔记本是否作为知识库" |
| `searchNotebookNotes` / `notes_search` / `notes_search_all` | tauri.ts L213-226 / notes.rs L1716-1827 | 独立工作，仅读 vault .md 文件 |
| `formatKnowledgeBaseContext`（重命名后） | notes-ai.ts L625-639 | 独立工作，仅消费 `NoteSearchResult[]` |
| `apply_context_levels_mem` | notes.rs L1766-1790 | 独立工作，按笔记 contextLevel 过滤 |
| 笔记 `tags` 字段与编辑 UI | notes-data.ts L85 / NoteList.tsx L386-389/L451-569 | 独立工作，对齐 Obsidian frontmatter + tags |
| `useKbStore` 同步 `notebookKbList` | NotesView.tsx L336-343 | 独立工作（KB RAG 共用） |
| `ThreadShell.injectKbContext` | ThreadShell.tsx L429-453 | 独立工作，注入笔记检索结果到 chat |

---

## 五、重命名建议

为避免概念混淆（"知识"二字已删，但函数名仍含 Knowledge），统一重命名：

| 旧名 | 新名 | 影响范围 |
|---|---|---|
| `formatKnowledgeBaseContext` | `formatNotebookBaseContext` | notes-ai.ts 定义；NoteAgentPanel.tsx L295、ThreadShell.tsx L436 动态 import |

`knowledgeBaseEnabled` / `KnowledgeBase` 类命名**保留**——这是"笔记本作为知识库"的开关，与 Obsidian 范式一致，不属于本次删除的"知识项"概念。

---

## 六、数据库与持久化处理

### 6.1 SQLite 表处理

**策略：保留 `notes.sqlite3` 文件，删除 schema 初始化代码，提供一次性 drop 脚本。**

理由：
- `migrate_legacy_sqlite_to_vault` 仍需 `Connection::open` 旧 DB 读取残留的 `notes/notebooks/app_state` 表（虽然这些表在迁移后会被 drop，但迁移流程本身需要读连接）
- 不强制 drop `knowledge_categories` / `knowledge_items` 表，避免对老用户数据造成不可逆破坏
- 但 `initialize_schema` 中的 `CREATE TABLE IF NOT EXISTS knowledge_*` 必须删除，否则下次启动又把表建回来了

**实施**：
1. `notes.rs` 中删除 `initialize_schema` / `seed_default_knowledge_categories` / `ensure_column` 三个函数
2. `open_notes_db` 改为仅 `Connection::open` + `pragma_update`，不再调用 schema 初始化
3. 提供 SQL 脚本 `docs/sql/2026-07-03-drop-knowledge-tables.sql`（可选执行）：
   ```sql
   DROP TABLE IF EXISTS knowledge_items;
   DROP TABLE IF EXISTS knowledge_categories;
   ```
4. 由于 `open_notes_db` 不再被 `notes_load_state` / `notes_save_state` 调用（删除了 knowledge 读写后已无 SQLite 读写需求），可考虑彻底删除该函数。但 `migrate_legacy_sqlite_to_vault` 仍需直接 `Connection::open`，所以保留 `notes_db_path` 辅助函数。

### 6.2 vault.json 兼容

`VaultMeta.active_knowledge_category_id` 字段删除。旧 vault.json 中可能残留该字段，由于 `#[serde(default)]` 已覆盖，反序列化时会被忽略，无需迁移。

### 6.3 .md frontmatter 兼容

笔记的 frontmatter 字段（`title/createdAt/updatedAt/source/tags/contextLevel/agentChatId/appliedAgentMessageIds`）**完全不变**。已写入的笔记文件无需任何改动。

### 6.4 NotesState JSON 兼容

`notes_save_state` 写入 vault.json 的 `NotesState` 序列化中删除 `knowledgeCategories` / `knowledgeItems` / `activeKnowledgeCategoryId` 字段。旧 vault.json 中这些字段会被 `serde(default)` 忽略；前端 `loadNotesState` 反序列化时也无影响。

---

## 七、实施步骤

按以下顺序提交，每一步保证可编译：

### 步骤 1：前端类型与存储层（无 UI 影响）
1. 修改 `notes-data.ts`：删除 Knowledge* 接口、NoteAiActionId 中 "extractKnowledge"
2. 修改 `notes-storage.ts`：删除 knowledge 字段与 ID 生成函数
3. 修改 `notes-ai.ts`：删除 extract* 函数、重命名 formatKnowledgeBaseContext → formatNotebookBaseContext

### 步骤 2：前端 UI 层
4. 删除 `KnowledgeView.tsx`、`KnowledgeDialogProvider.tsx`
5. 修改 `App.tsx`：移除 KnowledgeDialogProvider 包裹
6. 修改 `NotesView.tsx`：删除所有 knowledge state/handlers/UI/辅助函数、删除 viewMode/ModeButton
7. 修改 `NoteAgentPanel.tsx`：删除 extractKnowledge 路径、KnowledgeCandidateDock、useKnowledgeDialog
8. 修改 `NoteEditor.tsx`：删除 KnowledgeReturnBanner
9. 修改 `ThreadShell.tsx`：动态 import 改为 `formatNotebookBaseContext`

### 步骤 3：Rust 后端
10. 修改 `notes.rs`：删除 Knowledge* struct、knowledge schema、load/save/validate 中 knowledge 逻辑
11. 保留 `open_notes_db` 但移除 `initialize_schema` / `seed_default_knowledge_categories` 调用
12. 删除 `save_knowledge_to_db` / `load_knowledge_categories` / `load_knowledge_items` / `parse_json_field`

### 步骤 4：验证
13. `cargo check --manifest-path src-tauri/Cargo.toml`
14. `cd webui && npx tsc -p tsconfig.build.json --noEmit`
15. 手动验证：打开笔记视图（无"知识" Tab）、新建笔记、编辑标签、切换笔记本知识库开关、AI 对话（注入笔记上下文）

### 步骤 5：可选清理
16. 创建 `docs/sql/2026-07-03-drop-knowledge-tables.sql` 供老用户手动执行
17. 检查 i18n `nav.knowledge` 字段（[zh-CN/common.json#L88](file:///d:/liuzhe/Desktop/code/Mona/webui/src/i18n/locales/zh-CN/common.json) 与 en 同位置）是否仍被消费，若无则删除

---

## 八、验证清单

### 8.1 编译验证
- [ ] `cargo check` 通过（仅允许无关 dead code 警告）
- [ ] `tsc --noEmit` 通过
- [ ] `npm run tauri dev` 启动无错误

### 8.2 功能验证
- [ ] 笔记视图顶部无"笔记/知识"切换 Tab，只剩笔记视图
- [ ] NoteAgentPanel 无"提取知识点"按钮
- [ ] 笔记右键仍有"知识库上下文"子菜单（full/summary/none）
- [ ] 笔记本右键仍有"建为知识库"开关
- [ ] 笔记本开启知识库后，AI 对话能注入笔记检索结果
- [ ] 标签编辑对话框正常工作
- [ ] 创建/重命名/删除笔记本正常
- [ ] 创建/编辑/删除笔记正常
- [ ] 旧 vault.json 加载无报错（activeKnowledgeCategoryId 字段被忽略）
- [ ] 旧 .md 笔记加载无报错

### 8.3 回归验证
- [ ] 独立 KB RAG 功能（侧边栏"知识库"入口）不受影响
- [ ] ThreadShell chat 中选择 `notebook:xxx` 后注入笔记上下文正常
- [ ] 笔记 AI 模板（transformations）功能正常
- [ ] 笔记搜索（GlobalSearchDialog）正常

---

## 九、风险与回滚

### 9.1 风险

| 风险 | 概率 | 缓解 |
|---|---|---|
| 用户已积累的知识项数据丢失 | 中 | 知识项是笔记的衍生品，原始笔记仍在 vault；提供 SQL 脚本可查看旧数据 |
| 删除过程中遗漏调用点导致编译断裂 | 低 | 按步骤分阶段提交，每步 `tsc`/`cargo check` 验证 |
| `formatKnowledgeBaseContext` 重命名漏改调用点 | 低 | 编译会立即报错；调用点仅 2 处 |
| `useKbStore` 同步逻辑被误删 | 低 | 步骤 2 中明确保留 L336-343 |
| 独立 KB RAG 功能被误伤 | 低 | 清单 B 中已明确标注 KB RAG 文件不在范围 |

### 9.2 回滚方案

若发现问题需回滚：
1. `git revert` 该提交即可完整回滚（删除的文件由 git 恢复）
2. vault.json 中被忽略的 `activeKnowledgeCategoryId` 字段在回滚后自动恢复生效
3. SQLite 表若已手动 drop，需从备份恢复或重新执行 `initialize_schema` 重建空表

---

## 十、不在本次范围

明确**不做**的事：
1. 不实现 `[[双向链接]]`（Obsidian 链接语法）——这是另一个独立大功能，需要 markdown 解析器改造与图谱视图，不在本次范围
2. 不实现 Bases / Dataview 类结构化查询——同上
3. 不引入向量检索——`notes_search` 仍保持子串匹配，未来可独立立项
4. 不重做笔记 tags 为嵌套标签（`#a/b`）——保持扁平 tags 数组
5. 不动独立 KB RAG 功能（`webui/src/components/knowledge/` 与 `lib/kb-api.ts` 等）

本次目标是**做减法**：删除冗余的"知识项"二级实体，让笔记本身成为知识原子，对齐 Obsidian 的核心范式。后续若要引入双向链接、图谱、向量检索，可作为独立增量功能立项。
