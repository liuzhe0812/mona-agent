# 笔记模块开发计划

更新时间：2026-05-28

## 当前目标

功能范围只放在笔记模块内，但笔记页面必须能用到现有 agent 能力。

本阶段的“完成”指的是：用户进入笔记子页面后，可以管理笔记本和笔记，可以用可视化方式编辑 Markdown 笔记，也可以在右侧 Agent 联动区围绕当前笔记直接提问、触发快捷功能，并把 agent 回复追加、替换或复制到当前笔记。

暂时不做 SSH/RDP/Windows 模块真实联动，也不做向量索引和跨知识库问答。笔记模块内的结构化知识视图、知识点提取、自动归类和人工调整已经纳入本阶段。

## 原型对照

已覆盖的笔记子页面功能：

- 笔记本用下拉菜单选择，不做笔记本列表。
- 笔记本支持新建、重命名、编辑描述、删除、标记为知识库。
- 笔记才用左侧列表展示，支持搜索、数量统计、来源标签、更新时间、标签编辑和移动到其他笔记本。
- 顶部工具区按原型收敛为笔记本下拉 + 图标按钮：新建笔记、搜索、新建 SSH 记录、导出 Markdown、更多菜单。
- 中间是 Tiptap 可视化编辑器，并支持 Markdown 源码模式；标题放在正文编辑区内，工具栏固定在编辑区顶部。
- 编辑器工具栏支持正文、标题、加粗、斜体、任务清单、项目列表、编号列表、引用、代码块、表格、链接、撤销、重做。
- 桌面端 SQLite 自动保存，重启后恢复笔记、笔记本、选中状态。
- 自动保存有明确状态：正在保存、已自动保存、保存失败。
- 存储字段严格解析，数据库内容损坏时直接报错，不用空数组或空对象继续跑。
- 右侧为 Agent 联动面板，有连接状态、收起、对话区、快捷操作区、底部输入框和可拖拽宽度。
- 页面控件尺寸已按新会话页密度收敛：顶部栏 48px、图标按钮 32px、笔记列表 224px、右侧 Agent 面板 306px 起。
- 知识视图采用左侧知识分类目录、右侧知识卡片列表；一个知识点可以关联多篇笔记。
- 知识分类不预置固定业务分类，支持多级分类；AI 提取时会看到当前已有分类路径，但只在主题、学科或技术域高度一致时复用，`categoryName` 带 `/` 时自动创建多级路径，用户也能手动调整。

已覆盖的 Agent 联动能力：

- 每篇笔记独立保存一个 `agentChatId`。
- 当前笔记首次提问时，自动创建笔记专属 agent 会话。
- 再次进入同一笔记时，通过 `agentChatId` 读取对应 agent 会话历史。
- 自由提问会把当前笔记 Markdown 一起带给 agent。
- 快捷功能会生成面向当前笔记的 agent prompt：总结当前笔记、提取知识点。
- agent 流式回复会直接显示在笔记右侧面板内。
- agent 回复支持追加到当前笔记、替换当前笔记正文、复制为 Markdown。
- 已写回的 agent 回复会记录在 `appliedAgentMessageIds`，避免重复追加。
- `提取知识点` 会要求 Agent 输出结构化 JSON 候选列表，分类由 AI 根据内容自动推荐；候选确认使用弹窗，用户确认后保存并进入知识视图。
- 提取知识点时会把当前已有分类树和已有标签一起发给 Agent；分类只在高度匹配时复用，标签限制 1-4 个并优先复用已有标签。
- AI 返回新分类时自动创建分类，用户后续可新建一级分类和子分类、重命名、删除分类，也可移动知识点分类。
- 分类页直接展示知识卡片，卡片内显示标题、精简内容总结、标签、编辑/删除/移动分类和关联笔记入口，不再点击进入详情页。

## 技术路线

编辑器使用 Tiptap。

原因：

- 当前前端是 React + Vite + Tailwind，Tiptap 适配成本低。
- Tiptap 是 headless 编辑器，样式能贴合 Mona 现有灰白简约风。
- 用户默认用可视化编辑，不需要会 Markdown。
- 底层仍保留 Markdown，方便导出、agent 上下文和后续知识库使用。
- 桌面打包可用；编辑器依赖偏大，所以笔记模块已经按懒加载思路接入。

Agent 联动复用当前项目已有能力：

