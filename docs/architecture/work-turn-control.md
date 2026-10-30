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

## 引导输入状态

普通 Work 引导使用稳定 `input_id` 和明确的 `target_turn_id`。不携带目标字段的普通发送继续沿用原消息路径；目标字段为空、无法核对或属于已结束轮次时，不能把引导改投成新任务。讨论及结构化多智能体派发使用各自入口，不借引导绕过主轮边界。

`work_input_state` 按原 `chat_id`、`input_id` 及声明的目标轮次返回以下状态。状态仅在当前进程有效，不是持久 `follow_up` 协议：

| state | 含义 |
|---|---|
| accepted | 输入已进入服务端内存队列，尚不代表模型已收到 |
| consumed | 输入已进入正式执行或合法注入边界，不再自动恢复为待发 |
| paused | 原轮停止前尚未消费，原输入保留等待用户操作 |
| rejected | 本次输入未进入执行，界面保留原内容和附件 |

客户端接纳后保留并锁定原队列项，消费后才移除。暂停输入只有显式 `resume_input=true` 且原 ID 仍处于暂停状态时才能再次接纳；重复接纳不重复投递，未知恢复 ID 不建立新执行。

WebSocket 准备完成后、进入 pending queue 前及异步资料准备后的消费边界，均重新核对原目标和输入状态。精确停止与手工 `/stop` 都暂停相关已接纳但未消费的引导，包括仍在 Bus 或等待锁的项；取消收尾不把它们重投为新任务。正常完成的已接纳剩余输入可沿原 next-turn 路径继续，消费回执仍关联原目标。

进程内账本不保存正文或附件内容，最多同时保留 4096 个未退役引导身份；已消费身份在其实际执行轮次结束后退役。旧目标重放仍被已结束轮次边界拒绝，未知 ID 的恢复不会重新执行。容量满时明确拒绝新增引导，保留已有接纳与暂停状态。

退役后另保留最多 4096 条最小消费或拒绝状态，用于同一进程重新订阅时核对丢失的回执，不占待处理额度。终态观察缓存超出保留范围不代表可以重新执行：旧目标仍拒绝，未知恢复 ID 仍拒绝。重新 `attach` 会话时回放当前待处理状态及这段有界终态；普通发送不逐条回放全部观察缓存。

## 验证

最近回归位于 `tests/agent/test_work_turn_control.py`、`tests/channels/test_websocket_work_turn_control.py`、`webui/src/tests/mona-client.test.ts` 和 `webui/src/tests/useMonaStream.admission.test.tsx`。

引导生命周期回归位于 `tests/agent/test_work_input_lifecycle.py` 和 `tests/channels/test_websocket_work_input_state.py`，覆盖停止与消费交错、资料准备期间停止、队列满溢、原轮结束后的剩余输入、同 ID 显式恢复、优先命令结算和容量回收。

必须覆盖旧停止不影响新轮、同一 goal 的不同轮次、会话 key override、清理期间不放行新轮、清理晚完成、多窗口状态收敛、没有主轮身份时不回退、跨会话迟到回执隔离。
