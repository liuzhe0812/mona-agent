---
name: research-synthesis
description: Synthesize technical, fundamental, news, bull and bear artifacts into an evidence-traceable Decision Report V6 with independent research and trade gates; keep older reports as read-only history.
---

# 研究综合与裁决

## 当前主合同：Decision Report V6

新深度投研必须使用 V6；旧 V5/V4 字段只用于读取历史报告。V6 把 `research_ready` 与
`trade_ready` 分开：研究可用即可形成定性三周期报告，交易可用才允许系统物化交易计划。
至少一个周期研究可用时，完整报告必须成功；不可研究周期由系统呈现“暂不参与”，不能让整 run 失败。

通过 `submit_stock_report_staged(section=deep_v6)` 增量提交：

- `summary`、`instrument`；
- `horizon_decisions_v6.short_term`、`medium_term`、`long_term`；
- `disagreement_matrix`：争议点、双方依据、主审采信、保留风险、改变结论条件。

每个周期只提交方向、允许 action、定性 thesis、未持有/已持有动作、核心理由、主要风险、研究状态、
业务化改变结论条件和来源。LLM 不得提交 `trading_plan`、`position_plan`、`execution`、`calibration`
或任何价格、仓位、分数、执行数值；这些只能由确定性系统在 trade_ready 通过后注入。若 staged 后端
尚未接收 `disagreement_matrix`，只能保留为 Agent Artifact/契约测试合同，不能声称已持久化。

LLM action 集合只有 `conditional_participation`、`wait`、`hold`、`reduce`、`exit`、`avoid`；
`participate` 只允许用于未持有动作，`execution_blocked` 只能由系统注入。research_ready=true 且
trade_ready=false 时，当前 action 只能是 `wait`、`reduce`、`exit`、`avoid`。三周期保存后调用
`section=finalize`；只有全部 research_ready 失败、来源校验失败或确定性系统失败才终止。

深度投研 V6 第一回合先调用 `stock_evidence_read(sections=[decision_readiness], detail=compact)`
读取 `decision_readiness.research_ready`、`trade_ready`、量化晋级、估值资格、执行资格和风险门槛；
确定性状态是硬门槛，语言不能覆盖。每次工具调用必须是独立回合：任一 `artifact_read` 成功后，
下一次工具调用只能是对应的 `submit_stock_report_staged(section=deep_v6)`，收到 `Saved` 后才可
读取下一份 Artifact；禁止连续读取多个 Artifact、读取其他 run 或先生成完整 payload。按 technical →
fundamental → news → bull → bear 顺序读取；五份 Artifact 只核对同一标的、时间、来源质量和多空事实，
不把上游旧 stance 当成裁决，不读取原始 Evidence 分区，也不引入外部事实。对应 research_ready=true
的周期必须由可用事实裁决为 positive、neutral 或 negative；对应 research_ready=false 的周期保存
结构化不可用状态，系统在最终报告映射为“暂不参与”。至少一个周期 research_ready 时 finalize 必须
成功；trade_ready=false 不得阻断报告。新闻只能补充催化与风险，不能单独决定交易。
只保存 `summary`、`instrument`、三个 `horizon_decisions_v6` 和 `disagreement_matrix`。每周期保存
方向、允许 action、thesis、未持有/已持有动作、核心理由、主要风险、研究状态、业务化改变结论条件和
`source_ids`；不得提交价格、仓位、分数、`trading_plan`、`position_plan`、`execution` 或 `calibration`
数值。`disagreement_matrix` 包含争议点、双方依据、主审采信、保留风险、改变结论条件；后端未接收时
仅保留 Agent Artifact/契约测试合同，不声称已持久化。
若 finalize 返回具体字段错误，只修复对应字段后重试；只有全部 research_ready 失败、来源校验失败
或确定性系统失败才终止。所有事实只能来自当前 run，且保留对应 `source_id`。

严格区分 `research_cutoff_at` 与 `market_as_of`，只使用当前 run 中研究截止前公开的
Evidence；不得引入未来信息。保留每条声明的 `claim_type`，事实/推断/假设不得互相
冒充。

