# Mona SSH 模块 - AI Agent 联动设计方案

## 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Mona Terminal (Tauri App)                       │
│                                                                     │
│  ┌───────────────────────────┐      ┌───────────────────────────┐  │
│  │  Left Panel (Shell)      │      │  Right Panel (AI)         │  │
│  │                           │      │                           │  │
│  │  ┌─────────────────────┐ │      │  ┌─────────────────────┐ │  │
│  │  │  功能按钮区         │ │      │  │  AI 对话区           │ │  │
│  │  └─────────────────────┘ │      │  └─────────────────────┘ │  │
│  │  ┌─────────────────────┐ │      │  ┌─────────────────────┐ │  │
│  │  │  xterm.js 终端     │ │      │  │  快捷AI功能区       │ │  │
│  │  └─────────────────────┘ │      │  └─────────────────────┘ │  │
│  └───────────────────────────┘      └───────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
           │                                   │
           │ Tauri IPC                         │ Tauri IPC
           ▼                                   ▼
  ┌───────────────────┐              ┌───────────────────────┐
  │  Rust 后端        │              │ Python Agent Gateway  │
  │  (SSH/SFTP/FTP)   │              │  (AI Agent + Shell)    │
  └───────────────────┘              └───────────────────────┘
```

### 核心交互流程

```
用户操作 → 前端 (React) → Tauri IPC
                  │
    ┌─────────────┴─────────────┐
    ↓                           ↓
Rust 终端会话            Python Agent 调用
  (SSH/本地)              (工具执行)
    ↓                           ↓
xterm.js 显示            Agent 思考/执行
    ↑                           ↓
    └──────────── 数据流双向 ←──┘
```

---

## 功能设计

### 一、AI 快捷功能 (Quick AI Functions)

#### 1. 终端相关
| 功能 | 描述 | Agent 调用 |
|------|------|------------|
| **解释当前命令** | 解释终端中正在执行的命令 | 读取终端输出，解释 |
| **生成 Shell 脚本** | 生成自动化脚本 | 写文件 + 保存 |
| **修复命令错误** | 自动修复失败的命令 | 分析错误输出，修正重跑 |
| **分析终端输出** | 分析结果或日志 | 读取输出，生成总结/建议 |

#### 2. SFTP 相关
| 功能 | 描述 | Agent 调用 |
|------|------|------------|
| **SFTP 快捷助手** | 上传/下载常用目录的快捷操作 | 使用 sftp 工具 |
| **文件操作助手** | 文件比较、同步、备份 | 使用 sftp + shell 组合 |

#### 3. 其他
| 功能 | 描述 | Agent 调用 |
|------|------|------------|
| **常用命令搜索** | 搜索历史或常用命令 | 搜索记忆/历史 |
| **权限管理助手** | 分析或修复文件权限问题 | 执行 chmod/chown |

---

## 二、本地 Shell SSH/SFTP 完全替换

### 方案概述

Mona 终端模块将 **完全替换** 系统自带的 `ssh` 和 `sftp` 命令，用户在终端中输入 `ssh` 或 `sftp` 时，自动使用 Mona 自己的 Rust 实现，提供统一的 AI 增强体验。

### 替换原理

在 Mona 启动的 Shell 中，通过 Shell 函数覆盖系统命令：

```
用户输入: ssh user@server
        ↓
    Mona Shell 环境
        ↓
    ssh 命令已被 Mona 覆盖
        ↓
    调用 Rust russh 实现
        ↓
    进入 Mona SSH 会话 (xterm.js 渲染)
```

### 实现方式：Shell 函数覆盖

在 PowerShell/CMD/bash 启动时，注入自定义函数覆盖系统命令：

**PowerShell (Windows)：**

```powershell
# Mona 启动时注入的 ssh 函数（覆盖系统 ssh）
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

# Mona 启动时注入的 sftp 函数（覆盖系统 sftp）
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

**Bash (macOS/Linux)：**

```bash
# Mona 启动时注入的 ssh 函数（覆盖系统 ssh）
ssh() {
    local host="$1"
    local port="22"
    local username=""

    # 解析 user@host:port 格式
    if [[ "$host" =~ ^([^@]+)@(.+):([0-9]+)$ ]]; then
        username="${BASH_REMATCH[1]}"
        host="${BASH_REMATCH[2]}"
        port="${BASH_REMATCH[3]}"
    elif [[ "$host" =~ ^([^@]+)@(.+)$ ]]; then
        username="${BASH_REMATCH[1]}"
        host="${BASH_REMATCH[2]}"
    fi

    # 调用 Mona Rust SSH 实现
    mona-ssh-internal --host "$host" --port "$port" --username "$username" "$@"
}

sftp() {
    local host="$1"

    if [[ "$host" =~ ^([^@]+)@(.+)$ ]]; then
        local username="${BASH_REMATCH[1]}"
        local host_addr="${BASH_REMATCH[2]}"
        mona-sftp-internal --host "$host_addr" --username "$username" "$@"
    else
        mona-sftp-internal --host "$host" "$@"
    fi
}
```

