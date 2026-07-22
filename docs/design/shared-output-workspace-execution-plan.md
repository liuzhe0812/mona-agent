# 共享产物目录与会话右侧栏 — 最终执行计划

> 状态：最终执行方案  
> 日期：2026-07-22  
> 适用范围：普通非项目会话、项目会话的产物展示、历史工作区迁移  
> 关联设计：`docs/design/session-project-workspace.md`

## 一、结论

该功能有明确价值，现有架构也支持落地，不需要新增数据库、文件索引服务或常驻文件监听器。

最终采用以下模型：

- `workspace/` 保留为 Mona 工作区根目录。
- `workspace/output/` 是所有普通非项目会话共享的唯一产物根目录。
- 项目会话继续使用 `Session.metadata.workspace` 指向的项目目录，不写入共享 `output/`。
- PPT、视频等专用项目会话继续使用现有 `ppt_projects/`、`video_projects/` 工作流，不改目录语义。
- 会话区右侧栏逻辑始终挂载；无产物时收为紧凑提示条，有产物时显示列表。普通非项目会话读取 `workspace/output/` 的真实文件，项目会话继续显示当前项目范围内的显式交付文件。
- 文件系统是共享产物列表的唯一事实源，会话消息中的 `deliver_file` 和 `file_edit` 事件只用于实时刷新和项目会话展示。

该方案复用现有会话 workspace 路由、动态文件工具上下文、`WorkspacePanel`、`FilePreviewPanel` 和 WebSocket HTTP 接口，不引入第二套“产物记录系统”。

---

## 二、成功标准

完成后必须同时满足：

1. 任意普通非项目会话使用相对路径创建文件时，文件实际写入 `<workspace>/output/`。
2. 两个不同的普通非项目会话看到同一份共享产物列表。
3. 重启应用后，右侧栏仍能从磁盘恢复共享产物，不依赖会话历史；不超过 1000 个时全部显示，超过时明确截断并可直接打开 output 目录查看其余文件。
4. 项目会话仍在项目目录工作，不读取或污染共享 `output/`。
5. 普通非项目会话不能通过相对路径绕回 `workspace/` 根目录。
6. `AGENTS.md`、`SOUL.md`、`USER.md`、`HEARTBEAT.md`、`memory/`、`skills/` 不再被启动逻辑重新写回 workspace。
7. 文件预览接口必须鉴权，并拒绝绝对路径、`..`、符号链接逃逸和跨会话目录访问。
8. 历史工作区迁移不得静默覆盖或删除用户文件，迁移必须可审计、幂等并可恢复。

---

## 三、最终目录模型

```text
~/.mona/                              # Mona 全局配置与运行资源
├── config.json
├── memory/
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── USER.md
│   ├── MEMORY.md
│   └── history.jsonl
├── skills/
├── HEARTBEAT.md
├── media/
├── webui/
└── migration-backups/

~/.mona/workspace/                    # 可配置的 Mona 工作区根
├── output/                           # 普通非项目会话共享产物根
│   ├── 报告.docx
│   ├── 数据.xlsx
│   ├── generated/
│   │   └── 2026-07-22/
│   └── 子目录/其他产物
├── sessions/                         # 现有会话 JSONL，本次不迁移存储模型
├── cron/                             # 现有运行数据
├── schedule/                         # 现有运行数据
├── ppt_projects/                     # 专用 PPT 项目
├── video_projects/                   # 专用视频项目
└── .git/                             # 如已存在则保留，不在本次删除
```

用户配置的 `agents.defaults.workspace` 仍表示 workspace 根，不新增 `outputPath` 配置项。共享产物路径始终由 `<workspace>/output` 推导，避免两个可配置路径产生不一致。

---

## 四、会话分类与路径契约

