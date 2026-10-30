# 官网账户与在线 Work 身份共享

更新：2026-10-30。状态：本地账号前后端和兼容候选已准备，未切换线上服务。旧候选存在网站令牌可管理设备或走旧模型过渡通道的问题，已在新版本地候选修复；VPS 暂存的仍是旧候选，不得上线。生产备份/发布前检查此前遭执行平台安全拦截；不能把候选目录存在当成发布成功。

## 目标边界

官网和客户端共用原有 Mona Auth 的 users，不创建第二套用户库。在线 Work 只消费认证能力：账号身份、网页登录和退出。会话、附件、运行数据、模型凭据、并发额度仍归 Work 独立管理；不读取桌面项目或钱包，不连接现有计费/订阅/同步接口。

官网提供 `/account` 与 `/account/wechat`，首页导航增加登录/注册入口。未登录时可邮箱注册、密码登录、找回密码；微信入口必须由配置能力返回真实启用状态，未配置时禁用且说明，不能显示假二维码。首次微信授权后必须完成邮箱验证；绑定已有账号还必须校验该账号原密码，不通过同名昵称或相同未验证邮箱自动合并账号。后续扫码使用已绑定身份。

登录后可编辑昵称和账号名。更换邮箱须当前密码及新邮箱验证码。通过邮箱重设密码会撤销原账户凭据及设备会话。退出只撤销当前网页登录，不使其他正常设备退出。页面仅在服务器确认退出或确认令牌已失效后清除登录状态，连接失败时不会误报已退出。

## 身份、存储和安全

新增五张认证表：website_profiles、website_sessions、website_email_codes、website_wechat_attempts、website_wechat_identities。账户 ID、原 users/订阅/余额表不迁移到其他系统。新增账号沿用原注册策略创建用户及其初始业务记录；这不代表 Work 可消费原业务钱包。

网页登录令牌仍为 account scope，额外带 wsid 和 credential_version。get_current_user 在存在 wsid 时检查具体会话归属、有效期和撤销；普通旧账号/桌面令牌不因网页退出而被撤销。网站令牌不能管理新旧桌面设备，也不能利用旧模型访问过渡通道签发模型令牌；历史 account 和桌面令牌维持原行为。个人页面只允许当前网页登录修改自己的资料，不接受 user_id、is_admin 等字段。

邮箱验证码使用密码学随机数，只保存 HMAC，不保存明文；校验绑定邮箱、用途、挑战 ID 和账号/微信会话上下文，10 分钟有效、一次性使用，5 次失败锁定。发送有每邮箱冷却及小时上限，接口也有限流。SMTP 失败使本次挑战失效，不能泄露原始异常。SMTP SSL/STARTTLS 均验证服务器证书。

微信使用网站应用 OAuth 的固定 HTTPS 接口、不可预测 state 和发起浏览器保留的 verifier。state 在换取身份前原子占用，授权结果必须校验 OpenID/UnionID，一次性代码不因网络不确定而盲目重放。回调页面在处理前移除 URL 中的 code/state，并要求 code 与原始 state 匹配；没有浏览器 proof、缺失 state 或过期时重新扫码。授权凭据不存入用户工作区或日志。用户看到的是微信官方授权二维码页面，不是自制无效二维码。

网页 API 请求体最多 8KiB，包括分块上传；校验错误不反射密码等原始输入，账户响应统一 no-store。浏览器保存同一标签会话的令牌于 sessionStorage，凭据不放 URL，不增加跨站 CORS。此方案需要同源 HTTPS 和严格 CSP 保护，不能宣称 sessionStorage 等同 HttpOnly Cookie 的防护。

官网与 Work 同源时，通过同一个 sessionStorage 键共享已验证的网页登录；换账号时不沿用旧账号的 Work 会话选择。当前 Ubuntu 直接 HTTP IP 与官网 HTTPS 域名不是同一个 origin，浏览器不会自动跨域共享会话；内网仍可通过 Work 登录适配器登录同一账号。不得把官网 JWT 放进跳转 URL 来伪造跨域单点登录。

## 文件入口

认证服务位于独立 `mona-auth` 仓库：

- `app/website_*.py`：模型、输入契约、验证码、网页会话、微信协议与请求保护。
- `app/routers/website_account_router.py`：`/auth/web/*` 全流程。
- `app/routers/identity_router.py`：通用只读 `/auth/identity`。
- `alembic/versions/2026_10_30_add_website_accounts.py`：只新增认证表，依赖 account_token_version。
- `tests/test_website_accounts.py`、`test_website_security.py`：账户流程、安全与迁移验证。

