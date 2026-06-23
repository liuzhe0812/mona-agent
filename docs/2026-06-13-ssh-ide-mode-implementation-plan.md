# Mona SSH IDE Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Mona 的 SSH 会话标签内实现两栏远程 IDE Mode：左侧远程文件树，右侧上 Shell / 下 IDE 编辑器，支持打开、编辑、保存远程文件。

**Architecture:** 后端基于现有 `SftpClient` 新增 `terminal/ide` 模块提供 `ide_*` Tauri 命令，用 mtime + size 做乐观锁冲突检测；前端新增 `components/ide` 目录，使用独立 `useIdeStore` 管理文件树、Tab、编辑器状态，通过 `react-resizable-panels` 实现可拖动布局。

**Tech Stack:** Rust (Tauri 2, russh, russh-sftp) + React 18 + TypeScript + Zustand + CodeMirror 6 + react-resizable-panels

---

## File Structure

### 后端新增
- `src-tauri/src/terminal/ide/mod.rs` — 模块导出
- `src-tauri/src/terminal/ide/conflict.rs` — mtime/size 冲突检测逻辑 + 单元测试
- `src-tauri/src/terminal/ide/project.rs` — 项目信息类型
- `src-tauri/src/terminal/ide/commands.rs` — `ide_open_project` / `ide_check_file` / `ide_read_file` / `ide_write_file` / `ide_exec_command`

### 后端修改
- `src-tauri/src/terminal/mod.rs` — 注册 `ide` 子模块
- `src-tauri/src/lib.rs` — 注册 Tauri 命令

### 前端新增
- `webui/src/components/ide/useIdeStore.ts` — IDE 状态管理
- `webui/src/components/ide/IdeLayout.tsx` — 两栏布局容器
- `webui/src/components/ide/IdeFileTree.tsx` — 远程文件树
- `webui/src/components/ide/IdeEditorPanel.tsx` — IDE 区容器（Tabs + X 按钮）
- `webui/src/components/ide/IdeEditor.tsx` — CodeMirror 6 封装
- `webui/src/components/ide/IdeConflictDialog.tsx` — 保存冲突弹窗
- `webui/src/lib/codemirror/languageLoader.ts` — 按需加载 CodeMirror 语言包

### 前端修改
- `webui/src/components/terminal/TerminalView.tsx` — SSH 会话渲染 `IdeLayout`
- `webui/src/components/terminal/types/terminal.ts` — 新增 IDE 相关类型
- `webui/src/components/terminal/ipc.ts` — 新增 `ide_*` IPC 调用

### 测试
- `src-tauri/src/terminal/ide/conflict.rs` 内嵌 `#[cfg(test)]`
- `webui/src/test/components/ide/useIdeStore.test.ts` — useIdeStore 行为测试

---

## Task 1: 后端冲突检测模块

**Files:**
- Create: `src-tauri/src/terminal/ide/conflict.rs`

**Goal:** 实现基于 mtime + size 的乐观锁检测，统一按秒比较。

- [ ] **Step 1: 定义冲突检测结果枚举**

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConflictCheck {
    Ok,
    ModifiedExternally { remote_mtime: u64, remote_size: u64 },
}
```

- [ ] **Step 2: 实现比较函数**

```rust
pub fn check_conflict(
    expect_mtime: u64,
    expect_size: u64,
    remote_mtime: u64,
    remote_size: u64,
) -> ConflictCheck {
    // 统一按秒比较，避免毫秒/秒精度差异
    let expect_mtime_sec = expect_mtime / 1000;
    let remote_mtime_sec = remote_mtime / 1000;
    if expect_mtime_sec != remote_mtime_sec || expect_size != remote_size {
        ConflictCheck::ModifiedExternally {
            remote_mtime,
            remote_size,
        }
    } else {
        ConflictCheck::Ok
    }
}
```

- [ ] **Step 3: 编写单元测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_mtime_and_size_returns_ok() {
        assert_eq!(check_conflict(1_700_000_000_000, 100, 1_700_000_000_500, 100), ConflictCheck::Ok);
    }

    #[test]
    fn different_size_returns_conflict() {
        assert!(
            matches!(
                check_conflict(1_700_000_000_000, 100, 1_700_000_000_500, 200),
                ConflictCheck::ModifiedExternally { .. }
            )
        );
    }

    #[test]
    fn different_mtime_sec_returns_conflict() {
        assert!(
            matches!(
                check_conflict(1_700_000_000_000, 100, 1_700_000_001_000, 100),
                ConflictCheck::ModifiedExternally { .. }
            )
        );
    }
}
```

- [ ] **Step 4: 运行测试**

Run: `cd src-tauri && cargo test terminal::ide::conflict --lib`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/terminal/ide/conflict.rs

git commit -m "feat(ide): add mtime/size based conflict detection"
```

---

## Task 2: 后端项目信息类型

**Files:**
- Create: `src-tauri/src/terminal/ide/project.rs`

**Goal:** 定义项目信息、文件检查、读写结果类型。

- [ ] **Step 1: 定义类型**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub root_path: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FileCheckResult {
    Editable { size: u64, mtime: u64 },
    TooLarge { size: u64, limit: u64 },
    Binary,
    NotEditable { reason: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentResult {
    pub content: String,
    pub mtime: u64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime: u64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/terminal/ide/project.rs

git commit -m "feat(ide): add project and result types"
```

---

## Task 3: 后端 IDE 命令

