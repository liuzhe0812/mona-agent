# Notes Agent 工具模块设计方案

> 目标：让 agent 具备读写笔记、保存截图、生成图文笔记的能力，遵循"扩展放在边缘"原则，不改 agent core。

## 一、背景与目标

### 当前能力缺口

| 能力 | 现状 | 问题 |
|------|------|------|
| 写 .md 笔记到 vault | ❌ 无工具 | `filesystem` 受 workspace 限制，vault 不在 workspace 内 |
| 读笔记内容 | ⚠️ 仅前端 | agent 无法获取笔记正文供检索/引用 |
| 保存图片到 vault/assets | ⚠️ 仅前端 | `notes_save_image` Tauri 命令存在但未暴露给 agent |
| 截网页 | ✅ `browser_screenshot` | 截图存到 tempfile，需手动复制进 vault |
| 截桌面 | ❌ 无 | `browser_screenshot` 只能截 WebView2 tab |

### 目标场景

用户对 agent 说："截一张当前网页的图，写一篇图文笔记介绍这个页面"。agent 应能自主完成：

1. 截图 → 2. 保存图到 vault/assets → 3. 创建图文 .md 笔记

## 二、设计原则

1. **边缘扩展**：新增 `mona/agent/tools/notes.py`，不改 `agent/loop.py` / `agent/runner.py`
2. **复用现有 Tauri 命令**：尽量调用 Rust 侧已实现的命令，避免重复逻辑
3. **绕过 filesystem 限制**：vault 是受控目录，通过 Tauri IPC 调用是合理的
4. **最小依赖**：不引入新 Python 依赖；桌面截图作为可选能力单独评估
5. **不可删除**：agent 只能创建笔记，不能删除或修改已有笔记（避免误删/竞态）

## 三、能力清单

新增工具模块 `mona/agent/tools/notes.py`，包含 4 个工具类：

### 3.1 `notes_create` — 创建笔记

| 项 | 值 |
|---|---|
| 调用 | Tauri `notes_create_from_chat`（扩展 tags 参数） |
| 参数 | `title: string`（必填）、`content_markdown: string`（必填）、`notebook_name: string?`（可选，默认 `默认分类`）、`tags: string[]?`（可选） |
| 返回 | `note_id` + 文件相对路径 |
| 安全 | 写操作，受 `allow_create` 配置控制 |

### 3.2 `notes_search` — 搜索笔记

| 项 | 值 |
|---|---|
| 调用 | Tauri `notes_search_all` |
| 参数 | `query: string`（必填）、`limit: int?`（可选，默认 10） |
| 返回 | `[{noteId, title, snippet, notebookName}]` |
| 安全 | 只读，始终启用 |

### 3.3 `notes_read` — 读取笔记正文

| 项 | 值 |
|---|---|
| 调用 | **新增** Tauri `notes_read_note_content` |
| 参数 | `note_id: string`（必填） |
| 返回 | `{title, contentMarkdown, tags, notebookName, updatedAt}` |
| 安全 | 只读；按 `contextLevel` 过滤（`none` 不返回，`summary` 返回 preview） |

### 3.4 `notes_save_image` — 保存图片到 vault/assets

| 项 | 值 |
|---|---|
| 调用 | Tauri `notes_save_image` |
| 参数 | `file_path: string`（必填，源文件绝对路径）、`file_name: string?`（可选，默认从 file_path 派生） |
| 返回 | `assets/{file_name}`（markdown 引用路径） |
| 安全 | 写操作，受 `allow_create` 配置控制 |

**全程文件路径，零 base64**：Rust 侧 `fs::copy(src, dest)` 直接复制文件，不做任何字节编解码。Agent 调用流程：`browser_screenshot` 返回临时文件路径 → `notes_save_image(file_path=...)` → 拿到 `assets/xxx.png` → `notes_create(content="![](assets/xxx.png)")`。

> **设计取舍**：不提供 `notes_append`。理由：(1) read-merge-write 有并发竞态；(2) Obsidian 原子化笔记理念鼓励新建而非堆叠；(3) 若需合并，agent 可 `notes_read` 拿原文后在回复中拼接，让用户决定是否创建新笔记。

## 四、Rust 侧改动

### 4.1 新增命令

#### `notes_read_note_content`

```rust
#[tauri::command]
pub async fn notes_read_note_content(note_id: String) -> Result<NoteContent, String>
```

- 扫描 vault 找 `id == note_id` 的 .md 文件（复用 `scan_vault_notes`）
- 解析 frontmatter 拿元数据
- 按 `contextLevel` 过滤：`none` 返回错误"笔记不参与检索"；`summary` 返回 `preview`；`full` 返回完整 `content_markdown`
- 返回结构：`{title, contentMarkdown, tags, notebookName, updatedAt, contextLevel}`

