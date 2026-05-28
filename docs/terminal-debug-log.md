# 终端模块问题处理记录

## 当前问题

1. **新标签页不显示内容**：点击 + 打开新 Shell，终端区域空白，切换到其他标签再切回来才能看到内容（第 12 次修复方案待验证）
2. **无法输入**：终端区域无法接收键盘输入（待验证）
3. **标签页命名**：✅ 已修复 — 本地 Shell SSH 命令拦截 + 内置 SSH 用 host 命名

---

## 失败修复历史

### 尝试 1：初始 fit 后同步 PTY 尺寸
- **修改**：XtermTerminal.tsx — `fitAddon.fit()` 后调用 `resizeFn()`
- **结果**：未解决显示问题
- **失败原因**：尺寸同步是必要的，但不是根因

### 尝试 2：移除 mousedown 拦截器
- **修改**：XtermTerminal.tsx — 移除 `.xterm-screen` 上的 `stopImmediatePropagation`
- **结果**：恢复了输入，但光标可移动到上面覆盖内容
- **失败原因**：治标不治本，光标定位问题未解决

### 尝试 3：Bridge 同步点 + clear/reset + Buffer 重写
- **修改**：XtermTerminal.tsx — Bridge 连接后 `term.clear()` + `term.reset()` + `shellGetBuffer` 重写
- **结果**：本地 Shell 无内容显示
- **失败原因**：`shellGetBuffer` 在 Bridge 块内被无条件调用（包括 SSH），SSH 会话抛错导致整个 Bridge 块被 `catch {}` 吞掉

### 尝试 4：简化为 IPC 单路径 + Bridge 切换
- **修改**：XtermTerminal.tsx — IPC 作为初始路径，Bridge 连接后切换
- **结果**：第 3 个字母时输入区域跳到中间
- **失败原因**：后端同时通过 IPC 和 Bridge 发送同一份数据，造成重复写入

### 尝试 5：draining 机制跳过 Bridge 缓冲帧
- **修改**：XtermTerminal.tsx — Bridge 订阅后先 draining，requestAnimationFrame 后开始接收
- **结果**：本地 Shell 无内容
- **失败原因**：tokio broadcast channel 不会向新订阅者重放历史（假设错误），draining 导致首批 Bridge 数据丢失

### 尝试 6：架构重构 — 渲染所有终端实例，CSS 显示/隐藏
- **修改**：TerminalView.tsx — 遍历 sessions 渲染所有终端，用 `display: none/block` 切换
- **结果**：新标签仍不显示内容，且无法输入
- **失败原因**：架构改进是正确的，但没有解决 IPC 监听器注册时序问题

### 尝试 7：全局 IPC 监听器 + Store 缓冲 + Zustand subscribe
- **修改**：TerminalView.tsx 注册全局 `onTerminalOutput`，XtermTerminal 从 Store 读取数据
- **结果**：新标签仍不显示内容，无法输入
- **失败原因**：`onTerminalOutput` 使用 `await import("@tauri-apps/api/event")` 动态导入，注册监听器有延迟

### 尝试 8：静态导入 + Store 全局监听 + 版本号追踪
- **修改**：ipc.ts 静态导入，Store 创建后立即注册全局 IPC 监听器，OutputBufferEntry 版本号
- **结果**：新标签仍不显示内容，无法输入
- **失败原因**：IPC 监听器在 IIFE 的 `await` 之后注册，此时 shellSpawn 可能已经发出首批数据

### 尝试 9：OxideTerm 架构 — 全局注册表 + Bridge 单数据面
- **修改**：新建 TerminalRegistry，Store 初始化时建立 Bridge 连接，onFrame → registry.write()
- **结果**：默认标签页不显示内容，点击+也没反应
- **失败原因**：Bridge WebSocket 连接是异步的，tokio broadcast channel 不会为未连接的客户端保留数据

### 尝试 10：bridgeReady 硬门控
- **修改**：暴露 `bridgeReady` Promise，所有 shellSpawn/sshConnect 调用前 `await bridgeReady`
- **结果**：应用启动不显示新标签，点击+也没反应（比之前更严重）
- **失败原因**：`ensureBridgeConnected` 可能挂起导致死锁；硬门控模式在异步 Bridge 场景下不可行

### 尝试 11：双数据源兜底（terminalGetOutput）
- **修改**：XtermTerminal 注册后检查 registry 缓冲，为空时调 `terminalGetOutput` 兜底
- **结果**：默认标签页仍然没有内容
- **失败原因**：`terminalGetOutput` 调用时 PTY 读者线程可能还没读到初始 prompt，返回空字符串

---

## 根因分析（第 12 次深度调查）

### 核心问题：所有方案都败在"时序"上

| 方案 | 时序问题 |
|------|---------|
| IPC 监听器（尝试 7-8） | 监听器在 `await` 之后注册，首批 emit 事件丢失 |
| Bridge WebSocket（尝试 9） | WebSocket 连接是异步的，broadcast 不重放历史 |
| bridgeReady 门控（尝试 10） | 可能死锁，且 Bridge subscribe 时序仍不可控 |
| terminalGetOutput 兜底（尝试 11） | 调用时 PTY 还没输出数据，返回空字符串 |

