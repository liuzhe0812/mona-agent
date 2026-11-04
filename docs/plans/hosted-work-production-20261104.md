# 线上工作台发布与阻塞记录（2026-11-04）

用户已授权上线，并在真实使用后追加两项要求：修复任务不结束；Mona 以有个性、有判断的角色交流，只以 Mona 自称，不把“助手”、入口名称或部署方式作为身份。本轮仍不接云同步，不开放未完成计费的 Codex，不改余额、支付、订阅和设备。

## 已实际部署

- Ubuntu 当前最后核实为 `/home/liuzhe/mona-hosted-work/releases/20261104-shared-work-v5/content`，PID `3659232`。主配置仍为 `config/operator-accounts-v2.json`，原 `state` 目录保留。初次切换前的 3 个会话、3 条任务历史摘要逐项一致；测试使用另建的专用验收会话。
- VPS Work 代理使用 `/opt/mona-work-proxy-releases/20261104-shared-v1/work-locations.conf`，补齐 Work/Office WebSocket Upgrade；其余站点配置只替换该 include，限流区保留，新增专用 Connection map。`nginx -t` 通过且只热加载，master PID 仍为 `343378`。
- Linux Office 资源在 `/home/liuzhe/mona-hosted-work/resources/20261104-shared-editors`，通过 `MONA_RESOURCES_DIR` 指定。包含三份真实模板与经清单核对的 Linux x64 sidecar。程序 11,836,272 字节，SHA256 `35f2d758217d5791fe53bad2dac919a292db538c93d3f7cb06611c6fb9508930`，由锁定源码和逐文件校验的离线依赖以已有 Rust 1.95 构建，为 static-pie ELF；不安装或重启 Docker。
- 旧版基本 Work 与每轮修正的配置、状态备份均保留。首次完整回退点 `/home/liuzhe/mona-hosted-work/backups/20261104-shared-work-v2`；当前 v5 切换前备份为 `backups/20261104-shared-work-v5`。VPS 备份 `/var/www/mona/backups/shared-work-20261104`。
- 发布使用独立 checkout `408f82f5f` 加本任务的明确修复，没有使用主树未提交的模型选择、Office CSS 或其他任务改动。该完整源码与旧生产基础存在共享依赖差异，不能声称只包含三个 Work 提交。

## 已完成的真实验收

- Ubuntu v5：213 passed / 2 skipped；跳过项为 Windows 专属否决路径和单独执行的浏览器测试。另真实 Office/gVisor 测试 1 passed：两账号同名工作簿分别读出 42/48，实际修改后重算为 21，无网络、无宿主挂载、文件互不可见，关闭后精确容器回收。
- 候选与生产的真实 Qwen 均完成附件读取、写入、交付，浏览器实际下载内容与 SHA 一致；刷新不重复派发。生产下载 SHA `02c048979ee690ec86b077f8c31c42eca8a3da438179b13eddcc628888d94762`。
- 官网网站会话可直接打开共享界面。Word 的人工修改真实保存，模型也已通过实际 Office 通道在原文档中插入标记。但随后发现版本重复序列化冲突和终态编号错配，不能将 Word 导出乃至整轮发布验收记为完成。
- 专用测试账号仍为原有普通测试账号及既有管理员，没有改角色。各轮临时网站会话均已撤销；普通测试钱包始终为零，预扣、活跃请求和版本均未变。生产浏览器失败记录原样保留于 `output/hosted-work/shared-release-20261104/production-v*.json`，没有当作成功。

## 已修复但尚未发布的 v6

1. 服务端保留客户端的逻辑 `task_id`，真实执行仍由独立的 `turn_id/run_id` 追踪；开始、流式、交付与结束使用一致关联。此前错误地用 run_id 覆盖 task_id，界面丢弃结束事件，因此一直显示运行中。
2. 固定身份改为 Mona：温和、敏锐、可靠、有自己的判断和好奇心；自然直接，不奉承、不套客服开场。移除身份中的在线/Work/隔离描述，工具描述改为实际可用操作；物理安全边界继续由服务端执行。Office/画布契约只在实际注入对应工具时加入。
3. 同一文档版本只进行一次成功序列化，重复保存复用相同字节；载入版本保留原文件字节，每次传输复制缓冲区，失败可重试。保留后端“同版本不同内容必须拒绝”的检查。
4. Office 初始快照更新沿用现有版本单调保护；重复 attached 只合并新增编辑器，不再抢走当前文档焦点。补齐 docs summary 的 warnings 字段，保持严格协议校验。

代码提交：后端及发布契约 `ec243435d`；前端下载与编辑器保存 `33c64f79d`。本地后端 207 passed / 8 skipped，共享会话收尾回归 28 passed，OfficeHost 10 passed，下载/菜单 5 passed，Office 三入口及版本缓存相关 38 passed；干净候选 TypeScript、Ruff 和完整构建通过。以上不是 v6 生产验收。

v6 包：`output/hosted-work/shared-release-20261104/work-shared-v6-final.tar.gz`，40,642,648 字节、3,998 个清单文件，SHA256 `5a1c5d2833a96fedd7977a88beed12e1133ba2829d3e415cbb1cc4c70d8cb27c`。含已知旧 hash 静态资源以兼容已打开页面。仅需继续自身 Work 服务切换，不迁移数据库或改 Auth。

## 当前阻塞与继续方式

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
