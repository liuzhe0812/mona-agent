# Mona SSH IDE Mode 设计方案

> 状态：待评审  
> 目标：在 SSH 会话中提供轻量远程文件编辑能力，替代现有 Desktop 模式的简易文本编辑器。

---

## 一、背景与目标

Mona 当前已有：
- 基础 SSH/SFTP 终端能力
- Desktop 模式，内含一个基于 `<textarea>` 的远程文本编辑器，通过 SSH `cat`/`echo` 读写文件

OxideTerm 提供了成熟的 IDE Mode（文件树 + CodeMirror 6 + 远程 Agent），但其 Agent-first 架构与 Mona 当前基础设施差异较大，无法直接移植。

本方案目标：
- 基于 Mona 现有 SFTP 能力，实现一套轻量 IDE Mode
- 不引入 OxideTerm 远程 Agent（第一阶段）
- 满足用户指定的两栏交互布局

---

## 二、设计范围

### In Scope
- SSH 会话下的远程文件树浏览
- 可编辑文件的双击打开 / 右键“编辑文档”
- CodeMirror 6 多 Tab 编辑器
- 文件保存与基础冲突检测（mtime + size）
- IDE 区与 Shell 区上下分割、可拖动、可隐藏
- AI 助手侧边栏保持现有行为

### Out of Scope
- 远程 Agent（OxideTerm 的 `oxideterm-agent`）
- Git 状态显示与 Git 操作
- 本地文件树编辑
- 分屏终端
- AI 代码补全

---

## 三、总体架构

```
┌────────────────────────────────────────────────────────────────┐
│  Toolbar                                                  [AI]  │
├─────────────────┬──────────────────────────────────────────────┤
│                 │  Shell / Terminal (xterm.js)                 │
│  IdeFileTree    │  ─────────────────────────────────────────── │
│  (远程文件树)    │  IdeEditorPanel                              │
│                 │  ┌──────┬──────┬──────┐ [X]                 │
│                 │  │ Tab1 │ Tab2 │ ...  │                      │
│                 │  ├──────┴──────┴──────┤                      │
│                 │  │   CodeMirror 6      │                      │
│                 │  │   (按需语言包)       │                      │
│                 │  └────────────────────┘                      │
├─────────────────┴──────────────────────────────────────────────┤
│  StatusBar                                                     │
└────────────────────────────────────────────────────────────────┘
```

说明：
- 仅 **SSH 会话标签** 启用此布局；本地 Shell / SFTP / 批量 / Desktop 模式保持原 `TerminalView` 不变。
- 默认 IDE 区隐藏，Shell 占满右栏。
- 文件树宽度可拖动调整；IDE 区与 Shell 区分割线可拖动调整。
- 所有 Tab 关闭后 IDE 区自动隐藏。

---

## 四、后端设计

### 4.1 新增模块

```
src-tauri/src/terminal/ide/
├── mod.rs          # 模块导出
├── commands.rs     # Tauri IPC 命令
├── project.rs      # 项目根路径解析与缓存
└── conflict.rs     # 基于 mtime/size 的乐观锁检测
```

### 4.2 新增命令

| 命令 | 参数 | 返回值 | 说明 |
|---|---|---|---|
| `ide_open_project` | `session_id`, `path` | `ProjectInfo` | 验证远程目录存在，返回规范化的根路径、项目名 |
| `ide_check_file` | `session_id`, `path` | `FileCheckResult` | 判断文件是否可编辑：大小是否超过 10MB、是否二进制 |
| `ide_read_file` | `session_id`, `path` | `FileContentResult` | 通过 `SftpClient::download` 读取并尝试 UTF-8 解码 |
| `ide_write_file` | `session_id`, `path`, `content`, `expect_mtime`, `expect_size` | `WriteResult` | 保存前再次 `stat`，校验 mtime/size，一致则写入 |
| `ide_exec_command` | `session_id`, `command`, `cwd?` | `ExecResult` | 复用现有 SSH exec 通道，供后续 grep 等扩展 |

