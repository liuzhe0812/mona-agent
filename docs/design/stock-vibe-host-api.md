# 股票 Vibe 宿主协议验证

Services 注册 `/api/stock-vibe`，新业务默认关闭执行。当前正式股票入口仍使用旧模块；新接口的开发验收只在独立数据根、显式传入验收执行许可的应用内进行。状态读取不启动原生进程。正式执行权切换仍受实施方案四道门槛约束。

## 已接入口

白名单包括会话创建/详情/消息/取消、团队预设/运行/详情/取消/原生 resume、策略 run 列表/详情/预览、组合快照/刷新状态/只读同步，以及上传回执和原生操作列表/详情。原生操作限于版本化策略回测、Shadow 提取/回测/报告/扫描和普通成交统计。没有任意路径代理，没有在线交易写入口。会话创建不接受原生 config 覆写；团队入口目前只接受受控 `mona_ashare_research`。原生字段位于 `native` 或 `receipt.body`，不转换金融指标。

所有普通业务路径由 Mona 本地令牌保护。只有精确的 `/api/stock-vibe/events` 改用一次性票据，票据由已鉴权的 `POST /events/ticket` 签发，30 秒有效，绑定对象与原生游标。票据消费后即失效；内部端口和长期令牌不交给前端。转发保持原生 `id/event/data`，不把断线当成研究失败或重新提交消息。

## 请求与来源

每个写请求必须提供 `X-Mona-Request-ID` UUID。宿主 SQLite 在发送前保存规范请求摘要并绑定已握手的来源。原生0004补丁在生产端先 claim 再执行并保存回执。同 ID 相同输入只查询原回执，不派发第二次；输入不同返回冲突。网络失败保持 `unknown`，查询 `/requests/{id}` 只核对原生 ledger。无法确认时保留未知，不根据相同文字或标题猜测。

`completed` 表示该 HTTP 操作的回执已确认；研究最终状态仍以原生 attempt、Swarm task/run 和产物为准。来源保留原始快照、完整补丁收据、实例及数据根摘要。对象来源由确认的创建回执建立，重启或升级时不改写为当前引擎的来源。来源未建立的旧原生对象返回 `source: null`，不能伪装成当前组件的新结果。宿主索引不保存原始提交正文或真实提供商密钥。

## 当前验证

`tests/services/stock_vibe/test_api.py` 对已离线安装的真实原生服务进行请求。无模型、无账户凭据。回执丢失通过“真实 native 创建完成后，在调用方丢弃响应”注入；随后只查询 ledger 找回同一会话。重复提交后原生会话总数仍为1，不同正文同 ID 冲突。重启生成新实例，原会话与创建来源保持不变。

事件验证先建立真实 SSE 再发送一条无模型消息，保留原生 attempt.failed 和事件 ID；未鉴权签票、空票据、无效票据、重复使用票据被拒绝。未切换的生产注册路径拒绝业务请求且不创建原生数据根。模型覆写输入在派发前被拒绝。

定向验证：API 3项、请求索引10项、Services认证13项，合计 **26 passed**（18.35秒）；报告在 `.codex_tmp/stock-vibe-host-api-tests.xml`。这是早期接口原型的记录，当时的“上传、策略/Shadow薄路由和产品页面待接入”状态已由下文 2026-10-17 进展替代。26 项不证明账户连接、完整产物下载或四道切换门槛完成。

## 2026-10-17 接线进展

以上 26 项为早期记录。之后白名单原生操作和产品入口已接入候选实现，但 T06/T11 的完整产品验收仍未完成。策略页可以从已有 native run 创建版本化回测并查看/导出真实原生结果；目前没有完整的严格因子验证和实验比较界面。`GET /runs` 只列实际具有 strategy.py 与配置文件的回测输入；普通研究目录不会被误列为可回测策略。研究、团队、回测、情景与导出证据见 [UI 验收](stock-vibe-ui-verification.md)，不将接口受理状态等同于最终金融结果。

