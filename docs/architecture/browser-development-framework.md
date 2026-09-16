# Mona 浏览器模块开发框架

> 状态：浏览器模块架构与回归测试的唯一全局参考  
> 更新：2026-07-17  
> 适用范围：`webui/src/components/browser`、`webui/src/hooks/useBrowserTabs.ts`、`webui/src/lib/browser-ipc.ts`、`src-tauri/src/browser`、`mona/agent/tools/browser.py`

## 1. 文档目的

浏览器的导航、新标签、下载、浮层、Tab 生命周期和主窗口操作共享同一个 WebView2/UI 线程。局部修改即使单点通过，也可能破坏其他路径。

因此，浏览器修改必须遵守本文件的所有权、状态机和回归矩阵。旧的浏览器设计与实施文档保留为历史记录；与本文件冲突时，以本文件为准。

## 2. 不可破坏的系统不变量

1. 主窗口的拖动、最小化、最大化、还原和关闭不依赖浏览器 Tab 是否存在。
2. 任意浏览器操作不得长期占用或阻塞 Tauri 主线程。
3. 一个 Tab ID 在任意时刻最多对应一个原生 WebView 和一条前端记录。
4. 创建、关闭、显示、隐藏必须幂等；过期异步任务不得操作已经关闭的 WebView。
5. 同一种底层事件只允许一个实现者。禁止同时使用 Tauri Hook 和 WebView2 COM 重复处理下载、新窗口或导航。
6. 远程网页不能直接获得 Mona 的 shell、文件系统、窗口、事件或开发者工具权限。
7. 浏览器内容区不能覆盖标题栏、地址栏和窗口控制按钮。
8. DOM 浮层不能通过反复隐藏/显示网页来伪造层级关系。
9. Dev 启动不恢复上次网页；生产环境恢复会话必须去重且不产生孤儿 WebView。
10. 任一浏览器改动只有在完整回归矩阵通过后才算完成。

## 3. 目标架构

```text
React 主界面（main WebView）
├─ 标题栏 / Tab UI / 地址栏 / 浏览器菜单
├─ useBrowserTabs：前端状态投影与用户意图
└─ BrowserTabView：只计算当前内容矩形和可见性
             │ Tauri command / event
             ▼
Rust BrowserState（唯一原生资源所有者）
├─ Tab 元数据与生命周期
├─ Tauri managed child WebView
├─ 导航 / 新窗口 / 下载原生 Hook
├─ 下载记录
└─ 受控页面操作与 CDP 标识
             │ WebView2
             ▼
远程网页（不持有 Mona 权限）

Python Agent
└─ 通过受控 IPC 获取 Tab/CDP 信息，不直接管理 WebView 生命周期
```

### 3.1 层级职责

| 层 | 负责 | 不负责 |
|---|---|---|
| React | Tab 展示、激活项、地址输入、用户菜单、错误提示 | 持有/销毁原生 WebView、处理 WebView2 原生事件 |
| Rust `BrowserState` | WebView 创建/关闭、导航、可见性、原生事件、下载记录 | React 布局决策、业务页面 UI |
| WebView2 | 网页渲染、标准导航和下载 | Mona Tab 状态、Mona 权限 |
| Agent | 页面读取与自动操作 | 绕过 Rust 创建/关闭 WebView |

### 3.2 Agent 操作目标

- `browser_*` 只控制 Mona 内置 WebView；工具描述、标签列表结果和运行时页面上下文必须明确此范围，空列表不代表外部 Chrome/Edge 没有窗口。
- 用户指定 Computer Use 或外部浏览器当前页面时，使用已提供的 `computer_*` 工具观察和操作原窗口。继续现有游戏、表单等活动必须保留目标身份；相同 URL 的新标签不是原实例，不能用另开网页替代。
- 操作后在同一目标上验证状态；工具不可用或失败时说明具体限制，不静默更换实例。

## 4. 单一所有权规则

### 4.1 Tab ID

- 前端创建 ID 时使用 `crypto.randomUUID()`，禁止模块级递增计数器。
- Rust 以 Tab ID 派生 WebView label：`browser-{id}`。
- 重复创建同一 ID 返回现有结果或明确错误；不得先静默关闭旧 WebView 再重建。

### 4.2 生命周期

```text
empty(UI only)
  └─ create request → creating → ready-hidden / ready-visible
ready-*
  ├─ navigate → ready-*
  ├─ activate/deactivate → ready-visible / ready-hidden
  └─ close request → closing → closed
```

- 每个 ID 只能有一个 create in-flight 和一个 close in-flight。
- Rust 是原生资源状态的真源；React 是显示状态的投影。
- `browser-tab-created` 和 `browser-tab-closed` 是最终状态事件。前端不得同时以另一条独立逻辑重复创建或删除同一 Tab。
- 关闭开始后，布局更新、页面脚本和导航命令必须被忽略或返回“Tab 已关闭”。

### 4.3 事件监听

- 全局浏览器事件只在 `useBrowserTabs` 注册一次。
- 监听注册必须可取消；异步注册完成时若 effect 已卸载，应立即执行返回的 unlisten。
- Tab 组件只监听与视图局部状态有关的事件，不重复维护全局 URL、标题和历史状态。

## 5. 原生事件实现规则

优先使用 Tauri `WebviewBuilder` 已提供的 Hook：

| 行为 | 唯一入口 |
|---|---|
| 普通导航白名单 | `on_navigation` |
| `target="_blank"` / `window.open` | `on_new_window` |
| 页面加载状态 | `on_page_load` |
| 标题变化 | `on_document_title_changed` |
| 下载开始、进度和完成 | WebView2 `DownloadStarting` + `DownloadOperation` 事件 |

