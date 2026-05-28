# Mona Terminal Module - 详细设计方案

## 概述

> **目标：** 基于 Mona Tauri 项目，开发一个 Windows 桌面终端客户端，支持 SSH、SFTP、FTP、本地 Shell 协议。

**技术栈：**
- 后端：Rust (Tauri 2) + russh + russh-sftp + portable-pty + suppaftp
- 前端：React 18 + TypeScript + xterm.js + Tailwind CSS + Radix UI
- 打包：Tauri 2 build → Windows .exe/.msi

---

## 一、架构设计

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      Mona Terminal App                           │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    React 前端                              │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │   │
│  │  │ 侧边栏    │ │ Tab 栏   │ │ 终端区域  │ │ 文件管理  │   │   │
│  │  │ 连接列表  │ │ 会话标签  │ │ xterm.js │ │ SFTP/FTP │   │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                            │                                    │
│                     Tauri IPC (invoke/emit)                     │
│                            │                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   Rust 后端 (src-tauri)                  │   │
│  │  ┌─────────────────────────────────────────────────┐  │   │
│  │  │              Terminal Module (新增)                │  │   │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │  │   │
│  │  │  │ SSH/SFTP │ │  FTP    │ │ Local PTY │        │  │   │
│  │  │  │ russh   │ │suppaftp │ │portable-pty│       │  │   │
│  │  │  └──────────┘ └──────────┘ └──────────┘        │  │   │
│  │  │  ┌──────────────────────────────────────────┐   │  │   │
│  │  │  │          Session Manager                  │   │  │   │
│  │  │  │  (连接池、会话管理、心跳保活)               │   │  │   │
│  │  │  └──────────────────────────────────────────┘   │  │   │
│  │  └─────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 模块划分

```
src-tauri/src/
├── lib.rs                    # 入口，注册新模块
├── terminal/                 # 终端模块（新增）
│   ├── mod.rs
│   ├── commands.rs           # Tauri IPC 命令
│   ├── session.rs            # 会话管理
│   ├── ssh_client.rs         # SSH 连接实现
│   ├── sftp_client.rs        # SFTP 文件操作
│   ├── ftp_client.rs         # FTP 支持
│   ├── local_shell.rs        # 本地 Shell
│   ├── config.rs             # 连接配置
│   └── crypto.rs             # 凭据加密
└── ...

src/ (React 前端)
├── components/
│   └── terminal/
│       ├── TerminalView.tsx       # 主视图
│       ├── Sidebar/
│       │   ├── ConnectionList.tsx    # 连接列表
│       │   ├── ConnectionItem.tsx    # 单个连接
│       │   └── NewConnectionDialog.tsx # 新建连接对话框
│       ├── TabBar/
│       │   ├── TabBar.tsx            # Tab 栏
│       │   └── TabItem.tsx           # 单个 Tab
│       ├── Terminal/
│       │   ├── XtermTerminal.tsx     # xterm.js 封装
│       │   └── TerminalToolbar.tsx   # 工具栏
│       └── FileManager/
│           ├── FileManager.tsx       # 文件管理器
│           ├── FileList.tsx          # 文件列表
│           └── FileUpload.tsx        # 上传组件
├── hooks/
│   └── useTerminal.ts         # 终端 Hook
└── store/
    └── terminalStore.ts       # 状态管理
```

---

## 二、页面布局设计

