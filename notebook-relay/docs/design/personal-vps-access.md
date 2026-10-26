# 个人公网入口部署状态

2026-10-19 已将个人 Relay 入口部署到 VPS。笔记本服务仍只监听 `127.0.0.1:8800`，公网流量经 VPS 转发，不直接开放笔记本端口。

公网 API Base 为 `https://mona-ai.cn/personal/v1`；后台 OpenAI 兼容渠道的 API Base 如需手动配置，应为 `https://mona-ai.cn/personal`，不带 `/v1`。Key 是 Relay access Key：填原文，不要在 Key 前手动加 `Bearer `。公网 `GET /personal/v1/models` 已验证有效 Key 返回 `200`，无 Key 或错误 Key 返回 `401`。

个人入口由 Nginx 转发至 VPS 本机 `127.0.0.1:18800` 的 STCP visitor，再经笔记本 STCP provider 到达 Relay。个人请求直接由 Relay 处理，不经过官网账本；新增的 `/personal/v1/` location 与现有付费 `/v1` 路由分开，既有付费路由保留。

两端 `notebook-relay-tunnel.service` 已启动并启用开机启动。笔记本 FRPC 通过 WSS 连接 HTTPS 入口，使用系统 CA 验证证书链并按 `mona-ai.cn` 校验主机名；VPS visitor 只通过本机 loopback 连接 FRPS。两端程序为 `/opt/notebook-relay/runtime/frpc`，复用 VPS 原有 `/opt/frp/frpc` 的 FRPC 0.61.1（SHA-256：`0bb98b7a69ce8ee23bc60fec1664f22040a2d44032296e03c8b6573a5d28dd0b`）。现有 FRPS 未修改或重启，保持 `transport.tls.force = false`。

部署模板见 `deploy/frpc-notebook.toml`、`deploy/frpc-visitor.toml`、`deploy/notebook-relay-tunnel.service`、`deploy/nginx-personal.conf`。FRP 配置凭据通过 systemd 加密凭据提供，没有明文 Key 文件。活动 Nginx 配置 `/etc/nginx/conf.d/mona-ai-cn.conf` 已备份到 `/etc/nginx/backups/mona-ai-cn.conf.20261019T053250Z.notebook-relay.bak`，新增 location 校验后已平滑 reload。OneAPI 未添加或修改个人渠道；如需启用，必须手动创建 OpenAI 兼容渠道。

公网 `GET /personal/v1/models` 使用有效 Key 返回 `200`，无 Key 或错误 Key 返回 `401`。两轮 SSE 工具往返通过：首轮返回工具调用，调用方执行 `sum_numbers(17, 25)` 并提交完整历史后，第二轮返回 `PUBLIC_RELAY_47: 42`；两轮 `DONE` 正常，usage 分别为 3,622 和 3,645 tokens。`/health`、`/admin/` 返回 `200`，原有付费 `/v1/models` 无 Key 仍为 `401`；本轮 Nginx `nginx -t` 通过。

本次公网运行时 Relay 服务组占用约 220.4 MiB，峰值约 387.6 MiB；VPS FRPC 约 13.2 MiB RSS，笔记本 FRPC 服务组约 6.2 MiB。两端隧道服务均为 active、enabled 且未重启。当前待办仅为按需手动添加 OneAPI 个人渠道；OneAPI 未自动添加或修改。

回滚：恢复上述 Nginx 配置并校验、reload，停止两端新增隧道服务。笔记本的 loopback 原生模型服务可继续保留。

依据：FRP [固定版本 WSS connector](https://github.com/fatedier/frp/blob/v0.61.1/client/connector.go)、[TLS 校验](https://github.com/fatedier/frp/blob/v0.61.1/pkg/transport/tls.go)、[STCP 配置](https://github.com/fatedier/frp/blob/v0.61.1/README.md#expose-your-service-privately)。
