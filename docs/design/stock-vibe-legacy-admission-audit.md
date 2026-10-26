# 旧股票任务受理与收尾入口审计

审计日期：2026-10-16。此文档按当前 Mona 源码只读定位旧股票的新任务受理、调度、恢复、在途收尾和历史读取。没有修改旧股票处理代码，也没有执行旧金融任务。

## 新任务受理入口

| 入口 | 实际行为 | 代码位置 |
| --- | --- | --- |
| Services 诊股 HTTP | `POST /api/stock/diagnosis` 默认 `execute=true`；先创建持久记录，再在本次 HTTP 请求内 `await service.execute(...)`。`POST /api/stock/diagnosis/{diagnosis_id}/retry` 对失败/取消记录递增 attempt 并再次执行。它们不经过 Gateway AgentLoop。 | 路由注册在 `mona/services/server.py::create_services_app`（约 269 行，股票路由约 431–490 行）；处理在 `mona/services/stock/api.py::handle_stock_diagnosis_create`（446 行）、`handle_stock_diagnosis_retry`（593 行）；执行在 `mona/services/stock/diagnosis.py::DiagnosisService.create`（1228 行附近）、`retry`（1378 行）、`execute`（1492 行）。 |
| Gateway WebSocket workflow | `run_workflow` 按 room 的 active revision 或同 room 的 package template 新建 run，再异步调用 `WorkflowRunner.run`。股票隐藏 room 仍是 room；`_workflow_room_context` 检查 room 类型，但不做 stock-room 专属拒绝。WebSocket `message` 另可进入 Gateway AgentLoop。 | `mona/channels/websocket.py::_workflow_room_context`（5236 行）、`_handle_run_workflow_envelope`（5443 行）、协议分发（`run_workflow` 约 6374 行，`message` 约 6390 行）、`_handle_message`（2147 行）。 |
| Agent 工具直接启动 | `StockResearchStartTool.execute` 直接在 Gateway 中启动隐藏股票 room 的深度研究 run；会返回同证券未终态 run，而不是创建第二个同类 run。`StockScreenRunTool.execute` 在没有 `workflow_run_id` 时调用 `_start_workflow` 创建选股 run；在已有 workflow context 时则调用确定性筛选并写产物，是旧 run 内的步骤。打包选股 Agent allowlist 包含 `stock_screen_run`。 | `mona/agent/tools/stock_research.py::StockResearchStartTool`（116、139 行）；`mona/agent/tools/stock_selection.py::StockScreenRunTool`（495 行）、`_start_workflow`（约 590 行）、`execute`（665 行）；allowlist 在 `mona/agents/com.mona.a-share-team/com.mona.stock-selection-analyst/agent.json`。 |
| 定时注册与触发 | Gateway pack bootstrap 创建隐藏股票 room/模板，注册每日 review 和已保存选股策略的 cron。触发后 `_execute_workflow_run_cron` 创建新 workflow run。Gateway 启动时还会检查并补发当天遗漏的 review。保存策略的 Agent 工具和 WebSocket schedule envelope 都能注册未来任务。 | `mona/agent/pack_bootstrap.py::ensure_stock_pack`（91 行）、`sync_stock_review_cron`（247 行）、`sync_stock_selection_cron`（317 行）、`sync_all_stock_selection_crons`（344 行）；`mona/cli/commands.py::_maybe_catch_up_stock_review`（772 行）、`_execute_workflow_run_cron`（824 行）、Gateway `on_cron_job`（1121 行附近）；WebSocket `_handle_sync_stock_selection_schedule_envelope`（5581 行）；`StockScreenStrategySaveTool.execute`（`mona/agent/tools/stock_selection.py` 820 行）。 |

旧 `/api/stock/*` 路由实际注册在 `mona/services/server.py`，不是 Gateway 的 `mona/api/server.py`。后者的 `/v1/chat/completions` 会调用 `AgentLoop.process_direct`，但它本身不注册这些旧股票 Services 路由。因此只在 Gateway 或新 UI 禁用入口不足以阻止 Services 诊股请求。

