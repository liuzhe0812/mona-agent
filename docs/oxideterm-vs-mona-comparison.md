# OxideTerm vs Mona 终端模块 — 深度代码级对比分析

> 基于 OxideTerm v1.4.8（1086 commits）源码与 Mona 终端模块当前代码的逐行级对比

---

## 一、架构设计

| 维度 | OxideTerm | Mona | 对比结论 |
|------|-----------|------|---------|
| **通信架构** | 双平面：数据面 WebSocket（二进制帧 `[Type:1][Len:4][Payload:n]`）+ 控制面 Tauri IPC（JSON） | 单平面：全部走 Tauri IPC `emit("terminal-output", JSON)` | **Mona 必须重构**。JSON 序列化终端字节流在高频 I/O 下产生严重性能瓶颈，每条输出都经 JSON encode/decode + Base64 或 UTF-8 lossy 转换 |
| **寻址模型** | `nodeId` 寻址，前端不感知 `sessionId`/`connectionId`；重连时底层 connectionId 变化对上层透明 | `sessionId` 直接寻址；重连后 ID 变化，上层需重建所有引用 | **Mona 应引入 nodeId 层**。OxideTerm 的 `NodeRouter` 将 nodeId 解析为后端资源（terminal endpoint、SFTP session、forward manager），重连只替换底层连接，上层无感知 |
| **后端模块划分** | 14 个模块：ssh/、session/、bridge/、router/、sftp/、forwarding/、local/、config/、rag/、trzsz/、oxide_file/、agent/、cli_server/、graphics/ | 5 个模块：ssh/、shell/、sftp/、session/、config/ | **Mona 模块粒度合理**，但缺少 bridge/（WebSocket 桥接）、router/（节点路由）、forwarding/（端口转发）三个关键模块 |
| **前端 Store** | 19 个独立 Zustand store：reconnectStore、connectionStore、terminalStore、sftpStore、forwardStore、sessionTreeStore 等 | 1 个统一 terminalStore（sessions + connections + settings + outputBuffers + batchOutputs） | **Mona 应拆分 Store**。单 Store 在功能增长后状态耦合严重，OxideTerm 的拆分策略更利于独立测试和按需加载 |
| **前端组件** | ~60 个组件目录：terminal/（12 文件）、sftp/（7 文件）、ide/（16 文件）、connections/（3 文件）、forwards/（3 文件）、topology/（4 文件）、settings/（20+ 文件） | ~15 个组件文件：XtermTerminal、TerminalView、SessionTabBar、Toolbar、StatusBar、AIPanel、BatchMode、FileManager、Dialogs | **Mona 组件数量合理**，当前阶段不需要 OxideTerm 的 IDE/拓扑/插件等组件 |

### 关键架构代码对照

**线协议（Wire Protocol）**

OxideTerm `bridge/protocol.rs`:
```rust
// [Type:1][Length:4][Payload:n]
pub enum Frame {
    Data(Bytes),           // 0x00 — 终端 I/O 原始字节
    Resize { cols, rows }, // 0x01 — 窗口大小变更
    Heartbeat(u32),        // 0x02 — 心跳保活
    Error(String),         // 0x03 — 错误通知
}
```

Mona `ssh/client.rs`:
```rust
// JSON emit
let payload = serde_json::json!({
    "sessionId": session_id,
    "data": output,  // String::from_utf8_lossy — 有损转换
});
let _ = app_handle.emit("terminal-output", payload);
```

**结论：OxideTerm 的二进制帧零拷贝、零序列化、零编码转换；Mona 每条输出都经 3 次转换（bytes→lossy UTF-8→JSON string→IPC），性能差距在 cat 大文件时可达 10x+**

---

## 二、SSH 连接管理

