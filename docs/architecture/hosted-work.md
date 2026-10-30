# Mona 官网基本 Work：独立在线宿主

日期：2026-10-29。最新决策：除用户认证外，与现有业务完全解耦。Ubuntu/gVisor 已通过实机隔离验收；独立模型配置、认证接口生产发布和官网接入分别验收，不将存活状态等同于已开放任务服务。默认示例关闭，桌面更新不会启动在线服务。

## 1. 范围与运行方式

官网仅提供基本 Work：账号登录、会话、平台模型选择、文本与附件输入、执行进度、停止和文件交付。不开通开发、运维、邮件、笔记、桌面操作或其他模块；用户不能提交 API Key、自定义端点、原生引擎目录、宿主命令或身份字段。

调用链：浏览器 `/work/` 与 `/api/work/` → 独立反向通道 → Ubuntu `127.0.0.1:17175` → 独立可信执行宿主 → 用户 gVisor 工具沙箱。在线服务自己提供网页与 API；官网只需增加入口与目标转发，无需嵌入原业务进程。唯一业务依赖是现有用户认证，不访问其余额、Pro、设备、同步、支付或后台任务接口。

模型调用留在可信宿主，使用在线 Work 自己的运营凭据，不接收用户账号令牌，也不把模型密钥放进用户脚本环境。工具请求只能回到固定工具表，公共网页读取经过受控 HTTP 入口。每账号身份只从 Auth 的只读 `/auth/identity` 返回值派生，不接受前端指定 user_id；模型授权不再经过 Auth。

每轮使用独立 Python 宿主和用户容器；可信控制面并非运行在不可信容器里。同一账号任务及文件操作串行。工作区快照、会话和 runtime 数据按账号隔离；同一账号不同会话共用其工作区。平台同一原生账号配置串行，未知结果保留占用，不在另一用户处重用未知执行。

复用现有 AgentRunner、工具协议、检查点和流式钩子，不启动完整桌面 AgentLoop 的模块发现。固定工具只有 list_dir、read_file、write_file、exec、web_fetch、deliver_file。这是一版受限 Work 宿主，不宣称已迁移完整桌面 Skills、长期记忆、Office 实时编辑或浏览器自动化；镜像中未安装的工具不能冒充可用。

## 2. 桌面兼容边界

桌面入口、Gateway/Services、工具授权、原生账号及既有数据目录不变。新增配置只有显式启动在线宿主才使用，桌面不自动生成用户容器。

共用的只是通用 AgentRunner、Provider 和工具协议代码，不共用业务状态。HostedWorkConfig 虽定义在统一 schema 中，但不挂入桌面 Config，不会进入桌面设置保存和同步。NativeWorkProvider 的 native_home 是显式可选参数，未指定时保留桌面原行为。在线网页有独立 HTML、Vite 配置、缓存和输出，发布时固定通用源码版本。桌面或在线服务任一侧升级，不要求另一侧同时升级。

## 3. 沙箱与存储

仅支持已配置 Docker + gVisor runsc 的 Ubuntu/Linux。镜像必须是明确 SHA-256 image ID 或仓库 digest。启动先检查运行时和镜像，禁止自动 pull、降级 runc 或回退宿主 shell。

容器非 root、只读根文件系统、无附加 capabilities、no-new-privileges，并限制 PID、CPU、内存。不得挂载宿主目录、平台配置、认证目录或 Docker socket。用户只可写 /workspace 和私有 /tmp，系统程序和运行库按需只读。默认工作区 64MiB、单文件 10MiB、单条命令 120 秒、任务 900 秒、全局并发 2，均由服务端配置。

脚本容器使用 network=none，既不能访问私网，也不能直接请求公网或安装网络依赖。公共网页由 web_fetch 读取：只允许 HTTP(S) 标准端口、拒绝 URL 凭据、每跳验证、连接解析器拒绝非公网 DNS 结果、禁用环境代理与 Cookie。回环、私网、链路本地、双栈及 IPv4 映射 IPv6 等边界必须测试。该入口不提供任意网络写操作。

工作区使用有界 tmpfs。保存前停止残留用户进程，在容器中生成只包含普通文件/目录的有界 ZIP；宿主只保存不透明字节，不在宿主解压。下一轮在新容器中恢复。链接、特殊文件、过多文件或保存失败不能标为成功；保存失败保留旧快照。

上传、下载和交付核对账号、会话、精确文件身份与内容摘要。交付必须在工作区保存后重新校验。旧文件被后续任务修改时，旧下载记录拒绝返回错误版本，需要重新交付。上传文件先有安全保存结果再写入公开文件记录。

## 4. 平台模型与账号

