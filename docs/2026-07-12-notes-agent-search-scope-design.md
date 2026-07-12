# 笔记/邮件 Agent 搜索范围改造方案

> 日期：2026-07-12
> 状态：待实施
> 范围：Mona 笔记、邮件、主聊天、设置页

## 1. 背景与动机

### 1.1 当前"建为知识库"开关的问题

Mona 笔记模块当前存在一个 `knowledgeBaseEnabled` 开关，挂在每个笔记本上。该开关存在以下问题：

- **语义模糊**：名为"建为知识库"，实际既未创建向量索引，也未改变检索行为，只控制是否出现在主聊天 KB 选择器里。
- **核心链路断裂**：开关值仅写入 `vault.json` 和 React state，`notes_search_all` 和 `search_notes_in_memory` 完全未读取该字段。
- **死代码堆积**：为支持该开关引入的 Python 向量后端（`mona/notes_kb/`）、`notes-kb-api.ts` 部分函数、`RelatedNotesPanel` 组件、`/api/notes-kb/*` 路由均为死代码。
- **安全风险**：`embedding.json` 把 API Key 写入 Vault，可能被同步到 Git/网盘。
- **自包含违规**：Python 向量后端需要 Python 运行时，违反"Mona Desktop 必须完全自包含"红线。

### 1.2 与 Obsidian 社区主流做法的偏差

调研 Obsidian 三条主流路径（MCP Server、Copilot、Smart Connections）后发现：

- **没有任何主流方案提供"建为知识库"开关**。默认全部可检索，用户通过 `contextLevel` 等单篇权限控制隐私。
- Smart Connections 强调"install, enable, and AI-powered connections just work"——零配置默认开放。
- MCP Server 路径把 vault 当文件系统暴露给 Agent，不做范围过滤。

Mona 当前的开关设计源于"知识库"这个错误隐喻，把"是否允许 Agent 检索"包装成了"是否创建新知识库"。

### 1.3 邮件侧已验证"默认开放"可行

邮件模块的 `search_emails` 工具默认全部邮件可搜索，用户通过 `folder` 参数主动限定范围。该设计从未被用户投诉"应该有开关"，证明"默认开放 + 按需收紧"的模型可行。

## 2. 改造目标

1. **删除"建为知识库"概念**——移除开关、死代码、Python 向量后端、相关 UI 和路由。
2. **默认开放**——笔记和邮件默认全部可被 Agent 检索。
3. **设置页统一管理搜索范围**——新增"Agent 搜索范围"配置页，允许用户按文件夹/笔记本级别排除。
4. **恢复主聊天 KB 选择器**——选择器只显示 LLM Wiki 知识库项目，不再显示笔记笔记本。

## 3. 改造范围

### 3.1 删除清单（减法）

#### 3.1.1 Rust 侧（`src-tauri/src/notes.rs`）

- `Notebook` 结构体的 `knowledge_base_enabled: bool` 字段（第 50 行）
- `VaultNotebookMeta` 结构体的 `knowledge_base_enabled: bool` 字段（第 123-125 行）
- `scan_vault()` 中读取 `knowledge_base_enabled` 的逻辑（第 1036-1040 行）
- `save_vault_state()` 中持久化 `knowledge_base_enabled` 的逻辑（第 1326 行附近）

#### 3.1.2 Python 侧（`mona/`）

- 整个 `mona/notes_kb/` 目录（`indexer.py`、`search.py`、`__init__.py` 等）
- `mona/api/server.py` 中注册的 `/api/notes-kb/embed`、`/api/notes-kb/embed/status`、`/api/notes-kb/search`、`/api/notes-kb/related/{note_id}` 四个路由
- `mona/agent/tools/notes.py` 中 `NotesSearchTool.execute()` 的混合检索分支（第 203-214 行），只保留 Rust 子串搜索回退路径
- Vault 内 `.mona/embedding.json` 配置文件（含 API Key，安全风险）

#### 3.1.3 前端侧（`webui/src/`）