| 维度 | OxideTerm | Mona | 对比结论 |
|------|-----------|------|---------|
| **连接池** | `ConnectionRegistry`（DashMap 无锁并发），引用计数共享：terminal/SFTP/forward/IDE 共用一条 SSH 连接 | 无连接池，每次操作新建独立连接 | **Mona 必须实现**。当前 SSH 连接和 SFTP 连接是独立的，同一台服务器会建立两条 TCP 连接，浪费资源且认证重复 |
| **连接状态机** | `SessionStateMachine`：Disconnected→Connecting→Connected→Disconnecting→Error，5 状态 + 严格转换校验 + 转换计数 + 时间追踪 | `SessionStatus` 枚举：Connected/Disconnected/Error，无状态机，无转换校验 | **Mona 应实现状态机**。OxideTerm 的 `StateTransitionError` 防止了非法状态转换（如从 Disconnected 直接到 Connected），Mona 当前无此保护 |
| **引用计数** | `SharedSshSession`（Arc 引用计数），多消费者共享同一连接，最后一个消费者 drop 时自动断开 | 无引用计数，每个 session 独占连接 | **Mona 应实现引用计数**。连接池的基础设施 |
| **Keepalive** | 15s 间隔 SSH keepalive + 30s WebSocket 心跳 + 300s 超时检测 | 无 keepalive | **Mona 应添加**。没有 keepalive，NAT/防火墙会静默丢弃空闲连接 |
| **空闲超时** | 可配置（5m/15m/30m/1h/never），超时自动断开并通知前端 | 无 | **Mona 可后期添加** |

### 连接池核心代码对照

OxideTerm `ssh/connection_registry.rs`:
```rust
pub struct ConnectionRegistry {
    connections: DashMap<String, SharedSshSession>,
}
pub struct SharedSshSession {
    session: Arc<SshSession>,
    ref_count: Arc<AtomicUsize>,
    state: Arc<RwLock<SessionState>>,
}
```

Mona `session.rs`:
```rust
pub struct SessionManager {
    sessions: RwLock<HashMap<String, Session>>,
    handles: RwLock<HashMap<String, SessionHandle>>,
    max_sessions: usize,
}
```

**结论：OxideTerm 用 DashMap 无锁并发 + Arc 引用计数，支持多消费者共享；Mona 用 RwLock<HashMap>，每个 session 独占 handle，无法共享连接**

---

## 三、SSH 认证

| 认证方式 | OxideTerm | Mona | 对比结论 |
|---------|-----------|------|---------|
| **密码** | ✅ `authenticate_password` | ✅ `authenticate_password` | 对等 |
| **公钥（文件）** | ✅ RSA/Ed25519/ECDSA + passphrase 解密 | ✅ `load_secret_key` + `PrivateKeyWithHashAlg` | **Mona 缺少 passphrase 解密**。OxideTerm 支持 key passphrase 输入，Mona 传 `None` |
| **SSH Agent** | ✅ `AgentSigner`，跨平台（Unix `SSH_AUTH_SOCK` + Windows `\\.\pipe\openssh-ssh-agent`） | ❌ 返回 "not yet supported" | **Mona 必须实现**。企业用户普遍使用 SSH Agent，这是硬需求 |
| **证书认证** | ✅ `Arc<Certificate>` + `authenticate_certificate` | ❌ | **Mona 可后期添加** |
| **Keyboard-Interactive** | ✅ `keyboard_interactive.rs`，支持 2FA/OTP | ❌ | **Mona 应添加**。很多企业 SSH 强制 2FA |
| **多步认证** | ✅ 认证回退链：先尝试 Agent → 失败则尝试 Key → 失败则尝试 Password | ❌ 单一认证方式 | **Mona 应实现认证回退** |

### Agent 认证核心代码对照

OxideTerm `ssh/agent.rs`:
```rust
pub struct AgentSigner {
    identity: AgentIdentity,  // owned value，解决 RPITIT Send bound
}
impl Signer for AgentSigner {
    async fn sign(&self, ..) -> Result<..> {
        // 通过 Agent IPC 做签名
    }
}
```

**结论：OxideTerm 的 `AgentSigner` 解决了 russh 的 `Send` bound 问题（RPITIT），这是实现 SSH Agent 认证的关键技术点，Mona 可直接参考此设计模式**

---

## 四、Host Key 校验

| 维度 | OxideTerm | Mona | 对比结论 |
|------|-----------|------|---------|
| **校验策略** | TOFU（Trust On First Use）+ 变更检测 | 无校验，`check_server_key` 直接返回 `true` | **Mona 存在严重安全漏洞**。MITM 攻击可完全绕过 |
| **指纹算法** | SHA256 fingerprint（`SHA256:base64...`） | 无 | — |
| **存储** | `KnownHostsStore`，读写 `~/.ssh/known_hosts`（兼容 OpenSSH 格式），`parking_lot::RwLock` 缓存 + 文件持久化 | 无 | — |
| **变更检测** | `HostKeyVerification::Changed { expected, actual }`，日志 WARN | 无 | — |
| **UI 交互** | `HostKeyConfirmDialog` 组件，展示指纹让用户确认 | 无 | — |
| **删除** | `remove_host_key` 精确删除指定 host+port+key_type+指纹 | 无 | — |

