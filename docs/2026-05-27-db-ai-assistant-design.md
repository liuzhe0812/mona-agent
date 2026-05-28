# 数据库 AI 助手运维功能设计

## 概述

为数据库客户端的 AI 助手面板增加运维能力，包括 6 个快捷功能按钮、自然语言转 SQL 输入框，以及 3 个 Agent 数据库工具。AI 可以直接查询用户连接的数据库，实现智能诊断、索引分析、数据画像、错误诊断、一键巡检、优化建议等运维场景。

## 现状分析

### 已有基础设施

| 组件 | 位置 | 状态 |
|------|------|------|
| `DbAgentPanel` | `webui/src/components/db/DbAgentPanel.tsx` | 已实现，3 个快捷按钮（优化建议、生成SQL、解释表）+ 对话输入框 |
| `useMonaStream` | `webui/hooks/useMonaStream.ts` | 已实现，WebSocket 流式对话 |
| `Tool` 基类 | `mona/agent/tools/base.py` | 已实现，`@tool_parameters` 装饰器 + `ToolRegistry` |
| `ToolLoader` | `mona/agent/tools/loader.py` | 已实现，自动发现 `mona/agent/tools/` 下的工具模块 |
| `_tauri_invoke` | `mona/agent/tools/terminal.py` | 已实现，Python → Rust Tauri Command 通信桥 |
| `db_execute_query` | `src-tauri/src/db/commands.rs` | 已实现，执行 SQL 查询 |
| `db_get_table_info` | `src-tauri/src/db/commands.rs` | 已实现，获取表结构 |
| `db_get_server_stats` | `src-tauri/src/db/commands.rs` | 已实现，获取服务器状态 |
| `db_get_processes` | `src-tauri/src/db/commands.rs` | 已实现，获取进程列表 |

### 当前问题

1. AI 助手只能纯文本对话，无法访问数据库实时数据
2. 快捷按钮只传 prompt 文本，AI 无法获取表结构、查询结果等上下文
3. 没有 NL2SQL 功能，用户需要自己写 SQL

## 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────┐
│  前端 DbAgentPanel                                   │
│                                                      │
│  快捷按钮（2行6个）:                                  │
│  [执行计划] [索引诊断] [数据画像]                      │
│  [诊断错误] [一键巡检] [优化建议]                      │
│                                                      │
│  NL2SQL 输入框:  🔍 用中文描述...  [⚡生成]            │
│  对话输入框:     问数据库相关问题...  [发送]            │
└──────────┬──────────────────────────────────────────┘
           │ WebSocket
           ▼
┌─────────────────────────────────────────────────────┐
│  Mona Agent (Python)                                 │
│                                                      │
│  新增 3 个工具:                                       │
│  - db_query: 执行 SQL 查询                            │
│  - db_table_info: 获取表结构                          │
│  - db_server_status: 获取服务器状态                    │
│                                                      │
│  通过 _tauri_invoke 调用 Tauri 后端命令               │
└──────────┬──────────────────────────────────────────┘
           │ _tauri_invoke (IPC)
           ▼
┌─────────────────────────────────────────────────────┐
│  Tauri Backend (Rust)                                │
│  复用已有: db_execute_query, db_get_table_info, etc.  │
└─────────────────────────────────────────────────────┘
```

### 通信路径

Agent 工具通过 `_tauri_invoke` 调用 Tauri 后端命令，与 `terminal.py` 中已有的模式一致：

```python
# _tauri_invoke 已在 terminal.py 中实现
# 通过 Tauri 的 sidecar IPC 机制调用 Rust 命令
result = await _tauri_invoke("db_execute_query", {
    "connectionId": connection_id,
    "sql": sql,
    "limit": 100,
    "database": database,
})
```

### 上下文传递

前端在发送 prompt 时，将当前数据库上下文作为结构化前缀嵌入：

```
[DB_CONTEXT]
connection_id: abc123
database: myapp_prod
table: users
error: (如有执行错误)
[/DB_CONTEXT]

