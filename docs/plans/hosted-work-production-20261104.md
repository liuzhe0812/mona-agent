# 线上工作台生产发布记录（2026-11-04—05）

## 当前结论（2026-11-05，UTC+8）

本次 Qwen 共享工作台发布与功能验收已完成。Ubuntu 管理网络已恢复，原 v5 经修正切换至 v8；下方 11 月 4 日的网络阻塞和 v6 操作步骤为历史记录，不再执行。云同步按用户要求暂不接入，未开放尚未完成共享钱包计费的 Codex，微信网站应用仍待运营配置。

- Ubuntu：`/home/liuzhe/mona-hosted-work/releases/20261105-shared-work-v8/content`，PID `4147521`、NRestarts=0，原 `config/operator-accounts-v2.json`、`state` 和受限 Key 保留。
- v8 包：`output/hosted-work/shared-release-20261104/work-shared-v8.tar.gz`，44,110,794 字节、4,118 个清单文件，SHA256 `77b066dfbb893449b55cbb9316f578038e3bb7ad46a42aac05e6b1ce39300467`。配置、单元覆盖和状态备份为 `backups/20261105-shared-work-v8`。v8 激活未留下本地 JSON 回执，随后只读逐项核实全部文件、健康、版本及原数据，未重复切换。
- VPS 公共静态资源：`/var/www/mona/work-releases/20261105-shared-work-v7/content`，3,548 文件逐项摘要一致。v8 与 v7 全部前端产物逐字节相同，因此继续使用这份静态 release；工作台主页面、API 和按账号隔离的工作数据仍在 Ubuntu；账号认证继续使用 VPS Auth。
- Work 代理：`/opt/mona-work-proxy-releases/20261105-shared-v7-static/work-locations.conf`，SHA256 `93fc5b522d53f73ed8d0c346623537602f0e034f34e17903b7fa4c384c07ac05`；回退备份 `/var/www/mona/backups/work-static-20261105-v7`。只热加载 Nginx，master `420299` 与本轮开始时相同，官网静态 root 仍是 `workspace-nav-20261103-v5`。

## 修正范围与复用说明

仍直接使用原桌面的 ThreadShell、会话区、右栏及三个 Office 编辑器，没有另写一套界面。共享代码的必要修正包括：同一版本 checkpoint 复用同一字节、版本单调更新、恢复文档不抢焦点、Word summary 协议，以及新单元格读取只访问原文件的有效范围并保留现有编辑记录。Sheets 严格原始边界回归 14 项通过。桌面成品未重测，不能将共享路径的复现等同于所有已发布桌面版本必然发生同一故障。

线上适配修正包括客户端逻辑任务编号与实际执行编号的关联、只以 Mona 自称的人设、Office 兼容同值冗余查询模式和明确调用说明。主页面允许原组件的内嵌字体；大静态脚本改为 VPS 直供，解决经隧道加载时的慢传输和 HTTP/2 中断。没有修改余额、订阅、支付、设备或云同步逻辑。

代码分类提交：`ec243435d`、`33c64f79d` 为前轮基础修正；`82faee739` 为表格范围；`1a86e7b78` 为共享资源与验收诊断；`0104783cd` 为线上 Office 参数兼容。此前未通过的 v7 候选包未切入生产，实际 v7 使用的是 `work-shared-v7-checked.tar.gz`，SHA256 `1ff2d5cb4666b4d2edbcc5df16a3b7ab77ae04a21882e9919cbe33ecf0e474a0`。

## 真实验收证据

- `production-v6-static-20261105.json`：真实“你是谁？”只以 Mona 自称，界面恢复发送；Word 人工编辑、真实 AI 追加、保存、导出并核对文档 XML、刷新恢复全部通过。相关 Word 产物此后未变，沿用这些证据，没有反复重派已确认的写入。
- `production-v8-final-20261105.json`：passed=true、mocked_responses=false。Excel 真实模型编辑后读取 `[6, 7, 42]`，导出包含实际公式，刷新后再次读取 `[6, 7, 42]`；PPT 真实模型写入后导出 XML 含标记；思维导图手改、自动保存及刷新恢复通过。
- 同轮实际 exec 阶段停止，任务为 cancelled、工作区保存确认，停止后发送框恢复；另一账号访问会话和 Office 均 404；退出后原网站会话 401，编辑器状态清空。页面异常、失败 HTTP 请求和传输失败均为 0。
- 附件、真实模型生成文件与浏览器下载沿用原任务 `003157cabdd592ef53142b0dd8f4c379`，SHA256 `02c048979ee690ec86b077f8c31c42eca8a3da438179b13eddcc628888d94762`；刷新未重新发送消息。最终新派发仅 Excel、PPT、停止三条消息。
- 使用既有专用普通测试账号和既有管理员的短期网站会话，角色未改。每轮会话已撤销，普通测试账号余额、预扣、活跃计费请求及钱包版本仍为 0。密码登录和桌面成品不在本轮重测范围。

