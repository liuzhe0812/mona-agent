# Mona 项目开发规则

## 架构原则

- 核心保持精简，扩展放在边缘：新功能优先通过 `channels/`、`tools/`、skills 或 MCP 服务器添加，避免直接修改 `agent/loop.py` 和 `agent/runner.py`
- 简单优于框架：优先写简洁可读的代码，而非引入新的抽象层
- 允许重复，拒绝过早抽象：channel 和 provider 之间允许重复逻辑（如重试、媒体处理、消息拆分），不要为此引入复杂基类或共享 helper
- 最小变更：修 bug 只改必要部分，不要捆绑无关重构；如需重构，单独提 PR
- 显式优于隐式：配置必须在 `config/schema.py` 的 Pydantic 模型中显式声明；错误处理应抛出明确异常，而非静默纠正

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

## 配置规范

- 配置模型必须继承 `mona.config.schema.Base`（配置了 `alias_generator=to_camel` 和 `populate_by_name=True`）
- JSON 中使用 camelCase（如 `allowFrom`），Python 中使用 snake_case（如 `allow_from`）
- 敏感信息使用 `${VAR_NAME}` 环境变量引用，不要硬编码到 `config.json`

## 模板与 Prompt

- Agent 系统提示词和场景指令位于 `mona/templates/`，使用 Jinja2 markdown 格式
- 修改模板文件等同于修改运行时代码，需保持变更范围最小
- 不要教模型重复内部标记、本地路径或 tool-call 文本