| 会话类型 | 判断条件 | Agent 有效工作目录 | 右侧栏数据源 |
|---|---|---|---|
| 普通非项目会话 | 无 `metadata.workspace`，无专用 `agent_kind` | `<workspace>/output` | 共享 output 目录扫描结果 |
| 新会话首页 | 尚无 session | `<workspace>/output` | 共享 output 目录扫描结果 |
| 项目会话 | `metadata.workspace` 为非空绝对路径 | 项目目录 | 当前项目范围内的 `deliver_file` / `file_edit` |
| PPT 专用会话 | `agent_kind == "ppt"` | 保持现有 workspace/PPT 项目逻辑 | PPT 自有历史与预览界面 |
| 视频专用会话 | `agent_kind == "video"` | 保持现有 workspace/视频项目逻辑 | 视频自有历史与预览界面 |

路径选择只允许存在一个权威入口：`AgentLoop._effective_workspace()`。

目标逻辑：

```python
if session.metadata.workspace:
    return resolved_project_workspace
if session.metadata.agent_kind in {"ppt", "video"}:
    return configured_workspace_root
return shared_output_dir(configured_workspace_root)
```

`ContextBuilder`、主 Agent、Subagent、文件编辑追踪器和所有 workspace 相对路径工具必须读取同一个 contextvar 结果，禁止各自重新推导目录。

---

## 五、已核实的现状与缺口

### 5.1 已有能力

- `mona/agent/loop.py` 已通过 `_effective_workspace()` 和 `set_current_workspace()` 支持会话级 workspace。
- `mona/agent/tools/filesystem.py` 已从 `get_current_workspace()` 读取动态目录。
- `Session.metadata.workspace`、新建项目会话、项目分组和项目迁移 UI 已存在。
- `webui/src/components/thread/ThreadShell.tsx` 已挂载三栏布局，并能聚合交付文件和文件编辑事件。
- `WorkspacePanel`、`DeliveredFileCard`、`FilePreviewPanel` 已具备列表、预览、系统打开和定位能力。
- `mona/config/paths.py` 已把 memory、skills、heartbeat 定义在 workspace 外。

### 5.2 必须修复的缺口

1. `_effective_workspace()` 当前让普通会话直接使用 workspace 根，而不是 `workspace/output/`。
2. 右侧栏当前只聚合当前会话历史中的事件，无法显示其他会话或重启前未记录的磁盘文件。
3. `sync_workspace_templates()` 仍会创建 workspace 根下的 `AGENTS.md`、`memory/` 和 `skills/`。
4. `migrate_global_resources()` 目前只复制、不清理源路径，导致旧配置继续混在 workspace。
5. 以下工具仍使用构造时的静态 workspace，项目会话和新的 output 路由都可能解析错误：
   - `ExecTool`
   - `DeliverFileTool`
   - `MessageTool` 的本地媒体路径
   - `ChartTool`
   - `DataframeTool`
   - `DocumentTool`
   - `SkillAssetCopyTool`
6. 图片、视频和省略 output 参数的图表当前默认写入全局 media 目录，不会成为共享 output 中的用户产物。
7. `/api/file-preview` 当前接收任意绝对路径，没有 API token 校验和目录边界校验。
8. `ThreadShell` 在产物为空时完全隐藏入口，无法提供共享产物目录提示和稳定的访问位置。

---

## 六、后端实施设计

### 6.1 新增统一路径 helper

在 `mona/config/paths.py` 增加：

```python
def get_shared_output_dir(workspace: str | Path) -> Path:
    root = Path(workspace).expanduser().resolve()
    return ensure_dir(root / "output")
```

要求：

- 只负责推导并创建目录。
- 不接受独立 output 配置。
- 不把项目 workspace 自动追加 `/output`。
- 所有调用者必须传入已经确定的 Mona workspace 根，避免无参数调用忽略自定义 workspace。

### 6.2 修改 Agent 工作目录选择

修改 `mona/agent/loop.py::AgentLoop._effective_workspace()`：

