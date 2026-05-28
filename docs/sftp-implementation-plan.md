# SFTP 功能补齐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 Mona SFTP 核心功能，使其达到主流 SFTP 客户端的基本可用水平

**Architecture:** 前端双栏 FilePane 组件增强多选/右键/剪贴板，后端新增递归传输和文件操作 IPC 命令，传输队列由前端调度

**Tech Stack:** React + Zustand + Tauri IPC + @tauri-apps/plugin-fs + @tauri-apps/plugin-dialog + russh-sftp

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `webui/src/components/terminal/FileManager/FilePane.tsx` | 修改 | 多选、右键菜单、隐藏文件、搜索、状态栏 |
| `webui/src/components/terminal/FileManager/FileManager.tsx` | 修改 | 剪贴板、传输队列、拖拽分隔条 |
| `webui/src/components/terminal/FileManager/TransferQueue.tsx` | 新建 | 传输队列面板 |
| `webui/src/components/terminal/FileManager/PropertiesDialog.tsx` | 新建 | 文件属性对话框 |
| `webui/src/components/terminal/FileManager/PermissionsDialog.tsx` | 新建 | 权限修改对话框 |
| `webui/src/components/terminal/store/terminalStore.ts` | 修改 | 传输队列状态 |
| `webui/src/components/terminal/ipc.ts` | 修改 | 新增 IPC 函数 |
| `src-tauri/src/terminal/commands.rs` | 修改 | 新增后端命令 |
| `src-tauri/src/terminal/sftp/client.rs` | 修改 | 新增 SFTP 客户端方法 |
| `src-tauri/src/lib.rs` | 修改 | 注册新命令 |

---

## Task 1: FilePane 多选逻辑

**Files:**
- Modify: `webui/src/components/terminal/FileManager/FilePane.tsx`

- [ ] **Step 1: 替换单选状态为多选状态**

在 `FilePane` 组件中，将 `selectedPath: string | null` 替换为 `selectedPaths: Set<string>` 和 `lastSelectedIndex: number`：

```typescript
const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
const lastSelectedIndexRef = useRef(-1);
```

- [ ] **Step 2: 实现多选点击逻辑**

替换 `onSelect` 回调逻辑。在 `FilePane` 中新增 `handleSelect` 函数：

```typescript
const handleSelect = useCallback(
  (file: UnifiedFileItem, index: number, e: React.MouseEvent) => {
    const next = new Set(selectedPaths);
    if (e.shiftKey && lastSelectedIndexRef.current >= 0) {
      const start = Math.min(lastSelectedIndexRef.current, index);
      const end = Math.max(lastSelectedIndexRef.current, index);
      for (let i = start; i <= end; i++) {
        if (files[i]) next.add(files[i].path);
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (next.has(file.path)) {
        next.delete(file.path);
      } else {
        next.add(file.path);
      }
    } else {
      next.clear();
      next.add(file.path);
    }
    setSelectedPaths(next);
    lastSelectedIndexRef.current = index;
  },
  [selectedPaths, files],
);
```

- [ ] **Step 3: 实现 Ctrl+A 全选**

在 `FilePane` 容器上添加 `onKeyDown`：

```typescript
const handleKeyDown = useCallback(
  (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      e.preventDefault();
      const all = new Set(files.map((f) => f.path));
      setSelectedPaths(all);
    }
  },
  [files],
);
```

在面板根 div 上添加 `tabIndex={0}` 和 `onKeyDown={handleKeyDown}`。

- [ ] **Step 4: 更新 FileRow 选中判断**

将 `selected={selectedPath === file.path}` 改为 `selected={selectedPaths.has(file.path)}`。

- [ ] **Step 5: 点击空白区域取消全选**

在 `<table>` 的 `onClick` 事件中，如果点击目标是 `<table>` 本身（非行），则清空选择：

```typescript
<table
  className="w-full text-xs"
  onClick={(e) => {
    if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === "TH") {
      setSelectedPaths(new Set());
      lastSelectedIndexRef.current = -1;
    }
  }}
>
```