- `webui/src/lib/notes-kb-api.ts` 中的 `indexVault()` 和 `searchNotes()` 函数（死代码）
- `webui/src/components/notes/RelatedNotesPanel.tsx`（一直返回 null）
- `NotesView.tsx` 中的 `toggleNotebookKnowledgeBase` 回调
- `NoteList.tsx` / `NoteRow` / `NotebookSelect.tsx` 中"建为知识库"右键菜单项和相关 UI
- `notes-data.ts` 中 `Notebook` 类型的 `knowledgeBaseEnabled` 字段
- `kb-store.ts` 中 `notebookKbList` 相关逻辑（主聊天 KB 选择器不再显示笔记笔记本）

#### 3.1.4 主聊天 KB 选择器修复

当前 `ThreadShell.tsx` 第 138-143 行将 `kbProjectsRaw`（LLM Wiki）和 `notebookKbList`（笔记笔记本）合并显示。改造后只保留 LLM Wiki：

```typescript
// 改造前
const kbProjects = useMemo(
  () => [
    ...kbProjectsRaw.map((p) => ({ id: p.id, name: p.name, isNotebook: false })),
    ...notebookKbList.map((n) => ({ id: `notebook:${n.id}`, name: n.name, isNotebook: true })),
  ],
  [kbProjectsRaw, notebookKbList],
);

// 改造后
const kbProjects = useMemo(
  () => kbProjectsRaw.map((p) => ({ id: p.id, name: p.name })),
  [kbProjectsRaw],
);
```

同时移除 `ThreadShell.tsx` 第 418-441 行 `injectKbContext` 中 `notebook:` 前缀的分支（第 422-428 行），只保留 LLM Wiki 的 RAG 注入路径。

### 3.2 新增清单（加法）

#### 3.2.1 配置存储

在 Mona 应用数据目录（非 Vault）新增配置项，结构如下：

```json
{
  "agentSearchScope": {
    "notes": {
      "excludedNotebookIds": ["私人日记", "草稿箱"]
    },
    "email": {
      "excludedFolders": ["Junk", "Trash", "Drafts"]
    }
  }
}
```

- 配置存到 `app_data_dir/config.json` 或现有全局配置中，**不写入 Vault**
- 笔记排除列表的颗粒度是**文件夹/笔记本名**（包括根文件夹，用空字符串 `""` 表示）
- 邮件排除列表的颗粒度是**邮件文件夹名**（如 `INBOX`、`Sent`、`Junk`）

#### 3.2.2 设置页新增"Agent 搜索范围"分区

在 `SettingsView.tsx` 的 `SETTINGS_NAV_ITEMS` 中新增一项：

```typescript
{ key: "agent_scope", icon: Search, fallback: "Agent 搜索范围" },
```

位置建议放在 `models_providers` 之后、`web` 之前。

页面内容：

**笔记搜索范围**
- 列出所有笔记本（包括根文件夹"未分类"）
- 每个笔记本前有复选框，默认全选
- 取消勾选的笔记本会进入 `excludedNotebookIds`
- 底部说明文字："Agent 调用 notes_search 工具时不会检索被排除的笔记本。单篇笔记仍可通过 frontmatter 的 contextLevel=none 排除。"

**邮件搜索范围**
- 列出所有邮箱账号的文件夹（按账号分组）
- 每个文件夹前有复选框，默认全选
- 取消勾选的文件夹会进入 `excludedFolders`
- 底部说明文字："Agent 调用 search_emails 工具时不会检索被排除的文件夹。"
- 默认建议排除：垃圾邮件（Junk/Spam）、已删除邮件（Trash/Deleted）、草稿（Drafts）——首次加载时这些默认不勾选。

#### 3.2.3 Rust 侧 `notes_search_all` 接入排除列表

修改 `src-tauri/src/notes.rs` 的 `notes_search_all` 命令：