### Host Key 校验核心代码对照

OxideTerm `ssh/known_hosts.rs`:
```rust
pub enum HostKeyVerification {
    Verified,                                          // 匹配 known_hosts
    Unknown { fingerprint: String },                   // 首次连接
    Changed { expected_fingerprint, actual_fingerprint }, // 密钥变更（可能 MITM）
}
pub struct KnownHostsStore {
    hosts: RwLock<HashMap<String, Vec<HostKeyEntry>>>,
    path: PathBuf,  // ~/.ssh/known_hosts
}
```

Mona `ssh/client.rs`:
```rust
async fn check_server_key(&mut self, _key: &PublicKey) -> Result<bool, Error> {
    Ok(true)  // 盲目信任！
}
```

**结论：这是 Mona 最严重的安全缺陷，必须立即修复。OxideTerm 的实现可直接参考：`KnownHostsStore` + `HostKeyVerification` + 前端确认对话框**

---

## 五、ProxyJump / 多跳连接

| 维度 | OxideTerm | Mona | 对比结论 |
|------|-----------|------|---------|
| **ProxyJump** | ✅ 无限跳数，通过 `direct-tcpip` 通道创建 SSH-over-SSH 隧道 | ❌ | **Mona 应实现**。跳板机是企业 SSH 的标配场景 |
| **拓扑可视化** | ✅ `TopologyView` + D3.js 力导向图 | ❌ | **Mona 可后期添加** |
| **连接计划** | ✅ `sessionTreeConnectPlan.ts` 解析跳转链并生成连接步骤 | ❌ | — |
| **级联故障** | ✅ 跳板机断开 → 所有下游节点自动标记 `link_down` | ❌ | — |

**结论：ProxyJump 是企业场景的刚需，OxideTerm 的 `ProxyConnection` + `ProxyChain` 实现可作为参考**

---

## 六、自动重连

| 维度 | OxideTerm | Mona | 对比结论 |
|------|-----------|------|---------|
| **重连策略** | Grace Period（30s 探测旧连接），如果旧连接恢复则 vim/htop 不受影响 | 无重连，断开即销毁 | **Mona 必须实现**。网络抖动是 SSH 的常见场景 |
| **重连编排** | `ReconnectOrchestratorStore`（前端专用 Store），流水线：queued→snapshot→grace-period→ssh-connect→await-terminal→restore-forwards→resume-transfers→restore-ide→verify→done | 无 | — |
| **指数退避** | ✅ `SessionReconnector`，指数退避重试 | 无 | — |
| **状态快照** | ✅ 断开前快照终端面板、SFTP 传输、端口转发、IDE 文件 | 无 | — |
| **前端事件** | ✅ `ReconnectTimeline` 组件展示重连进度 | 无 | — |
| **主动检测** | ✅ `visibilitychange` + `online` 事件触发主动 SSH keepalive（~2s 检测 vs 15-30s 被动超时） | 无 | — |

**结论：OxideTerm 的 Grace Period 重连是其核心差异化特性。Mona 至少应实现基础重连（断开→自动重连→恢复终端），Grace Period 可作为进阶目标**

---

## 七、SFTP 文件管理