### 2.1 主视图布局（左右两栏）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Mona Terminal                                            [─] [□] [×]         │  ← 只有窗口标题栏，无额外标题
├──────────────────────────────────────────────────┬────────────────────────────┤
│                                                  │                            │
│  左栏                                           │       右栏                 │
│  ┌────────────────────────────────────────────┐ │ ┌────────────────────────┐ │
│  │ 功能按钮区                                 │ │ │                        │ │
│  │ [ + 新建会话 ] [ 📂 打开会话 ] [ ⚙ 设置 ] │ │ │   AI 对话框           │ │
│  │ [ 📄 导出日志 ] [ 🔌 断开全部 ]           │ │ │                        │ │
│  ├────────────────────────────────────────────┤ │ ├────────────────────────┤ │
│  │                                            │ │ │   快捷 AI 功能区      │ │
│  │                                            │ │ │                        │ │
│  │           Shell 区域                       │ │ │  [💻 解释命令]        │ │
│  │                                            │ │ │  [📝 生成脚本]         │ │
│  │ ┌────────────────────────────────────────┐ │ │ │  [🔧 修复错误]         │ │
│  │ │ root@server:~$ █                      │ │ │ │  [📊 分析输出]         │ │
│  │ │                                        │ │ │ │  [🗄️ SFTP 助手]       │ │
│  │ │                                        │ │ │ │  [🔍 搜索命令]         │ │
│  │ │                                        │ │ │ │  [📁 文件操作]         │ │
│  │ │                                        │ │ │ │  [🔐 权限管理]         │ │
│  │ └────────────────────────────────────────┘ │ │ └────────────────────────┘ │
│  │                                            │ │                            │
│  └────────────────────────────────────────────┘ │                            │
│                                                  │                            │
│  [状态栏：已连接 | 延迟: 12ms | 编码: UTF-8]     │                            │
│                                                  │                            │
└──────────────────────────────────────────────────┴────────────────────────────┘
```

### 2.2 左栏详细布局

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ┌───────────────────────────────────────────────────┐ │
│  │  功能按钮组                                      │ │
│  │  ┌───────┐  ┌───────┐  ┌───────┐              │ │
│  │  │+新建 │  │📂打开 │  │⚙ 设置 │  ...         │ │
│  │  └───────┘  └───────┘  └───────┘              │ │
│  │  ┌───────┐  ┌───────┐                          │ │
│  │  │📄导出 │  │🔌断开 │                          │ │
│  │  └───────┘  └───────┘                          │ │
│  └───────────────────────────────────────────────────┘ │
│                                                         │
│  ┌───────────────────────────────────────────────────┐ │
│  │  Shell 区域                                       │ │
│  │  ┌───────────────────────────────────────────────┐ │ │
│  │  │ root@server:~$ █                          │ │ │
│  │  │                                             │ │ │
│  │  │ ┌───────────────────────────────────────┐   │ │ │
│  │  │ │ 会话标签区：[Tab1] [Tab2] [+]       │   │ │ │
│  │  │ └───────────────────────────────────────┘   │ │ │
│  │  │                                             │ │ │
│  │  │ 终端内容区：                                │ │ │
│  │  │ root@server:~$ ls -la                       │ │ │
│  │  │ total 40                                    │ │ │
│  │  │ drwxr-xr-x 5 root root 4096 May 25 10:00 .  │ │ │
│  │  │ ...                                        │ │ │
│  │  └───────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────┘ │
│                                                         │
│  [状态信息：● 已连接 | 延迟 12ms | 编码 UTF-8]          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 2.3 右栏详细布局

```
┌───────────────────────────────────┐
│                                   │
│  ┌─────────────────────────────┐ │
│  │         AI 对话框          │ │
│  ├─────────────────────────────┤ │
│  │  对话历史区：              │ │
│  │ ┌───────────────────────┐ │ │
│  │ │ 👤: 帮我查看下当前目录 │ │ │
│  │ │   的磁盘使用情况       │ │ │
│  │ ├───────────────────────┤ │ │
│  │ │ 🤖: 运行 `df -h` 命令  │ │ │
│  │ ├───────────────────────┤ │ │
│  │ │ 👤: 显示下系统信息     │ │ │
│  │ │   ...               │ │ │
│  │ └───────────────────────┘ │ │
│  ├─────────────────────────────┤ │
│  │  输入框：                  │ │
│  │ ┌─────────────────────────┐ │ │
│  │ │ [输入问题...]  [发送]  │ │ │
│  │ └─────────────────────────┘ │ │
│  └─────────────────────────────┘ │
│                                   │
│  ┌─────────────────────────────┐ │
│  │     快捷 AI 功能区        │ │
│  ├─────────────────────────────┤ │
│  │  ┌───────────────────────┐ │ │
│  │  │ [💻 解释当前命令]   │ │ │
│  │  │ [📝 生成 Shell 脚本] │ │ │
│  │  │ [🔧 修复命令错误]   │ │ │
│  │  │ [📊 分析终端输出]   │ │ │
│  │  ├───────────────────────┤ │ │
│  │  │ [📁 SFTP 快捷操作]   │ │ │
│  │  │   - 上传文件          │ │ │
│  │  │   - 下载文件          │ │ │
│  │  │   - 编辑文件          │ │ │
│  │  ├───────────────────────┤ │ │
│  │  │ [🔍 常用命令搜索]    │ │ │
│  │  │ [🔐 权限管理助手]    │ │ │
│  │  └───────────────────────┘ │ │
│  └─────────────────────────────┘ │
│                                   │
└───────────────────────────────────┘
```

### 2.4 新建会话对话框

```
┌────────────────────────────────────────────────────────────┐
│                   新建会话                                 │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  会话类型:  ○ SSH  ● SFTP  ○ FTP  ○ 本地 Shell           │
│                                                            │
│  ─────────────────────────────────────────────────────    │
│                                                            │
│  会话名称: [我的服务器 ___________________________]         │
│                                                            │
│  主机地址: [192.168.1.100 ____________________] : 22     │
│                                                            │
│  用户名:   [root _______________________________]         │
│                                                            │
│  认证方式: ○ 密码  ● 密钥文件  ○ SSH Agent               │
│                                                            │
│  密码:     [••••••••••• _____________________] [显示]     │
│                                                            │
│  密钥文件: [C:\Users\...\.ssh\id_rsa ___][浏览...]       │
│                                                            │
│  ─────────────────────────────────────────────────────    │
│                                                            │
│  高级选项 (点击展开)                                        │
│  ├─ 超时时间: [30] 秒                                      │
│  ├─ 编码:    [UTF-8 ▼]                                   │
│  └─ 代理:    [无 ▼]                                       │
│                                                            │
│  ─────────────────────────────────────────────────────    │
│                                                            │
│                   [取消]           [保存并连接]              │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 2.5 文件管理器布局

