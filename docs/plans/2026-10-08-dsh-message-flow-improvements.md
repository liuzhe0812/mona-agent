# Mona 消息链路与 DSH 对比：逐项评估及优化记录

日期：2026-10-08。状态：9 个评估子项完成；I1、I2、I5 窄子项与 I6 已逐项优化，其余未通过本轮实施门槛。范围：普通 Mona / Work 的消息链路；内置 Code 只作为已有能力参考，原生执行者保留自身运行协议。

DSH 参考为本地 `D:/liuzhe/Desktop/code/deepseek-harness-latest` 的源码快照；本文件的 DSH 包路径相对该目录。Mona 代码引用相对本仓库。未使用真实模型或生产业务数据做性能/故障注入。

## 1. 目标与执行规则

降低消息丢失、重复副作用和长任务上下文丢失的风险。每项先核对真实代码、解释 DSH 的处理方式和本项目业务差异，再决定是否执行。完成一项的必要回归后，才开始下一项生产改动。只读研究可并行。

工作树已有大量开发模块和运行器修改，本轮不还原、不覆盖、不捆绑整理。未授权发布、重启服务、迁移用户数据或执行真实业务操作。

评估通过需同时满足：

1. 有具体故障路径或可验证的资源问题，而不是仅因 DSH 使用了某个机制。
2. 可以在现有会话、运行器、渠道、工具或输入记录边界内完成，不迁移整个框架。
3. 保持模型与供应商选择、工具授权、Office/浏览器绑定、专家身份、附件正文及业务工具参数不变。
4. 保持当前目标、已接纳输入、已完成工具结果和原始历史；未知结果不自动重放。
5. 有接近故障的行为回归；协议改动同时覆盖发送端和接收端。

收益明确但当前最小方案仍会改变业务语义的项目，记录未通过的原因和触发后续评估的条件，不直接扩大实现范围。

## 2. 项目清单与顺序

| 编号 | 项目 | 优先级 | 评估状态 | 执行状态 |
|---|---|---|---|---|
| I1 | 上下文超限只恢复当前模型请求 | P0 | 通过：当前恢复会丢弃本轮已完成结果 | 已完成：3 项新回归通过 |
| I2 | 工具恢复区分未派发、已完成与结果未知 | P0 | 通过：当前 pending 无派发记录 | 已完成：3 项新回归通过 |
| I3a | 普通对话消息 ID、接纳回执及重复提交去重 | P1 | 收益通过，当前最小方案未通过业务边界 | 暂缓：需区分接收、接纳、分发与未知 |
| I3b | 普通对话待发队列的持久化与撤回确认 | P1 | 收益通过，直接迁移方案未通过 | 暂缓：需普通会话自己的输入生命周期 |
| I4 | 普通对话每次请求前的语义上下文治理 | P1 | 收益通过，直接回调方案未通过持久化边界 | 暂缓：需可恢复投影与结构化结果保护 |
| I5 | 图片计量与上下文估算口径 | P1 | 部分通过：先消除二进制被当文本的误计 | 已完成：6 项新回归通过 |
| I6 | 安全工具调用的并发上限 | P2 | 通过：只限制 Work 安全批次资源峰值 | 已完成：5 项新回归通过 |
| I7 | 近期图片的保真历史回放 | P2 | 当前默认回放方案未通过成本与截图新鲜度边界 | 暂缓：需任务级媒体策略 |
| I8 | 脱敏请求诊断记录与重建能力 | P2 | 本轮没有新增记录的必要证据 | 暂缓：保留现有诊断与检查点 |

最大迭代次数、防重复调用、按需加载工具和单轮 system 稳定性继续作为约束，不按 DSH 的不同默认行为删除这些保护。此前完成的 80% 轮前整理与取消 120 条门槛不重复实施。

## 3. I1：上下文超限恢复

### 优化前故障路径

普通 Work 的 Runner 在供应商报告较小窗口时返回完整内存消息；`AgentLoop._state_run` 随后调用 `_rebuild_after_context_limit`，从持久会话重新构造初始请求，并再次启动 `_run_agent_loop`。第一次返回的 `all_msgs` 尚未由 `_state_save` 保存；检查点只在 metadata 中，重建路径没有物化它。因此本轮已完成的工具结果可能不在恢复请求里，运行器计数和重复保护也重新开始。

依据：`mona/agent/loop.py` 的 `_state_run`、`_rebuild_after_context_limit`、`_set_runtime_checkpoint`；`mona/agent/runner.py` 的 `run` 上下文错误分支。

