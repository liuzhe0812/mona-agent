# Mona Terminal Module - 完整开发计划

> **Goal:** 基于 Mona Tauri 项目，开发一个 Windows 桌面终端客户端，支持 SSH、SFTP、FTP、本地 Shell 协议，集成 AI Agent，提供批量 SSH 模式。

**Architecture:**
- 后端：Rust (Tauri 2) + russh + russh-sftp + portable-pty
- 前端：React 18 + TypeScript + xterm.js + Tailwind CSS + Radix UI
- AI 集成：复用 Mona Python Agent，通过 Tauri IPC 通信
- 打包：Tauri 2 build → Windows .exe/.msi

**Tech Stack:** Rust (Tauri 2), React 18, TypeScript, xterm.js, russh, russh-sftp, portable-pty, Zustand, Tailwind CSS, Radix UI, Lucide React

---

## 关键架构决策

1. **实施范围**：仅替换 SSH Tab 的 `ModulePlaceholder` 为 `TerminalView`，不修改 AppTitleBar、Sidebar、AgentWorkbench 等任何外部组件
2. **标签管理**：所有会话标签在终端模块页面内部，不使用 AppTitleBar 的 Tab 系统
3. **UI 风格**：使用现有 Radix UI + Tailwind CSS + Lucide icons + HSL 主题变量
4. **前端文件**：所有新增文件放在 `webui/src/components/terminal/` 下
5. **唯一外部修改**：`App.tsx` 中将 `activeTabId === 'ssh'` 时渲染 `TerminalView` 而非 `ModulePlaceholder`

---

## Phase 1: 基础框架搭建 (第 1-2 周)

### Task 1.1: Rust 后端模块骨架

**Files:**
- Create: `src-tauri/src/terminal/mod.rs`
- Create: `src-tauri/src/terminal/lib.rs`
- Create: `src-tauri/src/terminal/error.rs`
- Modify: `src-tauri/src/lib.rs` (注册模块)

- [ ] **Step 1: 创建 terminal 模块基础结构**

```rust
// src-tauri/src/terminal/mod.rs
pub mod error;
pub mod session;
pub mod config;
pub mod crypto;
pub mod ssh;
pub mod sftp;
pub mod ftp;
pub mod shell;
```

- [ ] **Step 2: 创建错误类型**

```rust
// src-tauri/src/terminal/error.rs
use thiserror::Error;

#[derive(Error, Debug)]
pub enum TerminalError {
    #[error("SSH connection failed: {0}")]
    SshConnection(String),
    #[error("SFTP operation failed: {0}")]
    SftpOperation(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Authentication failed: {0}")]
    AuthFailed(String),
}
```

- [ ] **Step 3: 在 lib.rs 中注册模块**

```rust
// src-tauri/src/lib.rs
pub mod terminal;
```

### Task 1.2: Cargo 依赖配置

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: 添加依赖**

```toml
[dependencies]
russh = { version = "0.61", features = ["aws-lc-rs"] }
russh-sftp = "2.1"
russh-config = "0.61"
portable-pty = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
thiserror = "2"
```

### Task 1.3: SSH 基础连接

**Files:**
- Create: `src-tauri/src/terminal/ssh/client.rs`
- Create: `src-tauri/src/terminal/ssh/mod.rs`
- Create: `src-tauri/src/terminal/commands.rs`

- [ ] **Step 1: 创建 SSH 客户端基础实现**

```rust
// src-tauri/src/terminal/ssh/client.rs
use russh::*;
use russh_keys::*;

pub struct SshClient {
    config: SshConfig,
    session: Option<client::Handle>,
}

impl SshClient {
    pub async fn connect(&mut self, config: SshConfig) -> Result<client::Handle, TerminalError> {
        let handler = SshClientHandler;
        let mut client = client::Client::new(
            (config.host.as_str(), config.port),
            Arc::new(handler),
        ).map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        let handle = client
            .authenticate_publickey(
                &config.username,
                keys::key_pair::ED25519,
            )
            .await
            .map_err(|e| TerminalError::AuthFailed(e.to_string()))?;

        self.session = Some(handle.clone());
        Ok(handle)
    }
}
```

- [ ] **Step 2: 创建 Tauri IPC 命令**

