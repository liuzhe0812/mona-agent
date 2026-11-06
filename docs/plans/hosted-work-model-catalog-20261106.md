# 工作台模型目录、开放状态与逐模型价格

日期：2026-11-06。后端 v29、前端 v30 已上线；本轮真实供应商目录与管理页面验收通过。

## 功能与边界

自定义 API 使用服务器已载入的凭据访问供应商自身 `/models`，网页自动显示真实返回的候选模型。管理员在每张模型卡分别设置开放、显示名称、免费/共用余额及三项独立价格，点击该卡保存；切换模型/连接不自动保存其他草稿。后台不再展示或修改推理强度，旧配置值兼容保留。

`HostedWorkModel.enabled` 对旧条目缺省 true、新条目缺省关闭；新建或从关闭变为开放必须提供价格，三项零由管理员明确填写。旧 Qwen 已开放且价格为空，保持原平台 ID、状态和价格，不自动赋值。已配置但本次目录未返回的模型保留关闭与修改入口；同 ID 不能跨来源覆盖，多个供应商/模型的价格和草稿独立。关闭已有自定义模型不依赖上游 DNS 和凭据恢复，配置写入仍要求工作台空闲并校验版本。

模型发现仅管理员可调用，使用同源、DNS 全记录公网校验、连接 IP 固定和原 TLS 主机名，拒绝跳转/代理/不受控内网；凭据只从服务环境变量读取，不返回或记录 Key。响应和模型数有界；供应商没有目录、返回不完整分页或格式错误时明确提示，不补造模型。供应商目录不是逐模型权限或实际推理成功的保证。

Codex 模型也可逐个记录开放意向与工作台独立价格，但执行适配和共用余额桥尚未完成，服务端继续阻止调用。专用缓存可显示为未验证目录；管理员主动检查连接并通过认证、协议与隔离检查后，使用 CLI 返回的 `model_details`，不再以缓存文件存在为前提。保存其他模型时保留相同修订下已验证的 Codex 目录；连接配置变化会使其失效。

用户提出网页 CLI 认证为可选项。[OpenAI App Server 官方认证说明](https://learn.chatgpt.com/docs/app-server#auth-endpoints)明确不允许托管或商业服务使用 App Server 内置认证，因此没有添加网页认证；保留 Ubuntu 终端登录说明，没有读取认证凭据、启动登录或发送 CLI 任务。OpenAI 同时说明 [model/list 可能是目录而非权限证明](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。

## 验证

- Ubuntu 候选 184 项通过；Windows 182 项通过、2 项因符号链接权限跳过；前端 23 项、隔离 TypeScript 和构建通过。覆盖单模型开关、旧模型兼容、价格必填、不同来源隔离、上游失败时关闭、旧客户端字段保留、版本/忙碌保护和已接收请求不重派。
- 真实供应商目录请求返回 6 项：`glm-5`、`kimi-k2.5`、`MiniMax-M2.5`、`qwen3.5-plus`、`qwen3.6-plus`、`qwen3.7-plus`。无模型推理，服务凭据未写日志或报告。
- 真实浏览器显示全部 6 项；新模型勾选/填价/取消仍是未保存草稿；既有 Qwen 按原 ID 临时保存价格、刷新读回并恢复，开放状态不变。推理强度字段不存在；Codex 实际路径预填、尚未配置/验证时空列表提示正常。
- 匿名及普通账号模型发现请求分别 401/403；浏览器对应用侧价表请求数为 0。没有调用模型、登录 Codex 或修改其他模型；临时管理员和普通账号测试会话撤销，测试钱包保持 0。
- 首轮真实页面验收在模型列表阶段断言未通过，未写任何配置；第二轮完整通过，原失败 `production-acceptance.json` 与最终 `production-acceptance2.json` 均保留在 `output/hosted-work/work-models-20261106/`。

## 生产与回退

Ubuntu 后端 `/home/liuzhe/mona-hosted-work/releases/20261106-work-models-v29/content`，PID 732118、active、NRestarts=0；5,646 文件核验，清单 SHA `8cb400d54d477f7ab2942381bca191d4801a1ac2f598eba2672cc0dcf213d8af`。VPS 前端 `/var/www/mona/work-releases/20261106-work-models-ui-v30/content`，5,516 文件核验，清单 SHA `bf4b626fcea1c49bf37ef699d72ca1146f9a4625dbf093f357642af647d042d6`；include `/opt/mona-work-proxy-releases/20261106-work-models-ui-v30/work-locations.conf`。465 Office 文件及旧 hash 保留。

只在无活动/unknown 任务与文件操作时备份并切换 Work。25 会话/31 任务/6 文件保持，原八容器、四个暂停 Worker、Docker 78383、Work 隧道 423172 及 VPS 原服务进程保持；其他任务未提交改动、官网首页和个人 Relay 未发布或操作。配置 600，Auth 验收登录已撤销。

回退用 `/home/liuzhe/mona-hosted-work/backups/20261106-work-models-v29` 的配置/用户服务文件及 `/var/www/mona/backups/work-models-20261106-v30` 的原 Work include；先确认空闲，不覆盖当前用户 state/数据库。发布摘要与测试记录为 `deploy/hosted-work/model-catalog-release-20261106.json`。分类提交 `03eca57b0`（发现、启停与安全边界）、`c6d19ebed`（页面和浏览器验收），未推送。
