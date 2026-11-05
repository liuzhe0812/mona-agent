# 在线 Work 独立发布

2026-11-05 当前线上为 Ubuntu v10：`/home/liuzhe/mona-hosted-work/releases/20261105-skills-ui-v10/content`，PID `34615`，备份 `/home/liuzhe/mona-hosted-work/backups/20261105-skills-ui-v10`。归档 `output/hosted-work/skills-ui-20261105-v1/work-skills-ui-v10.tar.gz` 有 5,185 个清单文件、105,590,706 字节，SHA256 `9acadecb959bc9ab562c382f5f35d0a59d3eef1fc33d8d030f0ecc529c9173c4`。v10 只调整 executor 的 Widget 事件白名单及对应测试，前端、Skill 和 Office 与 v9 一致；VPS 静态与代理沿用 v9。

网页移除欢迎右块、猫形提示词入口和左下退出按钮，桌面保留。v9 打包 13 套内置 Skill、761 个资源，接入发现、按需读取、引用、真实样张、素材复制和隔离脚本，不加载私有/专家/用户配置、ContextBuilder 或 memory(always)。网页工具目前支持 Word、Excel、PPT、画布、设计、PRD、visualizer 7 套；PDF、生图、视频、记忆、长期目标及 Skill 私有安装缺对应工具服务，不能称 13 套全部可执行。设计目前只支持参考和 Office，浏览器自动操作尚未接入。高级脚本要求 Python >=3.13，实时公开 runtime catalog 仅登记 Windows 基座，Linux 依赖缺失时明确返回 `runtime_unavailable`，不回退宿主。

标准库案例检索已在真实 gVisor 执行，素材 SHA 一致、容器精确清理。Widget 复用原 `show_widget`、MonaClient 事件和隔离 iframe，公开 bootstrap 不含用户代码或凭据；主页面 CSP 未放宽，sandbox 无 same-origin，真实本地浏览器计数器交互和拒绝访问父 DOM 均已验证。Linux 关联测试 16 项、Windows UI 7 项、Widget 6 项、后端路由 28 项通过（另 1 项跳过），DI 6 项、Wire 3 项、类型检查与独立构建通过；Office 465 个产物与 v8 一致，未重新构建或修改。

公网真实 Qwen 验收 `output/hosted-work/skills-ui-20261105-v1/production-v2.json` 的 `passed=true`：真实 Skill 发现、读取与引用，Widget 计数器 0→1、刷新后仍可交互且无额外模型帧，素材复制交付的 SHA256 `3f1f1a39a6564577a1781c3b458552aa723bd82b8d9cd05d3d03469c6d68ade1`，另一账号 404、退出后 401 和返回登录均通过；测试令牌撤销，钱包余额与版本保持 0，页面异常和 HTTP 失败均为 0。仅有两条新模型消息。

v9 首次 Widget 被父进程白名单拒绝的失败记录保留；相关自有任务核实容器/进程结束后离线结束追踪，状态 `interrupted`、结果仍未知且未重派。v10 仅将 Widget 加入白名单，未知事件仍拒绝，新增 4 项 executor 回归在 Windows 和 Linux 均通过。最终无活动或 unknown 任务、未确认文件操作或额外 Work 容器；Docker、原 8 容器、Work 隧道及 VPS 原服务保持，其他站点配置未变，3,890 个静态文件再次验 SHA 通过。v9 切换前 12 会话/18 任务/5 文件与备份一致，验收后为 14/22/6。提交 `d6d26b421`、`f6be94e49`、`9c0e81b03`、`8671ffbf1`。

## 2026-11-05 v8 验收（历史）

当时共享界面由 v5 经 v6、v7 切换至 Ubuntu v8，release 为 `/home/liuzhe/mona-hosted-work/releases/20261105-shared-work-v8/content`，PID `4147521`、NRestarts=0。归档 `output/hosted-work/shared-release-20261104/work-shared-v8.tar.gz` 有 4,118 个清单文件、44,110,794 字节，SHA256 `77b066dfbb893449b55cbb9316f578038e3bb7ad46a42aac05e6b1ce39300467`；切换备份为 `/home/liuzhe/mona-hosted-work/backups/20261105-shared-work-v8`，原配置、状态和 Key 保留。v8 仅修改 Hosted Office 对重复且同值的顶层 `mode` 的兼容、工具说明及对应 1 项回归，前端产物与 v7 逐字节一致；此前 v6 未切换与管理网络中断是 2026-11-04 的历史状态。

