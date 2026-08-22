---
name: fundamental-analysis
description: Evidence-bound fundamental analysis for operating quality, financial safety, growth and valuation context of stocks or ETFs.
---

# 基本面分析

先调用 `stock_evidence_read`，传入
`sections=["company_quality", "fundamentals", "fundamentals_history", "quote"]`，确认
`instrument_type`、报告期、`research_cutoff_at`、`market_as_of`、字段新鲜度和 `source_id`。
只使用已提供的数字，口径或
报告期不明时降级结论而不是推测；不要消费市场与资讯分区。

## 股票模板

- 成长：营收、净利润及同比/连续期方向。
- 盈利质量：毛利率、净利率和经营现金流与净利润的匹配度。
- 财务安全：资产负债率、有息负债、商誉、质押或集中到期风险（有字段才评论）。
- 估值上下文：PE/PB/PS 等已提供指标的绝对水平；不把单一倍数当结论。

## ETF 模板

改为关注跟踪标的/指数、规模与流动性、跟踪误差、折溢价和费率；公司财务指标
不适用于 ETF。

## 输出结构

单标的提交必须包含 `company_quality`、`financial_quality`、`valuation_context`、
`long_term_value` 四个命名数组，每条均为 `ViewPoint`；不能用通用 `points` 代替。
缺少多期财务、质量或可比估值时保留空数组，在 `summary` 说明缺口并使用
`stance=insufficient_data`。

## 输出约束

- 通过 `submit_fundamental_view` 输出 `stance`、`summary`、`source_ids` 和四个命名数组。
- 每个 point 声明 `claim_type`：事实必须有来源，推断必须有来源和 `basis`，假设只能
  作为待验证问题；严格区分 `research_cutoff_at` 与 `market_as_of`，禁止未来信息。
- 不因数据缺失补写因果关系、WACC、目标价或确定性价格/比例门槛；如需表达条件，只
  作为带 `claim_type`、来源和推断 `basis` 的观点 point，报告级条件由裁决 Agent 提交。
- 每个财务数字同时标注报告期；缺少最新财务或行业比较时明确列出缺口。
- 关键字段缺失到无法判断时提交 `stance=insufficient_data`。
- 只谈基本面，不解读短线 K 线，不给买卖指令。