```
┌──────────────────────────────────────────┐
│ 文件管理器 ─ root@server1          [×]  │
├──────────────────────────────────────────┤
│  ┌─ 路径导航 ───────────────────────┐  │
│  │ /home/user/project/src          │  │
│  └──────────────────────────────────┘  │
├──────────────────────────────────────────┤
│ ┌──────────┬──────────────┬──────────┐  │
│ │ 名称     │ 大小         │ 修改时间  │  │
│ ├──────────┼──────────────┼──────────┤  │
│ │ 📁 src   │ -            │ 今天     │  │
│ │ 📁 dist  │ -            │ 今天     │  │
│ │ 📄 index │ 1.2 KB       │ 昨天     │  │
│ │ 📄 pac...│ 2.1 KB       │ 昨天     │  │
│ │ 🖼 logo  │ 45.3 KB      │ 3天前    │  │
│ └──────────┴──────────────┴──────────┘  │
├──────────────────────────────────────────┤
│  已选择: index.html (1.2 KB)             │
│  ┌────────────────────────────────────┐   │
│  │  [下载] [重命名] [删除] [移动]     │   │
│  └────────────────────────────────────┘   │
│                                           │
│  拖拽文件到此处上传                        │
└──────────────────────────────────────────┘
```

---

## 三、功能模块设计

### 3.1 SSH 模块

**核心功能：**
- 密码认证 / 密钥认证
- 交互式 PTY 会话
- 命令执行
- 端口转发（本地、远程）
- 会话保持（心跳保活）
- 自动重连