### 4.3 冲突检测

SFTP 无版本号，采用 **mtime + size 乐观锁**：

1. `ide_read_file` 返回内容时同时返回 `mtime` 和 `size`。
2. `ide_write_file` 保存前再次 `sftp.stat(path)`。
3. 若 `mtime != expect_mtime` 或 `size != expect_size`，返回 `FileModifiedExternally` 错误。
4. 前端捕获后弹出冲突对话框：覆盖远程 / 放弃本地修改 / 取消。

### 4.4 复用现有 SFTP 能力

`SftpClient` 已提供：
- `list_dir(path)` — 文件树
- `stat(path)` — 文件信息
- `download(path) -> Vec<u8>` — 读取文件
- `upload(path, data)` — 写入文件

新增命令均为薄封装，不修改现有 `SftpClient` 行为。

---

## 五、前端设计

### 5.1 新增组件

```
webui/src/components/ide/
├── IdeLayout.tsx          # 两栏布局容器（文件树 + 右栏）
├── IdeFileTree.tsx        # 远程文件树（基于 FilePane 改造）
├── IdeEditorPanel.tsx     # IDE 区容器：Tabs + CodeMirror + X 按钮
├── IdeEditor.tsx          # CodeMirror 6 封装
├── IdeConflictDialog.tsx  # 保存冲突弹窗
└── useIdeStore.ts         # IDE 专用 Zustand store
```

### 5.2 改造现有组件

- `TerminalView.tsx`：根据 `session.type` 判断渲染。
  - `ssh` → `IdeLayout`
  - 其他 → 原 TerminalView
- `Toolbar.tsx`：AI 助手按钮行为不变，正常触发右侧边栏。

### 5.3 IDE Store

```typescript
interface IdeTab {
  id: string;
  path: string;
  name: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
  isLoading: boolean;
  language: string | null;
  serverMtime: number | null;
  serverSize: number | null;
}

interface IdeState {
  sessionId: string | null;
  rootPath: string | null;
  tree: FileTreeNode[];
  expandedPaths: Set<string>;
  tabs: IdeTab[];
  activeTabId: string | null;
  ideVisible: boolean;

  openProject: (sessionId: string, path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  closeTab: (tabId: string) => void;
  saveFile: (tabId: string) => Promise<void>;
  setTabContent: (tabId: string, content: string) => void;
  hideIdePanel: () => void;
  showIdePanel: () => void;
}
```

### 5.4 关键交互

| 操作 | 行为 |
|---|---|
| 双击可编辑文件 | 新建 Tab 或激活已有 Tab，展开 IDE 区 |
| 右键文件 → 编辑文档 | 同上 |
| 关闭最后一个 Tab | 若 dirty → 弹窗提示保存；否则 IDE 区自动隐藏 |
| 点击 IDE 区 X 按钮 | 隐藏 IDE 区，Tab 保留 |
| Ctrl+S | 保存当前激活 Tab |
| 文件树宽度拖动 | 调整左栏文件树宽度 |
| IDE/SHELL 分割线拖动 | 调整右栏 Shell 与 IDE 区高度 |

### 5.5 文件树行为

- 异步加载目录，支持展开/折叠。
- 目录双击进入；文件双击尝试编辑。
- 右键菜单项：打开、编辑文档、下载、删除、重命名、新建文件夹、刷新、显示隐藏文件。
- 提供“显示隐藏文件”切换（默认关闭）。
- 不可编辑文件（二进制、超过 10MB）双击无反应或 toast 提示。

### 5.6 编辑器

- 基于 `@codemirror/view` + `@codemirror/state`。
- 语言包按需加载，参考 Oxideterm `languageLoader.ts` 模式实现 `mona/lib/codemirror/languageLoader.ts`。
- 主题跟随 Mona 当前主题（暗色用 `one-dark`，亮色自定义）。

---