- [ ] **Step 6: 向上暴露选中文件**

在 `Props` 接口新增：

```typescript
onSelectionChange?: (paths: Set<string>) => void;
```

在 `selectedPaths` 变化时调用 `onSelectionChange`：

```typescript
useEffect(() => {
  onSelectionChange?.(selectedPaths);
}, [selectedPaths, onSelectionChange]);
```

- [ ] **Step 7: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | findstr FileManager`

Expected: 无与 FilePane 相关的错误

---

## Task 2: 右键上下文菜单

**Files:**
- Modify: `webui/src/components/terminal/FileManager/FilePane.tsx`

- [ ] **Step 1: 在 FileRow 外层包裹 ContextMenu**

在 `FilePane.tsx` 中导入 `@/components/ui/context-menu`：

```typescript
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Eye, EyeOff, Copy, Scissors, ClipboardPaste, FilePlus, FolderUp, Info } from "lucide-react";
```

- [ ] **Step 2: 在 Props 中新增回调**

```typescript
interface Props {
  // ...existing
  onCopy?: (files: UnifiedFileItem[]) => void;
  onCut?: (files: UnifiedFileItem[]) => void;
  onPaste?: () => void;
  onCreateFile?: () => void;
  onProperties?: (file: UnifiedFileItem) => void;
  showHiddenFiles: boolean;
  onToggleHiddenFiles: () => void;
  clipboardHasItems: boolean;
}
```

- [ ] **Step 3: 实现 FileRow 右键菜单**

将 `<tr>` 包裹在 `<ContextMenu>` 中。右键点击时自动选中该文件：

```tsx
<ContextMenu>
  <ContextMenuTrigger asChild>
    <tr ...>
      {/* existing row content */}
    </tr>
  </ContextMenuTrigger>
  <ContextMenuContent className="w-48">
    {file.isDir && (
      <ContextMenuItem onClick={() => onOpen(file)}>
        <FolderUp className="mr-2 h-3.5 w-3.5" /> 打开
      </ContextMenuItem>
    )}
    {side === "remote" && !file.isDir && onDownload && (
      <ContextMenuItem onClick={() => onDownload(file)}>
        <Download className="mr-2 h-3.5 w-3.5" /> 下载
      </ContextMenuItem>
    )}
    {side === "local" && onUploadByPicker && (
      <ContextMenuItem onClick={onUploadByPicker}>
        <Upload className="mr-2 h-3.5 w-3.5" /> 上传
      </ContextMenuItem>
    )}
    <ContextMenuSeparator />
    <ContextMenuItem onClick={() => onCopy?.(getSelectedFiles(file))}>
      <Copy className="mr-2 h-3.5 w-3.5" /> 复制
    </ContextMenuItem>
    <ContextMenuItem onClick={() => onCut?.(getSelectedFiles(file))}>
      <Scissors className="mr-2 h-3.5 w-3.5" /> 剪切
    </ContextMenuItem>
    {clipboardHasItems && (
      <ContextMenuItem onClick={() => onPaste?.()}>
        <ClipboardPaste className="mr-2 h-3.5 w-3.5" /> 粘贴
      </ContextMenuItem>
    )}
    <ContextMenuSeparator />
    <ContextMenuItem onClick={() => onRename(file)}>
      <Pencil className="mr-2 h-3.5 w-3.5" /> 重命名
    </ContextMenuItem>
    <ContextMenuItem onClick={() => onDelete(file)}>
      <Trash2 className="mr-2 h-3.5 w-3.5" /> 删除
    </ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem onClick={() => onCreateFile?.()}>
      <FilePlus className="mr-2 h-3.5 w-3.5" /> 新建文件
    </ContextMenuItem>
    <ContextMenuItem onClick={onCreateFolder}>
      <FolderPlus className="mr-2 h-3.5 w-3.5" /> 新建文件夹
    </ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem onClick={() => onProperties?.(file)}>
      <Info className="mr-2 h-3.5 w-3.5" /> 属性
    </ContextMenuItem>
  </ContextMenuContent>
