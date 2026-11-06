# 工作台模型与计费入口、样张和 PPT 控件交付

日期：2026-11-06。最终后端 v23、前端 v24、静态入口 v24c；已生产发布并完成下述真实验收。Codex 实际执行和收费未开通。

## 管理入口

原后台侧栏“工作台模型与计费”进入 `https://mona-ai.cn/work/admin/`。保持原 Auth 管理员认证，匿名管理 API 返回 401，普通注册账号返回 403。

- 免费 API：新增/修改 `HostedWorkModel` 已定义的八个字段，只允许 `source=mona`，引用已载入的 `MONA_WORK_MODEL_*` 环境变量，不接收或回显 Key。Qwen 对全部已登录账号免费。
- 保存：与 Codex 草稿共用文件摘要版本、异步锁和文件锁，备份/原子替换；拒绝活动/未知任务、文件操作、占用进程、旧版本或不同来源模型覆盖。空闲临界区直接更新同一个配置对象，已有任务的派发配置不改变。页面恢复焦点时重新读取公开模型设置。
- 网络：新地址全量检查 DNS 公网地址并固定实际连接 IP，保留原 Host/TLS SNI；拒绝重定向、跨 origin、私网和特殊地址。既有受控字面回环 origin 可保留，不开放任意新内网配置。
- Codex：保留程序路径、认证方式、原生模型、账务模型、显示名称、登录说明和检测。保存为连接草稿，`billing.ready=false`、`public_enabled=false`。
- 共用价格：读取 Auth `/admin/credits/model-prices` 的最高已启用 token 价格版本，展示输入/缓存输入/输出的人民币百万 token 价格。修改继续在原后台“模型服务 → 模型计价”，不另建价表或钱包。本轮未改价、未发付费模型请求。

真实管理员验收使用当前 Qwen 配置逐字段保存原值，确认服务同步、旧版本 409、Codex 未保存草稿保留、三个价格/版本与原表相同。测试选择已有价格仅为未保存的显示验证，未把该价格模型写成 Codex 配置。从原后台实际点击导航进入新页面、加载模型配置已通过。普通账号与匿名读写均拒绝；临时登录均撤销，测试钱包四项数值保持 0。

## 样张和按钮

原用户任务只加载 `mona-pptx`，随后成功读取其指向的 `mona-design` 资料，但六次素材复制被 Hosted 特有的“必须另外加载设计 Skill”条件拒绝，没有产生预览文件。应用 `SkillAssetCopyTool` 没有这项条件。本次只对公开内置依赖素材移除额外门槛，保留路径/链接/大小、只读来源和沙箱目标检查；脚本仍须加载对应 Skill，私人来源仍禁止。

v21 真实 Qwen 样张任务 `bc76b0655d9746a2d48f02300d2fc8b1` 中三张 1200×750 JPG 同时可见，真实图像尺寸和内置文件 SHA 均匹配，风格面板可见。模型该次自行读取了两个 Skill；“只加载 PPT 也能复制设计依赖”由真实三图字节回归验证，不能混称该生产请求只读了一个 Skill。样张确认后 QA 主动取消自己的任务，工作区已保存；本验收不代表整份 PPT 制作完成。

网页 PPT “AI 编辑”只在共享 `OfficeEditorFrame` 的 Hosted slides 分支注入样式隐藏 `.mona-stage-ai-menu`；桌面保留，不修改或重建 Office 产物。真实原生编辑器中按钮不可见，新增幻灯片 1→2、保存、刷新仍为两页且按钮继续隐藏；保存工作副本 32,321 字节，SHA `490314f129a34844e899ec1c9733115b4d2c5dbf595e0a5ffeee195afbba8d6d`。没有发模型消息。

开始切换 v21 前发现真实用户任务仍在运行，等待其自行结束，没有中断。其原状态 `failed/workspace_saved=true`、原因为 `workspace_operation_failed`，未被改为成功或重派。

## 生产与范围