**Tauri IPC 接口：**
```rust
// 命令
#[tauri::command]
async fn ssh_connect(config: SshConfig) -> Result<String, String>;

#[tauri::command]
async fn ssh_disconnect(session_id: String) -> Result<(), String>;

#[tauri::command]
async fn ssh_write(session_id: String, data: String) -> Result<(), String>;

#[tauri::command]
async fn ssh_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String>;

#[tauri::command]
async fn ssh_execute(session_id: String, command: String) -> Result<String, String>;
```

### 3.2 SFTP 模块

**核心功能：**
- 浏览远程目录
- 上传/下载文件
- 创建/删除目录
- 重命名
- 权限修改 (chmod)
- 符号链接处理
- 断点续传（大文件）

**Tauri IPC 接口：**
```rust
#[tauri::command]
async fn sftp_list(session_id: String, path: String) -> Result<Vec<FileEntry>, String>;

#[tauri::command]
async fn sftp_download(session_id: String, remote_path: String, local_path: String) -> Result<(), String>;

#[tauri::command]
async fn sftp_upload(session_id: String, local_path: String, remote_path: String) -> Result<(), String>;

#[tauri::command]
async fn sftp_mkdir(session_id: String, path: String) -> Result<(), String>;

#[tauri::command]
async fn sftp_remove(session_id: String, path: String, is_dir: bool) -> Result<(), String>;

#[tauri::command]
async fn sftp_rename(session_id: String, old_path: String, new_path: String) -> Result<(), String>;

#[tauri::command]
async fn sftp_chmod(session_id: String, path: String, mode: u32) -> Result<(), String>;
```

### 3.3 FTP 模块

**核心功能：**
- FTP/FTPS 支持
- 主动/被动模式
- 文件上传/下载
- 目录浏览
- 匿名登录

### 3.4 本地 Shell 模块

**核心功能：**
- Windows cmd.exe / PowerShell
- Unix bash/zsh (WSL)
- PTY 分配
- 环境变量配置

---

## 四、数据模型

### 4.1 连接配置

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,              // UUID
    pub name: String,            // 连接名称
    pub protocol: Protocol,       // SSH/SFTP/FTP/LOCAL
    pub host: String,            // 主机地址
    pub port: u16,              // 端口
    pub username: String,        // 用户名
    pub auth: AuthConfig,        // 认证配置
    pub options: ConnectionOptions, // 连接选项
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuthConfig {
    Password(String),
    KeyFile { path: String, passphrase: Option<String> },
    Agent, // SSH Agent
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionOptions {
    pub timeout: u64,           // 超时秒数
    pub encoding: String,       // 字符编码
    pub keepalive: u64,         // 心跳间隔
    pub compress: bool,        // 压缩
}
```

### 4.2 会话状态

```rust
#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,             // 会话 ID
    pub config_id: String,      // 关联的配置 ID
    pub protocol: Protocol,
    pub status: SessionStatus,
    pub created_at: DateTime,
    pub last_active: DateTime,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionStatus {
    Connecting,
    Connected,
    Disconnected,
    Error(String),
}
```

---

## 五、前端组件设计

### 5.1 组件树

```
TerminalApp
├── LeftPanel (左栏)
│   ├── ButtonBar (功能按钮区)
│   │   ├── NewSessionButton
│   │   ├── OpenSessionButton
│   │   ├── SettingsButton
│   │   ├── ExportLogsButton
│   │   └── DisconnectAllButton
│   └── ShellArea (Shell区域)
│       ├── TabBar (会话标签)
│       │   └── TabItem[]
│       └── TerminalContent
│           └── XtermTerminal
├── RightPanel (右栏)
│   ├── AIChatDialog (AI对话框)
│   │   ├── ChatHistory
│   │   └── ChatInput
│   └── QuickAIFunctions (快捷AI功能区)
│       ├── FunctionGroup1 (终端相关)
│       │   ├── ExplainCommandButton
│       │   ├── GenerateScriptButton
│       │   ├── FixErrorButton
│       │   └── AnalyzeOutputButton
│       ├── FunctionGroup2 (SFTP相关)
│       │   ├── SFTPHelperButton
│       │   └── FileOperationsButton
│       └── FunctionGroup3 (其他)
│           ├── SearchCommandButton
│           └── PermissionManagerButton
└── StatusBar (状态栏)
```

### 5.2 状态管理

```typescript
// terminalStore.ts
interface TerminalState {
  connections: ConnectionConfig[];
  sessions: Map<string, Session>;
  activeSessionId: string | null;
  sidebarCollapsed: boolean;
  fileManagerVisible: boolean;
}

// 主要状态
interface ConnectionStore {
  // 连接管理
  addConnection: (config: ConnectionConfig) => void;
  removeConnection: (id: string) => void;
  updateConnection: (id: string, config: Partial<ConnectionConfig>) => void;

  // 会话管理
  createSession: (configId: string) => Promise<string>;
  closeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string) => void;
}

