# 给Mona的建议

官网 `/suggestions` 公开展示建议；注册用户通过已有网站会话发布 1–1000 个 Unicode 字符的纯文字，可包含 emoji、换行和制表符。界面明确提示内容公开，不应填写隐私。没有附件、富文本、评论、点赞或额外账户体系。

页面名称为“给Mona的建议”，首页导航与账户菜单入口统一为“建议”。文案版本对应官网 `/var/www/mona/site-releases/suggestions-labels-20261031-v4/content`，只修改三个文字位置，管理与数据规则沿用下述 v3 发布。

页面以暖纸色建议列表为主体，暗色品牌导航保持官网识别；右下角“写建议”按钮展开固定在底部的非模态输入面板，不锁定列表滚动。收起或 Escape 保留当前账号草稿，发送期间禁止关闭，成功后收起。移动端根据可见视口避让键盘，并给列表底部留出面板占位。

## 所有权

业务服务源码在 `deploy/website-suggestions/app.py`，由独立 `mona-website-suggestions.service` 运行。它只向现有 Auth 的 `/auth/web/profile` 传递当前 Bearer 令牌，读取账号 ID 和昵称，并由 Auth 检查网站会话及撤销状态；不持有签名密钥，不读取 Auth 数据库、余额、订阅、支付、设备或 Work 数据。前端通过 `/auth/identity` 确认当前身份后加载该账号在当前标签页保存的草稿。

管理员通过现有 `/admin/` 后台的“建议管理”查看、隐藏、恢复与删除。每次管理请求都调用 Auth 的通用只读 `/auth/identity/admin`：沿用已有账号认证、撤销和数据库管理员角色，非管理员返回 403；不信任浏览器角色字段，不另设管理员名单或新管理密钥。Auth 不新增建议业务表或业务路由。

服务不装配 Mona 桌面运行时，配置在本独立组件的 `Settings` 中显式声明，由 `/etc/mona-website-suggestions/operator.json` 提供；不向桌面的 `mona/config/schema.py` 增加无关业务配置。生产只绑定 VPS loopback `127.0.0.1:8002`。认证上游固定为本机 Auth，官网来源固定为 `https://mona-ai.cn`，不接受用户提供的目标 URL。

建议保存到 `/var/lib/mona-website-suggestions/suggestions.sqlite3`，与代码目录分离，SQLite WAL 由独立动态系统用户持有。只保存内部账号 ID、请求 ID、正文、发布时昵称和 UTC 时间；公开响应仅含建议 ID、正文、昵称与时间，不返回账号 ID、邮箱或认证信息。

## 接口与交互

- `GET /api/suggestions?before=<id>`：无需登录，按发布时间倒序，每页 20 条，用单调 ID 翻页。
- `POST /api/suggestions`：仅同源 JSON 和有效网站会话；正文及 UUID4 `request_id` 必填，其他字段拒绝。正文和请求体分别限制 1000 字符、8KiB。
- `(account_id, request_id)` 唯一；相同正文重试返回同一条建议，改变正文但复用 ID 返回 409。重复请求仍须重新验权，不因去重绕过退出撤销。新发布间隔 30 秒，每账号每小时最多 10 条，事务内检查以防并发绕过。
- 请求结果未知时，前端保留草稿和请求 ID，用户重试仍核对同一提交；切换账号不会加载或提交另一账号草稿，迟到响应不能改变新账号的提交状态。
- HTML、Markdown 和 URL 都按普通文字显示，不执行、不自动展开链接或抓取。注册、登录及退出规则仍由原账号页面处理。
- `GET /api/suggestions/admin?state=all|public|hidden&before=<id>`：管理员分页查看；`PATCH /api/suggestions/admin/{id}` 的严格布尔 `hidden` 控制隐藏或恢复，`DELETE` 删除。写入要求规范官网 Origin，每次重新核验管理员身份。管理结果未确认时，界面要求先刷新核对，不自动重放。
- SQLite 仅增量添加 `state`、`moderated_by`、`moderated_at`，原有内容默认为公开，`user_version=2`。公开列表只读取 public；隐藏可恢复，删除以 deleted 状态保留内部操作记录，从官网和后台列表同时移除，不能通过旧请求 ID 重新公开。

