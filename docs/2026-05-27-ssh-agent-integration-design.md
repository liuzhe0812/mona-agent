# SSH 模块 AI Agent 联动增强设计

## 概述

增强 Mona SSH 模块与 AI Agent 的联动能力，实现三个核心功能：

1. **Agent 复用已有 SSH 会话**（session_id 桥接）
2. **AI 读取终端缓冲区**
3. **自然语言 → Shell 命令**，权限模式：全局默认 + 危险命令强制审批

## 现状分析

### 已有基础设施

| 组件 | 位置 | 状态 |
|------|------|------|
| `TerminalExecTool` | `mona/agent/tools/terminal.py` | 已实现，通过 session_id 复用会话，支持 require_approval |
| `TerminalOutputTool` | `mona/agent/tools/terminal.py` | 已实现，读取终端缓冲区或列出会话 |
| `ApprovalManager` | `src-tauri/src/terminal/approval.rs` | 已实现，审批制命令执行 |
| `SessionManager` | `src-tauri/src/terminal/session.rs` | 已实现，管理所有 SSH/本地会话 |
| `_tauri_invoke` | `mona/agent/tools/terminal.py` | 已实现，Python → Rust 通信桥 |
| `terminal_request_exec` | `src-tauri/src/terminal/commands.rs` | 已实现，审批制执行 |
| `terminal_exec_command` | `src-tauri/src/terminal/commands.rs` | 已实现，直接执行 |
| `terminal_get_output` | `src-tauri/src/terminal/commands.rs` | 已实现，读取缓冲区 |

### 需要废弃的组件

| 组件 | 位置 | 原因 |
|------|------|------|
| `SSHExecTool` | `mona/agent/tools/ssh.py` | 每次新建连接，不复用会话，与终端模块脱节 |

**结论**：功能 1 和 2 的核心代码已存在，主要工作是增强现有工具 + 新增风险分级机制。

## 架构设计

### 整体架构

```
用户自然语言 → Agent Loop → Tool 调用
                              │
                 ┌────────────┴────────────┐
                 │                         │
         TerminalExecTool           TerminalOutputTool
         (增强风险分级)              (微调)
                 │                         │
         ┌───────┴───────┐                │
         │ Python 端      │                │
         │ 风险分级判断    │                │
         │ (第一层过滤)    │                │
         └───────┬───────┘                │
                 │                         │
         _tauri_invoke()            _tauri_invoke()
                 │                         │
     ┌───────────┴───────────┐             │
     │                       │             │
  terminal_exec_command   terminal_request_exec   terminal_get_output
  (直接执行)              (审批后执行)             (读取缓冲区)
     │                       │                       │
     └───────────────────────┤                       │
                             │                       │
                   Rust 端二次校验                    │
                   (危险命令强制审批)                  │
                   (第二层兜底)                       │
                             │                       │
                   SessionManager.get_handle()
                             │
                   SshClient / LocalShell
```

### 双重安全模型

- **Python 端（第一层）**：根据 `TerminalConfig` 配置判断命令风险等级，决定走直接执行还是审批流程
- **Rust 端（第二层）**：硬编码最小危险命令集合，即使 Python 端被绕过也能拦截

## 详细设计

### 1. TerminalConfig 配置模型

在 `config/schema.py` 的 `ToolsConfig` 中新增 `terminal` 字段：

```python
class TerminalExecMode(str, Enum):
    AUTO = "auto"          # AI 生成的命令直接执行（危险命令除外）
    APPROVAL = "approval"  # 所有 AI 生成的命令都需审批

class TerminalToolConfig(Base):
    enable: bool = True
    exec_mode: TerminalExecMode = TerminalExecMode.APPROVAL
    dangerous_patterns: list[str] = Field(default_factory=lambda: [
        "rm -rf /", "rm -rf /*", "mkfs", "dd if=", "dd of=",
        "> /dev/sd", "chmod -R 777 /", "chown -R",
        "shutdown", "reboot", "init 0", "init 6",
        ":(){ :|:& };:", "fork bomb",
    ])
    safe_patterns: list[str] = Field(default_factory=lambda: [
        "ls", "cat", "head", "tail", "grep", "find", "wc",
        "ps", "top", "df", "du", "free", "uptime",
        "echo", "pwd", "whoami", "hostname", "uname",
        "netstat", "ss", "ping", "curl", "wget",
    ])
```

**设计要点**：

- `exec_mode` 控制全局默认行为，默认 `approval`（安全优先）
- `dangerous_patterns` 匹配的命令**始终**需要审批，无论全局模式如何
- `safe_patterns` 仅在 `exec_mode=auto` 时生效，匹配的命令可跳过审批
- 不在 safe 也不在 dangerous 中的命令，跟随 `exec_mode` 全局设置

### 2. Python 端风险分级（第一层过滤）

增强 `TerminalExecTool.execute()` 的逻辑：

```
命令进入
    │
    ├── 匹配 dangerous_patterns？ ──→ 强制走 terminal_request_exec（审批）
    │
    ├── exec_mode == approval？ ──→ 走 terminal_request_exec（审批）
    │
    ├── exec_mode == auto 且 匹配 safe_patterns？ ──→ 走 terminal_exec_command（直接执行）
    │
    └── exec_mode == auto 且 不匹配任何模式？ ──→ 走 terminal_request_exec（审批）
```

**关键**：`auto` 模式不是"全部放行"，而是"仅安全命令放行，其余仍需审批"。

### 3. Rust 端二次校验（第二层兜底）

在 `terminal_exec_command` 中新增危险命令检查：