### DSH 实现

`packages/core/agent-loop/src/agent.ts` 的每个 step 内有请求 attempt 循环。失败后 `agent/request-error` 可返回 retry，继续本 step；此前成功的 assistant 和 tool/result 已在当前 Session surface 中。`packages/compaction/compaction-basic/src/index.ts` 的超限处理只有在上下文替换确实前进且未取消时才允许重试。

每次 attempt 仍会重新解析路由并冻结请求，不能宣称重试必然字节相同；保证的是已接纳输入和已执行步骤不重放。

### 决策与最小实现边界

通过。把 Work 的窗口学习接入 Runner 当前请求的恢复分支，复用同一份内存消息、工具结果、计费累计及循环保护。移除外层整轮重建重跑路径。最多一次确认窗口后的恢复，仍无法满足预算则保留进度并报告失败。

本项不新增轮内语义压缩、不更换模型、不执行历史工具、不重建本轮 system。Code 现有恢复回调保持自己的处理方式。

验收：真实运行器搭配本地副作用工具，工具成功后下一请求模拟窗口超限；恢复请求包含成功结果，文件只写一次、system 相同、原始历史及计费保存正确。取消与无法恢复时不再次启动整轮。

## 4. I2：工具执行状态与恢复

### 优化前差异

Mona 在工具批次前保存所有 pending calls、结束后记录完成结果，但没有单独记录真正进入工具调用的 ID。恢复时所有 pending 都变成同一种中断错误。

DSH 在 assistant/message 之后逐个记录 tool/call，结束后记录 tool/result。`packages/core/session/src/repair.ts` 根据缺失 call start 或缺失 result 分别产生 `TOOL_NOT_STARTED`、`TOOL_OUTCOME_UNKNOWN`；结果未知的操作必须先核验外部状态。修复只追加记录，不调用工具。

### 决策与最小实现边界

通过。复用现有 checkpoint，增加真正派发前的开始记录；恢复结果使用稳定错误码区分未派发与未知。旧检查点无法确认派发情况时按未知处理。保留完整工具配对和已完成结果，不新增重试调度器或工具审批入口。

开始状态必须在实际 execute 前保存；参数校验失败或保护规则拦截不标记已派发。并行批次的开始和完成更新需包含截至当时的累计记录，不能覆盖已结束的同批工具。

验收：取消在派发前、派发后未完成、部分完成、旧检查点四种情况；未派发可以按新请求继续，未知提示禁止盲目重试，完成结果原样恢复，恢复函数不产生副作用。

## 5. I3：普通对话输入可靠性

DSH 有稳定 requestId，队列/历史去重及 accepted 回执，区分 next-turn 和 next-step。accepted 是运行时 Inbox 已接纳，队列变化写事件日志；prompt 路径没有等待独立 flush，不能当作强持久化屏障。

Mona 普通 ThreadShell 的待发项在 `usePendingQueue` 的 React 内存中；追加后调用 inject 并移除本地项。服务端也有当前会话的内存 pending 队列。taskId 是任务分组，不是消息幂等 ID。开发模块通过 requestId 和 SQLite inputs 登记 follow_up，属于独立执行协议。

I3a 单独评估消息级去重和接纳确认；I3b 单独评估持久队列与编辑/撤回。不得把普通业务会话直接转接到 development 的工具、人格或执行者，不改变目前的追加/下一轮规则。

### 深评结论

有必要优化，但本轮不通过直接实施门槛。DSH 的统一 Inbox 能判断接纳状态；Mona `_dispatch_envelope` 还包含上传、Office/浏览器上下文、房间、直接点名专家和讨论路由；有的分支返回“已处理”，包含已经发送拒绝通知的情况，并不等于任务已接纳。不能在这层简单包装一个 accepted=true。

Mona 用户 transcript 已在 MessageBus 分发前 fsync；只依赖其中的 requestId 去重，可能抑制“记录成功但尚未分发就崩溃”的合法续接。只用内存去重则又不能解决重启后的接纳与执行不确定性。为达成完整保证，需要明确定义 RECEIVED/ADMITTED/DISPATCHED/UNKNOWN，并将普通会话输入与现有分发、房间任务及附件生命周期关联。这会超出单加字段或回执的局部变更。

依据：`webui/src/lib/mona-client.ts:945`、`mona/channels/websocket.py:2036`、`mona/channels/websocket.py:6145`、`mona/webui/transcript.py:174`；DSH `packages/api/session-controller/src/commands.ts:311`、`packages/core/agent-loop/src/inbox.ts:227`。开发模块现有 `runtime.py:306`、`store.py:881` 可以参考事务登记，但其 run/executor/project 归属不能直接用于普通会话。

