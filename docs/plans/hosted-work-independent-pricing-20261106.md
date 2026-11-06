# 工作台独立价格与 Codex 自动发现

日期：2026-11-06。后端 v27c、前端 v28 已上线，真实管理员与普通账号浏览器验收通过。

## 价格与边界

自定义 API 和 Codex CLI 的同一表单直接设置输入、缓存输入、输出三项单价。工作台将 `price` 保存到各自的 `HostedWorkModel` 或 `HostedCodexSettings`，不读写应用侧 `/admin/credits/model-prices`；旧 `billing_model` 仅兼容保留、不作为价格来源，未编辑价格的旧客户端不会擦掉已保存值。没有从应用价表推导或迁移价格。

金额是人民币/百万 token 的非负十进制字符串，最多六位小数，上限 1,000,000,000；三项全空为未配置，零是明确的值，部分填写、负数、浮点和科学记数拒绝。服务端复用现有版本校验、文件锁、受限备份、空闲检查与原子同步，防止覆盖其他模型、旧客户端及并发管理员的修改。免费/共用余额仍由管理员选择，用户此前选择的 Qwen free 保持。

网站和应用侧模型配置、价格和上游连接独立；账号仍使用此前要求的同一余额。共用余额预扣/结算桥尚未实现，wallet 模型仍拒绝派发，Codex 执行适配也未完成。未来收费必须在服务端冻结该次独立价格与真实用量，不能回查应用价表、信任浏览器金额或把未知用量当零。保存价格不等于收费已开放。

## 自动发现

管理页选择 Codex 且尚未保存程序路径时，页面可见期间每 10 秒只读重查。服务端检查可信 PATH、常见系统/npm-global/nvm 及固定运营目录；不扫描租户工作区，不执行程序或读取凭据。未配置且用户未手动修改时自动预填未保存路径，管理员保存后才能连接检测；已配置/手动路径及其他价格草稿不会被覆盖。

Ubuntu 实际安装的 `@openai/codex` 包为 0.167.0，原生 ELF 位于 `~/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`。共享 npm 解析器原只检查 `vendor/<triple>/codex/codex`，新增对新版 `vendor/<triple>/bin/codex` 的向后兼容，保留包名、vendor 范围及可执行权限校验。真实机器只读发现与页面自动预填均通过，没有启动该程序；发现不代表认证、连接、执行或收费已通过。

## 真实验收

真实管理员在工作台分别临时填写自定义 API 和 Codex 价格，保存、刷新读回后按原值恢复；两类其余配置、当前 Qwen 的免费状态和 CLI 已保存路径保持。并发恢复使用版本校验，未经确认的状态不盲目覆盖。浏览器拦截并核对原价表请求数为 0；匿名和普通账号对两条管理 API 的读写分别为 401/403。检测到的实际 CLI 路径已自动填入但未自动保存。未点击连接检测或执行模型任务，临时登录撤销，测试钱包余额/预占/占用/版本不变。

Windows 关联测试 119 项通过/10 项平台权限或符号链接跳过；Ubuntu 候选 129 项通过，覆盖这些 Linux 场景。前端关联 23 项、隔离 TypeScript 和最终构建通过。候选首次脚本误用系统 Python 缺少 `loguru`，未切换服务；改用现有 Work 虚拟环境后测试和真实文件发现均通过，未将第一次失败记为成功。

## 生产与回退

Ubuntu 后端 `/home/liuzhe/mona-hosted-work/releases/20261106-work-pricing-v27c/content`，PID 709912、active、NRestarts=0；5,644 文件核验，清单 SHA `e186ecc73b0ec76e77e2504be0740cb13be14ee6d5ef9125c58b26ae46fcd5c7`。VPS 前端 `/var/www/mona/work-releases/20261106-work-pricing-ui-v28/content`，5,172 文件核验，清单 SHA `8ff18f708503b9f736d31e7024b176ffd39a6b0c13663b89deec8d03a01ba50d`；include `/opt/mona-work-proxy-releases/20261106-work-pricing-ui-v28/work-locations.conf`。465 Office 文件与旧 hash 保留。

仅在无运行、取消中或 unknown 任务与文件操作时备份并切换 Work；25 会话/31 任务/6 文件保持，无活动/unknown。Docker 78383、隧道 423172、原八容器及四个暂停 Worker、Nginx 420299、MariaDB 420210、Work visitor 367299、Auth 389486 和 One API 310825 均保持；官网首页与个人 Relay 未操作。

后端候选包 v27、v27b 和 v27c 依次叠加价格/检测、路径校验和 npm 新版布局；只有 v27c 被激活。前端 v28 只变更两个静态文件，保留此前资源。精确摘要、验收及测试结果见 `deploy/hosted-work/independent-pricing-release-20261106.json` 与 `output/hosted-work/work-pricing-20261106/`。

回退可用 `/home/liuzhe/mona-hosted-work/backups/20261106-work-pricing-v27c` 的配置和用户服务备份，以及 `/var/www/mona/backups/work-pricing-20261106-v28` 的原 Work include。先确认空闲，不用旧 state/数据库覆盖现有用户数据。源码分类提交 `312238b6b`（独立价格和发现）、`1ac152ae1`（表单与真实验收），未推送；其他任务未提交修改未打包。
