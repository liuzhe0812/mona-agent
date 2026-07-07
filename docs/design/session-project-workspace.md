# 会话绑定项目工作目录 — 设计方案

## 一、核心模型

```
会话(Session) ──metadata.workspace──▶ 工作目录
                                      │
                                      ├─ null  → ~/.mona/workspace/（默认会话区）
                                      └─ 路径  → 用户指定的项目目录
```

**核心决策**：

1. **项目 = 唯一的 workspace 目录路径**。Session.metadata 中存 `workspace` 字段（null 或绝对路径），不新增数据表。
2. **全局资源移出 workspace**。memory/、skills/、ppt_projects/、SOUL.md/USER.md/AGENTS.md/HEARTBEAT.md 统一迁到 `~/.mona/` 下，与产物目录完全隔离。
3. **`_FsTool` 的 workspace 硬编码指向会话工作目录**（默认 `~/.mona/workspace/` 或项目目录），无 fallback、无双根查找、无 extra_allowed_dirs 漏点。
4. **全局资源通过专用工具访问**（memory_search、skill_read、heartbeat_update、ppt_project_* 等），工具内部用固定 Path，不经过 _FsTool。
5. **Session JSONL 仍集中存 `~/.mona/workspace/sessions/`**——会话索引集中管理，项目目录只放产物。

### 设计目标

- 支持创建会话时选择项目目录
- 同一项目的多个会话共享产物，跨会话连续协作
- 默认会话产物统一在 `~/.mona/workspace/`，不污染 `~/.mona/` 根
- 会话列表以"分区"形式展示：顶部"会话"区 + 后续各项目区，平铺不折叠
- 代码层面硬约束产物路径，agent 无法绕过

---

## 二、目录结构

### 改造前（现状）

```
~/.mona/
├── config.json
└── workspace/                         # 所有东西混在一起
    ├── AGENTS.md / SOUL.md / USER.md
    ├── HEARTBEAT.md
    ├── memory/
    ├── skills/
    ├── ppt_projects/
    ├── sessions/
    └── <agent 写的散落产物>
```

### 改造后

```
~/.mona/                               # 全局资源根（不在 workspace 内）
├── config.json
├── memory/                            # 从 workspace/memory/ 迁出
│   ├── MEMORY.md
│   ├── SOUL.md / USER.md / AGENTS.md
│   ├── history.jsonl
│   └── projects/{project-id}/         # per-project 记忆（可选，Phase 3）
│       └── MEMORY.md
├── skills/                            # 从 workspace/skills/ 迁出（用户自建 skills）
├── HEARTBEAT.md                       # 从 workspace/HEARTBEAT.md 迁出
└── workspace/                         # 产物目录（_FsTool 唯一可写区域）
    ├── sessions/                      # 会话 JSONL（集中存储，不随项目迁移）
    ├── ppt_projects/                  # PPT 项目（保留在 workspace 下，PPT agent 专用）
    └── <agent 产物>
```

**关键性质**：
- `_FsTool.workspace` 唯一指向 `~/.mona/workspace/` 或项目目录
- `~/.mona/memory/`、`~/.mona/skills/` 不在 workspace 内，_FsTool 无法访问
- `ppt_projects/` 保留在 workspace 下，PPT agent 通过专用工具族访问
- 全局资源访问全部走专用工具（见第四节）

---

## 三、产物路径规则

| 会话分区 | `metadata.workspace` | agent 产物落点 |
|---------|---------------------|--------------|
| 会话（默认） | `null` | `~/.mona/workspace/` |
| 项目 | `/path/to/project` | 项目目录内 |

**示例**：
- 默认会话让 agent 写 `report.md` → 写入 `~/.mona/workspace/report.md`
- 项目会话（绑定 `D:\my-app`）让 agent 写 `src/main.tsx` → 写入 `D:\my-app\src\main.tsx`

---

## 四、全局资源专用工具（核心改造）

要实现 _FsTool 硬编码约束，必须把所有"经 _FsTool 访问全局资源"的入口迁移到专用工具。

### 4.1 新增专用工具

| 工具 | 替代的 _FsTool 访问 | 内部路径源 | scope |
|------|---------------------|-----------|-------|
| `memory_search` | `grep(path="memory/...")` | `~/.mona/memory/history.jsonl` | core |
| `memory_read` | `read_file("MEMORY.md")` 等 | `~/.mona/memory/` | core |
| `memory_edit` | `edit_file("SOUL.md")` 等 | `~/.mona/memory/` | dream |
| `skill_read` | `read_file(skill_path)` | `~/.mona/skills/` + builtin | core |
| `skill_create` | `write_file("skills/...")` | `~/.mona/skills/` | dream |
| `skill_install` | `exec("npx clawhub install")` | `~/.mona/skills/` | core |
| `skill_script_run` | `exec("python ${SKILL_DIR}/scripts/...")` | builtin skills 目录 | core |
| `skill_reference_read` | `read_file("${SKILL_DIR}/references/...")` | builtin skills 目录 | core |
| `skill_asset_copy` | `exec("cp ${SKILL_DIR}/...")` | builtin skills 目录 | core |
| `heartbeat_update` | `edit_file("HEARTBEAT.md")` | `~/.mona/HEARTBEAT.md` | core |

**注意**：PPT 的 `ppt_projects/` 保留在 workspace 下，PPT agent 通过通用 _FsTool 访问，不需要 ppt_project_* 专用工具族。PPT agent 用独立 ToolRegistry（工具子集）+ 独立提示词实现隔离，详见 Phase 4。

### 4.2 _FsTool 边界闭合

**`mona/agent/tools/filesystem.py` `_FsTool.create()`**：

