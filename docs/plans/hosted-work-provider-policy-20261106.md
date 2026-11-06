# 工作台统一提供者配置与滚动修复

日期：2026-11-06。后端 v25b、前端 v26 已上线，真实两角色浏览器验收通过。

## 行为

管理页只提供“自定义 API”“Codex CLI”，使用同一模型参数与计费表单。管理员选择 `billing_mode=free|wallet` 和 `billing_model`；具体单价由原 Auth 模型价表决定，不按提供者强制免费或收费。缺失计费选择的管理请求拒绝，新配置缺省 wallet；已有 Qwen 的 free 显式保留此前用户选择，之后可在管理页更改。

公共字段：显示名称、模型 ID、输入预算、最大输出、推理强度、计费方式和账务模型映射。自定义 API 另有平台标识、Base URL、已载入密钥的环境变量引用；Codex CLI 另有程序路径与认证方式，保留原生模型列表建议、登录说明和连接检测。切换提供者保留草稿，版本冲突阻止覆盖。保存同一配置版本，钱包/价表不另建。

`globals.css` 为桌面应用固定 html/body/root 不滚动，旧 AdminApp 没有内部滚动容器。本次只将管理页 main 改为 `h-full min-h-0 overflow-y-auto`，不改共享桌面样式。

| 提供者 | 计费选择 | 当前执行状态 |
|---|---|---|
| 自定义 API | free | 凭据就绪后可用 |
| 自定义 API | wallet | 共用余额桥未完成，拒绝执行，不回退免费 |
| Codex CLI | free | 执行接入未完成，暂不可用 |
| Codex CLI | wallet | 执行和余额桥均未完成，暂不可用 |

公共列表、设置、已保存模型恢复、父进程准入和 provider 构造共用 `model_policy`；不能只改页面文案。重复已接受请求仍先观察原结果，不因策略变化重派。Codex 的连接、执行和计费状态分开，连接检测文案不再把余额状态混进去。没有修改 Runner、现有原生执行器、价格、余额、订阅、支付、同步或设备逻辑。

## 验证

- Windows 后端 131 项通过/2 个链接权限跳过，Linux 候选 133 项通过。覆盖两种来源/两种计费、保存及非法选择拒绝、钱包模型隐藏/拒绝派发且没有执行/新任务、选择恢复、已接受请求不重派与原有权限/空闲/版本边界。连接文案随后单独修正，Linux 关联 27 项通过，不将其当作额外唯一用例。
- 前端最终 11 项通过；隔离源码 TypeScript 和构建通过，只复制三个本任务产品文件，没有夹带其他任务的 App、会话、Office 或原生执行器未提交修改。
- 真实管理员/普通用户/匿名请求通过：两条管理 API 普通 403、匿名 401；旧版本 409。1560×1000 与 760×520 均使用实际鼠标滚轮到页面底部，再滚到保存按钮；两提供者均可选择两种计费方式。
- Qwen 仅保存一次原值，运行配置同步；价格只在未保存表单中映射已有模型，三个金额/版本与原表相符，随后恢复原映射，没有价格写入。Codex 草稿实际 wallet→free→原 wallet，除了 mode 不改任何字段；全过程执行/public_enabled=false，Qwen 始终不变。
- 全部临时登录撤销，测试钱包四项保持 0；无模型任务、CLI 检测或调用。恢复使用已确认版本和 CAS，不覆盖并发管理员修改。

首次浏览器报告在已通过两窗口滚动后，因凭据文案选择器仍匹配旧文本而失败；没有管理员配置写入，登录已撤销。只修正验收选择器后完整通过，首次报告保留为失败：`output/hosted-work/model-policy-20261106/production-acceptance.json`；最终为 `production-acceptance2.json`。

## 发布与回退

| 范围 | 最终事实 |
|---|---|
| Work 后端 | `/home/liuzhe/mona-hosted-work/releases/20261106-model-policy-v25b/content`，PID 672347、active、NRestarts=0；5,641 文件核验 |
| 后端清单 SHA | `3a3892566d21e2868bba7f094d4414c36e68d5da59e13aa5bc1ac3fc5c951e3c` |
| 前端 | `/var/www/mona/work-releases/20261106-model-policy-ui-v26/content`，5,171 文件，465 Office 文件不变、旧 hash 保留 |
| 静态清单 SHA | `d3e13c020b6cdecdae450039d4ec58b5f61c0a37e264f411ab9295614f182fb1` |
| Work include | `/opt/mona-work-proxy-releases/20261106-model-policy-ui-v26/work-locations.conf`，SHA `ccded410284899754e8acf496ea927f32b503c21428a8db76f9fc4bca316618b` |

按空闲和无 unknown 检查后备份状态、配置、服务覆盖文件，先 v25 字段/闸门，再 v25b 连接文案，Nginx 仅热加载 v26。配置 600，25 会话/31 任务/6 文件保持，无活动/unknown。Docker 78383、隧道 423172、原八容器 ID/状态/启动时间及四个暂停 Worker保持；Nginx 420299、MariaDB 420210、Work visitor 367299、Auth 389486、One API 310825 保持。Auth 只签发/撤销自身验收登录，业务代码、价表、余额和官网首页保持；未操作个人 Relay。

v25 增量在 v23 上叠加 16 文件；v25b 仅修一处连接文案；v26 在 v24 静态上叠加 346 文件并保留旧资源。精确包 SHA/大小、生产核验和验收摘要见 `deploy/hosted-work/model-policy-release-20261106.json`，原始报告与包位于 `output/hosted-work/model-policy-20261106/`。

回退至 v23 使用 `/home/liuzhe/mona-hosted-work/backups/20261106-model-policy-v25` 的配置/用户服务文件；v25b 备份只回到 v25。前端使用 `/var/www/mona/backups/model-policy-20261106-v26` 的旧 include。先确认空闲，保留当前用户 state/数据库，不恢复旧用户数据。没有重启 Docker、恢复 Worker 或发布其他任务的未提交修改。

分类提交：`538b531d4`（计费配置/真实准入），`8180ac6a2`（统一表单/滚动/浏览器验证），未推送。Codex 执行适配与共用钱包桥仍待后续实现，本次不把配置管理上线当作收费线路已开放。