- 普通会话返回 `self.workspace / "output"`。
- 项目会话保持 `metadata.workspace`。
- `ppt`、`video` 专用 agent 保持现有根目录语义。
- 返回路径必须 `expanduser().resolve()` 并确保目录存在。

同步更新 identity 中注入的 `workspace_path`。普通会话看到的路径应直接是 `workspace/output`，模型不需要知道 workspace 根结构。

### 6.3 完成动态 workspace 工具审计

复用现有 `get_current_workspace(fallback)`，不新增第二个 workspace 上下文。

| 工具/模块 | 当前状态 | 必须改动 |
|---|---|---|
| `_FsTool`、read/write/edit/list、apply_patch、find/grep | 已动态 | 保持并补回归测试 |
| `ExecTool` | 静态 `working_dir` | `_prepare_command()` 使用 active workspace 作为默认 cwd 和限制根 |
| `DeliverFileTool` | 静态 `_workspace` | 相对路径、边界校验和展示路径全部使用 active workspace；普通会话拒绝直接交付 output 外文件 |
| `MessageTool` | 静态 `_workspace` | 本地 media 相对路径使用 active workspace |
| `ChartTool` | 静态 `_workspace` | 显式 output 使用 active workspace；普通会话默认写入 `generated/` |
| `DataframeTool` | 静态 `_workspace` | 输入文件相对路径和限制根使用 active workspace |
| `DocumentTool` | 静态 `_workspace` | 输入文件相对路径和限制根使用 active workspace |
| `SkillAssetCopyTool` | 无会话 workspace | 相对目标使用 active workspace |
| Subagent | 已继承 contextvar | 验证普通会话继承 `workspace/output` |

限制模式下，`allowed_dir` 必须随 active workspace 变化。禁止出现“解析基于 output、边界仍基于 workspace 根”或相反的组合。

本功能把“普通会话产物”严格定义为 `workspace/output/` 内的文件。即使现有配置允许通过绝对路径访问外部文件，普通会话也不能直接把外部文件登记为产物；必须先复制或写入 active workspace。显式编辑外部绝对路径的既有能力不在本次改造范围内，这类文件不会进入产物栏。

### 6.4 图片、视频和图表产物

普通会话生成的用户产物必须进入共享 output：

```text
workspace/output/generated/YYYY-MM-DD/<artifact-id>.<ext>
```

实施规则：

- `store_generated_image_artifact()` 和 `store_generated_video_artifact()` 接受明确的 artifact root。
- 普通会话和项目会话使用 active workspace 下的 `generated/`。
- 专用 PPT/视频 agent 保持现有项目管线，不强行重定向到共享 output。
- 生成元数据可继续写入全局 media 元数据目录；右侧栏只展示用户可消费的图像、视频文件，不展示内部 sidecar。
- 不复制大视频形成双份 canonical 文件；用户产物文件作为 canonical，聊天媒体服务按现有机制签名或暂存。

### 6.5 共享产物扫描

新增一个无数据库的目录扫描函数，文件系统是事实源。

扫描规则：

- 根目录固定为当前配置 workspace 的 `output/`。
- 递归返回普通文件，按 `mtime` 降序、相对路径升序稳定排序。
- 不跟随符号链接；符号链接本身也不进入列表。
- 跳过任一路径分段以 `.` 开头的内部目录/文件，以及 `.tmp`、`.part`、尾随 `~` 的临时文件。
- 单个文件在扫描期间消失时跳过，不让整个请求失败。
- 返回所有扩展名，不继续使用前端的产物扩展名白名单。
- 设置 `MAX_ARTIFACT_FILES = 1000` 的返回保护上限；超出时返回最近修改的 1000 个并标记 `truncated: true`，右栏明确显示截断状态并提供“打开 output 目录”。
- 该上限只控制响应体和前端渲染量；按 `mtime` 选出最新文件仍需要遍历目录。首版不增加索引、mtime 分页或虚拟列表，出现实测瓶颈后再升级。

