# 官网产品建议

官网 `/suggestions` 公开展示建议；注册用户通过已有网站会话发布 1–1000 个 Unicode 字符的纯文字，可包含 emoji、换行和制表符。界面明确提示内容公开，不应填写隐私。没有附件、富文本、评论、点赞或额外账户体系。

## 所有权

业务服务源码在 `deploy/website-suggestions/app.py`，由独立 `mona-website-suggestions.service` 运行。它只向现有 Auth 的 `/auth/web/profile` 传递当前 Bearer 令牌，读取账号 ID 和昵称，并由 Auth 检查网站会话及撤销状态；不持有签名密钥，不读取 Auth 数据库、余额、订阅、支付、设备或 Work 数据。前端通过 `/auth/identity` 确认当前身份后加载该账号在当前标签页保存的草稿。

服务不装配 Mona 桌面运行时，配置在本独立组件的 `Settings` 中显式声明，由 `/etc/mona-website-suggestions/operator.json` 提供；不向桌面的 `mona/config/schema.py` 增加无关业务配置。生产只绑定 VPS loopback `127.0.0.1:8002`。认证上游固定为本机 Auth，官网来源固定为 `https://mona-ai.cn`，不接受用户提供的目标 URL。

建议保存到 `/var/lib/mona-website-suggestions/suggestions.sqlite3`，与代码目录分离，SQLite WAL 由独立动态系统用户持有。只保存内部账号 ID、请求 ID、正文、发布时昵称和 UTC 时间；公开响应仅含建议 ID、正文、昵称与时间，不返回账号 ID、邮箱或认证信息。

## 接口与交互

- `GET /api/suggestions?before=<id>`：无需登录，按发布时间倒序，每页 20 条，用单调 ID 翻页。
- `POST /api/suggestions`：仅同源 JSON 和有效网站会话；正文及 UUID4 `request_id` 必填，其他字段拒绝。正文和请求体分别限制 1000 字符、8KiB。
- `(account_id, request_id)` 唯一；相同正文重试返回同一条建议，改变正文但复用 ID 返回 409。重复请求仍须重新验权，不因去重绕过退出撤销。新发布间隔 30 秒，每账号每小时最多 10 条，事务内检查以防并发绕过。
- 请求结果未知时，前端保留草稿和请求 ID，用户重试仍核对同一提交；切换账号不会加载或提交另一账号草稿，迟到响应不能改变新账号的提交状态。
- HTML、Markdown 和 URL 都按普通文字显示，不执行、不自动展开链接或抓取。注册、登录及退出规则仍由原账号页面处理。

## 发布与恢复

网站基于已发布源码快照隔离构建，建议改动保存为 `deploy/website-suggestions/official-site.patch`，原账户补丁仍保留自己的历史范围。新静态包保留旧 hash 资源；`/suggestions` 的 www 入口转向规范域名，HTML 和 API 均不缓存。Nginx 只新增建议页面及精确 API 反代，认证路由与其他业务不变。

服务使用独立 venv、只读代码与 systemd `StateDirectory`，只启动本服务；不重启 Auth、Docker 或其他应用。回退网站可切回之前静态目录，停止建议服务会使提交明确失败；保留建议数据库，不通过整库覆盖或删除用户内容回退。

备份使用 SQLite 在线 backup API，单独恢复到临时数据库并检查 integrity 与行数；不能仅复制运行中的主文件而漏掉 WAL。升级前保存服务单元、运营配置、源码与 Nginx 配置；生产测试记录需要区分本地合成身份边界和真实登录、发布、重新加载及退出验收。

## 2026-10-31 生产验收

当前官网目录 `/var/www/mona/site-releases/suggestions-20261031-v2/content`；独立服务目录 `/opt/mona-website-suggestions/releases/suggestions-20261031-v1-runtime-pinned`。运行与产物清单见 `deploy/website-suggestions/release-manifest.json`。

使用原有专用测试账号，经真实邮件重置及正常网站登录，在隔离浏览器完成公开读取、文字/emoji/换行发布、刷新持久化、HTML 字面显示、桌面导航、320px 布局和退出后旧令牌拒绝发布；只重启建议服务后仍保留测试行。SQLite 在线备份已恢复并验证，再按精确账号、请求 ID 与正文删除该条验收内容。未留下模拟建议。9 项服务端检查在本服务独立生产环境通过；本地浏览器测试使用合成边界，与上述真实验收分开记录。

部署只新增本服务并热加载 Nginx，Auth、数据库、One API 与现有隧道进程保持原 PID；未操作 Docker 或 Ubuntu。建议服务开机启动配置已启用，未通过整机重启验证。
