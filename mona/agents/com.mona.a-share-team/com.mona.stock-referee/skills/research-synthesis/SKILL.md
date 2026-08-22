---
name: research-synthesis
description: Synthesize technical, fundamental, news, bull and bear artifacts into an evidence-traceable Report V4 with independent horizon decisions and explicit decision conditions.
---

# 研究综合与裁决

先调用一次 `stock_evidence_read(sections=[evidence_coverage], detail=compact)` 获取覆盖状态（可先
`skill_read`）。每次工具调用必须是独立回合：任一 `artifact_read` 成功后，下一次工具调用
只能是对应的 `submit_stock_report_staged`，收到 `Saved` 后才可读取下一份 Artifact；禁止
连续读取多个 Artifact 或先生成完整 payload。随后按证据到达顺序边读边提交：technical → `deep_dimensions` 的
`market_environment`/`capital_positioning`，fundamental → `company_quality`/`valuation`，
news → `industry`/`policy`/`cycle`/`event_risk`；bull 读取后立即把其可追溯催化（无则空数组）
保存到 `deep_context.catalysts`，收到 `Saved` 后再读 bear；bear 读取后立即把其可追溯风险
（无则空数组）保存到 `deep_context.risks`。收到第二次 `Saved` 后，模型才同时拥有 bull 与
bear 上下文，再按 `short_term`、`medium_term`、`long_term` 提交 `deep_decision`（每次对应
一个 `horizon_views` 和一个 `debate_resolution`），最后补 `cross_horizon_conflict`。不要先读取全部 Artifact，也不要读取
原始 Evidence 分区。工具会用当前 run 的完整 Evidence 做校验与注入；主席不一次性假定全量
evidence.json 可见，也不自行补充数据；所有数字与事实只能来自当前 run，且保留对应
`source_id`。

严格区分 `research_cutoff_at` 与 `market_as_of`，只使用当前 run 中研究截止前公开的
Evidence；不得引入未来信息。保留每条声明的 `claim_type`，事实/推断/假设不得互相
冒充。

## 裁决顺序

1. 检查三路分析是否覆盖同一标的、同一研究截止时间，列出缺失和过期字段。
2. 对多空每个核心论点逐项核对来源质量、时效和与原始字段的一致性。
3. 冲突时优先直接来源、较新来源和可复核数据；同时写明被保留的反方风险。
4. 对 short_term、medium_term、long_term 分别裁决为 `positive`、`neutral`、
   `negative` 或 `insufficient_data`，不要用 composite stance 或隐式加权分数
   替代解释。

## 必交字段

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