// 终端状态
interface TerminalStore {
  write: (sessionId: string, data: string) => void;
  resize: (sessionId: string, cols: number, rows: number) => void;
}
```

---

## 六、安全设计

### 6.1 凭据存储

- SSH 密码 / 密钥文件路径 → 使用 Windows DPAPI 加密存储
- 配置数据 → SQLite 数据库，字段级加密
- 内存中的敏感数据 → 使用后立即清零

### 6.2 连接安全

- SSH 主机密钥验证（首次连接记录，后续校验）
- FTPS 证书验证
- 内网地址连接警告

---

## 七、文件结构

### 7.1 Rust 后端

```
src-tauri/src/
├── lib.rs                         # 模块注册
├── terminal/                      # 终端模块
│   ├── mod.rs                     # 模块入口
│   ├── lib.rs                     # 对外 API
│   ├── error.rs                   # 错误类型
│   ├── commands.rs                # Tauri IPC 命令
│   ├── config.rs                  # 连接配置
│   ├── crypto.rs                  # 凭据加密
│   ├── session.rs                 # 会话管理
│   ├── ssh/
│   │   ├── mod.rs
│   │   ├── client.rs              # SSH 客户端
│   │   └── channel.rs             # SSH Channel
│   ├── sftp/
│   │   ├── mod.rs
│   │   └── client.rs              # SFTP 客户端
│   ├── ftp/
│   │   ├── mod.rs
│   │   └── client.rs              # FTP 客户端
│   └── shell/
│       ├── mod.rs
│       └── local.rs               # 本地 Shell
├── main.rs
└── ...
```

### 7.2 React 前端

```
src/
├── components/
│   └── terminal/
│       ├── TerminalApp.tsx         # 主应用组件
│       ├── LeftPanel/
│       │   ├── LeftPanel.tsx       # 左栏容器
│       │   ├── ButtonBar/
│       │   │   ├── ButtonBar.tsx   # 功能按钮区
│       │   │   ├── NewSessionButton.tsx
│       │   │   ├── OpenSessionButton.tsx
│       │   │   ├── SettingsButton.tsx
│       │   │   ├── ExportLogsButton.tsx
│       │   │   └── DisconnectAllButton.tsx
│       │   └── ShellArea/
│       │       ├── ShellArea.tsx
│       │       ├── TabBar/
│       │       │   ├── TabBar.tsx
│       │       │   └── TabItem.tsx
│       │       └── TerminalContent/
│       │           └── XtermTerminal.tsx
│       ├── RightPanel/
│       │   ├── RightPanel.tsx      # 右栏容器
│       │   ├── AIChatDialog/
│       │   │   ├── AIChatDialog.tsx
│       │   │   ├── ChatHistory.tsx
│       │   │   └── ChatInput.tsx
│       │   └── QuickAIFunctions/
│       │       ├── QuickAIFunctions.tsx
│       │       ├── TerminalGroup.tsx
│       │       │   ├── ExplainCommandButton.tsx
│       │       │   ├── GenerateScriptButton.tsx
│       │       │   ├── FixErrorButton.tsx
│       │       │   └── AnalyzeOutputButton.tsx
│       │       ├── SFTPGroup.tsx
│       │       │   ├── SFTPHelperButton.tsx
│       │       │   └── FileOperationsButton.tsx
│       │       └── OtherGroup.tsx
│       │           ├── SearchCommandButton.tsx
│       │           └── PermissionManagerButton.tsx
│       ├── Dialogs/
│       │   ├── NewSessionDialog.tsx
│       │   └── SessionSettingsDialog.tsx
│       ├── FileManager/
│       │   ├── FileManager.tsx     # 文件管理器
│       │   ├── FileList.tsx        # 文件列表
│       │   ├── FileItem.tsx        # 文件项
│       │   ├── FileUpload.tsx      # 上传组件
│       │   └── FileContextMenu.tsx # 右键菜单
│       ├── StatusBar/
│       │   └── StatusBar.tsx       # 状态栏
│       └── common/
│           ├── Input.tsx
│           ├── Select.tsx
│           └── Button.tsx
├── hooks/
│   ├── useTerminal.ts             # 终端 Hook
│   ├── useAIChat.ts               # AI对话 Hook
│   └── useSessions.ts             # 会话管理 Hook
├── store/
│   └── terminalStore.ts           # Zustand 状态管理
├── types/
│   └── terminal.ts                # TypeScript 类型定义
├── api/
│   └── terminal.ts                # Tauri IPC 调用封装
└── App.tsx                       # 入口
```

---

## 七、批量 SSH 模式（独立标签）

### 7.1 模式概述

批量 SSH 模式作为独立标签存在，支持同时管理多个 SSH 连接，批量执行命令。

### 7.2 布局设计

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Mona Terminal                              [─] [□] [×]                      │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  主标签栏：  [本地 Shell] [SSH: server1] [📦 批量管理] [+]              │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                          │ │
│  │  [📦 批量管理] 标签内容：                                                │ │
│  │                                                                          │ │
│  │  ┌───────────────────────────────────────┬──────────────────────────────┐│ │
│  │  │ 会话列表（可多选）                    │ 会话标签 + 批量输入          ││ │
│  │  │                                       │                              ││ │
│  │  │ [ + 批量会话 ]                        │ [Tab1][Tab2][Tab3][+]       ││ │
│  │  │                                       │                              ││ │
│  │  │ 会话列表：                             │ [批量命令输入框]          ││ │
│  │  │ ┌───────────────────────────────────┐ │                              ││ │
│  │  │ │ ☑ server1                        │ │ ┌───────────────────────────┐│ │
│  │  │ │ ☑ server2                        │ │ │ 标签1终端：               ││ │
│  │  │ │ ☐ server3                        │ │ │ root@server1:~$ whoami   ││ │
│  │  │ │ ────────────────────────────────────│ │ │ root                     ││ │
│  │  │ │ 全选  反选  新建会话组             │ │ │ root@server1:~$ █        ││ │
│  │  │ └───────────────────────────────────┘ │ └───────────────────────────┘│ │
│  │  │                                       │                              ││ │
│  │  │ 会话组管理：                           │ ┌───────────────────────────┐│ │
│  │  │ ┌───────────────────────────────────┐ │ │ 标签2终端：               ││ │
│  │  │ │ 📁 服务器组                        │ │ │ root@server2:~$ whoami   ││ │
│  │  │ │   ├─ web 集群                      │ │ │ root                     ││ │
│  │  │ │   └─ 数据库集群                    │ │ │ root@server2:~$ █        ││ │
│  │  │ └───────────────────────────────────┘ │ └───────────────────────────┘│ │
│  │  └───────────────────────────────────────┴──────────────────────────────┘│ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└────────────────────────────────────────────────────────────────────────────┘
```