## 六、数据流

### 6.1 打开文件

```
用户双击文件
  → useIdeStore.openFile(path)
    → ide_check_file(sessionId, path)
      → 返回 Editable / TooLarge / Binary
    → ide_read_file(sessionId, path)
      → SftpClient::download → UTF-8 解码
      → 返回 { content, mtime, size }
    → 创建 IdeTab，设置 activeTabId
    → ideVisible = true
  → IdeEditorPanel 渲染 CodeMirror
```

### 6.2 保存文件

```
用户 Ctrl+S
  → useIdeStore.saveFile(tabId)
    → ide_check_file 或 sftp_stat 获取最新 mtime/size
    → 与 Tab 中 serverMtime/serverSize 比较
      → 不一致 → 设置 conflictState → 弹窗
      → 一致 → ide_write_file(sessionId, path, content, mtime, size)
        → SftpClient::upload
        → 成功后返回新 mtime/size
    → 更新 Tab：originalContent = content, isDirty = false, serverMtime/size 更新
```

---

## 七、错误处理

| 场景 | 处理方式 |
|---|---|
| 网络断开 | 保存失败 toast；会话状态标记为断开 |
| 远程文件外部修改 | 冲突弹窗：覆盖 / 放弃 / 取消 |
| 文件超过 10MB | `ide_check_file` 返回 TooLarge，前端提示建议下载 |
| 二进制文件 | `ide_check_file` 返回 Binary，不可编辑 |
| 编码失败 | `ide_read_file` 返回错误，提示非文本文件 |
| 无写入权限 | 后端返回 `Permission denied`，前端 toast |
| Tab 关闭时 dirty | 弹窗提示保存 / 不保存 / 取消 |

---

## 八、测试策略

| 层级 | 内容 |
|---|---|
| Rust 单元测试 | `ide/conflict.rs`：mtime/size 比较逻辑 |
| | `ide/commands.rs`：参数校验与错误映射 |
| 前端单元测试 | `useIdeStore`：open/close/save/conflict 状态流转 |
| | `IdeEditor`：CodeMirror 渲染与内容变更 |
| 集成测试 | 本地 OpenSSH + 临时目录，端到端打开→编辑→保存 |
| 人工验收 | 大文件、二进制文件、冲突、断网、拖动分割场景 |

---

## 九、工作量估算

| 模块 | 人天 |
|---|---|
| 后端 `ide_*` 命令 + 冲突检测 | 3 |
| 前端 `IdeLayout` + `IdeFileTree` | 3 |
| 前端 `IdeEditorPanel` + Tabs + CodeMirror | 4 |
| 与 `TerminalView` / `terminalStore` 集成 | 2 |
| 测试 + 调优 | 2 |
| **合计** | **约 14 人天** |

---

## 十、风险与应对

| 风险 | 应对 |
|---|---|
| SFTP 大文件读取慢 | 10MB 可编辑上限；超过后提示下载到本地 |
| mtime 精度问题（秒级 vs 毫秒级） | 统一按秒比较；不同文件系统差异在 UI 中提示 |
| 多 Tab 状态复杂 | 独立 `useIdeStore`，与 `terminalStore` 解耦 |
| 与现有 Desktop 模式重复 | Desktop 保持现状；IDE Mode 面向 SSH 开发场景，后续可考虑合并 |

---

## 十一、未来扩展

1. **远程 Agent**：后续可引入 OxideTerm 风格的 Agent，提供 hash 乐观锁、`git status`、文件监听等。
2. **本地文件树**：扩展为支持本地工作区的完整 IDE。
3. **AI 工具集成**：让 Mona Agent 能够读取/修改当前打开的远程文件。

---

## 十二、已确认事项

- [x] 文件树宽度支持拖动调整。
- [x] 不实现书签/收藏功能。
- [x] 文件树提供“显示隐藏文件”切换，默认关闭。
- [x] IDE 区与 Shell 区默认各占 50% 高度。