| 维度 | OxideTerm | Mona | 对比结论 |
|------|-----------|------|---------|
| **基础操作** | ls/stat/mkdir/rm/rename/download/upload | ls/stat/mkdir/rm/rename/download/upload/canonicalize | **Mona 基础操作完备**，甚至多了 canonicalize |
| **传输队列** | ✅ `TransferManager`（Semaphore 并发控制 + 原子计数器），支持暂停/恢复/取消 | ❌ 单文件全量传输 | **Mona 应实现传输队列** |
| **断点续传** | ✅ `download_with_resume` / `upload_with_resume`，`.oxide-part` 临时文件 + 原子 rename | ❌ | **Mona 应实现**。大文件传输的刚需 |
| **进度追踪** | ✅ `StoredTransferProgress` + `RedbProgressStore`（redb 持久化），崩溃后可恢复 | ❌ | **Mona 可后期添加** |
| **自动重试** | ✅ `transfer_with_retry`，指数退避 + 可重试错误判断 | ❌ | **Mona 应添加** |
| **目录传输** | ✅ `tar_transfer`：tar-on-the-fly 流式上传/下载目录 | ❌ | **Mona 可后期添加** |
| **文件预览** | ✅ 图片/视频/音频/代码/PDF/Hex/字体（QuickLook 组件） | ❌ | **Mona 可后期添加** |
| **双面板** | ✅ 拖拽传输（dnd-kit） | ❌ 单面板 | **Mona 可后期添加** |
| **虚拟滚动** | ✅ `@tanstack/react-virtual` | ❌ | **Mona 应添加**。大目录性能问题 |

### 传输队列核心代码对照

OxideTerm `sftp/transfer.rs`:
```rust
pub struct TransferManager {
    semaphore: Arc<Semaphore>,        // 并发控制
    active_count: AtomicUsize,        // 活跃传输数
    total_bytes: AtomicU64,           // 总字节数
    cancelled: Arc<AtomicBool>,       // 取消标志
    speed_limit: Arc<AtomicU64>,      // 速度限制
}
```

**结论：Mona 的 SFTP 基础操作已完备，但缺少传输队列、断点续传和进度追踪这三个生产级特性**

---

## 八、端口转发

| 维度 | OxideTerm | Mona | 对比结论 |
|------|-----------|------|---------|
| **本地转发 (-L)** | ✅ `LocalForwardHandle`，无锁消息传递 bridge | ❌ | **Mona 应实现**。端口转发是 SSH 的核心功能 |
| **远程转发 (-R)** | ✅ `RemoteForwardHandle`，原子统计计数 | ❌ | **Mona 应实现** |
| **动态 SOCKS5 (-D)** | ✅ `DynamicForwardHandle`，SOCKS5 协议解析 | ❌ | **Mona 可后期添加** |
| **数据桥接** | ✅ `bridge_stream_to_ssh_channel`，无锁消息传递 + 超时保护 + 干净关闭 | ❌ | — |
| **重连恢复** | ✅ `stop_all_and_save_rules` 保存规则，重连后 `restore_all` | ❌ | — |
| **统计** | ✅ 原子计数器：活跃连接数/发送字节/接收字节 | ❌ | — |
| **前端 UI** | ✅ `ForwardsView` + `PortDetectionBanner` | ❌ | — |

**结论：端口转发是 OxideTerm 的完整功能模块，Mona 完全缺失。建议优先实现 -L 本地转发**

---

## 九、本地 Shell

| 维度 | OxideTerm | Mona | 对比结论 |
|------|-----------|------|---------|
| **PTY 库** | portable-pty | portable-pty | 对等 |
| **Shell 检测** | ✅ `shell.rs` 自动检测 zsh/bash/fish/pwsh/WSL2 | ❌ 硬编码 cmd.exe/pwsh | **Mona 应实现 Shell 自动检测** |
| **数据传输** | WebSocket 二进制帧 | Tauri IPC JSON emit | 同架构差距 |
| **编码处理** | 前端 `terminalEncoding.ts` 可配置编码 | Rust 端 GBK 解码（Windows） | **Mona 的 GBK 解码在 Rust 端做是正确的**，但应支持配置 |
| **WSL2** | ✅ 专用 WSL2 集成 | ❌ | **Mona 可后期添加** |
| **Telnet** | ✅ `telnet.rs` | ❌ | 不需要 |

**结论：本地 Shell 基础能力对等，Mona 需要补充 Shell 自动检测和编码配置**

---

## 十、安全性

| 维度 | OxideTerm | Mona | 对比结论 |
|------|-----------|------|---------|
| **Host Key 校验** | ✅ TOFU + SHA256 指纹 + 变更检测 | ❌ 盲目信任 | **P0 安全漏洞** |
| **凭据存储** | ✅ OS keychain（keyring crate）+ ChaCha20-Poly1305 + Argon2id | ❌ JSON 明文 `terminal-connections.json` | **P0 安全漏洞** |
| **加密导出** | ✅ `.oxide` 文件：ChaCha20-Poly1305 + Argon2id（256MB 内存） | ❌ | **Mona 可后期添加** |
| **Touch ID** | ✅ macOS Touch ID 解锁 | ❌ | macOS 专属，可后期添加 |
| **内存清零** | ✅ `zeroize` crate | ❌ | **Mona 应添加**。密码/密钥在内存中应零化 |
| **Vault** | ✅ `vault.rs` AES 加密配置存储 | ❌ | — |