### 用户体验

| 用户输入 | Mona 行为 |
|---------|----------|
| `ssh user@server` | 直接进入 Mona SSH 会话 (xterm.js) |
| `ssh user@server -p 2222` | Mona SSH 使用指定端口 |
| `sftp user@server` | 直接打开 Mona SFTP 文件管理器 |
| `exit` | 退出 Mona SSH/SFTP，返回 Shell |

---

## 三、Mona 快捷命令

除了直接使用 `ssh`/`sftp`，还提供保存连接的快捷命令：

| 命令 | 行为 |
|------|------|
| `mona-ssh myserver` | 快速连接已保存的服务器（无需输入 user@host） |
| `mona-sftp myserver` | 快速打开 SFTP 文件管理器到已保存的服务器 |
| `mona-connect list` | 列出所有已保存的连接 |
| `mona-connect add myserver` | 添加新连接 |
| `mona-connect edit myserver` | 编辑连接配置 |

### 快捷命令实现

```bash
# PowerShell
function mona-ssh {
    param([string]$Name)

    $config = Get-MonaConnection -Name $Name
    if ($config) {
        mona-ssh-internal -Host $config.Host -Port $config.Port -Username $config.Username
    } else {
        Write-Host "❌ 未找到连接: $Name"
        Write-Host "使用 'mona-connect list' 查看所有连接"
    }
}
```

---

## 四、拦截后的增强体验

当用户使用 `ssh` 连接时：

| 体验 | 系统 OpenSSH | Mona 增强版 |
|------|-------------|------------|
| 连接渲染 | 系统终端 | xterm.js，支持主题、搜索 |
| 连接管理 | 无记忆 | 自动保存配置、自动重连 |
| AI 辅助 | 无 | AI 解释命令、分析错误 |
| SFTP 切换 | 单独输入 `sftp` | 一键按钮切换 |
| 会话保持 | 依赖 SSH config | 内置心跳，断线自动重连 |
| 命令补全 | 基础 Tab 补全 | 支持连接的智能补全 |

---

## 五、用户设置选项

在 Mona 设置中可配置默认行为：

| 选项 | 说明 | 默认值 |
|------|------|--------|
| **覆盖系统 ssh** | 是否用 Mona SSH 替换系统 ssh | ✅ 启用 |
| **覆盖系统 sftp** | 是否用 Mona SFTP 替换系统 sftp | ✅ 启用 |
| **自动保存连接** | 连接成功后是否保存配置 | ✅ 启用 |
| **断线自动重连** | 连接断开是否自动重连 | ❌ 禁用 |

---

## 技术实现

### 一、新增 SSH 工具 (Agent Tools)

在 `mona/agent/tools/` 目录下创建新的工具模块：

```
mona/agent/tools/
├── __init__.py
├── ssh.py          # SSH 连接与命令执行
├── sftp.py         # SFTP 文件操作
└── terminal.py     # 终端会话管理
```

#### ssh.py - SSH 执行工具

```python
from __future__ import annotations
from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import StringSchema, IntegerSchema, tool_parameters_schema


@tool_parameters(
    tool_parameters_schema(
        host=StringSchema("SSH server hostname or IP"),
        port=IntegerSchema(22, description="SSH port, default 22"),
        username=StringSchema("SSH username"),
        password=StringSchema("SSH password (optional)", nullable=True),
        private_key_path=StringSchema("Path to private key (optional)", nullable=True),
        command=StringSchema("Command to execute on remote server"),
    )
)
class SSHExecTool(Tool):
    """Tool to execute commands on a remote SSH server."""
    
    _scopes = {"core", "subagent"}
    config_key = "ssh"
    
    @property
    def name(self) -> str:
        return "ssh_exec"
    
    @property
    def description(self) -> str:
        return "Execute a command on a remote SSH server. Returns stdout, stderr, and exit code."
    
    async def execute(
        self, host: str, username: str,
        command: str, port: int = 22,
        password: str | None = None,
        private_key_path: str | None = None,
        **kwargs
    ) -> str:
        # 调用 Tauri 后端的 SSH 服务
        return await self._call_tauri_ssh(
            host, port, username, password, private_key_path, command
        )
    
    async def _call_tauri_ssh(self, *args) -> str:
        # 通过消息总线调用 Rust 后端或子进程
        pass
```