```rust
#[tauri::command]
pub async fn notes_search_all(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<NoteSearchResult>, String> {
    let vault = match read_vault_path() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let notes = scan_vault_notes(&vault)?;

    // 读取全局配置中的排除笔记本列表
    let excluded = read_agent_scope_excluded_notebooks();
    let filtered: Vec<&OperationNote> = notes
        .iter()
        .filter(|n| !excluded.contains(&n.notebook_id))
        .collect();

    Ok(search_notes_in_memory(
        &filtered,
        None,
        &query,
        limit.unwrap_or(20),
    ))
}
```

`search_notes_in_memory` 函数签名保持不变（`notebook_filter: Option<&str>` 参数用于按单笔记本检索，`notes_search` 命令仍保留），但需要支持 `&[&OperationNote]` 入参——可加一个泛化版本或在调用处过滤。

#### 3.2.4 Python 侧 `search_emails` 接入排除列表

修改 `mona/agent/tools/email_intel.py` 的 `EmailSearchTool.execute()`：

```python
async def execute(self, folder=None, ...):
    # 读取全局配置中的排除邮件文件夹列表
    excluded_folders = read_agent_scope_excluded_email_folders()
    # 如果用户显式指定了 folder，且该 folder 不在排除列表，按用户指定搜索
    # 如果用户未指定 folder，搜索时自动排除 excluded_folders
    ...
```

#### 3.2.5 配置读写 API

新增 Rust 命令供前端读写配置：

```rust
#[tauri::command]
pub async fn get_agent_search_scope() -> Result<AgentSearchScope, String> { ... }

#[tauri::command]
pub async fn set_agent_search_scope(scope: AgentSearchScope) -> Result<(), String> { ... }
```

前端通过 `@/lib/tauri.ts` 调用。

## 4. 不在本次改造范围内

以下内容明确**不做**：

1. **向量索引**——不恢复 `indexVault` 调用，不建立向量数据库。当前 Rust 子串搜索（标题+3、标签+2、正文+1）已满足需求。向量检索作为未来可选增强，需先做基线评测证明收益。
2. **统一检索服务**——不合并三入口（主聊天、Agent、RelatedNotes）。删除 `RelatedNotesPanel` 后入口减为两个，后续视需要再统一。
3. **note_id 与 page_id 统一**——删除 Python 向量后端后，`page_id` 概念随之消失，`note_id` 成为唯一身份，无需额外工作。
4. **自动上下文注入**——不实现"Agent loop 开始时自动检索注入 system prompt"。Agent 通过 `notes_search` 工具自主决定何时检索，对齐 MCP 主流路径。
5. **Agent 自动写回笔记**——现有 `notes_create` / `notes_update` 工具保留，不新增编辑能力。
6. **`contextLevel` 改造**——保持现有 `full` / `summary` / `none` 三级语义不变，继续作为单篇权限兜底。

## 5. 验收标准

### 5.1 删除验证

- [ ] Vault 下不再有 `.mona/embedding.json` 文件
- [ ] `mona/notes_kb/` 目录已删除
- [ ] `/api/notes-kb/*` 路由已移除
- [ ] 笔记右键菜单无"建为知识库"选项
- [ ] `Notebook` 类型无 `knowledgeBaseEnabled` 字段
- [ ] `RelatedNotesPanel` 组件已删除
- [ ] `notes-kb-api.ts` 中 `indexVault` / `searchNotes` 函数已删除

### 5.2 主聊天 KB 选择器验证

- [ ] 选择器只显示 LLM Wiki 知识库项目
- [ ] 不再显示 `notebook:xxx` 前缀的笔记笔记本
- [ ] 选中 LLM Wiki 后 RAG 注入正常工作
- [ ] 未选中任何 KB 时主聊天正常工作

### 5.3 默认开放验证

- [ ] 笔记 Agent 调用 `notes_search` 默认检索所有笔记本（含根目录）
- [ ] 邮件 Agent 调用 `search_emails` 默认检索所有文件夹
- [ ] `contextLevel=none` 的笔记仍被正确排除（现有逻辑保留）

### 5.4 设置页验证