```rust
// src-tauri/src/terminal/commands.rs
use tauri::command;

#[command]
pub async fn ssh_connect(config: SshConfig) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    // 实现连接逻辑
    Ok(session_id)
}

#[command]
pub async fn ssh_disconnect(session_id: String) -> Result<(), String> {
    // 实现断开逻辑
    Ok(())
}

#[command]
pub async fn ssh_write(session_id: String, data: String) -> Result<(), String> {
    Ok(())
}

#[command]
pub async fn ssh_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    Ok(())
}
```

### Task 1.4: React 前端基础结构

**Files:**
- Create: `webui/src/components/terminal/TerminalView.tsx`
- Create: `webui/src/components/terminal/Toolbar.tsx`
- Create: `webui/src/components/terminal/SessionTabBar.tsx`
- Create: `webui/src/components/terminal/XtermTerminal.tsx`
- Create: `webui/src/components/terminal/StatusBar.tsx`
- Create: `webui/src/components/terminal/AIPanel/AIPanel.tsx`
- Create: `webui/src/components/terminal/AIPanel/AIChat.tsx`
- Create: `webui/src/components/terminal/AIPanel/QuickActions.tsx`
- Create: `webui/src/components/terminal/store/terminalStore.ts`
- Create: `webui/src/components/terminal/types/terminal.ts`

- [ ] **Step 1: 创建类型定义**

```typescript
// webui/src/components/terminal/types/terminal.ts
export interface SshConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthConfig;
}

export type AuthConfig =
  | { type: 'password'; password: string }
  | { type: 'key'; keyPath: string; passphrase?: string }
  | { type: 'agent' };

export interface Session {
  id: string;
  configId: string;
  type: 'local' | 'ssh' | 'sftp' | 'ftp' | 'batch';
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  title: string;
}
```

- [ ] **Step 2: 创建 Zustand Store**

```typescript
// webui/src/components/terminal/store/terminalStore.ts
import { create } from 'zustand';
import type { Session, SshConfig } from '../types/terminal';

interface TerminalState {
  sessions: Session[];
  activeSessionId: string | null;
  connections: SshConfig[];
  aiPanelVisible: boolean;

  addSession: (session: Session) => void;
  removeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string) => void;
  updateSessionStatus: (sessionId: string, status: Session['status']) => void;
  toggleAIPanel: () => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  sessions: [],
  activeSessionId: null,
  connections: [],
  aiPanelVisible: true,

  addSession: (session) => {
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id,
    }));
  },

  removeSession: (sessionId) => {
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== sessionId);
      const activeSessionId =
        state.activeSessionId === sessionId
          ? sessions[sessions.length - 1]?.id ?? null
          : state.activeSessionId;
      return { sessions, activeSessionId };
    });
  },

  setActiveSession: (sessionId) => {
    set({ activeSessionId: sessionId });
  },

  updateSessionStatus: (sessionId, status) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, status } : s,
      ),
    }));
  },

  toggleAIPanel: () => {
    set((state) => ({ aiPanelVisible: !state.aiPanelVisible }));
  },
}));
```

- [ ] **Step 3: 创建 TerminalView 主组件**

```typescript
// webui/src/components/terminal/TerminalView.tsx
import { Toolbar } from './Toolbar';
import { SessionTabBar } from './SessionTabBar';
import { XtermTerminal } from './XtermTerminal';
import { StatusBar } from './StatusBar';
import { AIPanel } from './AIPanel/AIPanel';
import { BatchModeView } from './BatchMode/BatchModeView';
import { useTerminalStore } from './store/terminalStore';

export function TerminalView() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const aiPanelVisible = useTerminalStore((s) => s.aiPanelVisible);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      <SessionTabBar />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {activeSession?.type === 'batch' ? (
            <BatchModeView />
          ) : activeSession ? (
            <XtermTerminal sessionId={activeSession.id} />
          ) : (
            <TerminalEmptyState />
          )}
        </div>
        {aiPanelVisible && <AIPanel sessionId={activeSessionId} />}
      </div>
      <StatusBar sessionId={activeSessionId} />
    </div>
  );
}

function TerminalEmptyState() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <div className="text-center">
        <p className="text-sm">点击「新建」创建一个终端会话</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 在 App.tsx 中接入 TerminalView**

在 `App.tsx` 中，当 `activeTabId === 'ssh'` 时渲染 `TerminalView`：

```typescript
// webui/src/App.tsx (仅此一处修改)
import { TerminalView } from '@/components/terminal/TerminalView';