## 裁决顺序

1. 检查三路分析是否覆盖同一标的、同一研究截止时间，列出缺失和过期字段。
2. 对多空每个核心论点逐项核对来源质量、时效和与原始字段的一致性。
3. 冲突时优先直接来源、较新来源和可复核数据；同时写明被保留的反方风险。
4. 对 research_ready=true 的 short_term、medium_term、long_term 分别裁决为 `positive`、`neutral` 或
   `negative`，research_ready=false 的周期输出结构化不可用状态和“暂不参与”；不要用 composite stance
   或隐式加权分数替代解释。trade_ready、量化晋级、估值和执行资格只决定系统是否物化交易计划。

## 语义完整性闭环（P0）

- Evidence 和确定性系统字段是唯一真值：主审只能原样引用当前 run Evidence 或已带 Evidence `source_ids` 的 Artifact；不得用多空文本重新计算数值，也不得把上游摘要当作新的数字来源。
- 主审禁止自由算术（加减乘除、同比/环比、比例、平均、排序、聚合、单位换算、插值），禁止提交或改写价格、仓位、分数、概率、止盈止损、确认阈值和执行状态。所有交易、量化、校准和执行字段只能由确定性系统注入。
- 基础指标、研究结论、派生交易计划和执行资格必须分层；派生计划或某一上游分区缺失不得改写成基础指标全部缺失。没有行业供需、产业链、产品价格或周期证据时，不得裁决为行业趋势/周期已确认；没有公司经营证据时，不得用资讯替代公司发展结论。
- 不可用周期只保留结构化状态、`failure_reasons`/`missing_fields` 和来源，不能自行猜 provider、接口、URL 或日志原因；用户可见不可用摘要由系统固定映射生成。不得以语言覆盖任何确定性门槛，也不得在用户文本暴露内部字段、英文状态、接口名、机器码或 HTML 实体。

## 历史 Report V4 必交字段（只读兼容）

通过 `submit_stock_report_staged` 增量提交 Report V4：按证据到达顺序多次保存
`deep_dimensions`、`deep_decision`、`deep_context`，最后调用无 payload 的 `finalize`。
工具只在 finalize 时写入最终 Artifact 并执行完整校验；
若是每日复盘，则只保存 `daily_digest` 后 finalize，不得混用：

- `dimension_views` 必须完整包含八个维度：`market_environment`、`industry`、
  `policy`、`cycle`、`company_quality`、`valuation`、`capital_positioning`、
  `event_risk`。每个维度以 `facts`、`inferences`、`hypotheses` 为唯一输入真值，
  `points` 只是按三栏合并的页面渲染字段，必须与三栏一致，并带
  `status`、`summary`、`missing_fields`、`source_ids`；只剩假设或底层 Evidence
  缺失时不能标记为 `available`。来源的研究截止、行情截至、公开时间和统计期末由
  工具注入，主席不能伪造。
- 必须提交三周期 `debate_resolution`，每项含 `status`、`issue`、`bull_case`、`bear_case`、
  `verdict`、`change_conditions`、`missing_fields`、`source_ids`，用短结构呈现核心分歧、
  裁决理由和改变结论的事实；available 的论据和裁决必须可追溯。
- `horizon_views` 的三个独立周期，每个含 stance/status/thesis/drivers、基准和已计价程度、
  action、参与/确认/观察/失效条件、时间退出、可交易性风险、盲区、证据强度和缺口。
- 每个周期还必须提交 `stop_loss_conditions` 与 `take_profit_conditions` 数组；证据不足时
  使用空数组。每个非空条件必须带非空 `claim_type` 和 `source_ids`；`trigger` 条件必须
  带当前 Evidence 的 `observed_metric_ref`、`threshold_metric_ref`、完整 `operator` 和
  可核验有效时点。不得生成无来源目标价、目标区间、概率、仓位比例或风险收益比。
- 三个周期必须声明 `dimension_keys`：短线消费市场/行业/资金筹码/事件并说明可交易性，
  中线消费市场/行业/政策/周期/资金筹码，长线消费行业/政策/周期/公司质量/估值；不能
  用同一段综合摘要代替三周期证据。