v8 的 Qwen 共享工作台发布验收已完成：真实生产验收 `output/hosted-work/shared-release-20261104/production-v8-final-20261105.json` 的 `passed=true`，覆盖 Excel 实际读取 `[6,7,42]`、公式导出及刷新后重读，PPT 模型编辑及导出 XML，思维导图保存恢复，执行中停止、另一账号 404 和退出后 401。三条消息为 Excel、PPT 和停止任务，基础文件复用既有 run。Mona 人设、任务收尾与 Word 人工和 AI 编辑、保存、导出、恢复采用 `production-v6-static-20261105.json` 的真实通过结果，相关 Word 产物此后未改；当时未重测密码登录或桌面成品。

最终验收无页面异常、HTTP 失败和请求传输失败；控制台有 16 条 Univer 隐藏布局宽度日志，内容、导出和恢复均通过。测试令牌已撤销，测试钱包余额及版本保持 0。v7 的 Sheets 14 项、CSP 1 项、Office 类型检查和构建通过，v8 另通过 1 项 Office 兼容回归；云同步、付费 Codex 和微信网站登录仍未开放。

## 部署说明

本目录仅提供人工审核的部署材料，不会被桌面端自动使用、安装或启动。
完整边界、验证命令和上线准入见 `docs/architecture/hosted-work.md`。

2026-11-01 最新需求：Qwen 免费且不限制个人账号；Codex 使用平台专用账号，按官方 Token 单价扣网站与客户端共用余额。当前发布包仍只接入认证，计费尚未实现；不得先将 Codex 加入公开模型表冒充收费完成。Ubuntu 连接与登录步骤见 `docs/guides/hosted-work-two-providers.md`，专用目录初始化及登录辅助入口为 `codex-login.sh`。

- `config.example.json` 默认关闭、没有开放模型，也不包含凭据或假定可用的镜像。
- `Dockerfile` 仅构建工具沙箱，不包含 Mona、模型凭据、Docker socket 或用户数据。必须由运维提供已经核验的 Python 3.11+ Linux 基础镜像 digest；容器运行时禁止自动拉取。
- `mona-hosted-work.service.example` 是独立 systemd 单元示例，不是安装脚本。服务账号对 Docker 的访问属于高权限控制面，不能授予网站用户，也不能在工具容器内挂载该 socket。
- 现有 Ubuntu 文档记录使用 Snap Docker 且承载其他 Worker。不要为了本功能迁移 Docker、停止或清理其容器。先核实 gVisor 和隔离环境兼容性；缺失时本服务拒绝启动，不降级。

前端在独立、已核对源码的 `webui/` 执行 `npm run build:hosted`，同时构建工作台和原 Office 的三个入口，产物为 `webui/dist-hosted-work/`。随后在仓库根目录运行 `python deploy/hosted-work/build-release.py --output output/hosted-work/work-release.tar.gz`，得到独立、带哈希清单的发布包，包含 Office 空白模板，不包含 Auth 源码、配置凭据或用户状态。安装到一个新的 releases 子目录，测试通过后仅切换自己的 systemd 单元；保留旧版本供回退。

Ubuntu 表格还需要对应 Linux 架构的完整 Office 资源，不能使用 Windows `.exe`。`MONA_RESOURCES_DIR` 指向含 `office-editor/templates/`、Linux `manifest.json` 和 `sheets/xlsx-sidecar` 的已验证资源根。该程序只在 gVisor 内运行；表格容器的 `/workspace` 明确为 exec，`/tmp` 仍为 noexec，其余运行时、网络、挂载和资源限制保持。不对普通 Work 容器放宽此项。

服务通过 frontend_dir 自己提供 `/work/` 和 assets，API 为 `/api/work/`；登录及退出经 `/api/work/auth/` 代理到认证服务的 `/auth/web/login` 和 `/auth/web/logout`，当前受保护请求只调用 `/auth/identity`。无需官网路由读取任何 Work 数据；后续收费适配复用原钱包，但不放开既有 /v1 设备鉴权，不改变充值、支付、设备或同步路由。新版本必须在依赖接口上线后才能切换。

公网主页面 `/work/` 和 `/api/work/` 经 Work 专用隧道转发到 Ubuntu `172.31.3.176:17175`；Work 的 `assets`、`office-editor` 等静态前缀由 VPS 的独立 release 直供，按账号隔离的工作数据和 API 仍在 Ubuntu；账号认证继续使用 VPS Auth。公网需 TLS、请求限流、上传上限和超时；不要更改现有其他转发规则。前端同源，不开放跨站 CORS，不将账号令牌放 URL。独立服务发送 CSP，附件统一下载而不执行 HTML。`/healthz` 仅代表进程存活，models_configured=false 时不应宣传可执行任务。