// 在 Shell 组件中，将:
//   <ModulePlaceholder tab={activeTabId} />
// 替换为:
//   activeTabId === 'ssh' ? <TerminalView /> : <ModulePlaceholder tab={activeTabId} />
```

### Task 1.5: xterm.js 集成

**Files:**
- Modify: `webui/package.json`
- Modify: `webui/src/components/terminal/XtermTerminal.tsx`

- [ ] **Step 1: 添加 xterm.js 依赖**

```bash
cd webui && npm install @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
```

- [ ] **Step 2: 实现 xterm.js 组件**

```typescript
// webui/src/components/terminal/XtermTerminal.tsx
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';

interface Props {
  sessionId: string;
}

export function XtermTerminal({ sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      theme: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        cursor: 'hsl(var(--foreground))',
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminal.onData((data) => {
      // 调用 Tauri IPC: ssh_write(sessionId, data)
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      terminal.dispose();
    };
  }, [sessionId]);

  return <div ref={containerRef} className="h-full w-full" />;
}
```

---

## Phase 2: SSH 功能完善 (第 3-4 周)

### Task 2.1: SSH PTY 会话管理

**Files:**
- Modify: `src-tauri/src/terminal/ssh/client.rs`
- Modify: `src-tauri/src/terminal/session.rs`
- Modify: `src-tauri/src/terminal/commands.rs`

- [ ] **Step 1: 实现 PTY channel**

```rust
// src-tauri/src/terminal/ssh/client.rs
impl SshClient {
    pub async fn open_pty_session(&mut self) -> Result<Channel, TerminalError> {
        let channel = self.session
            .as_mut()
            .ok_or(TerminalError::SessionNotFound)?
            .channel_open_session()
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        channel
            .request_pty(
                false,
                "xterm-256color",
                80,
                24,
                0,
                0,
                &[],
            )
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        channel
            .request_shell(false)
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        Ok(channel)
    }
}
```

### Task 2.2: 会话管理器

**Files:**
- Create: `src-tauri/src/terminal/session.rs`

- [ ] **Step 1: 实现会话管理器**

```rust
// src-tauri/src/terminal/session.rs
use std::collections::HashMap;
use tokio::sync::RwLock;

pub struct SessionManager {
    sessions: RwLock<HashMap<String, Session>>,
    max_sessions: usize,
}

impl SessionManager {
    pub async fn create(&self, session: Session) -> Result<(), TerminalError> {
        let mut sessions = self.sessions.write().await;
        if sessions.len() >= self.max_sessions {
            return Err(TerminalError::TooManySessions);
        }
        sessions.insert(session.id.clone(), session);
        Ok(())
    }

    pub async fn get(&self, id: &str) -> Option<Session> {
        self.sessions.read().await.get(id).cloned()
    }

    pub async fn remove(&self, id: &str) -> Option<Session> {
        self.sessions.write().await.remove(id)
    }
}
```

### Task 2.3: 本地 Shell 实现

**Files:**
- Create: `src-tauri/src/terminal/shell/local.rs`
- Create: `src-tauri/src/terminal/shell/mod.rs`

- [ ] **Step 1: 实现本地 Shell**

```rust
// src-tauri/src/terminal/shell/local.rs
use portable_pty::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct LocalShell {
    master: Box<dyn MasterPty + Send>,
    reader: tokio::io::BufReader<Box<dyn Read + Send>>,
}

impl LocalShell {
    pub async fn spawn(shell: Option<&str>) -> Result<Self, TerminalError> {
        let builder = CommandBuilder::new(shell.unwrap_or("powershell.exe"));

        let pair = portable_pty::native_pty_system()
            .openpty(pty_size())
            .map_err(|e| TerminalError::ShellSpawn(e.to_string()))?;

        let _child = pair.slave.spawn_command(builder)
            .map_err(|e| TerminalError::ShellSpawn(e.to_string()))?;

        let reader = pair.master.try_clone_reader()
            .map_err(|e| TerminalError::ShellSpawn(e.to_string()))?;

        Ok(Self {
            master: pair.master,
            reader: tokio::io::BufReader::new(reader),
        })
    }
}
```

### Task 2.4: 会话标签栏组件

**Files:**
- Create: `webui/src/components/terminal/SessionTabBar.tsx`

- [ ] **Step 1: 创建会话标签栏组件**

```typescript
// webui/src/components/terminal/SessionTabBar.tsx
import { X } from 'lucide-react';
import { useTerminalStore } from './store/terminalStore';