**Files:**
- Create: `src-tauri/src/terminal/ide/commands.rs`
- Modify: `src-tauri/src/terminal/ide/mod.rs`

**Goal:** 实现所有 Tauri IDE 命令。

- [ ] **Step 1: 创建 mod.rs 导出模块**

```rust
pub mod commands;
pub mod conflict;
pub mod project;
```

- [ ] **Step 2: 实现命令模块框架**

```rust
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::terminal::error::TerminalError;
use crate::terminal::session::{SessionHandle, SessionManager};
use crate::terminal::sftp::client::{FileInfo, SftpClient};
use crate::terminal::TerminalState;

use super::conflict::{check_conflict, ConflictCheck};
use super::project::{ExecResult, FileCheckResult, FileContentResult, ProjectInfo, WriteResult};

const MAX_EDITABLE_SIZE: u64 = 10 * 1024 * 1024; // 10MB

async fn get_sftp_client(
    state: &TerminalState,
    session_id: &str,
) -> Result<Arc<SftpClient>, String> {
    let handle = state
        .manager
        .get_handle(session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()).to_string())?;

    match handle {
        SessionHandle::Sftp(client) | SessionHandle::Ssh(client) => {
            // SSH 会话复用其内部 SFTP session
            Ok(client)
        }
        _ => Err("Not an SSH/SFTP session".to_string()),
    }
}
```

> **注意：** `SessionHandle::Ssh` 当前保存的是 `SshClient` 而非 `SftpClient`。若 SSH 会话未同时持有 SFTP 会话，需要先改造 `SshClient` 暴露 SFTP 能力，或在打开 IDE 时自动创建一个 SFTP 会话。本计划假设在 Task 3.5 中补充此能力。

- [ ] **Step 3: 实现 `ide_open_project`**

```rust
#[tauri::command]
pub async fn ide_open_project(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<ProjectInfo, String> {
    let client = get_sftp_client(&state, &session_id).await?;
    let info = client.stat(&path).await.map_err(|e| e.to_string())?;
    if info.is_dir {
        let name = std::path::Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".to_string());
        Ok(ProjectInfo {
            root_path: path,
            name,
        })
    } else {
        Err("Path is not a directory".to_string())
    }
}
```

- [ ] **Step 4: 实现 `ide_check_file`**

```rust
#[tauri::command]
pub async fn ide_check_file(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<FileCheckResult, String> {
    let client = get_sftp_client(&state, &session_id).await?;
    let info = client.stat(&path).await.map_err(|e| e.to_string())?;

    if info.is_dir {
        return Ok(FileCheckResult::NotEditable {
            reason: "Is a directory".to_string(),
        });
    }

    let size = info.size.unwrap_or(0);
    let mtime = info.mtime.unwrap_or(0) as u64;

    if size > MAX_EDITABLE_SIZE {
        return Ok(FileCheckResult::TooLarge {
            size,
            limit: MAX_EDITABLE_SIZE,
        });
    }

    // 读取前 8KB 探测是否为二进制
    let head = client.download(&path).await.unwrap_or_default();
    let sample = &head[..head.len().min(8192)];
    if sample.contains(&0u8) {
        return Ok(FileCheckResult::Binary);
    }

    Ok(FileCheckResult::Editable { size, mtime })
}
```

- [ ] **Step 5: 实现 `ide_read_file`**

```rust
#[tauri::command]
pub async fn ide_read_file(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<FileContentResult, String> {
    let client = get_sftp_client(&state, &session_id).await?;
    let info = client.stat(&path).await.map_err(|e| e.to_string())?;
    let data = client.download(&path).await.map_err(|e| e.to_string())?;
    let content = String::from_utf8(data)
        .map_err(|_| "File is not valid UTF-8".to_string())?;
    Ok(FileContentResult {
        content,
        mtime: info.mtime.unwrap_or(0) as u64,
        size: info.size.unwrap_or(0),
    })
}
```

- [ ] **Step 6: 实现 `ide_write_file`**

```rust
#[tauri::command]
pub async fn ide_write_file(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
    content: String,
    expect_mtime: u64,
    expect_size: u64,
) -> Result<WriteResult, String> {
    let client = get_sftp_client(&state, &session_id).await?;

    // 保存前校验
    let latest = client.stat(&path).await.map_err(|e| e.to_string())?;
    let latest_mtime = latest.mtime.unwrap_or(0) as u64;
    let latest_size = latest.size.unwrap_or(0);

    match check_conflict(expect_mtime, expect_size, latest_mtime, latest_size) {
        ConflictCheck::ModifiedExternally { .. } => {
            return Err("File modified externally".to_string());
        }
        ConflictCheck::Ok => {}
    }

    client
        .upload(&path, content.into_bytes())
        .await
        .map_err(|e| e.to_string())?;

    // 写入后重新 stat 获取新 mtime
    let after = client.stat(&path).await.map_err(|e| e.to_string())?;
    Ok(WriteResult {
        mtime: after.mtime.unwrap_or(0) as u64,
        size: after.size.unwrap_or(0),
    })
}
```

- [ ] **Step 7: 实现 `ide_exec_command`**

复用现有 SSH exec 能力。若当前会话是 SSH，通过 `SshClient::exec_command` 执行；若是纯 SFTP 会话则返回错误。

