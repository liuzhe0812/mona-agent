# 笔记知识点提取功能开发计划

更新时间：2026-05-28

## 目标

在通用笔记模块内实现“提取知识点”闭环：Agent 从当前笔记提取候选知识点，自动推荐分类或新分类，用户确认后保存到知识视图，并能手动调整多级分类、跳回原始笔记。

## 范围

只改笔记模块及其必须依赖的 Tauri 笔记存储。

包括：

- 笔记模块前端类型。
- Agent prompt。
- Agent 面板按钮。
- 知识视图。
- 多级知识分类人工调整。
- SQLite 持久化。
- 开发文档。

不包括：

- 独立知识库模块。
- 向量索引。
- 跨知识库问答。
- SSH/RDP/Windows 模块联动。

## 文件规划

- `webui/src/components/notes/notes-data.ts`
  - 增加 `KnowledgeCategory`、`KnowledgeItem`、`extractKnowledge` action 类型。
  - `KnowledgeCategory` 只保留分类名称和 `parentId`，不保留描述。
- `webui/src/components/notes/notes-storage.ts`
  - 扩展 `NotesStorageState`。
  - 增加知识分类和知识条目 ID 创建方法。
- `webui/src/components/notes/notes-ai.ts`
  - 增加 `提取知识点` prompt。
  - 分类由 AI 根据内容自动生成，不写固定分类列表。
  - 提取时带上当前已有分类路径，但只允许 Agent 在主题、学科或技术域高度一致时复用已有分类。
  - 提取时带上当前已有标签，优先复用已有标签；标签限制 1-4 个。
  - 技术内容必须从技术角度归类，并默认生成多级分类路径。
  - 增加 AI JSON 解析函数。
- `webui/src/components/notes/NoteAgentPanel.tsx`
  - 增加 `提取知识点` 按钮。
  - `提取知识点` 的 Agent 回复完成后解析为候选知识点卡片，由用户确认保存，不在回复卡片里显示 `保存知识点`。
  - `categoryName` 支持用 `/` 表示多级分类路径。
- `webui/src/components/notes/KnowledgeView.tsx`
  - 新增知识分类目录和知识卡片列表。
  - 支持多级分类展示。
  - 支持分类内搜索、标签筛选。
  - 卡片内直接展示精简内容总结和关联笔记入口，不再进入详情页。
  - 支持新建一级分类、新建子分类、重命名、删除分类。
  - 支持知识点移动分类。
- `webui/src/components/notes/NotesView.tsx`
  - 增加 `笔记 / 知识` 子视图切换。
  - 管理知识分类、知识条目状态。
  - 保存知识点并跳转知识视图；同分类同名知识点只追加关联笔记，不重复创建页面。
- `src-tauri/src/notes.rs`
  - 扩展 SQLite schema。
  - 加载和保存知识分类、知识条目。
  - 只初始化 `未分类`，不预置固定业务分类。
  - 分类持久化 `parent_id`，不向前端暴露描述。
  - 知识条目持久化 `linked_notes_json`，支持一个知识点关联多篇笔记。
  - 增加后端状态校验。
- `docs/notes-knowledge-extraction-design.md`
  - 方案设计。
- `docs/notes-knowledge-extraction-development-plan.md`
  - 本开发计划。
- `docs/notes-module-development-plan.md`
  - 更新笔记模块总进度。

## 执行任务

### Task 1：定义知识数据结构

- [x] 在 `notes-data.ts` 增加 `KnowledgeCategory`。
- [x] 在 `notes-data.ts` 增加 `KnowledgeItem`。
- [x] 在 `notes-data.ts` 增加 `KnowledgeLinkedNote`。
- [x] `KnowledgeCategory` 改为只保留 `name` 和 `parentId`。
- [x] 将 `NoteAiActionId` 扩展为 `summary | extractKnowledge | freeform`。
- [x] 在 `notes-storage.ts` 扩展 `NotesStorageState`。
- [x] 在 `notes-storage.ts` 增加 `createKnowledgeCategory()`。
- [x] 在 `notes-storage.ts` 增加 `createKnowledgeItemId()`。

### Task 2：增加 AI 提取知识点协议

- [x] 在 `notes-ai.ts` 增加 `提取知识点` action。
- [x] 在 `buildAgentActionPrompt()` 中增加 `extractKnowledge` 分支。
- [x] 要求 Agent 输出严格 JSON。
- [x] 要求 AI 根据笔记内容自动返回分类名，不固定使用运维/技术分类。
- [x] 增加 `parseExtractedKnowledgeCandidates()`，把 AI JSON 解析为候选知识点列表。
- [x] 解析失败时抛出明确错误，由 UI 提示。

### Task 3：接入 Agent 面板

- [x] 在 `NoteAgentPanel.tsx` 的快捷区增加 `提取知识点`。
- [x] Agent 回复符合知识 JSON 时生成候选知识点卡片。
- [x] 用户在候选卡片点击保存后再写入知识视图。
- [x] AI 回复卡片不再显示 `保存知识点` 操作。