移除 `extra_allowed_dirs=[BUILTIN_SKILLS_DIR]` 漏点，让 workspace 边界真正闭合：

```python
@classmethod
def create(cls, ctx: Any) -> Tool:
    restrict = (ctx.config.restrict_to_workspace or ctx.config.exec.sandbox)
    allowed_dir = Path(ctx.workspace) if restrict else None
    # 移除：extra_read = [BUILTIN_SKILLS_DIR] if allowed_dir else None
    return cls(
        workspace=ctx.workspace,
        allowed_dir=allowed_dir,
        extra_allowed_dirs=None,  # 硬约束：无额外放行
        # ...
    )
```

### 4.3 Dream 工具集重建

**`mona/agent/memory.py` `Dream._build_tools()`**：

Dream 当前用通用 `ReadFileTool`/`EditFileTool`（`allowed_dir=workspace`）编辑 SOUL/USER/MEMORY/skills。改为专用工具：

```python
def _build_tools(self) -> ToolRegistry:
    tools = ToolRegistry()
    tools.register(MemoryEditTool(...))     # 替代 edit_file("SOUL.md")
    tools.register(SkillCreateTool(...))    # 替代 write_file("skills/...")
    tools.register(SkillReadTool(...))      # 替代 read_file(skill_path)
    tools.register(MemoryReadTool(...))     # 替代 read_file("MEMORY.md")
    # 不再注册通用 ReadFileTool/EditFileTool/WriteFileTool
    return tools
```

### 4.4 数据目录迁移

启动时检测旧路径，自动迁移：

```python
def migrate_global_resources(config: Config):
    """启动时一次性迁移：把全局资源从 workspace/ 迁到 ~/.mona/"""
    old_ws = config.workspace_path  # ~/.mona/workspace
    new_root = old_ws.parent         # ~/.mona

    migrations = [
        (old_ws / "memory", new_root / "memory"),
        (old_ws / "skills", new_root / "skills"),
        # 注意：ppt_projects/ 保留在 workspace 下，不迁移
        (old_ws / "HEARTBEAT.md", new_root / "HEARTBEAT.md"),
        (old_ws / "SOUL.md", new_root / "memory" / "SOUL.md"),
        (old_ws / "USER.md", new_root / "memory" / "USER.md"),
        (old_ws / "AGENTS.md", new_root / "memory" / "AGENTS.md"),
    ]
    for old, new in migrations:
        if old.exists() and not new.exists():
            new.parent.mkdir(parents=True, exist_ok=True)
            old.rename(new)
```

---

## 五、数据流

### 创建会话

```
前端 newChat({workspace: "/path/to/project"})  // null 表示默认会话
  │
  ▼ WS envelope {type:"new_chat", workspace:"/path/to/project"}
  │
  ▼ websocket._dispatch_envelope
  │   生成 chat_id → _attach
  │   session = sessions.get_or_create(f"websocket:{chat_id}")
  │   session.metadata["workspace"] = workspace  // null 也显式写入
  │   sessions.save(session)
  ▼
  回复 {event:"attached", chat_id}
```

### 发送消息时使用会话 workspace

```
AgentLoop._dispatch(msg)
  │
  ▼ session = sessions.get_or_create(key)
  ▼ ws_override = session.metadata.get("workspace")
  ▼ effective_workspace = ws_override or config.workspace_path
  ▼ _run_agent_loop(..., workspace=effective_workspace)
  │
  ▼ AgentRunSpec(workspace=effective_workspace)
  │
  ├─ ContextBuilder 按 spec.workspace 渲染 identity.md
  └─ _FsTool._resolve(path) 从 contextvar 读取当前 workspace
```

### 默认 workspace 计算

`metadata.workspace` 为 null 时，回退到 `config.workspace_path`（即 `~/.mona/workspace/`）。无需新增 helper。

---

## 六、分模块改动清单

### 1. 协议层 — WebSocket envelope

**`mona/channels/websocket.py` `_dispatch_envelope`**

`new_chat` 分支增加 `workspace` 字段提取：

```python
if msg_type == "new_chat":
    chat_id = str(uuid.uuid4())
    workspace = payload.get("workspace")  # 新增，None 表示默认会话
    _attach(connection, chat_id)
    session = self._sessions.get_or_create(f"websocket:{chat_id}")
    session.metadata["workspace"] = workspace
    self._sessions.save(session)
    await self._send_envelope(connection, {"event": "attached", "chat_id": chat_id})
    await self._hydrate_after_subscribe(chat_id)
    return
```

### 2. 路由层 — AgentLoop

**`mona/agent/loop.py` `_process_message`**

```python
session = self.sessions.get_or_create(session_key)
workspace_override = session.metadata.get("workspace")
effective_workspace = (
    Path(workspace_override).expanduser()
    if workspace_override
    else self.workspace  # config.workspace_path
)
```

把 `effective_workspace` 透传到 `_run_agent_loop`。

**`mona/agent/loop.py` `_run_agent_loop`**

`AgentRunSpec(workspace=effective_workspace, ...)`。

### 3. 工具层 — 动态 workspace（contextvar）

**`mona/agent/tools/path_utils.py`** 新增：

```python
import contextvars

_current_workspace: contextvars.ContextVar[Path | None] = contextvars.ContextVar(
    "_current_workspace", default=None
)

def set_current_workspace(ws: Path | None) -> contextvars.Token:
    return _current_workspace.set(ws)

def get_current_workspace(fallback: Path | None = None) -> Path | None:
    return _current_workspace.get() or fallback
```

**`mona/agent/tools/filesystem.py` `_FsTool._resolve`**：