### 关键洞察：IPC `listen()` 是同步注册的

Tauri 2 的 `listen()` 函数内部调用 `window.__TAURI_INTERNALS__.listen()`，这是**同步**的——监听器在函数调用时立即注册，不需要等 Promise resolve。

之前尝试 7-8 失败的原因是：监听器注册代码在 IIFE 的 `await` **之后**，导致注册被延迟到微任务队列。

**解决方案：在 IIFE 的第一个 `await` 之前同步注册 IPC 监听器。**

```
时间线（修复后）：
  T1: Store 模块加载 → IIFE 开始执行
  T2: onTerminalOutput(handler) → 同步注册 IPC 监听器（在第一个 await 之前！）
  T3: IIFE 执行到 await bridgeGetPort() → 暂停
  T4: TerminalView 挂载 → shellSpawn() → Rust 创建 PTY → PTY 输出 prompt
  T5: Rust: emit("terminal-output", data) → IPC 监听器收到 → registry.write()
  T6: XtermTerminal 挂载 → registry.register() → 写入缓冲数据
```

**T2 在 T4 之前**，监听器在 shellSpawn 之前就已激活。

### 去重机制

后端同时通过 IPC emit 和 Bridge WebSocket 发送同一份数据。TerminalRegistry 使用 `writtenLen` 游标去重：

- `write(sid, data)` 追加到缓冲区，但只写入 `newBuf.slice(alreadyWritten)` 到终端
- `register(sid, terminal)` 注册时自动写入缓冲区中尚未显示的数据
- 同一份数据无论从 IPC 还是 Bridge 到达，都只会写入终端一次

---

## 修复方案（第 12 次）— 同步 IPC + Bridge 双通道 + 去重

### 核心策略

1. **IPC 监听器同步注册**：在 Store IIFE 的第一个 `await` 之前注册，保证在 shellSpawn 之前激活
2. **Bridge 尽力而为**：异步连接，连上了也推送数据（与 IPC 数据相同，靠去重机制避免重复写入）
3. **TerminalRegistry 去重**：`writtenLen` 游标确保同一份数据只写入终端一次
4. **register 自动恢复**：终端注册时自动写入缓冲区中未显示的数据

### 数据流

```
后端 PTY/SSH 输出
  ├→ IPC emit("terminal-output") → 同步到达前端 → registry.write()
  └→ Bridge broadcast → 异步到达前端 → registry.write()（去重后跳过已写入部分）

TerminalRegistry.write(sid, data):
  1. 追加到 buffer
  2. 如果终端已注册 → 计算 newBuf.slice(alreadyWritten) → terminal.write()
  3. 更新 writtenLen 游标

XtermTerminal 挂载:
  1. registry.register(sid, terminal) → 自动写入 buffer 中未显示的数据
  2. 之后 IPC/Bridge 持续推送新数据
```

### 修改的文件

| 文件 | 修改内容 |
|------|---------|
| `terminalStore.ts` | IIFE 中在第一个 `await` 之前同步注册 `onTerminalOutput` |
| `terminalRegistry.ts` | 添加 `writtenLen` 游标去重机制；`register()` 自动写入未显示数据 |
| `XtermTerminal.tsx` | 移除 `terminalGetOutput` 兜底，`register()` 已自动处理 |

### 关键代码

**Store IIFE 同步注册 IPC**（terminalStore.ts）：
```typescript
// 在第一个 await 之前同步注册——保证监听器在 shellSpawn 之前激活
onTerminalOutput((event) => {
  registry.write(event.sessionId, event.data);
}).catch(() => {});

// Bridge 异步连接（尽力而为）
(async () => {
  try {
    const port = await bridgeGetPort();
    if (port <= 0) return;
    const client = await ensureBridgeConnected(port);
    client.onFrame((_sid, frameType, payload) => {
      if (frameType === 0x00) {
        const text = new TextDecoder().decode(payload);
        registry.write(_sid, text);
      }
    });
  } catch {}
})();
```

**TerminalRegistry 去重**（terminalRegistry.ts）：
```typescript
write(sessionId: string, data: string): void {
  const buf = this.buffers.get(sessionId) ?? "";
  const newBuf = buf + data;
  this.buffers.set(sessionId, newBuf);
  const terminal = this.terminals.get(sessionId);
  if (terminal) {
    const alreadyWritten = this.writtenLen.get(sessionId) ?? 0;
    if (newBuf.length > alreadyWritten) {
      terminal.write(newBuf.slice(alreadyWritten));
      this.writtenLen.set(sessionId, newBuf.length);
    }
  }
}
```

### 待验证

- [ ] 默认标签页是否立即显示内容
- [ ] 点击+是否正常打开新标签
- [ ] 终端是否可以正常输入
- [ ] SSH 连接是否正常