- [ ] 设置页可见"Agent 搜索范围"分区
- [ ] 笔记排除列表正确显示所有笔记本（含根文件夹）
- [ ] 邮件排除列表正确显示所有账号的文件夹
- [ ] 排除某笔记本后，Agent `notes_search` 不再返回该笔记本的笔记
- [ ] 排除某邮件文件夹后，Agent `search_emails` 不再返回该文件夹的邮件
- [ ] 配置写入 `app_data_dir`，不写入 Vault

### 5.5 安全验证

- [ ] Vault 内不存在任何 API Key
- [ ] 排除列表配置不随 Vault 同步

## 6. 实施顺序

建议分三个 commit：

### Commit 1：删除死代码（减法）

- 删除 `mona/notes_kb/` 目录
- 删除 `/api/notes-kb/*` 路由
- 删除 `notes-kb-api.ts` 中 `indexVault` / `searchNotes`
- 删除 `RelatedNotesPanel` 组件
- 清理 `NotesSearchTool.execute()` 中的混合检索分支
- 清理 `ThreadShell.tsx` 中 `notebook:` 前缀的 KB 注入分支

### Commit 2：移除 `knowledgeBaseEnabled` 字段

- Rust 侧删除 `Notebook` / `VaultNotebookMeta` 的 `knowledge_base_enabled` 字段
- 前端删除 `Notebook` 类型的 `knowledgeBaseEnabled` 字段
- 删除 `toggleNotebookKnowledgeBase` 回调
- 删除笔记右键菜单"建为知识库"项
- 主聊天 KB 选择器只显示 LLM Wiki

### Commit 3：新增设置页"Agent 搜索范围"

- 新增 `AgentSearchScope` 配置结构
- 新增 Rust 命令 `get_agent_search_scope` / `set_agent_search_scope`
- 设置页新增"Agent 搜索范围"分区
- `notes_search_all` 接入笔记排除列表
- `search_emails` 接入邮件排除列表

## 7. 风险评估

### 7.1 低风险

- **删除死代码**：`indexVault` 从未被调用，`RelatedNotesPanel` 一直返回 null，删除无行为变化。
- **移除 `knowledgeBaseEnabled` 字段**：该字段从未参与任何业务逻辑，删除无功能影响。
- **主聊天 KB 选择器**：移除笔记笔记本选项不影响 LLM Wiki 功能。

### 7.2 中风险

- **`notes_search_all` 接入排除列表**：需确保配置读取失败时降级为"全检索"（默认开放），不阻塞 Agent 工具调用。
- **`search_emails` 接入排除列表**：需处理"用户显式指定 folder"与"全局排除列表"的优先级——显式指定优先，即使用户指定的 folder 在排除列表中。

### 7.3 需要注意

- **配置迁移**：现有 `vault.json` 中残留的 `knowledge_base_enabled` 字段可安全忽略，新代码不读取。无需写迁移逻辑。
- **测试覆盖**：需为 `notes_search_all` 的排除列表过滤增加单元测试，确保排除生效。

## 8. 最终状态

改造完成后：

- 笔记和邮件默认全部可被 Agent 检索
- 用户可在设置页按文件夹/笔记本级别排除
- 主聊天 KB 选择器只显示 LLM Wiki 知识库
- `contextLevel=none` 仍作为单篇笔记的隐私兜底
- 死代码全部清除，Python 向量后端不再占用安装包体积
- Vault 内不存放任何敏感配置

## 9. 未来可选增强（不承诺）

以下能力明确**不在本次范围**，仅作为未来可能方向记录：

1. **向量检索基线评测**——用 20-30 个真实问题对比子串 vs 向量的 Top-5 命中率，若向量显著优于子串再考虑接入。
2. **本地零配置 Embedding**——用 Rust 原生绑定（如 `ort` crate + ONNX 模型）实现无需 API Key 的本地向量索引，对齐 Smart Connections 的零配置体验。
3. **标签级排除**——在文件夹排除之外，支持按标签排除笔记。
4. **统一检索服务**——若后续需要主聊天也支持笔记 RAG，再统一三入口。

---

本方案核心思想：**删除 > 新增**。通过移除错误的"建为知识库"抽象，回归"默认开放 + 按需收紧"的简单模型，对齐 Obsidian 社区主流做法。
