# SFTP 传输进度监控设计文档

## 背景

Mona 的 SFTP 文件管理器当前缺少完整的传输进度监控。用户拖拽上传/下载时，无法看到实时进度、速度、ETA 等信息。lztools 项目已实现了一套成熟的进度监控体系，本设计参考其架构，结合 Mona 现有基础设施进行轻量改造。

## 目标

1. 拖拽上传/下载时显示实时进度条、速度、已传输/总大小
2. 支持多文件传输的任务管理（当前文件、已完成数/总数）
3. 支持取消传输
4. 传输任务面板内嵌在 FileManager 底部
5. 产品力不低于 lztools

## 现状分析

### Mona 已有基础设施

| 层级 | 已有内容 |
|------|----------|
| 后端 | `upload_file_with_progress` / `download_file_with_progress`（分块传输 + `sftp-transfer-progress` 事件） |
| 后端 | `upload_file_streaming` / `download_file_streaming`（流式 + `mpsc::Sender<FileTransferProgress>` + `CancellationToken` + 暂停支持） |
| 后端 | `BatchTransferManager`（取消/暂停/恢复能力） |
| 后端 | `SftpClient::create_sftp_channel()`（创建独立 SFTP session，避免锁冲突） |
| 前端 | `onSftpTransferProgress` 已监听 `sftp-transfer-progress` 事件 |
| 前端 | `terminalStore` 已有 `transferProgress: Record<string, TransferProgress>` |
| 前端 | `FileManager.tsx` 底部有简单的进度条显示（仅百分比，无任务概念） |

### Mona 缺少的

- 前端没有 `TransferTask` 状态机（waiting/transferring/completed/error/cancelled）
- 没有速度计算、ETA
- 没有取消按钮
- 没有文件级进度展开
- 拖拽上传走 `sftpUpload(data: number[])`（内存模式），没有走流式传输
- 下载也是一次性返回 `number[]`

## 方案选择：方案 A（轻量改造）

复用 Mona 已有的后端进度基础设施，重点改造前端。后端改动最小，前端新建 `TransferPanel` 组件和 `TransferTask` 状态模型。

## 已识别风险与应对

### 风险 1：SFTP Session 锁冲突（已解决）

**问题**：`SftpClient.session` 是 `Arc<Mutex<Option<SftpSession>>>`。现有方法（`download`、`upload`、`list_dir` 等）都先 `lock()` 获取 guard 再调用 session 方法。流式传输是长时间操作，如果持有 Mutex guard 整个传输过程，其他 SFTP 操作会被阻塞。

**解决方案**：`SftpClient` 已有 `create_sftp_channel()` 方法，可以为每次传输创建独立的 SFTP session。新命令使用独立 session 进行流式传输，不占用主 session 锁。`upload_file_streaming` / `download_file_streaming` 接收 `&SftpSession` 引用，直接传入独立 session 即可。

### 风险 2：CancellationToken 注册（已解决）

**问题**：`sftp_cancel_transfer` 需要通过 `task_id` 找到对应的 `CancellationToken`。当前 `BatchTransferManager.active_transfers` 用 `batch_id` 做 key，不适合单文件传输场景。

**解决方案**：在 `TerminalState` 中新增 `transfer_cancels: Arc<RwLock<HashMap<String, CancellationToken>>>` 字段。新命令启动传输时注册 cancel token，传输完成或取消后移除。

### 风险 3：内存模式上传无进度（已解决）

**问题**：拖拽系统文件时 `File.path` 不可用（`dragDropEnabled: false`），只能用 `arrayBuffer()` + `sftpUpload(data: number[])`。当前 `sftp_upload` 命令调用 `SftpClient::upload()`，内部直接 `write_all`，没有进度事件。

**解决方案**：改造 `SftpClient::upload()` 方法，使用与 `upload_file_with_progress` 相同的分块写入 + 进度发射模式。新增 `app_handle`、`session_id`、`task_id` 参数。同时保留无进度版本作为内部方法。

### 风险 4：目录传输无进度（已知，本次不解决）