### 7.3 核心功能

| 功能 | 说明 |
|------|------|
| **多选会话** | 左侧列表支持勾选多个会话 |
| **批量命令** | 共享输入框，命令同步发送到所有选中会话 |
| **独立执行** | 每个会话独立执行，输出独立显示 |
| **会话分组** | 支持会话组管理，方便批量选择 |
| **错误高亮** | 执行失败的会话标签高亮显示 |

### 7.4 批量操作流程

```
用户在批量输入框输入命令
        ↓
    发送到所有选中的会话
        ↓
    Rust 后端并行执行
        ↓
    每个终端独立显示输出
        ↓
    失败的会话标签高亮
```

### 7.5 文件结构

```
src/components/terminal/
├── BatchMode/
│   ├── BatchModeTab.tsx           # 批量模式标签内容
│   ├── BatchSidebar/
│   │   ├── BatchSessionList.tsx   # 会话列表（可多选）
│   │   ├── SessionGroupManager.tsx # 会话组管理
│   │   └── SessionCheckbox.tsx    # 复选框组件
│   └── BatchRightPane/
│       ├── BatchTabBar.tsx        # 会话标签栏
│       ├── BatchTerminalGrid.tsx  # 多终端网格
│       └── BatchCommandInput.tsx  # 批量命令输入
└── ...
```

