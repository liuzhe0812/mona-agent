# Notebook Relay

为笔记本常驻的 OpenAI 兼容接口，当前主目标是 OpenCode 官方免费模型 `deepseek-v4.1-flash-free`。原生通道已通过真实 `/v1/chat/completions` 工具往返验证：调用方执行工具，再把完整历史和工具结果发起下一轮。官方免费服务的可用性、限额和协议可能变化。

## 安装与启动

需要 Python 3.11 或更新版本，以及官方 OpenCode CLI **2.0.32**。服务不会下载运行时；若 `opencode` 不在 `PATH`，可用 `NOTEBOOK_RELAY_OPENCODE_EXECUTABLE` 指定程序路径，启动时会严格检查版本。

在 Ubuntu 笔记本上建议先建立虚拟环境，再安装并启动：

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e .
python -m notebook_relay
```

启用主要通道时，在服务进程环境中设置 `NOTEBOOK_RELAY_UPSTREAM_PROVIDER=opencode_native`。还需由安全运行环境注入至少 16 个字符的 `NOTEBOOK_RELAY_API_KEY`，用于访问本服务；不要把密钥写入工程配置文件、README 或日志。原生免费模型不需要 OpenCode 账户 API Key 或上游模型 Key。

默认单 worker 监听 `127.0.0.1:8800`，只绑定 loopback。服务启动时创建并长期复用一个 `opencode serve --stdio` 进程，不会为每个请求另起 CLI。

## 原生通道与请求隔离

OpenCode 配置、缓存、状态和工作目录使用服务创建的临时目录；子进程环境经过筛选，不传入用户的环境凭据，并关闭祖先项目配置发现。启动时还会检查机器级配置目录；目录非空、不可读或是文件时拒绝启动，不读取或删除配置内容。具体检查范围见[设计契约](docs/design/opencode-bridge.md)。

每个 `POST /v1/chat/completions` 请求使用独立的临时工作区和原生会话。Relay 将调用方提供的完整 system 与消息历史交给该会话，登记本次请求声明的函数工具；OpenCode 不会在本机执行这些工具，调用方负责执行。官方响应的副本由本机 broker 读取并转换为兼容响应；原响应本身不替换。调用方执行工具后，下一次请求须提交完整历史、assistant 工具调用和 `role: "tool"` 结果，服务会创建新会话。

请求完成、超时或客户端断开时，服务按中断、删除会话、清理 location 的顺序释放原生资源。服务退出时也会关闭原生服务并回收子进程。服务入口仅绑定 loopback，受保护接口使用 Bearer 鉴权；错误脱敏，日志不写请求正文或密钥。

## 配置

配置通过进程环境变量注入，不读取工程内 `.env`。原生模式自动固定模型为 `deepseek-v4.1-flash-free`；不要配置其他模型。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NOTEBOOK_RELAY_HOST` | `127.0.0.1` | 仅允许 `127.0.0.1` 或 `::1`。 |
| `NOTEBOOK_RELAY_PORT` | `8800` | 本服务监听端口。 |
| `NOTEBOOK_RELAY_API_KEY` | 必填 | 至少 16 个字符的入口 Bearer 密钥。 |
| `NOTEBOOK_RELAY_UPSTREAM_PROVIDER` | `local` | 主要通道设为 `opencode_native`。 |
| `NOTEBOOK_RELAY_OPENCODE_EXECUTABLE` | 自动发现 | 未设置时从 `PATH` 查找 `opencode`。 |
| `NOTEBOOK_RELAY_MODELS` | 原生模式自动固定 | 原生模式只允许 `deepseek-v4.1-flash-free`。 |
| `NOTEBOOK_RELAY_MAX_CONCURRENCY` | `16` | 本机 Relay 同时处理的入口请求上限；达到上限返回 `429`。 |
| `NOTEBOOK_RELAY_REQUEST_TIMEOUT_SECONDS` | `180` | 单个模型请求的总超时秒数。 |
| `NOTEBOOK_RELAY_MAX_BODY_BYTES` | `2097152` | 入口请求体上限（2 MiB）。 |
| `NOTEBOOK_RELAY_OPENCODE_START_TIMEOUT_SECONDS` | `30` | 原生服务启动等待秒数。 |
| `NOTEBOOK_RELAY_OPENCODE_MAX_RESPONSE_BYTES` | `16777216` | 捕获的原生响应上限（16 MiB）。 |

本机并发上限不代表官方免费通道允许相同并发或持续调用，也不会自动重试、切换模型或回退到付费模型。本机 broker 已验证 15 个独立工作区的并行隔离；未对免费上游施加 15 路并发压力。

## 接口与兼容范围

