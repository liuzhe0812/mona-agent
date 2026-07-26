# AI 侧边栏 P0/P1 开发计划

> 依据：`docs/ai-sidebar-evaluation-redesign.md`
> 范围：邮件 P0-A、笔记 P0-B、数据库 P1-B（与 P0 并行）、邮件 P1-A（依赖 P0-A）
> 原则：先补闭环、后做抽象；每个阶段独立 PR、独立验收
> 状态：**全部完成**（tsc + vite build 通过）

---

## 总体排期

```
P0-A 邮件闭环  ──┐
P0-B 笔记选区  ──┼── 并行，互不依赖
P1-B NL2SQL 卡 ──┘
        │
        ▼
P1-A 邮件分析卡（依赖 P0-A 的上下文联通）
        │
        ▼
P2 UI 统一（Header/Composer/ContextChip，P0/P1 稳定后）
```

---

## P0-A：邮件闭环

### 目标
1. Agent 提问当前邮件时，能拿到正文（截断+提示）和已有 `email_analyze` 分析结果
2. 切换邮件后，新请求不携带上一封邮件正文
3. 写信窗口加 AI 按钮：草拟回复、润色正文，结果回填编辑器（不自动发送）

### 实现项

#### A1. 上下文构建重构
- 文件：`webui/src/components/email/MailAgentPanel.tsx` 的 `buildEmailContext`
- 改造为分层构建：
  ```
  [EMAIL_CONTEXT]
  account_id / folder / uid / subject / from / from_name / date
  [EMAIL_ANALYSIS]（若 analysisCache 命中）
  summary / category / intent / urgency / key_info
  [EMAIL_BODY]
  <bodyText 截断到 4000 字符；超长则尾部追加：
   "…（正文已截断，如需完整内容请使用 read_email_body 工具读取 account_id=X folder=Y uid=Z）">
  [/EMAIL_BODY]
  [/EMAIL_CONTEXT]
  ```
- 常量 `EMAIL_BODY_CHAR_LIMIT = 4000`
- 从 `useEmailStore` 读取 `analysisCache`（key=`${uid}:${accountId}:${folder}`），命中则注入分析段
- 未命中不自动触发 `runAnalysis`，直接用正文回答

#### A2. 会话作用域修正
- 问题：当前 `agentChatId` 全局单值，切换邮件时历史会话残留
- 方案：切换邮件时，若当前 `agentChatId` 属于上一封邮件，重置为 null（下条提问自动新建）
- 实现：`MailAgentPanel` 内 `useEffect` 监听 `selectedMessage?.uid` 变化，比较 ref 中上次 uid，不同则 `setAgentChatId(null)` + `setMessages([])`
- 邮箱级任务（自动归档、无选中邮件搜索）不受影响，继续用全局会话

#### A3. 写信窗口 AI
- 入口：写信窗口工具栏新增 AI 按钮（图标 Sparkles）
- 弹出轻量菜单：草拟回复 / 润色正文 / [语气: 正式|随意|默认]
- 草拟回复：
  - 上下文：原邮件 subject/from/bodyText（截断）+ 当前收件人关系
  - 调用 agent 会话（复用 `useMonaStream`，独立 chatId 存写信窗口 state）
  - 结果回填写信编辑器正文区，保留原正文到 undo 栈
- 润色正文：
  - 上下文：写信窗口当前正文 + 语气要求
  - 结果替换正文区
- 约束：
  - 不自动发送
  - 失败不清空草稿
  - 回复模式不修改收件人/主题/附件
- 文件：找到写信窗口组件（`Compose*` / `Write*`），新增 AI 工具栏组件

### 验收
- [x] Agent 能回答只存在于当前邮件正文中的问题
- [x] 已有 `email_analyze` 结果被复用，不重复请求分析
- [x] 切换邮件后新请求不携带上一封邮件正文
- [x] 草拟回复/润色只修改正文，不触发发送
- [x] 失败时原草稿不变
- [x] 邮件批量操作确认流程无回归
- [x] `ruff check` / `bun run build` 通过

---

## P0-B：笔记选区 AI

### 目标
选中笔记内文本 → 浮动工具条（润色/缩写/翻译）→ 结果预览 → 替换/插入/复制/取消

### 实现项

#### B1. 选区浮动工具条
- 文件：笔记编辑器组件（TipTap，找 `notes/Edit*` 或 `NoteEditor*`）
- 监听编辑器 `selection-update` 事件，当选区非空且非折叠时显示工具条
- 工具条定位：选区上方，使用 floating-ui 或绝对定位计算
- 三个按钮：润色、缩写、翻译（图标 Wand2/Minimize2/Languages）
- 点击后进入"生成中"状态，工具条转为 loading