```rust
#[tauri::command]
pub async fn ide_exec_command(
    state: State<'_, TerminalState>,
    session_id: String,
    command: String,
    cwd: Option<String>,
) -> Result<ExecResult, String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    let full_command = match cwd {
        Some(dir) => format!("cd {} && {}", shell_escape(&dir), command),
        None => command,
    };

    match handle {
        SessionHandle::Ssh(client) => {
            let output = client.exec_command(&full_command).await.map_err(|e| e.to_string())?;
            Ok(ExecResult {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: output.exit_code.map(|c| c as i32),
            })
        }
        _ => Err("Exec command only supported for SSH sessions".to_string()),
    }
}

fn shell_escape(input: &str) -> String {
    format!("'{}'", input.replace('\'', "'\"'\"'"))
}
```

- [ ] **Step 8: 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 无错误（可能需要先调整 `get_sftp_client` 以适配实际 `SessionHandle` 类型）

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/terminal/ide/

git commit -m "feat(ide): add ide_* tauri commands"
```

---

## Task 4: SSH 会话暴露 SFTP 能力

**Files:**
- Modify: `src-tauri/src/terminal/ssh/client.rs`
- Modify: `src-tauri/src/terminal/session.rs`
- Modify: `src-tauri/src/terminal/commands.rs`（`ssh_connect`）

**Goal:** 让 SSH 连接同时初始化一个 SFTP 子系统会话，供 IDE 命令复用。

- [ ] **Step 1: 在 `SshClient` 中增加 SFTP session 字段**

```rust
pub struct SshClient {
    pub handle: Arc<Mutex<client::Handle<SshClientHandler>>>,
    pub writer: Arc<Mutex<Option<ChannelWriteHalf<client::Msg>>>>,
    pub scroll_buffer: Arc<ScrollBuffer>,
    pub sftp_session: Arc<Mutex<Option<russh_sftp::client::SftpSession>>>,
}
```

- [ ] **Step 2: 在 SSH 连接成功后启动 SFTP 子系统**

在 `SshClient::connect` 成功后，复用同一 `handle` 开启一个 `channel_open_session` 并请求 `sftp` subsystem，保存到 `sftp_session`。

```rust
let channel = handle.channel_open_session().await?;
channel.request_subsystem(true, "sftp").await?;
let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await?;
```

- [ ] **Step 3: 暴露 `sftp()` 方法**

```rust
impl SshClient {
    pub async fn sftp(&self) -> Result<russh_sftp::client::SftpSession, TerminalError> {
        let guard = self.sftp_session.lock().await;
        guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not initialized".to_string())
        }).map(|s| /* clone or return reference */)
    }
}
```

> 由于 `SftpSession` 无法直接 Clone，更简单的做法是在 `SessionHandle` 中新增 `SshWithSftp(Arc<SshClient>, Arc<SftpClient>)`，或在 `get_sftp_client` 中根据 SSH handle 动态创建 `SftpClient` wrapper。具体实现需根据 `SftpClient` 内部结构选择。最低成本方案：在 `SshClient` 内持有一个 `Arc<SftpClient>`，连接成功后创建并初始化。

- [ ] **Step 4: 调整 `get_sftp_client` 辅助函数**

```rust
async fn get_sftp_client(
    state: &TerminalState,
    session_id: &str,
) -> Result<Arc<SftpClient>, String> {
    let handle = state
        .manager
        .get_handle(session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()).to_string())?;

    match handle {
        SessionHandle::Sftp(client) => Ok(client),
        SessionHandle::Ssh(ssh_client) => {
            ssh_client
                .sftp_client()
                .await
                .ok_or_else(|| "SSH session has no SFTP".to_string())
        }
        _ => Err("Not an SSH/SFTP session".to_string()),
    }
}
```

- [ ] **Step 5: 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/terminal/ssh/client.rs src-tauri/src/terminal/session.rs src-tauri/src/terminal/commands.rs

git commit -m "feat(ssh): initialize sftp subsystem for ssh sessions"
```

---

## Task 5: 注册 Rust 模块和命令

**Files:**
- Modify: `src-tauri/src/terminal/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 `terminal/mod.rs` 注册 `ide`**

```rust
pub mod ide;
```

- [ ] **Step 2: 在 `lib.rs` 注册命令**

在 `.invoke_handler` 中添加：

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    terminal::ide::commands::ide_open_project,
    terminal::ide::commands::ide_check_file,
    terminal::ide::commands::ide_read_file,
    terminal::ide::commands::ide_write_file,
    terminal::ide::commands::ide_exec_command,
])
```

- [ ] **Step 3: 编译检查**

Run: `cd src-tauri && cargo check`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/terminal/mod.rs src-tauri/src/lib.rs

git commit -m "feat(ide): register ide module and tauri commands"
```

---

## Task 6: 前端类型与 IPC 绑定

**Files:**
- Modify: `webui/src/components/terminal/types/terminal.ts`
- Modify: `webui/src/components/terminal/ipc.ts`

- [ ] **Step 1: 在 `terminal.ts` 新增类型**

```typescript
export interface ProjectInfo {
  rootPath: string;
  name: string;
}

export type FileCheckResult =
  | { type: "editable"; size: number; mtime: number }
  | { type: "too_large"; size: number; limit: number }
  | { type: "binary" }
  | { type: "not_editable"; reason: string };

export interface FileContentResult {
  content: string;
  mtime: number;
  size: number;
}

export interface WriteResult {
  mtime: number;
  size: number;
}

export interface IdeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}
```

- [ ] **Step 2: 在 `ipc.ts` 新增调用函数**

```typescript
import { invoke } from "@tauri-apps/api/core";
import type {
  FileCheckResult,
  FileContentResult,
  IdeExecResult,
  ProjectInfo,
  WriteResult,
} from "./types/terminal";