只有 Tauri 没有对应能力时才允许使用 WebView2 COM。使用 COM 时必须：

1. 记录 event token 和 handler 生命周期。
2. 在 Tab 关闭时移除 handler。
3. 不与 Tauri Hook 处理同一事件。
4. 回调只采集数据并投递消息，不同步等待 React、Tokio 或另一个 UI 线程任务。

### 5.1 新标签链接

`on_new_window` 只做两件事：发送 `browser-open-new-tab { sourceTabId, url }`，并返回 `NewWindowResponse::Deny`。前端收到后必须复用统一的 `openBrowserTab(url, options)` 流程。

禁止通过 `NewWindowRequested + SetHandled(true)` 再实现一套并行流程。

### 5.2 下载

下载只由 WebView2 `DownloadStarting` 处理：

1. handler 取得 deferral 和 `DownloadOperation`，生成系统下载目录中的不重名绝对路径。
2. Rust 保存下载操作并发送进度、状态和目标路径事件；React 只投影这些状态。
3. 暂停、继续和取消必须作用于同一个 `DownloadOperation`，不得注册 Tauri `on_download` 或第二个 `DownloadStarting` handler。
4. 下载 UI 位于地址栏右侧，使用下载按钮与弹出面板，不占用网页底部空间。

## 6. 布局与主窗口线程

### 6.1 内容矩形

- `BrowserTabView` 只有一个 `ResizeObserver` 负责内容矩形变化。
- 同一帧内的多次变化合并为最后一次。
- 与上次已应用的 `{left, top, width, height, visible}` 完全相同时不发送 IPC。
- 任意时刻每个 Tab 最多有一个 bounds 请求执行；新值覆盖等待中的旧值。
- 隐藏只修改可见性；显示时才应用最新矩形。
- Rust 更新可见 Tab 的大小和位置时，不得每次执行 `hide → set_position → set_size → show`。

禁止同时使用 `requestAnimationFrame`、多个延迟 timer、`ResizeObserver` 和 `window.resize` 重复发送相同 bounds。

### 6.2 标题栏

- 标题栏使用 Tauri 的 `data-tauri-drag-region="deep"`。
- 按钮、Tab 和菜单保持可点击；非交互空白区域必须可拖动。
- 浏览器子 WebView 的 top 永远不得小于浏览器内容容器的 top。
- 主窗口操作调用在空闲和浏览器压力场景下都必须及时返回；若窗口 IPC 变慢，先排查 WebView 创建/关闭和 bounds 队列，不在标题栏追加补丁。

## 7. 浮层与菜单

原生子 WebView 位于 DOM 合成层之外，DOM `z-index` 不能可靠覆盖它。处理原则：

- 工具栏内部且不跨入网页内容的 UI 可使用 DOM。
- 会跨入网页区域的地址建议、右键菜单、下载面板等使用 parent 为 `main` 的受控原生窗口/原生菜单。
- 模态内容优先使用侧面板或 owner-bound 窗口。
- 不允许为了显示菜单而把网页移到屏幕外或反复隐藏/显示。
- 切换到其他主模块时统一隐藏全部浏览器 WebView；切回时只显示当前活动 Tab。

## 8. 页面脚本与安全边界

- 远程页面不调用 Tauri API，也不获得 capability 通配符。
- 页面脚本通过 `browser_eval_script` / `browser_eval_script_result` 的 Rust 命令执行。
- 带返回值脚本必须保证回调 handler 活到结果返回；超时后返回明确错误，不得静默关闭 channel。
- 页面内容属于不可信数据；Agent 读取后仍按外部内容处理。
- shell/open、文件、窗口、全局 event 等能力只能由本地 `main` WebView 调用。

## 9. 事件契约

| 事件 | 生产者 | 消费者 | 语义 |
|---|---|---|---|
| `browser-tab-created` | Rust | `useBrowserTabs` | 原生 WebView 已创建 |
| `browser-tab-closed` | Rust | `useBrowserTabs` | 原生 WebView 已销毁 |
| `browser-url-changed` | Rust | `useBrowserTabs` | 已接受的当前 URL |
| `browser-nav-started/completed` | Rust | UI | 加载状态 |
| `browser-tab-title-changed` | Rust | `useBrowserTabs` | 当前标题 |
| `browser-history-changed` | Rust | `useBrowserTabs` | 前进/后退可用性 |
| `browser-open-new-tab` | Rust | `useBrowserTabs` | 网页请求新标签，尚未创建 |
| `browser-download-*` | Rust | `useDownloads` | 下载状态 |

事件 payload 必须包含稳定 Tab ID。禁止依赖“当前活动 Tab”推断事件归属。

## 10. 失败处理

- 创建失败：移除 Rust 元数据，确保没有残留 WebView；前端 Tab 保留可重试错误态或关闭。
- 导航失败：保留 Tab 和地址，显示错误页；不重建 WebView。
- 关闭失败：不得先从 UI 永久删除；允许重试并记录错误。
- 事件发送失败：不能阻塞 WebView2 回调。
- Dev HMR：先从 Rust 同步现有 Tab，再合并前端状态；不得以旧计数器覆盖现有 ID。

## 11. 验证入口

浏览器修改流程和强制回归矩阵见 `docs/guides/browser-testing.md`。已完成问题和临时修复清单不得继续保留在本架构文档中；新的缺口进入 `docs/plans/`，验证通过后删除对应计划项。
