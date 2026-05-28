# 数据库 AI 助手运维功能 — 开发计划

## 依赖关系

```
Phase 1: Agent 工具层（后端）
  ├── Step 1: _tauri_invoke 桥接验证
  ├── Step 2: db_query 工具
  ├── Step 3: db_table_info 工具
  └── Step 4: db_server_status 工具
           │
           ▼
Phase 2: 前端 UI 层
  ├── Step 5: 上下文传递机制
  ├── Step 6: 6 个快捷按钮
  ├── Step 7: NL2SQL 输入框
  └── Step 8: SQL 提取与填入
           │
           ▼
Phase 3: 集成验证
  └── Step 9: 端到端测试 + 修复
```

## Phase 1: Agent 工具层

### Step 1: _tauri_invoke 桥接验证

**目标**：确认 Python Agent 能通过 `_tauri_invoke` 调用数据库 Tauri 命令

**任务**：
1. 阅读 `mona/agent/tools/terminal.py` 中 `_tauri_invoke` 的实现
2. 验证 `_tauri_invoke("db_execute_query", {...})` 是否能正常调用
3. 如果不能直接调用（因为 `_tauri_invoke` 可能是 terminal 专用的），需要实现通用的 Tauri IPC 桥接

**验证**：在 Agent 对话中手动触发 `db_execute_query` 调用，确认返回数据

**涉及文件**：
- `mona/agent/tools/terminal.py`（阅读 `_tauri_invoke`）
- `mona/agent/tools/database.py`（新建，先写一个最小测试工具）

### Step 2: db_query 工具

**目标**：实现 `db_query` 工具，AI 可执行只读 SQL 查询

**任务**：
1. 创建 `mona/agent/tools/database.py`
2. 实现 `_DbTool` 基类，包含 `set_context` 方法从 `RequestContext.metadata` 提取 `connection_id`/`database`/`table`
3. 实现 `DbQueryTool`：
   - 参数：`sql`（必填）、`database`（可选）
   - 安全检查：只允许 SELECT/SHOW/DESCRIBE/EXPLAIN/WITH 开头的语句
   - 自动追加 LIMIT 100（如果 SQL 不含 LIMIT）
   - 调用 `_tauri_invoke("db_execute_query", { connectionId, sql, limit: 100, database })`
   - 返回格式化的查询结果（列名 + 行数据，文本格式）
4. 注册到 `ToolLoader`（自动发现机制，放在 `mona/agent/tools/` 下即可）

**验证**：在 Agent 对话中让 AI 调用 `db_query`，确认返回数据

**涉及文件**：
- `mona/agent/tools/database.py`（新建）

### Step 3: db_table_info 工具

**目标**：实现 `db_table_info` 工具，AI 可获取表结构

**任务**：
1. 在 `database.py` 中实现 `DbTableInfoTool`：
   - 参数：`database`（必填）、`table`（必填）
   - 调用 `_tauri_invoke("db_get_table_info", { connectionId, database, table })`
   - 返回格式化的表结构信息（列定义、索引、外键、DDL、行数等）
2. 如果 `connection_id` 存在但 `database`/`table` 未传，尝试从上下文元数据中获取

**验证**：在 Agent 对话中让 AI 调用 `db_table_info`，确认返回表结构

**涉及文件**：
- `mona/agent/tools/database.py`（修改）

### Step 4: db_server_status 工具

**目标**：实现 `db_server_status` 工具，AI 可获取服务器状态

**任务**：
1. 在 `database.py` 中实现 `DbServerStatusTool`：
   - 无必填参数
   - 调用 `_tauri_invoke("db_get_server_stats", { connectionId })`
   - 返回格式化的服务器状态（连接数、QPS、慢查询、版本等）
2. 额外查询 `SHOW STATUS` 和 `SHOW VARIABLES` 中的关键指标（如果 `db_get_server_stats` 不够全面）

**验证**：在 Agent 对话中让 AI 调用 `db_server_status`，确认返回状态信息

**涉及文件**：
- `mona/agent/tools/database.py`（修改）

## Phase 2: 前端 UI 层

### Step 5: 上下文传递机制

**目标**：前端发送 prompt 时自动附加数据库上下文

**任务**：
1. 在 `DbAgentPanel.tsx` 中新增 `buildContextPrefix()` 函数：
   - 从 `useDbStore` 读取 `activeTab.connectionId`、`activeTab.database`、`activeTab.title`、`activeTab.result?.message`
   - 构造 `[DB_CONTEXT]...[/DB_CONTEXT]` 块
2. 修改 `sendPromptToAgent`，在发送前自动附加上下文前缀
3. 确认 Agent 的 `RequestContext.metadata` 能接收到这些信息（可能需要查看 WebSocket 消息格式）