- `GET /health`：公开的进程存活检查。
- `GET /ready`：需要 Bearer 鉴权；检查本机原生服务与插件就绪，不代表免费上游当前一定可用。
- `GET /v1/models`：需要鉴权，只返回配置允许的模型。
- `POST /v1/chat/completions`：需要鉴权，仅接受固定模型和受支持的请求字段；支持普通 JSON 回复与 SSE。

支持开头的 `system` 消息、文本消息、assistant 历史、reasoning、function 工具调用与 `role: "tool"` 结果；支持 `tool_choice=auto`、SSE usage，以及 `max_tokens`/`max_completion_tokens`、`temperature`、`top_p`、频率/存在惩罚、`seed`、`stop` 和 `reasoning_effort`（`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。上游 usage 原样使用，不用本地估算。

不支持强制或禁用工具选择、图像等多模态输入、`n>1`、`strict: true`、未知字段或互斥参数同时传入；不支持项明确返回 `400`。OpenCode 原生免费模型会按实际上游能力返回文本或工具调用，不保证每次都调用工具。

## 验证与部署状态

真实 `/v1` 验收通过了两种首轮形式：非流式工具调用后接流式第二轮，以及流式工具调用后接流式第二轮。调用方执行 `sum_numbers(17, 25)` 并提交完整历史后，最终回答包含测试 codeword `BRIDGE_WORD_47` 和结果 `42`；返回包含真实上游 usage。已验证请求头等待、非流式完成和 SSE 输出阶段的客户端断连都会取消并等待清理、只关闭 job 一次并释放并发名额。流式首轮曾出现协议错误，已补充合法空工具增量兼容并复测通过；这不代表免费上游绝对稳定。

Notebook Relay 验收测试 85 项通过（24.85 秒），包含两条真实官方模型往返；`ruff check` 与 Node 语法检查通过。

2026-10-19 已部署到笔记本 `/opt/notebook-relay`，由独立的 `notebook-relay` 系统账号运行，服务名为 `notebook-relay.service`，已启用开机启动。部署模板见 [systemd unit](deploy/notebook-relay.service) 与[启动脚本](deploy/start.sh)。入口凭据保存在 systemd 的主机加密凭据仓库中，启动时解密到运行时凭据目录。

笔记本通过 83 项 Ubuntu 本地回归测试（两个另行执行的真实上游测试跳过），运行中服务的真实两轮流式工具往返及重启恢复检查通过。本次公网运行时 Relay 服务组占用约 220.4 MiB，峰值约 387.6 MiB；VPS FRPC 约 13.2 MiB RSS，笔记本 FRPC 服务组约 6.2 MiB。未做 15 路真实上游并发测试。

个人公网入口已部署为 `https://mona-ai.cn/personal/v1`。公网直连的 API Base 包含 `/v1`；Relay access Key 填密钥原文，请求使用 Bearer 鉴权，但不要把 `Bearer ` 前缀写进 Key。`GET /personal/v1/models` 已验证有效 Key 返回 `200`，缺少或错误 Key 返回 `401`。

请求经过 Nginx、VPS 本地 `127.0.0.1:18800` 的 STCP visitor，再到笔记本 `127.0.0.1:8800`。笔记本 FRPC 使用 WSS、系统 CA 和 `mona-ai.cn` 主机名校验公网证书；新建的两端 `notebook-relay-tunnel.service` 已启动并启用开机启动。现有 FRPS 未修改或重启。新增 `/personal/v1/` location 与既有付费 `/v1` 路由分开；个人入口直接访问 Relay，不经过官网账本。

公网真实两轮 SSE 工具往返通过：首轮返回工具调用，调用方执行 `sum_numbers(17, 25)` 并提交完整历史后，第二轮返回 `PUBLIC_RELAY_47: 42`；两轮 `DONE` 正常，usage 分别为 3,622 和 3,645 tokens。`/health` 与 `/admin/` 返回 `200`；原有付费 `/v1/models` 无 Key 仍返回 `401`。本轮 Nginx `nginx -t` 通过，两端隧道服务为 active、enabled 且未重启。

OneAPI 未添加或修改个人渠道。如后续手动配置 OpenAI 兼容渠道，其 API Base 填 `https://mona-ai.cn/personal`（不带 `/v1`），Key 填 Relay access Key 原文；该渠道不会自动添加。按需由运营方手动添加 OneAPI 个人渠道是当前后续事项。

保留的 `local`、`groq`、`openrouter_free` 是其他可选兼容模式；
若相应上游要求鉴权，可通过 `NOTEBOOK_RELAY_UPSTREAM_API_KEY` 提供密钥。
这些模式不替代本项目当前的 OpenCode 官方免费 DeepSeek 目标。
