# Mona SFTP 功能补齐方案（单 SSH 模式）

> 范围：仅限单 SSH 会话下的 SFTP 功能，不涉及批量 SSH 和桌面模式

---

## 一、现状概览

### 已实现功能

| 功能 | 状态 |
|------|------|
| 双栏布局（本地 + 远程） | ✅ |
| 面包屑导航 + 路径编辑 | ✅ |
| 上级目录 / 根目录导航 | ✅ |
| 系统文件图标（扩展名缓存） | ✅ |
| 文件列表（名称/大小/权限/时间） | ✅ |
| 新建文件夹 | ✅ |
| 删除（文件/文件夹） | ✅ |
| 重命名 | ✅ |
| 单文件上传（文件选择器） | ✅ |
| 单文件下载（保存对话框） | ✅ |
| 传输进度条 | ✅ |

### 核心缺失

1. 无法多选文件、无右键菜单
2. 无复制/剪切/粘贴跨面板操作
3. 无法传输文件夹（递归）
4. 无传输队列管理
5. 无拖拽传输
6. 无文件属性/权限修改
7. 无隐藏文件切换
8. 无搜索/过滤

---

## 二、补齐方案

### P0 — 核心交互（必须实现）

#### 1. 多选 + 右键菜单

**前端改动**：`FilePane.tsx`

- **多选**：
  - 单击选中/取消选中当前行
  - `Ctrl+Click` 追加选中
  - `Shift+Click` 范围选中（从上次选中项到当前项）
  - `Ctrl+A` 全选
  - 点击空白区域取消全选
- **右键菜单**（使用 `@/components/ui/context-menu`）：
  - 打开（目录）
  - 下载 / 上传
  - 复制 / 剪切 / 粘贴
  - 重命名
  - 删除
  - 新建文件夹 / 新建文件
  - 显示隐藏文件（toggle）
  - 属性

**数据结构**：`FilePane` 新增 `selectedPaths: Set<string>` 替换 `selectedPath: string | null`，`lastSelectedIndex: number` 用于 Shift 范围选。

#### 2. 复制 / 剪切 / 粘贴

**前端改动**：`FileManager.tsx` 新增剪贴板状态

```typescript
interface ClipboardEntry {
  side: "local" | "remote";
  files: UnifiedFileItem[];
  mode: "copy" | "cut";
}
```

- **复制/剪切**：将选中文件信息存入剪贴板状态
- **粘贴**：
  - 同侧粘贴 = 本地复制/移动 或 远程 SFTP copy/move
  - 跨侧粘贴 = 上传或下载
  - 粘贴前检查目标路径是否已存在同名文件，弹出覆盖确认
- **快捷键**：`Ctrl+C` / `Ctrl+X` / `Ctrl+V`

**后端改动**：`commands.rs` 新增

| 命令 | 参数 | 说明 |
|------|------|------|
| `sftp_copy` | session_id, src_path, dest_path | 远程文件复制（读取→写入） |
| `sftp_move` | session_id, src_path, dest_path | 远程文件移动（rename 封装） |

本地复制/移动使用 `@tauri-apps/plugin-fs` 的 `copyFile` / `rename`。

#### 3. 文件夹递归传输

**后端改动**：`commands.rs` + `sftp/client.rs`

新增命令：

| 命令 | 参数 | 说明 |
|------|------|------|
| `sftp_download_dir` | session_id, remote_path, local_path | 递归下载文件夹 |
| `sftp_upload_dir` | session_id, local_path, remote_path | 递归上传文件夹 |

实现思路：

```
sftp_download_dir:
  1. 创建本地目录
  2. sftp_list 获取远程目录内容
  3. 对文件：sftp_download → 写入本地
  4. 对子目录：递归调用
  5. 每传输一个文件，emit 进度事件

sftp_upload_dir:
  1. sftp_mkdir 创建远程目录
  2. local_list_dir 获取本地目录内容
  3. 对文件：读取本地 → sftp_upload
  4. 对子目录：递归调用
  5. 每传输一个文件，emit 进度事件
```

进度事件格式（复用现有 `sftp:transfer_progress`）：

```json
{
  "sessionId": "xxx",
  "path": "/remote/dir/file.txt",
  "direction": "upload" | "download",
  "bytesTransferred": 1024,
  "totalBytes": 2048,
  "currentFile": "file.txt",
  "filesCompleted": 3,
  "filesTotal": 10
}
```

**前端改动**：`FileManager.tsx`