#### sftp.py - SFTP 文件操作工具

```python
@tool_parameters(
    tool_parameters_schema(
        host=StringSchema("SSH server"),
        port=IntegerSchema(22),
        username=StringSchema("Username"),
        operation=StringSchema("Operation: list/download/upload/delete/mkdir"),
        remote_path=StringSchema("Remote path"),
        local_path=StringSchema("Local path (for upload/download)", nullable=True),
    )
)
class SFTPTool(Tool):
    """SFTP file operations on remote server."""
    
    @property
    def name(self) -> str:
        return "sftp"
    
    async def execute(
        self, host: str, username: str, operation: str, remote_path: str,
        port: int = 22, local_path: str | None = None, **kwargs
    ) -> str:
        pass
```

### 二、Rust 后端接口

在 `src-tauri/src/terminal/` 下创建：

```rust
// terminal/commands.rs
#[tauri::command]
async fn ssh_connect(config: SSHConfig) -> Result<String, String> {
    // 建立 SSH 连接
}

#[tauri::command]
async fn ssh_exec(session_id: String, command: String) -> Result<String, String> {
    // 执行 SSH 命令
}

#[tauri::command]
async fn sftp_list(session_id: String, path: String) -> Result<Vec<FileEntry>, String> {
    // 列出 SFTP 目录
}

#[tauri::command]
async fn sftp_upload(session_id: String, local: String, remote: String) -> Result<(), String> {
    // 上传文件
}
```

### 三、前端状态管理

```typescript
// terminalStore.ts
interface TerminalSession {
    id: string;
    type: 'local' | 'ssh' | 'sftp' | 'ftp';
    config: any;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    terminal: Terminal | null;
    history: string[];
}

interface TerminalState {
    sessions: Map<string, TerminalSession>;
    activeSessionId: string | null;
    connections: ConnectionConfig[];
    
    addConnection: (config: ConnectionConfig) => void;
    createSession: (configId: string) => Promise<string>;
    closeSession: (sessionId: string) => void;
    
    // AI 快捷功能
    explainCurrentCommand: (sessionId: string) => Promise<string>;
    generateScript: (description: string) => Promise<string>;
    fixError: (sessionId: string, errorOutput: string) => Promise<void>;
}
```

### 四、快捷功能实现示例

#### 解释当前命令

```typescript
// hooks/useTerminalAI.ts
export async function explainCurrentCommand(sessionId: string): Promise<string> {
    // 1. 从终端获取当前命令和输出
    const output = getTerminalOutput(sessionId);
    
    // 2. 调用 AI Agent 解释
    const result = await invokeMonaAgent({
        action: 'explain',
        context: output
    });
    
    return result;
}

async function invokeMonaAgent(payload: any): Promise<string> {
    // 通过现有的消息总线调用 Agent
    const response = await fetch('/api/agent/ask', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' }
    });
    
    return await response.text();
}
```

---

## 数据流设计

### 场景一：AI 自动修复命令

```
1. 用户在终端输入命令
   ↓
2. 命令执行失败
   ↓
3. 用户点击「修复命令错误」按钮
   ↓
4. 前端捕获终端输出
   ↓
5. 调用 Mona Agent
   ↓
6. Agent 分析错误 → 修正命令
   ↓
7. Agent 调用 ssh_exec 工具执行修正后的命令
   ↓
8. 输出通过 xterm.js 显示
```

### 场景二：SFTP 快捷操作

```
1. 用户点击「SFTP 快捷助手」
   ↓
2. 打开快捷对话框
   ↓
3. 用户选择上传项目文件
   ↓
4. Agent 调用 sftp 工具上传
   ↓
5. 同时可选：在远程服务器执行构建脚本
```

---

## 安全设计

| 安全层面 | 措施 |
|---------|------|
| **密码/密钥存储** | 使用系统密钥链（Windows Credential Locker）加密存储 |
| **连接验证** | SSH 指纹验证，首次连接确认 |
| **命令限制** | 应用与现有 `ExecTool` 相同的安全规则 |
| **权限隔离** | Agent 只执行用户授权的操作，高风险操作需确认 |

---

## 实现优先级

### Phase 1: 基础 SSH + AI 基础
- [ ] Rust 后端 SSH 连接（使用 russh）
- [ ] xterm.js 集成
- [ ] `ssh_exec` 工具
- [ ] 「解释当前命令」「分析输出」功能

### Phase 2: SFTP + 更丰富功能
- [ ] `sftp` 工具
- [ ] 文件管理器 UI
- [ ] 「生成脚本」「修复错误」功能

### Phase 3: 高级自动化
- [ ] 多步骤 AI 工作流
- [ ] 文件比较/同步助手
- [ ] 自动化脚本模板库