```python
def _resolve(self, path: str) -> Path:
    ws = get_current_workspace(self._workspace)
    allowed = ws if self._restrict else None
    return resolve_workspace_path(path, ws, allowed, self._extra_allowed_dirs)
```

**`mona/agent/loop.py` `_run_agent_loop` 入口**：

```python
token = set_current_workspace(spec.workspace)
try:
    # ... 原有 agent loop 执行 ...
finally:
    set_current_workspace(None)
```

### 4. 上下文层 — ContextBuilder

**`mona/agent/context.py`**

identity.md 中的 `workspace_path` 注入会话的 effective_workspace。ContextBuilder 渲染时按传入 workspace 参数：

```python
def _get_identity(self, channel: str | None, workspace: Path) -> str:
    workspace_path = str(workspace.expanduser().resolve())
    # render_template("agent/identity.md", workspace_path=workspace_path, ...)
```

identity.md 模板**移除**对 `memory/`、`skills/` 路径的注入（这些走专用工具，agent 不需要知道路径）。

### 5. SessionManager.list_sessions

**`mona/session/manager.py` `list_sessions`**

返回每个 session 的 `workspace` 字段：

```python
item = {
    "key": ...,
    "created_at": ...,
    "updated_at": ...,
    "title": meta.get("title", ""),
    "workspace": meta.get("workspace"),  # null = 默认会话
    "preview": ...,
}
```

### 6. 前端 — 数据类型

**`webui/src/lib/types.ts`**：

```typescript
export interface ChatSummary {
  key: string;
  channel: string;
  chatId: string;
  createdAt: string | null;
  updatedAt: string | null;
  title?: string;
  preview: string;
  runStartedAt?: number | null;
  workspace: string | null;  // null = 默认会话
}

export interface ProjectGroup {
  id: string;        // workspace 路径，null 时为 "__default__"
  name: string;      // 目录名或 "会话"
  workspace: string | null;
  sessions: ChatSummary[];
}
```

**`webui/src/lib/mona-client.ts` `newChat`**：

```typescript
async newChat(
  opts?: { workspace?: string | null; ephemeral?: boolean },
  timeoutMs = 10000
) {
  const payload: any = { type: "new_chat" };
  if (opts?.ephemeral) payload.ephemeral = true;
  if (opts && "workspace" in opts) payload.workspace = opts.workspace;
  // ...
}
```

### 7. 前端 — 会话列表分区

**`webui/src/components/ChatList.tsx`** 改为分区结构：

```
会话
  💬 随便问个问题                2 周
  💬 帮我查个资料                3 周

my-app  ·  D:\my-app
  💬 写需求文档                  2 天
  💬 搭项目骨架                  1 天

docs-project  ·  D:\docs
  💬 整理 API 文档               1 周
```

**布局规则**：
- 顶部第一区标题固定为"**会话**"（默认会话区，非目录、不可折叠）
- 后续每个项目一个区，标题格式：`{项目名}  ·  {完整路径}`
- 所有分区**平铺**，滚动查看，无展开/折叠交互
- "会话"区永远在最前
- 点击会话进入聊天，无"点击项目名"交互

**右键菜单**：
- 默认会话区右键：新建会话、新项目会话
- 项目区标题右键：在此项目新建会话、删除项目（删除该项目下所有会话历史，不删目录文件）
- 会话项右键：移动到项目…、改为默认会话、重命名、置顶、删除

**新建会话入口**：

侧边栏顶部两个按钮：
- "新会话" → `newChat({ workspace: null })`，进入"会话"区
- "新项目会话" → 弹出目录选择器，选完目录后 `newChat({ workspace })`，进入对应项目区

### 8. 新增 HTTP API

```
PUT    /api/sessions/{key}/workspace   { workspace: "/path" | null }
       → 更新 session.metadata["workspace"]

DELETE /api/sessions/{key}/workspace
       → 清除绑定，归入默认会话

GET    /api/sessions/{key}/workspace
       → 查询当前绑定

GET    /api/projects
       → 返回所有已使用的项目列表（从所有 session 的 workspace 字段聚合）
```

---

## 七、提示词改写清单

以下提示词需要同步修改（去掉对 `read_file`/`grep`/`write_file`/`edit_file` 访问全局资源的指示，改为调用专用工具）：

1. **`mona/skills/memory/SKILL.md`** — "Search Past Events" 段落改用 `memory_search`
2. **`mona/templates/agent/identity.md`** — 删除 `{{ workspace_path }}/memory/...` 与 `{{ workspace_path }}/skills/...` 路径注入；只保留 workspace_path 本身
3. **`mona/templates/agent/skills_section.md`** — "read its SKILL.md file using the read_file tool" 改为 "use the `skill_read` tool"
4. **`mona/templates/AGENTS.md`** — "Keep durable facts ... in USER.md/SOUL.md/memory/MEMORY.md" 改为指向 `memory_*` 工具；"Use file tools to manage periodic tasks" 改为 "use the `heartbeat_update` tool"
5. **`mona/templates/agent/tool_contract.md`** — "update HEARTBEAT.md" 改为 "use the `heartbeat_update` tool"
6. **`mona/templates/agent/dream_phase2.md`** — "create a new skill under skills/<name>/SKILL.md using write_file" 改为 "use the `skill_create` tool"；"File paths (relative to workspace root) - SOUL.md / USER.md / memory/MEMORY.md" 改为 "use the `memory_edit` tool with file=soul|user|memory"
7. **`mona/skills/mona-ppt/SKILL.md`** — `${SKILL_DIR}` 引用全部改为 `skill_script_run` / `skill_reference_read` / `skill_asset_copy`；`ppt_projects/` 路径改为 `ppt_project_*` 工具调用
8. **`mona/skills/html-report/SKILL.md`** — 同上
9. **`mona/skills/clawhub/SKILL.md`** — `npx clawhub install --workdir ~/.mona/workspace` 改为 `skill_install(slug)`
10. **`mona/skills/skill-creator/SKILL.md`** — "custom skills should live under `<workspace>/skills/...`" 改为 "use the `skill_create` tool"
11. **`mona/skills/update-setup/SKILL.md`** — `read_file`/`write_file` 改为 `skill_read`/`skill_create`