`GET /uploads` 只读宿主已确认的原生上传回执，核验摘要及来源，只返回 upload ID、原名、大小和收据/来源字段，不扫描目录、不启动原生、不重新上传。大小来自回执精确限定的当前私有文件；缺失时为空。回执存在不证明文件当前仍存在，实际派发由原生重新校验。界面可在浏览器本地记录丢失后选择已有上传附件。

模型与关注设置为明确标注 `mona_settings` 的本地设置回执，来源为空，不冒充原生任务。模型 `null` 表示尚未选择，`"default"` 表示用户显式沿用 Mona API 配置，独立于 CodeBuddy 聊天执行器。此次已授权配置核验的是 `qwen3.7-plus` / `aliyun-bailian-coding`，provider backend 为 `openai_compat`；这记录当前验收配置，不表示每台设备的 Mona API 都使用相同模型。空的旧 `dashscope_coding_plan` 字段不作为模型来源。真实提供商密钥只留在父进程的 provider snapshot 中，不发给原生 Vibe 子进程。

普通成交复盘使用用户选择的 CSV/XLS/XLSX 附件；宿主上传限制为 8 MiB。发给 native operation 的契约只包含 `{operation: "analyze_trade_journal", upload_id}`。原生用私有上传目录中的 UUID 重新解析文件，再调用 `TradeJournalTool` 的 full 分析；不接受客户端物理路径、filter 或 analysis_type，也不需要已连接账户、模型调用或联网行情。它与 Shadow 规则提取是两个独立操作，少量成交仍可做普通统计，但不因此达到 Shadow 提取样本门槛。

正式入口由 `StockEntry` 按唯一 ownership 挂载一个实现；没有记录时默认 legacy。switching、paused、损坏状态和连接失败不会挂载执行页面。真实用户 ownership 未写入，未正式激活。业务在派发前被执行权拒绝时明确返回 409 `execution_not_allowed`，界面保留输入、允许以后由用户再次提交；派发之后的未知结果仍只查询，不按该错误处理或重发。

关注设置、情景读取、原生调度 firings 及提醒 claim/ack 已接入。通知点击保留原生 artifact/session/attempt 引用，只读取对应历史判断或完成报告。实际 OS 通知仍待完整桌面验收。

Shadow 回测与报告限定为 A 股；回测的默认篮子为 5 只，UI 可明确选择 1–100 只。报告不再依赖默认补齐输入：宿主必须提交 `window_start`、`window_end`、`source`、`markets`、`per_market_count` 五项，`upload_id` 可选；`include_today_signals` 只能是 `false`。生成报告不会隐式执行行情扫描，扫描需单独提交 `scan_shadow_signals` 操作。原生报告记录生成时间、成交文件区间、Shadow 回测区间、来源、股票池和篮子数量。Hosted 报告契约只允许 `include_today_signals=false`，因此该报告应显示“未请求扫描”；独立行情扫描不由报告调用隐式触发。报告不通过默认参数补齐日期、来源、市场或篮子输入，也不做隐含的同窗比较。

原生 patch 0023（SHA-256 `201d169cde5779f9b7aa45d179c5fc80f1d162d89eb268dd0bf65566e34789b5`）在缺少同一回测区间的期初持仓、本金和账户净值证据时，不计算账户收益、差额或经济归因；普通成交流水只是交易证据，不是账户收益曲线。patch 0024（SHA-256 `c57a3267d0a008f192df531fecbfa766fcd6252fd13afae14845c17cee478df6`）增加上传 ID 限定的普通统计。patch 0025（SHA-256 `b94b6a79f3acf15159410ffce14830bf0e186b8e8133b210b67863317dbd41e8`）补全报告输入元数据并固定 hosted 报告与信号扫描分离。它们都不证明真实券商账户接入、账户净值对比或产品发布验收已完成。

### T06 候选：独立区间与成本验证

