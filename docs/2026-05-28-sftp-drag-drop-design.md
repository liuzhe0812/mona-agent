# SFTP 拖拽上传/下载与多选批量传输设计

## 概述

在终端页面的 SFTP 文件管理器中，实现拖拽上传/下载功能，支持多选文件和目录的批量传输。

## 交互场景

1. **面板间互拖上传**：本地面板选中文件/目录 → 拖到远程面板 → 上传到当前远程目录
2. **面板间互拖下载**：远程面板选中文件/目录 → 拖到本地面板 → 下载到当前本地目录
3. **系统文件拖入上传**：从系统文件管理器拖文件/目录到远程面板 → 上传
4. **多选拖拽**：先 Ctrl+Click / Shift+Click 多选，拖拽任意选中项时所有选中项一起传输

## 技术方案

### 拖拽事件处理

- **面板间拖拽**：使用 HTML5 Drag & Drop API
  - `onDragStart`：文件行设为 draggable，拖拽时将选中文件列表写入 dataTransfer
  - `onDragOver`/`onDragLeave`：目标面板显示高亮覆盖层
  - `onDrop`：解析 dataTransfer 中的文件列表，触发传输

- **系统文件拖入**：使用 Tauri 的 `onDragDropEvent` 监听原生拖拽事件
  - 获取系统拖入的文件路径列表
  - 在 FilePane 区域内时显示高亮，松开时触发上传

### 传输逻辑

**拖入远程面板（上传）：**
```
for each file in droppedFiles:
  if file.isDir:
    sftpUploadDir(sessionId, file.path, remotePath + "/" + file.name)
  else:
    readFile(file.path) → sftpUpload(sessionId, remotePath + "/" + file.name, data)
```

**拖入本地面板（下载）：**
```
for each file in droppedFiles:
  if file.isDir:
    sftpDownloadDir(sessionId, file.path, localPath + sep + file.name)
  else:
    sftpDownload(sessionId, file.path) → writeFile(localPath + sep + file.name, data)
```

### 组件改动

#### FilePane.tsx

新增 props：
- `onDropFiles: (files: UnifiedFileItem[], fromSide: "local" | "remote") => void`

新增状态：
- `isDragOver: boolean` — 控制高亮覆盖层显示

文件行改动：
- `<tr>` 添加 `draggable` 属性
- `onDragStart`：将选中文件列表 JSON 序列化写入 dataTransfer
- 拖拽未选中项时自动选中该项

文件列表区域改动：
- 添加 `onDragOver`（preventDefault + 设置 isDragOver）
- 添加 `onDragLeave`（清除 isDragOver）
- 添加 `onDrop`（解析 dataTransfer，调用 onDropFiles）

系统文件拖入：
- 使用 Tauri `onDragDropEvent` 监听，在组件内判断拖入位置是否在当前面板区域

#### FileManager.tsx

新增方法：
- `handleDropToRemote(files, fromSide)` — 处理拖入远程面板的文件
- `handleDropToLocal(files, fromSide)` — 处理拖入本地面板的文件

传输状态：
- `isTransferring: boolean` — 传输中禁用新的拖拽操作

### 视觉反馈

- **拖入高亮**：目标面板显示蓝色半透明边框 + 居中提示文字
  - 远程面板："拖放以上传"
  - 本地面板："拖放以下载"
- **进度显示**：复用底部已有的传输进度条
- **拖拽预览**：使用浏览器默认拖拽预览

### 错误处理

- 传输失败时在进度条区域显示错误标记
- 部分文件失败不阻断后续文件传输
- 同名文件直接覆盖（与当前行为一致）

## 现有后端能力

后端已实现以下命令，无需修改：
- `sftp_upload` — 单文件上传
- `sftp_download` — 单文件下载
- `sftp_upload_dir` — 目录递归上传
- `sftp_download_dir` — 目录递归下载
- `sftp-transfer-progress` 事件 — 传输进度通知