上述 JSON、实际导出的 docx/xlsx/pptx、截图及失败记录保留在 `output/hosted-work/shared-release-20261104/`。最终控制台仍有 16 条上游 Univer 隐藏布局的列宽日志；没有页面异常或失败请求，所测内容、导出与恢复均通过。本轮不扩大到这项布局日志修复，也不把它写成“全部控制台无错误”。

## 最终生产核对与回退

`final-ubuntu-20261105.json` 核对：v8 切换前 9 个会话、14 条任务、5 条文件的全部字段与备份逐项相同，验收仅新增至 11/18/5；无 running、cancelling、unknown 任务或未确认文件操作。Docker PID `78383`、Work 隧道 `423172`、原 8 个容器的 ID/状态/启动时刻均未变化，四个暂停 Worker 仍暂停，无额外 Work 容器。自有候选单元 `mona-work-candidate-v2-20261104` 已停止，数据保留。

`final-vps-20261105.json` 核对：Auth `389486`、One API `310825`、MariaDB `420210`、Nginx master `420299`、FRPS `743`、Relay `275482`、Work visitor `367299/367306` 的 PID 与启动时刻均与本轮开始相同；除 Work include 外，其他站点配置逐字节不变。Nginx/MariaDB 在本轮开始前已与昨天的 PID 不同，未沿用旧快照冒充当前事实。

需要回退时先确认没有执行中或未知任务，只恢复对应备份中的运营配置和 systemd 覆盖并启动原 Work release；不要用旧状态快照覆盖发布后的用户数据。VPS 仅恢复对应 Work include 并通过 `nginx -t` 后热加载。无需重启 Docker、恢复暂停 Worker 或操作 Relay。

完整清单见 `deploy/hosted-work/shared-release-20261104.json`。剩余边界为微信网站应用及凭据、Codex 专用登录与共享钱包真实结算，以及未验证的无人登录整机重启/密钥环恢复；不代表这些项目已随 Qwen 验收上线。

## 2026-11-04 过程记录（历史）

用户已授权上线，并在真实使用后追加两项要求：修复任务不结束；Mona 以有个性、有判断的角色交流，只以 Mona 自称，不把“助手”、入口名称或部署方式作为身份。本轮仍不接云同步，不开放未完成计费的 Codex，不改余额、支付、订阅和设备。

### 当时已实际部署

- Ubuntu 当前最后核实为 `/home/liuzhe/mona-hosted-work/releases/20261104-shared-work-v5/content`，PID `3659232`。主配置仍为 `config/operator-accounts-v2.json`，原 `state` 目录保留。初次切换前的 3 个会话、3 条任务历史摘要逐项一致；测试使用另建的专用验收会话。
- VPS Work 代理使用 `/opt/mona-work-proxy-releases/20261104-shared-v1/work-locations.conf`，补齐 Work/Office WebSocket Upgrade；其余站点配置只替换该 include，限流区保留，新增专用 Connection map。`nginx -t` 通过且只热加载，master PID 仍为 `343378`。
- Linux Office 资源在 `/home/liuzhe/mona-hosted-work/resources/20261104-shared-editors`，通过 `MONA_RESOURCES_DIR` 指定。包含三份真实模板与经清单核对的 Linux x64 sidecar。程序 11,836,272 字节，SHA256 `35f2d758217d5791fe53bad2dac919a292db538c93d3f7cb06611c6fb9508930`，由锁定源码和逐文件校验的离线依赖以已有 Rust 1.95 构建，为 static-pie ELF；不安装或重启 Docker。
- 旧版基本 Work 与每轮修正的配置、状态备份均保留。首次完整回退点 `/home/liuzhe/mona-hosted-work/backups/20261104-shared-work-v2`；当前 v5 切换前备份为 `backups/20261104-shared-work-v5`。VPS 备份 `/var/www/mona/backups/shared-work-20261104`。
- 发布使用独立 checkout `408f82f5f` 加本任务的明确修复，没有使用主树未提交的模型选择、Office CSS 或其他任务改动。该完整源码与旧生产基础存在共享依赖差异，不能声称只包含三个 Work 提交。

### 当时已完成的真实验收