- 上传/下载按钮支持选中文件夹时触发递归传输
- 拖拽文件夹到对侧面板触发递归传输
- 进度条显示当前文件名 + 总文件进度

#### 4. 传输队列管理

**前端改动**：`terminalStore.ts` 扩展 + 新增 `TransferQueue` 组件

数据结构：

```typescript
interface TransferTask {
  id: string;
  sessionId: string;
  type: "upload" | "download";
  sourcePath: string;
  destPath: string;
  fileName: string;
  isDir: boolean;
  status: "waiting" | "transferring" | "completed" | "error" | "cancelled";
  bytesTransferred: number;
  totalBytes: number | null;
  currentFile: string | null;
  filesCompleted: number;
  filesTotal: number;
  error: string | null;
  startedAt: number | null;
}
```

UI：

- FileManager 底部新增传输队列面板（可折叠）
- 每个任务显示：文件名、进度条、速度、状态
- 操作：取消、清除已完成、全部清除
- 多任务串行执行（避免并发导致带宽争抢）

**后端改动**：无需新增命令，复用 `sftp_download` / `sftp_upload` / `sftp_download_dir` / `sftp_upload_dir`，前端控制串行调度。

---

### P1 — 重要体验（应该实现）

#### 5. 拖拽传输

**依赖**：`@dnd-kit/core` + `@dnd-kit/sortable`（需新增依赖）

实现思路：

- 本地面板的文件可拖拽到远程面板 → 触发上传
- 远程面板的文件可拖拽到本地面板 → 触发下载
- 拖拽时显示半透明预览
- 放下时加入传输队列

**前端改动**：

- `FilePane.tsx`：每个 `FileRow` 包裹 `useDraggable`
- `FilePane.tsx`：面板容器使用 `useDroppable`
- `FileManager.tsx`：`DndContext` 包裹两个面板，`onDragEnd` 处理传输逻辑

#### 6. 文件属性对话框

**后端改动**：`commands.rs` 新增

| 命令 | 参数 | 说明 |
|------|------|------|
| `sftp_stat_detail` | session_id, path | 返回完整 stat 信息 |

返回结构：

```rust
pub struct FileStatDetail {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: u32,
    pub mode_string: String,       // "drwxr-xr-x"
    pub owner: String,
    pub group: String,
    pub atime: Option<String>,     // 访问时间
    pub mtime: Option<String>,     // 修改时间
}
```

**前端改动**：新增 `PropertiesDialog.tsx`

- 显示：文件名、类型、路径、大小、权限（八进制 + rwx）、所有者、组、时间
- 远程文件：通过 `sftp_stat_detail` 获取
- 本地文件：通过 `@tauri-apps/plugin-fs` 的 `stat` 获取

#### 7. 权限修改

**后端改动**：`commands.rs` 新增

| 命令 | 参数 | 说明 |
|------|------|------|
| `sftp_chmod` | session_id, path, mode, recursive | 修改文件权限 |
| `sftp_chown` | session_id, path, owner, group, recursive | 修改所有者 |

实现：通过 SFTP 的 `setstat` 方法设置权限，或通过 SSH 执行 `chmod` / `chown` 命令。

**前端改动**：新增 `PermissionsDialog.tsx`

- 权限矩阵（Owner/Group/Others × Read/Write/Execute）
- 八进制输入框
- 递归应用到子目录 checkbox
- 所有者/组选择（远程执行 `cut -d: -f1 /etc/passwd` 获取用户列表）

#### 8. 显示/隐藏隐藏文件

**前端改动**：`FilePane.tsx`

- 工具栏新增 👁 切换按钮
- 状态：`showHiddenFiles: boolean`（默认 false）
- 过滤逻辑：`files.filter(f => showHiddenFiles || !f.name.startsWith("."))`
- 本地和远程面板各自独立控制

---

### P2 — 体验优化（可选实现）

#### 9. 文件搜索/过滤

**前端改动**：`FilePane.tsx`

- 工具栏新增搜索输入框
- 输入时实时过滤当前目录文件（前端过滤，不请求后端）
- 匹配文件名（不区分大小写）

#### 10. 新建空文件

**后端改动**：`commands.rs` 新增

| 命令 | 参数 | 说明 |
|------|------|------|
| `sftp_touch` | session_id, path | 创建空文件 |

实现：`sftp_session.write(path, &[]).await`

**前端改动**：`FilePane.tsx` 右键菜单 + 工具栏新增"新建文件"按钮

#### 11. 状态栏

**前端改动**：`FilePane.tsx` 底部新增状态栏

