# 官网产品建议交付

已发布页面：[产品建议](https://mona-ai.cn/suggestions)。注册用户使用现有网站会话发布，访客可阅读。业务和认证边界见 [架构说明](../../docs/architecture/website-suggestions.md)。

## 生产入口

| 项目 | 当前值 |
|---|---|
| systemd | `mona-website-suggestions.service`，独立动态用户，已启用开机启动 |
| 监听 | VPS `127.0.0.1:8002`，仅代理精确 `/api/suggestions` |
| 代码 | `/opt/mona-website-suggestions/current` → `releases/suggestions-20261031-v1-runtime-pinned` |
| 依赖 | `/opt/mona-website-suggestions/venv`，`requirements.txt` 和 `constraints.txt` 固定版本，不修改 Auth 环境 |
| 配置 | `/etc/mona-website-suggestions/operator.json`，不包含凭据 |
| 数据 | `/var/lib/mona-website-suggestions/suggestions.sqlite3`，包含 WAL，独立于发布目录 |
| 网站 | `/var/www/mona/site-releases/suggestions-20261031-v2/content` |
| 备份 | `/var/www/mona/backups/suggestions-20261031-v1`、`suggestions-20261031-layout-v2` |

只通过已有 Auth 的身份读取接口验证用户，不部署第二套账号或签名密钥，不需要模型、微信或支付凭据。本服务的配置由 `app.py` 的 `Settings` 显式声明；它不是桌面 Gateway/Services 的运行配置。

## 源码与产物

`official-site/` 被主仓库忽略。`official-site.patch` 只包含建议页、导航入口和浏览器检查，应用基线为此前捕获的 `account-login-return-v3/source.tar.gz`，SHA256 `97a753e2adb05919f459f10813a27513aa48d801c740709eb8d178811c16d8e9`。

补丁保留原始 CRLF 到 LF 的字节差异；根 `.gitattributes` 对该文件设置 `-text`，不要重新归一化补丁本身。原归档安全解压后可直接 `git apply --check` 再 apply；已在两个隔离目录验证全部 93 个源码文件 SHA 与最终源码快照一致。不要在正在被其他任务修改的官网目录上反向应用旧补丁。

`release-manifest.json` 记录最终源码、网站和后端产物摘要；归档保存在 `output/website-suggestions/`，对应生产 release 也保留了源码归档和产物。发布前先比对真实 Nginx root、服务 cwd 和配置，不能直接打包当前脏工作树。

## 验证与恢复

`test_app.py` 覆盖身份、撤销、正文、真实 SQLite 持久化、幂等去重、限流、分页和依赖失败；`tests/suggestions-browser.test.mjs` 随官网补丁交付。本地合成接口检查与真实生产浏览器验收分别记录在 `acceptance-20261031.json`。生产测试内容已精确清理。

SQLite 备份使用在线 backup API，并在独立文件恢复检查 integrity 和内容；不要直接复制活跃主文件而遗漏 WAL。回退网站只切换静态 root，建议数据保留；停止本服务不影响 Auth。任何后续更改只操作本服务及本域名相关 Nginx 配置，不重启 Docker、Auth 或其他业务。