| 项目 | 最终事实 |
|---|---|
| Ubuntu | `/home/liuzhe/mona-hosted-work/releases/20261106-model-admin-v23/content`，PID 644369、active、NRestarts=0，5,640 文件 |
| 后端清单 SHA | `102d79571a26b8e55a6963fc2fb66ba3eb311c2f47f9480e8a818567ffea132a` |
| VPS 静态 | `/var/www/mona/work-releases/20261106-model-admin-ui-v24/content`，4,827 文件，旧 hash 保留，465 Office 文件不变 |
| 静态清单 SHA | `f7898c0a4cd02fb7edb341794da606a7f0e7da7f499ec5901c93dc4d0f728bf3` |
| 入口配置 | `/opt/mona-work-proxy-releases/20261106-model-admin-ui-v24c/work-locations.conf`，SHA `3ae0039f535a5414287e64dc1b2d5a63c0fe588c56429030ac1b6059bb06ed44` |
| 数据 | 25 会话/31 任务/6 文件；completed 21、cancelled 4、failed 5、interrupted 1，无活动/unknown；原 finished 文件操作 1 |
| 保护项 | Docker 78383、隧道 423172、原八容器 ID/状态/启动时间、四个暂停 Worker；Nginx 420299、MariaDB 420210、Work visitor 367299、Auth 389486、One API 310825 均保持 |

只在空闲且无未知操作时重启 Work 用户服务，Nginx 仅热加载。官网首页未变，API、WebSocket、动态 Widget 和 CSP 保持。Auth 只给现行 HTML 插入一行同源导航，使用线上原文件做隔离候选；没有发布其本地 208 行新增/86 行删除等其他任务差异，也没有重启 Auth。导航前后 SHA 与备份见机器记录。原余额、订阅、充值、支付、云同步、桌面设备逻辑未改；云同步仍关闭。

## 验证与留档

必要验证：v21 Windows 39 项通过/1 链接权限跳过，Linux 57 项通过；v23 Linux 112 项通过，真实 Qwen TLS/IP 固定连接返回 stop 和 17 输入/33 输出 token；前端关联 14 项、隔离源码类型检查和构建通过。生产真实验收覆盖样张、原生 PPT 控件、配置保存/鉴权/价格与侧栏导航，均无模拟回包。

保留失败证据：PPT 控件首次因原生 iframe 冷加载超过旧测试等待时间超时，延长到实际原生根后通过；管理页先仍代理 Ubuntu 旧 HTML，随后一次静态入口错误指向普通会话 HTML，两次标题断言失败。最终独立 `hosted-admin.html` 与静态资源配对并验收通过，失败文件没有覆盖或改记成功。每轮临时登录均撤销，钱包未扣费。

产物与报告保存在以下目录，机器交付记录为 `deploy/hosted-work/model-admin-release-20261106.json`：

- `output/hosted-work/style-preview-20261106/`：v21 增量、Linux 与真实样张结果。
- `output/hosted-work/hide-ai-edit-20261106/`：v22 静态增量、首次失败与 `production-ui2/acceptance.json`。
- `output/hosted-work/model-admin-20261106/`：v23/v24 包、候选/发布快照、三轮管理 UI 报告、最终 `production-acceptance3.json`、`production-navigation.json` 和 `final-production.json`。

回退：后端配置/用户服务备份 `/home/liuzhe/mona-hosted-work/backups/20261106-model-admin-v23`；前端旧 root/include 对应 `/var/www/mona/backups/model-admin-20261106-v24`；Auth 导航原文件 `/opt/mona-auth-backups/work-model-admin-nav-20261106/index.before.html`。只恢复核对后的配置/路由/静态 HTML，先确认 Work 空闲，不能用旧数据备份覆盖用户当前状态。

## 代码与后续

主仓分类提交：`261927354`（素材与样张验证）、`f3922052b`（隐藏按钮）、`638847886`（模型管理与网络边界）、`1311bb8fc`（配置页面与入口模板）；Auth 独立仓 `1268e0c` 仅一行导航，原有未提交 HTML 及其他文件保持。均未推送。

Codex 下一步仍是专用程序/凭据和权限配置、Hosted 工具适配、Auth 预扣/结算/未知用量桥及实际隔离收费验收，详见 [接入评估](hosted-work-codex-cli-integration-20261106.md)。微信网站应用及未配置的安全解析、生成模型、检索依赖不在本轮冒称可用。