## 发布与恢复

网站基于已发布源码快照隔离构建，建议改动保存为 `deploy/website-suggestions/official-site.patch`，原账户补丁仍保留自己的历史范围。新静态包保留旧 hash 资源；`/suggestions` 的 www 入口转向规范域名，HTML 和 API 均不缓存。Nginx 的精确公开 API 和 `/api/suggestions/` 管理前缀只代理独立建议服务。

服务使用独立 venv、只读代码与 systemd `StateDirectory`。本轮为新增通用管理员身份读取接口而单独切换 Auth，保留原配置和撤销校验；其他服务与 Docker 不重启。恢复的旧后台 HTML 只增加建议菜单、资源与切换钩子，Auth 静态文件路径做 resolved-path 范围检查，`/admin/` 反代绕过通用静态资源正则以正确加载后台资源。

状态迁移后不能直接回退到不识别 state 的 v1 服务，否则已隐藏或删除的建议可能重新公开。应保留当前状态过滤的兼容版本；不可用时关闭建议 API 并显示失败，不恢复整库覆盖新增内容。旧静态目录可单独回退，数据库和删除记录保持原状。

备份使用 SQLite 在线 backup API，单独恢复到临时数据库并检查 integrity 与行数；不能仅复制运行中的主文件而漏掉 WAL。升级前保存服务单元、运营配置、源码与 Nginx 配置；生产测试记录需要区分本地合成身份边界和真实登录、发布、重新加载及退出验收。

## 2026-10-31 管理与重设计验收

当前官网目录 `/var/www/mona/site-releases/suggestions-admin-redesign-20261031-v3/content`；建议服务 `/opt/mona-website-suggestions/releases/suggestions-admin-redesign-20261031-v3`；Auth `/opt/mona-auth-releases/20261031-suggestions-admin-v3/content`。产物清单见 `deploy/website-suggestions/admin-redesign-release-manifest.json`。

线上原管理页因网站账号发布包漏带静态目录返回 404。本轮从服务器保留的原生产页面恢复，未发布本地 Auth 脏页面及其余额等修改。8 项 Auth 检查、12 项建议服务检查在生产依赖环境通过；21 项账户/建议前端检查及 8 项管理前端检查使用隔离浏览器和合成接口。

另用服务器运维权限为既有测试用户和既有管理员签发 10 分钟内过期、可单独撤销的真实网站会话，未修改任何账号角色。真实生产浏览器通过 11 个场景，包括浮动输入、草稿、手机布局、发布/刷新/HTML 字面、普通用户管理 403、管理员隐藏/恢复/确认删除和两个会话退出后 401。没有把管理密码登录表单列为本轮重新验收项目。

原有一条真实建议逐字段保持不变；验收建议由后台删除，保留内部 deleted 记录。只重启建议服务后删除状态仍生效，SQLite 在线备份在独立文件恢复并通过 integrity 校验。备份 `/var/www/mona/backups/suggestions-admin-redesign-20261031-v3`。Auth 全量源码清单 130 个文件校验通过，PM2 已保存新 cwd；MariaDB schema 仍为 website_accounts，余额等业务代码与原记录未改变。

## 初次发布记录

当前官网目录 `/var/www/mona/site-releases/suggestions-20261031-v2/content`；独立服务目录 `/opt/mona-website-suggestions/releases/suggestions-20261031-v1-runtime-pinned`。运行与产物清单见 `deploy/website-suggestions/release-manifest.json`。

使用原有专用测试账号，经真实邮件重置及正常网站登录，在隔离浏览器完成公开读取、文字/emoji/换行发布、刷新持久化、HTML 字面显示、桌面导航、320px 布局和退出后旧令牌拒绝发布；只重启建议服务后仍保留测试行。SQLite 在线备份已恢复并验证，再按精确账号、请求 ID 与正文删除该条验收内容。未留下模拟建议。9 项服务端检查在本服务独立生产环境通过；本地浏览器测试使用合成边界，与上述真实验收分开记录。

部署只新增本服务并热加载 Nginx，Auth、数据库、One API 与现有隧道进程保持原 PID；未操作 Docker 或 Ubuntu。建议服务开机启动配置已启用，未通过整机重启验证。