export function SessionTabBar() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const removeSession = useTerminalStore((s) => s.removeSession);

  return (
    <div className="flex items-center gap-1 border-b px-2 py-1">
      {sessions.map((session) => (
        <button
          key={session.id}
          onClick={() => setActiveSession(session.id)}
          className={`flex items-center gap-1.5 rounded px-3 py-1 text-sm ${
            session.id === activeSessionId
              ? 'bg-background text-foreground'
              : 'text-muted-foreground hover:bg-sidebar-accent'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${
            session.status === 'connected' ? 'bg-emerald-500' : 'bg-muted'
          }`} />
          <span>{session.title}</span>
          <X
            className="h-3 w-3 opacity-0 hover:opacity-100"
            onClick={(e) => { e.stopPropagation(); removeSession(session.id); }}
          />
        </button>
      ))}
    </div>
  );
}
```

### Task 2.5: SSH Shell 覆盖

**Files:**
- Create: `src-tauri/src/terminal/shell/overrides.ps1`
- Create: `src-tauri/src/terminal/shell/overrides.sh`
- Modify: `src-tauri/src/terminal/shell/local.rs`

- [ ] **Step 1: 创建 PowerShell SSH 覆盖函数**

```powershell
# src-tauri/src/terminal/shell/overrides.ps1
function ssh {
    param(
        [string]$Target,
        [string]$Port = "22"
    )

    # 解析 user@host 格式
    if ($Target -match "^([^@]+)@(.+)$") {
        $Username = $Matches[1]
        $HostAddr = $Matches[2]
    } else {
        $HostAddr = $Target
    }

    # 调用 Mona Rust SSH 实现
    mona-ssh-internal -Host $HostAddr -Port $Port -Username $Username
}

function sftp {
    param([string]$Target)

    if ($Target -match "^([^@]+)@(.+)$") {
        $Username = $Matches[1]
        $HostAddr = $Matches[2]
    } else {
        $HostAddr = $Target
    }

    # 调用 Mona Rust SFTP 实现
    mona-sftp-internal -Host $HostAddr -Username $Username
}
```

---

## Phase 3: SFTP 功能 (第 5-6 周)

### Task 3.1: SFTP 客户端

**Files:**
- Create: `src-tauri/src/terminal/sftp/client.rs`
- Create: `src-tauri/src/terminal/sftp/mod.rs`
- Modify: `src-tauri/src/terminal/commands.rs`

- [ ] **Step 1: 实现 SFTP 客户端**

```rust
// src-tauri/src/terminal/sftp/client.rs
use russh_sftp::client::*;

pub struct SftpClient {
    session: SshSession,
    sftp: Client,
}

impl SftpClient {
    pub async fn connect(config: &SshConfig) -> Result<Self, TerminalError> {
        // 建立 SSH 连接
        let session = SshSession::connect(config).await?;

        // 打开 SFTP 子系统
        let sftp = Client::init(&session)
            .await
            .map_err(|e| TerminalError::SftpOperation(e.to_string()))?;

        Ok(Self { session, sftp })
    }

    pub async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, TerminalError> {
        let mut dir = self.sftp
            .readdir(path)
            .await
            .map_err(|e| TerminalError::SftpOperation(e.to_string()))?;

        Ok(dir.drain(..)
            .map(|(_, stat)| FileEntry::from(stat))
            .collect())
    }
}
```

### Task 3.2: 文件管理器 UI

**Files:**
- Create: `webui/src/components/terminal/FileManager/FileManager.tsx`
- Create: `webui/src/components/terminal/FileManager/FileList.tsx`
- Create: `webui/src/components/terminal/FileManager/FileItem.tsx`
- Create: `webui/src/components/terminal/FileManager/FileToolbar.tsx`

- [ ] **Step 1: 创建文件管理器组件**

```typescript
// webui/src/components/terminal/FileManager/FileManager.tsx
interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: Date;
}

interface Props {
  sessionId: string;
  initialPath?: string;
}