`StockResearchStartTool` 类存在，但在当前打包 Agent allowlist 搜索中未找到其显式引用；类级入口明确存在，具体生产模型可达性需结合运行时 Agent 配置再核实。`stock_screen_run` 在打包选股 Agent 中明确启用。

## 已接受任务的收尾和恢复

| 状态/动作 | 当前行为 | 切换时的边界 |
| --- | --- | --- |
| Workflow 新建 | `WorkflowRunner.run` 持久化一个新 run；活动 room 冲突时拒绝第二个 run，不将其排队。 | 这是 WebSocket、Agent 工具与 cron 共用的 run 型新任务入口；Service diagnosis 不经过它。 |
| Gateway 启动恢复 | `AgentLoop.run` 启动时调 `SubagentManager.recover_jobs` 与 `recover_workflow_runs`。queued AgentJob 会重新启动，running AgentJob 标失败；queued workflow run 自动 `resume`，running workflow 被标失败而不盲目重放；未过期的 `waiting_approval` 保留。 | 若要保留已接受任务，不能全局关闭恢复。queued 恢复可能在切换后开始执行；要停掉它必须按旧股票 room/workflow 精确处理，不能影响其他任务。 |
| 审批与步骤重试 | 对已有 run 的 `resolve_workflow_approval` 会继续 run；`retry_workflow_step` 会重试已有 run 的步骤。两者不创建新 workflow id，但可能继续产生工具副作用。 | 需要区分已接受 run 的明确继续/重试与全新任务提交；应由切换状态策略决定哪些旧 run 可继续。 |
| 旧选股步骤 | `StockScreenRunTool.execute` 有 workflow context 时在原 run 内执行引擎并写入 `selection.json`；不应因关闭外部新建而打断已启动的选股 workflow。 | 对工具只拦无 `workflow_run_id` 的新建分支，或由 run 级策略对已接受 run 作精确白名单。 |
| 旧 AI 诊股步骤 | `submit_stock_diagnosis_semantic` 只允许带 workflow/job context 调用；它会校验当前 run/evidence，然后调用旧 `DiagnosisService.create/retry/execute` 完成该 workflow 的诊断产物。 | 它是既有 workflow 的提交/收尾步骤，不是外部新 workflow 创建入口。若仍允许旧 run 收尾，不要全局禁用 `DiagnosisService.execute`。 |
| Services diagnosis 中途状态 | HTTP handler 在请求内同步执行；DiagnosisStore 有 `queued/running/...` 持久状态。本次代码定位没有发现它像 AgentJob/workflow 那样的 Gateway 启动恢复路径。 | 不要将诊断记录的历史 queued 状态误认为已有自动恢复保证；如果需要恢复，必须另作明确设计，不能由新架构重放未知写入。 |

关键代码：`mona/agent/workflow.py::WorkflowRunner.run`（1295 行）、`resume`（1205 行）；`mona/agent/loop.py::AgentLoop.run`（1802、1805 行触发恢复）；`mona/agent/subagent.py::recover_jobs`（2154 行）、`recover_workflow_runs`（2224 行）、`_reconcile_run`（2256 行）。WebSocket 的历史读取、取消、审批、步骤重试分布在 `_handle_get_workflow_run_envelope`（6054 行）、`_handle_cancel_workflow_run_envelope`、`_handle_resolve_workflow_approval_envelope`（5956 行）和 `_handle_retry_workflow_step_envelope`（5833 行）。

## 历史读取和非研究后台刷新

诊断 `GET /api/stock/diagnosis`、`GET /api/stock/diagnosis/{id}` 与 outcome、选股结果/历史、报告列表和详情，以及 Agent 工具 `stock_research_status`、`stock_screen_read`、`stock_report_read` 和 WebSocket `get_workflow_run`，都是已存在对象的读取入口。它们应与新建/重试入口区分，不能因为禁用旧任务受理而一并抹掉必要历史访问。

`POST /api/stock/research/preflight` 只构建不可变证据上下文；handler 文档明确说明它不创建 workflow run。`/api/stock/intraday` 和 `/api/stock/intraday/stream` 也不是研究 run：前者按需拉取行情，后者建立订阅并在订阅期间启动每证券刷新协程，断开后停止。它是旧数据后台刷新，不是研究调度；如产品切换要求停止所有旧数据请求，需单独决定，不应误归为 Agent 任务队列。