### 凭据存储对照

OxideTerm `config/keychain.rs` + `config/vault.rs`:
```rust
// OS keychain 存储 SSH 密码和 API key
pub struct Keychain { /* keyring-rs 封装 */ }
// AES 加密本地配置
pub struct Vault { /* encrypted config storage */ }
```

Mona `commands.rs`:
```rust
fn connections_path() -> Result<PathBuf, String> {
    let dir = config_dir.join("mona");
    Ok(dir.join("terminal-connections.json"))  // 明文 JSON！
}
```

**结论：Mona 的凭据明文存储是严重安全缺陷，必须立即修复。OxideTerm 的 keyring + vault 方案可直接参考**

---

## 十一、前端终端渲染

| 维度 | OxideTerm | Mona | 对比结论 |
|------|-----------|------|---------|
| **xterm.js 版本** | @xterm/xterm 6 | @xterm/xterm（最新） | 对等 |
| **渲染器** | WebGL addon（主）+ Canvas addon（降级）+ DOM fallback | DOM 渲染器（默认） | **Mona 应添加 WebGL**。大数据量时 DOM 渲染器性能不足 |
| **自适应渲染** | ✅ `useAdaptiveRenderer` hook，根据 GPU 能力自动选择 WebGL/Canvas/DOM | ❌ | **Mona 应实现** |
| **终端注册表** | ✅ `terminalRegistry.ts`，全局管理所有终端实例、缓冲区、活跃终端 | ❌ 每个 XtermTerminal 组件独立管理 | **Mona 应实现全局注册表**。AI 面板需要访问任意终端的缓冲区 |
| **搜索** | ✅ @xterm/addon-search + SearchBar 组件 | ❌ | **Mona 可后期添加** |
| **图片显示** | ✅ @xterm/addon-image | ❌ | **Mona 可后期添加** |
| **序列化** | ✅ @xterm/addon-serialize（会话录制/回放） | ❌ | **Mona 可后期添加** |
| **自动补全** | ✅ autosuggest addon（ghost text） | ❌ | **Mona 可后期添加** |
| **trzsz 传输** | ✅ 内核集成（controller + transport + dialogs） | ❌ | **Mona 可后期添加** |
| **会话录制** | ✅ asciicast v2 格式 + CastPlayer 回放 | ❌ | **Mona 可后期添加** |
| **分屏** | ✅ react-resizable-panels + SplitTerminalContainer | ❌ | **Mona 应添加** |

**结论：OxideTerm 的终端渲染栈远超 Mona，但很多是锦上添花。Mona 优先应添加 WebGL 渲染器和全局终端注册表**

---

## 十二、AI 集成

| 维度 | OxideTerm (OxideSens) | Mona | 对比结论 |
|------|----------------------|------|---------|
| **交互模式** | Inline panel（⌘I）+ Sidebar chat | Sidebar chat | **Mona 可后期添加 inline 模式** |
| **上下文感知** | Target-first：连接/会话/终端缓冲区/SFTP 路径/设置/知识库 | 终端缓冲区注入 | **Mona 的 AI 上下文太窄**。应扩展到 SFTP 路径、连接信息 |
| **执行命令** | ✅ 审批制执行远程命令（`terminalRun`/`terminalSend`/`terminalWait`/`terminalObserve`） | ❌ 仅聊天 | **Mona 应实现 AI 命令执行**。这是 AI 终端的核心价值 |
| **MCP 支持** | ✅ stdio + SSE，`mcpClient.ts` + `mcpRegistry.ts` | ❌ | **Mona 可通过现有 Agent Tool 体系实现** |
| **RAG 知识库** | ✅ BM25 + HNSW 向量检索 + CJK bigram 分词 + Markdown 感知分块 | ❌ | **Mona 可后期添加** |
| **Provider** | OpenAI/Ollama/DeepSeek/Anthropic/Gemini/OneAPI | Mona Agent（Python Gateway） | **架构不同**。OxideTerm 直连 LLM API，Mona 通过 Python Agent 间接调用 |
| **安全护栏** | ✅ `guardrails.ts` + `toolUsePolicy.ts` + `risk.ts`（命令风险分级） | ❌ | **Mona 应添加**。AI 执行命令需要风险控制 |
| **工具系统** | ✅ 12+ 工具：terminalRun/Send/Wait/Observe + fileInspect + sftpPath + settings + knowledgeBase | ❌ 仅聊天 | **Mona 应实现 AI 工具系统** |