export function FileManager({ sessionId, initialPath = '/' }: Props) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath, sessionId]);

  const loadDirectory = async (path: string) => {
    const entries = await invoke<FileEntry[]>('sftp_list', {
      sessionId,
      path,
    });
    setFiles(entries);
  };

  return (
    <div className="flex flex-col h-full border rounded">
      <FileToolbar
        currentPath={currentPath}
        onNavigate={setCurrentPath}
        selectedCount={selectedFiles.size}
      />
      <FileList
        files={files}
        selectedFiles={selectedFiles}
        onSelect={setSelectedFiles}
        onDoubleClick={handleFileOpen}
      />
    </div>
  );
}
```

### Task 3.3: 文件上传/下载

**Files:**
- Modify: `src-tauri/src/terminal/sftp/client.rs`
- Modify: `src-tauri/src/terminal/commands.rs`
- Create: `webui/src/components/terminal/FileManager/FileUpload.tsx`

- [ ] **Step 1: 添加上传下载命令**

```rust
// src-tauri/src/terminal/commands.rs
#[command]
pub async fn sftp_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    // 实现上传逻辑
    Ok(())
}

#[command]
pub async fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    // 实现下载逻辑
    Ok(())
}
```

---

## Phase 4: AI 集成 (第 7-8 周)

### Task 4.1: Agent SSH 工具

**Files:**
- Create: `mona/agent/tools/ssh.py`
- Create: `mona/agent/tools/sftp.py`
- Modify: `mona/agent/tools/registry.py`

- [ ] **Step 1: 创建 SSH 工具**

```python
# mona/agent/tools/ssh.py
from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import StringSchema, IntegerSchema, tool_parameters_schema

@tool_parameters(
    tool_parameters_schema(
        host=StringSchema("SSH server hostname or IP"),
        port=IntegerSchema(22, description="SSH port, default 22"),
        username=StringSchema("SSH username"),
        command=StringSchema("Command to execute on remote server"),
    )
)
class SSHExecTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "ssh"

    @property
    def name(self) -> str:
        return "ssh_exec"

    @property
    def description(self) -> str:
        return "Execute a command on a remote SSH server."

    async def execute(self, host: str, username: str, command: str,
                      port: int = 22, **kwargs) -> str:
        # 通过 Tauri IPC 调用 Rust 后端
        result = await invoke('ssh_execute', {
            'host': host,
            'port': port,
            'username': username,
            'command': command,
        })
        return result
```

### Task 4.2: AI 面板组件

**Files:**
- Create: `webui/src/components/terminal/AIPanel/AIPanel.tsx`
- Create: `webui/src/components/terminal/AIPanel/AIChat.tsx`
- Create: `webui/src/components/terminal/AIPanel/QuickActions.tsx`

- [ ] **Step 1: 创建 AI 面板主组件**

```typescript
// webui/src/components/terminal/AIPanel/AIPanel.tsx
import { AIChat } from './AIChat';
import { QuickActions } from './QuickActions';

interface Props {
  sessionId: string | null;
}