平台配置 hosted_work.models；客户端只接收模型 ID、显示名、来源。运行配置在派发时冻结并通过 stdin 传递，账号令牌不进入命令行、数据库、工具结果或持久日志。

认证：在线服务的 `/api/work/auth/login` 和 `/api/work/auth/logout` 分别代理 `/auth/web/login` 和 `/auth/web/logout`，不创建第二套账号。每次受保护请求调用 `/auth/identity` 验证真实用户及撤销；该接口只返回 account_id，不返回余额/订阅/设备信息。官网账号需要相应的 Auth 迁移和网页会话；Work 不引入业务状态、专用数据库迁移或节点密钥。认证接口必须先于新 Work 版本上线。

Mona API：平台在独立配置中填写 api_base，并通过名称以 `MONA_WORK_MODEL_` 开头的环境变量提供运营 API Key。凭据缺失直接拒绝，不读取桌面 API Key、用户余额或旧 model-token。默认禁止把账号服务旧 `/v1` 网关重新配置为在线模型入口；可连接有独立配额/凭据的推理服务。模型接口费用若由上游收取，属于在线服务自己的运营成本，不扣用户原有 Mona 业务钱包。本轮未另造收费系统。

已撤销上一版 `/internal/hosted-work/model-token`、节点密钥与模型鉴权例外。原业务 config/deps 恢复至本任务开始前快照，保留其他任务所有既有修改。

Codex/GPT 与 WorkBuddy：复用 NativeWorkProvider，WorkBuddy 内部 ExecutorId 仍为 codebuddy。平台提供专用、已认证的受管原生目录和配置，不能使用用户工作区或把整个宿主 HOME 暴露给容器。原生内置文件/命令/MCP 工具保持禁用，只允许 Mona 工具回调；原生认证根与用户 runtime 数据分离。

原生 SDK/CLI、Ubuntu 登录方式、工具封锁、实际用量和授权条款仍需单独核验。没有调用真实收费引擎，也没有实现原生个人订阅额度转售或新收费方案。默认模型表为空，由运营配置获准来源后才开放。接入适配不等于已证明个人订阅可向公众共享。

每次模型迭代和工具执行前重新核对账号身份；撤销后拒绝新的操作，已开始的外部模型调用不能被宣称已经撤销。

## 5. 连续性、停止与人工核对

发送、创建会话、上传均使用稳定请求 ID。相同 ID 相同内容只观察原结果，不重复执行；换内容拒绝。刷新、断线和关闭浏览器只影响观察，不重新派发任务，也不自动停止服务端执行。

进度是持久、有序、有界事件，通过游标按需读取，文字逐段呈现。任务在工作区保存和容器结束确认后才报告完成，模型说“完成”不是状态依据。停止精确作用于原执行，等待原生 Provider 和沙箱清理。

响应丢失、进程退出但没有有效终态、清理结果不明时记录 unknown，并阻止后续执行。重启把原 running/cancelling 标为 unknown，不从头运行。未知文件操作同样持久化并保留资源占用。网页显示可采取的核对动作，不静默重试。

离线运维入口：`python -m mona.hosted_work.reconcile --config <配置文件>`，默认仅列出未知记录。改变状态必须先停止本在线服务及其拥有的原生进程，核对工作区结果，再提供精确 owner/kind/id、说明和 `--apply --confirm-executors-stopped --acknowledge-unknown-result`。

核对工具要求服务锁、用户执行锁空闲，并成功确认原容器不存在。它不删除其他进程、不重新执行任何请求。处理后保留审计，语义是“跟踪结束、原结果仍未知”，不会改为成功。没有公网解锁接口，禁止直接删除数据库行绕过核对。

## 6. 文件与部署入口

- `mona/hosted_work/`：在线 API、会话状态、可信执行宿主、模型/工具适配、沙箱、人工核对。
- `mona/config/schema.py`：唯一显式配置定义。
- `webui/src/hosted-work/`、`webui/hosted-work.html`、`webui/vite.hosted.config.ts`：独立网页。
- `deploy/hosted-work/`：默认关闭的配置样例、工具镜像 Dockerfile、人工审核的 systemd 材料。
- `tests/hosted_work/`：协议与真实 AgentRunner 回归、显式 opt-in 的 Ubuntu 隔离验收。
- `mona-auth/app/routers/identity_router.py`：认证侧的通用只读身份接口。官网账号的完整认证变更见 `website-accounts.md`；生产候选必须基于当前线上源码构建，不发布其他任务未提交的 Auth 源码。