```rust
#[tauri::command]
pub async fn terminal_exec_command(
    state: State<'_, TerminalState>,
    session_id: String,
    command: String,
    source: Option<String>,  // 新增参数
) -> Result<(), String> {
    if source.as_deref() == Some("ai") {
        if is_dangerous_command(&command) {
            return Err("Dangerous command requires approval. Use terminal_request_exec instead.".into());
        }
    }
    // ... 原有逻辑
}
```

Rust 端维护一份**硬编码的最小危险命令列表**（不可配置），作为安全底线：

```rust
fn is_dangerous_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    let patterns = [
        "rm -rf /", "rm -rf /*", "mkfs.", "dd if=",
        "> /dev/sd", ":(){ :|:& };:",
    ];
    patterns.iter().any(|p| lower.contains(p))
}
```

**设计要点**：

- Rust 端的列表是**最小集合**，只包含不可逆的破坏性命令
- Python 端的 `dangerous_patterns` 是**可配置的扩展集**，用户可自定义
- 即使 Python 端被绕过（如直接调用 API），Rust 端仍能拦截

### 4. 废弃 SSHExecTool

- 在 `SSHExecTool` 的 `description` 中引导 Agent 使用 `terminal_exec` 代替
- 从工具注册中标记为 deprecated

### 5. TerminalOutputTool 微调

- 返回内容时附带会话元信息（host、username、session_type）
- 截断策略保持 4000 字符硬编码（后续可配置化）

## 数据流设计

### 场景一：安全命令直接执行（auto 模式）

```
用户: "查看 server1 的磁盘使用情况"
        │
        ▼
  Agent Loop → tool_call: terminal_exec
  {session_id: "abc123", command: "df -h"}
        │
        ▼
  Python 风险分级: "df -h" 匹配 safe_patterns → 可跳过审批
        │
        ▼
  _tauri_invoke("terminal_exec_command", {
      sessionId: "abc123", command: "df -h", source: "ai"
  })
        │
        ▼
  Rust: source=="ai" → is_dangerous_command("df -h") → false
        │
        ▼
  SshClient.write("df -h\n") → 命令写入 SSH 通道
        │
        ▼
  返回 "Command executed: df -h"
        │
        ▼
  Agent 调用 terminal_output 读取结果 → 回复用户
```

### 场景二：危险命令审批执行

```
用户: "清理 server1 的旧日志"
        │
        ▼
  Agent → terminal_exec({command: "rm -f /var/log/*.log.old"})
        │
        ▼
  Python 风险分级: "rm -f" 不在 safe_patterns → 需要审批
        │
        ▼
  _tauri_invoke("terminal_request_exec", {
      sessionId: "abc123",
      command: "rm -f /var/log/*.log.old",
      source: "AI Agent"
  })
        │
        ▼
  Rust ApprovalManager.submit()
  → emit("terminal-exec-request") → 前端弹审批对话框
        │
        ▼
  用户点击 [批准]
        │
        ▼
  terminal_respond_exec(requestId, approved=true)
        │
        ▼
  SshClient.write("rm -f /var/log/*.log.old\n")
        │
        ▼
  返回 "Command submitted for approval: rm -f /var/log/*.log.old"
```

### 场景三：读取终端缓冲区

```
用户: "终端里显示了什么错误？"
        │
        ▼
  Agent → terminal_output({session_id: "abc123"})
        │
        ▼
  _tauri_invoke("terminal_get_output", {sessionId: "abc123"})
        │
        ▼
  Rust: SshClient.get_buffer() → 返回终端内容
        │
        ▼
  Agent 分析输出 → 回复用户
```

## 错误处理

| 场景 | Python 端处理 | Rust 端处理 |
|------|-------------|------------|
| session_id 不存在 | 返回错误信息 | 返回 `SessionNotFound` |
| 命令被 Rust 端拦截 | — | 返回 "Dangerous command requires approval" |
| 审批超时（30s） | — | oneshot channel 关闭，返回错误 |
| 审批被拒绝 | 返回 "Command rejected: {reason}" | — |
| SSH 连接已断开 | — | `client.write()` 返回连接错误 |
| `_tauri_invoke` 调用失败 | 返回 "Error: Tauri invoke failed: ..." | — |

## 配置示例

```json
{
  "tools": {
    "terminal": {
      "enable": true,
      "execMode": "approval",
      "dangerousPatterns": [
        "rm -rf /", "rm -rf /*", "mkfs", "dd if=",
        "dd of=", "> /dev/sd", "chmod -R 777 /",
        "chown -R", "shutdown", "reboot", "init 0", "init 6"
      ],
      "safePatterns": [
        "ls", "cat", "head", "tail", "grep", "find", "wc",
        "ps", "top", "df", "du", "free", "uptime",
        "echo", "pwd", "whoami", "hostname", "uname",
        "netstat", "ss", "ping", "curl", "wget"
      ]
    }
  }
}
```

## 变更清单

### Python 端

| 文件 | 变更 |
|------|------|
| `mona/config/schema.py` | 新增 `TerminalExecMode` 枚举、`TerminalToolConfig` 模型、`ToolsConfig.terminal` 字段 |
| `mona/agent/tools/terminal.py` | 增强 `TerminalExecTool`：加载配置、风险分级判断、传递 `source` 参数；微调 `TerminalOutputTool` |
| `mona/agent/tools/ssh.py` | 标记 `SSHExecTool` 为 deprecated，引导使用 `terminal_exec` |

### Rust 端

| 文件 | 变更 |
|------|------|
| `src-tauri/src/terminal/commands.rs` | `terminal_exec_command` 新增 `source` 参数，新增 `is_dangerous_command` 函数 |

### 前端（无变更）

前端审批对话框已存在，无需修改。
