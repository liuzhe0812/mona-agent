# 在线 Work 独立发布

本目录仅提供人工审核的部署材料，不会被桌面端自动使用、安装或启动。
完整边界、验证命令和上线准入见 `docs/architecture/hosted-work.md`。

2026-11-01 最新需求：Qwen 免费且不限制个人账号；Codex 使用平台专用账号，按官方 Token 单价扣网站与客户端共用余额。当前发布包仍只接入认证，计费尚未实现；不得先将 Codex 加入公开模型表冒充收费完成。Ubuntu 连接与登录步骤见 `docs/guides/hosted-work-two-providers.md`，专用目录初始化及登录辅助入口为 `codex-login.sh`。

- `config.example.json` 默认关闭、没有开放模型，也不包含凭据或假定可用的镜像。
- `Dockerfile` 仅构建工具沙箱，不包含 Mona、模型凭据、Docker socket 或用户数据。必须由运维提供已经核验的 Python 3.11+ Linux 基础镜像 digest；容器运行时禁止自动拉取。
- `mona-hosted-work.service.example` 是独立 systemd 单元示例，不是安装脚本。服务账号对 Docker 的访问属于高权限控制面，不能授予网站用户，也不能在工具容器内挂载该 socket。
- 现有 Ubuntu 文档记录使用 Snap Docker 且承载其他 Worker。不要为了本功能迁移 Docker、停止或清理其容器。先核实 gVisor 和隔离环境兼容性；缺失时本服务拒绝启动，不降级。

前端在 `webui/` 执行 `node node_modules/vite/bin/vite.js build --config vite.hosted.config.ts`，产物为 `webui/dist-hosted-work/`。随后在仓库根目录运行 `python deploy/hosted-work/build-release.py --output output/hosted-work/work-release.tar.gz`，得到独立、带哈希清单的发布包，不包含桌面前端、Auth 源码或任何配置凭据。安装到一个新的 releases 子目录，测试通过后仅切换自己的 systemd 单元；保留旧版本供回退。

服务通过 frontend_dir 自己提供 `/work/` 和 assets，API 为 `/api/work/`；登录及退出经 `/api/work/auth/` 代理到认证服务的 `/auth/web/login` 和 `/auth/web/logout`，当前受保护请求只调用 `/auth/identity`。无需官网路由读取任何 Work 数据；后续收费适配复用原钱包，但不放开既有 /v1 设备鉴权，不改变充值、支付、设备或同步路由。新版本必须在依赖接口上线后才能切换。

反向通道只将 `/work/`、`/api/work/` 转发到 Ubuntu `127.0.0.1:17175`。公网需 TLS、请求限流、上传上限和超时；不要更改现有其他转发规则。前端同源，不开放跨站 CORS，不将账号令牌放 URL。独立服务发送 CSP，附件统一下载而不执行 HTML。`/healthz` 仅代表进程存活，models_configured=false 时不应宣传可执行任务。

`nginx-work-limits.conf.example` 放在 Nginx 的 http 配置中，`nginx-work.conf.example` 的 location 放在现有 HTTPS server 中；它们只作用于 Work。2026-11-03 已部署该配置，公网 origin 为 `https://mona-ai.cn`，内部目标仍为原私网接口。切换前备份原配置，`nginx -t` 通过后仅热加载；旧 worker 退出需要短暂时间，重复检查必须取得 JSON 401 等真实 Work 响应，不能将 SPA HTML 当作 API 成功。

本次实际发布与验收摘要在 `public-release-20261103.json`，只记录公开端点、凭据变量名称和非敏感摘要，不包含密钥或网站会话。官网免费 Qwen 已通过真实任务、下载、停止及隔离验收；Codex 收费和无人登录的整机重启恢复仍未验收。

真实生产浏览器验收入口为 `production-browser-check.mjs --url https://mona-ai.cn/work/ --output output/hosted-work/<新目录>`。用 stdin JSON 传入两枚既有专用测试账号的短期网站会话 `{token, other_token}`，不放参数或磁盘；脚本不会模拟接口。验收范围包括官网菜单与共享会话、真实模型/工具、上传下载摘要、刷新不重派、停止、账号隔离和退出撤销；未覆盖密码登录。输出目录不得已存在，结果中的失败或待核对状态不得改写成成功。操作前先核对没有待处理的旧任务，并在测试后确认自己的会话已撤销、容器已清理。

Auth 官网账号功能需要兼容迁移、网页会话和通用身份接口；当前 Work 未引入模型授权或节点密钥。收费新增信任边界需独立审阅，不能直接恢复历史模型令牌例外。禁止将当前 Auth 仓库中的其他任务改动一并发布；生产候选应基于实际运行版本构建并按上线手册验证。

平台模型 API 在独立 models 配置中填写 source=mona、api_base、api_key_env 和 model；api_key_env 必须使用 `MONA_WORK_MODEL_` 前缀，真实值放独立的受限平台环境文件，不能使用旧业务 /v1 账户网关。Qwen 不扣用户余额。原生 Codex/WorkBuddy 使用平台专用 native_config_path 和认证目录；收费必须由可信服务端按真实回执结算，模型标签本身不能实现收费。网页用户只能选择平台开放项，不能修改端点和凭据。

只启动自己的用户级服务，无需再次安装 gVisor；不得重复运行历史 install/fix 脚本。没有模型时可启动待配置服务供健康和页面验收，但不会接受模型任务，也不能自动借用现有业务账户/额度。

`tunnel.py` 是独立 Work 的 FRP provider/visitor 启动器，使用现有 FRP 客户端，经官网 WSS 并显式校验证书；访客端只监听 VPS 本机 18801。认证材料分别从 Ubuntu 用户密钥环和 VPS systemd 加密凭据读取，配置只存于匿名内存文件。两个 service 示例仅供审核运维使用，不修改或重启现有 Relay。用户密钥环在当前会话可用，但机器重启后能否自动解锁尚未验证，不能据此宣称隧道可无人值守恢复。
