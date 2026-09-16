# Mona 工程架构边界

- 状态：Accepted
- 适用范围：Mona 桌面端、Python Gateway/Services、WebUI、Agent 与工具系统
- 最后更新：2026-09-09

## 1. 核心与扩展

- `mona/agent/loop.py`、`mona/agent/runner.py` 和上下文构建链路属于核心路径，修改必须小而可验证。
- 新能力优先放在 `mona/channels/`、`mona/agent/tools/`、`mona/skills/`、专家包或 MCP 边界中。
- 不为消除少量重复而引入跨 channel/provider 的复杂基类。共享抽象必须保护真实边界或消除已发生的复杂性。
- 配置必须在 `mona/config/schema.py` 中显式声明，解析路径应能从配置追踪到具体实现。

## 2. 进程与端口所有权

| 服务 | 默认端口 | 所有权 |
|---|---:|---|
| Gateway HTTP / Agent runtime | 17173 | 会话、Agent、模型、工具和 Gateway API |
| Services HTTP | 17174 | 文档、资料、视频、股票等产品业务服务 |
| Browser CDP | 9300 | Tauri WebView2 浏览器调试与自动化 |

新增路由前必须先判断业务所有权，不得通过前端 fallback 掩盖路由注册在错误进程的问题。前端统一通过已有的 Gateway/Services base URL 解析函数访问对应服务。

## 3. Prompt 与上下文稳定性

- 单个 turn 内 system prompt 必须保持字节稳定，避免破坏提供商前缀缓存。
- `ContextBuilder.build_messages` 只在 turn 入口构建初始消息；迭代循环只追加 assistant/tool 消息。
- 固定 system 只保留跨工具规则，工具细节优先由其 Schema 或专用 Skill 承载，避免同一要求在多处重复。提示词精简不得改变工具授权、参数结构、执行边界或 Skill 触发；工具按需加载和记忆召回属于独立能力变更，需单独验证后启用。
- `my`、Notes 与 Agent Knowledge 的搜索/读取保持初始可见。Office、生图/视频、邮件、数据库、终端、笔记写入、收藏、消息、自动化和浏览器通过请求级 `load_capability` 由模型按自然语言加载；活动 UI 上下文和媒体附件可直接预加载，不用关键词分类器。加载只能收窄当前已授权、已注册、订阅和运行上下文允许的集合，不能扩大权限；没有加载器的内部子 Agent 保持原工具视图。
- 开发/文件写入、结构化 HTTP 和 Skill 配套工具同样按需加载；基础文件发现/读取、网页搜索/读取、记忆、资料查询、`skill_read` 和任务协调保持初始可见。成功读取 Skill 后自动提供其参考资料、脚本与素材工具；文档专用 Agent 预加载流水线所需工具。工具授权与模型描述加载分离，不删除必需能力。
- 浏览器、开发、终端和数据库操作契约与工具描述同步提供：初始已加载的进入 system，轮中新增的进入加载工具结果；重复加载不重复注入同一契约。下一 turn 从保留的 assistant 工具调用恢复能力，仍逐次检查当前权限，不重放执行。
- 能力集合只在新 turn 入口初始化；轮内刷新工具路由上下文不得清空已加载、附件预加载或历史恢复的能力。不同 turn 的集合保持隔离。
- Skill 目录可优先使用显式 `short_description`；缺失时保留完整 `description`，不裁掉用户/专家 Skill 或其触发描述。完整 Skill 读取不受目录精简影响。
- 上下文窗口优先使用当前模型目录或探测元数据；目录未知时使用产品统一的 1M 默认值，不接受用户配置覆盖。运行时裁剪、压缩阈值和前端占用显示必须消费同一个解析结果，不能在切换模型后继续沿用上一模型的窗口。
- 模型可用窗口是硬安全边界，自动压缩阈值是可配置的提前整理线，两者不得混为一个配置。压缩只有在完整交接摘要生成并持久化后才能推进会话游标；新摘要必须进入同一轮的后续请求。
- 时间、channel、chat id、浏览器页面、目标状态等动态上下文必须进入带 `_RUNTIME_CONTEXT_TAG` 的 user runtime context，不进入 system prompt。
- 工具执行期间不得把临时路径、工具回显或运行状态写入长期记忆、SOUL、USER 或技能列表。
- 工具结果进入模型前不得按内容猜测做头尾摘录、截短表格或剥离代码/协议；通用归一化只做无损紧凑化，并保持多轮幂等。超出预算时保存全文并明确返回不完整预览及恢复引用。
- 修改 `mona/templates/agent/`、工具描述、Skills 或历史重放逻辑，按修改运行时代码的标准进行评审和回归验证。