- Ubuntu v5：213 passed / 2 skipped；跳过项为 Windows 专属否决路径和单独执行的浏览器测试。另真实 Office/gVisor 测试 1 passed：两账号同名工作簿分别读出 42/48，实际修改后重算为 21，无网络、无宿主挂载、文件互不可见，关闭后精确容器回收。
- 候选与生产的真实 Qwen 均完成附件读取、写入、交付，浏览器实际下载内容与 SHA 一致；刷新不重复派发。生产下载 SHA `02c048979ee690ec86b077f8c31c42eca8a3da438179b13eddcc628888d94762`。
- 官网网站会话可直接打开共享界面。Word 的人工修改真实保存，模型也已通过实际 Office 通道在原文档中插入标记。但随后发现版本重复序列化冲突和终态编号错配，不能将 Word 导出乃至整轮发布验收记为完成。
- 专用测试账号仍为原有普通测试账号及既有管理员，没有改角色。各轮临时网站会话均已撤销；普通测试钱包始终为零，预扣、活跃请求和版本均未变。生产浏览器失败记录原样保留于 `output/hosted-work/shared-release-20261104/production-v*.json`，没有当作成功。

### 当时已修复但尚未发布的 v6

1. 服务端保留客户端的逻辑 `task_id`，真实执行仍由独立的 `turn_id/run_id` 追踪；开始、流式、交付与结束使用一致关联。此前错误地用 run_id 覆盖 task_id，界面丢弃结束事件，因此一直显示运行中。
2. 固定身份改为 Mona：温和、敏锐、可靠、有自己的判断和好奇心；自然直接，不奉承、不套客服开场。移除身份中的在线/Work/隔离描述，工具描述改为实际可用操作；物理安全边界继续由服务端执行。Office/画布契约只在实际注入对应工具时加入。
3. 同一文档版本只进行一次成功序列化，重复保存复用相同字节；载入版本保留原文件字节，每次传输复制缓冲区，失败可重试。保留后端“同版本不同内容必须拒绝”的检查。
4. Office 初始快照更新沿用现有版本单调保护；重复 attached 只合并新增编辑器，不再抢走当前文档焦点。补齐 docs summary 的 warnings 字段，保持严格协议校验。

代码提交：后端及发布契约 `ec243435d`；前端下载与编辑器保存 `33c64f79d`。本地后端 207 passed / 8 skipped，共享会话收尾回归 28 passed，OfficeHost 10 passed，下载/菜单 5 passed，Office 三入口及版本缓存相关 38 passed；干净候选 TypeScript、Ruff 和完整构建通过。以上不是 v6 生产验收。

v6 包：`output/hosted-work/shared-release-20261104/work-shared-v6-final.tar.gz`，40,642,648 字节、3,998 个清单文件，SHA256 `5a1c5d2833a96fedd7977a88beed12e1133ba2829d3e415cbb1cc4c70d8cb27c`。含已知旧 hash 静态资源以兼容已打开页面。仅需继续自身 Work 服务切换，不迁移数据库或改 Auth。

### 当时网络阻塞与继续方式（历史，不再执行）

准备 v6 时电脑切至手机热点 `192.168.43.15`，Ubuntu `172.31.3.176:22` 超时；VPS 的现有路由也不能管理该主机。官网仍返回正常页面，但 v6 没有切换，不能宣称用户刚报告的两项故障已在线修复。需要恢复该管理网络，或由用户提供已存在的其他管理入口。

恢复连接后先重新核对真实状态与包 SHA、确认没有运行中或未知任务，再使用已准备的切换流程。它会备份配置和状态，只更新 Work 的工作目录/前端目录，失败自动回到 v5；不恢复整个状态库覆盖用户新数据。无需再次申请发布权限。

v6 完整包和经过语法检查的激活脚本也已放在 VPS 受限目录 `/opt/mona-work-staging/shared-20261104-v6/`（目录 700、文件 600），包 SHA 已在 VPS 再次核对一致。脚本 `activate-v6.py` SHA256 为 `f2a41dbf400ef1d8b72d8b1177b08cf96795421515006c80f41cc04ef26a39c2`。如用户选择在 Ubuntu 本机操作，可使用已有的 VPS SSH 认证方式，按以下顺序取回并执行；未取全或 SHA 不符会拒绝切换：

```sh
scp root@47.117.69.105:/opt/mona-work-staging/shared-20261104-v6/work-shared-v6-final.tar.gz /home/liuzhe/mona-hosted-work/builds/20261104-shared-editors/
scp root@47.117.69.105:/opt/mona-work-staging/shared-20261104-v6/activate-v6.py /home/liuzhe/mona-hosted-work/builds/20261104-shared-editors/
python3 /home/liuzhe/mona-hosted-work/builds/20261104-shared-editors/activate-v6.py
```

脚本使用既有环境文件和 Office 资源，不重新配置 Key、端点或 Docker。存在运行中/未知任务时会拒绝；先核对结果再继续，不能删记录强行放行。切换成功仍需真实功能验收。

必须继续完成：真实“你是谁？”及界面正常结束、Word 保存/导出、Excel/PPT 真实编辑与导出、画布保存恢复、实际执行中停止、另一账号拒绝和退出撤销。检查其他容器、暂停 Worker、Docker、Auth、钱包与 Relay 状态后才写上线完成。