返回结构复用并扩展 `DeliveredFile`：

```json
{
  "files": [
    {
      "path": "子目录/报告.docx",
      "absolute_path": "D:/.../workspace/output/子目录/报告.docx",
      "name": "报告.docx",
      "size": 12048,
      "size_human": "11.8 KB",
      "mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "modified_at": "2026-07-22T10:00:00+08:00"
    }
  ],
  "truncated": false
}
```

### 6.6 HTTP API

在 WebSocket 同端口 HTTP surface 增加：

#### `GET /api/artifacts`

- 必须通过现有 API token 鉴权。
- 只返回共享 `workspace/output/` 的扫描结果。
- 不接受客户端传入 root 或任意 workspace 路径。

#### 收紧 `GET /api/file-preview`

新参数：

```text
scope=shared|project
session_key=<websocket session key，仅 project 必需>
path=<相对路径>
```

规则：

- 必须通过 API token 鉴权。
- `path` 必须是相对路径，拒绝空路径、绝对路径和 `..`。
- `scope=shared` 的根固定为 `workspace/output/`。
- `scope=project` 必须读取 `session_key` 的 `metadata.workspace` 作为根。
- `resolve()` 后再次执行 `relative_to(root)`，阻断符号链接逃逸。
- 非 WebSocket session、未知 session、已清空项目绑定的 session 返回 404。
- 保留 `X-Content-Type-Options: nosniff` 和安全 MIME 处理。
- `.html`、`.htm` 首版强制以 `text/plain; charset=utf-8` 返回，只预览源码，不执行页面，也不加载相对 CSS、图片或脚本。

前端不再直接把绝对路径放进 iframe/img URL。`FilePreviewPanel` 使用带 Authorization header 的 fetch 获取 Blob，再创建对象 URL；HTML Blob 显式使用 `text/plain`。组件卸载或切换文件时调用 `URL.revokeObjectURL()`。首版不注入 `<base>`，也不改写 HTML 内的相对资源；如果后续必须渲染完整网页，再单独设计受限目录预览路由、sandbox 和 CSP。

---

## 七、前端实施设计

### 7.1 新增共享产物 hook

新增 `webui/src/hooks/useArtifacts.ts`：

- 初次进入会话区时请求 `/api/artifacts`。
- 暴露 `files`、`loading`、`error`、`truncated`、`refresh()`。
- 不轮询，不创建文件监听器。
- 在任务 `turn_end` 后刷新一次。
- 在 workspace 设置更新并重启后重新获取。
- 右栏提供手动刷新按钮，用于显示应用外部写入的文件。
- 用户停留在会话 B 时，会话 A 后台写入不会强制刷新 B；首版接受该短暂陈旧状态，由切换会话、当前任务 `turn_end` 或手动刷新收敛。

### 7.2 ThreadShell 数据选择

普通非项目会话与新会话首页：

- 右栏以 `/api/artifacts` 返回值为准。
- 当前 turn 中的 `deliver_file` / `file_edit` 可临时合并以获得即时反馈。
- 仅合并位于共享 output 根内的事件文件；`turn_end` 后以服务器扫描结果校正。
- 不从历史消息重建共享列表，避免会话切换造成文件缺失或重复。

项目会话：

- 不扫描整个项目目录，避免把源码、依赖和构建目录全部当作产物。
- 保留现有显式交付与文件编辑事件聚合。
- 只显示绝对路径位于当前 `session.workspace` 内的条目，避免会话改绑项目后显示旧 scope 文件。

### 7.3 右栏行为

- 会话区中右栏组件逻辑始终挂载，不再因 `files.length === 0` 返回 `null`。
- 无文件时视觉上收为紧凑提示条，显示产物目录提示，不占用完整右栏宽度。
- 有文件时显示列表；保留并尊重用户手动折叠状态，不因刷新反复强制展开。
- 标题统一为“产物”，显示文件数、刷新按钮、打开目录按钮和折叠按钮。
- 普通会话显示相对 `output/` 的路径；同名文件位于不同子目录时必须能区分。
- 默认按最近修改排序，不增加搜索、标签、分组和文件树交互。
- 达到返回上限时显示“仅显示最近 1000 个文件”，不能静默截断。