export function AIPanel({ sessionId }: Props) {
  return (
    <div className="flex w-80 flex-col border-l">
      <div className="flex-1 overflow-auto">
        <AIChat sessionId={sessionId} />
      </div>
      <div className="border-t p-3">
        <QuickActions sessionId={sessionId} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 创建快捷功能组件**

```typescript
// webui/src/components/terminal/AIPanel/QuickActions.tsx
import { Terminal, Wrench, FileCode, BarChart3, FolderSync, Shield } from 'lucide-react';

interface Props {
  sessionId: string | null;
}

const QUICK_ACTIONS = [
  { id: 'explain', icon: Terminal, label: '解释命令' },
  { id: 'fix', icon: Wrench, label: '修复错误' },
  { id: 'script', icon: FileCode, label: '生成脚本' },
  { id: 'analyze', icon: BarChart3, label: '分析输出' },
  { id: 'sftp', icon: FolderSync, label: 'SFTP助手' },
  { id: 'perm', icon: Shield, label: '权限管理' },
];

export function QuickActions({ sessionId }: Props) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">快捷 AI 功能</h3>
      <div className="grid grid-cols-2 gap-1.5">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.id}
            className="flex items-center gap-1.5 rounded p-1.5 text-xs hover:bg-sidebar-accent"
          >
            <action.icon className="h-3.5 w-3.5" />
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 创建 AI 对话组件**

```typescript
// webui/src/components/terminal/AIPanel/AIChat.tsx
import { useState } from 'react';
import { Send } from 'lucide-react';

interface Props {
  sessionId: string | null;
}

export function AIChat({ sessionId }: Props) {
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [input, setInput] = useState('');

  const handleSend = async () => {
    if (!input.trim()) return;
    setMessages((prev) => [...prev, { role: 'user', content: input }]);
    setInput('');
    // 调用 Mona Agent
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {messages.map((msg, i) => (
          <div key={i} className={`text-sm ${msg.role === 'user' ? 'text-foreground' : 'text-muted-foreground'}`}>
            {msg.content}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t p-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入问题..."
          className="flex-1 bg-transparent text-sm outline-none"
        />
        <button onClick={handleSend} className="p-1 hover:bg-sidebar-accent rounded">
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
```

---

## Phase 5: 批量 SSH 模式 (第 9-10 周)

### Task 5.1: 批量模式标签

**Files:**
- Create: `webui/src/components/terminal/BatchMode/BatchModeView.tsx`

- [ ] **Step 1: 创建批量模式组件**

```typescript
// webui/src/components/terminal/BatchMode/BatchModeView.tsx
export function BatchModeTab() {
  return (
    <div className="flex h-full">
      <BatchSidebar />
      <BatchRightPane />
    </div>
  );
}
```

### Task 5.2: 批量会话列表

**Files:**
- Create: `webui/src/components/terminal/BatchMode/BatchSessionList.tsx`
- Create: `webui/src/components/terminal/BatchMode/SessionCheckbox.tsx`
- Create: `webui/src/components/terminal/BatchMode/SessionGroupManager.tsx`

- [ ] **Step 1: 创建会话列表组件**

```typescript
// webui/src/components/terminal/BatchMode/BatchSessionList.tsx
interface BatchSession {
  id: string;
  name: string;
  host: string;
  status: 'connected' | 'disconnected' | 'connecting';
}

interface Props {
  sessions: BatchSession[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
}

export function BatchSessionList({ sessions, selectedIds, onSelectionChange }: Props) {
  const handleToggle = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    onSelectionChange(newSelected);
  };

  const handleSelectAll = () => {
    onSelectionChange(new Set(sessions.map(s => s.id)));
  };

  return (
    <div className="w-64 border-r bg-gray-900 p-4">
      <div className="flex gap-2 mb-4">
        <button onClick={handleSelectAll} className="text-sm">全选</button>
        <button onClick={() => onSelectionChange(new Set())} className="text-sm">反选</button>
      </div>

      <div className="space-y-2">
        {sessions.map(session => (
          <SessionCheckbox
            key={session.id}
            session={session}
            checked={selectedIds.has(session.id)}
            onToggle={() => handleToggle(session.id)}
          />
        ))}
      </div>

      <SessionGroupManager />
    </div>
  );
}
```

### Task 5.3: 批量命令输入

**Files:**
- Create: `webui/src/components/terminal/BatchMode/BatchCommandInput.tsx`
- Create: `webui/src/components/terminal/BatchMode/BatchTerminalGrid.tsx`
- Create: `webui/src/components/terminal/BatchMode/BatchTabBar.tsx`

- [ ] **Step 1: 创建批量命令输入组件**

```typescript
// webui/src/components/terminal/BatchMode/BatchCommandInput.tsx
interface Props {
  selectedSessionIds: string[];
  onExecute: (command: string, sessionIds: string[]) => void;
}

export function BatchCommandInput({ selectedSessionIds, onExecute }: Props) {
  const [command, setCommand] = useState('');

  const handleExecute = () => {
    if (command.trim() && selectedSessionIds.length > 0) {
      onExecute(command, Array.from(selectedSessionIds));
      setCommand('');
    }
  };

  return (
    <div className="border-b p-4">
      <textarea
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder="输入批量命令..."
        className="w-full bg-gray-800 text-white rounded p-2 font-mono"
        rows={3}
      />
      <div className="flex justify-between mt-2">
        <span className="text-sm text-gray-400">
          已选择 {selectedSessionIds.length} 个会话
        </span>
        <div className="flex gap-2">
          <button onClick={() => setCommand('')} className="px-3 py-1 text-sm">
            清空
          </button>
          <button
            onClick={handleExecute}
            disabled={!command.trim() || selectedSessionIds.length === 0}
            className="px-3 py-1 bg-blue-600 rounded text-sm disabled:opacity-50"
          >
            执行
          </button>
        </div>
      </div>
    </div>
  );
}
```

### Task 5.4: 批量命令后端

**Files:**
- Modify: `src-tauri/src/terminal/commands.rs`
- Modify: `src-tauri/src/terminal/session.rs`

- [ ] **Step 1: 实现批量命令执行**

```rust
// src-tauri/src/terminal/commands.rs
#[command]
pub async fn batch_ssh_execute(
    session_ids: Vec<String>,
    command: String,
) -> Result<Vec<BatchResult>, String> {
    let mut results = Vec::new();

    for session_id in session_ids {
        let result = ssh_execute_internal(&session_id, &command).await;
        results.push(BatchResult {
            session_id,
            success: result.is_ok(),
            output: result.unwrap_or_default(),
            error: result.err(),
        });
    }

    Ok(results)
}
```

---

## Phase 6: 连接管理 (第 11 周)

### Task 6.1: 连接配置持久化

**Files:**
- Create: `src-tauri/src/terminal/config.rs`
- Modify: `src-tauri/src/terminal/commands.rs`

- [ ] **Step 1: 实现配置存储**

```rust
// src-tauri/src/terminal/config.rs
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(skip_serializing)]
    pub password: Option<String>>,
    pub key_path: Option<String>,
}

impl ConnectionConfig {
    pub fn load_all() -> Result<Vec<Self>, TerminalError> {
        let config_path = get_config_dir().join("connections.json");
        if !config_path.exists() {
            return Ok(Vec::new());
        }
        let content = std::fs::read_to_string(config_path)
            .map_err(|e| TerminalError::ConfigLoad(e.to_string()))?;
        serde_json::from_str(&content)
            .map_err(|e| TerminalError::ConfigLoad(e.to_string()))
    }

    pub fn save_all(configs: &[ConnectionConfig]) -> Result<(), TerminalError> {
        let config_path = get_config_dir().join("connections.json");
        let content = serde_json::to_string_pretty(configs)
            .map_err(|e| TerminalError::ConfigSave(e.to_string()))?;
        std::fs::write(config_path, content)
            .map_err(|e| TerminalError::ConfigSave(e.to_string()))
    }
}
```

### Task 6.2: 连接对话框

**Files:**
- Create: `webui/src/components/terminal/Dialogs/NewConnectionDialog.tsx`
- Create: `webui/src/components/terminal/Dialogs/ConnectionSettingsDialog.tsx`

- [ ] **Step 1: 创建新建连接对话框**

```typescript
// webui/src/components/terminal/Dialogs/NewConnectionDialog.tsx
interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: SshConfig) => void;
}

export function NewConnectionDialog({ isOpen, onClose, onSave }: Props) {
  const [config, setConfig] = useState<Partial<SshConfig>>({
    protocol: 'ssh',
    port: 22,
  });

  const handleSave = () => {
    onSave({
      ...config,
      id: uuid(),
    } as SshConfig);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建连接</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>连接类型</Label>
            <RadioGroup
              value={config.protocol}
              onValueChange={(v) => setConfig({ ...config, protocol: v })}
            >
              <div className="flex gap-4">
                <RadioGroupItem value="ssh" label="SSH" />
                <RadioGroupItem value="sftp" label="SFTP" />
              </div>
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label>连接名称</Label>
            <Input
              value={config.name || ''}
              onChange={(e) => setConfig({ ...config, name: e.target.value })}
              placeholder="我的服务器"
            />
          </div>

          {/* 其他字段... */}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSave}>保存并连接</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

---

## Phase 7: 收尾与优化 (第 12 周)

### Task 7.1: 状态栏

**Files:**
- Create: `webui/src/components/terminal/StatusBar.tsx`

- [ ] **Step 1: 创建状态栏组件**

```typescript
// webui/src/components/terminal/StatusBar.tsx
export function StatusBar({ sessionId }: { sessionId: string | null }) {
  const session = useTerminalStore(state =>
    sessionId ? state.sessions.get(sessionId) : null
  );

  if (!session) return null;

  return (
    <div className="flex items-center gap-4 px-4 py-1 border-t bg-gray-900 text-sm">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${
          session.status === 'connected' ? 'bg-green-500' : 'bg-gray-500'
        }`} />
        <span>{session.status}</span>
      </div>

      {session.type === 'ssh' && (
        <>
          <div>延迟: {session.latency}ms</div>
          <div>编码: UTF-8</div>
        </>
      )}
    </div>
  );
}
```

### Task 7.2: 设置页面

**Files:**
- Create: `webui/src/components/terminal/Settings/TerminalSettings.tsx`
- Create: `webui/src/components/terminal/Settings/SSHOverrideSettings.tsx`

- [ ] **Step 1: 创建设置组件**

```typescript
// webui/src/components/terminal/Settings/TerminalSettings.tsx
export function TerminalSettings() {
  const [settings, setSettings] = useState({
    overrideSSH: true,
    overrideSFTP: true,
    autoSaveConnection: true,
    autoReconnect: false,
  });

  return (
    <div className="p-4 space-y-6">
      <h2 className="text-lg font-medium">终端设置</h2>

      <div className="space-y-4">
        <SwitchField
          label="覆盖系统 SSH"
          description="使用 Mona SSH 替换系统 ssh 命令"
          checked={settings.overrideSSH}
          onChange={(v) => setSettings({ ...settings, overrideSSH: v })}
        />

        <SwitchField
          label="覆盖系统 SFTP"
          description="使用 Mona SFTP 替换系统 sftp 命令"
          checked={settings.overrideSFTP}
          onChange={(v) => setSettings({ ...settings, overrideSFTP: v })}
        />

        <SwitchField
          label="自动保存连接"
          description="连接成功后自动保存配置"
          checked={settings.autoSaveConnection}
          onChange={(v) => setSettings({ ...settings, autoSaveConnection: v })}
        />

        <SwitchField
          label="断线自动重连"
          description="连接断开时自动尝试重连"
          checked={settings.autoReconnect}
          onChange={(v) => setSettings({ ...settings, autoReconnect: v })}
        />
      </div>
    </div>
  );
}
```

### Task 7.3: 主题适配

**Files:**
- Modify: `webui/src/components/terminal/store/terminalStore.ts`
- Modify: `webui/src/components/terminal/XtermTerminal.tsx`

- [ ] **Step 1: 实现主题切换**

```typescript
// webui/src/components/terminal/XtermTerminal.tsx
const THEMES = {
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#ffffff',
  },
  light: {
    background: '#ffffff',
    foreground: '#333333',
    cursor: '#000000',
  },
};