`nginx-work-limits.conf.example` 放在 Nginx 的 http 配置中，`nginx-work.conf.example` 的 location 放在现有 HTTPS server 中；它们只作用于 Work。2026-11-03 已部署该配置，公网 origin 为 `https://mona-ai.cn`，内部目标仍为原私网接口。切换前备份原配置，`nginx -t` 通过后仅热加载；旧 worker 退出需要短暂时间，重复检查必须取得 JSON 401 等真实 Work 响应，不能将 SPA HTML 当作 API 成功。

大文件直供可参考 `nginx-work-static.conf.example`：从已验清单的 `webui/dist-hosted-work/` 只发布公共静态产物到新的 VPS release，逐项核对摘要并与 Ubuntu 的工作台版本配对；不复制服务源码、凭据或用户状态。当前静态目录 `/var/www/mona/work-releases/20261105-skills-ui-v9/content` 有 3,890 个文件，代理配置 `/opt/mona-work-proxy-releases/20261105-skills-ui-v9/work-locations.conf` 的 SHA256 为 `d54849cc56009a2a50f18fcd4cbc4f353984d5a1e277d478fca9477eb8190394`，备份在 `/var/www/mona/backups/skills-ui-20261105-v9`。本轮 Nginx 仅热加载，master PID `420299` 不变。

v8 验收时复核原 8 个容器的 ID、状态与启动时间不变，没有额外 Work 容器；Docker PID `78383`、隧道 PID `423172` 和其他服务 PID/启动时间均保持，其他站点配置与官网 root 未改。v8 切换前的 9 个会话、14 条任务、5 条文件字段与备份一致，当时验收后为 11、18、5，无运行中、取消中或 unknown 任务，也无未知文件操作；当时的自有候选单元已停止、状态保留。

2026-11-03 的基础工作台发布与验收摘要在 `public-release-20261103.json`，只记录公开端点、凭据变量名称和非敏感摘要，不包含密钥或网站会话。当时免费 Qwen 已通过真实任务、下载、停止及隔离验收；当前 v10 联合验收以本文开头状态为准。Codex 收费和无人登录的整机重启恢复仍未验收。

2026-11-03 基础工作台的真实生产浏览器验收入口为 `production-browser-check.mjs --url https://mona-ai.cn/work/ --output output/hosted-work/<新目录>`；共享组件联合验收入口为 `shared-browser-check.py --output output/hosted-work/<新目录>`。用 stdin JSON 传入两枚既有专用测试账号的短期网站会话 `{token, other_token}`，不放参数或磁盘；脚本不会模拟接口。输出目录不得已存在，结果中的失败或待核对状态不得改写成成功。操作前先核对没有待处理的旧任务，并在测试后确认自己的会话已撤销、容器已清理。

Auth 官网账号功能需要兼容迁移、网页会话和通用身份接口；当前 Work 未引入模型授权或节点密钥。收费新增信任边界需独立审阅，不能直接恢复历史模型令牌例外。禁止将当前 Auth 仓库中的其他任务改动一并发布；生产候选应基于实际运行版本构建并按上线手册验证。

平台模型 API 在独立 models 配置中填写 source=mona、api_base、api_key_env 和 model；api_key_env 必须使用 `MONA_WORK_MODEL_` 前缀，真实值放独立的受限平台环境文件，不能使用旧业务 /v1 账户网关。Qwen 不扣用户余额。原生 Codex/WorkBuddy 使用平台专用 native_config_path 和认证目录；收费必须由可信服务端按真实回执结算，模型标签本身不能实现收费。网页用户只能选择平台开放项，不能修改端点和凭据。

只启动自己的用户级服务，无需再次安装 gVisor；不得重复运行历史 install/fix 脚本。没有模型时可启动待配置服务供健康和页面验收，但不会接受模型任务，也不能自动借用现有业务账户/额度。

`tunnel.py` 是独立 Work 的 FRP provider/visitor 启动器，使用现有 FRP 客户端，经官网 WSS 并显式校验证书；访客端只监听 VPS 本机 18801。认证材料分别从 Ubuntu 用户密钥环和 VPS systemd 加密凭据读取，配置只存于匿名内存文件。两个 service 示例仅供审核运维使用，不修改或重启现有 Relay。用户密钥环在当前会话可用，但机器重启后能否自动解锁尚未验证，不能据此宣称隧道可无人值守恢复。