### 7.1 `mona/templates/AGENTS.md` 详细改写

**当前内容**（节选关键行）：

```markdown
## Workspace Guidance

Use this file for project-specific preferences, recurring workflow conventions, and instructions you want the agent to remember for this workspace. Keep durable facts about the user in `USER.md`, personality/style guidance in `SOUL.md`, and long-term memory in `memory/MEMORY.md`.

## Heartbeat Tasks

`HEARTBEAT.md` is checked on the configured heartbeat interval. Use file tools to manage periodic tasks.

- Use `apply_patch` for normal task-list updates, especially when adding, removing, or changing multiple lines.
- Use `edit_file` only for small exact replacements copied from the current `HEARTBEAT.md`.
- Use `write_file` for first creation or intentional full-file rewrites.

When the user asks for a recurring/periodic task, update `HEARTBEAT.md` instead of creating a one-time cron reminder.
```

**改写后**：

```markdown
## Workspace Guidance

Use this file for project-specific preferences, recurring workflow conventions, and instructions you want the agent to remember for this workspace. Durable facts about the user, personality/style guidance, and long-term memory are managed via dedicated tools — do not use `read_file`/`write_file`/`edit_file` on them directly:

- `memory_read(file="user"|"soul"|"memory")` — read USER.md / SOUL.md / MEMORY.md
- `memory_edit(file="user"|"soul"|"memory", ...)` — edit them (Dream agent only)
- `memory_search(query, ...)` — search past events in history log

## Heartbeat Tasks

`HEARTBEAT.md` is checked on the configured heartbeat interval. Use the `heartbeat_update` tool to manage periodic tasks — do not use `apply_patch`/`edit_file`/`write_file` on HEARTBEAT.md directly.

When the user asks for a recurring/periodic task, use `heartbeat_update` instead of creating a one-time cron reminder.
```

**关键变化**：
- 删除"用 apply_patch/edit_file/write_file 管理 HEARTBEAT.md"的全部指示
- 改为"用 heartbeat_update 工具"
- 删除"用 read_file/grep 访问 USER.md/SOUL.md/MEMORY.md"的隐含指示
- 改为"用 memory_read/memory_edit/memory_search 专用工具"

### 7.2 `mona/templates/agent/identity.md` 详细改写

**当前内容**（关键行）：

```markdown
## Workspace
Your workspace is at: {{ workspace_path }}
- Long-term memory: {{ workspace_path }}/memory/MEMORY.md (automatically managed by Dream — do not edit directly)
- History log: {{ workspace_path }}/memory/history.jsonl (append-only JSONL; prefer built-in `grep` for search).
- Custom skills: {{ workspace_path }}/skills/{skill-name}/SKILL.md
```

**改写后**：

```markdown
## Workspace
Your workspace is at: {{ workspace_path }}

Long-term memory, user profile, and skills are stored outside the workspace and accessed via dedicated tools:

- Long-term memory: use `memory_read` / `memory_edit` (Dream only) / `memory_search`
- Custom skills: use `skill_read` to load a skill's SKILL.md content
```

**关键变化**：
- 删除 `{{ workspace_path }}/memory/MEMORY.md` 等绝对路径注入
- 删除 `{{ workspace_path }}/skills/{skill-name}/SKILL.md` 路径注入
- 改为指示用专用工具访问
- agent 不再知道全局资源的物理路径，只知道通过工具访问

### 7.3 `mona/templates/agent/tool_contract.md` 详细改写

**当前内容**（关键行）：

```markdown
## Scheduling and Background Work

- Use `cron` for scheduled reminders or recurring jobs; do not run `mona cron` through `exec`.
- For heartbeat tasks, update `HEARTBEAT.md` according to the agent instructions.
- Do not write reminders only to memory files when the user expects an actual notification.
```

**改写后**：

```markdown
## Scheduling and Background Work

- Use `cron` for scheduled reminders or recurring jobs; do not run `mona cron` through `exec`.
- For heartbeat tasks, use the `heartbeat_update` tool — do not use `apply_patch`/`edit_file`/`write_file` on HEARTBEAT.md.
- Do not write reminders only to memory files when the user expects an actual notification.

## Global Resources (Outside Workspace)

The following resources are stored outside the workspace and must be accessed via dedicated tools — `read_file`/`write_file`/`edit_file`/`grep` cannot reach them:

- Memory (MEMORY.md / SOUL.md / USER.md / history.jsonl): use `memory_read` / `memory_edit` (Dream only) / `memory_search`
- Skills (SKILL.md files): use `skill_read` to load content, `skill_create` (Dream only) to create new skills
- Skill scripts and references: use `skill_script_run` / `skill_reference_read` / `skill_asset_copy`
- Heartbeat (HEARTBEAT.md): use `heartbeat_update`

Attempting to read/write these resources via file tools will fail with a workspace boundary error.
```

**关键变化**：
- heartbeat 部分改为指示用 `heartbeat_update` 工具
- 新增"Global Resources (Outside Workspace)"段落，明确告知 agent 哪些资源在 workspace 外、用什么工具访问
- 明确"用文件工具访问会失败"，让 agent 不会反复尝试

### 7.4 `mona/templates/agent/skills_section.md` 详细改写

**当前内容**（关键行）：