### 7.4 预览与系统打开

- 普通文本和图片通过鉴权 fetch + Blob URL 预览。
- HTML 首版按源码文本预览，不注入 `<base>`，不拦截或改写相对资源。
- 不支持内嵌预览的格式继续使用系统应用打开。
- Tauri 打开/定位使用 API 返回的 `absolute_path`。
- Web 版没有系统打开能力时只显示可用操作，不渲染无效按钮。
- 文件已删除时显示明确错误并触发一次列表刷新。

---

## 八、历史数据迁移

### 8.1 启动顺序修正

当前“先同步 workspace 模板、再迁移全局资源”的顺序会反复制造混杂。新顺序必须是：

1. 确保 workspace 根存在。
2. 先执行全局资源迁移，保留用户自定义内容。
3. 在 `~/.mona/` 下补齐缺失的全局模板。
4. 创建 `workspace/output/`。
5. 执行一次性 loose artifact 迁移。
6. 启动 SessionManager、AgentLoop 和 channel。

新增 `sync_global_templates()`，替换运行时所有 `sync_workspace_templates()` 调用。新函数写入：

- `get_memory_dir()/AGENTS.md`
- `get_memory_dir()/SOUL.md`
- `get_memory_dir()/USER.md`
- `get_memory_dir()/MEMORY.md`
- `get_memory_dir()/history.jsonl`
- `get_heartbeat_path()`
- `get_skills_dir()`

Memory GitStore 已在 `MemoryStore` 中以 global memory 目录为根，不再在 workspace 根初始化新的 GitStore。

### 8.2 workspace 根目录迁移规则

迁移版本：`workspace-output-v1`。

保留在 workspace 根、不移入 output 的已知条目：

```text
output/
sessions/
cron/
schedule/
ppt_projects/
video_projects/
.git/
.gitignore
.mona/
```

全局资源条目先迁移到 `~/.mona/`，然后从 workspace 根移走：

```text
AGENTS.md
SOUL.md
USER.md
HEARTBEAT.md
memory/
skills/
```

剩余非保留的顶层文件和目录按原相对结构移动到 `workspace/output/`。这是旧版本普通会话的工作内容，也是需要整理的 legacy artifact。

### 8.3 数据安全规则

- 禁止覆盖目标已有文件。
- 目标不存在时优先使用同卷原子移动。
- 目标冲突时，把源文件移动到 `~/.mona/migration-backups/workspace-output-v1/<timestamp>/`，记录冲突，不自行改名覆盖。
- 每次迁移写入 JSON manifest，记录旧绝对路径、新绝对路径、文件大小、迁移结果和错误。
- 全部成功后才写完成标记；中断后再次启动按 manifest 幂等续跑。
- 不删除迁移备份。
- 如果 workspace 根是用户 Git 仓库且 Git index 中存在非 Mona 全局资源的已跟踪文件，停止 loose artifact 自动迁移，写 `manual_required` 状态；仍启用新的 output 路径，避免修改用户项目布局。

### 8.4 历史路径兼容

不批量重写 Session JSONL 和 WebUI transcript，避免扩大数据损坏面。

读取历史会话时：

- 若 `deliveredFiles.absolute_path` 或 `fileEdits.absolute_path` 已不存在，查询迁移 manifest 的旧→新映射。
- 命中映射后，仅在返回给前端的 UI payload 中替换路径。
- 原始 transcript 保持不变。
- 未命中映射时保留现有“文件不存在”行为。

该兼容层至少保留一个正式版本周期；确认升级用户无回退需求后再单独决定是否移除。

### 8.5 修改 workspace 设置