官网 `official-site/app/account/` 是实际页面，`static-main.tsx` 提供静态版路由。`tests/account-browser.test.mjs` 在真实 Edge 中测试生产构建，网络边界只在测试服务器模拟，不部署假账号服务。现有仓库规则忽略整个 official-site；本轮保留该规则，并把账户相关新增/修改内容记录在 `deploy/website-accounts/official-site.patch`，不能认为普通主仓库提交会自动包含官网目录。

Work 的 `auth_client.py` 使用 `/auth/web/login` 和 `/auth/web/logout`，用户身份仍通过通用 `/auth/identity` 校验。新的 Work 发布包必须在这些生产账号接口可用后再切换，不能先改上线 Work 导致旧 Auth 404。

## 生产配置与上线前置

配置只从认证服务受限环境读取，不写进仓库或聊天：

- MONA_AUTH_WEBSITE_ACCOUNTS_ENABLED：默认 false，迁移与兼容验证后开启。
- MONA_AUTH_WEBSITE_ORIGIN：官网唯一 HTTPS origin，当前计划为 https://mona-ai.cn。
- MONA_AUTH_WEBSITE_SESSION_HOURS：默认 168。
- MONA_AUTH_WECHAT_LOGIN_ENABLED：默认 false；与 AppID、AppSecret、微信后台获准的回调域名同时核验后开启。
- MONA_AUTH_WECHAT_APP_ID / MONA_AUTH_WECHAT_APP_SECRET：微信网站应用的运营配置，不得借用支付应用配置。
- 复用原账号服务 SMTP；真实发信及微信扫码验收与 mocked 测试分别记录。

微信回调是 `/account/wechat`；部署应关闭该精确回调路由的 query-string 访问日志并设置 no-referrer。官网 www 别名的账户入口应重定向到已配置的规范域名，不能把 Origin 校验整体关闭。网站 HTML 不长期缓存，新构建的 hash 资源可长期缓存；单独保留旧资源便于非破坏回退。

## 已核实的生产差异与候选包

VPS 实际运行的 Auth 并不是 `/opt/mona-auth/app`，而是 PM2 的 `/opt/mona-auth-releases/20261014-account-keys-c14f258`。部署前读取进程 cwd 和 PM2 元数据，不能按旧目录覆盖代码。

该生产版本的数据库 revision 为 cloud_account_keys，没有 credential_version；保留旧 device/trial 注册路由。直接上传本地整个 Auth 会错误地混入其他未完成业务改动。因此 `deploy/website-accounts/build-auth-candidate.py` 基于实际线上源码摘要生成兼容版本：只添加账号字段/检查、网站模块和通用 identity；为旧网页登录/桌面令牌签发传入当前凭据版本，保留原有注册设备试用、订阅、支付、计费和云同步路由。

新版本地候选目录：`output/website-accounts/auth-candidate-20261030-device-boundary-v2`。
新版候选归档：`output/website-accounts/auth-candidate-20261030-device-boundary-v2.tar.gz`。
新版归档 SHA256：`2cae5def6f83af08e59fbb0abd88f43167e2692b490398d08897b614fdde2a0a`。
服务器暂存目录 `/opt/mona-auth-releases/20261030-website-accounts` 是存在上述缺陷的旧候选，不得启用。私有运行配置及加密云配置只在原服务器保存，没有进入归档。

旧候选曾在 VPS 临时 SQLite 验证 9 项接口，但其测试未覆盖网站令牌越界，不能作为上线依据。新版候选在本地隔离 SQLite 通过 65 项账号、旧设备、桌面和身份兼容回归；尚未上传或在 VPS 测试。生产备份/检查调用此前被平台安全检查屏蔽；本轮只读复核确认旧 release 仍在运行，线上 `/auth/identity` 和 `/auth/web/capabilities` 仍是 404。

后续发布必须先完成数据库备份与迁移权限核验，再应用 account_token_version 和 website_accounts 两个增量迁移。先在网站开关关闭时验证原客户端路由、旧 token、identity 和 SMTP，再打开账号入口。发布只切换 Auth 指定 PM2 进程及网站账户静态产物，不重启其他服务。

回退不能在已签发 wsid 令牌后退回不识别 wsid 的旧鉴权代码，否则被撤销的令牌可能重新有效。应先关闭网站开关并保留会话撤销校验，再按审查过的兼容版本回退；不要直接删除认证表、恢复整库或清空用户数据。

## 验证口径

新版生产源码兼容候选的账号和旧设备回归 65 项通过；真实 Edge 账户界面 7 项通过（模拟 SMTP/微信网络边界）。本轮指定 Work 包已在目标 Ubuntu 通过 104 项测试，包括真实 gVisor 隔离；上线时应重新核对该包与最新源码、配置和生产状态，不能把其他包的测试记录冒充本版本验收。

官网、Auth、Work 的源码和测试已补齐，不代表已经上线。真实 WeChat 配置、真实邮件收取、独立平台模型和正式路由联调仍需分别核验。