**问题**：`sftp_upload_dir` / `sftp_download_dir` 是递归调用，前端无法获知目录内文件总数和当前进度。

**应对**：本次迭代中，`TransferPanel` 对目录传输显示"传输中..."的简单状态（indeterminate 进度条），不显示具体百分比。后续迭代可改造为逐文件调用流式命令。

## 详细设计

### 1. 后端改动

#### 1.1 `TerminalState` 新增 `transfer_cancels` 字段

```rust
// src-tauri/src/terminal/mod.rs
pub struct TerminalState {
    pub manager: SessionManager,
    pub known_hosts: Arc<KnownHostsStore>,
    pub approval: ApprovalState,
    pub batch_transfer: BatchTransferManager,
    pub transfer_cancels: Arc<RwLock<HashMap<String, CancellationToken>>>,  // 新增
}
```

#### 1.2 新增 `sftp_upload_file` 命令（流式上传）

用于本地文件上传到远程，支持进度和取消：

```rust
#[tauri::command]
pub async fn sftp_upload_file(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    task_id: String,
) -> Result<(), String>
```

实现要点：
1. 从 `state.manager` 获取 `SftpClient`
2. 调用 `client.create_sftp_channel()` 创建独立 SFTP session（避免主 session 锁冲突）
3. 创建 `CancellationToken`，注册到 `state.transfer_cancels`
4. 创建 `mpsc::channel::<FileTransferProgress>` 进度通道
5. 启动后台任务：从进度通道读取数据，通过 `app_handle.emit("sftp:transfer:{session_id}:{task_id}", ...)` 发射进度事件
6. 调用 `upload_file_streaming(&sftp, &local_path, &remote_path, Some(progress_tx), Some(cancel_token), None)`
7. 传输完成后从 `transfer_cancels` 移除 token

#### 1.3 新增 `sftp_download_file` 命令（流式下载）

用于远程文件下载到本地，支持进度和取消：

```rust
#[tauri::command]
pub async fn sftp_download_file(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    task_id: String,
) -> Result<(), String>
```

实现要点同上传，调用 `download_file_streaming`。

#### 1.4 新增 `sftp_cancel_transfer` 命令

```rust
#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: State<'_, TerminalState>,
    task_id: String,
) -> Result<(), String>
```

从 `state.transfer_cancels` 中查找并触发 `CancellationToken`。

#### 1.5 改造 `sftp_upload` 命令（内存模式增加进度）

当前签名：
```rust
pub async fn sftp_upload(
    state: State<'_, TerminalState>,
    session_id: String,
    remote_path: String,
    data: Vec<u8>,
) -> Result<(), String>
```

新增可选参数：
```rust
pub async fn sftp_upload(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    remote_path: String,
    data: Vec<u8>,
    task_id: Option<String>,  // 新增：传入时启用进度事件
) -> Result<(), String>
```

改造 `SftpClient::upload()` 方法：
- 新增 `upload_with_progress(app_handle, session_id, task_id, remote_path, data)` 方法
- 内部使用分块写入 + 进度发射（复用 `upload_file_with_progress` 的模式）
- 原有 `upload()` 保留为无进度版本，供内部调用

#### 1.6 进度事件格式

事件名：`sftp:transfer:{session_id}:{task_id}`

前端通过 `listen("sftp:transfer:{session_id}:{task_id}", handler)` 监听特定任务的事件，避免全局广播的性能问题。

```json
{
  "taskId": "upload-xxx-0",
  "sessionId": "sess-123",
  "type": "upload",
  "path": "/root/AI_RULES.md",
  "bytesTransferred": 32768,
  "totalBytes": 102400,
  "percentage": 32,
  "speed": 524288
}
```

`speed` 字段由后端计算：每次发射进度事件时，记录时间戳和字节数，计算增量速度（bytes/sec）。

#### 1.7 注册新命令

在 `src-tauri/src/lib.rs` 的 `generate_handler!` 宏中添加：
- `terminal::commands::sftp_upload_file`
- `terminal::commands::sftp_download_file`
- `terminal::commands::sftp_cancel_transfer`