后续准入：先定义普通会话的输入状态与错误回执，保持当前追加与下一轮语义；再通过断线未知、记录后未分发、分发后无响应、重复附件、Office 上下文、房间/专家路由、停止和撤回冲突的协议回归。当前发送业务保持现状，文档不宣称其已有开发模块的持久 follow_up。

## 6. I4：轮内上下文治理

DSH 在每个 pre-step 检查压力并对完整可替换区间生成摘要。Mona 轮前 Consolidator 使用完整用户回合切点；一个用户请求下的长工具链没有新的 user 切点。Runner 的普通路径还使用 microcompact 和 snip，Code 的 CodingContinuation 则另有完整批次投影及当前目标保护。

需要评估的是长单轮工具链的真实缺口，而不是新增另一套长期记忆。候选方案必须保持 system 字节、业务工具、原始历史和保存偏移；摘要进入 user runtime context；失败时不能用不完整摘要推进游标。

### 深评结论

逐请求治理的必要性通过，直接挂现有回调的实现方案未通过。Consolidator 只读取持久 Session 并推进全局游标，不能看到当前尚未保存的工具链；CodingContinuation 依赖开发 transcript、输入状态和固定 CODING_SYSTEM。直接复用会越过 Work/Code 业务边界。

仅增加内存摘要回调也不足：回调非空会绕过现有工具结果预算与历史裁剪；原始结果仍按 save_skip 保存，摘要投影与持久消息没有统一的区间身份。取消或下一轮时，投影可能丢失；长单轮原文超过摘要输入预算后，轮前归档仍会失败。不能只证明同一进程中某一次请求变短，就宣称跨轮与恢复连续性完整。

依据：`mona/agent/runner.py:432`、`mona/agent/memory.py:687`、`mona/agent/loop.py` 的 `_save_turn`；`mona/development/continuation.py:118`、`mona/development/compaction.py:47`。DSH 则将替换范围和新摘要持久化为 surface 变更，后续请求和恢复使用同一投影。

后续准入：为普通会话定义独立、可恢复的投影范围；保存原始目标和所有已接纳纠偏；验证 Office 版本/工具协议/MCP 结构化结果、完整工具配对、保存偏移、摘要失败及跨轮恢复。与 I3 的输入身份及 I8 的诊断边界一起设计，但不移植完整 DSH 日志框架。本轮保持现有业务行为；I1 已先消除整轮重跑的副作用风险。

## 7. I5：计量一致性

DSH token-meter 使用供应商用量锚点、当前 surface 增减和路由图片计价；不代表任何模型都有精确本地 tokenizer。

Mona 文本兜底的完整提示估算只数文本；单消息估算可能序列化非文本块。这两种处理对图片不一致。必须先验证本项目模型元数据和计量调用者，区别可立即修正的估算口径与没有可靠来源的模型特定价格。不得写入伪精确的视觉 token/计费数字，或因保守图片猜测拒绝原本合法的业务请求。

### 深评结论

批准最小子范围：提示估算与单消息边界选择共用文本/协议字段提取；图片块的 base64 不作为文本 token 参与边界选择。结构化文本工具结果与 tool_calls/name/reasoning 仍计入。供应商显式 counter 优先级、请求内容及真实 usage 不变。

DSH 通用 fallback 同样是近似结构计量，只有声明路由定价的 adapter 才能加入可靠视觉成本。DeepSeek 自己的公式不能抄成所有 Mona 模型的规则，base64 膨胀只适用于传输字节预算。故本轮不新增固定“每张图片多少 token”、模型私有定价或计费估算，也不改变图像发送/降级策略。

依据：DSH `packages/llm/token-meter/src/estimate.ts`、`route-pricing.ts`、`packages/llm/llm/src/types.ts` 的 `LlmImageRequestPricing` 与 `content.ts` 的字节预算；Mona `mona/utils/helpers.py` 的两种估算函数。验收同一文本/结构化工具消息口径一致，二进制长度变化不导致百万文本 token 或提前大范围归档，输入消息不被修改。

## 8. I6：工具并发上限

DSH 对并行安全工具使用配置化池，默认 10，按模型顺序提交结果；独占工具形成顺序屏障。Mona 已按 concurrency_safe 分批，但同一安全批次直接 gather 全部调用。

评估只针对资源峰值上限，不把写入工具改为并行，不改变调用参数、结果顺序、失败与停止处理。