`mona/webui/settings_api.py::_migrate_workspace_data()` 调整为：

- 非破坏性复制旧 `sessions/` 到新 workspace。
- 非破坏性复制旧 `output/` 到新 workspace 的 `output/`。
- 不再复制 `memory/` 和 `skills/`，它们已经是全局资源。
- 任一关键复制失败时不保存新的 workspace 配置。
- 源 workspace 保留，由用户确认后自行清理。

---

## 九、实施阶段与文件清单

### 阶段 1：建立路径契约

目标：所有普通会话先稳定落到 `workspace/output/`。

改动：

- `mona/config/paths.py`
  - 新增 `get_shared_output_dir()`。
- `mona/agent/loop.py`
  - 修改 `_effective_workspace()`，保留项目和专用 agent 分支。
- `mona/agent/context.py`
  - 验证 identity 注入的是 effective workspace。
- `mona/agent/subagent.py`
  - 验证继承 active workspace。

阶段验收：普通会话 write_file、apply_patch、subagent 写文件均只落在 output；项目会话路径不变。

### 阶段 2：修复所有静态 workspace 工具

分两批实施，降低单次改动面：

第一批处理高频和交付链路：

- `mona/agent/tools/shell.py`
- `mona/agent/tools/deliver_file.py`
- `mona/agent/tools/message.py`

第二批处理其余读取、生成和复制工具：

- `mona/agent/tools/chart.py`
- `mona/agent/tools/dataframe.py`
- `mona/agent/tools/document.py`
- `mona/agent/tools/skill_tools.py`
- `mona/agent/tools/image_generation.py`
- `mona/agent/tools/video_generation.py`
- `mona/utils/artifacts.py`

测试不机械展开成“工具 × 模式”的全部组合：用一组参数化 active-workspace 契约测试覆盖公共行为，再为 `deliver_file`、shell 限制模式和本地媒体路径补专门测试。两批可以分别提交，但所有工具完成审计并使用同一个 active workspace 后才能发布。

阶段验收：第一批高频链路测试通过；第二批全部完成后，普通、项目和限制模式的路径契约通过发布门禁。

### 阶段 3：产物扫描和安全文件接口

改动：

- 建议新增 `mona/utils/artifact_listing.py`
  - 扫描、排序、过滤、数量限制和文件 DTO 构建。
- `mona/channels/websocket.py`
  - 新增 `/api/artifacts`。
  - 收紧 `/api/file-preview`。
  - 注入当前配置 workspace 根，不再依赖无参数 `get_workspace_path()`。
- `mona/channels/manager.py`
  - 向 WebSocketChannel 显式传递 workspace 根。

阶段验收：未鉴权、路径穿越、绝对路径、符号链接逃逸、跨项目预览全部失败；合法文件可列出和预览。

### 阶段 4：右侧栏改造

改动：

- `webui/src/lib/types.ts`
  - `DeliveredFile` 增加 `modified_at`。
- `webui/src/lib/api.ts`
  - 增加 artifact list 和 authenticated preview 请求。
- 新增 `webui/src/hooks/useArtifacts.ts`
- `webui/src/components/thread/ThreadShell.tsx`
  - 按会话类型选择数据源，任务结束后刷新。
- `webui/src/components/deliver/WorkspacePanel.tsx`
  - 逻辑常驻、空目录紧凑提示条、刷新和截断提示。
- `webui/src/components/deliver/FilePreviewPanel.tsx`
  - 改为鉴权 Blob 预览；HTML 强制按源码文本显示。
- `webui/src/components/deliver/filePreviewStore.ts`
  - 如需要，保存 preview scope/session key；不新增全局产物业务状态。

阶段验收：两个普通会话共享列表；重启后列表恢复；项目会话不显示共享 output；无产物时仅显示紧凑提示条；HTML 不执行且不请求相对资源。

### 阶段 5：迁移与初始化收口

改动：