**结论：OxideTerm 的 AI 集成远超 Mona，但 Mona 有自己的 Agent 体系优势。Mona 应优先实现 AI 命令执行（审批制）和上下文扩展**

---

## 十三、配置与持久化

| 维度 | OxideTerm | Mona | 对比结论 |
|------|-----------|------|---------|
| **连接配置** | OS keychain + 加密 Vault + SSH config 解析 | JSON 明文 `terminal-connections.json` | **Mona 必须加密** |
| **SSH config** | ✅ 解析 `~/.ssh/config`，自动导入用户已有配置 | ❌ | **Mona 应添加**。用户已有 SSH 配置应自动识别 |
| **设置持久化** | ✅ Rust 端权威存储 + 前端快照同步 | ❌ Zustand 内存状态，刷新丢失 | **Mona 应实现持久化** |
| **导出/导入** | ✅ `.oxide` 加密导出（ChaCha20-Poly1305 + Argon2id） | ❌ | **Mona 可后期添加** |

---

## 十四、测试与质量

| 维度 | OxideTerm | Mona | 对比结论 |
|------|-----------|------|---------|
| **Rust 单元测试** | ✅ 每个模块都有 `#[cfg(test)]`（known_hosts 400+ 行测试、state machine 200+ 行测试、wire protocol 200+ 行测试） | ❌ 无测试 | **Mona 应添加核心模块测试** |
| **前端测试** | ✅ vitest + @testing-library/react | ❌ | **Mona 应添加** |
| **集成测试** | ✅ SSH Agent 集成测试、Proxy 集成测试 | ❌ | — |
| **CI** | ✅ GitHub Actions（build + test + lint） | ❌ | — |

---

## 十五、综合优先级排序

| 优先级 | 改进项 | 参考模块 | 预估工作量 |
|--------|--------|---------|-----------|
| **P0** | Host Key TOFU 校验 | `ssh/known_hosts.rs` | 2 天 |
| **P0** | 凭据加密存储（keyring crate） | `config/keychain.rs` + `config/vault.rs` | 2 天 |
| **P0** | WebSocket 二进制数据面 | `bridge/server.rs` + `bridge/protocol.rs` | 5 天 |
| **P1** | 连接池（DashMap + 引用计数） | `ssh/connection_registry.rs` | 3 天 |
| **P1** | SSH Agent 认证 | `ssh/agent.rs` | 2 天 |
| **P1** | 自动重连（基础版） | `session/reconnect.rs` | 3 天 |
| **P1** | 会话状态机 | `session/state.rs` | 1 天 |
| **P1** | Keepalive + 心跳 | `session/health.rs` | 1 天 |
| **P1** | 端口转发（-L/-R） | `forwarding/local.rs` + `forwarding/remote.rs` | 5 天 |
| **P2** | SFTP 传输队列 + 断点续传 | `sftp/transfer.rs` + `sftp/progress.rs` | 5 天 |
| **P2** | ProxyJump | `ssh/proxy.rs` | 3 天 |
| **P2** | Keyboard-Interactive 2FA | `ssh/keyboard_interactive.rs` | 1 天 |
| **P2** | WebGL 渲染器 | `useAdaptiveRenderer.ts` | 2 天 |
| **P2** | 全局终端注册表 | `terminalRegistry.ts` | 2 天 |
| **P2** | Store 拆分 | OxideTerm 19 个 Store | 3 天 |
| **P3** | AI 命令执行（审批制） | `lib/ai/tools/` | 5 天 |
| **P3** | SSH config 解析 | `config/ssh_config.rs` | 2 天 |
| **P3** | 分屏 | `SplitTerminalContainer.tsx` | 2 天 |
| **P3** | Shell 自动检测 | `local/shell.rs` | 1 天 |
| **P3** | 核心模块单元测试 | OxideTerm 测试代码 | 持续 |