### 4.2 扩展现有命令

#### `notes_create_from_chat` 增加 `tags` 参数

当前签名：
```rust
pub async fn notes_create_from_chat(
    title: String,
    content_markdown: String,
    notebook_id: Option<String>,
) -> Result<String, String>
```

扩展为：
```rust
pub async fn notes_create_from_chat(
    title: String,
    content_markdown: String,
    notebook_id: Option<String>,
    tags: Option<Vec<String>>,  // 新增，默认空数组
) -> Result<String, String>
```

- 在构造 `OperationNote` 时把 `tags` 写入
- `serialize_frontmatter` 已支持 tags 序列化

### 4.3 命令注册

在 `src-tauri/src/lib.rs` 的 `tauri::generate_handler!` 宏中新增：
- `notes_read_note_content`

## 五、Python 侧实现

### 5.1 文件结构

```
mona/agent/tools/notes.py   # 新增
```

ToolLoader 自动发现机制（`loader.py`）会自动加载，`_SKIP_MODULES` 不含 `notes`。

### 5.2 IPC Bridge 复用

复用 `browser.py:30-65` 的 `_tauri_invoke(cmd, args)` 实现：

```python
from pathlib import Path
import urllib.request
import json

_IPC_PORT_FILE = Path.home() / ".mona" / "ipc_bridge_port"
_DEFAULT_IPC_PORT = 17860

def _read_ipc_port() -> int:
    try:
        text = _IPC_PORT_FILE.read_text().strip()
        return int(text) if text else _DEFAULT_IPC_PORT
    except Exception:
        return _DEFAULT_IPC_PORT

def _tauri_invoke(cmd: str, args: dict) -> Any:
    port = _read_ipc_port()
    payload = json.dumps({"cmd": cmd, "args": args}).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    if "error" in body:
        raise RuntimeError(body["error"])
    return body.get("result")
```

**实现时直接从 `browser.py` 抽取为共享 helper**（如 `mona/agent/tools/tauri_ipc.py`），避免重复。这是必要的最小重构，不属于过度抽象。

### 5.3 工具类骨架

```python
class _NotesToolBase(Tool):
    _scopes = {"core"}
    _plugin_discoverable = True

    @classmethod
    def enabled(cls, ctx) -> bool:
        notes_cfg = getattr(ctx.config, "notes_tools", None)
        return notes_cfg is None or notes_cfg.enabled

class NotesCreateTool(_NotesToolBase):
    # name="notes_create"
    # 调 _tauri_invoke("notes_create_from_chat", {...})
    ...

class NotesSearchTool(_NotesToolBase):
    # name="notes_search"
    # read_only=True
    # 调 _tauri_invoke("notes_search_all", {...})
    ...

class NotesReadTool(_NotesToolBase):
    # name="notes_read"
    # read_only=True
    # 调 _tauri_invoke("notes_read_note_content", {...})
    ...

class NotesAppendTool(_NotesToolBase):
    # name="notes_append"
    # 调 _tauri_invoke("notes_append_to_note", {...})
    ...

class NotesSaveImageTool(_NotesToolBase):
    # name="notes_save_image"
    # 调 _tauri_invoke("notes_save_image", {...})
    ...
```

### 5.4 参数 Schema

使用 `tool_parameters_schema` 工厂（参考 `schedule.py:17-21`）：

```python
parameters = tool_parameters_schema(
    StringSchema("title", required=True, description="笔记标题"),
    StringSchema("content_markdown", required=True, description="Markdown 正文"),
    StringSchema("notebook_name", required=False, description="笔记本名（文件夹名），默认"默认分类""),
    ArraySchema("tags", StringSchema, required=False, description="标签列表"),
)
```

## 六、配置

在 `mona/config/schema.py` 新增：

```python
class NotesToolsConfig(Base):
    enabled: bool = True
    allow_create: bool = True    # notes_create / notes_save_image
```

在主 `Config` 模型上加字段：
```python
notes_tools: NotesToolsConfig = NotesToolsConfig()
```

工具类通过 `ctx.config.notes_tools` 读取配置，分级开关控制写操作。

## 七、桌面截图（可选，单独评估）

### 现状

`browser_screenshot` 只能截 WebView2 tab，无法截桌面或 Mona 自身界面。

### 方案

若用户需要桌面截图，新增 `desktop_screenshot` 工具：