- `mona/utils/helpers.py`
  - 新增 `sync_global_templates()`，停止向 workspace 写模板和初始化 Git。
- `mona/config/migrate_global.py`
  - 改为移动/备份语义，补 manifest 和幂等处理。
- 建议新增 `mona/config/migrate_workspace_output.py`
  - loose artifact 迁移、冲突备份和历史路径映射。
- `mona/cli/commands.py`
  - 修正 onboard、agent、gateway、CLI 启动顺序。
- `mona/webui/settings_api.py`
  - workspace 变更时迁移 sessions/output，不再迁移 memory。
- `mona/webui/transcript.py` 或 WebSocket replay 后处理
  - 使用 manifest 解析 legacy artifact 路径。

阶段验收：全新安装 workspace 根不生成全局配置；旧安装升级不丢文件；重复启动不重复迁移。

### 阶段 6：回归与发布门禁

全部检查通过后才能发布：

```text
python -m pytest tests/config/test_config_paths.py tests/agent/test_loop_tool_context.py tests/channels/test_websocket_http_routes.py tests/utils/test_webui_turn_helpers.py
python -m pytest
python -m ruff check mona tests
npm --prefix webui test
npm --prefix webui run lint
npm --prefix webui run build
Windows 本地升级烟测
全新安装烟测
```

---

## 十、测试计划

### 10.1 Python 单元测试

新增或扩展：

- `tests/config/test_config_paths.py`
  - 默认、自定义 workspace 的 output 推导。
- `tests/agent/test_loop_workspace.py`
  - 普通、项目、PPT、视频会话的 effective workspace。
- 现有 tool tests
  - exec、deliver_file、message、chart、dataframe、document、skill asset 的动态 workspace。
- `tests/utils/test_artifact_listing.py`
  - 递归、排序、隐藏文件、临时文件、符号链接、扫描中删除、截断。
- `tests/channels/test_websocket_channel.py`
  - artifact list 鉴权与返回格式。
  - preview 的 shared/project scope 和全部路径攻击用例。
  - HTML preview 强制返回 `text/plain`，不作为页面执行。
- `tests/config/test_workspace_output_migration.py`
  - 正常迁移、冲突备份、中断续跑、幂等、用户 Git 仓库停止条件。
- `tests/utils/test_webui_transcript.py`
  - legacy 路径通过 manifest 在响应时恢复。

### 10.2 前端测试

新增：

- `webui/src/tests/useArtifacts.test.tsx`
  - 初始加载、错误、刷新、turn_end 后刷新、截断状态。
- `webui/src/tests/workspace-panel.test.tsx`
  - 空目录紧凑提示条、有文件列表、排序、刷新、1000 文件截断提示和折叠状态。
- `webui/src/tests/file-preview-panel.test.tsx`
  - 鉴权 fetch、Blob URL、HTML 源码预览、切换/卸载 revoke、404 状态。
- 扩展 `thread-shell.test.tsx`
  - 新会话首页和两个普通会话共享文件。
  - 项目会话不混入共享 output。
  - 会话 workspace 改绑后过滤旧 scope 条目。

### 10.3 端到端烟测

1. 普通会话 A 创建 `报告.md`，验证物理路径是 `workspace/output/报告.md`。
2. 切换普通会话 B，右栏立即能看到同一文件。
3. 重启 Mona，右栏仍显示该文件。
4. 创建项目会话并写 `project/report.md`，验证共享 output 不出现该文件。
5. 普通会话生成图片、视频和图表，验证用户文件位于 output 并可预览。
6. 开启 `restrict_to_workspace`，验证 `../AGENTS.md`、workspace 根文件和其他项目文件都无法访问。
7. 使用中文路径、空格路径和 Windows 盘符进行完整测试。
8. 对旧 workspace 执行升级，核对迁移 manifest、备份和历史文件卡片。

---

