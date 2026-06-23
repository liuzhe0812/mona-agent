# Mona 项目开发规则

## 架构原则

- 核心保持精简，扩展放在边缘：新功能优先通过 `channels/`、`tools/`、skills 或 MCP 服务器添加，避免直接修改 `agent/loop.py` 和 `agent/runner.py`
- 简单优于框架：优先写简洁可读的代码，而非引入新的抽象层
- 允许重复，拒绝过早抽象：channel 和 provider 之间允许重复逻辑（如重试、媒体处理、消息拆分），不要为此引入复杂基类或共享 helper
- 最小变更：修 bug 只改必要部分，不要捆绑无关重构；如需重构，单独提 PR
- 显式优于隐式：配置必须在 `config/schema.py` 的 Pydantic 模型中显式声明；错误处理应抛出明确异常，而非静默纠正

## 端口架构（重要，勿搞混）

Mona 运行时有两个 HTTP/WebSocket 服务：

| 服务 | 配置项 | 默认端口 | 实现 | 路由 |
|------|--------|----------|------|------|
| **Gateway HTTP server**（aiohttp） | `gateway.port` | 17173 | `mona/cli/commands.py` 的 `_http_server()` → `mona/api/server.py` 的 `create_app()` | **所有** HTTP 路由：`/health`、`/v1/chat/completions`、`/api/kb/*`、`/email/*` 等 |
| **WebSocket Channel** | `channels.websocket.port` | 8765 | `mona/channels/websocket.py` 的 `serve()` + `_dispatch_http_inner()` | WebSocket 连接 + **仅 GET** HTTP 路由（settings、sessions 等）。websockets 库的 `process_request` **无法可靠读取 POST body** |

### 前端如何选择端口

- **需要 POST body 的路由**（如 `/email/*`、`/api/kb/*` 的创建/更新操作）用 `getGatewayHttpBase()`（返回 `http://127.0.0.1:${port}`，gateway 端口）
- **纯 GET 路由或 WebSocket** 用 `getApiBase()`（返回 `http://127.0.0.1:${ws_port}`，websocket 端口）
- **禁止硬编码端口**，必须通过上述函数动态获取

### 新增 HTTP 路由的规则

- 需要 POST body 的路由注册在 `mona/api/server.py` 的 `create_app()` 中 → 前端用 `getGatewayHttpBase()`
- 纯 GET 路由可注册在 `mona/channels/websocket.py` 的 `_dispatch_http_inner()` 中 → 前端用 `getApiBase()`
- 业务逻辑放在 `mona/api/server.py` 的辅助函数中（如 `_imap_list_folders`），由 aiohttp handler 调用

### Rust 侧

- `gateway_status` 命令返回 `{ port, ws_port }`：`port` 是 gateway HTTP 端口（aiohttp app），`ws_port` 是 websocket 端口
- Rust 命令需要调用 HTTP 路由时，前端应传入 `getGatewayHttpBase()` 的返回值作为 `gateway_url` 参数

## Dev 模式 Python 包安装（重要）

Dev 模式下 gateway 进程通过 `python -m mona gateway` 启动，Python 会从 `site-packages` 加载 `mona` 包。**必须以可编辑模式安装源码树**，否则修改 `mona/` 下的 Python 代码不会生效：

```bash
pip install -e . --no-deps
```

- `--no-deps` 避免重复安装依赖（依赖已在环境中）
- 安装后 `import mona` 会指向源码树（如 `D:\...\Mona\mona\`），修改立即生效
- 验证：`python -c "import mona.api.server; print(mona.api.server.__file__)"` 应指向源码树而非 site-packages

### 已知问题：gateway.rs 的 PYTHONPATH 计算

`src-tauri/src/gateway.rs` 在 dev 模式下会尝试设置 PYTHONPATH 指向源码树，但路径计算有误：exe 在 `src-tauri/target/debug/`，`project_root = exe_dir.parent()` 得到的是 `src-tauri/target/`，而非项目根。导致 `mona_pkg_dir` 不存在，PYTHONPATH 不会被设置。**当前通过 `pip install -e .` 规避此问题。**

## 代码风格

- Python >=3.11，使用现代 Python 特性
- Ruff lint 规则：`select = ["E", "F", "I", "N", "W"]`，忽略 `E501`
- 行宽上限 100 字符
- **禁止使用 `ruff format`**，只能用 `ruff check`，因为 format 会破坏 git blame 历史
- 使用 `loguru` 做日志，使用 `pydantic` 做数据模型
- 异步代码使用 `asyncio`

## 跨平台兼容

- 项目必须支持 Windows
- 路径操作必须使用 `pathlib.Path`，不要假设 `/` 分隔符
- `ExecTool` 在 Windows 上使用 `cmd /c`，在 Unix 上使用 `sh -c`
- MCP stdio 服务器命令需对 Windows 路径分隔符做规范化

## 安全边界

- 文件系统工具必须通过 `_resolve_path`（`agent/tools/filesystem.py`）校验路径，确保在 workspace 内
- 所有出站 HTTP 请求必须通过 `validate_url_target`（`security/network.py`）做 SSRF 防护，禁止直接使用 `httpx.get` / `requests.get`
- 新增沙箱后端需实现 `_wrap_<name>(command, workspace, cwd) -> str` 并注册到 `_BACKENDS`
- 不要在代码中暴露 API 密钥、token 或敏感信息

### 红线：禁止依赖用户侧 Python 环境

- **Mona Desktop 必须完全自包含**，所有 Python 依赖必须在构建时打包进 `python.tar.gz`，不得要求用户机器上预装 Python 或任何 pip 包
- 禁止运行时调用 `pip install`：用户机器上可能没有 pip、没有网络、没有 Python
- 新增 Python 依赖时必须评估对安装包体积的影响，优先选择轻量替代方案
- 所有功能必须开箱即用，零额外配置

## 配置规范

- 配置模型必须继承 `mona.config.schema.Base`（配置了 `alias_generator=to_camel` 和 `populate_by_name=True`）
- JSON 中使用 camelCase（如 `allowFrom`），Python 中使用 snake_case（如 `allow_from`）
- 敏感信息使用 `${VAR_NAME}` 环境变量引用，不要硬编码到 `config.json`

## 模板与 Prompt

- Agent 系统提示词和场景指令位于 `mona/templates/`，使用 Jinja2 markdown 格式
- 修改模板文件等同于修改运行时代码，需保持变更范围最小
- 不要教模型重复内部标记、本地路径或 tool-call 文本

## UI 规范

### 红线：禁止使用浏览器原生控件样式

- **禁止直接使用浏览器原生表单控件**（`<input>`、`<textarea>`、`<select>`、`<button>` 等），必须使用项目 UI 组件库封装的对应组件，确保视觉风格统一
- 输入框：使用 `Input`（`@/components/ui/input`）或 `Textarea`（`@/components/ui/textarea`）
- 下拉选择：使用 `Select` / `Combobox` 等组件库封装
- 按钮：使用 `Button`（`@/components/ui/button`）
- 全局已通过 `globals.css` 移除浏览器默认 focus outline（`*:focus { outline: none; }`），聚焦样式由组件库内部 `focus-visible:ring` 控制

### 输入框细节

- 圆角统一使用 `rounded-full`（单行输入）或 `rounded-lg`（多行文本域）
- 高度统一 `h-8`，字号 `text-[13px]`
- 禁止在输入框上添加额外的 `border`、`outline`、`ring` 样式，除非有明确的交互需求（如错误状态 `ring-destructive`）