### Task 4：实现知识视图

- [x] 新建 `KnowledgeView.tsx`。
- [x] 左侧展示多级知识分类目录。
- [x] 右侧展示当前分类下知识卡片。
- [x] 知识卡片显示标题、精简内容总结、标签、关联笔记、更新时间。
- [x] 知识卡片支持跳回关联笔记。
- [x] 知识卡片支持移动到其他分类。
- [x] 分类目录支持新建一级分类。
- [x] 分类目录支持新建子分类。
- [x] 分类目录支持重命名分类。
- [x] 分类目录支持删除分类，删除时知识点移动到父级或剩余分类，子分类向上移动，不直接丢数据。

### Task 5：接入 NotesView 状态流

- [x] 增加 `viewMode: notes | knowledge`。
- [x] 增加知识分类和知识条目状态。
- [x] 加载状态时读取知识分类和知识条目。
- [x] 保存状态时写入知识分类和知识条目。
- [x] 保存知识点后自动切到知识视图。
- [x] AI 返回新分类时自动创建分类，支持 `/` 多级路径。
- [x] 点击关联笔记后切回笔记视图并选中对应笔记。
- [x] 从知识卡片打开关联笔记后，笔记编辑器显示返回知识视图入口。
- [x] 支持手动创建一级分类和子分类、重命名、删除知识分类。
- [x] 支持手动移动知识点分类。

### Task 6：实现 Tauri SQLite 持久化

- [x] 在 `src-tauri/src/notes.rs` 增加知识分类和知识条目 Rust 类型。
- [x] 新增 `knowledge_categories` 表。
- [x] 新增 `knowledge_items` 表。
- [x] 初始化 `未分类`，不再初始化固定运维/技术分类。
- [x] 分类增加 `parent_id` 持久化，支持多级分类。
- [x] 知识条目增加 `linked_notes_json`，支持多篇关联笔记持久化。
- [x] 加载知识分类和知识条目。
- [x] 保存知识分类和知识条目。
- [x] 校验知识分类和知识条目状态。

### Task 7：通用笔记修正

- [x] 新建笔记默认文案改为通用笔记。
- [x] 默认笔记本改为通用笔记本。
- [x] 编辑器 placeholder 改为通用笔记描述。
- [x] 清理文档里的固定运维分类描述。

### Task 8：更新文档

- [x] 新增方案设计文档。
- [x] 新增开发计划文档。
- [x] 更新笔记模块总计划，记录知识点提取和通用分类完成状态。

### Task 9：验证

- [x] 笔记模块 TypeScript 检查。
- [x] 笔记模块残留兜底扫描。
- [x] Tauri 后端检查。
- [x] 如 Tauri 后端仍被 terminal 模块挡住，在文档和最终说明里明确说明阻塞点。

### Task 10：提取知识点时带入已有分类树

- [x] 在 `notes-ai.ts` 增加分类路径格式化方法。
- [x] `buildAgentActionPrompt()` 接收当前 `knowledgeCategories`。
- [x] `extractKnowledge` prompt 增加“已有分类路径”，但要求 Agent 只在语义高度匹配时复用。
- [x] `extractKnowledge` prompt 明确技术内容按技术领域归类，默认至少二级分类。
- [x] `NoteAgentPanel.tsx` 接收 `knowledgeCategories` 并传给 prompt。
- [x] `NotesView.tsx` 将当前知识分类传入右侧 Agent 面板。

### Task 11：知识视图改为卡片列表

- [x] `KnowledgeView.tsx` 将分类页默认展示改为知识卡片列表。
- [x] 卡片直接显示标题、精简内容总结、标签、关联笔记、更新时间。
- [x] 去掉知识点二级详情页。
- [x] 卡片内支持分类调整、编辑、删除和打开关联笔记。

### Task 12：支持一个知识点关联多篇笔记

- [x] `KnowledgeItem` 增加 `linkedNotes`。
- [x] 新提取知识点时写入当前笔记为关联笔记。
- [x] 同一分类下同名知识点再次提取时，不新建重复知识点，只追加或更新关联笔记。
- [x] 知识卡片显示关联笔记数量。
- [x] 知识卡片展示关联笔记入口，并支持打开任意关联笔记。
- [x] 从关联笔记返回知识视图。
- [x] Tauri SQLite 持久化关联笔记列表。

### Task 13：补齐知识点编辑、删除和布局边界

- [x] 知识卡片增加编辑模式。
- [x] 支持编辑标题、精简内容总结、来源说明、标签。
- [x] 编辑时校验标题、精简内容总结不能为空。
- [x] 编辑时校验标签必须是 1-4 个。
- [x] 支持删除知识点，删除前二次确认。
- [x] 删除后从卡片列表移除。
- [x] 知识视图根容器禁止横向溢出。
- [x] 卡片标题、精简内容总结、来源说明、关联笔记长文本不撑破页面区域。

### Task 15：修正知识分类和提炼策略