```markdown
The following skills extend your capabilities. To use a skill, read its SKILL.md file using the read_file tool.
```

**改写后**：

```markdown
The following skills extend your capabilities. To use a skill, load its SKILL.md content using the `skill_read` tool:

- `skill_read(name="skill-name")` — returns the full SKILL.md content for the given skill

Do not use `read_file` to load SKILL.md files — they are stored outside the workspace and `read_file` cannot reach them.
```

**关键变化**：
- "read its SKILL.md file using the read_file tool" 改为 "use the `skill_read` tool"
- 明确说明 `read_file` 无法访问 skills 目录

### 7.5 `mona/templates/agent/dream_phase2.md` 详细改写

**当前内容**（关键行）：

```markdown
- [FILE] entries: add the described content to the appropriate file
- [SKILL] entries: create a new skill under skills/<name>/SKILL.md using write_file

## File paths (relative to workspace root)
- SOUL.md
- USER.md
- memory/MEMORY.md
- skills/<name>/SKILL.md (for [SKILL] entries only)
...
- Use write_file to create skills/<name>/SKILL.md
```

**改写后**：

```markdown
- [FILE] entries: use the `memory_edit` tool to update the appropriate memory file
  - `memory_edit(file="soul", ...)` for SOUL.md
  - `memory_edit(file="user", ...)` for USER.md
  - `memory_edit(file="memory", ...)` for MEMORY.md
- [SKILL] entries: use the `skill_create` tool to create a new skill
  - `skill_create(name="skill-name", content="...")` creates the SKILL.md

## Memory and Skill Access

Memory files (SOUL.md / USER.md / MEMORY.md) and skills are stored outside the workspace. Use dedicated tools:

- `memory_read(file="soul"|"user"|"memory")` — read content
- `memory_edit(file="soul"|"user"|"memory", ...)` — edit content
- `skill_read(name="...")` — read existing skill
- `skill_create(name="...", content="...")` — create new skill

Do not use `read_file`/`write_file`/`edit_file` for these resources — they are outside the workspace boundary.
```

**关键变化**：
- "add the described content to the appropriate file" 改为 "use the `memory_edit` tool"
- "create a new skill under skills/<name>/SKILL.md using write_file" 改为 "use the `skill_create` tool"
- 删除"File paths (relative to workspace root)"段落（agent 不再需要知道路径）
- 新增"Memory and Skill Access"段落，明确专用工具的使用方式

### 7.6 `mona/skills/memory/SKILL.md` 详细改写

**当前内容**（关键行）：

```markdown
- `memory/history.jsonl` — append-only JSONL, not loaded into context. Prefer the built-in `grep` tool to search it.
...
- `grep(pattern="keyword", path="memory/history.jsonl", case_insensitive=true)`
- `grep(pattern="2026-04-02 10:00", path="memory/history.jsonl", fixed_strings=true)`
- `grep(pattern="keyword", path="memory", glob="*.jsonl", output_mode="count", case_insensitive=true)`
- `grep(pattern="oauth|token", path="memory", glob="*.jsonl", output_mode="content", case_insensitive=true)`
```

**改写后**：

```markdown
- `memory/history.jsonl` — append-only JSONL, not loaded into context. Use the `memory_search` tool to search it.

## Searching Past Events

Use `memory_search` to search the history log:

- `memory_search(query="keyword")` — full-text search
- `memory_search(query="oauth token")` — multi-word search
- `memory_search(query="2026-04-02")` — search by date
- `memory_search(query="oauth|token", output_mode="count")` — count matches

Do not use `grep` to search memory — memory files are stored outside the workspace and `grep` cannot reach them.
```

**关键变化**：
- 所有 `grep(path="memory/...")` 改为 `memory_search(query="...")`
- 明确说明 `grep` 无法访问 memory 目录

### 7.7 用户定制版 AGENTS.md 的处理

迁移脚本只搬文件位置（`workspace/AGENTS.md` → `~/.mona/memory/AGENTS.md`），**不改内容**。这意味着：
- 如果用户有定制版，里面的旧指示（如"用 edit_file 改 SOUL.md"）会保留
- agent 按旧指示调用 `edit_file("SOUL.md")` 会失败（_FsTool 边界闭合，SOUL.md 不在 workspace 内）

**处理策略**：

1. **迁移脚本检测警告**：迁移脚本检测到用户定制版 AGENTS.md 时，输出警告日志：
   ```
   WARNING: User-customized AGENTS.md found at ~/.mona/memory/AGENTS.md.
   The file may contain outdated instructions referencing direct file access to memory/heartbeat.
   Please review and update to use the new dedicated tools (memory_*/heartbeat_update/skill_*).
   ```

2. **ContextBuilder 启动时附加 override 提示**：ContextBuilder 加载用户版 AGENTS.md 后，在末尾自动追加一条 override 提示：
   ```markdown
   ---
   NOTE: Memory files (SOUL.md/USER.md/MEMORY.md/history.jsonl), skills, and HEARTBEAT.md are now stored outside the workspace. Use dedicated tools (memory_read/memory_edit/memory_search/skill_read/skill_create/heartbeat_update) instead of read_file/write_file/edit_file/grep/apply_patch. Direct file access to these resources will fail with a workspace boundary error.
   ```

   这条 override 提示会覆盖用户定制版中的旧指示，让 agent 优先用专用工具。

3. **首次启动提示用户**：前端检测到迁移发生时，弹窗提示用户检查 AGENTS.md 是否有需要更新的指示。

---

## 八、代码改写清单