Services DTO 和 UI 当前接入候选请求 `strategy_oos_validation`：必须引用已有 `run_id`，并明确提交 `window_start`、`window_end`。UI 明确提交 `cost_scenarios`；API 省略该项时仅运行原配置成本情景。区间由原生再次核验，验证开始日必须严格晚于来源 run 配置中的 `end_date`。情景集合必须有唯一的 `source_config`（空 overrides，沿用原始成本），最多另带两个 stress 情景；每个情景各自创建独立 native run，原始策略代码 SHA 不被改写。

成本字段只接受有限 JSON 数字，不接受字符串、布尔值、路径、代码或环境字段。`commission_rate`、`stamp_tax`、`transfer_fee` 和 `slippage` 是 `0–0.1` 的小数率；`commission_min` 是 `0–1000` 的金额下限。其余成本继续沿用源配置，不把小数率当百分数整数传入。

普通策略检验保留各项原生 check 和各自结果，不合成总体通过门槛。原生未提供 aggregate gate 时应为 `outcome=unavailable`、`outcome_reason_code=no_native_aggregate_gate`，不能显示“通过”。严格因子检验需要因子库及横截面数据；当前策略 run 返回 `not_applicable`，不代表严格因子验证已执行。

WebUI 已接入请求、成本输入、原生 scenario/run 身份及结果展示。native patch 0026 已冻结（SHA-256 `5b5b68a790eaacde7a2758d94fecd859928dda939761cedcaa38504d34af4eaa`），fresh 1–26 源的合成本地 Runner、package 10 离线安装和预览 5 UI 实跑均有对应证据；preflight 9 不包含该补丁。任务为持久 operation，结果未知时只能查询原请求，当前没有中途取消支持。

原生持久记录将输入 run 保存为 `payload.input_run_id` 和 `references.input_run_id`，UI 以该引用匹配历史实验，不假设 payload 仍叫 run_id。`tool_result.status` 为工具执行 `ok/error`，`experiment_status` 单独区分 `completed/partial/failed/not_applicable`；各情景的执行状态在 `scenarios[].status`。开发期和验证期使用两个日期数组，原生指标在 `backtest_summary.metrics`，普通检验另含 `status/outcome/outcome_reason_code/checks/artifact_available`。源身份在创建时保存，GET 不按当前安装版本重写旧对象来源。

### T06 候选：严格因子检验

独立操作 `strict_factor_validation` 接受内置 `zoo=alpha101|qlib158`、明确 `start_date/end_date/oos_cutoff`，区间至多五个日历年且 `start < cutoff < end`。固定 CSI300、开启随机对照；可选种子数 1–5、观察期 1–21、top 1–100，默认 5/1/20。不接受任意代码、路径、证券池、阈值或请求内令牌。它直接调用打包原生 strict 内核，训练期包含截止日、验证期在其后；原始 rows、skipped 与 meta 持久保留。

Mona 仅从显式 `stockVibe.tushareToken` 或 `MONA_STOCK_VIBE__TUSHARE_TOKEN` 提供增强行情配置，后者优先；默认空，GET status 只返回 `tushare_token_configured` 布尔值。签名仅加入摘要，活动任务完成前不换环境。原生 Tushare 回测 loader 与策略在同一子进程，保留既有行情令牌白名单；模型/券商凭据边界不放宽，不称 OS 密钥隔离。

缺显式行情配置时，原生返回 `status=error, experiment_status=unavailable, reason_code=tushare_token_unconfigured, no_network_attempt=true, native_result=null`；后台 operation 为 failed，与统计未执行/数据不可用分层展示。成分降级同样不可用，并保留原始诊断，不当作完整 CSI300 检验。补丁 27 已冻结，fresh 源真实 Alpha101 合成面板检查、package 11 离线安装及预览 6 缺配置 UI 分支有证据；真实 Tushare 权限和数据仍未验收。

T12候选维护接口由显式根的 `tools/stock_vibe/cutover.py` 驱动：status只读、freeze盘点旧任务并停用旧cron、commit核对迁移和独立证据。旧Registry调用lease在freeze/commit时参与阻挡；无法确认完成的lease不会自动清除。隔离owner、Registry、archive和cutover测试合计39项通过，但没有对真实用户ownership执行切换或迁移，候选命令不代表正式执行权已经转移。