</ContextMenu>
```

其中 `getSelectedFiles` 函数：如果右键的文件已在选中集合中，返回所有选中文件；否则只返回当前文件。

- [ ] **Step 4: 面板空白区域右键菜单**

在 `<table>` 外层包裹一个面板级 ContextMenu，提供：新建文件夹、新建文件、粘贴、显示/隐藏隐藏文件、刷新。

- [ ] **Step 5: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | findstr FileManager`

---

## Task 3: 显示/隐藏隐藏文件 + 搜索过滤

**Files:**
- Modify: `webui/src/components/terminal/FileManager/FilePane.tsx`

- [ ] **Step 1: 新增 showHiddenFiles 和 searchQuery 状态**

```typescript
// 由 Props 传入 showHiddenFiles 和 onToggleHiddenFiles
const [searchQuery, setSearchQuery] = useState("");
```

- [ ] **Step 2: 过滤文件列表**

在渲染前过滤：

```typescript
const displayFiles = useMemo(() => {
  let result = files;
  if (!showHiddenFiles) {
    result = result.filter((f) => !f.name.startsWith("."));
  }
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    result = result.filter((f) => f.name.toLowerCase().includes(q));
  }
  return result;
}, [files, showHiddenFiles, searchQuery]);
```

将 `displayFiles` 用于渲染表格行（而非 `files`）。

- [ ] **Step 3: 工具栏新增搜索框和隐藏文件按钮**

在工具栏中，刷新按钮前添加：

```tsx
<div className="relative">
  <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
  <Input
    value={searchQuery}
    onChange={(e) => setSearchQuery(e.target.value)}
    placeholder="搜索..."
    className="h-6 w-24 pl-6 pr-1.5 py-0 text-xs"
  />
</div>
<Button
  variant="ghost"
  size="sm"
  className="h-6 w-6 p-0"
  onClick={onToggleHiddenFiles}
  title={showHiddenFiles ? "隐藏隐藏文件" : "显示隐藏文件"}
>
  {showHiddenFiles ? (
    <Eye className="h-3 w-3" />
  ) : (
    <EyeOff className="h-3 w-3" />
  )}
</Button>
```

- [ ] **Step 4: 验证编译**

---

## Task 4: 复制/剪切/粘贴 + 快捷键

**Files:**
- Modify: `webui/src/components/terminal/FileManager/FileManager.tsx`
- Modify: `webui/src/components/terminal/FileManager/FilePane.tsx`

- [ ] **Step 1: 在 FileManager 中新增剪贴板状态**

```typescript
interface ClipboardEntry {
  side: "local" | "remote";
  files: UnifiedFileItem[];
  mode: "copy" | "cut";
}

const [clipboard, setClipboard] = useState<ClipboardEntry | null>(null);
```

- [ ] **Step 2: 实现 handleCopy / handleCut / handlePaste**