用户的问题或指令...
```

Agent 解析 `[DB_CONTEXT]` 块，提取 `connection_id`、`database`、`table` 等信息，在调用 `db_query` 等工具时自动带上。

## 快捷按钮设计

### 布局

```
┌──────────┐ ┌──────────┐ ┌──────────┐
│  执行计划  │ │  索引诊断  │ │  数据画像  │   ← 第一行（围绕当前表）
└──────────┘ └──────────┘ └──────────┘
┌──────────┐ ┌──────────┐ ┌──────────┐
│  诊断错误  │ │  一键巡检  │ │  优化建议  │   ← 第二行（围绕当前操作）
└──────────┘ └──────────┘ └──────────┘
```

### 按钮详细定义

| 按钮 | 图标 | Prompt 模板 | AI 行为 |
|------|------|------------|---------|
| 执行计划 | `Zap` | 分析表 {table} 的查询性能。调用 db_table_info 获取表结构，然后构造典型查询做 EXPLAIN 分析，指出全表扫描、文件排序、临时表等性能问题 | `db_table_info` → 构造 `EXPLAIN` → `db_query` → 分析 |
| 索引诊断 | `ListTree` | 诊断表 {table} 的索引状况。调用 db_table_info 获取索引定义，调用 db_query 查询索引使用统计，找出冗余索引和缺失索引 | `db_table_info` → 查 `information_schema.STATISTICS` → 分析 |
| 数据画像 | `BarChart3` | 为表 {table} 生成数据画像。调用 db_table_info 获取结构，调用 db_query 统计行数、空值率、枚举分布等 | `db_table_info` → 构造统计 SQL → `db_query` → 汇总 |
| 诊断错误 | `AlertTriangle` | SQL 执行报错：{error}。请调用 db_table_info 获取相关表结构，分析错误原因并给出修复 SQL | `db_table_info` → 分析错误 → 给出修复 SQL |
| 一键巡检 | `Shield` | 对当前数据库实例做健康巡检。调用 db_server_status 获取状态，调用 db_query 查询关键指标，生成巡检报告 | `db_server_status` → 查 `SHOW STATUS` → 汇总报告 |
| 优化建议 | `Wrench` | 分析表 {table} 的整体优化建议。调用 db_table_info 获取表结构和索引，调用 db_query 查询数据量和碎片率，给出优化建议 | `db_table_info` + `db_query` → 综合分析 |

### 按钮禁用条件

- **执行计划 / 索引诊断 / 数据画像 / 优化建议**：需要选中了表（`activeTab?.tableInfo` 存在）
- **诊断错误**：需要当前查询有错误（`activeTab?.result?.message` 包含错误信息）
- **一键巡检**：需要已连接数据库（`activeTab?.connectionId` 存在）

## NL2SQL 输入框设计

### 交互流程

```
用户输入: "查询最近7天注册的用户"
     │
     ▼
前端构造 prompt:
  "根据以下表结构，将用户的自然语言查询转为 SQL。
   数据库: myapp_prod
   表: users (id BIGINT PK, name VARCHAR(100), email VARCHAR(255),
         created_at DATETIME, status ENUM('active','inactive'))
   用户查询: 查询最近7天注册的用户
   只输出一条 SQL 语句，不要解释。"
     │
     ▼
AI 返回: "SELECT * FROM `myapp_prod`.`users`
         WHERE `created_at` >= DATE_SUB(NOW(), INTERVAL 7 DAY)"
     │
     ▼
前端: 自动填入 SQL 编辑器（不自动执行）
```

### UI 设计

在原有对话输入框上方新增 NL2SQL 专用输入框：

```
┌────────────────────────────────────────────┐
│ 🔍 用中文描述你想查的数据...        [⚡生成] │  ← NL2SQL
├────────────────────────────────────────────┤
│ 问数据库相关问题...                [发送]    │  ← 对话
└────────────────────────────────────────────┘
```

- NL2SQL 输入框：单行，placeholder `用中文描述你想查的数据...`
- 生成按钮：`⚡生成`，点击后发送 prompt
- AI 返回 SQL 后，前端提取 SQL 部分，调用 `updateTabSql(tabId, sql)` 填入编辑器
- 不自动执行，用户确认后手动点执行

### SQL 提取逻辑

AI 返回的内容可能包含解释文字，前端需要提取 SQL：

1. 如果返回内容被 ```sql ... ``` 包裹，提取代码块内容
2. 如果返回内容以 `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`WITH` 开头，直接使用
3. 否则，作为普通对话消息显示