1. **`mona/agent/tools/filesystem.py`** — `_FsTool.create()` 移除 `extra_allowed_dirs=[BUILTIN_SKILLS_DIR]`
2. **`mona/agent/memory.py`** — `Dream._build_tools()` 用专用工具替换 `ReadFileTool`/`EditFileTool`/`WriteFileTool`
3. **`mona/agent/skills.py`** — `build_skills_summary()` 不再输出 `entry['path']` 绝对路径
4. **`mona/agent/subagent.py`** — `_build_tools()` 注入新的专用工具，subagent 的 `allowed_dir` 改为会话绑定的 workspace
5. **`mona/agent/tools/loader.py`** — 注册新的 `memory_*` / `skill_*` / `heartbeat_*` 工具类
6. **`mona/config/schema.py`** — 给新工具补 Config 类（如 `MemoryToolsConfig`、`SkillToolsConfig`）
7. **`mona/agent/tools/path_utils.py`** — 新增 workspace contextvar
8. **`mona/config/paths.py`** — 新增 `get_memory_dir()`、`get_skills_dir()` 等 helper（PPT 路径不变，不需要 helper）
9. **`mona/heartbeat/service.py`** — 路径从 `workspace / "HEARTBEAT.md"` 改为 `~/.mona/HEARTBEAT.md`
10. **`mona/channels/websocket.py`** — PPT 相关路由保持 `workspace / "ppt_projects"` 不变（PPT 保留在 workspace 下）
11. **`mona/agent/context.py`** — `_load_bootstrap_files()` 路径从 `workspace / "SOUL.md"` 改为 `~/.mona/memory/SOUL.md`
12. **`mona/agent/memory.py` `MemoryStore`** — 所有路径从 `workspace / "memory"` 改为 `~/.mona/memory/`

---

## 九、安全约束

1. **路径校验**：用户选的项目路径必须 `expanduser().resolve()` 后校验，禁止 `..` 穿越
2. **`_resolve_path` 边界**：session workspace 切换后，`allowed_dir` 必须同步切换
3. **不限制路径范围**：允许用户选任意目录作为项目，但写入受 `_FsTool._resolve` 保护
4. **无 fallback**：_FsTool 解析路径唯一指向会话 workspace，不查全局资源目录

---

## 十、兼容性处理

| 场景 | 行为 |
|------|------|
| 旧会话无 `metadata.workspace` | 归入"会话"分区，产物进入 `~/.mona/workspace/` |
| 旧数据在 `workspace/memory/` 等 | 启动时自动迁移到 `~/.mona/` 下（一次性迁移脚本） |
| `unified_session=True` 模式 | 不支持项目绑定，归入"会话"分区 |
| CLI/Telegram 等非 WS 渠道 | 暂不支持绑定，归入"会话"分区 |
| Subagent | 继承主 session 的项目 workspace |
| 删除会话 | 只删 session JSONL，不删项目目录文件 |
| 删除项目 | 删除该项目分区下所有会话历史；项目目录文件保留 |

---

## 十一、实现优先级（分阶段）

### Phase 1：全局资源迁移 + 专用工具（前置必做）

目标：让 _FsTool 的 workspace 边界真正闭合，为会话绑定 workspace 铺路。

- 数据目录迁移：`workspace/memory/`、`workspace/skills/`、`workspace/HEARTBEAT.md`、`workspace/SOUL.md` 等迁到 `~/.mona/` 下（`ppt_projects/` 保留在 workspace 下不迁移）
- 新增专用工具：
  - `memory_search` / `memory_read` / `memory_edit`（Dream only）
  - `skill_read` / `skill_create`（Dream only）/ `skill_install` / `skill_script_run` / `skill_reference_read` / `skill_asset_copy`
  - `heartbeat_update`
- `_FsTool.create()` 移除 `extra_allowed_dirs=[BUILTIN_SKILLS_DIR]`
- `Dream._build_tools()` 用专用工具替换通用 _FsTool
- 改写所有提示词（第七节清单）
- 启动时一次性迁移脚本

### Phase 2：会话绑定 workspace（核心功能）

- 后端：
  - `Session.metadata.workspace` 存 null 或路径
  - `_process_message` 读取并传给 `AgentRunSpec`
  - `list_sessions` 返回 workspace 字段
- 工具层：contextvar 动态 workspace + `_FsTool._resolve` 改造
- 协议：`new_chat` envelope 接受 workspace
- 前端：
  - `newChat` 透传 workspace
  - `ChatSummary` 加 workspace 字段
  - 会话列表改为分区布局
  - 新建会话入口支持"新会话"和"新项目会话"

### Phase 3：完善

- ContextBuilder per-session workspace 渲染
- HTTP API（PUT/DELETE/GET workspace）
- "移动到项目"右键菜单
- `restrict_to_workspace` 模式下的 `_allowed_dir` 动态化
- 项目别名（显示名 vs 实际路径）
- per-project 记忆隔离（`~/.mona/memory/projects/{id}/MEMORY.md`）
- 删除项目时可选同时删除目录文件
- 最近使用的项目快速选择

### Phase 4：PPT 独立 agent（专注化设计，前端交互不变）

**现状问题**：PPT 任务复用主 AgentLoop，提示词混入大量无关内容（AGENTS.md/SOUL.md/USER.md/memory/skills summary/heartbeat 指导等），导致：
- 初始上下文浪费 20-40K token 在与 PPT 无关的内容上
- agent 可能被通用行为指导带偏（试图更新 memory、维护 heartbeat）
- 7 步 pipeline 执行不严格（agent 可能跳步或自由发挥）
- SKILL.md 依赖 agent 主动 read_file，加载时机不可控

**改造目标**：PPT 任务路由到专用 `PPTAgentLoop`，专注化提示词 + 严格 pipeline 约束 + 工具白名单硬约束，让 agent 100% 聚焦 PPT 任务。前端业务交互逻辑完全不变。