```typescript
const handleCopy = useCallback(
  (side: "local" | "remote", files: UnifiedFileItem[]) => {
    if (files.length === 0) return;
    setClipboard({ side, files, mode: "copy" });
  },
  [],
);

const handleCut = useCallback(
  (side: "local" | "remote", files: UnifiedFileItem[]) => {
    if (files.length === 0) return;
    setClipboard({ side, files, mode: "cut" });
  },
  [],
);

const handlePaste = useCallback(
  async (targetSide: "local" | "remote") => {
    if (!clipboard) return;
    const isCrossSide = clipboard.side !== targetSide;

    for (const file of clipboard.files) {
      try {
        if (isCrossSide) {
          if (clipboard.side === "local" && targetSide === "remote") {
            // 上传
            if (!file.isDir) {
              const { readFile } = await import("@tauri-apps/plugin-fs");
              const data = await readFile(file.path as `${string}/${string}`);
              const remoteFilePath =
                remotePath === "/" ? `/${file.name}` : `${remotePath}/${file.name}`;
              await sftpUpload(sessionId, remoteFilePath, Array.from(data));
            }
          } else {
            // 下载
            if (!file.isDir) {
              const sep = localPath.includes("\\") ? "\\" : "/";
              const localFilePath = `${localPath}${sep}${file.name}`;
              const data = await sftpDownload(sessionId, file.path);
              const { writeFile } = await import("@tauri-apps/plugin-fs");
              await writeFile(localFilePath as `${string}/${string}`, new Uint8Array(data));
            }
          }
        } else {
          // 同侧复制/移动
          if (targetSide === "remote") {
            if (clipboard.mode === "copy") {
              // 远程复制：读取 → 写入（后续 Task 实现后端 sftp_copy）
            } else {
              // 远程移动：rename
              const newPath =
                remotePath === "/" ? `/${file.name}` : `${remotePath}/${file.name}`;
              await sftpRename(sessionId, file.path, newPath);
            }
          } else {
            if (clipboard.mode === "copy") {
              const { copyFile } = await import("@tauri-apps/plugin-fs");
              const sep = localPath.includes("\\") ? "\\" : "/";
              const dest = `${localPath}${sep}${file.name}`;
              await copyFile(file.path as `${string}/${string}`, dest as `${string}/${string}`);
            } else {
              const { rename } = await import("@tauri-apps/plugin-fs");
              const sep = localPath.includes("\\") ? "\\" : "/";
              const dest = `${localPath}${sep}${file.name}`;
              await rename(file.path as `${string}/${string}`, dest as `${string}/${string}`);
            }
          }
        }
      } catch {}
    }

    // 剪切模式粘贴后清空剪贴板
    if (clipboard.mode === "cut") {
      setClipboard(null);
    }

    // 刷新目标面板
    if (targetSide === "local") loadLocalDir(localPath);
    else loadRemoteDir(remotePath);
  },
  [clipboard, sessionId, localPath, remotePath, loadLocalDir, loadRemoteDir],
);
```

- [ ] **Step 3: 注册 Ctrl+C/X/V 快捷键**

在 `FileManager` 中添加 `useEffect` 监听键盘事件：

```typescript
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "c") {
      // 复制当前活动面板的选中文件
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "x") {
      // 剪切
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "v") {
      // 粘贴到当前活动面板
    }
  };
  document.addEventListener("keydown", handleKeyDown);
  return () => document.removeEventListener("keydown", handleKeyDown);
}, []);
```

需要追踪当前活动面板（local/remote），通过 `FilePane` 的 `onFocus` 回调更新。

- [ ] **Step 4: 传递回调到 FilePane**

在 `FileManager` 的两个 `FilePane` 上新增 props：`onCopy`, `onCut`, `onPaste`, `clipboardHasItems`。

- [ ] **Step 5: 验证编译**

---

## Task 5: 后端 — 递归传输 + 新建文件 + 详细属性 + 权限修改

**Files:**
- Modify: `src-tauri/src/terminal/sftp/client.rs`
- Modify: `src-tauri/src/terminal/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `webui/src/components/terminal/ipc.ts`

- [ ] **Step 1: SftpClient 新增方法**

在 `client.rs` 中新增：

```rust
pub async fn touch(&self, path: &str) -> Result<(), TerminalError> {
    let session = self.session.lock().await;
    let session = session.as_ref().ok_or(TerminalError::SftpOperation("SFTP not connected".into()))?;
    session.write(path, &[]).await.map_err(|e| TerminalError::SftpOperation(e.to_string()))?;
    Ok(())
}