## 十一、风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 只改 AgentLoop，静态工具仍写 workspace 根 | 目录继续混杂或项目文件写错 | 阶段 2 完成全工具审计后才允许合并 |
| 专用 PPT/视频 agent 被重定向 | 现有项目管线失效 | `_effective_workspace()` 明确保留 agent_kind 分支 |
| 图片/视频仍在 media 根 | “所有产物”不完整 | 生成工具接受 active artifact root，内部元数据与用户文件分离 |
| 自动迁移覆盖用户文件 | 数据损失 | 禁止覆盖、冲突移入全局备份、manifest、幂等续跑 |
| 移动旧文件导致历史卡片失效 | 老会话无法打开产物 | 响应时使用 manifest 映射，不重写原 transcript |
| 文件预览读取任意本地文件 | 高安全风险 | API token、相对路径、scope 根、resolve 后 containment、拒绝 symlink |
| HTML Blob 无法解析相对资源，且渲染任意页面扩大攻击面 | 页面预览不完整或引入安全问题 | 首版只显示 HTML 源码；有明确需求后再建设受限目录预览路由 |
| output 文件持续增长 | 扫描变慢、右栏拥挤 | 1000 文件返回上限、mtime 排序、手动刷新；不提前引入索引数据库 |
| 多会话同名文件覆盖 | 产物内容变化 | 不做自动版本化；模型写入前检查存在性，用户明确覆盖时才更新 |
| 扫描期间文件变化 | 单次列表不一致 | 单文件异常跳过，turn_end/手动刷新最终收敛 |
| 后台会话写入时当前会话列表短暂陈旧 | 新文件不会立即出现 | 接受最终一致；切换会话、turn_end 或手动刷新，不引入 watcher/轮询 |
| 自定义 workspace 未传到 WebSocket API | 扫描错误目录 | ChannelManager 显式注入配置 workspace 根 |

---

## 十二、明确不做的内容

本次不实现：

- 每会话独立子目录。
- 产物数据库、全文索引或搜索服务。
- 常驻目录 watcher 或定时轮询。
- 标签、收藏、云同步、版本历史。
- 自动清理或删除旧产物。
- 把整个项目源码目录展示为产物树。
- 在普通会话增加跨 shared/project scope 切换；项目产物继续从对应项目会话进入。
- 完整渲染带相对 CSS、图片或脚本的 HTML 页面。
- 为 output 增加第二个用户配置项。

当真实数据证明 1000 文件上限、手动刷新或平铺列表不足时，再单独增加索引、分页、轻量变更通知或文件树。只有出现明确的跨项目浏览需求时，才增加 scope 切换入口。

---

## 十三、回滚方案

- 代码回滚时保留 `workspace/output/`，产物本身不删除。
- 迁移 manifest 和 `migration-backups/` 不随应用卸载或版本回滚清理。
- 实现并测试一个内部 `restore_workspace_output_migration(manifest)`，按 manifest 把文件恢复到旧位置；不需要首版增加 UI 或 CLI 命令。
- 如果升级迁移失败，应用继续使用新 output 处理后续任务，同时在日志和 UI 显示迁移未完成，不得重复移动已成功条目。
- 发布前必须用一个全新 workspace 和一个包含旧配置、旧产物、冲突文件的升级 workspace 各完成一次回滚演练。

---

## 十四、最终完成定义

只有以下条件全部成立，任务才算完成：

- 后端、前端、迁移、鉴权和路径边界改动全部落地。
- 定向测试、全量测试、lint 和 production build 全部通过。
- 新安装与旧版本升级烟测通过。
- 普通会话、项目会话、PPT/视频专用会话的路径行为均有自动化测试。
- `/api/file-preview` 的任意路径读取问题已关闭。
- workspace 根不再由启动过程生成 AGENTS、memory、skills 等全局配置。
- 文档 `session-project-workspace.md` 中“默认会话直接使用 workspace 根”的旧描述同步更新为 `workspace/output/`。