### 7.6 状态管理

```typescript
interface BatchModeState {
  // 选中的会话
  selectedSessionIds: string[];

  // 所有已打开的会话
  openSessions: BatchSession[];

  // 当前输入的命令
  commandInput: string;

  // 会话分组
  sessionGroups: SessionGroup[];
}

interface BatchSession {
  id: string;
  name: string;
  host: string;
  status: 'connecting' | 'connected' | 'error';
  terminalRef: TerminalRef;
}

interface SessionGroup {
  id: string;
  name: string;
  sessionIds: string[];
}
```

### 7.7 Rust 后端批量命令

```rust
#[tauri::command]
async fn batch_ssh_execute(
    session_ids: Vec<String>,
    command: String
) -> Result<Vec<BatchResult>, String>;

#[derive(Serialize)]
struct BatchResult {
    session_id: String,
    success: bool,
    output: String,
    error: Option<String>,
}
```

---

## 八、实现计划

### Phase 1: 基础框架 (第 1 周)
1. 创建 `terminal` Rust 模块骨架
2. 集成 russh 依赖
3. 实现 SSH 基本连接
4. 创建 React 组件基础结构
5. 实现 xterm.js 集成

### Phase 2: SSH 功能 (第 2 周)
1. 完善 SSH PTY 会话
2. 实现会话管理（Tab、多会话）
3. 实现窗口 resize
4. 实现连接保持和重连

### Phase 3: SFTP 功能 (第 3 周)
1. 集成 russh-sftp
2. 实现文件浏览
3. 实现上传/下载
4. 实现文件管理器 UI

### Phase 4: 完善功能 (第 4 周)
1. 实现 FTP 支持
2. 实现本地 Shell
3. 实现连接配置持久化
4. 实现凭据加密存储
5. UI 优化和细节打磨

---

## 九、验收标准

### 功能验收
- [ ] 可以创建、保存、编辑、删除 SSH/SFTP/FTP 连接
- [ ] 可以通过密码或密钥连接远程服务器
- [ ] 终端支持交互式命令执行
- [ ] 支持多 Tab 同时连接
- [ ] SFTP 可以浏览、上传、下载文件
- [ ] 本地 PowerShell/cmd 可正常执行
- [ ] 连接配置持久化保存

### 性能验收
- [ ] 终端输入延迟 < 50ms
- [ ] 文件传输速度接近原生 SFTP
- [ ] 支持 10+ 并发会话

### UI/UX 验收
- [ ] 侧边栏可收起/展开
- [ ] Tab 可拖拽排序
- [ ] 文件管理器可折叠/展开
- [ ] 窗口大小变化时终端自适应

---

## 十、依赖版本

```toml
# src-tauri/Cargo.toml
[dependencies]
russh = { version = "0.61", features = ["aws-lc-rs"] }
russh-sftp = "2.1"
russh-config = "0.61"
portable-pty = "0.8"
suppaftp = "6"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
thiserror = "2"

# 前端 (webui/package.json)
{
  "dependencies": {
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-web-links": "^0.11.0",
    "zustand": "^5.0.0"
  }
}
```
