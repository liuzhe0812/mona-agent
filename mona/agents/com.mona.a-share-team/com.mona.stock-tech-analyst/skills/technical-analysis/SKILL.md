---
name: technical-analysis
description: Evidence-bound technical analysis for price trend, volume-price structure, indicators and observable support or resistance.
---

# 技术分析

只分析当前运行证据包覆盖的标的。深度投研（V6）先调用
`stock_evidence_read(sections=["decision_readiness"])`，把
`decision_readiness.research_ready.horizons.short_term` 作为能否形成短线观点的唯一第一门禁；
`evidence_coverage` 只用于记录增强信息局限，不得在 research_ready=ready 时阻断观点。随后调用
`sections=["market_regime", "capital_positioning", "tradeability", "kline"]`，以返回的
`research_cutoff_at`、`market_as_of`、确定性指标和各分区 `source_id` 为唯一事实来源；
只消费这些市场与交易分区，不凭记忆补数字，也不把指标重新计算后当成新证据。

## 证据对象不可混用

`kline` 表示历史价格和成交量，`indicators` 表示基础技术指标，`quote` 表示当前/冻结报价，
`market_regime` 表示市场环境，`tradeability` 表示执行约束，`derived_decision_metrics` 表示系统派生的交易计划。
其中任一对象缺失，都不能写成其他对象缺失。特别是 `derived_indicators_unavailable` 只代表派生交易计划未生成，
不代表 MA、MACD、RSI 等基础指标缺失。

## 分析顺序

1. **趋势**：比较价格与证据包中的 MA5/MA10/MA20/MA60（仅使用实际提供的
   周期），判断上升、下降或震荡及所处阶段。
2. **量价**：检查上涨/下跌与成交量变化是否配合，标注异常放量、缩量和近期
   高低点。不要把单日量价直接外推为长期趋势。
3. **指标**：结合 RSI、MACD、乖离或其他已提供指标；指标只作组合证据，不能
   单独产生反转结论。
4. **关键位**：只引用证据包提供的支撑、压力或可复核的波段高低点，并说明
   依据的周期/日期。没有关键位字段就明确写缺失，不自行编造价格。

## 输出结构

单标的提交必须包含四个命名数组：`market_regime`、`capital_positioning`、
`tradeability`、`short_term_timing`。每个数组由 `ViewPoint` 组成，不能用通用
`points` 代替。该周期 research_ready=ready 时必须从可用事实形成至少一条有来源观点；增强分区缺口
改写为业务风险或待观察事项，不得在面向 V6 的 `summary`/`points` 使用
`insufficient_data`、数据不足、证据不足、数据缺失、暂不判断、暂无法判断、未提供。

## 语义完整性闭环（P0）

- Evidence 是数值唯一真值：只能原样引用当前 run Evidence 中已有、带 `source_ids` 的数值；上游 Artifact 只能复述其已带 Evidence 来源的事实，不能二次计算。
- 禁止自由算术（加减乘除、同比/环比、比例、平均、排序、聚合、单位换算、插值），禁止自行生成价格、仓位、分数、概率、止盈止损或确认阈值。`kline`、`indicators`、`quote` 与派生交易计划必须分开表述。
- 缺口只能引用当前 Evidence 的 `failure_reasons`/`missing_fields` 及业务影响；不得从 provider、接口、URL、日志或错误文本推测原因，也不得把派生计划缺失扩大为基础技术指标缺失。
- `research_ready=false` 时只提交结构化状态、缺口和来源；不可用摘要由系统按固定映射生成。用户文本不得出现内部字段、英文状态、接口名、机器码或 HTML 实体。

## 输出约束

- 通过 `submit_technical_view` 输出 `stance`、`summary`、`source_ids` 和上述四个命名数组。
- 每个 point 声明 `claim_type`：`fact` 必须有 `source_ids`；`inference` 必须有
  `source_ids` 和非空 `basis`；`hypothesis` 只能作为待验证问题。
- 区分 `research_cutoff_at` 与 `market_as_of`，排除研究截止后的数据；不要因缺失数据
  补写因果、WACC、目标价或确定性价格/比例阈值。
- 如需表达条件，只作为带 `claim_type`、来源和推断 `basis` 的观点 point；报告级
  `decision_conditions` 仅由裁决 Agent 提交。
- 每个事实性 point 带对应 `source_ids`；结论中的 `as_of` 与证据包一致。
- research_ready 未 ready 时提交结构化不可用 Artifact（状态、业务原因、已有 source_ids），不要伪造
  V6 观点；仍需保留可用 K 线和基础指标事实，并在 summary 中明确“指标可用，但暂不能形成短线结论/交易计划”。
  `failure_reasons` 只能逐项转换为用户语言，不得从 provider、URL、日志推测数据源因果，不得输出内部字段、英文状态或 HTML 实体；只有全部三周期均未 ready 才终止报告。research_ready=ready 时 `stance` 只能从
  positive/neutral/negative 中按事实选择，且不得提交 trade_ready 所属的价格、仓位、分数或执行状态。
- 只谈技术面，不评价估值、公告或给出买卖指令。
