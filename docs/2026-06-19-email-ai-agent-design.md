# AI 邮件智能体设计方案

> **定位**：将邮件从"被动收件箱"升级为"主动知识引擎"。AI Agent 不仅是辅助工具，而是邮件的理解者、组织者和行动者。

---

## 一、设计理念

### 核心问题

当前邮件模块是传统收件箱：邮件按时间排列，用户手动分类、手动搜索、手动回复。10 个目标功能（摘要、智能回复、自动分类、任务提取、项目关联、跟进提醒、日报周报、跨邮件搜索、自动化工作流、知识图谱）如果逐个单点实现，会产生：

- 重复的邮件内容理解逻辑（摘要要读邮件、分类要读邮件、任务提取也要读邮件）
- 割裂的数据模型（任务存在任务表、项目存在项目表、摘要存在摘要表，互相不关联）
- 无法组合（"找出项目A中所有未完成的任务相关邮件"需要跨表查询）

### 解决思路：流水线预处理 + 最小工具集

```
┌─────────────────────────────────────────────────────────────┐
│                    用户功能层（10 个功能）                      │
│  摘要回复 │ 分类归档 │ 任务提取 │ 项目关联 │ 跟进提醒          │
│  日报周报 │ 智能搜索 │ 自动化   │ 知识图谱 │ 自然语言操作       │
├─────────────────────────────────────────────────────────────┤
│                    Agent 工具层（仅 4 个）                     │
│  email_search │ email_read │ email_send │ email_action      │
├─────────────────────────────────────────────────────────────┤
│                    邮件智能基础设施                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ 处理流水线 │  │ 结构化存储 │  │ 调度引擎  │                  │
│  │ Pipeline  │  │ SQLite   │  │ Scheduler│                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

### 两个关键设计决策

**决策一：Agent 工具最小化**

Agent 的能力来自 LLM 推理组合，不是工具数量。如同文件操作只需 `read_file` + `write_file`，邮件操作也只需 4 个原子工具：

| 工具 | 职责 | 为什么不能再少 |
|------|------|---------------|
| `email_search` | 搜索邮件 | Agent 需要找到相关邮件 |
| `email_read` | 读取邮件全文 + AI 分析 | Agent 需要理解邮件内容 |
| `email_send` | 发送/回复/转发邮件 | Agent 需要能输出邮件 |
| `email_action` | 移动/标记/删除邮件 | Agent 需要能操作邮件 |

所有高级功能都是这 4 个工具的组合：
- 摘要 = `email_read` → LLM 自己总结
- 报告 = `email_search` + `email_read` → LLM 汇总
- 知识查询 = `email_search` + `email_read` → LLM 回答
- 批量归档 = `email_search` + `email_action`

**决策二：不做邮件知识库，用 AI 搜索 + 阅读代替**

邮件是结构化数据（发件人、日期、主题、正文），SQL 搜索 + AI 阅读就足够。不需要预先向量化存储：

| 方案 | 邮件知识库（废弃） | AI 搜索 + 阅读（采用） |
|------|-------------------|----------------------|
| 预处理 | 每封邮件向量化存储 | 只做 AI 分析，不向量化 |
| 查询 | 向量相似度搜索 | SQL 全文 + 元数据筛选 |
| 回答 | 从向量库提取 | AI 读搜索结果回答 |
| 存储 | 额外向量表 | 无额外存储 |
| 维护 | 需同步向量 | 无维护成本 |
| 适用 | 非结构化文本 | 结构化邮件数据 |

用户问"张总的邮箱是多少"→ `email_search(from="张总")` → `email_read` → AI 从邮件内容提取邮箱。不需要知识图谱。

**决策三：AI 不默认介入邮箱，所有功能必须用户主动触发**

这是最重要的产品原则。邮箱是用户的私密空间，AI 不能擅自读取、分析、移动邮件。每个功能必须明确触发模式：

| 触发模式 | 含义 | 适用场景 |
|---------|------|---------|
| **开关（默认关闭）** | 用户主动开启后，AI 在特定条件下自动执行。关闭后完全不介入 | 只读分析类、提醒类 |
| **人工单次触发** | 用户每次主动点击/输入才执行，AI 不自动启动 | 生成类、操作类、查询类 |
| **禁止 AI 自动执行** | 即使开关开启，也必须人工确认 | 不可逆操作（移动、删除、发送） |

各功能触发模式：

| 功能 | 触发模式 | 说明 |
|------|---------|------|
| 邮件 AI 分析（摘要/分类/实体） | 开关，**默认关闭** | 涉及 LLM 成本和隐私，用户必须主动开启后才对新邮件自动分析 |
| 分类标签显示 | 依赖 AI 分析开关 | 只读展示，无破坏性 |
| 自动归档/移动邮件 | **禁止 AI 自动执行** | 不可逆操作，只能人工拖拽或用户明确配置规则后执行 |
| 自动标记已读 | **禁止 AI 自动执行** | 同上 |
| 任务提取 | 人工单次触发 | 用户点击"提取任务"按钮才执行 |
| 项目关联 | 人工单次触发 | 用户右键"关联到项目"才执行 |
| 跟进提醒检测 | 开关，**默认关闭** | 用户开启后才定时检测 |
| 智能回复生成 | 人工单次触发 | 用户点击"生成回复"才调用 LLM |
| 日报/周报 | 开关，**默认关闭** | 用户开启定时或手动触发 |
| 自然语言搜索/操作 | 人工单次触发 | 用户在 AI 面板输入才执行 |
| 知识查询 | 人工单次触发 | 用户提问才查询 |
| 自动化工作流 | 开关，**默认关闭** | 用户明确配置规则并开启后才生效 |

**红线**：
- AI 永远不会在用户不知情的情况下读取邮件内容发送给 LLM
- AI 永远不会自动移动、删除、发送邮件
- 所有开关默认关闭，用户必须主动开启
- 开关开启时，UI 上要有明显标识（如"AI 分析已开启"）

---

## 二、核心数据模型

### 2.1 扩展 SQLite 表结构

在现有 `email.sqlite3` 中新增以下表，与 `messages` 表通过 `(uid, account_id, folder)` 关联。

#### email_ai_analysis — AI 分析结果表

每封邮件一条记录，存储流水线的全部产出。

```sql
CREATE TABLE IF NOT EXISTS email_ai_analysis (
    uid TEXT NOT NULL,
    account_id TEXT NOT NULL,
    folder TEXT NOT NULL,
    -- 摘要
    summary TEXT,                    -- 3 句话摘要
    -- 分类
    category TEXT,                   -- AI 分类：work/personal/finance/notification/marketing/social
    category_confidence REAL,        -- 分类置信度 0-1
    suggested_folder TEXT,           -- 建议归档文件夹
    -- 意图
    intent TEXT,                     -- needs_reply/needs_action/notify_only/needs_approval/spam
    urgency TEXT,                    -- high/normal/low
    -- 情绪
    sentiment TEXT,                  -- positive/neutral/negative
    -- 关键信息（JSON）
    key_info TEXT,                   -- {"dates":[],"amounts":[],"links":[],"deadlines":[]}
    -- 处理状态
    processed_at TEXT,               -- 处理时间
    model_version TEXT,              -- 处理时使用的模型版本
    PRIMARY KEY (uid, account_id, folder)
);
```

#### email_entities — 实体表

从邮件中提取的结构化实体，用于 SQL 筛选和项目匹配。

```sql
CREATE TABLE IF NOT EXISTS email_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,
    account_id TEXT NOT NULL,
    folder TEXT NOT NULL,
    entity_type TEXT NOT NULL,       -- person/project/date/amount/task/deadline/link/file
    entity_value TEXT NOT NULL,      -- 实体值
    entity_label TEXT,               -- 显示名（如人名、项目名）
    context TEXT,                    -- 出现的上下文片段
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_type_value ON email_entities(entity_type, entity_value);
CREATE INDEX IF NOT EXISTS idx_entities_account ON email_entities(account_id);
```

#### email_tasks — 任务表

从邮件中提取的待办事项。

```sql
CREATE TABLE IF NOT EXISTS email_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,
    account_id TEXT NOT NULL,
    folder TEXT NOT NULL,
    title TEXT NOT NULL,             -- 任务标题
    description TEXT,                -- 任务描述
    assignee TEXT,                   -- 负责人（邮箱）
    due_date TEXT,                   -- 截止日期
    status TEXT DEFAULT 'pending',   -- pending/in_progress/completed/cancelled
    priority TEXT DEFAULT 'normal',  -- high/normal/low
    project_id TEXT,                 -- 关联项目
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON email_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON email_tasks(due_date);
```

#### email_projects — 项目表

AI 自动识别或用户创建的项目。

```sql
CREATE TABLE IF NOT EXISTS email_projects (
    id TEXT PRIMARY KEY,             -- UUID
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    keywords TEXT,                   -- 关联关键词（JSON 数组），用于自动匹配
    color TEXT,                      -- 显示颜色
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

#### email_project_links — 邮件-项目关联表

```sql
CREATE TABLE IF NOT EXISTS email_project_links (
    project_id TEXT NOT NULL,
    uid TEXT NOT NULL,
    account_id TEXT NOT NULL,
    folder TEXT NOT NULL,
    relevance REAL DEFAULT 1.0,      -- 关联度 0-1
    matched_by TEXT,                 -- keyword/ai/manual
    PRIMARY KEY (project_id, uid, account_id, folder)
);
```

#### email_followups — 跟进记录表

```sql
CREATE TABLE IF NOT EXISTS email_followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,
    account_id TEXT NOT NULL,
    folder TEXT NOT NULL,
    followup_type TEXT NOT NULL,     -- awaiting_reply/scheduled_reminder/deadline
    remind_at TEXT,                  -- 提醒时间
    status TEXT DEFAULT 'active',    -- active/dismissed/triggered
    note TEXT,
    created_at TEXT NOT NULL
);
```

### 2.2 数据流转关系

```
邮件同步 → messages 表（原始数据）
              ↓
         处理流水线
              ↓
    ┌─────────┼─────────┬──────────┐
    ↓         ↓         ↓          ↓
 email_ai   entities  tasks   followups
_analysis                     (按需创建)
              ↓
         project_links（实体匹配后关联项目）
```

注意：**不向量化**。搜索时用 SQL 全文搜索 + 实体筛选，AI 阅读搜索结果回答问题。

---

## 三、邮件智能处理流水线

### 3.1 流水线设计

每封新邮件同步到本地后，触发一次流水线处理。一次 LLM 调用产出全部分析结果。

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  触发器   │ →  │ 内容预处理 │ →  │ AI 分析   │ →  │ 后处理    │
│ Trigger  │    │ Preprocess│    │ Analyze  │    │ Post     │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                                     ↓               ↓
                               ┌─────────────────────────────┐
                               │       存储层（SQLite）        │
                               │  ai_analysis + entities      │
                               └─────────────────────────────┘
                                     ↓
                    ┌────────────────┼────────────────┐
                    ↓                ↓                ↓
              ┌──────────┐    ┌──────────┐    ┌──────────┐
              │ 项目匹配   │    │ 任务创建   │    │ 跟进检测   │
              │ Match    │    │ Task     │    │ Followup │
              └──────────┘    └──────────┘    └──────────┘
```

### 3.2 触发机制

**前提条件**：流水线只在用户开启"AI 分析"开关后才会运行。开关关闭时，不触发任何处理，邮件只做正常收发存储。

**不阻塞同步流程**。邮件同步完成后，异步触发流水线：

```python
# mona/email_intel/pipeline.py

async def on_email_synced(account_id: str, new_uids: list[str]):
    """邮件同步完成后异步触发，不阻塞 UI"""
    for uid in new_uids:
        await _queue.put((account_id, uid))
```

触发时机：
- **首次同步**：批量处理，限制并发为 2（避免 API 限流）
- **增量同步**：只处理新增的 UID
- **手动触发**：用户可对单封邮件重新分析
- **定时补全**：每小时检查是否有漏处理的邮件

### 3.3 内容预处理

```python
def preprocess(message: EmailMessage) -> ProcessedContent:
    """提取纯文本，清理引用、签名、HTML 标签"""
    # 1. 优先用 body_text，无则从 body_html 转换
    # 2. 移除引用链（> 开头的行）
    # 3. 移除签名（-- 分隔符之后）
    # 4. 移除邮件客户端自动添加的脚注
    # 5. 保留邮件头信息（发件人、日期、主题）作为上下文
```

### 3.4 AI 分析（单次调用，多产出）

**关键设计：一次 LLM 调用产出全部分析结果**，而非每封邮件调 5 次。

```python
ANALYSIS_PROMPT = """你是一个邮件分析助手。请分析以下邮件并返回 JSON：

邮件主题：{subject}
发件人：{from}
日期：{date}
正文：
{body}

请返回以下 JSON 结构（不要包含其他内容）：
{
  "summary": "3句话摘要",
  "category": "work|personal|finance|notification|marketing|social",
  "intent": "needs_reply|needs_action|notify_only|needs_approval|spam",
  "urgency": "high|normal|low",
  "sentiment": "positive|neutral|negative",
  "key_info": {
    "dates": [{"date": "ISO格式", "description": "什么日期"}],
    "amounts": [{"value": "金额", "currency": "币种", "context": "上下文"}],
    "deadlines": [{"date": "ISO格式", "task": "什么任务"}],
    "links": [{"url": "链接", "description": "描述"}]
  },
  "entities": [
    {"type": "person", "value": "邮箱或姓名", "label": "显示名"},
    {"type": "project", "value": "项目名", "label": "项目名"},
    {"type": "task", "value": "任务描述", "label": "简短标题"}
  ],
  "suggested_reply": "如果是 needs_reply，提供一句话回复建议",
  "suggested_folder": "建议归档的文件夹名"
}
"""
```

**模型选择**：使用用户配置的主模型（支持 JSON mode 的模型优先）。对于简单邮件，可用轻量模型降低成本。

### 3.5 后处理

AI 分析返回后，将结果拆分存储到各表：

```python
async def post_process(message, analysis_result):
    # 1. 存入 email_ai_analysis
    save_analysis(message.uid, analysis_result)

    # 2. 拆分实体存入 email_entities
    for entity in analysis_result.entities:
        save_entity(message.uid, entity)

    # 3. 从 entities 中 type=task 的创建任务
    for entity in analysis_result.entities:
        if entity.type == "task":
            create_task(message.uid, entity)

    # 4. 项目匹配
    match_projects(message, analysis_result.entities)

    # 5. 跟进检测
    detect_followups(message, analysis_result)
```

### 3.6 项目匹配

```python
def match_projects(account_id: str, message: EmailMessage, entities: list[Entity]):
    """将邮件关联到已有项目"""
    projects = load_projects(account_id)
    for project in projects:
        score = 0
        # 关键词匹配
        for keyword in project.keywords:
            if keyword in message.subject or keyword in message.body_text:
                score += 0.5
        # 实体匹配
        for entity in entities:
            if entity.type == "project" and entity.value in project.keywords:
                score += 0.8
        if score >= 0.5:
            create_project_link(project.id, message, score, matched_by="keyword")
```

### 3.7 跟进检测

```python
def detect_followups(message: EmailMessage, analysis: AnalysisResult):
    """检测需要跟进的邮件"""
    # 1. intent == needs_reply 且用户已回复 → 创建 awaiting_reply 跟进
    #    如果 3 天后对方未回复 → 触发提醒
    # 2. key_info.deadlines 不为空 → 创建 scheduled_reminder
    #    在截止日期前 1 天提醒
    # 3. intent == needs_action → 创建 scheduled_reminder
    #    2 天后如果邮件仍为未读 → 提醒
```

---

## 四、Agent 工具层

### 4.1 设计原则

Agent 工具应该是原子化、正交、最小的。Agent 的能力来自 LLM 推理组合工具，而不是工具数量。如同文件操作只需 `read_file` + `write_file`，邮件操作只需 4 个工具。

**不做成工具的**：任务管理、项目创建、报告生成、知识查询——这些要么是流水线自动完成的，要么是 Agent 用 4 个工具组合完成的，不需要单独工具。

### 4.2 四个核心工具

```python
# mona/email_intel/tools.py

EMAIL_TOOLS = [
    {
        "name": "email_search",
        "description": "搜索邮件。支持关键词、发件人、日期范围、文件夹、AI分类、意图等条件筛选",
        "params": {
            "query": "str?",           # 关键词（搜索主题和正文）
            "from": "str?",            # 发件人筛选
            "to": "str?",              # 收件人筛选
            "date_from": "str?",       # 日期范围起（ISO格式）
            "date_to": "str?",         # 日期范围止
            "folder": "str?",          # 文件夹
            "category": "str?",        # AI 分类：work/personal/finance/notification/marketing/social
            "intent": "str?",          # AI 意图：needs_reply/needs_action/notify_only/needs_approval
            "project": "str?",         # 关联项目名
            "unread_only": "bool?",    # 仅未读
            "has_tasks": "bool?",      # 是否有提取的任务
            "limit": "int?",           # 返回数量，默认20
        },
    },
    {
        "name": "email_read",
        "description": "读取邮件全文及AI分析结果（摘要、分类、意图、关键信息、提取的任务）",
        "params": {
            "uid": "str",
            "account_id": "str?",
            "folder": "str?",
        },
    },
    {
        "name": "email_send",
        "description": "发送、回复或转发邮件。通过mode参数区分",
        "params": {
            "mode": "str",             # send/reply/reply_all/forward
            "to": "list?",             # 收件人（send模式必填）
            "cc": "list?",             # 抄送
            "subject": "str?",         # 主题（send模式必填）
            "body": "str",             # 邮件正文
            "uid": "str?",             # 回复/转发时的原邮件UID
            "account_id": "str?",
        },
    },
    {
        "name": "email_action",
        "description": "操作邮件：移动、标记已读/未读、删除。支持单封和批量",
        "params": {
            "action": "str",           # move/mark_read/mark_unread/delete
            "uids": "list",            # 邮件UID列表
            "dest_folder": "str?",     # move时的目标文件夹
            "account_id": "str?",
        },
    },
]
```

### 4.3 工具组合示例

所有高级功能都是 4 个工具的组合，LLM 自行决定调用链：

| 用户意图 | Agent 工具调用链 | 说明 |
|---------|----------------|------|
| "帮我找上个月张总发的关于预算的邮件" | `email_search(query="预算", from="张总", date_from=..., date_to=...)` | 单次搜索 |
| "总结一下这封邮件" | `email_read(uid)` → LLM 总结 | 读后总结，不需要 summarize 工具 |
| "总结项目A的邮件进展" | `email_search(project="项目A")` → `email_read(uid1)` `email_read(uid2)` ... → LLM 汇总 | 搜索+阅读+总结 |
| "帮我回复这封邮件，语气专业点" | `email_read(uid)` → LLM 生成回复 → `email_send(mode="reply", uid=..., body=...)` | 读+生成+发送 |
| "今天有什么需要处理的邮件" | `email_search(intent="needs_reply", date_from=今天)` + `email_search(intent="needs_action", date_from=今天)` → LLM 汇总 | 搜索+汇总 |
| "把这周营销邮件归档" | `email_search(category="marketing", date_from=周一)` → `email_action(action="move", uids=[...], dest_folder="营销邮件")` | 搜索+操作 |
| "张总的邮箱是多少" | `email_search(from="张总")` → `email_read(uid)` → LLM 提取邮箱 | 搜索+阅读+回答 |
| "生成今天的日报" | `email_search(date_from=昨天)` → `email_read` 多封 → LLM 生成报告 | 搜索+阅读+报告 |
| "项目A有哪些未完成任务" | `email_search(project="项目A")` → `email_read` 多封 → LLM 筛选未完成任务 | 搜索+阅读+回答 |

### 4.4 email_search 实现细节

搜索是 Agent 最核心的工具。用 SQL 实现，不需要向量：

```python
async def email_search(params: SearchParams) -> list[SearchResult]:
    """SQL 全文搜索 + 元数据筛选"""
    sql = "SELECT m.*, a.summary, a.category, a.intent, a.urgency \
           FROM messages m \
           LEFT JOIN email_ai_analysis a ON m.uid = a.uid AND m.account_id = a.account_id \
           WHERE 1=1"
    args = []

    # 关键词搜索（主题 + 正文，LIKE 匹配）
    if params.query:
        sql += " AND (m.subject LIKE ? OR m.body_text LIKE ?)"
        args.extend([f"%{params.query}%", f"%{params.query}%"])

    # 发件人筛选
    if params.from_:
        sql += " AND m.from_addr LIKE ?"
        args.append(f"%{params.from_}%")

    # 日期范围
    if params.date_from:
        sql += " AND m.date >= ?"
        args.append(params.date_from)
    if params.date_to:
        sql += " AND m.date <= ?"
        args.append(params.date_to)

    # AI 分类筛选
    if params.category:
        sql += " AND a.category = ?"
        args.append(params.category)

    # AI 意图筛选
    if params.intent:
        sql += " AND a.intent = ?"
        args.append(params.intent)

    # 项目筛选（子查询）
    if params.project:
        sql += " AND m.uid IN (SELECT uid FROM email_project_links pl \
                JOIN email_projects p ON pl.project_id = p.id \
                WHERE p.name LIKE ?)"
        args.append(f"%{params.project}%")

    # 未读筛选
    if params.unread_only:
        sql += " AND m.is_read = 0"

    sql += " ORDER BY m.date DESC LIMIT ?"
    args.append(params.limit or 20)

    results = await db.execute(sql, args)
    return [SearchResult(**r) for r in results]
```

---

## 五、功能模块详细设计

### 5.1 邮件摘要 + 智能回复

**触发模式**：
- **摘要**：开关（默认关闭）。用户在设置中开启"AI 分析"后，新邮件同步时自动生成摘要并存入 `email_ai_analysis` 表。关闭开关时不分析、不显示摘要。
- **智能回复**：人工单次触发。用户点击"生成回复"按钮才调用 LLM，不自动生成。

**数据来源**：开启 AI 分析开关后，摘要由流水线预处理存入 `email_ai_analysis` 表，AI 面板直接读取，无需实时调用 LLM。未开启开关时面板不显示摘要区域。

**UI 交互**：
```
┌─ AI 面板 ──────────────────────────┐
│ 📋 摘要                            │
│ 张总确认了项目A的预算为50万，要求    │
│ 下周五前提交详细方案。              │
│                                    │
│ 🏷️ 分类: 工作 | 紧急度: 高         │
│ 📅 关键日期: 下周五 - 提交方案      │
│ 💰 金额: 50万 CNY                  │
│                                    │
│ 💬 回复建议                        │
│ "收到，我会在下周五前提交详细方案。" │
│ [使用此回复] [重新生成]            │
│                                    │
│ ✅ 提取的任务                      │
│ • 下周五前提交项目A详细方案 [添加]  │
└────────────────────────────────────┘
```

**智能回复生成**：点击"重新生成"时实时调用 LLM，传入邮件全文 + 分析结果 + 对话历史，支持多轮调整。

### 5.2 自动分类与归档

**触发模式**：
- **分类标签**：依赖 AI 分析开关。开关开启后流水线产出 `category`，邮件列表显示分类色标。开关关闭时不分类、不显示。
- **自动归档**：**禁止 AI 自动执行**。即使开启 AI 分析，也只显示建议文件夹，不自动移动。用户必须手动拖拽或配置自动化规则（5.8 节）并明确开启后才执行。

**分类策略**：
- 流水线产出 `category` 和 `suggested_folder`（仅当 AI 分析开关开启时）
- **不自动移动邮件**，只在邮件列表显示分类标签和建议文件夹
- 自动归档必须通过自动化规则（5.8 节）由用户明确配置并开启，不属于 AI 分析的默认行为

**UI 呈现**：
- 邮件列表每行显示分类色标（左侧 3px 色条）
- 分类标签可点击筛选
- 右键菜单增加"按 AI 分类筛选"

**归档规则配置**：
```json
{
  "autoArchive": false,
  "rules": [
    {"category": "marketing", "action": "move", "folder": "营销邮件"},
    {"category": "notification", "action": "mark_read"}
  ]
}
```

### 5.3 任务自动提取

**触发模式**：人工单次触发。用户在邮件详情或 AI 面板点击"提取任务"按钮才执行，不随 AI 分析流水线自动执行。

**提取规则**：AI 从邮件正文中识别：
- 明确的行动要求（"请提交""请确认""请在X前完成"）
- 隐含的待办（"我们需要讨论""建议跟进"）
- 截止日期关联的任务

**UI 呈现**：
- 邮件正文顶部显示"提取到 N 个任务"横幅
- AI 面板显示任务列表，可编辑、添加到日历
- 独立的"任务"视图 tab，汇总所有邮件任务

### 5.4 项目关联

**触发模式**：人工单次触发。用户右键邮件 → "关联到项目" → 选择或新建项目。不自动关联。

**项目创建方式**：
- **手动创建**：用户在设置中创建项目，设置关键词
- **从邮件创建**：右键邮件 → "关联到项目" → 新建项目

**关联逻辑**（用户触发关联时执行）：
- 关键词匹配（主题、正文包含项目关键词）
- 实体匹配（AI 提取的 project 实体匹配项目名）
- 参与者匹配（同一组人讨论的邮件可能属于同一项目）

**UI 呈现**：
- 文件夹树底部增加"项目"分组
- 点击项目 → 显示该项目所有邮件的时间线视图
- 邮件正文顶部显示所属项目标签

### 5.5 智能跟进提醒

**触发模式**：开关，**默认关闭**。用户在设置中开启"跟进提醒"后，系统定时检测需要跟进的邮件。关闭时不检测、不提醒。

| 类型 | 触发条件 | 提醒时机 |
|------|---------|---------|
| awaiting_reply | 用户回复了邮件，等待对方回应 | 3 天后对方未回复 |
| deadline | 邮件中包含截止日期 | 截止前 1 天 |
| action_pending | 邮件标记为 needs_action 但未处理 | 2 天后邮件仍为未读 |
| no_response | 用户发送的邮件对方一直没回 | 5 天后 |

**提醒方式**：
- 桌面通知（复用现有 Notification API）
- AI 面板顶部显示"你有 3 封邮件需要跟进"
- 邮件列表中跟进邮件显示特殊图标

**调度实现**：复用 Mona 的 cron 服务，每小时检查一次 `email_followups` 表。

### 5.6 邮件日报/周报

**触发模式**：
- **定时生成**：开关，**默认关闭**。用户开启后，日报每天 9:00、周报每周一 9:00 自动生成。
- **手动触发**：人工单次触发。用户在 AI 面板输入"生成日报"或点击按钮。

**实现方式**：Agent 用 `email_search` + `email_read` 组合完成，不需要单独工具。

```
Agent 生成日报流程：
1. email_search(date_from=昨天, date_to=今天) → 获取昨日邮件
2. email_read 读取每封邮件的分析结果
3. email_search(intent="needs_reply", unread_only=true) → 需要回复的
4. 从 email_tasks 表查询今日待办
5. 从 email_followups 表查询待跟进
6. LLM 汇总生成自然语言报告
```

**报告内容**：

```
┌─ 📊 邮件日报 - 2026年6月19日 ──────┐
│                                    │
│ 📥 昨日收到 12 封邮件               │
│   • 需要回复: 3 封                 │
│   • 需要处理: 2 封                 │
│   • 仅通知: 7 封                   │
│                                    │
│ 🔴 重要邮件                        │
│ 1. 张总 - 项目A预算确认 (需回复)    │
│ 2. 财务部 - 6月报销截止 (有截止日期) │
│                                    │
│ ⏰ 待跟进                          │
│ • 3天前回复李四，尚未收到回应       │
│ • 项目B方案周五截止                 │
│                                    │
│ ✅ 今日待办                        │
│ • 下周五前提交项目A详细方案         │
│ • 确认6月报销单                     │
└────────────────────────────────────┘
```

### 5.7 跨邮件智能搜索

**触发模式**：人工单次触发。用户在搜索框输入关键词或在 AI 面板输入自然语言才执行。

**搜索方式**：SQL 全文搜索 + 元数据筛选，不需要向量。

**两种入口**：

1. **UI 搜索框**：邮件列表顶部搜索框，支持关键词 + 筛选条件
2. **自然语言搜索**：AI 面板输入自然语言，Agent 调用 `email_search`

**Agent 搜索流程**：
```
用户: "上个月张总发的关于预算的邮件"
  ↓ LLM 理解意图
Agent: email_search(query="预算", from="张总", date_from="2026-05-01", date_to="2026-05-31")
  ↓ 返回结果
Agent: 找到 3 封相关邮件：
  1. [项目A预算确认] - 张总 - 5月15日
  2. [预算调整通知] - 张总 - 5月20日
  3. [Re: 预算问题] - 张总 - 5月28日
```

**UI 呈现**：邮件列表顶部搜索框，输入关键词即搜。高级筛选可按发件人、日期、分类等条件。

### 5.8 邮件驱动的自动化工作流

**触发模式**：开关，**默认关闭**。用户必须明确创建规则、配置条件、开启开关后才生效。未配置规则或开关关闭时，不执行任何自动化操作。

**设计理念**：用户定义"当收到满足条件的邮件时，自动执行动作"。这是唯一允许 AI 自动执行邮件操作（如移动、标记）的途径，但前提是用户明确配置并开启。

**规则模型**：

```json
{
  "name": "发票自动处理",
  "enabled": true,
  "trigger": {
    "type": "email_received",
    "conditions": {
      "subject_contains": ["发票", "invoice"],
      "from_contains": ["finance", "财务"]
    }
  },
  "actions": [
    {"type": "extract_task", "assignee": "me"},
    {"type": "move_to_folder", "folder": "财务"},
    {"type": "notify", "message": "收到新发票邮件"}
  ]
}
```

**实现方式**：
- 规则存储在 SQLite 配置表中
- 邮件同步后，流水线处理前先过规则引擎
- 动作通过代码函数执行（移动、标记、通知）
- 复杂条件可调用 AI 判断（如"如果邮件语气紧急则通知"）

**预设规则模板**：
- 发票邮件 → 提取金额 + 归档 + 通知
- 会议邀请 → 提取时间 + 创建任务
- 简历邮件 → AI 分析匹配度 + 归档到招聘文件夹
- 营销邮件 → 自动标为已读

### 5.9 邮件知识查询（替代知识图谱）

**触发模式**：人工单次触发。用户在 AI 面板提问才执行，不主动推送知识。

**设计理念**：不构建显式知识图谱，AI 通过搜索 + 阅读回答知识性问题。

**查询方式**：用户在 AI 面板自然语言提问，Agent 用 `email_search` + `email_read` 回答。

**场景示例**：

```
用户: 张总参与了哪些项目？
Agent: 
  → email_search(from="张总")  // 找到张总的所有邮件
  → email_read 读取分析结果    // 读取每封邮件的实体和分类
  → LLM 汇总：张总参与了项目A（预算确认）、项目B（方案讨论）

用户: 项目A的预算是多少？
Agent:
  → email_search(query="项目A 预算")  // 搜索相关邮件
  → email_read 读取邮件全文           // 读取包含预算信息的邮件
  → LLM 提取：项目A预算为50万，张总在5月15日邮件中确认

用户: 谁和我通信最频繁？
Agent:
  → email_search(date_from=最近30天)  // 搜索近期邮件
  → LLM 统计发件人频率：张总(23封)、李四(15封)、财务部(8封)

用户: 上个月提到过哪些金额？
Agent:
  → email_search(date_from=上月初, date_to=上月末)
  → email_read 读取分析结果的 key_info
  → LLM 汇总：5月提到的金额：项目A预算50万、设备采购12万、差旅报销3000元
```

**优势**：不需要维护图谱节点和边，不需要预处理图谱关系。AI 直接从邮件内容回答，永远是最新的。

### 5.10 自然语言操作邮件

**触发模式**：人工单次触发。用户在 AI 面板输入指令才执行，Agent 不主动操作邮件。

**入口**：AI 面板的对话输入框。

**实现**：复用 Mona 现有 Agent 架构，注册 4 个邮件工具。Agent 根据用户意图自动选择工具组合。

**场景示例**：

```
用户: 帮我整理一下这周的邮件
Agent: 我来帮你整理。先搜索本周邮件...
  → email_search(date_from=周一)
Agent: 找到 23 封邮件。按分类整理：
  • 工作: 12 封（3 封需要回复）
  • 通知: 7 封
  • 营销: 4 封
  要我把营销邮件归档吗？

用户: 好，另外帮我回复张总那封
Agent: 好的。先归档营销邮件...
  → email_search(category="marketing", date_from=周一)
  → email_action(action="move", uids=[...], dest_folder="营销邮件")
Agent: 已归档 4 封营销邮件。
  现在回复张总。先读一下他的邮件...
  → email_search(from="张总", intent="needs_reply")
  → email_read(uid=...)
Agent: 张总的邮件是关于项目A预算确认的，
  建议回复："收到，我会在下周五前提交详细方案。"
  要使用这个回复吗？

用户: 可以，再加一句下周二给他更新进度
Agent: 好的，发送回复...
  → email_send(mode="reply", uid="xxx", body="收到，我会在下周五前提交详细方案。另外，我会在下周二给您更新进度。")
Agent: 已回复张总。
```

---

## 六、实施路径

### 6.1 分期规划

```
Phase 1 (基础层)          Phase 2 (核心功能)        Phase 3 (高级功能)
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│ 处理流水线    │         │ 智能搜索     │         │ 自动化工作流  │
│ 数据模型      │         │ 任务提取     │         │ 日报周报     │
│ 4个Agent工具  │         │ 项目关联     │         │ 知识查询     │
│ 摘要 + 回复   │         │ 跟进提醒     │         │              │
│ 自动分类      │         │ 自然语言操作  │         │              │
└──────────────┘         └──────────────┘         └──────────────┘
```

### 6.2 Phase 1：基础层 + 摘要回复（最高优先级）

**目标**：建立基础设施，实现用户感知最强的摘要和回复功能。

**任务清单**：

| # | 任务 | 文件 | 说明 |
|---|------|------|------|
| 1 | 创建 email_intel 模块 | `mona/email_intel/` | 流水线、工具、调度 |
| 2 | 数据模型迁移 | `src-tauri/src/email.rs` | 新增 6 张表 |
| 3 | 处理流水线 | `mona/email_intel/pipeline.py` | 预处理 → AI 分析 → 后处理 |
| 4 | Agent 工具注册 | `mona/email_intel/tools.py` | 注册 4 个工具 |
| 5 | 摘要 UI | `webui/src/components/email/MailAgentPanel.tsx` | 显示摘要、分类、关键信息 |
| 6 | 智能回复 | `webui/src/components/email/MailAgentPanel.tsx` | 回复建议 + 多轮调整 |
| 7 | 流水线触发 | `mona/email_intel/trigger.py` | 同步后异步触发 |
| 8 | 分类标签 UI | `webui/src/components/email/MailListView.tsx` | 邮件列表显示分类色标 |

### 6.3 Phase 2：核心功能

| # | 任务 | 依赖 |
|---|------|------|
| 1 | 跨邮件智能搜索 | Phase 1 流水线（AI 分析结果用于筛选） |
| 2 | 任务提取与管理 | Phase 1 实体提取 |
| 3 | 项目关联 | Phase 1 实体提取 |
| 4 | 跟进提醒 | Phase 1 意图分析 |
| 5 | 自然语言操作 | Phase 1 Agent 工具 |

### 6.4 Phase 3：高级功能

| # | 任务 | 依赖 |
|---|------|------|
| 1 | 自动化工作流 | Phase 2 全部 |
| 2 | 日报周报 | Phase 2 任务 + 跟进 |
| 3 | 知识查询 | Phase 2 搜索 + 项目 |

---

## 七、技术选型与约束

### 7.1 复用现有基础设施

| 能力 | 复用模块 | 说明 |
|------|---------|------|
| Agent 工具系统 | `mona/agent/tools/` | 注册 4 个邮件工具 |
| LLM 调用 | `mona/providers/` | 复用用户配置的模型 |
| 定时调度 | `mona/cron/` | 跟进提醒、日报生成 |
| 桌面通知 | `Notification API` | 新邮件、跟进提醒 |
| SQLite | `src-tauri/src/email.rs` | 扩展现有表结构 |
| 邮件收发 | 现有邮件模块 | `email_send` 工具封装现有发送逻辑 |

### 7.2 性能约束

- **流水线并发**：限制 2 个并发处理，避免 API 限流
- **增量处理**：只处理新增邮件，不重复处理
- **懒加载**：AI 面板摘要按需加载，不预加载所有邮件
- **搜索限制**：SQL 搜索限制 top 50，避免返回过多结果

### 7.3 隐私与安全

- 邮件内容发送到 LLM 时，不发送附件内容
- 所有数据存储在本地 SQLite，不上传云端
- 用户可选择关闭 AI 分析（纯本地模式）
- 敏感信息（密码、token）不进入分析

### 7.4 降级策略

| 场景 | 降级方案 |
|------|---------|
| LLM 不可用 | 跳过 AI 分析，仅存储原始邮件，摘要显示"未分析" |
| 流水线处理失败 | 记录错误，不影响邮件正常收发 |
| 搜索无 AI 分析结果 | 降级为纯 SQL 关键词搜索，不按分类/意图筛选 |

---

## 八、文件结构

```
mona/email_intel/                    # Python 侧智能模块（新增）
├── __init__.py
├── pipeline.py                      # 处理流水线（预处理 → AI 分析 → 后处理）
├── analyze.py                       # AI 分析（LLM 调用 + Prompt）
├── post_process.py                  # 后处理（实体存储、任务创建、项目匹配、跟进检测）
├── tools.py                         # Agent 工具注册（4 个工具）
├── trigger.py                       # 流水线触发器
└── scheduler.py                     # 定时任务（跟进检查、日报生成）

mona/api/email_intel_api.py          # Gateway HTTP 路由（新增）
  - POST /email_intel/analyze        # 手动触发分析
  - GET  /email_intel/analysis/:uid  # 获取 AI 分析结果
  - POST /email_intel/search         # 搜索邮件
  - GET  /email_intel/tasks          # 获取任务列表
  - POST /email_intel/tasks/:id      # 更新任务状态
  - GET  /email_intel/projects       # 获取项目列表
  - GET  /email_intel/followups      # 获取跟进列表

src-tauri/src/email.rs               # 扩展：新增表 + 命令
  - email_get_analysis               # 获取 AI 分析结果
  - email_search                     # 搜索邮件（调用 Python）
  - email_get_tasks                  # 获取任务
  - email_update_task                # 更新任务
  - email_get_projects               # 获取项目
  - email_get_followups              # 获取跟进列表

webui/src/components/email/          # 前端扩展
├── MailAgentPanel.tsx               # 改造：摘要 + 回复 + 任务
├── MailListView.tsx                 # 改造：分类标签 + 搜索框
├── EmailTaskPanel.tsx               # 新增：任务管理面板
├── EmailProjectView.tsx             # 新增：项目视图
├── EmailReportView.tsx              # 新增：日报周报
├── EmailAutomationRules.tsx         # 新增：自动化规则配置
└── store/emailStore.ts              # 扩展：AI 状态管理
```

---

## 九、配置项

```json
{
  "emailIntel": {
    "enabled": false,                 // 总开关，默认关闭。关闭时所有 AI 功能不介入
    "autoProcessOnSync": false,       // 同步后自动分析，默认关闭。开启后对新邮件自动跑流水线
    "model": null,
    "followup": {
      "enabled": false,               // 跟进提醒开关，默认关闭
      "replyTimeoutDays": 3,
      "actionPendingDays": 2,
      "noResponseDays": 5
    },
    "report": {
      "dailyEnabled": false,          // 日报开关，默认关闭
      "dailyTime": "09:00",
      "weeklyEnabled": false,         // 周报开关，默认关闭
      "weeklyDay": 1
    },
    "automation": {
      "enabled": false,               // 自动化工作流开关，默认关闭
      "rules": []
    }
  }
}
```

**配置原则**：所有开关默认关闭。用户必须逐个主动开启。`emailIntel.enabled` 是总开关，关闭时即使子开关开启也不生效。

---

## 十、风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| LLM 调用成本高 | 大量邮件处理费用高 | 批处理 + 轻量模型 + 增量处理 |
| 处理延迟影响体验 | 用户等待感 | 异步处理 + 先显示邮件再补分析 |
| 分类准确率不足 | 用户体验差 | 置信度低于 0.7 时不自动操作 |
| 搜索精度不够 | 找不到邮件 | SQL 全文搜索 + AI 分析结果筛选 + Agent 多轮搜索 |
| 隐私顾虑 | 用户不愿邮件发到云端 | 支持本地模型（Ollama）+ 可关闭 |
| 与现有邮件 Channel 冲突 | 功能重复 | 桌面模块独立于 Channel，互不干扰 |