- 用 `useClient().client.newChat()` 创建笔记专属会话。
- 用 `useSessionHistory("websocket:<chatId>")` 读取历史消息。
- 用 `useMonaStream(chatId, ...)` 收发真实 agent 流式消息。

笔记存储使用 Tauri 后端 SQLite：

- 数据库文件：应用数据目录下的 `notes/notes.sqlite3`。
- 表：`notebooks`、`notes`、`knowledge_categories`、`knowledge_items`、`app_state`。
- `notes.content_markdown` 是正文主数据源，Tiptap 可视化编辑只负责编辑体验。
- `notes.agent_chat_id` 保存每篇笔记绑定的 Agent 会话。
- `notes.applied_agent_message_ids_json` 记录已写回的 Agent 消息。
- `knowledge_items.source_note_id` 关联首个原始笔记，`linked_notes_json` 记录所有关联笔记；知识视图不复制整篇笔记全文，只保存提炼后的知识点。
- 知识点标签限制 1-4 个；新提取、合并已有知识点、手动编辑都遵守这个限制。
- 初始知识分类只有 `未分类`，不再固化运维或技术分类。
- `knowledge_categories` 只向前端暴露分类名称和 `parentId`，不再使用描述字段。
- 不再使用 `localStorage` 或单 JSON 文件做桌面端兜底；存储失败时页面直接提示失败。
- 前端新建笔记、新建笔记本、复制笔记统一使用 `crypto.randomUUID()`，环境不支持时直接提示失败，不改用时间戳 ID。
- 前端保存做 450ms 防抖，避免每次按键都触发 Tauri 写库；切换笔记时编辑器只在笔记切换或外部内容变化时同步内容，避免打字过程被反复覆盖。

## 已完成

- [x] 新增笔记模块目录：`webui/src/components/notes`
- [x] 新增笔记模块入口：`NotesView.tsx`
- [x] 新增笔记本下拉：`NotebookSelect.tsx`
- [x] 新增笔记列表：`NoteList.tsx`
- [x] 新增 Tiptap 编辑器：`NoteEditor.tsx`
- [x] 新增右侧 Agent 联动面板：`NoteAgentPanel.tsx`
- [x] 新增知识视图：`KnowledgeView.tsx`
- [x] 新增笔记类型定义：`notes-data.ts`
- [x] 新增桌面端笔记存储调用：`notes-storage.ts`
- [x] 新增 Tauri SQLite 笔记存储：`src-tauri/src/notes.rs`
- [x] 清理 `localStorage` / JSON 文件兜底存储策略
- [x] 清理后端读库时吞 JSON 解析错误的逻辑
- [x] 清理前端时间戳 ID 生成逻辑
- [x] 新增 agent prompt 构造工具：`notes-ai.ts`
- [x] 按原型调整顶部工具区：只保留下拉和图标按钮
- [x] 按原型调整笔记列表：固定窄列、卡片化列表项、底部数量统计
- [x] 按原型调整编辑区：标题进入内容区，工具栏贴顶部
- [x] 按原型调整右侧 Agent 面板：对话区、快捷操作区、输入框分层
- [x] 按新会话页尺寸体系压缩笔记页控件尺寸
- [x] 新建笔记
- [x] 新建 SSH 记录模板
- [x] 新建笔记本
- [x] 重命名笔记本
- [x] 编辑笔记本描述
- [x] 删除笔记本，并同步删除该笔记本内笔记
- [x] 标记/取消标记笔记本为知识库
- [x] 笔记搜索
- [x] 编辑笔记标签
- [x] 移动笔记到其他笔记本
- [x] 当前笔记导出 Markdown
- [x] 更多菜单：复制 Markdown、复制笔记、删除笔记
- [x] 编辑器保存状态、字数和行数
- [x] 编辑器切换笔记时稳定同步，避免输入中反复重置内容
- [x] 自动保存防抖和失败状态展示
- [x] 编辑器 Markdown 源码模式
- [x] 右侧 Agent 面板收起和固定按钮
- [x] Agent 对话/功能双视图
- [x] 每篇笔记保存自己的 agent 会话 ID
- [x] 笔记页内创建真实 agent 会话
- [x] 笔记页内读取真实 agent 会话历史
- [x] 自由提问发送当前笔记上下文给 agent
- [x] Agent 总结当前笔记
- [x] Agent 提取知识点
- [x] 提取知识点时带入当前已有分类树，但只在语义高度匹配时复用已有分类
- [x] 提取知识点时带入当前已有标签，标签限制 1-4 个并优先复用已有标签
- [x] 技术知识按技术领域自动归类，默认多级分类
- [x] Agent 回复生成候选知识点卡片，用户确认后保存为结构化知识条目
- [x] 候选知识点确认改为弹窗，关闭弹窗后保留重新打开入口
- [x] 知识视图按分类展示知识卡片
- [x] 知识点去掉二级详情页，卡片内直接展示精简内容总结
- [x] 知识点编辑
- [x] 知识点删除
- [x] 知识页面长内容不撑破当前区域
- [x] 一个知识点关联多篇笔记
- [x] 从关联笔记返回知识视图
- [x] AI 根据笔记内容自动归类或创建新知识分类
- [x] 多级知识分类
- [x] 人工新建一级分类、新建子分类、重命名、删除知识分类
- [x] 人工移动知识点分类
- [x] 提取知识点完成后生成候选卡片，不在 Agent 回复卡片放保存按钮
- [x] 知识点支持跳回关联笔记
- [x] Agent 回复追加到当前笔记
- [x] Agent 回复替换当前笔记正文
- [x] Agent 回复复制为 Markdown
- [x] 记录已回写的 agent 消息，避免重复追加
- [x] 移除本地模拟 AI 消息结构和示例笔记数据