**保留不变**（前端交互约束）：
- PptMakerView/PptConfigPanel/PptHistory/PptPreview/PptChatPanel 组件
- 16 个 `/api/ppt/*` HTTP 路由
- 3 个 WS envelope（ppt_upload/ppt_import_native/ppt_delete_native）
- `.chat_id` 文件过滤机制（PPT 会话从通用列表隐藏）
- PPT 历史面板的项目列表/状态/下载
- 状态轮询机制（`/api/ppt/export-status`）
- 八项确认预填（前端 buildPptPrompt 构造）
- 三种模板分支（layout/brand/native）
- WebSocket 通信机制 + SessionManager 复用
- `ppt_projects/` 仍在 workspace 下

#### 4.1 后端路由分发

`WebSocketChannel._dispatch` 检测 PPT 会话（chat_id 是否在 `ppt_projects/*/.chat_id` 中），路由到 `PPTAgentLoop` 而非主 AgentLoop。

#### 4.2 PPTAgentLoop（新增 `mona/agent/ppt_loop.py`）

继承或组合 AgentLoop，覆盖工具集和提示词构建：

- 独立 ToolRegistry：只含 PPT 所需工具白名单
- 不加载 MemoryStore（PPT 任务独立，不读写记忆）
- 不加载 heartbeat
- 不加载通用 skills summary
- 强制注入 mona-ppt SKILL.md 全文

#### 4.3 工具白名单（硬约束）

```python
PPT_TOOLS_WHITELIST = [
    # 文件操作（限定在 ppt_projects/ 和 workspace 内）
    "read_file", "write_file", "edit_file", "list_dir", "find_files", "grep",
    # 脚本执行（限定在 mona-ppt/scripts/ 内）
    "exec",
    # skill 资源访问（专用工具，替代 ${SKILL_DIR} 裸路径）
    "skill_reference_read", "skill_script_run", "skill_asset_copy",
    # 图片生成
    "generate_image",
    # 网络图片搜索
    "web_search", "web_fetch",
]
```

**禁止注册**：memory_*、heartbeat_update、notes_*、kb_*、apply_patch、spawn、document、chart 等通用工具。工具层硬约束，PPT agent 无法调用这些工具。

#### 4.4 PPTContextBuilder（新增 `mona/agent/ppt_context.py`）

**只加载**：
- `ppt_soul.md` — PPT 专属提示词（设计原则 + pipeline 约束 + 工具白名单）
- `mona-ppt/SKILL.md` 全文强制注入（agent 不需要主动 read_file）
- `workspace_path`（仅注入 `~/.mona/workspace/`，不注入 memory/skills 路径）

**完全不加载**：
- AGENTS.md / SOUL.md / USER.md
- memory/MEMORY.md / history.jsonl
- 通用 skills summary
- heartbeat 指导
- 通用 tool_contract

前端 `buildPptPrompt` 构造的 prompt 仍作为用户消息传入，不变。

#### 4.5 PPT soul.md（新增 `mona/templates/agent/ppt_soul.md`）

PPT 专属提示词，强约束 agent 行为：

```markdown
# PPT Agent 提示词

## 核心约束

你是一个 PPT 设计专家，只负责执行 mona-ppt skill 的 7 步 pipeline。

### 严格执行 pipeline

必须按顺序执行 Step 1 → Step 7，禁止跳步、禁止重排：
- Step 1: 源内容处理
- Step 2: 项目初始化
- Step 3: 模板选择（可选）
- Step 4: Strategist 阶段（产出 spec_lock.md）
- Step 5: 图片获取
- Step 6: Executor 阶段（逐页 SVG + 质量检查）
- Step 7: 后处理与导出

每个 Step 完成后必须自检 checkpoint（见 SKILL.md），未通过不得进入下一步。

### 工具使用白名单

只允许使用以下工具：
- read_file / write_file / edit_file / list_dir / find_files / grep — 操作 ppt_projects/ 内文件
- exec — 执行 mona-ppt/scripts/*.py
- skill_reference_read — 读 mona-ppt/references/*.md
- skill_script_run — 执行 skill 脚本（替代裸 exec）
- skill_asset_copy — 拷贝 skill 资源（字体/图标）
- generate_image — AI 图片生成
- web_search / web_fetch — 网络图片搜索

禁止使用：memory_* / heartbeat_update / notes_* / kb_* 等通用工具。

### 设计原则

- 视觉层次：每页有明确焦点，信息密度适中
- 配色：遵循 spec_lock.md 的主色调，禁止使用未确认的颜色
- SVG：必须手写，禁止用工具自动生成；必须过 svg_quality_checker.py 0 错误
- 图片：优先用 generate_image，网络图片必须校验版权
- 演讲备注：Markdown 格式，与 SVG 一一对应

### 行为禁止

- 不更新 memory / SOUL.md / USER.md
- 不维护 heartbeat
- 不创建通用 skill
- 不执行与 PPT 无关的任务
- 不偏离 pipeline 顺序，即使用户要求
- 不跳过质量检查（svg_quality_checker.py）

### 输出规范

完成后只报告：
- 项目路径：ppt_projects/<name>/
- 导出文件：exports/<name>_<timestamp>.pptx
- 页数、耗时、关键决策点
```

#### 4.6 mona-ppt skill 调整

- `${SKILL_DIR}` 引用改为 `skill_script_run` / `skill_reference_read` / `skill_asset_copy` 专用工具
- `ppt_projects/` 路径保持不变（仍在 workspace 下）
- SKILL.md 内容由 PPTContextBuilder 强制注入，agent 不需要主动 read_file
- `${SKILL_DIR}` 占位符在 PPTContextBuilder 中解析为绝对路径注入

