# Mona 后端进程拆分架构

- 状态：Accepted / Implemented
- 最后更新：2026-09-05

## 1. 进程所有权

Mona Python 后端拆分为两个独立进程：

| 进程 | 默认端口 | 所有权 |
|---|---:|---|
| Gateway | 17173 | AgentLoop、会话、模型、工具、MCP 运行态和 Agent WebSocket/HTTP API |
| Services | 17174 | 不依赖 AgentLoop 的产品业务 API，如资料、Office 编辑会话、文档、视频、股票和画像 |

Tauri 负责启动、停止、健康检查和端口发现。WebUI 不写死端口，通过 `getGatewayHttpBase()`、`getServicesHttpBase()` 等已有解析函数访问对应进程。

## 2. 路由归属

路由归属由运行时依赖决定，而不是由 HTTP 方法或前端页面决定：

- 直接读取或操作 AgentLoop、SessionManager、模型提供商、工具注册表、MCP 连接和 Agent 状态的路由属于 Gateway。
- 不需要 AgentLoop、可以作为纯业务服务独立启动的路由属于 Services。
- Office session、文件、checkpoint、保存、导出和 Editor WebSocket 只属于 Services；Gateway 仅保留调用这些路由的 `office` Agent 工具和客户端。
- 业务路由不能为了方便直接访问 Gateway 的内部对象；需要 Agent 能力时通过明确的跨进程契约调用。
- 新路由不得在两个进程各注册一份并依赖前端猜测 fallback。

## 3. 生命周期

- Gateway 与 Services 有独立状态和健康检查，任一进程失败不能被另一个进程的存活状态掩盖。
- Gateway 就绪同时要求 17173 的 Agent HTTP 能力和 8765 的 WebUI 会话能力通过身份与 capability 校验；WebSocket 绑定失败属于启动失败，不能由 17173 存活掩盖。
- Tauri 在开发和桌面运行时持有进程句柄；停止应用时应回收两个子进程。
- 外部已经运行的兼容进程可以复用，但必须通过版本/健康检查确认，不根据端口占用直接判定可用。
- 复用只适用于发布版。dev（`debug_assertions`）必须自己从源码拉起两个后端：它启动的后端是一次性的、代码随时在变，复用等于继续跑旧代码——典型症状是源码里已有的路由在请求时返回 404。因此 dev 遇到端口被占时只区分两种结局：占用者是 Mona 服务就用 `/shutdown` 请它优雅退出再自己拉起，不是 Mona 就报错，绝不复用也不强杀无关进程。发布版保留复用，因为第二窗口与 `run_in_background` 的常驻会话需要共享同一后端状态。
- 服务重启后前端重新解析 base URL，并保持用户数据和任务状态由各自持久层恢复。
- 全局工作区与运行时迁移由 Gateway 启动路径唯一负责；Services 只确保自身目录存在，功能运行时按需解析组件，不重复执行全局迁移。
- MCP 和电脑操作等可延后能力不得阻塞基础 HTTP/会话健康接口绑定；具体请求仍在使用能力前完成连接或返回明确的不可用状态。

## 4. 鉴权与网络边界

- 两个进程都只在预期接口监听，远程暴露策略必须显式配置。
- 本地受保护业务路由使用 Mona 本地服务令牌；不能因为监听 loopback 就省略敏感操作鉴权。
- 从 Tauri 到 Python 的请求只附加目标路由所需的最小认证信息。
- 外部 URL 抓取继续经过 SSRF 校验；进程拆分不改变网络安全边界。

## 5. 前端契约

- `webui/src/lib/api.ts` 维护 Gateway 与 Services 两类 base URL，不允许业务组件自行拼接 `127.0.0.1:<port>`。
- 请求错误应区分“目标服务未运行”“业务错误”和“鉴权失败”，不以另一个端口的 HTML 或 404 作为成功 fallback。
- 会话列表的瞬时启动错误应有限重试，并在最终失败时提供明确错误与手动重试；未成功加载不能渲染成空会话事实。
- 长任务的进度、取消和恢复由拥有该任务的进程负责。

## 6. 关键实现

- `mona/api/server.py`：Gateway API 组装与仍依赖 AgentLoop 的 handler。
- `mona/services/server.py`：Services API 组装。
- `mona/services/__init__.py`：Services 入口。
- `src-tauri/src/gateway.rs`：Gateway 进程管理。
- `src-tauri/src/services.rs`：Services 进程管理。
- `src-tauri/src/lib.rs`：Tauri 命令注册和启动顺序。
- `webui/src/lib/api.ts`：前端 API base URL 路由。

## 7. 准入检查

新增或迁移路由必须验证：

- 不跨进程直接读取未声明的运行时对象。
- 路由只在一个所有者进程注册。
- Tauri 和 WebUI 使用正确 base URL。
- 独立停止 Gateway 或 Services 时，错误表现与影响范围符合所有权。
- 受保护路由的本地令牌、CORS 和错误契约有回归测试。
