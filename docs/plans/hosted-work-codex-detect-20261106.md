# 工作台 Codex 连接及模型管理验收（2026-11-06）

## 范围与结果

- 后端 `63a27e2b6`：为专用 Codex CLI 登录和连接探测增加受限本地代理选项，区分连接超时与程序协议错误；不改变 Qwen 或 Work 全局网络设置。
- 前端 `4b0c01857`：模型改为一行一项，提供开放开关和设置弹窗；未定价模型开放前先填写价格。移除服务器程序路径、Ubuntu 登录说明、重复提示和内部实现状态。已有路径自动保留，失效且发现新程序时需管理员显式切换。
- 没有为用户自动开放 Codex 模型或修改价格。专用账号连接及目录读取成功不代表逐模型调用权限；Codex 任务执行和共用余额计费桥仍未完成。托管商业认证边界参见 [OpenAI 官方说明](https://learn.chatgpt.com/docs/app-server#auth-endpoints)。

## 排查

专用 CLI `login status` 成功；空配置环境初始化成功。Ubuntu 直接访问上游网络失败（系统错误 101），真实专用账号连接探测在读取账号阶段超时。用户现有本机代理可用；只在该 CLI 子进程设置回环代理后，真实账号、协议和隔离检查通过，并返回 8 个模型。代理停止时检测可能再次超时。未输出账号凭据或原始认证数据。

`hosted_work.codex.local_proxy_url` 仅允许带端口的 HTTP 字面回环地址，不允许凭据、路径、查询或片段；旧管理客户端省略该字段时保留已有值。只作用于 Codex 登录和检测进程，不影响 Qwen、其他模型或服务器全局网络。

## 验证与发布

- 后端 Windows：107 项通过、8 项平台跳过；Ubuntu 候选：115 项通过。前端组件：21 项通过，隔离构建和 TypeScript 检查通过。
- 生产真实管理员会话执行连接检测，读取 8 个目录项；真实浏览器验证单行列表、设置弹窗和取消、未定价模型开放前进入设置。未发送模型任务、未保存测试配置，临时会话均撤销，测试钱包未改变。
- 验收后管理员自行开放并定价 GPT-6.1-Sol；只读核验其配置已保存，服务端执行和钱包门槛仍阻止调用，没有回滚用户配置。
- Ubuntu 后端：`/home/liuzhe/mona-hosted-work/releases/20261106-codex-probe-v32/content`，5,646 文件 SHA 核验；清单 `abdd7153aaa677c292c2fbfd8d3ba41d04bee20c21fe8be1b1079bfd5af54f4e`。发布备份 `/home/liuzhe/mona-hosted-work/backups/20261106-codex-probe-v32`。
- VPS 前端：`/var/www/mona/work-releases/20261106-codex-list-ui-v33/content`，5,860 文件 SHA 核验、465 个 Office 产物不变；清单 `c725a920c947a5704972c6c422e601e3cd7d5d1301049bfb4730a4be40969b02`。回退备份 `/var/www/mona/backups/codex-list-20261106-v33`。
- 后端仅在无活动或未知任务时切换 Work 自身；网站仅变更 Work 静态资源及 include 并平滑加载 Nginx。25 会话、31 任务、6 文件保持；Docker、隧道、原有容器及四个暂停 Worker 未改变，其他业务服务未重启。未发布其他任务的未提交改动。

回退前确认任务空闲，不用历史 state 或数据库覆盖已有用户数据；相关脱敏机器记录见 `deploy/hosted-work/codex-detect-release-20261106.json`。