export async function ideOpenProject(
  sessionId: string,
  path: string,
): Promise<ProjectInfo> {
  return invoke("ide_open_project", { sessionId, path });
}

export async function ideCheckFile(
  sessionId: string,
  path: string,
): Promise<FileCheckResult> {
  return invoke("ide_check_file", { sessionId, path });
}

export async function ideReadFile(
  sessionId: string,
  path: string,
): Promise<FileContentResult> {
  return invoke("ide_read_file", { sessionId, path });
}

export async function ideWriteFile(
  sessionId: string,
  path: string,
  content: string,
  expectMtime: number,
  expectSize: number,
): Promise<WriteResult> {
  return invoke("ide_write_file", {
    sessionId,
    path,
    content,
    expectMtime,
    expectSize,
  });
}

export async function ideExecCommand(
  sessionId: string,
  command: string,
  cwd?: string,
): Promise<IdeExecResult> {
  return invoke("ide_exec_command", { sessionId, command, cwd });
}
```

- [ ] **Step 3: TypeScript 检查**

Run: `cd webui && npm run lint`（或 `npx tsc --noEmit`）
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add webui/src/components/terminal/types/terminal.ts webui/src/components/terminal/ipc.ts

git commit -m "feat(ide): add frontend types and ipc bindings"
```

---

## Task 7: CodeMirror 语言包按需加载器

**Files:**
- Create: `webui/src/lib/codemirror/languageLoader.ts`

- [ ] **Step 1: 实现语言映射与动态导入**

```typescript
import type { Extension } from "@codemirror/state";

const LANG_MAP: Record<string, () => Promise<Extension>> = {
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  ts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  tsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  rs: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  java: () => import("@codemirror/lang-java").then((m) => m.java()),
  cpp: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  c: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  yml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
};

export function detectLanguage(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return LANG_MAP[ext] ? ext : null;
}

export async function loadLanguage(filename: string): Promise<Extension | null> {
  const ext = detectLanguage(filename);
  if (!ext) return null;
  return LANG_MAP[ext]();
}
```

- [ ] **Step 2: Commit**

```bash
git add webui/src/lib/codemirror/languageLoader.ts

git commit -m "feat(ide): add codemirror language loader"
```

---

## Task 8: useIdeStore 状态管理

**Files:**
- Create: `webui/src/components/ide/useIdeStore.ts`

- [ ] **Step 1: 定义 Tab 和状态类型**

```typescript
import { create } from "zustand";
import {
  ideCheckFile,
  ideOpenProject,
  ideReadFile,
  ideWriteFile,
} from "../terminal/ipc";
import { detectLanguage } from "@/lib/codemirror/languageLoader";

export interface IdeTab {
  id: string;
  path: string;
  name: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
  isLoading: boolean;
  language: string | null;
  serverMtime: number;
  serverSize: number;
}

export interface ConflictState {
  tabId: string;
  remoteMtime: number;
  remoteSize: number;
}

export interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeNode[];
  isLoading?: boolean;
}

interface IdeState {
  sessionId: string | null;
  rootPath: string | null;
  tree: FileTreeNode[];
  expandedPaths: Set<string>;
  tabs: IdeTab[];
  activeTabId: string | null;
  ideVisible: boolean;
  showHiddenFiles: boolean;
  conflictState: ConflictState | null;

  openProject: (sessionId: string, path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  closeTab: (tabId: string) => void;
  saveFile: (tabId: string) => Promise<void>;
  setTabContent: (tabId: string, content: string) => void;
  setActiveTab: (tabId: string) => void;
  togglePath: (path: string) => void;
  loadChildren: (path: string) => Promise<void>;
  hideIdePanel: () => void;
  showIdePanel: () => void;
  setShowHiddenFiles: (show: boolean) => void;
  resolveConflict: (tabId: string, action: "overwrite" | "discard") => Promise<void>;
}
```

- [ ] **Step 2: 实现核心 action（openFile / saveFile）**