#### 4.7 专注化效果对比

| 维度 | 改造前 | 改造后 |
|------|--------|--------|
| 初始上下文 | 30-50K（含通用模板+memory+skills summary） | 10-15K（仅 ppt_soul.md + SKILL.md） |
| agent 注意力 | 分散在通用行为+PPT 任务 | 100% 聚焦 PPT pipeline |
| pipeline 执行 | agent 可能跳步或自由发挥 | 严格顺序 + checkpoint 自检 |
| 工具误用 | 可能调 memory_*、heartbeat_* | 工具白名单硬约束，无法误用 |
| SKILL.md 加载 | 依赖 agent 主动 read_file | 强制注入，agent 必看 |
| 跑偏风险 | 高（通用提示词可能引导到无关行为） | 低（强约束禁止偏离 pipeline） |

#### 4.8 Session 机制

- 仍复用 SessionManager（不改前端 useSessionHistory/useMonaStream 适配层）
- 仍通过 `.chat_id` 文件过滤
- PPT 会话历史仍通过 PPT 历史面板访问

#### 4.9 工作区

- `ppt_projects/` 仍在 workspace 下（按用户指示）
- PPTAgentLoop 的 workspace 与主 agent 一致（`~/.mona/workspace/`）
- PPT agent 通过 `ppt_projects/<project>/` 子目录访问项目文件

---

## 十二、最大风险点

1. **工具层 contextvar 改造**：所有 `_FsTool` 子类都走 `_resolve`，需要全面测试。
2. **会话列表 UI 改造**：从时间分组改为分区布局，需重新实现排序、置顶、归档等交互。
3. **提示词改写**：11 个提示词文件需要同步修改，遗漏会导致 agent 行为异常。
4. **Dream 工具集重建**：Dream 当前依赖通用 _FsTool，改为专用工具后需要验证 dream 仍能正常编辑 SOUL/USER/MEMORY/skills。
5. **数据迁移**：现有用户的全局资源需要从 workspace/ 迁到 ~/.mona/，迁移脚本要健壮（检测新旧路径、避免覆盖）。

**验证用例**：
1. 新建默认会话，让 agent 写文件，确认在 `~/.mona/workspace/`
2. 新建项目会话绑定 `/tmp/test-project`，让 agent 写文件，确认在 `/tmp/test-project/`
3. 同一项目下两个会话，第二个会话能读到第一个会话写的文件
4. agent 执行 `memory_search` 能搜到 `~/.mona/memory/history.jsonl`
5. agent 执行 `skill_read("mona-ppt")` 能读到 builtin skill 内容
6. Dream 能通过 `memory_edit` 修改 SOUL.md
7. agent 无法通过 `read_file("memory/history.jsonl")` 读到 memory（应报错越界）

---

## 十三、关键代码位置索引

### 后端
| 文件 | 内容 |
|------|------|
| `mona/config/paths.py` | 新增 `get_memory_dir()` / `get_skills_dir()` / `get_ppt_projects_dir()` |
| `mona/config/schema.py` | `workspace` 配置 + 新工具 Config 类 |
| `mona/session/manager.py` | `Session` 类 + `list_sessions()` |
| `mona/agent/loop.py` | `AgentLoop.__init__` / `_dispatch` / `_process_message` / `_run_agent_loop` |
| `mona/agent/runner.py` | `AgentRunSpec` |
| `mona/agent/context.py` | `ContextBuilder` + `_get_identity` |
| `mona/agent/tools/filesystem.py` | `_FsTool` + `_resolve` + `create()` |
| `mona/agent/tools/path_utils.py` | `resolve_workspace_path` + 新增 contextvar |
| `mona/agent/tools/loader.py` | 注册新专用工具 |
| `mona/agent/memory.py` | `MemoryStore` + `Dream._build_tools()` |
| `mona/agent/skills.py` | `SkillsLoader` + `build_skills_summary()` |
| `mona/agent/subagent.py` | `SubagentManager._build_tools()` |
| `mona/channels/websocket.py` | `_dispatch_envelope` + ppt_projects 路由 |
| `mona/heartbeat/service.py` | HEARTBEAT.md 路径 |

### 前端
| 文件 | 内容 |
|------|------|
| `webui/src/lib/types.ts` | `ChatSummary` + `ProjectGroup` |
| `webui/src/lib/mona-client.ts` | `newChat` |
| `webui/src/hooks/useSessions.ts` | 会话状态管理 + 分区逻辑 |
| `webui/src/components/ChatList.tsx` | 会话列表渲染（需大改） |
| `webui/src/components/Sidebar.tsx` | 侧边栏容器 |

### 模板
| 文件 | 内容 |
|------|------|
| `mona/templates/agent/identity.md` | `workspace_path` 注入点 |
| `mona/templates/agent/skills_section.md` | skill 加载指示 |
| `mona/templates/AGENTS.md` | memory/heartbeat 维护指示 |
| `mona/templates/agent/tool_contract.md` | HEARTBEAT.md 维护 |
| `mona/templates/agent/dream_phase2.md` | Dream 文件编辑指示 |

### Skills
| 文件 | 内容 |
|------|------|
| `mona/skills/memory/SKILL.md` | memory 检索指示 |
| `mona/skills/mona-ppt/SKILL.md` | PPT 工作流路径引用 |
| `mona/skills/html-report/SKILL.md` | 报告生成路径引用 |
| `mona/skills/clawhub/SKILL.md` | skill 安装路径 |
| `mona/skills/skill-creator/SKILL.md` | skill 创建路径 |
| `mona/skills/update-setup/SKILL.md` | skill 更新路径 |