interface Props {
  sessionId: string;
  theme?: 'dark' | 'light';
}

export function XtermTerminal({ sessionId, theme = 'dark' }: Props) {
  const terminalTheme = THEMES[theme];

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme;
    }
  }, [theme, terminalTheme]);

  // ...
}
```

---

## 验收标准

### 功能验收
- [ ] 可以创建、保存、编辑、删除 SSH/SFTP 连接
- [ ] 可以通过密码或密钥连接远程服务器
- [ ] 终端支持交互式命令执行
- [ ] 支持多 Tab 同时连接
- [ ] SFTP 可以浏览、上传、下载文件
- [ ] 本地 PowerShell/cmd 可正常执行
- [ ] `ssh` 和 `sftp` 命令自动使用 Mona 实现
- [ ] 批量 SSH 模式可以同时管理多个连接
- [ ] AI 快捷功能可以正常调用

### 性能验收
- [ ] 终端输入延迟 < 50ms
- [ ] 文件传输速度接近原生 SFTP
- [ ] 支持 10+ 并发会话

### UI/UX 验收
- [ ] 左右两栏布局正常显示
- [ ] Tab 栏可拖拽排序
- [ ] 文件管理器可折叠/展开
- [ ] 窗口大小变化时终端自适应
- [ ] 主题切换正常

---

## 时间总览

| Phase | 内容 | 周数 |
|-------|------|------|
| Phase 1 | 基础框架搭建 | 1-2 |
| Phase 2 | SSH 功能完善 | 3-4 |
| Phase 3 | SFTP 功能 | 5-6 |
| Phase 4 | AI 集成 | 7-8 |
| Phase 5 | 批量 SSH 模式 | 9-10 |
| Phase 6 | 连接管理 | 11 |
| Phase 7 | 收尾与优化 | 12 |

**总计：约 12 周**