## 2026-10-17 工具执行门禁补充

对旧 Agent 工具调用链复核后，`mona/agent/tools/stock_query.py::StockQuoteTool.execute` 直接调用进程内 `EastMoneyProvider.quote`；本模块没有请求本机 Mona Services 的 HTTP adapter。因此，不存在可加 trusted drain header 的旧行情 HTTP 请求；Services gate 继续拒绝非 legacy 的旧 live GET，旧查询仅能在 Registry 持可信 `workflow_run_id` 且该 run 已登记为 draining 时收尾。`ToolLoader` 在非 legacy 时隐藏旧金融执行工具，历史读取白名单保留；`ToolRegistry.execute` 在实际调用前再次检查 ownership。该门禁没有启用正式 ownership 状态，也没有改变正式切换门槛。

## 最小收口点

1. run 型新任务至少在股票专属条件下收口到 `WorkflowRunner.run`，覆盖 WebSocket `run_workflow`、直接 Agent 工具和 cron；保留必要的历史查询与既有 run 的显式恢复/收尾策略。
2. Services 诊股 create/retry 独立收口，因为它们不经过 `WorkflowRunner` 或 Gateway HTTP。
3. 停止未来自动任务时同步处理 `ensure_stock_pack`/策略 schedule 恢复、schedule 更新入口和 missed-review catch-up。仅移除前端按钮不够。
4. 启动恢复应以 stock room/workflow/job 身份筛选；不能关闭全局 queued AgentJob/workflow 恢复。被接受的 queued run 是否继续必须由切换策略明确决定。
5. 保留只读历史边界；intraday 刷新另设决定，不与研究任务混为一谈。

## 正式切换状态

正式切换门槛未达。本次审计只记录事实，不修改旧入口、不冻结、不迁移、不切换执行权。开发计划的 T12 仍未完成；计划 7.1 的真实调用链/依赖、安装与生命周期、模型桥接、完整业务链四道门槛仍有未完成项。正式切换前仍须先关闭新旧业务的新任务受理，再处理旧 cron、排队和在途任务、未知结果与历史只读边界；不能以本审计代替门槛验收。

## 2026-10-17 维护编排与在途调用闭合

后续开发已增加 `mona/services/stock_cutover.py` 与显式存储根的 `python -m tools.stock_vibe.cutover` 维护入口。status 只读；freeze 在 owner 的同一 admission 锁内盘点 workflow / AgentJob / 旧诊断与旧工具调用，再暂停旧股票 cron。commit 重新盘点 queued / inflight / unknown / draining，核验实际归档 manifest、绑定原生 source receipt 与实际产物的四份独立证据，在同一 owner 锁内最终重验后提交。未知或未完成项阻挡切换，不由调用方传入的零计数替代实际盘点。

Registry 原先短 admission 只覆盖“开始调用”的瞬间，不能覆盖已经 await provider 的 direct / generic 工具调用。现复用唯一 owner JSON 的有界 `active_legacy_calls`：await 前短锁登记，finally 短锁清除，不跨 await 持锁。freeze 保存已有调用快照；任何遗留调用都作为 unknown 阻挡 commit。崩溃遗留记录不自动清理或重放，需要人工核验。

白名单迁移现接受显式实际 workflow-runs 根，能归档 app-data/runtime/workflow-runs；不把旧工作流或报告转换成 Vibe 任务，不复制启用状态。只读归档 API/UI 已接入，旧 Agent 工具与 HTTP / WS / workflow / job / cron / 恢复路径保留门禁。

隔离测试 39 项通过（cutover、Registry、archive、owner Store）：真实异步 StockQuoteTool 分别在 Mona direct 与 generic 上下文阻塞，freeze 捕获在途 lease、commit 被挡，工具完成并清理后才可提交；另覆盖 schema-1 兼容、崩溃后 lease 阻挡、迁移、重启与受支持版本恢复。ruff 通过，CLI help 可执行。上述是临时存储根的验收；没有对真实用户根执行冻结、迁移、提交或回滚，四道正式门槛仍未据此自动通过。