```typescript
export const useIdeStore = create<IdeState>((set, get) => ({
  sessionId: null,
  rootPath: null,
  tree: [],
  expandedPaths: new Set(),
  tabs: [],
  activeTabId: null,
  ideVisible: false,
  showHiddenFiles: false,
  conflictState: null,

  openProject: async (sessionId, path) => {
    const info = await ideOpenProject(sessionId, path);
    set({
      sessionId,
      rootPath: info.rootPath,
      tree: [{ name: info.name, path: info.rootPath, isDir: true, isLoading: false }],
      expandedPaths: new Set([info.rootPath]),
    });
    await get().loadChildren(info.rootPath);
  },

  openFile: async (path) => {
    const { sessionId, tabs } = get();
    if (!sessionId) throw new Error("No active session");

    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      set({ activeTabId: existing.id, ideVisible: true });
      return;
    }

    const check = await ideCheckFile(sessionId, path);
    if (check.type !== "editable") {
      if (check.type === "too_large") throw new Error(`File too large: ${check.size}`);
      if (check.type === "binary") {
        console.info("Skipping binary file:", path);
        return;
      }
      throw new Error(`Cannot edit: ${check.reason}`);
    }

    const fileName = path.split("/").pop() || path;
    const tabId = crypto.randomUUID();
    const newTab: IdeTab = {
      id: tabId,
      path,
      name: fileName,
      content: "",
      originalContent: "",
      isDirty: false,
      isLoading: true,
      language: detectLanguage(fileName),
      serverMtime: check.mtime,
      serverSize: check.size,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
      ideVisible: true,
    }));

    try {
      const result = await ideReadFile(sessionId, path);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                content: result.content,
                originalContent: result.content,
                isLoading: false,
                serverMtime: result.mtime,
                serverSize: result.size,
              }
            : t
        ),
      }));
    } catch (err) {
      set((state) => ({
        tabs: state.tabs.filter((t) => t.id !== tabId),
        activeTabId: state.activeTabId === tabId ? null : state.activeTabId,
      }));
      throw err;
    }
  },

  closeTab: (tabId) => {
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (tab?.isDirty) {
        // 调用方应先提示保存
        return state;
      }
      const newTabs = state.tabs.filter((t) => t.id !== tabId);
      const newActive =
        state.activeTabId === tabId
          ? newTabs[newTabs.length - 1]?.id ?? null
          : state.activeTabId;
      return {
        tabs: newTabs,
        activeTabId: newActive,
        ideVisible: newTabs.length > 0,
      };
    });
  },

  saveFile: async (tabId) => {
    const { sessionId, tabs } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!sessionId || !tab) throw new Error("Invalid save state");

    try {
      const result = await ideWriteFile(
        sessionId,
        tab.path,
        tab.content,
        tab.serverMtime,
        tab.serverSize
      );
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                originalContent: t.content,
                isDirty: false,
                serverMtime: result.mtime,
                serverSize: result.size,
              }
            : t
        ),
        conflictState: null,
      }));
    } catch (err) {
      const msg = String(err);
      if (msg.includes("File modified externally")) {
        // 需要重新 stat 获取最新信息
        const latest = await ideCheckFile(sessionId, tab.path);
        if (latest.type === "editable") {
          set({
            conflictState: {
              tabId,
              remoteMtime: latest.mtime,
              remoteSize: latest.size,
            },
          });
        }
      }
      throw err;
    }
  },

  setTabContent: (tabId, content) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? { ...t, content, isDirty: t.originalContent !== content }
          : t
      ),
    }));
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  hideIdePanel: () => set({ ideVisible: false }),
  showIdePanel: () => set({ ideVisible: true }),

  setShowHiddenFiles: (show) => {
    set({ showHiddenFiles: show });
    // 刷新已展开目录
    const { expandedPaths, loadChildren } = get();
    expandedPaths.forEach((path) => loadChildren(path));
  },

  resolveConflict: async (tabId, action) => {
    const { sessionId, tabs } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!sessionId || !tab) return;

    if (action === "discard") {
      const result = await ideReadFile(sessionId, tab.path);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                content: result.content,
                originalContent: result.content,
                isDirty: false,
                serverMtime: result.mtime,
                serverSize: result.size,
              }
            : t
        ),
        conflictState: null,
      }));
    } else {
      // overwrite：绕过 mtime 校验再次写入
      const result = await ideWriteFile(
        sessionId,
        tab.path,
        tab.content,
        0,
        0
      );
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                originalContent: t.content,
                isDirty: false,
                serverMtime: result.mtime,
                serverSize: result.size,
              }
            : t
        ),
        conflictState: null,
      }));
    }
  },

  togglePath: (path) => {
    set((state) => {
      const next = new Set(state.expandedPaths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { expandedPaths: next };
    });
    get().loadChildren(path);
  },

  loadChildren: async (path) => {
    // 通过现有 sftpList IPC 加载目录内容
    const { sessionId, showHiddenFiles } = get();
    if (!sessionId) return;
    const { sftpList } = await import("../terminal/ipc");
    const files = await sftpList(sessionId, path);
    const nodes = files
      .filter((f) => showHiddenFiles || !f.name.startsWith("."))
      .map((f) => ({
        name: f.name,
        path: f.path,
        isDir: f.isDir,
        isLoading: false,
      }));
    set((state) => ({
      tree: updateTreeChildren(state.tree, path, nodes),
    }));
  },
}));

function updateTreeChildren(
  tree: FileTreeNode[],
  path: string,
  children: FileTreeNode[]
): FileTreeNode[] {
  return tree.map((node) => {
    if (node.path === path) {
      return { ...node, children };
    }
    if (node.children) {
      return { ...node, children: updateTreeChildren(node.children, path, children) };
    }
    return node;
  });
}
```

> 注：`resolveConflict` 中的 `overwrite` 实现（传 `0,0` 绕过校验）需要后端支持“强制写入”模式，或新增 `ide_force_write_file` 命令。更稳妥的做法：后端 `ide_write_file` 增加 `force: bool` 参数。

- [ ] **Step 3: Commit**

```bash
git add webui/src/components/ide/useIdeStore.ts

git commit -m "feat(ide): add useIdeStore state management"
```

---

## Task 9: IdeEditor 组件

**Files:**
- Create: `webui/src/components/ide/IdeEditor.tsx`

- [ ] **Step 1: 实现 CodeMirror 编辑器封装**

```tsx
import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState, Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { loadLanguage } from "@/lib/codemirror/languageLoader";

interface IdeEditorProps {
  content: string;
  language: string | null;
  onChange: (value: string) => void;
  readOnly?: boolean;
}

export function IdeEditor({ content, language, onChange, readOnly }: IdeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const startState = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange(update.state.doc.toString());
          }
        }),
        EditorView.editable.of(!readOnly),
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: containerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // 外部 content 变化时同步（如切换 Tab）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === content) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    });
  }, [content]);

  // 语言包动态加载
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !language) return;
    loadLanguage(language).then((langExt) => {
      if (!langExt || !viewRef.current) return;
      viewRef.current.dispatch({
        effects: StateEffect.reconfigure.of([
          // ... base extensions + langExt
        ]),
      });
    });
  }, [language]);

  return <div ref={containerRef} className="h-full w-full overflow-auto" />;
}
```