### 深评结论

通过：普通 Work 的已声明 concurrency_safe 批次会一次启动模型提出的全部调用；没有资源上限，批次变大时可集中占用线程、网络与文件句柄。设置池上限不需要改变任务内容或写入工具语义。

批准只增加 `AgentDefaults.max_parallel_tool_calls`（默认 10、正整数）与 Work Runner 参数。文档/伙伴循环继承主 Work 限额。共享 Runner 的未配置调用者保留原策略，Code/子任务不顺带改预算。已有 unsafe/exclusive 分批和模型顺序返回保留，开始/完成 checkpoint 在持有池槽时进行。

依据：DSH `packages/core/agent-loop/src/tool-calls.ts:199` 的有界 fillPool 和顺序 commit；Mona `mona/agent/runner.py` 的 `_partition_tool_batches` 与 `_execute_tools`。验收真实工具的峰值不超过配置、结果仍按模型顺序、独占工具前后无并行交叠、取消后的等待者未派发。

## 9. I7：图片历史

DSH 持久图片引用在后续请求中可按路由恢复；Mona 普通历史主要保留图片路径提示，当前输入才直接载入真实图片。默认恢复全部图片会增加成本，并可能影响看图、电脑操作及不同模型的兼容性。

需要按真实用户目标评估有界回放，保留既有文件读取能力。不能借此改变电脑操作截图新鲜度、删除图片或引入新的媒体存储根目录。

### 深评结论

本轮暂缓。DSH 先保存 provider-independent 的附件引用，再按路由生成版本，并记录逐张 offload；旧图不会自动恢复。Mona 当前用户图片、电脑操作截图、专家/文档附件有不同的生命周期和新鲜度要求；统一默认最近 N 张会改变发送成本，并可能把过期截图重新用于定位。

现有路径提示和按需文件读取仍能找回用户附件，开发模块已有不可变图片输入。没有证据表明需要默认把全部近期图送给每次请求。后续仅在多轮看图的明确场景验证任务级、可控的回放，并同时核对图片不存在、模型不支持视觉、像素/字节上限和电脑操作新鲜度；不顺带修改媒体存储或删除规则。

## 10. I8：请求诊断记录

DSH 用 request/header、request/context 与 surface 事件重建语义请求，模型可见内容有日志依据；它不等同于所有供应商 HTTP body/headers 的完整重建。Mona 已有会话、transcript、检查点与诊断日志。

候选改进只能补充定位实际故障所需的脱敏元信息或引用。现行工程边界禁止把完整请求体、认证头或生产凭据写日志；不能为模仿 DSH 另建全量事件存储、复制用户文档或扩大后台日志收集。

### 深评结论

本轮暂缓。DSH 的 semantic header 本身没有 API key，也不是完整 HTTP 日志；但它依赖统一日志/surface，不能只复制一个“请求快照”字段便复建 Mona 动态人格、工具和媒体。当前恢复故障已经用实际消息与检查点测试定位，I1/I2 新状态提供必要依据，没有额外采集全部请求内容的收益证据。

已有模型/窗口、计费用量、工具调用 ID、检查点和 transcript 保留。后续出现无法定位的具体故障时，先确定需要的 provider/model、工具 schema 指纹及日志偏移，验证脱敏与生命周期，再引入最小元记录；不用新的全量日志平台或用户文档副本。

## 11. 执行与验证记录

### I1 完成

- 改动：`mona/agent/runner.py` 增加当前请求容量学习回调；`mona/agent/loop.py` 绑定 Work 回调并移除外层重建与重跑；`tests/agent/test_message_flow_recovery.py` 增加真实运行器/工具行为回归。
- 结果：新回归 3 passed；既有上下文治理与轮前整理选集 28 passed。外部模型及配置使用测试替身，本地文件真实写入。
- 证据：成功工具后第二次请求超限，第三请求带成功结果，文件只有一行；system 相同；输入/输出计费仍累计第一请求；回调拒绝与第二次超限均不会无限恢复。
- 限制：这一步没有引入轮内语义摘要；原有确定性预算治理仍工作。I4 独立评估。

下列记录对应已完成项目；所有测试均为与本轮变更相关的选集，外部模型由替身隔离，不等同于全仓库或真实供应商验证。

### I2 完成

