# 2026-11-05 线上任务流式、上下文和交付修复

状态：Work v15 已发布，真实任务验收通过；原失败任务没有自动重跑。

## 确认的原因

用户原 SGLang 美化任务为 `40c1253365acf9492ba486d6b6b523a0`，2026-11-05 15:19–15:22（UTC+8），运行 141.61 秒。原记录 `result.content` 明确为“当前请求内容超出模型可用上下文”，最后检查点 `tools_completed`、iteration=19。网页旧 `HostedWorkModel.context_window_tokens` 默认 32768，Runner 在下一轮请求前做本地预算检查而停止；不是模型本身被核实只有 32K。

原用量 423,836 输入 token 是多轮累计量，不是单次上下文。应用共享目录对该端点/模型登记 1,000,000 token；本次改用现有 `resolve_model_context_window_details`，未知仍使用应用统一默认来源标记，不加载个人配置、不调用桌面 IPC。旧显式值作为额外输入预算 cap，模型容量由目录解析。

原 `WorkHook` 每轮发送固定进度，未实现推理回调且未传工具调用状态。wire 又用通用 message 遮住具体失败原因并把它当工具进度展示；子进程关闭默认日志且父进程丢弃原始 stderr，因此日志里没有原始异常，但任务结果/检查点仍可定位。

原 PPT 工作副本为 37,003 字节，SHA256 `26d0cc98591c67cd321265628e7b2d2e686e44f6a4d3ab2e5a4271f11671d8d9`；第 9 版与检查点一致，savedVersion=null。最终再次核对未变；保留失败状态，没有把部分编辑视为完成、保存或导出。

## 最小复用

- Runner 原本已共用，本次不修改 `mona/agent` 核心循环。
- 网页 Hook 直接继承 `AgentProgressHook`，沿用推理提取、短文本流式、工具开始/结束与 Widget 生命周期；只在通道边界短化参数、去掉重复大结果及原始错误。
- Wire 映射为现有桌面事件并保留 task/turn/input/call ID。失败消息不伪装成工具调用，未结束的推理/文本流会关闭；unknown 不发成功终态、不自动重派。
- 运行与设置接口共用应用模型窗口解析；没有新建另一套压缩、记忆或图片存储算法，没有把宿主目录暴露给模型作为可读工作区。
- Office、全部前端、共享 Agent 文件与 v13 清单一致；没有部署其他任务的未提交编辑器或原生执行器代码。

## 真实验收发现并修复的交付缺口

v14 的真实新测试请求已越过旧容量，创建、预览、导出 3 页，但随后再次 `deliver_file` 时，网页只查 gVisor，找不到 Office 已导出的文档，触发安全停止。该 QA 运行 `267dffee4a3bb61444ebfa97a878924e` 保留 failed，不能写成上线成功。

v15 在原 `_EditorBus` 里为当前 run 的真实导出登记逻辑路径、大小和 SHA；`deliver_file` 只在命中登记并重新核验后复用应用 `DeliverFileTool`。共享 bus 按摘要去重，未登记文件仍走旧 gVisor stat/artifact/保存复核；不因同账号文件存在就交付。跨账号、跨会话、同会话新一轮、变化文件均不能借登记旁路。两次核对间的同长度改写也拒绝，显式再次 export 可登记新版本。临时工作区 ContextVar 在成功、错误后都恢复。

本轮登记仅覆盖本轮已导出的文件；历史轮文件若需要重新交付，可由新的明确请求再次 export，不新增跨轮直接读取授权。

## 验收与证据

Windows、Ubuntu/Linux 的流式/窗口/服务 34 项通过；交付/编辑器/Hook 28 项通过，两组包含重合的 Hook 测试。Ruff 通过。另一次补充边界执行里，旧 `test_uncertain_native_source_stays_blocked_across_users` 期待 model_pending，但上一版 Codex 未计费闸门先返回 billing_unavailable；该范围外旧断言未改，未冒称所有历史测试全绿。

真实生产第二次运行 `81668ca2a4e21e892da6bc52e39e9c29` 使用新请求，在同一 QA 会话的已确认三页文稿上执行核对、export、重复 deliver，不重做页面。结果 completed，4 次模型交互，单次上下文峰值 **76,811 token**，不是用累计量替代窗口。3 个调用均收到匹配结束，19 个 reasoning_delta / 4 个 reasoning_end / 4 个回答 delta；无固定“正在处理任务”，交付事件仅 1 次、turn_end 1 次。

实际下载 PPTX 并验证 3 个 slide XML，SHA256 `56ea7dcf238a331432943e68ee5887266529615d6a12b56f72c880714cff746f`。刷新只观察既有运行，没有新模型任务；后续只读浏览器确认编辑器恢复、过程可展开，无页面异常。观察器最初用文本选择器检查画布导致选择器失败，失败报告保留；改用实际画布/保存状态后通过，不代表产品恢复失败。

证据目录 `output/hosted-work/stream-incident-20261105/`：`failure-reason.json`、`original-office-checkpoint.json`、`production-v1.json`（真实失败）、`production-v2.json`（真实通过）、`observe-ui.json`、`final-state.json`。所有临时测试登录已撤销，测试钱包余额/预占/请求数/版本均保持 0。原用户文稿没有被重跑或覆盖。

## 部署与日志

最终 `/home/liuzhe/mona-hosted-work/releases/20261105-stream-work-v15/content`，PID 123126、NRestarts=0；5,600 个文件核验。备份 `/home/liuzhe/mona-hosted-work/backups/20261105-stream-work-v15`。归档链、摘要和详细状态见 `deploy/hosted-work/stream-release-20261105.json`。仅切换自身用户服务及前端目录配置，VPS、Nginx、官网静态目录未改。

任务结果新增 `diagnostic`：stop_reason、轮次、目录窗口与来源、单次上下文峰值、上游 HTTP 状态；异常额外记录阶段与异常类型。父进程仅按这些字段记录告警，不写提示词、工具正文、图片、原始 stderr、认证或供应商异常原文。子进程继续关闭默认日志，避免共享 Hook DEBUG 参数进入日志。旧运行没有新增字段，不补造历史日志。

Ubuntu 以 liuzhe 查看已知任务的脱敏日志，例如：

```bash
journalctl --user -u mona-hosted-work.service --since '2026-11-05 15:00:00' --grep 'Hosted Work run=267dffee4a3bb61444ebfa97a878924e' --no-pager
```

任务接口的 owner 校验仍保留，诊断不作为默认聊天正文。unknown 不自动解锁或重做。最终会话/任务/沙箱文件 15/27/6，无活跃/取消中/unknown 或未确认文件操作；Docker PID 78383、8 个原容器状态/启动时间、隧道和 VPS 原服务 PID 不变，四个 Worker 保持暂停。Qwen 继续免费，余额、支付、订阅、设备与云同步不变，Codex 仍未开放收费。

回退前先确认无活跃或待核对写入，只切回 v14/v13 的本服务配置/覆盖文件；保留新增用户状态，不用旧 state 盖写新数据。代码提交 `29af3fe1a`、`4f5702349`，未推送。