- [x] 修正“优先复用已有分类”导致错误分类的问题。
- [x] 分类逻辑改为先判断内容所属领域，再判断已有分类是否高度匹配。
- [x] 技术内容明确从技术领域归类，不再归到教育技术等弱相关分类。
- [x] 提取内容改为精简内容总结，不再大段复述原文。
- [x] 知识页面去掉点击进入详情的交互，卡片内直接跳转关联笔记。

### Task 14：修复首次提取知识点候选生成

- [x] 修复首次创建笔记专属 Agent 会话时，提取知识点待处理标记被清空的问题。
- [x] Agent 回复未命中严格字段检测时，仍尝试解析最终回复，并给出明确失败提示。
- [x] 保持切换到其他笔记时清理待处理状态，避免串到别的笔记。

### Task 16：改为候选知识点确认入库

- [x] `extractKnowledge` prompt 改为返回 `items` 候选列表，最多 5 个。
- [x] 候选字段改为 `summary` 精简内容总结，不再用大段概述承载核心内容。
- [x] 候选卡片显示标题、推荐分类、精简内容总结和标签。
- [x] 去掉 Agent 回复完成后的自动入库，用户点击候选卡片保存后才写入知识视图。
- [x] 保存时把候选知识点转换为现有 `KnowledgeItem`，并保留多笔记关联逻辑。
- [x] AI 原始 JSON 回复在聊天区收敛为提示文案，避免用户直接看到大段 JSON。

### Task 17：修复候选知识点不可见问题

- [x] 将候选知识点入口从聊天滚动区顶部移到输入框上方，避免被聊天滚动隐藏。
- [x] 修正提示文案，明确可以打开候选确认入口。
- [x] 解析失败时在输入框上方持续显示错误，不再只短暂显示在标题栏。

### Task 18：轻量知识点和弹窗确认

- [x] 候选知识点确认改为弹窗，生成候选后自动打开。
- [x] 弹窗关闭后，如仍有候选知识点，右侧输入框上方保留重新打开入口。
- [x] 去掉候选卡片里的保存理由、关键概念、适用场景、注意事项等固定详情区。
- [x] 知识卡片去掉正文详情区，只展示标题、精简内容总结、标签、分类和关联笔记。
- [x] 知识点编辑去掉独立正文编辑，编辑精简内容总结时同步更新存储里的 `content` 字段。
- [x] 提取知识点时把已有标签传给 Agent，要求优先复用已有标签。
- [x] 新提取、合并已有知识点、手动编辑时，标签都限制为 1-4 个。
- [x] 标签策略明确为领域级或主题级，避免 BF16、INT8 这类过细参数长期堆积成标签。

## 验证记录

- 笔记模块 TypeScript 检查 `npx tsc -p src/components/notes/tsconfig.notes-check.json`：通过。
- Web 前端 TypeScript 构建检查 `npx tsc -p tsconfig.build.json`：未通过，阻塞点在非笔记模块 `src/components/terminal/Toolbar.tsx` 引用了不存在的 `saveConnection`。本轮按用户要求不修改笔记模块以外代码。
- 笔记模块旧兜底扫描：通过，未发现 `localStorage`、示例笔记、模拟 AI 消息、时间戳 ID、吞 JSON 解析错误等旧逻辑。
- 固定分类扫描：通过，未发现旧的固定运维/技术知识分类。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过，有 terminal/db 模块既有 warning，不影响本次笔记功能。

## 验收用例

1. 打开笔记页面。
2. 进入笔记视图，选择一篇有内容的笔记。
3. 点击右侧 `提取知识点`。
4. Agent 返回 JSON 后，右侧自动打开候选知识点确认弹窗。
5. 候选卡片显示标题、推荐分类、精简内容总结和 1-4 个标签。
6. 点击候选卡片里的保存后，页面切换到知识视图。
7. AI 返回新分类时，左侧自动出现对应分类；返回 `父级/子级` 时自动形成层级。
8. 右侧出现知识卡片，卡片内直接显示精简内容总结。
9. 在知识卡片里把知识点移动到其他分类。
10. 新建一级分类、新建子分类、重命名、删除知识分类。
11. 点击关联笔记回到原始笔记，再点击顶部返回入口回到知识视图。
12. 对同一分类下同名知识点再次提取时，只增加关联笔记，不新增重复详情页。
13. 在知识卡片里编辑标题、精简内容总结、来源说明、标签后，内容能保存。
14. 手动输入 0 个或超过 4 个标签时，编辑保存会提示修正。
15. 删除知识点后回到目录，重启后该知识点不再出现。
16. 长标题、长链接、长精简总结不会撑出知识页面内容区域。
17. 重启桌面端后知识分类、知识条目和关联笔记仍存在。

## 当前设计结论

知识视图只保存提炼后的精简知识点，不复制整篇笔记全文。AI 只负责生成候选知识点，入库动作由用户确认。

完整上下文通过 `关联笔记` 跳转回笔记查看。同一个知识点可以关联多篇笔记，分类由 AI 自动判断，也允许用户后续用多级分类手动整理。