## 4. 安全边界

### 文件与工作区

- 路径必须使用 `pathlib.Path` 或 Rust `Path/PathBuf` 解析，不依赖字符串拼接和平台分隔符。
- 开启 `restrict_to_workspace` 时，文件和命令目标必须位于活动工作区或显式允许目录。
- 新的路径入口必须复用现有路径解析/作用域校验，或实现等价的 resolved-path containment 检查。
- 解压包、文件名和用户提供的相对路径必须防止路径逃逸。

### 网络

- Agent 工具和后端外部抓取必须经过 `mona.security.network.validate_url_target` 或等价的逐跳校验。
- 禁止绕过 SSRF 防护直接请求用户提供的 URL。
- 可下载运行时遵循 `runtime-component-management.md` 的固定版本、大小、SHA 和多源规则。

### 凭据与日志

- API Key、密码、Cookie、私钥和访问令牌不得写入仓库文档、Skill、示例、日志或测试快照。
- 运维文档只记录凭据来源和获取方式，不记录凭据值。
- 日志和错误响应不得包含完整请求体、认证头、邮件授权码或进程环境。
- 发现仓库中存在明文生产凭据时，应删除载体并单独轮换凭据；删除文件不能替代轮换。

## 5. Windows 与桌面端

- Mona 的产品交付形态是纯桌面客户端。生产前端由 Tauri 的 `frontendDist` 嵌入主程序；Gateway 发布资源不包含 `mona/web/dist/` 的第二份网页前端。桌面内部 HTTP/WebSocket 通信不代表提供独立网页客户端。
- 正式产品不注册系统级 `mona` CLI。桌面只启动安装包内的 Gateway；源码开发需要手动运行后端时使用 `python -m mona`。
- Python 打包不构建或携带网页前端，Gateway 不托管 SPA 静态文件；前端本地预览输出到 `webui/dist/`，桌面构建输出到 `src-tauri/dist/`。
- 内置 Skill 按文件路径执行的 Python 脚本必须作为资源保留，包括其子目录模块；不能因 Python 代码已进入 PyInstaller import archive 就省略脚本文件。
- Gateway 的本地部署记录应用版本，每次桌面版本升级后重新部署配套资源；不能仅通过可执行文件大小判断资源是否为新版。
- Gateway 发布版本由当前 `pyproject.toml` 生成的包 metadata 决定，不继承构建机器的旧安装版本；产物 `--version` 必须与桌面产品版本一致。
- Mona 必须兼容 Windows 路径、非 ASCII 文件名和 UTF-8 输出。
- 机器相关、可重建且体积较大的数据放在操作系统 LocalAppData；用户数据和工作区不得混入运行时缓存。
- Tauri IPC 的参数名必须与 Rust command 契约一致，并为新增命令增加最小调用测试。
- WebView2 子 WebView 共用应用默认数据目录和固定 CDP 初始化；不要为每个标签创建独立数据目录。

## 6. UI 约束

- `docs/design/mona-ui-design-system.md` 是当前唯一全局视觉规范。
- 新增 UI 使用共享组件和语义 Token；不得新增任意产品色、字号、圆角或阴影。
- UI 改造不捆绑业务重构、性能专项或依赖升级。
- 用户可见文案使用用户语言和用户心智，不暴露内部进程、端口或工具名。
- UI/UX 原型、模拟图和线框图必须交付图像，不用 HTML/CSS/React 代替原型图。

## 7. 代码与测试

- 修改解决问题所需的最少代码，不重构无关模块，不为未发生场景预建框架。
- 仅在意图不明显时添加注释，不保留注释掉的代码和调试输出。
- 测试验证真实行为和边界，不验证 mock 本身；mock 只用于隔离明确依赖。
- Bug 修复至少增加距离故障最近的回归测试；跨进程契约同时覆盖生产端与调用端。
- Python 使用 `ruff check`；不要对历史代码批量执行格式化。
- 长任务将边界清晰、成功标准明确的简单工作交给 Luna，复杂判断和最终整合由主 Agent 负责。

## 8. 文档治理

- `docs/architecture/`：长期、跨模块、被工程规则引用的架构基线。
- `docs/design/`：模块设计和阶段性方案。
- `docs/plans/`：实施计划、批次和临时验收清单。
- `docs/guides/`：操作与开发指南。
- `docs/archive/`：确需留档但不再指导实现的历史材料。
- 根目录只保留 `README.md`、`AGENTS.md` 和生态要求的标准文件；禁止新增根目录开发计划。
- 长期架构必须进入 Git；被忽略的本地文档不能作为产品约束来源。