## Agent 工具设计

### 工具 1：db_query

```python
@tool_parameters({
    "type": "object",
    "properties": {
        "sql": {
            "type": "string",
            "description": "要执行的 SQL 语句（仅支持 SELECT/SHOW/DESCRIBE/EXPLAIN）",
        },
        "database": {
            "type": "string",
            "description": "目标数据库（可选，默认使用当前数据库）",
        },
    },
    "required": ["sql"],
})
class DbQueryTool(Tool):
    name = "db_query"
    description = "在用户当前连接的数据库上执行只读 SQL 查询"
    read_only = True
```

安全约束：
- 仅允许 `SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN`/`WITH` 开头的语句
- 强制 `LIMIT 100`（如果 SQL 不含 LIMIT）
- 30 秒超时
- 使用前端传入的 `connection_id`，不能访问其他连接

### 工具 2：db_table_info

```python
@tool_parameters({
    "type": "object",
    "properties": {
        "database": {
            "type": "string",
            "description": "数据库名",
        },
        "table": {
            "type": "string",
            "description": "表名",
        },
    },
    "required": ["database", "table"],
})
class DbTableInfoTool(Tool):
    name = "db_table_info"
    description = "获取表的完整结构信息：列定义、索引、外键、DDL、行数等"
    read_only = True
```

### 工具 3：db_server_status

```python
@tool_parameters({
    "type": "object",
    "properties": {},
})
class DbServerStatusTool(Tool):
    name = "db_server_status"
    description = "获取数据库服务器状态：连接数、QPS、慢查询、主从延迟、版本等"
    read_only = True
```

### connection_id 传递机制

Agent 工具需要知道当前用户的 `connection_id`。传递路径：

1. 前端发送 prompt 时，在 `[DB_CONTEXT]` 块中包含 `connection_id`
2. Agent 的 `RequestContext.metadata` 中存储解析后的 `connection_id`
3. 工具通过 `self._connection_id` 访问（在 `set_context` 时设置）

```python
class _DbTool(Tool):
    _scopes = {"core"}

    def __init__(self) -> None:
        self._connection_id: str | None = None
        self._database: str | None = None
        self._table: str | None = None

    def set_context(self, ctx: RequestContext) -> None:
        meta = ctx.metadata or {}
        self._connection_id = meta.get("connection_id")
        self._database = meta.get("database")
        self._table = meta.get("table")
```

## 安全边界

1. **只读优先**：`db_query` 默认只允许 SELECT/SHOW/DESCRIBE/EXPLAIN，拒绝 DDL/DML
2. **结果行数限制**：强制 LIMIT 100，防止返回过多数据撑爆上下文
3. **连接隔离**：Agent 只能使用前端传入的 connection_id，不能访问其他连接
4. **超时控制**：30 秒超时，防止长时间查询阻塞
5. **不自动执行**：NL2SQL 生成的 SQL 只填入编辑器，不自动执行
6. **错误处理**：工具执行失败时返回错误信息，AI 据此调整策略

## 涉及文件

### 新增文件

| 文件 | 说明 |
|------|------|
| `mona/agent/tools/database.py` | 3 个数据库工具实现 |

### 修改文件

| 文件 | 说明 |
|------|------|
| `webui/src/components/db/DbAgentPanel.tsx` | 6 个快捷按钮 + NL2SQL 输入框 |
| `webui/src/components/db/store/dbStore.ts` | 新增 `updateTabSql` 方法（NL2SQL 填入 SQL） |
