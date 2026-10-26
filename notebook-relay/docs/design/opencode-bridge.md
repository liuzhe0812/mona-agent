# OpenCode 官方免费模型接入

状态：官方原生工具与上下文通道已通过真实 `/v1/chat/completions` 往返验证；
笔记本部署、真实工具回环与公网接入已完成。

本轮唯一目标是 OpenCode 官方免费模型 `deepseek-v4.1-flash-free`。
Groq、OpenRouter 和自建兼容上游仅为可选模式，不构成本目标的替代实现。

## 原生接入路径

- 固定使用官方 OpenCode CLI 2.0.32；启动时校验版本。服务启动一个长期运行的 `opencode serve --stdio`，不按请求新建 CLI，也不自动下载运行时。
- 每个 `/v1/chat/completions` 请求分配独立临时工作区与原生会话；每次请求都从调用方提交的完整 system、history 和工具结果重建上下文，不跨请求复用会话。
- 插件通过官方工具注册机制加入本请求的函数工具，并用执行 guard 禁止 OpenCode 在本机执行工具。函数工具只由 API 调用方执行。
- 官方请求按原生协议发送；不替换出站请求正文、不改官方身份头、不替换原生响应。插件通过 `http.response` 读取响应副本并送入本机 broker，再编码成兼容 API 回复。实现见 [插件](../../notebook_relay/opencode_plugin.mjs)、[broker](../../notebook_relay/opencode_bridge.py) 和 [codec](../../notebook_relay/opencode_codec.py)。
- 调用方收到工具调用后执行对应函数，再把完整历史、assistant 工具调用和 `role: "tool"` 结果提交下一次请求；下一次请求建立新的临时工作区与会话。
- 完成、超时或客户端断开后，依次中断并删除会话、清理 OpenCode location；服务退出时关闭长期进程并回收子进程。

## 配置与边界

- 原生通道由 `NOTEBOOK_RELAY_UPSTREAM_PROVIDER=opencode_native` 启用，模型白名单自动固定为 `deepseek-v4.1-flash-free`。可用 `NOTEBOOK_RELAY_OPENCODE_EXECUTABLE` 指定二进制，否则从 `PATH` 查找 `opencode`。
- 不需要用户的 OpenCode 账户 API Key；仅需安全注入 Relay 入口 `NOTEBOOK_RELAY_API_KEY`。Relay 不把入口 Key 传给上游，原生进程也不继承用户的环境凭据。
- Relay 默认只监听 `127.0.0.1:8800`，只允许 loopback 绑定。服务内部的插件控制接口也限制在 loopback，并使用运行时密钥。
- 原生进程使用临时工作目录、XDG 配置/缓存/状态目录及筛选后的环境，并设置 `OPENCODE_CONFIG_PROJECT_DISABLE=1` 禁用祖先项目配置发现。
- 精确检查 Windows `C:\ProgramData\opencode` 与 Linux `/etc/opencode`：路径须不存在，或是可读的空目录；若为非空目录、文件或不可读则拒绝启动。检查不读取配置内容，也不删除目录。
- 默认入口并发上限 16；达到上限返回 `429`，不重试、不换模型、不回退付费模型。180 秒为请求总超时，原生进程启动等待默认 30 秒；请求体上限 2 MiB，观测到的上游响应上限 16 MiB。
- 本机并发上限不代表官方免费服务的配额；本轮没有对官方上游施加 15 路并发压力。免费模型可用性、限流与协议行为由上游控制。

## API 支持范围

- 支持开头的 `system`、完整历史、纯文本、assistant reasoning、function 工具调用及带 `tool_call_id` 的 `role: "tool"` 结果。
- 支持 JSON 与 SSE 响应、真实上游 usage、`tool_choice=auto`，以及 `max_tokens`/`max_completion_tokens`、`temperature`、`top_p`、频率/存在惩罚、`seed`、`stop` 和 `reasoning_effort`。思考档位以运行中官方客户端 `/api/model` 的声明为准，未声明的档位返回 `400`。
- 仅支持自动工具选择；强制/禁用工具、多模态输入、`n>1`、`strict: true`、未知字段及互斥参数组合不支持，明确返回 `400`。

## 模型能力同步

- 原生 `/v1/models` 从官方客户端读取并返回上下文窗口及思考档位，不根据付费版 ID 或内部兜底预算猜测能力。
- 2026-10-20，官方 2.0.32 声明该免费模型窗口为 `200000` tokens、最大输出 `32000` tokens，思考档位为 `low`、`high`、`max`。Relay 明确将自身默认档位设为 `high`，未指定时实际注入该值；这不是官方目录声明的默认值。
- 官网现有“获取模型”流程只对精确匹配该模型 ID 且 `owned_by=notebook-relay` 的记录保存能力快照，使用现有 `AppConfig`，不更改价格版本。托管模型目录和 `/v1/models` 下发该快照，其他模型维持原有来源。
- 官方声明撤掉字段后，再次获取模型会清除旧快照。实际推理不依赖实时抓取公网目录；客户端仍按当前目录决定占用计算、压缩和思考滑条。

## 实测证据与后续

- 官方 2.0.32 的真实公开 `/v1` 往返通过：首轮非流式工具调用后接流式第二轮，以及首轮流式工具调用后接流式第二轮，两种流程均返回 HTTP 200。
- 两种流程都把 `sum_numbers(17, 25)` 交给调用方执行；调用方回传 `42` 和完整历史后，第二轮回答包含 `BRIDGE_WORD_47` 与结果 `42`，并返回 `[DONE]` 及真实上游 usage。冒号后的空白不属于协议要求。没有改写官方请求正文、身份头或响应，也没有 OpenCode 原生工具执行。
- TCP 断连覆盖原生请求等待头、非流式 completion 与 SSE 输出阶段：均取消并等待请求任务、只关闭 job 一次，并将入口并发计数释放。
- 曾有一次流式首轮协议错误；补充对官方合法空工具增量的兼容后复测通过。免费上游可能变化，不承诺绝对稳定。
- 先前公开 HTTP hook 直接替换请求正文的尝试返回 `403 FreeTierError`，只否定该旧路线；它与当前原生工具注册及响应副本观察路径不同，不通过伪造身份头或回退工具来修补旧路线。
- 本机 15 个 broker job/临时工作区并行分段回传隔离已验证；入口 15/16/17 并发闸门已验证，但未验证 15 个真实官方原生执行并发或免费上游吞吐。
- Notebook Relay 验收测试共 85 项通过（24.85 秒），包括两条真实公开模型往返；`ruff check` 与 Node 语法检查通过。
- 2026-10-19 已部署到笔记本 `/opt/notebook-relay`，独立账号与 systemd 服务运行，入口凭据使用主机加密的 systemd credentials。Ubuntu 本地回归 83 项通过、两个 opt-in 上游测试跳过；实际运行的服务另行完成流式工具调用、客户端计算 `42`、完整上下文回传与最终回答 `NOTEBOOK_LIVE_47:42`。重启后就绪检查通过，原有容器仍运行。
- 已接通个人专用 FRP 公网入口和 OneAPI 托管渠道。2026-10-20 能力同步上线后，经 OneAPI 正常路由分别以 `low`、`high`、`max` 请求，三档均返回 HTTP 200 与真实 usage；名称、价格及其他模型未改变。
