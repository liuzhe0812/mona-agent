# 官网产品建议交付

已发布页面：[产品建议](https://mona-ai.cn/suggestions)。注册用户使用现有网站会话发布，访客可阅读。业务和认证边界见 [架构说明](../../docs/architecture/website-suggestions.md)。

## 生产入口

| 项目 | 当前值 |
|---|---|
| systemd | `mona-website-suggestions.service`，独立动态用户，已启用开机启动 |
| 监听 | VPS `127.0.0.1:8002`，仅代理精确 `/api/suggestions` |
| 代码 | `/opt/mona-website-suggestions/current` → `releases/suggestions-admin-redesign-20261031-v3` |
| 依赖 | `/opt/mona-website-suggestions/venv`，`requirements.txt` 和 `constraints.txt` 固定版本，不修改 Auth 环境 |
| 配置 | `/etc/mona-website-suggestions/operator.json`，不包含凭据 |
| 数据 | `/var/lib/mona-website-suggestions/suggestions.sqlite3`，包含 WAL，独立于发布目录 |
| 网站 | `/var/www/mona/site-releases/suggestions-admin-redesign-20261031-v3/content` |
| 后台 | `https://mona-ai.cn/admin/` → “建议管理” |
| Auth | `/opt/mona-auth-releases/20261031-suggestions-admin-v3/content`，通用 `/auth/identity/admin` 核验原管理员角色 |
| 本轮备份 | `/var/www/mona/backups/suggestions-admin-redesign-20261031-v3` |

只通过已有 Auth 的身份读取接口验证用户，不部署第二套账号或签名密钥，不需要模型、微信或支付凭据。本服务的配置由 `app.py` 的 `Settings` 显式声明；它不是桌面 Gateway/Services 的运行配置。

## 源码与产物

`official-site/` 被主仓库忽略。`official-site.patch` 只包含建议页、导航入口和浏览器检查，应用基线为此前捕获的 `account-login-return-v3/source.tar.gz`，SHA256 `97a753e2adb05919f459f10813a27513aa48d801c740709eb8d178811c16d8e9`。

补丁保留原始 CRLF 到 LF 的字节差异；根 `.gitattributes` 对该文件设置 `-text`，不要重新归一化补丁本身。原归档安全解压后可直接 `git apply --check` 再 apply；已在两个隔离目录验证全部 93 个源码文件 SHA 与最终源码快照一致。不要在正在被其他任务修改的官网目录上反向应用旧补丁。

本轮 `admin-redesign-release-manifest.json` 记录最终源码、网站、建议服务和 Auth 定向补丁产物摘要；初次发布清单仍在 `release-manifest.json`。归档保存在 `output/website-suggestions/admin-redesign/release-v3/`，生产 release 同样保留归档。`auth-core.patch` 只增加通用管理员身份读取和后台静态路径防越界；`admin-integration.patch` 在服务器保留的原后台页面上添加建议管理，未混入本地脏 Auth 页面。三个补丁均按原基线逐字节回放通过。发布前先比对真实 Nginx root、服务 cwd 和配置，不能直接打包当前脏工作树。

## 验证与恢复

`test_app.py` 覆盖身份、撤销、正文、SQLite 持久化、去重、限流、分页、增量迁移和管理员操作；官网浏览器检查随补丁交付。后台浏览器回归为 `admin/browser.test.mjs`，通过 `MONA_ADMIN_CANDIDATE_HTML` 指向隔离构建的后台候选页，不读取本地脏 Auth 页面。生产联调记录在 `admin-redesign-acceptance-20261031.json`，与本地合成边界检查区分。原有建议完整保留，本轮验收建议经后台删除并保留内部删除记录。

SQLite 备份使用在线 backup API，并在独立文件恢复检查 integrity 和内容；不要直接复制活跃主文件而遗漏 WAL。已处理过隐藏或删除后，不得回退到忽略 state 的 v1 后端，避免重新公开内容；保留状态兼容版本，或关闭建议 API。网站可单独切换旧静态 root，数据保留。日常建议升级独立操作本服务，只有认证接口变更才单独切换 Auth；不重启 Docker 或其他业务。