### 2. 前端改动

#### 2.1 新建类型定义

```typescript
// webui/src/components/terminal/FileManager/types.ts
export type TransferStatus = 'waiting' | 'transferring' | 'completed' | 'error' | 'cancelled';

export interface TransferFileInfo {
  name: string;
  localPath: string;
  remotePath: string;
  size: number;
  status: 'pending' | 'transferring' | 'completed' | 'error';
}

export interface TransferTask {
  id: string;
  type: 'upload' | 'download';
  status: TransferStatus;
  currentFile: string;
  currentFileIndex: number;
  totalFiles: number;
  progress: number;       // 0-100
  speed: string;          // "1.2 MB/s"
  bytesTransferred: number;
  totalBytes: number;
  error?: string;
  files: TransferFileInfo[];
}
```

#### 2.2 新建 `TransferPanel` 组件

内嵌在 FileManager 底部，参考 lztools 的 `TransferTaskBar`：

- **标题栏**：传输任务 (2/5) | 取消按钮 | 清理按钮
- **进度区域**：
  - 当前文件名 + 状态图标（旋转/✓/✗）
  - 进度条 + 百分比
  - 速度 + 已传输/总大小
- **文件列表**（可展开/折叠）：每个文件的独立状态和进度
- **无任务时**：不显示面板
- **目录传输**：显示 indeterminate 进度条（动画条）+ "传输中..."

#### 2.3 改造传输逻辑

`handleDropToRemote` / `handleDropToLocal` / `handleUploadByPicker` / `handleDownloadFile`：

1. 创建 `TransferTask`，生成 `taskId`
2. 逐文件调用 `sftpUploadFile` / `sftpDownloadFile`（流式命令）
3. 监听 `sftp:transfer:{sessionId}:{taskId}` 事件更新进度
4. 支持取消（调用 `sftpCancelTransfer`）

对于拖拽系统文件（`_rawFile` 存在）：
1. 读取 `arrayBuffer()`
2. 调用 `sftpUpload(sessionId, remotePath, data, taskId)`（内存模式 + 进度）
3. 监听同一个进度事件更新

对于目录传输：
1. 调用 `sftpUploadDir` / `sftpDownloadDir`（无进度）
2. `TransferPanel` 显示 indeterminate 进度条

#### 2.4 速度计算

前端维护 `lastBytesRef` + `lastTimeRef`，每次进度事件计算增量速度，每秒更新一次 UI。

```typescript
const now = Date.now();
const elapsed = now - lastTimeRef.current;
if (elapsed >= 1000) {
  const bytesDelta = event.bytesTransferred - lastBytesRef.current;
  const speed = bytesDelta / (elapsed / 1000);
  lastBytesRef.current = event.bytesTransferred;
  lastTimeRef.current = now;
  // 更新 speed 状态
}
```

#### 2.5 IPC 层新增

```typescript
// ipc.ts

export interface TransferProgressEvent {
  taskId: string;
  sessionId: string;
  type: 'upload' | 'download';
  path: string;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speed: number;
}

export async function sftpUploadFile(
  sessionId: string, localPath: string, remotePath: string, taskId: string
): Promise<void>

export async function sftpDownloadFile(
  sessionId: string, remotePath: string, localPath: string, taskId: string
): Promise<void>

export async function sftpCancelTransfer(taskId: string): Promise<void>

export function onTransferProgress(
  sessionId: string, taskId: string,
  handler: (event: TransferProgressEvent) => void
): Promise<UnlistenFn> {
  return listen<TransferProgressEvent>(
    `sftp:transfer:${sessionId}:${taskId}`,
    (e) => handler(e.payload)
  );
}
```

#### 2.6 清理旧进度基础设施

- 移除 `terminalStore` 中的 `transferProgress` / `updateTransferProgress` / `clearTransferProgress`
- 移除 `FileManager.tsx` 中旧的 `onSftpTransferProgress` 监听和底部简单进度条
- 移除 `ipc.ts` 中的 `onSftpTransferProgress` 和 `SftpTransferProgressEvent`

### 3. 数据流