| 项 | 值 |
|---|---|
| 依赖 | `mss`（纯 Python，约 50KB，符合轻量依赖红线） |
| 参数 | `monitor: int?`（默认 1，主屏） |
| 实现 | `mss.mss().grab(monitor)` → PNG bytes → 调 `notes_save_image` |
| 返回 | `assets/{file_name}` |

**当前不在主方案范围内**，作为后续可选增强。需要时单独提 PR。

## 八、安全边界

| 风险 | 缓解 |
|------|------|
| agent 误删笔记 | 工具集不含删除能力；删除仍由前端 UI 操作 |
| 图片写入越权 | `notes_save_image` 只能写 vault/assets，路径受 Rust 控制 |
| 大量笔记写入 | 配置 `allow_create` 可关闭；agent 上下文窗口限制单次写入量 |
| 截图隐私 | 桌面截图暂不实现；网页截图复用 `browser_screenshot` 的现有边界 |
| vault 未配置 | 所有工具先调 `notes_vault_get_path`，无 vault 时返回明确错误 |

## 九、实施步骤

### 阶段 1：Rust 侧（保证可编译）

1. `notes.rs` 新增 `notes_read_note_content` 命令
2. `notes.rs` 扩展 `notes_create_from_chat` 加 `tags` 参数
3. `lib.rs` 注册 1 个新命令
4. `cargo check` 验证

### 阶段 2：Python 工具层

1. 新建 `mona/agent/tools/tauri_ipc.py`（抽取共享 IPC helper）
2. `browser.py` 改为引用共享 helper（最小改动）
3. 新建 `mona/agent/tools/notes.py`（4 个工具类）
4. `mona/config/schema.py` 加 `NotesToolsConfig`
5. 启动验证工具是否被 ToolLoader 发现

### 阶段 3：验证

1. 手动测试：让 agent 执行"创建一篇笔记"
2. 手动测试：让 agent 执行"搜索关于 X 的笔记"
3. 手动测试：让 agent 执行"截当前网页，写一篇图文笔记"
4. 确认 `notes_save_state` 全量保存不会覆盖 agent 创建的笔记（scan_vault 会重新发现）

## 十、验证清单

- [ ] `cargo check` 通过
- [ ] Python 工具模块被 ToolLoader 自动发现
- [ ] agent 能创建笔记，frontmatter 格式正确
- [ ] agent 能搜索笔记，结果按 contextLevel 过滤
- [ ] agent 能读取笔记正文
- [ ] agent 能追加内容到笔记，updatedAt 更新
- [ ] agent 能保存图片到 vault/assets，markdown 引用正确
- [ ] 网页截图 → 保存图片 → 写笔记 全链路打通
- [ ] vault 未配置时返回明确错误
- [ ] 配置关闭后工具不可用

## 十一、风险与回滚

| 风险 | 影响 | 回滚 |
|------|------|------|
| IPC bridge 端口读取失败 | 工具不可用 | 回退默认端口 17860 |
| 新增 Rust 命令有 bug | 笔记读写异常 | 注释掉 `lib.rs` 注册行 |
| agent 滥用写工具 | 笔记污染 | 关闭 `allow_create` 配置 |
| `notes_save_state` 与 agent 创建冲突 | 覆盖丢失 | scan_vault 机制保证不会丢失，但需测试并发场景 |

## 十二、使用示例

### 场景 1：纯文本笔记

```
用户：把刚才讨论的架构方案写成笔记

agent 流程：
1. notes_create(title="架构方案", content_markdown="# 架构方案\n\n...")
   → 返回 note_id
2. 回复用户："已创建笔记《架构方案》"
```

### 场景 2：图文笔记

```
用户：截一张当前网页的图，写一篇图文笔记介绍这个页面

agent 流程：
1. browser_screenshot(tabId="current")
   → 返回 /tmp/mona-browser-screenshots/screenshot_xxx.png
2. notes_save_image(image_data_base64=<读文件转base64>)
   → 返回 assets/abc123.png
3. notes_create(
     title="网页介绍",
     content_markdown="# 网页介绍\n\n![截图](assets/abc123.png)\n\n这个页面...",
     tags=["截图", "网页"]
   )
   → 返回 note_id
4. 回复用户："已创建图文笔记《网页介绍》"
```

### 场景 3：检索 + 引用

```
用户：找到我之前写的架构笔记，结合今天的讨论补充一下

agent 流程：
1. notes_search(query="架构")
   → 返回 [{noteId, title, snippet}]
2. notes_read(note_id="note-xxx")
   → 返回原内容
3. 在回复中拼接原内容 + 新想法，提示用户
4. notes_create(title="架构方案 v2", content_markdown=拼接后的内容)
   → 创建新笔记，保留原子化结构
```
