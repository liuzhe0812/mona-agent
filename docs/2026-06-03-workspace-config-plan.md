# 工作区路径配置功能开发计划

> 日期：2026-06-03
> 状态：规划中

## 1. 背景与目标

### 现状

- 工作区路径（`workspace`）定义在 `AgentDefaults.workspace`，默认 `~/.mona/workspace`
- 在 WebUI 设置-运行时页面中，工作区路径以 `ReadOnlyRow` 展示，用户无法修改
- 修改工作区只能通过手动编辑 `config.json` 或 CLI `--workspace` 参数
- `update_agent_settings` 白名单中不包含 `workspace` 字段

### 目标

允许用户在 WebUI 设置-运行时页面中修改工作区路径，修改后需重启生效。

## 2. 核心约束

| 约束 | 说明 |
|------|------|
| **必须重启生效** | workspace 在 AgentLoop 构造时绑定到所有工具实例，运行中无法热切换 |
| **路径安全校验** | 禁止根目录、系统关键目录、路径遍历，防止绕过 `restrict_to_workspace` 沙箱 |
| **新目录自动初始化** | 保存时若目录不存在，自动创建并同步模板 |
| **CLI 优先级不变** | CLI `--workspace` 参数仍覆盖配置文件中的值 |
| **会话数据不迁移** | 切换工作区后旧会话保留在原目录，不自动迁移 |

## 3. 涉及文件与改动

### 3.1 后端：`mona/webui/settings_api.py`

**改动**：在 `update_agent_settings` 函数中增加 `workspace` 字段处理

```python
# 在 tool_hint_max_length 处理之后添加
workspace = _query_first_alias(query, "workspace", "workspace")
if workspace is not None:
    workspace = workspace.strip()
    if not workspace:
        raise WebUISettingsError("workspace is required")
    expanded = Path(workspace).expanduser()
    # 安全校验
    _validate_workspace_path(expanded)
    if defaults.workspace != workspace:
        defaults.workspace = workspace
        changed = True
        restart_required = True
```

**新增校验函数** `_validate_workspace_path`：

```python
def _validate_workspace_path(path: Path) -> None:
    """Reject unsafe workspace paths."""
    resolved = path.resolve()
    # 禁止根目录
    if resolved == resolved.parent:
        raise WebUISettingsError("workspace cannot be the filesystem root")
    # 禁止用户 home 目录本身
    home = Path.home().resolve()
    if resolved == home:
        raise WebUISettingsError("workspace cannot be the user home directory")
    # 禁止路径遍历（配置值中含 ..）
    raw = str(path)
    if ".." in Path(raw).parts:
        raise WebUISettingsError("workspace path must not contain '..'")
    # Windows: 禁止系统关键目录
    if os.name == "nt":
        system_dirs = {
            Path(os.environ.get("SystemRoot", r"C:\Windows")).resolve(),
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")).resolve(),
            Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")).resolve(),
        }
        if resolved in system_dirs or any(resolved.is_relative_to(d) for d in system_dirs):
            raise WebUISettingsError("workspace cannot be inside a system directory")
```

**新增目录初始化逻辑**（保存后）：

```python
if changed:
    save_config(config)
    # 如果 workspace 变更，确保新目录存在并同步模板
    if "workspace" in query or "workspace" in query:
        from mona.config.paths import get_workspace_path
        from mona.cli.commands import sync_workspace_templates
        ws = get_workspace_path(config.workspace_path)
        ws.mkdir(parents=True, exist_ok=True)
        sync_workspace_templates(ws)
```

### 3.2 前端：`webui/src/components/settings/SettingsView.tsx`

**改动 1**：`AgentSettingsDraft` 增加 `workspace` 字段

```typescript
interface AgentSettingsDraft {
  model: string;
  provider: string;
  modelPreset: string;
  timezone: string;
  botName: string;
  botIcon: string;
  toolHintMaxLength: number;
  workspace: string;  // 新增
}
```

**改动 2**：`applyPayload` 中初始化 `workspace`

```typescript
setForm({
  // ...现有字段
  workspace: payload.runtime.workspace_path,
});
```

**改动 3**：`runtimeDirty` 计算中加入 workspace

```typescript
const runtimeDirty = useMemo(() => {
  if (!settings) return false;
  return (
    form.timezone !== settings.agent.timezone ||
    form.botName !== settings.agent.bot_name ||
    form.botIcon !== settings.agent.bot_icon ||
    form.toolHintMaxLength !== settings.agent.tool_hint_max_length ||
    form.workspace !== settings.runtime.workspace_path  // 新增
  );
}, [form, settings]);
```