#### 3.1 流式上传（本地文件 → 远程）

```
用户拖拽本地文件到远程面板 → handleDropToRemote
  → 创建 TransferTask (id=upload-xxx)
  → for each file:
    → invoke("sftp_upload_file", { sessionId, localPath, remotePath, taskId: "upload-xxx-0" })
    → 后端 create_sftp_channel() 创建独立 session
    → 后端 upload_file_streaming 分块读写
    → 后端进度通道 → emit("sftp:transfer:{sid}:{tid}", progress)
    → 前端 listen 更新 TransferTask.progress / speed
  → 全部完成 → status=completed
```

#### 3.2 内存模式上传（系统拖拽文件 → 远程）

```
用户从系统拖拽文件到远程面板 → handleDropToRemote (fromSide=system, _rawFile存在)
  → 创建 TransferTask (id=upload-xxx)
  → for each file:
    → file._rawFile.arrayBuffer() 读取内容
    → invoke("sftp_upload", { sessionId, remotePath, data, taskId: "upload-xxx-0" })
    → 后端 SftpClient::upload_with_progress 分块写入 + 进度发射
    → 后端 emit("sftp:transfer:{sid}:{tid}", progress)
    → 前端 listen 更新 TransferTask.progress / speed
  → 全部完成 → status=completed
```

#### 3.3 流式下载（远程 → 本地文件）

```
用户拖拽远程文件到本地面板 → handleDropToLocal
  → 创建 TransferTask (id=download-xxx)
  → for each file:
    → invoke("sftp_download_file", { sessionId, remotePath, localPath, taskId: "download-xxx-0" })
    → 后端 create_sftp_channel() 创建独立 session
    → 后端 download_file_streaming 分块读写
    → 后端进度通道 → emit("sftp:transfer:{sid}:{tid}", progress)
    → 前端 listen 更新 TransferTask.progress / speed
  → 全部完成 → status=completed
```

### 4. 超越 lztools 的交互

1. **拖拽传输 + 进度联动**：lztools 的拖拽上传没有进度（`File.path` 不可用），Mona 通过 `File.arrayBuffer()` + `sftpUpload`（内存模式 + 进度）也能显示进度
2. **面板间互拖进度**：lztools 没有双面板互拖，Mona 独有
3. **文件级进度展开**：点击进度条展开文件列表，每个文件独立状态

## 文件变更清单

### 后端
- `src-tauri/src/terminal/mod.rs` - `TerminalState` 新增 `transfer_cancels` 字段
- `src-tauri/src/terminal/commands.rs` - 新增 `sftp_upload_file`、`sftp_download_file`、`sftp_cancel_transfer` 命令；改造 `sftp_upload` 增加 `task_id` 参数
- `src-tauri/src/terminal/sftp/client.rs` - 新增 `upload_with_progress` 方法（分块写入 + 进度发射）
- `src-tauri/src/lib.rs` - `generate_handler!` 注册新命令

### 前端
- `webui/src/components/terminal/ipc.ts` - 新增 IPC 函数和类型，移除旧的 `onSftpTransferProgress`
- `webui/src/components/terminal/FileManager/types.ts` - 新建类型定义
- `webui/src/components/terminal/FileManager/TransferPanel.tsx` - 新建传输面板组件
- `webui/src/components/terminal/FileManager/FileManager.tsx` - 改造传输逻辑，集成 TransferPanel，移除旧进度条
- `webui/src/components/terminal/store/terminalStore.ts` - 移除 `transferProgress` 相关状态
- `webui/src/components/terminal/FilePane.tsx` - 无需修改（拖拽事件已就绪）

## 后续迭代

1. **暂停/恢复**：后端 `upload_file_streaming` 已支持 `is_paused` + `resume_notify`，新增 `sftp_pause_transfer` / `sftp_resume_transfer` 命令即可
2. **目录递归传输进度**：改造 `sftp_upload_dir` / `sftp_download_dir`，先递归收集文件列表返回前端，前端逐文件调用流式命令
3. **批量多会话传输**：`BatchTransferManager` 已支持，可作为后续高级功能