## 最小闭环交付判断

已完成。

当前笔记模块已经具备最小可交付闭环：

- 首次进入桌面端会初始化默认笔记本。
- 用户可以新建笔记本、新建笔记、编辑内容、改标题、改标签、移动笔记、删除笔记。
- 笔记会自动保存到 Tauri SQLite，重启后恢复笔记本、笔记和选中状态。
- 用户不用懂 Markdown，默认用可视化编辑；需要时可以切到 MD 源码。
- 每篇笔记可以创建并绑定独立 Agent 会话。
- Agent 可以读取当前笔记上下文，回复可以追加、替换或复制回笔记。
- Agent 可以从当前笔记提取结构化知识点，AI 自动归类或创建分类。
- 用户可以在知识视图里调整分类，并从知识卡片跳回关联笔记；同一个知识点可以保留多篇来源笔记。

## 后续增强，不影响最小闭环

- [ ] SSH/RDP/Windows 会话历史真实保存到指定笔记本。
- [ ] 基于知识条目创建向量索引和跨知识库问答。
- [ ] 增加笔记数据库迁移版本号和迁移测试。
- [ ] 按笔记字段做更细粒度的后端 CRUD 命令，减少整包事务保存。
- [ ] 给 Markdown 往返转换补极简核心测试。

## 验证记录

- 笔记模块单独 TypeScript 检查：通过。
- Web 前端 TypeScript 构建检查：未通过，阻塞点在非笔记模块 `src/components/terminal/Toolbar.tsx` 引用了不存在的 `saveConnection`。本轮按要求不修改笔记模块以外代码。
- Tauri 后端 `cargo check`：通过，有 terminal/db 模块既有 warning，不影响本次笔记功能。
- 笔记模块残留兜底扫描：通过，未发现 `localStorage`、示例笔记、模拟 AI 消息、时间戳 ID、吞 JSON 解析错误等旧逻辑。
- 固定知识分类扫描：通过，未发现旧的固定运维/技术知识分类。
- 本地浏览器打开 `http://127.0.0.1:5173/`：笔记模块可进入，控制台无错误；浏览器环境提示“笔记存储需要在桌面端运行”，真实 SQLite invoke 链路仍需要在 Tauri 桌面端补一次手工验收。

## 当前文件范围

本轮笔记模块相关变更文件：

- `webui/src/components/notes/NotesView.tsx`
- `webui/src/components/notes/KnowledgeView.tsx`
- `webui/src/components/notes/NoteAgentPanel.tsx`
- `webui/src/components/notes/NoteEditor.tsx`
- `webui/src/components/notes/NoteList.tsx`
- `webui/src/components/notes/NotebookSelect.tsx`
- `webui/src/components/notes/notes-data.ts`
- `webui/src/components/notes/notes-storage.ts`
- `webui/src/components/notes/notes-ai.ts`
- `webui/package.json`
- `webui/package-lock.json`
- `webui/src/lib/tauri.ts`
- `src-tauri/src/notes.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `docs/notes-module-development-plan.md`