**验证**：在 Agent 对话中发送消息，确认 AI 能识别上下文

**涉及文件**：
- `webui/src/components/db/DbAgentPanel.tsx`（修改）

### Step 6: 6 个快捷按钮

**目标**：将现有 3 个按钮替换为 2 行 6 个按钮

**任务**：
1. 修改 `DbAgentPanel.tsx` 中快捷按钮区域：
   - 从 `grid-cols-3` 单行改为两行 `grid-cols-3`
   - 替换按钮：优化建议/生成SQL/解释表 → 执行计划/索引诊断/数据画像/诊断错误/一键巡检/优化建议
   - 更新图标：Zap/ListTree/BarChart3/AlertTriangle/Shield/Wrench
   - 更新 prompt 模板（参考设计文档）
2. 各按钮的禁用条件：
   - 执行计划/索引诊断/数据画像/优化建议：需要 `activeTab?.tableInfo` 存在
   - 诊断错误：需要 `activeTab?.result?.message` 包含错误关键词
   - 一键巡检：需要 `activeTab?.connectionId` 存在

**验证**：点击每个按钮，确认发送正确的 prompt

**涉及文件**：
- `webui/src/components/db/DbAgentPanel.tsx`（修改）

### Step 7: NL2SQL 输入框

**目标**：新增自然语言转 SQL 输入框

**任务**：
1. 在 `DbAgentPanel.tsx` 中新增 NL2SQL 输入框：
   - 位于快捷按钮和对话输入框之间
   - 单行输入，placeholder `用中文描述你想查的数据...`
   - 生成按钮 `⚡生成`
2. 新增 `nlQuery` state 和 `handleNlToSql` 回调
3. `handleNlToSql` 构造 NL2SQL prompt：
   - 包含当前表结构（从 `activeTab?.tableInfo` 提取列名和类型）
   - 包含用户输入的自然语言
   - 指示 AI 只输出 SQL
4. 发送给 Agent，等待返回

**验证**：输入自然语言，确认 AI 返回 SQL

**涉及文件**：
- `webui/src/components/db/DbAgentPanel.tsx`（修改）

### Step 8: SQL 提取与填入

**目标**：AI 返回 SQL 后，自动填入 SQL 编辑器

**任务**：
1. 在 `dbStore.ts` 中确认 `updateTabSql` 方法存在
2. 在 `DbAgentPanel.tsx` 中监听 AI 返回的消息：
   - 如果是 NL2SQL 触发的对话，检测 AI 回复中的 SQL
   - SQL 提取逻辑：
     a. 尝试提取 ```sql ... ``` 代码块
     b. 尝试匹配以 SELECT/INSERT/UPDATE/DELETE/WITH 开头的语句
     c. 如果提取成功，调用 `updateTabSql(tabId, sql)` 填入编辑器
     d. 如果提取失败，作为普通对话消息显示
3. 添加一个 `pendingNlToSql` ref 标记当前对话是否为 NL2SQL 触发

**验证**：输入自然语言 → AI 返回 SQL → 自动填入编辑器 → 手动执行

**涉及文件**：
- `webui/src/components/db/DbAgentPanel.tsx`（修改）
- `webui/src/components/db/store/dbStore.ts`（确认/修改）

## Phase 3: 集成验证

### Step 9: 端到端测试 + 修复

**目标**：验证所有功能端到端工作

**任务**：
1. 连接 MySQL 数据库
2. 选中一张表，依次点击 6 个快捷按钮，验证：
   - AI 能调用 `db_table_info`/`db_query`/`db_server_status`
   - 返回的分析结果准确
3. 测试 NL2SQL：
   - 输入自然语言 → AI 生成 SQL → 填入编辑器 → 执行成功
4. 测试诊断错误：
   - 执行一条错误 SQL → 点击诊断错误 → AI 分析原因
5. 测试安全边界：
   - 确认 `db_query` 拒绝 DDL/DML
   - 确认 NL2SQL 不自动执行
6. 修复发现的问题

**验证**：所有功能正常工作

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| `_tauri_invoke` 不能直接调用 db 命令 | Step 1 先验证，必要时实现通用 IPC 桥接 |
| AI 返回的 SQL 格式不统一 | SQL 提取逻辑覆盖多种格式，兜底显示原文 |
| `db_query` 安全检查被绕过 | 白名单机制（只允许 SELECT/SHOW/DESCRIBE/EXPLAIN/WITH），非白名单直接拒绝 |
| 上下文信息过长撑爆 token | 限制表结构信息只传列名+类型，不传 DDL 原文 |
| Agent 工具无法获取 connection_id | 在 `set_context` 中从 `RequestContext.metadata` 提取，前端确保传入 |
