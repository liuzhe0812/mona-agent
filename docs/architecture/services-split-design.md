# Mona 后端进程拆分架构

- 状态：Accepted / Implemented
- 最后更新：2026-10-09

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
- Tauri 在开发和桌面运行时持有进程句柄；停止应用时应回收两个子进程。Windows 新启动的后端及其子进程使用不继承的 Job Object，桌面崩溃或被强制结束时由系统回收；跨平台后端同时通过父进程持有的 stdin 管道检测桌面退出，先触发正常清理，5 秒内未结束则退出。隐藏到后台不关闭桌面进程或管道，继续保留运行态。内部监督标志在后端入口消费，不传给 SDK worker 等有独立 stdin 协议的子进程。
- 外部已经运行的兼容进程可以复用，但必须通过版本/健康检查确认，不根据端口占用直接判定可用。三个健康接口都声明产品版本；发布版仅复用当前版本且所有必需能力均就绪的后端。旧版、能力不匹配或 Gateway 会话端未就绪时，先通过已确认属于 Mona 的接口请求退出，再等待相关端口全部释放。仅返回 `status=ok` 不足以确认 Mona 身份，不能据此停止其他软件。
- 复用只适用于发布版。dev（`debug_assertions`）必须自己从源码拉起两个后端：它启动的后端是一次性的、代码随时在变，复用等于继续跑旧代码——典型症状是源码里已有的路由在请求时返回 404。因此 dev 遇到端口被占时只区分两种结局：占用者是 Mona 服务就用 `/shutdown` 请它优雅退出再自己拉起，不是 Mona 就报错，绝不复用也不强杀无关进程。发布版保留复用，因为第二窗口与 `run_in_background` 的常驻会话需要共享同一后端状态。
- 旧后端不响应或优雅退出未释放端口时，可回收经系统监听表确认的 Mona 端口所有者：必须同时核对可执行文件、Gateway/Services 启动参数与进程生命周期，只结束该进程，不按镜像名全局清理。Windows 使用核验过创建时间的原生进程句柄终止，避免 PID 复用误伤；无法确认身份时保留进程并报告地址冲突。Gateway 的关闭事件必须结束整套运行任务、停止会话监听并刷写会话，不能只关闭 HTTP 服务。
- 服务重启后前端重新解析 base URL，并保持用户数据和任务状态由各自持久层恢复。
- 默认 `npm run dev` 使用 Tauri `--no-watch`，保留前端 Vite 热更新，避免宿主文件监听在 Code 任务执行中重启整套进程。Rust 自动重载只通过显式 `npm run dev:watch` 启用；修改 Rust 后，默认模式需手动重启。
- 源码开发时 Gateway 和 Services 优先使用源码项目 `.venv` 中满足版本要求的 Python，以保证两者使用 `pyproject.toml` 声明的同一依赖集合；没有项目环境时才探测本机 Python。仅验证 Python 版本不能证明新增业务依赖可用。正式版仍只启动安装包中的后端。
- 全局工作区与运行时迁移由 Gateway 启动路径唯一负责；Services 只确保自身目录存在，功能运行时按需解析组件，不重复执行全局迁移。
- MCP 和电脑操作等可延后能力不得阻塞基础 HTTP/会话健康接口绑定；具体请求仍在使用能力前完成连接或返回明确的不可用状态。
- MCP 客户端 SDK 的冷导入在工作线程执行，传输创建、连接和关闭仍由原连接 Task 持有。会话列表、侧栏状态的磁盘读取与设置元数据组装移出 HTTP 事件循环，不能拖住鉴权、健康检查或其他会话请求；配置快照读取及共享安全策略更新仍在事件循环完成。设置只发现界面实际展示的通信渠道，读取类元数据不加载实际连接 SDK。
- 旧会话列表摘要通过 `sessions/.list-summaries.json` 缓存在后台原子写入，不改写原始会话。缓存绑定文件修改时间和大小，原会话中的有效摘要优先；缓存失效或损坏时从会话重建。清空或删除会话同时失效派生缓存，不能保留或恢复已删除的预览。
- MCP 传输的创建、持有和关闭必须由同一个专用 Task 负责，避免 SDK 的取消作用域影响 Gateway 主循环。初始化使用配置快照，并合并等待期间动态接入的连接；批次中断时关闭尚未交付的连接，不能清空其他已建立连接。

## 4. 鉴权与网络边界

- 两个进程都只在预期接口监听，远程暴露策略必须显式配置。
- 本地受保护业务路由使用 Mona 本地服务令牌；不能因为监听 loopback 就省略敏感操作鉴权。
- WebUI 会话接口与聊天连接共用 Gateway 本次运行的随机令牌，只保存在内存中，不按时间过期；多窗口获取同一个令牌，Gateway 停止或重新创建后旧令牌失效。前端仅在初始化和断线重连时重新获取，不做定时续期。Bootstrap 保留已有本机来源或配置密钥校验；可选的独立 WebSocket 发证接口仍使用短期一次性令牌。
- 桌面启动、复用和就绪检查要求 WebSocket 健康接口声明 `webui-runtime-token-v1`，避免新界面误连仍使用短期令牌的旧后台。
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