- 显示：当前目录文件数、选中文件数、选中文件总大小

#### 12. 面板宽度可拖拽调整

**前端改动**：`FileManager.tsx`

- 两栏之间添加拖拽分隔条
- 拖拽时实时调整左右面板宽度比例
- 记住宽度比例到 localStorage

---

## 三、实施计划

### 阶段一：核心交互（P0）

| 序号 | 任务 | 涉及文件 | 工作量 |
|------|------|----------|--------|
| 1 | 多选逻辑（Ctrl/Shift/全选） | `FilePane.tsx` | 中 |
| 2 | 右键上下文菜单 | `FilePane.tsx` | 中 |
| 3 | 复制/剪切/粘贴 | `FileManager.tsx`, `commands.rs`, `ipc.ts` | 大 |
| 4 | 文件夹递归传输 | `commands.rs`, `sftp/client.rs`, `ipc.ts`, `FileManager.tsx` | 大 |
| 5 | 传输队列管理 | `terminalStore.ts`, 新增 `TransferQueue.tsx`, `FileManager.tsx` | 大 |

### 阶段二：重要体验（P1）

| 序号 | 任务 | 涉及文件 | 工作量 |
|------|------|----------|--------|
| 6 | 拖拽传输 | 安装 dnd-kit, `FilePane.tsx`, `FileManager.tsx` | 中 |
| 7 | 文件属性对话框 | `commands.rs`, 新增 `PropertiesDialog.tsx` | 中 |
| 8 | 权限修改 | `commands.rs`, 新增 `PermissionsDialog.tsx` | 中 |
| 9 | 显示/隐藏隐藏文件 | `FilePane.tsx` | 小 |

### 阶段三：体验优化（P2）

| 序号 | 任务 | 涉及文件 | 工作量 |
|------|------|----------|--------|
| 10 | 文件搜索/过滤 | `FilePane.tsx` | 小 |
| 11 | 新建空文件 | `commands.rs`, `FilePane.tsx` | 小 |
| 12 | 状态栏 | `FilePane.tsx` | 小 |
| 13 | 面板宽度可拖拽 | `FileManager.tsx` | 小 |

---

## 四、后端新增命令汇总

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `sftp_copy` | session_id, src, dest | () | 远程文件复制 |
| `sftp_move` | session_id, src, dest | () | 远程文件移动 |
| `sftp_download_dir` | session_id, remote_path, local_path | () | 递归下载文件夹 |
| `sftp_upload_dir` | session_id, local_path, remote_path | () | 递归上传文件夹 |
| `sftp_stat_detail` | session_id, path | FileStatDetail | 详细文件属性 |
| `sftp_chmod` | session_id, path, mode, recursive | () | 修改权限 |
| `sftp_chown` | session_id, path, owner, group, recursive | () | 修改所有者 |
| `sftp_touch` | session_id, path | () | 创建空文件 |

---

## 五、前端新增组件/文件汇总

| 文件 | 说明 |
|------|------|
| `FileManager/TransferQueue.tsx` | 传输队列面板 |
| `FileManager/PropertiesDialog.tsx` | 文件属性对话框 |
| `FileManager/PermissionsDialog.tsx` | 权限修改对话框 |
| `FileManager/ContextMenu.tsx` | 右键菜单（可选，也可内联在 FilePane） |

---

## 六、注意事项

1. **递归传输的取消机制**：后端递归传输需要支持中途取消。建议在 `TerminalState` 中维护一个 `cancellation_tokens: DashMap<String, CancellationToken>`，前端取消时设置 token，后端每次递归前检查 token。
2. **传输队列串行化**：前端使用队列管理器串行调度传输任务，避免并发传输导致带宽争抢和连接超时。
3. **大文件传输**：当前 `sftp_download` / `sftp_upload` 是一次性读取整个文件到内存。大文件需要改为流式传输（分块读写），后端已有 `download_file_with_progress` / `upload_file_with_progress` 方法但未暴露为 IPC 命令，应复用。
4. **跨面板粘贴**：复制本地文件 → 粘贴到远程 = 上传；复制远程文件 → 粘贴到本地 = 下载。需要自动判断方向。
5. **权限修改**：SFTP 协议的 `setstat` 支持设置权限，但 `chown` 可能需要 SSH exec 权限。如果 SFTP setstat 不支持 chown，则 fallback 到 SSH 执行 `chown` 命令。
6. **拖拽库选择**：`@dnd-kit/core` 是 React 生态最成熟的拖拽库，lztools 也使用它。需要确认与现有 UI 组件的兼容性。