- `priced_in` 非 unknown 时必须用带 basis/source_ids 的 inference 填写 `priced_in_basis`；
  benchmark 的 relative_view 非 unknown 时必须用 Evidence 可核验的 instrument_id、basis、
  source_ids，不能按名称猜代码；三者必须来自当前 Evidence 的 relative_benchmarks 匹配项，
  且有与周期匹配、状态明确为 available/degraded 的窗口。即使周期结论为
  insufficient_data，只要窗口存在，工具也会把窗口、相对收益和方向确定性注入最终报告；
  不得丢弃可核验基准或编造 relative_view。
- `valuation` 必须保留 Evidence 已提供的当前绝对 PE/PB；同行比较缺失时标记 degraded
  并披露 peer_valuation，不能把已知绝对估值抹成 current_pe/current_pb 缺失，也不能伪造同行数据。
- 事件日历只能由 submit 工具从当前 Evidence 的 event_calendar 注入，不能由模型改写；
  仅保留研究截止前事件及其 event_type/title/published_at/event_date/status/url/source_ids，
  无 event_date 不得标为 upcoming。
- 四类周期键固定映射：policy=宏观与流动性，industry=行业供需与产品价格，
  earnings=公司盈利与现金流，valuation=市场风格与筹码；每项含阶段、领先/确认指标、
  转折条件、观察窗口、可信度和缺失。
- `cycle_states` 的 `policy`、`industry`、`earnings`、`valuation`；
  `market_regime_summary`、`industry_policy_summary`；
  `scenario_sets` 的三个周期各自 `optimistic`/`base`/`pessimistic`；每个情景至少一个非空
  条件。若 Evidence 有 `quote.price` 与 `indicators.swing.support/resistance` 或均线等
  数值路径，短线确认、观察、失效各至少一个可机读 trigger；中长线缺未来数值时可用
  有意义的 manual 条件，但不能留空。
- `cross_horizon_conflict` 只给解释和来源；状态由系统按三个 stance 派生。
- `risks`、`catalysts`、`open_questions` 使用带 `claim_type` 和 `source_ids` 的声明。

深度投研三段的字段边界固定为：

- `deep_dimensions`：可分次提供 `dimension_views` 的八个 key；`as_of:null`、`summary`、
  `source_ids`、`instrument`、`versions` 可在任一次提供或覆盖；
- `deep_decision`：可分三次提供三个 `horizon_views` 和三个 `debate_resolution`，再补
  `cross_horizon_conflict`；
- `deep_context`：bull/bear 读取后先分别保存 `catalysts` 与 `risks`；后续按独立小调用
  提供四个 `cycle_states`、两个摘要、三个周期的 `scenario_sets`，最后追加
  `open_questions`。每次收到 `Saved` 后才能提交下一组，后续不要重复提交 catalysts/risks，
  避免一次生成完整 context payload。

三段合并后必须满足全部 Report V4 字段和来源、coverage、metric、immutable、
outcome 约束，不得用分段提交来删减任何研究维度。

条件使用 `kind=manual` 或 `kind=trigger`。manual 只能人工观察，不能自动触发；
trigger 必须有 `observed_metric_ref`、完整 operator、来自当前 Evidence 的
`threshold_metric_ref` 和 source_ids，且两个引用必须不同（例如
`quote.price` 对 `indicators.swing.support` 或 `indicators.swing.resistance`）；
禁止裸数值 threshold。禁止买卖指令、
目标价、WACC、仓位比例和未经校准的概率。

Evidence 对应周期为 `insufficient_data` 时，周期必须保持
`stance=status=insufficient_data` 且 `missing_fields` 非空，不得改写为 neutral。
该周期的 `debate_resolution` 必须为 `status=missing`，其 `bull_case`、`bear_case`、
`verdict`、`change_conditions`、`source_ids` 必须为空，`missing_fields` 必须披露缺口。
`research_cutoff_at`、`market_as_of`、`evidence_coverage`、`outcome_tracking_id`
由工具从当前 run Evidence 注入或确定性生成，不能由模型输入。