#### B2. 上下文与调用
- 发送给 agent 的内容（最小化）：
  ```
  笔记标题: <title>
  
  选中文本:
  <selected_text>
  
  任务: <润色|缩写|翻译>
  要求: <动作特定指令>
  翻译规则: 中文→英文，其他→中文
  只输出结果，不要解释。
  ```
- 调用：复用 `useMonaStream`，独立 chatId（存笔记 frontmatter 或组件 state）
- 不发送整篇笔记

#### B3. 结果应用与安全
- 结果以小型预览气泡呈现（选区下方），四个操作：
  - 替换选区：替换前校验当前选区文本与请求时一致（存 ref 比对）；不一致则禁用替换，仅保留复制
  - 插入选区后：在选区末尾插入结果
  - 复制
  - 取消
- 撤销：替换走 TipTap 的 transaction，支持编辑器原生 undo
- 切换笔记：`useEffect` 监听 note.id 变化，清空待应用结果

### 验收
- [x] Agent 收到的正文仅包含选中文本（可抽查网络请求或加日志）
- [x] 替换只影响原选区，不改动其他段落
- [x] 生成期间编辑正文不会替换错误位置（选区校验生效）
- [x] 可撤销一次替换
- [x] 切换笔记后旧结果不作用到新笔记
- [x] 现有整篇总结/翻译/标签/自定义模板无回归
- [x] `bun run build` 通过

---

## P1-B：NL2SQL 结果卡片（与 P0 并行）

### 目标
现有 `extractSql` + `updateTabSql` 升级为 SQL 结果卡片，带插入/替换/复制按钮

### 实现项

#### C1. SQL 结果卡片组件
- 新文件：`webui/src/components/db/SqlResultCard.tsx`
- 从 assistant message 内容中提取 SQL（复用现有 `extractSql` 逻辑）
- 卡片内容：
  - SQL 代码块（CodeBlock 组件，语法高亮）
  - 三个按钮：插入编辑器 / 替换当前 / 复制
- 不提供直接执行

#### C2. 集成到 DbAgentPanel
- 文件：`webui/src/components/db/DbAgentPanel.tsx`
- 当 `pendingNlToSqlRef.current === true` 且 streaming 结束时，不再直接 `updateTabSql`，而是渲染 `SqlResultCard`
- 卡片按钮回调：
  - 插入编辑器：在当前 SQL 末尾追加 `\n` + sql
  - 替换当前：`updateTabSql(activeTabId, sql)`
  - 复制：`navigator.clipboard.writeText(sql)`
- 降级：`extractSql` 返回 null 时，保持现有行为（不显示卡片）

### 验收
- [x] NL2SQL 产出渲染为卡片，不再直接回填
- [x] 插入/替换/复制三个按钮工作正常
- [x] 不提供直接执行
- [x] extractSql 失败时降级为 Markdown，不阻断会话
- [x] 现有对话提问（非 NL2SQL）不受影响
- [x] `bun run build` 通过

---

## P1-A：邮件分析卡（依赖 P0-A）

### 目标
现有 `EmailAnalysis` 数据渲染为常驻卡片，带草拟回复入口

### 实现项

#### D1. 邮件分析卡组件
- 新文件：`webui/src/components/email/EmailAnalysisCard.tsx`
- 数据源：`useEmailStore.analysisCache[`${uid}:${accountId}:${folder}`]`
- 展示：摘要 / 分类 / 意图 / 紧急度 / 关键信息
- 按钮：草拟回复（触发写信窗口 AI，复用 P0-A 的 A3 能力）
- 无分析时：不渲染卡片（不自动触发分析）

#### D2. 集成到 MailAgentPanel
- 文件：`webui/src/components/email/MailAgentPanel.tsx`
- 在快捷操作区下方、消息列表上方插入卡片（命中缓存时显示）
- 卡片可折叠（节省空间）

### 验收
- [x] 有分析结果时显示卡片，无则不显示
- [x] 卡片字段正确渲染
- [x] 草拟回复按钮触发写信窗口 AI
- [x] 卡片折叠/展开正常
- [x] `bun run build` 通过

---

## 执行顺序

1. **先做 P0-B（笔记选区 AI）**：独立、不依赖其他模块，风险最低
2. **并行 P1-B（NL2SQL 卡）**：独立、改造范围小
3. **再做 P0-A（邮件闭环）**：改动最大，含写信窗口
4. **最后 P1-A（邮件分析卡）**：依赖 P0-A 的写信能力

每个阶段完成后：
- 运行 `ruff check`（Python）和 `bun run build`（前端）
- 运行相关模块测试
- 自查验收清单
- 标记本计划对应项为 [x]