pub async fn set_permissions(&self, path: &str, mode: u32) -> Result<(), TerminalError> {
    let session = self.session.lock().await;
    let session = session.as_ref().ok_or(TerminalError::SftpOperation("SFTP not connected".into()))?;
    let metadata = russh_sftp::client::Metadata {
        permissions: Some(mode),
        ..Default::default()
    };
    session.setstat(path, metadata).await.map_err(|e| TerminalError::SftpOperation(e.to_string()))?;
    Ok(())
}
```

- [ ] **Step 2: commands.rs 新增 IPC 命令**

```rust
#[tauri::command]
pub async fn sftp_touch(state: State<'_, TerminalState>, session_id: String, path: String) -> Result<(), String> {
    let client = get_sftp_client(&state, &session_id).await.ok_or("SFTP session not found")?;
    client.touch(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_chmod(state: State<'_, TerminalState>, session_id: String, path: String, mode: u32) -> Result<(), String> {
    let client = get_sftp_client(&state, &session_id).await.ok_or("SFTP session not found")?;
    client.set_permissions(&path, mode).await.map_err(|e| e.to_string())
}

#[derive(Debug, serde::Serialize)]
pub struct FileStatDetail {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: u32,
    pub mode_string: String,
    pub owner: String,
    pub group: String,
    pub mtime: Option<String>,
    pub atime: Option<String>,
}

#[tauri::command]
pub async fn sftp_stat_detail(state: State<'_, TerminalState>, session_id: String, path: String) -> Result<FileStatDetail, String> {
    let client = get_sftp_client(&state, &session_id).await.ok_or("SFTP session not found")?;
    let info = client.stat(&path).await.map_err(|e| e.to_string())?;
    let mode_string = {
        let p = info.permissions.unwrap_or(0);
        let rwx = |n: u32| -> String {
            (if n & 4 != 0 { "r" } else { "-" })
                .to_string()
                + (if n & 2 != 0 { "w" } else { "-" })
                + (if n & 1 != 0 { "x" } else { "-" })
        };
        (if info.is_dir { "d" } else { "-" }).to_string() + &rwx((p >> 6) & 7) + &rwx((p >> 3) & 7) + &rwx(p & 7)
    };
    Ok(FileStatDetail {
        name: path.rsplit('/').next().unwrap_or("").to_string(),
        path: info.path,
        is_dir: info.is_dir,
        size: info.size.unwrap_or(0),
        permissions: info.permissions.unwrap_or(0),
        mode_string,
        owner: info.owner.unwrap_or_default(),
        group: info.group.unwrap_or_default(),
        mtime: info.mtime.map(|t| {
            chrono::DateTime::from_timestamp(t as i64, 0)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_default()
        }),
        atime: None,
    })
}

#[tauri::command]
pub async fn sftp_download_dir(
    state: State<'_, TerminalState>,
    app: AppHandle,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let client = get_sftp_client(&state, &session_id).await.ok_or("SFTP session not found")?;
    download_dir_recursive(&client, &app, &session_id, &remote_path, &local_path).await
}

#[tauri::command]
pub async fn sftp_upload_dir(
    state: State<'_, TerminalState>,
    app: AppHandle,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let client = get_sftp_client(&state, &session_id).await.ok_or("SFTP session not found")?;
    upload_dir_recursive(&client, &app, &session_id, &local_path, &remote_path).await
}
```

- [ ] **Step 3: 实现递归传输辅助函数**

```rust
async fn download_dir_recursive(
    client: &SftpClient,
    app: &AppHandle,
    session_id: &str,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    let local_dir = std::path::Path::new(local_path);
    std::fs::create_dir_all(local_dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    let entries = client.list_dir(remote_path).await.map_err(|e| e.to_string())?;
    for entry in &entries {
        let local_file_path = local_dir.join(&entry.name);
        let local_file_str = local_file_path.to_string_lossy().to_string();
        if entry.is_dir {
            let remote_sub = if remote_path.ends_with('/') {
                format!("{}{}", remote_path, entry.name)
            } else {
                format!("{}/{}", remote_path, entry.name)
            };
            Box::pin(download_dir_recursive(client, app, session_id, &remote_sub, &local_file_str)).await?;
        } else {
            let remote_file = if remote_path.ends_with('/') {
                format!("{}{}", remote_path, entry.name)
            } else {
                format!("{}/{}", remote_path, entry.name)
            };
            let data = client.download(&remote_file).await.map_err(|e| e.to_string())?;
            std::fs::write(&local_file_path, &data).map_err(|e| format!("Write error: {}", e))?;
            let _ = app.emit("sftp:transfer_progress", serde_json::json!({
                "sessionId": session_id,
                "path": remote_file,
                "direction": "download",
                "bytesTransferred": data.len(),
                "totalBytes": data.len(),
            }));
        }
    }
    Ok(())
}

async fn upload_dir_recursive(
    client: &SftpClient,
    app: &AppHandle,
    session_id: &str,
    local_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    let remote_dir = if remote_path.ends_with('/') {
        format!("{}{}", remote_path, std::path::Path::new(local_path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
    } else {
        format!("{}/{}", remote_path, std::path::Path::new(local_path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
    };
    client.mkdir(&remote_dir).await.map_err(|e| e.to_string())?;
    let entries = std::fs::read_dir(local_path).map_err(|e| format!("Read dir error: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Dir entry error: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let local_file_str = entry.path().to_string_lossy().to_string();
        let remote_file = format!("{}/{}", remote_dir, name);
        let metadata = entry.metadata().map_err(|e| format!("Metadata error: {}", e))?;
        if metadata.is_dir() {
            Box::pin(upload_dir_recursive(client, app, session_id, &local_file_str, &remote_dir)).await?;
        } else {
            let data = std::fs::read(&local_file_str).map_err(|e| format!("Read file error: {}", e))?;
            client.upload(&remote_file, &data).await.map_err(|e| e.to_string())?;
            let _ = app.emit("sftp:transfer_progress", serde_json::json!({
                "sessionId": session_id,
                "path": remote_file,
                "direction": "upload",
                "bytesTransferred": data.len(),
                "totalBytes": data.len(),
            }));
        }
    }
    Ok(())
}
```

- [ ] **Step 4: 注册新命令到 lib.rs**

在 `invoke_handler` 的 handler 列表中添加：
```
terminal::commands::sftp_touch,
terminal::commands::sftp_chmod,
terminal::commands::sftp_stat_detail,
terminal::commands::sftp_download_dir,
terminal::commands::sftp_upload_dir,
```

- [ ] **Step 5: 前端 ipc.ts 新增函数**

```typescript
export async function sftpTouch(sessionId: string, path: string): Promise<void> {
  return invoke("sftp_touch", { sessionId, path });
}

export async function sftpChmod(sessionId: string, path: string, mode: number): Promise<void> {
  return invoke("sftp_chmod", { sessionId, path, mode });
}

export interface FileStatDetail {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  permissions: number;
  modeString: string;
  owner: string;
  group: string;
  mtime: string | null;
  atime: string | null;
}

export async function sftpStatDetail(sessionId: string, path: string): Promise<FileStatDetail> {
  return invoke<FileStatDetail>("sftp_stat_detail", { sessionId, path });
}

export async function sftpDownloadDir(sessionId: string, remotePath: string, localPath: string): Promise<void> {
  return invoke("sftp_download_dir", { sessionId, remotePath, localPath });
}

export async function sftpUploadDir(sessionId: string, localPath: string, remotePath: string): Promise<void> {
  return invoke("sftp_upload_dir", { sessionId, localPath, remotePath });
}
```

- [ ] **Step 6: 验证 Rust 编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\src-tauri && cargo check 2>&1`

- [ ] **Step 7: 验证 TypeScript 编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | findstr ipc`

---

## Task 6: 传输队列管理

**Files:**
- Modify: `webui/src/components/terminal/store/terminalStore.ts`
- Create: `webui/src/components/terminal/FileManager/TransferQueue.tsx`
- Modify: `webui/src/components/terminal/FileManager/FileManager.tsx`

- [ ] **Step 1: terminalStore 新增 TransferTask 类型和状态**

```typescript
export interface TransferTask {
  id: string;
  type: "upload" | "download";
  sourcePath: string;
  destPath: string;
  fileName: string;
  isDir: boolean;
  status: "waiting" | "transferring" | "completed" | "error" | "cancelled";
  bytesTransferred: number;
  totalBytes: number | null;
  error: string | null;
}
```

在 `TerminalState` 接口中新增：

```typescript
transferTasks: TransferTask[];
addTransferTask: (task: TransferTask) => void;
updateTransferTask: (id: string, update: Partial<TransferTask>) => void;
removeTransferTask: (id: string) => void;
clearCompletedTasks: () => void;
```

实现这些方法。

- [ ] **Step 2: 创建 TransferQueue.tsx 组件**

显示传输任务列表，每个任务显示：文件名、方向、进度条、状态、取消按钮。

```tsx
export function TransferQueue({ tasks, onCancel, onClearCompleted }: Props) {
  if (tasks.length === 0) return null;
  return (
    <div className="border-t shrink-0">
      <div className="flex items-center justify-between px-3 py-1 bg-muted/20">
        <span className="text-xs font-medium">传输队列 ({tasks.length})</span>
        <Button variant="ghost" size="sm" className="h-5 text-xs" onClick={onClearCompleted}>
          清除已完成
        </Button>
      </div>
      <div className="max-h-32 overflow-auto">
        {tasks.map((task) => (
          <div key={task.id} className="flex items-center gap-2 px-3 py-1 text-xs border-b">
            <span className="w-8">{task.type === "upload" ? "↑" : "↓"}</span>
            <span className="truncate flex-1">{task.fileName}</span>
            {task.status === "transferring" && (
              <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-primary" style={{ width: `${task.totalBytes ? Math.round(task.bytesTransferred / task.totalBytes * 100) : 0}%` }} />
              </div>
            )}
            <span className="text-muted-foreground w-16">
              {task.status === "waiting" ? "等待中" : task.status === "transferring" ? "传输中" : task.status === "completed" ? "完成" : task.status === "error" ? "失败" : "已取消"}
            </span>
            {(task.status === "waiting" || task.status === "transferring") && (
              <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => onCancel(task.id)}>
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: FileManager 中集成传输队列**

替换现有的 `transferProgress` 底部面板为 `<TransferQueue>`。

实现串行调度：当有 `waiting` 状态的任务且没有 `transferring` 状态的任务时，自动开始下一个任务。

- [ ] **Step 4: 上传/下载改为加入队列**

修改 `handleUploadByPicker` 和 `handleDownloadFile`，不再直接传输，而是创建 `TransferTask` 加入队列。

- [ ] **Step 5: 验证编译**

---

## Task 7: 文件属性对话框

**Files:**
- Create: `webui/src/components/terminal/FileManager/PropertiesDialog.tsx`
- Modify: `webui/src/components/terminal/FileManager/FileManager.tsx`

- [ ] **Step 1: 创建 PropertiesDialog.tsx**

```tsx
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { sftpStatDetail } from "../ipc";
import type { FileStatDetail } from "../ipc";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: { name: string; path: string; isDir: boolean } | null;
  side: "local" | "remote";
  sessionId: string;
}

export function PropertiesDialog({ open, onOpenChange, file, side, sessionId }: Props) {
  const [detail, setDetail] = useState<FileStatDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !file || side !== "remote") return;
    setLoading(true);
    sftpStatDetail(sessionId, file.path)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [open, file, side, sessionId]);

  // 本地文件使用 @tauri-apps/plugin-fs stat

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>属性 — {file?.name}</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>
        ) : detail ? (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-[80px_1fr] gap-y-2">
              <span className="text-muted-foreground">类型</span>
              <span>{detail.isDir ? "文件夹" : "文件"}</span>
              <span className="text-muted-foreground">路径</span>
              <span className="truncate">{detail.path}</span>
              <span className="text-muted-foreground">大小</span>
              <span>{formatSize(detail.size)}</span>
              <span className="text-muted-foreground">权限</span>
              <span className="font-mono">{detail.modeString} ({detail.permissions.toString(8).padStart(3, "0")})</span>
              <span className="text-muted-foreground">所有者</span>
              <span>{detail.owner || "-"}</span>
              <span className="text-muted-foreground">所属组</span>
              <span>{detail.group || "-"}</span>
              <span className="text-muted-foreground">修改时间</span>
              <span>{detail.mtime || "-"}</span>
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">无法获取文件信息</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: FileManager 中集成属性对话框**

新增 `propertiesDialogOpen` 和 `propertiesTarget` 状态，传递 `onProperties` 到 FilePane。

- [ ] **Step 3: 验证编译**

---

## Task 8: 权限修改对话框

**Files:**
- Create: `webui/src/components/terminal/FileManager/PermissionsDialog.tsx`
- Modify: `webui/src/components/terminal/FileManager/FileManager.tsx`

- [ ] **Step 1: 创建 PermissionsDialog.tsx**

包含权限矩阵（Owner/Group/Others × R/W/X）、八进制输入框、递归 checkbox、确定/取消按钮。调用 `sftpChmod` IPC。

- [ ] **Step 2: FileManager 中集成**

从属性对话框中添加"修改权限"按钮打开权限对话框。

- [ ] **Step 3: 验证编译**

---

## Task 9: 面板宽度可拖拽调整 + 状态栏

**Files:**
- Modify: `webui/src/components/terminal/FileManager/FileManager.tsx`
- Modify: `webui/src/components/terminal/FileManager/FilePane.tsx`

- [ ] **Step 1: FileManager 中实现可拖拽分隔条**

替换两个面板的 `flex-1` 为受控宽度，中间添加拖拽手柄：

```tsx
const [leftWidth, setLeftWidth] = useState(50); // 百分比

<div className="flex flex-1 min-h-0">
  <div style={{ width: `${leftWidth}%` }} className="min-w-0 border-r">
    <FilePane ... />
  </div>
  <div
    className="w-1 cursor-col-resize bg-border hover:bg-primary/50 shrink-0"
    onMouseDown={(e) => {
      const startX = e.clientX;
      const startWidth = leftWidth;
      const handleMove = (e: MouseEvent) => {
        const container = e.currentTarget as HTMLElement;
        // 需要获取容器宽度来计算百分比
        const delta = e.clientX - startX;
        const containerWidth = (e.currentTarget as HTMLElement).parentElement?.clientWidth ?? 800;
        setLeftWidth(Math.max(20, Math.min(80, startWidth + (delta / containerWidth) * 100)));
      };
      // ... mousemove/mouseup handlers
    }}
  />
  <div className="flex-1 min-w-0">
    <FilePane ... />
  </div>
</div>
```

- [ ] **Step 2: FilePane 底部新增状态栏**

```tsx
<div className="h-6 shrink-0 border-t px-2 flex items-center text-[10px] text-muted-foreground bg-muted/10">
  <span>{displayFiles.length} 项</span>
  {selectedPaths.size > 0 && (
    <>
      <span className="mx-1">·</span>
      <span>已选 {selectedPaths.size} 项</span>
    </>
  )}
</div>
```

- [ ] **Step 3: 验证编译**

---

## Task 10: 集成测试 + 编译验证

**Files:** 无新增

- [ ] **Step 1: Rust 编译验证**

Run: `cd d:\liuzhe\Desktop\code\Mona\src-tauri && cargo check 2>&1`

Expected: 0 errors

- [ ] **Step 2: TypeScript 编译验证**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1`

Expected: 无与 FileManager/ipc/terminalStore 相关的错误

- [ ] **Step 3: Ruff lint 验证**

Run: `cd d:\liuzhe\Desktop\code\Mona\src-tauri && ruff check src/terminal/commands.rs src/terminal/sftp/client.rs 2>&1`

Expected: 0 errors (warnings acceptable)