- 改动：Runner 在参数校验和保护规则之后、真实工具 execute 之前保存开始 ID；完成与后续开始记录均携带累计结果。Loop 恢复输出未派发或结果未知的稳定分类。
- 新回归：`tests/agent/test_tool_dispatch_recovery.py`，3 passed。真实 Registry、Runner、SessionManager 和本地工具验证保存顺序；从新 SessionManager 实例读取检查点。
- 证据：并行 A 先完成、B 后进入 execute 时，磁盘检查点同时含 A 结果和 B 开始 ID；取消后恢复 A 原结果、B 未知、C 未派发；恢复不调用工具。校验失败不记录开始；旧检查点按未知。
- 保留现有失败处理、工具参数、授权与调用顺序。旧取消测试使用缺少 Session 方法的 namespace 替身，改为真实 Session，避免为测试给生产代码增加兜底。

### I5 完成

- 改动：`mona/utils/helpers.py` 共用文本/协议字段提取，单消息切点计量不再数图片 base64。实际图片内容、供应商计量入口和计费用量不变；不添加没有来源的视觉成本常数。
- `tests/agent/test_token_estimate_consistency.py`：6 passed，Ruff 通过。
- 证据：文本、dict 工具结果、tool_calls/ID/reasoning 一致；小图片与百万字符图片不产生不同文本 token，消息对象未改变；provider counter 仍优先；真实 Consolidator 对带大图片的历史仍按完整用户回合选正确边界。
- 限制：没有供应商规则时依然是文本近似；不宣称已经精确计算图片视觉 token。路由定价和真实用量锚点属于后续明确接口范围。

### I6 完成

- 改动：`mona/config/schema.py` 显式声明正整数限额；`mona/agent/loop.py` 从配置传入 Work Runner 并让文档/伙伴循环继承；`mona/agent/runner.py` 在原安全批次内使用并发池。
- `tests/agent/test_parallel_tool_budget.py`：5 passed，Ruff 通过。
- 证据：安全读取峰值正好达到配置 2 且不超过；乱序完成仍按模型调用顺序返回；独占工具无交叠；取消时池等待者未派发；camelCase 配置 1 进入真实 Work 循环，0 被拒绝。
- 检查点存储异常时，已启动 A 必须完成并记录结果，B 不进入 execute，随后才传播原异常；不会遗留已启动工具而提前结束运行。
- 限制：限额作用于普通 Work 每个安全批次，不是全应用全局限流；未修改 Code/子任务的独立预算、工具参数或业务 UI。

## 12. 最终验证与交付范围

最终相关 Python 选集：**150 passed**。执行的文件为四份新回归、`test_loop_save_turn.py`、`test_loop_consolidation_tokens.py`、`test_runner_governance.py`、`test_consolidator.py`、`test_consolidation_ratio.py`，以及开发侧 `test_compaction.py`、`test_delivery_continuity.py`、`test_coding.py`。覆盖同一次运行的恢复、会话保存偏移、普通 Work 与 Code 连续性、工具并发及失败收尾。

命令：

```powershell
.\.venv\Scripts\python.exe -X utf8 -m pytest tests/agent/test_message_flow_recovery.py tests/agent/test_tool_dispatch_recovery.py tests/agent/test_token_estimate_consistency.py tests/agent/test_parallel_tool_budget.py tests/agent/test_loop_save_turn.py tests/agent/test_loop_consolidation_tokens.py tests/agent/test_runner_governance.py tests/agent/test_consolidator.py tests/agent/test_consolidation_ratio.py tests/development/test_compaction.py tests/development/test_delivery_continuity.py tests/development/test_coding.py -q
```

四个生产文件与四份新回归的 `ruff check` 通过；相关已跟踪代码的 `git diff --check` 通过。历史本地治理测试有旧的 import/命名 lint，未批量格式化或整理；其行为选集通过。本轮没有改前端或 Rust，因此未重复前端构建和桌面构建。

生产改动限制在 `mona/agent/loop.py`、`mona/agent/runner.py`、`mona/config/schema.py`、`mona/utils/helpers.py`。文档基线补充了已通过的保护规则，并澄清普通 Work 与开发输入协议的真实差异。`.gitignore` 只增加本评估文档和新回归的精确允许项，保留其他本地忽略规则。没有迁移数据、启动/停止服务、执行真实业务工具或发布版本。

后续条件：I3a/I3b 先定义普通会话接纳/分发/未知状态并验证全部现有路由；I4 要有可恢复投影和业务结果保真；I5 的精确视觉价格必须有路由规则来源；I7 要有明确的多轮看图需求与成本/新鲜度策略；I8 先出现现有诊断不足的具体案例。当前暂缓项目不自动扩大到后续开发任务。