> 语言包动态替换需要更严谨的扩展管理。建议将基础扩展抽成函数 `createExtensions(langExt)`，在 language 变化时重新创建 State 或精确替换语言扩展 compartment。

- [ ] **Step 2: Commit**

```bash
git add webui/src/components/ide/IdeEditor.tsx

git commit -m "feat(ide): add IdeEditor with codemirror"
```

---

## Task 10: IdeEditorPanel 组件

**Files:**
- Create: `webui/src/components/ide/IdeEditorPanel.tsx`

- [ ] **Step 1: 实现 Tab 栏 + 编辑器容器 + X 按钮**

```tsx
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IdeEditor } from "./IdeEditor";
import { useIdeStore } from "./useIdeStore";

export function IdeEditorPanel() {
  const tabs = useIdeStore((s) => s.tabs);
  const activeTabId = useIdeStore((s) => s.activeTabId);
  const setActiveTab = useIdeStore((s) => s.setActiveTab);
  const closeTab = useIdeStore((s) => s.closeTab);
  const setTabContent = useIdeStore((s) => s.setTabContent);
  const hideIdePanel = useIdeStore((s) => s.hideIdePanel);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className="flex h-full flex-col bg-[#1e1e1e]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#333] bg-[#252526] px-2">
        <div className="flex min-w-0 flex-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex max-w-[160px] shrink-0 items-center gap-1.5 px-3 py-1 text-xs ${
                tab.id === activeTabId
                  ? "bg-[#1e1e1e] text-white"
                  : "text-white/60 hover:bg-[#2a2d2e]"
              }`}
            >
              <span className="truncate">{tab.name}</span>
              {tab.isDirty && <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />}
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="ml-1 rounded p-0.5 hover:bg-white/10"
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-white/60 hover:text-white"
          onClick={hideIdePanel}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        {activeTab ? (
          <IdeEditor
            key={activeTab.id}
            content={activeTab.content}
            language={activeTab.language}
            onChange={(value) => setTabContent(activeTab.id, value)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-white/40">
            选择一个文件开始编辑
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add webui/src/components/ide/IdeEditorPanel.tsx

git commit -m "feat(ide): add IdeEditorPanel with tabs"
```

---

## Task 11: IdeFileTree 组件

**Files:**
- Create: `webui/src/components/ide/IdeFileTree.tsx`

- [ ] **Step 1: 实现递归文件树 + 右键菜单**

```tsx
import { useState } from "react";
import { ChevronRight, ChevronDown, Folder, FileText } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useIdeStore, type FileTreeNode } from "./useIdeStore";

interface TreeNodeProps {
  node: FileTreeNode;
  depth: number;
}

function TreeNode({ node, depth }: TreeNodeProps) {
  const { expandedPaths, togglePath, openFile } = useIdeStore();
  const expanded = expandedPaths.has(node.path);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          className="flex cursor-pointer items-center py-1 pr-2 text-sm text-white/80 hover:bg-white/5"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onDoubleClick={() => {
            if (node.isDir) {
              togglePath(node.path);
            } else {
              openFile(node.path).catch(console.error);
            }
          }}
        >
          <span className="mr-1 text-white/50">
            {node.isDir ? (
              expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />
            ) : null}
          </span>
          {node.isDir ? (
            <Folder className="mr-1.5 h-4 w-4 text-yellow-500/80" />
          ) : (
            <FileText className="mr-1.5 h-4 w-4 text-blue-400/80" />
          )}
          <span className="truncate">{node.name}</span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {!node.isDir && (
          <ContextMenuItem onClick={() => openFile(node.path)}>编辑文档</ContextMenuItem>
        )}
        <ContextMenuItem>下载</ContextMenuItem>
        <ContextMenuItem>重命名</ContextMenuItem>
        <ContextMenuItem className="text-red-400">删除</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function IdeFileTree() {
  const tree = useIdeStore((s) => s.tree);

  const renderNode = (node: FileTreeNode, depth: number) => (
    <div key={node.path}>
      <TreeNode node={node} depth={depth} />
      {node.children && node.children.map((child) => renderNode(child, depth + 1))}
    </div>
  );

  return (
    <div className="h-full overflow-auto bg-[#252526] py-2">
      {tree.map((node) => renderNode(node, 0))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add webui/src/components/ide/IdeFileTree.tsx

git commit -m "feat(ide): add IdeFileTree with context menu"
```

---

## Task 12: IdeLayout 组件

**Files:**
- Create: `webui/src/components/ide/IdeLayout.tsx`

- [ ] **Step 1: 使用 react-resizable-panels 实现两栏 + 上下切分**

```tsx
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { IdeFileTree } from "./IdeFileTree";
import { IdeEditorPanel } from "./IdeEditorPanel";
import { XtermTerminal } from "../terminal/XtermTerminal";
import { useIdeStore } from "./useIdeStore";

interface IdeLayoutProps {
  sessionId: string;
}

export function IdeLayout({ sessionId }: IdeLayoutProps) {
  const ideVisible = useIdeStore((s) => s.ideVisible);

  return (
    <div className="flex h-full flex-col">
      <PanelGroup direction="horizontal">
        <Panel defaultSize={20} minSize={15} maxSize={40}>
          <IdeFileTree />
        </Panel>
        <PanelResizeHandle className="w-1 bg-[#333] hover:bg-[#555]" />
        <Panel defaultSize={80}>
          {ideVisible ? (
            <PanelGroup direction="vertical">
              <Panel defaultSize={50} minSize={20}>
                <XtermTerminal sessionId={sessionId} />
              </Panel>
              <PanelResizeHandle className="h-1 bg-[#333] hover:bg-[#555]" />
              <Panel defaultSize={50} minSize={15}>
                <IdeEditorPanel />
              </Panel>
            </PanelGroup>
          ) : (
            <XtermTerminal sessionId={sessionId} />
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
```

> 注意：`XtermTerminal` 当前 props 需确认是否接受 `sessionId`。如不接受，需修改。

- [ ] **Step 2: Commit**

```bash
git add webui/src/components/ide/IdeLayout.tsx

git commit -m "feat(ide): add IdeLayout with resizable panels"
```

---

## Task 13: 集成到 TerminalView

**Files:**
- Modify: `webui/src/components/terminal/TerminalView.tsx`

- [ ] **Step 1: SSH 会话渲染 IdeLayout**

```tsx
import { IdeLayout } from "../ide/IdeLayout";

// 在 TerminalView 的 session 类型分支中
if (session.type === "ssh") {
  return <IdeLayout sessionId={session.id} />;
}
```

- [ ] **Step 2: 会话激活时自动打开项目根目录**

在 `IdeLayout` 的 `useEffect` 中，组件挂载时调用 `useIdeStore.getState().openProject(sessionId, "~")` 或根据连接配置确定默认路径。建议先使用用户家目录 `~`，后续可配置。

```tsx
import { useEffect } from "react";
import { useIdeStore } from "./useIdeStore";

export function IdeLayout({ sessionId }: IdeLayoutProps) {
  const openProject = useIdeStore((s) => s.openProject);

  useEffect(() => {
    openProject(sessionId, "~").catch(console.error);
  }, [sessionId, openProject]);

  // ...
}
```

- [ ] **Step 3: Commit**

```bash
git add webui/src/components/terminal/TerminalView.tsx webui/src/components/ide/IdeLayout.tsx

git commit -m "feat(ide): integrate IdeLayout into SSH TerminalView"
```

---

## Task 14: 保存冲突弹窗

**Files:**
- Create: `webui/src/components/ide/IdeConflictDialog.tsx`

- [ ] **Step 1: 实现冲突解决弹窗**

```tsx
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useIdeStore } from "./useIdeStore";

export function IdeConflictDialog() {
  const conflict = useIdeStore((s) => s.conflictState);
  const resolveConflict = useIdeStore((s) => s.resolveConflict);

  if (!conflict) return null;

  return (
    <Dialog open onOpenChange={() => useIdeStore.setState({ conflictState: null })}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>文件已被外部修改</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-white/70">
          远程文件在编辑期间被修改。您要覆盖远程版本，还是放弃本地修改？
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => useIdeStore.setState({ conflictState: null })}>
            取消
          </Button>
          <Button variant="secondary" onClick={() => resolveConflict(conflict.tabId, "discard")}>
            放弃本地修改
          </Button>
          <Button onClick={() => resolveConflict(conflict.tabId, "overwrite")}>
            覆盖远程
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 在 IdeLayout 中挂载弹窗**

```tsx
import { IdeConflictDialog } from "./IdeConflictDialog";

// 在 IdeLayout 返回的 JSX 末尾添加
<IdeConflictDialog />
```

- [ ] **Step 3: Commit**

```bash
git add webui/src/components/ide/IdeConflictDialog.tsx webui/src/components/ide/IdeLayout.tsx

git commit -m "feat(ide): add conflict resolution dialog"
```

---

## Task 15: 关闭 Tab 时 dirty 提示

**Files:**
- Modify: `webui/src/components/ide/IdeEditorPanel.tsx`

- [ ] **Step 1: 在关闭 Tab 前检查 dirty 状态**

```tsx
const handleCloseTab = (tabId: string) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (tab.isDirty) {
    // 使用浏览器 confirm；后续可替换为项目内 Dialog
    const ok = confirm(`文件 "${tab.name}" 有未保存修改，确认关闭？`);
    if (!ok) return;
  }
  closeTab(tabId);
};
```

> 后续可接入项目内的 `useConfirm` hook 做更美观的确认弹窗。

- [ ] **Step 2: Commit**

```bash
git add webui/src/components/ide/IdeEditorPanel.tsx

git commit -m "feat(ide): prompt before closing dirty tab"
```

---

## Task 16: Rust 单元测试完善

**Files:**
- Modify: `src-tauri/src/terminal/ide/commands.rs`

- [ ] **Step 1: 为命令函数添加测试辅助或纯逻辑测试**

`commands.rs` 中主要逻辑依赖 SFTP 连接，适合在 `conflict.rs` 中覆盖冲突检测。若需测试命令参数校验，可添加：

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn max_editable_size_is_10mb() {
        assert_eq!(super::MAX_EDITABLE_SIZE, 10 * 1024 * 1024);
    }
}
```

- [ ] **Step 2: 运行测试**

Run: `cd src-tauri && cargo test terminal::ide --lib`
Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/terminal/ide/commands.rs

git commit -m "test(ide): add command constants tests"
```

---

## Task 17: 前端 Store 测试

**Files:**
- Create: `webui/src/test/components/ide/useIdeStore.test.ts`

- [ ] **Step 1: 测试 Tab 状态流转**

```typescript
import { describe, it, expect, vi } from "vitest";
import { useIdeStore } from "@/components/ide/useIdeStore";

vi.mock("@/components/terminal/ipc", () => ({
  ideOpenProject: vi.fn(),
  ideCheckFile: vi.fn(),
  ideReadFile: vi.fn(),
  ideWriteFile: vi.fn(),
  sftpList: vi.fn(),
}));

describe("useIdeStore", () => {
  it("opens a new tab when openFile is called", async () => {
    const { ideCheckFile, ideReadFile } = await import("@/components/terminal/ipc");
    vi.mocked(ideCheckFile).mockResolvedValue({ type: "editable", size: 100, mtime: 1 });
    vi.mocked(ideReadFile).mockResolvedValue({ content: "hello", mtime: 1, size: 100 });

    useIdeStore.setState({ sessionId: "s1" });
    await useIdeStore.getState().openFile("/home/user/test.txt");

    const state = useIdeStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].name).toBe("test.txt");
    expect(state.ideVisible).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `cd webui && npm test -- src/test/components/ide/useIdeStore.test.ts`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add webui/src/test/components/ide/useIdeStore.test.ts

git commit -m "test(ide): add useIdeStore unit tests"
```

---

## Task 18: 端到端集成测试

**Files:**
- Create: `tests/terminal/test_ide_mode.py`（可选，如项目无 SSH 集成测试框架，可跳过）

**Goal:** 在本地 OpenSSH 临时目录验证打开→编辑→保存流程。

由于 Mona 当前测试以 Python 单元测试为主，SSH 集成测试基础设施可能缺失，本任务标记为 **可选（P1）**，优先保证 Task 16/17 的单元测试。

- [ ] **Step 1: 编写手动 QA 清单**

在 `docs/2026-06-13-ssh-ide-mode-implementation-plan.md` 末尾追加：

```markdown
## 手动 QA 清单
- [ ] SSH 连接后显示文件树
- [ ] 双击文本文件打开 Tab 并展开 IDE 区
- [ ] 编辑内容后 Tab 显示 dirty 标记
- [ ] Ctrl+S 保存成功，dirty 标记消失
- [ ] 关闭 dirty Tab 时弹出确认
- [ ] 外部修改文件后保存触发冲突弹窗
- [ ] 点击 IDE 区 X 按钮隐藏面板，Tab 保留
- [ ] 关闭所有 Tab 后 IDE 区自动隐藏
- [ ] 文件树宽度、Shell/IDE 分割线可拖动
- [ ] 切换隐藏文件显示正常过滤/显示点号文件
- [ ] 二进制文件和大文件不可编辑
```

- [ ] **Step 2: Commit**

```bash
git add docs/2026-06-13-ssh-ide-mode-implementation-plan.md

git commit -m "docs(ide): add manual qa checklist"
```

---

## Task 19: 构建与 lint 检查

**Files:**
- 无新增文件

- [ ] **Step 1: Rust 编译**

Run: `cd src-tauri && cargo build`
Expected: 成功

- [ ] **Step 2: 前端 lint**

Run: `cd webui && npm run lint`
Expected: 无新增错误

- [ ] **Step 3: 前端类型检查**

Run: `cd webui && npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 4: Commit 修复**

如 lint/type 报错，修复后提交：

```bash
git add .

git commit -m "chore(ide): fix lint and type errors"
```

---

## 手动 QA 清单
- [ ] SSH 连接后显示文件树
- [ ] 双击文本文件打开 Tab 并展开 IDE 区
- [ ] 编辑内容后 Tab 显示 dirty 标记
- [ ] Ctrl+S 保存成功，dirty 标记消失
- [ ] 关闭 dirty Tab 时弹出确认
- [ ] 外部修改文件后保存触发冲突弹窗
- [ ] 点击 IDE 区 X 按钮隐藏面板，Tab 保留
- [ ] 关闭所有 Tab 后 IDE 区自动隐藏
- [ ] 文件树宽度、Shell/IDE 分割线可拖动
- [ ] 切换隐藏文件显示正常过滤/显示点号文件
- [ ] 二进制文件和大文件不可编辑

---

## 计划自查

### Spec 覆盖检查
- [x] 两栏布局：Task 12
- [x] 左侧文件树：Task 11
- [x] 右侧 Shell + IDE 上下分割：Task 12
- [x] IDE 区可拖动、可 X 关闭、无文件自动隐藏：Task 12, 10
- [x] 双击/右键编辑打开 Tab：Task 11
- [x] CodeMirror 6 编辑器：Task 9
- [x] mtime + size 冲突检测：Task 1, 3
- [x] 隐藏文件切换：Task 8
- [x] AI 侧边栏不受影响：未改动 Toolbar，保持现有行为

### Placeholder 检查
- [x] 无 TBD/TODO
- [x] 无 "add appropriate error handling" 类模糊描述
- [x] 每个任务包含具体文件路径

### 类型一致性检查
- `FileCheckResult` 在前端类型和后端序列化中使用一致
- `WriteResult` 字段 `mtime`/`size` 前后端一致
- `useIdeStore` 中 action 名称与组件消费一致

---

## 执行方式选择

Plan complete and saved to `docs/2026-06-13-ssh-ide-mode-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