**改动 4**：`saveRuntimeSettings` 中传递 workspace

```typescript
const payload = await updateSettings(token, {
  timezone: form.timezone,
  botName: form.botName,
  botIcon: form.botIcon,
  toolHintMaxLength: form.toolHintMaxLength,
  workspace: form.workspace,  // 新增
});
```

**改动 5**：`RuntimeSettings` 组件中将 `ReadOnlyRow` 改为可编辑

将：
```tsx
<ReadOnlyRow title={tx("settings.rows.workspacePath", "Workspace path")} value={settings.runtime.workspace_path} />
```

改为：
```tsx
<SettingsRow
  title={tx("settings.rows.workspacePath", "Workspace path")}
  description={tx("settings.help.workspacePath", "Changing the workspace requires a restart. Existing sessions will remain in the old directory.")}
>
  <Input
    value={form.workspace}
    onChange={(event) => setForm((prev) => ({ ...prev, workspace: event.target.value }))}
    className="h-8 w-[min(320px,70vw)] rounded-full text-[13px]"
  />
</SettingsRow>
```

### 3.3 前端：`webui/src/lib/api.ts`

**改动**：`updateSettings` 函数增加 `workspace` 参数传递

```typescript
if (update.workspace !== undefined) query.set("workspace", update.workspace);
```

### 3.4 前端：`webui/src/lib/types.ts`

**改动**：`SettingsUpdate` 接口增加 `workspace` 字段

```typescript
export interface SettingsUpdate {
  // ...现有字段
  workspace?: string;
}
```

## 4. 不需要改动的部分

| 文件 | 原因 |
|------|------|
| `mona/config/schema.py` | `workspace` 字段已存在，无需修改 |
| `mona/agent/loop.py` | 启动时读取 `config.workspace_path`，重启后自然生效 |
| `mona/agent/tools/filesystem.py` | 工具实例在 `create()` 时绑定 workspace，重启后重建 |
| `mona/agent/tools/path_utils.py` | 路径校验逻辑无需改动 |
| `mona/cli/commands.py` | CLI `--workspace` 优先级逻辑不变 |

## 5. 开发任务清单

### Phase 1：后端（预计 3 个任务）

- [ ] **T1**：在 `settings_api.py` 中实现 `_validate_workspace_path` 校验函数
- [ ] **T2**：在 `update_agent_settings` 中增加 `workspace` 字段处理逻辑，含校验和目录初始化
- [ ] **T3**：验证 `sync_workspace_templates` 可从 `settings_api` 模块正确调用（确认无循环导入）

### Phase 2：前端（预计 4 个任务）

- [ ] **T4**：`types.ts` 增加 `SettingsUpdate.workspace`，`api.ts` 增加 query 参数
- [ ] **T5**：`SettingsView.tsx` 中 `AgentSettingsDraft` 增加 `workspace`，更新 `applyPayload` 和 `runtimeDirty`
- [ ] **T6**：`RuntimeSettings` 组件中将 workspace 的 `ReadOnlyRow` 改为可编辑 `Input`
- [ ] **T7**：`saveRuntimeSettings` 中传递 `workspace` 参数

### Phase 3：测试与验证（预计 3 个任务）

- [ ] **T8**：手动测试——修改 workspace → 保存 → 重启 → 验证新路径生效
- [ ] **T9**：边界测试——输入根目录、空路径、含 `..` 路径、不存在的路径，验证校验拦截
- [ ] **T10**：回归测试——确认 CLI `--workspace` 仍能覆盖配置文件值

## 6. 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 用户输入恶意路径绕过沙箱 | `_validate_workspace_path` 多层校验：根目录、home、系统目录、路径遍历 |
| `sync_workspace_templates` 循环导入 | T3 专门验证，必要时用 lazy import |
| 用户切换 workspace 后找不到旧会话 | UI description 中明确提示"现有会话保留在原目录" |
| Windows 路径分隔符问题 | 后端统一用 `pathlib.Path`，前端传原始字符串由后端规范化 |

## 7. 后续可选增强（不在本期范围）

- **文件夹选择器**：Tauri 桌面端可集成原生文件夹选择对话框，替代手动输入
- **工作区切换器**：在 Sidebar 中提供快速切换最近使用的工作区
- **会话迁移**：可选地将旧工作区的活跃会话迁移到新路径
- **工作区模板同步状态**：显示当前工作区是否已同步最新模板
