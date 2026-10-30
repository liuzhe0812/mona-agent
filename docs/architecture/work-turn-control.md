# 普通 Work 轮次控制

- 状态：Accepted / Implemented
- 适用范围：桌面普通 Work 的 WebSocket 主轮次
- 日期：2026-10-30

## 身份与所有权

`MessageBus.work_turns` 持有进程内的 `WorkTurnController`。一次 WebSocket 外层 `_dispatch` 实际取得会话锁后，创建唯一 `turn_id`，绑定当前 Task、真实有效会话 key、原 chat ID 和可选 input ID。

`turn_id` 表示本次执行；可跨轮复用的产物或目标 `task_id` 不决定停止范围。身份进入运行状态、重连快照、文本与推理流和终态。客户端忽略已退役轮次的迟到状态；旧轮的空闲状态不能结束新轮。

普通直聊、命名 Agent 直聊和文档路由使用外层 Task 身份。纯房间子任务没有主轮次时，不伪造主轮身份，继续使用已有 job/workflow 精确停止入口。Code 的执行与存储协议保持独立。

## 精确停止

UI 使用 `stop_work_turn`，携带原 `chat_id`、稳定 `request_id` 和 `expected_turn_id`。服务端核对连接授权、会话订阅和原轮次后执行，不退回会话级 `/stop`。

`work_turn_stop_result` 返回原身份及以下结果：

| outcome | 含义 |
|---|---|
| stopped | 所绑定宿主 Task 和可确认的收尾已结束 |
| already_finished | 原轮次已结束，没有停止后来轮次 |
| unknown | 原轮次或部分活动结果尚未确认，不自动重放 |
| unsupported | 当前活动没有可核验的主轮身份，应使用对应任务入口 |

手工输入 `/stop` 继续保留原会话级命令语义，其他 channel 不强制使用本协议。

## 清理与未知结果

精确停止只取消、等待所绑定的 Task，由该 Task 已有的 `finally` 清理其拥有的资源。不因同属一个会话就广播取消子任务、后台进程或终端操作。

本轮宿主清理期间，同一有效会话的新轮次不能启动。清理超时或异常时保留阻塞和原身份，不把超时当成停止成功；晚到清理确认后自动收敛，向所有窗口发布原轮空闲状态，再放行后续执行。

若宿主已收尾但仍有无法证明属于本轮的其他活动，返回 `unknown` 和诊断标志 `external_unknown`，不误停它们。该情况下可释放本地清理阻塞。停止不保证撤销已经产生的文件或远端副作用。

已结束身份仅保留有界的最小记录；释放 Task、取消回调和清理回调，避免历史身份保留整个执行上下文。

## 验证

最近回归位于 `tests/agent/test_work_turn_control.py`、`tests/channels/test_websocket_work_turn_control.py`、`webui/src/tests/mona-client.test.ts` 和 `webui/src/tests/useMonaStream.admission.test.tsx`。

必须覆盖旧停止不影响新轮、同一 goal 的不同轮次、会话 key override、清理期间不放行新轮、清理晚完成、多窗口状态收敛、没有主轮身份时不回退、跨会话迟到回执隔离。
