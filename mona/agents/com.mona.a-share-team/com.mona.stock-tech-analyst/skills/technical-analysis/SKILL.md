---
name: technical-analysis
description: Evidence-bound technical analysis for price trend, volume-price structure, indicators and observable support or resistance.
---

# 技术分析

只分析当前运行证据包覆盖的标的。先调用 `stock_evidence_read`，传入
`sections=["market_regime", "capital_positioning", "tradeability", "kline"]`，以返回的
`research_cutoff_at`、`market_as_of`、确定性指标和各分区 `source_id` 为唯一事实来源；
只消费这些市场与交易分区，不凭记忆补数字，也不把指标重新计算后当成新证据。

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
`points` 代替；证据缺失时保留空数组并在 `summary` 和 `stance` 说明。

## 输出约束

- 通过 `submit_technical_view` 输出 `stance`、`summary`、`source_ids` 和上述四个命名数组。
- 每个 point 声明 `claim_type`：`fact` 必须有 `source_ids`；`inference` 必须有
  `source_ids` 和非空 `basis`；`hypothesis` 只能作为待验证问题。
- 区分 `research_cutoff_at` 与 `market_as_of`，排除研究截止后的数据；不要因缺失数据
  补写因果、WACC、目标价或确定性价格/比例阈值。
- 如需表达条件，只作为带 `claim_type`、来源和推断 `basis` 的观点 point；报告级
  `decision_conditions` 仅由裁决 Agent 提交。
- 每个事实性 point 带对应 `source_ids`；结论中的 `as_of` 与证据包一致。
- 证据缺少决定性字段时仍提交，`stance=insufficient_data`，在 summary 或
  point 中列出缺失字段和影响范围。
- 只谈技术面，不评价估值、公告或给出买卖指令。