通过 frontend_dir 指定独立发布包内网页目录；服务自己提供 `/work/`、受限 assets 与 CSP。`/healthz` 只说明进程存活，并明确 models_configured；不证明认证/推理已联通。允许模型表为空的待配置服务启动，但无法提交模型任务。公网只转发 `/work/` 与 `/api/work/`，无需更改原 `/auth`、`/v1`、支付或同步路由。禁止代理整个桌面 Gateway，不暴露 Docker/Tauri/引擎端口，不开放跨站 CORS。

现有 Snap Docker 的 gVisor 已通过管理员授权安装和路径修复。OEClaw 与 Qdrant 的 4 个容器继续运行，Mona 的 4 个 Worker 容器已按独立审计暂停。日常在线 Work 发布只切换自己的不可变 release 与用户级 systemd 服务，不再次运行安装脚本、不重启 Docker、不触碰原 Worker/Relay/数据库。共享的是宿主硬件和 Docker 基础设施，资源仍需限额；不是宣称物理机器完全隔离。

## 7. 验证命令与发布准入

Mona 根目录：

```text
.venv\Scripts\python.exe -m pytest tests/hosted_work tests/development/test_work_native.py tests/development/test_work_native_images.py -q -rs
.venv\Scripts\python.exe -m ruff check mona/hosted_work tests/hosted_work mona/config/schema.py mona/providers/native_work_provider.py
```

webui 目录：

```text
node node_modules/vitest/vitest.mjs run src/hosted-work --exclude .tmp-verify/** --maxWorkers 2 --minWorkers 1
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json --incremental false
node node_modules/vite/bin/vite.js build --config vite.hosted.config.ts
```

Auth 测试必须使用临时 cwd、临时 SQLite、随机测试 JWT secret、隔离 MONA_AUTH_* 环境运行 test_identity.py、test_desktop_sessions.py、test_account_token_revocation.py；不加载生产 .env，不混淆主仓库与 Auth tests 包。

真实 Linux 验收为 tests/hosted_work/test_linux_sandbox.py：只有显式设置 MONA_HOSTED_SANDBOX_SMOKE=1 和已存在的 MONA_HOSTED_SANDBOX_IMAGE 才执行。它核验非 root、宿主文件不可见、系统写入拒绝、IPv4/IPv6 网络拒绝、两用户工作区隔离、快照恢复和精确清理，不安装或 pull 软件。Windows 跳过必须报告，不能把参数构造测试称为操作系统隔离验证。

上线前仍需真实认证接口、在线服务自己的模型来源/运营配额、获准的 Codex/WorkBuddy Linux 工具封锁、官网转发及浏览器下载/停止联合验收；不得重新依赖原用户钱包扣费。另需确定磁盘总配额、备份、历史数据保留及容量压测。第一版满载明确拒绝，不提供无限排队或自动扩容，不能未经压测承诺公网用户容量。

## 8. 内网直接访问与浏览器验收（2026-10-30）

独立服务默认仍监听 loopback；运营可显式指定 bind_host 为单个私网接口，例如 172.31.3.176。禁止通配监听 0.0.0.0 / :: 和公网地址。public_origin 必须匹配实际浏览器入口；内网 HTTP 需要显式 allow_insecure_lan_http=true、固定私网 IP 和一致端口。该选项只适用于可信内网，HTTP 不提供链路加密；公网正式访问继续通过 HTTPS。账号上游仍使用 HTTPS，不能降低 TLS 校验。开放网页的入站接口不会给用户工具容器增加出站网络权限。

网页 HTML、JS、CSS、字体及 favicon 不依赖登录；它们不会因浏览器携带 Origin 而返回鉴权 JSON。静态资源仍限制目录和同源读取。业务 API 和登录动作继续按配置校验 Origin，所有请求检查 Host，不信任客户端伪造的 X-Forwarded-*；未登录业务请求仍为 401。根路径跳转到 /work/，favicon 为明确的空响应而非鉴权失败。

内网 HTTP 浏览器不是安全上下文：请求 ID 使用 getRandomValues 生成 128 位随机标识，不依赖 randomUUID；下载使用固定版本的 SHA-256 库核对内容，不跳过摘要校验。网页不要求浏览器关闭安全选项。

验收不得只检查 curl 返回 200。tests/hosted_work/test_web_access.py 覆盖模块脚本/样式携带 Origin、MIME、内网配置、Host/Origin 拒绝和业务鉴权。deploy/hosted-work/browser-check.mjs 用本机独立 Edge/Chromium 配置实际加载发布页面，检查网络错误、样式、脚本、布局及控制台；可在单独测试标签内拦截 API 验证登录、新建会话、附件、发送、下载校验及停止，但报告明确区分模拟接口流程和真实认证/推理，绝不把浏览器 fixture 部署到服务端或称为真实模型联调。
