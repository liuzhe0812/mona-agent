---
name: fundamental-analysis
description: Evidence-bound fundamental analysis for operating quality, financial safety, growth and valuation context of stocks or ETFs.
---

# 基本面分析

深度投研（V6）先调用 `stock_evidence_read(sections=["decision_readiness"])`，以
`decision_readiness.research_ready.horizons.long_term` 作为能否形成长线观点的唯一第一门禁；
`evidence_coverage` 只记录增强信息局限。随后传入
`sections=["company_quality", "fundamentals", "fundamentals_history", "valuation"]`，确认
`instrument_type`、报告期、`research_cutoff_at`、`market_as_of`、字段新鲜度和 `source_id`。
只使用已提供的数字，口径或报告期不明时降级为业务风险/待观察事项而不是推测；不要消费市场与资讯分区。

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
该周期 research_ready=ready 时必须从可用财务事实形成至少一条有来源观点；增强分区缺口改写为业务风险
或待观察事项。不得在面向 V6 的 `summary`/`points` 使用 `insufficient_data`、数据不足、
证据不足、数据缺失、暂不判断、暂无法判断、未提供。该周期 research_ready 未 ready 时提交结构化
不可用 Artifact（状态、业务原因、已有 source_ids），不伪造 V6 观点；只有全部三周期均未 ready
才由主审终止报告。

## 语义完整性闭环（P0）

- Evidence 是数值唯一真值：只能原样引用当前 run Evidence 中已有、带 `source_ids` 的数值；上游 Artifact 只能复述其已带 Evidence 来源的事实，不能二次计算。
- 禁止自由算术（加减乘除、同比/环比、比例、平均、排序、聚合、单位换算、插值），禁止自行生成价格、仓位、分数、概率、止盈止损或确认阈值。不得把单期财务数字加工成未由系统提供的趋势、质量比率或估值结论。
- 没有公司经营、现金流或多期财务证据时，不能用资讯、单一公告或常识代替公司业务发展；没有行业供需、产业链、产品价格或生命周期证据时，不得声称行业趋势/周期已确认。缺口只能引用当前 Evidence 的 `failure_reasons`/`missing_fields` 及业务影响。
- `research_ready=false` 时只提交结构化状态、缺口和来源；不可用摘要由系统按固定映射生成。用户文本不得出现内部字段、英文状态、接口名、机器码或 HTML 实体。

## 输出约束

- 通过 `submit_fundamental_view` 输出 `stance`、`summary`、`source_ids` 和四个命名数组。
- 每个 point 声明 `claim_type`：事实必须有来源，推断必须有来源和 `basis`，假设只能
  作为待验证问题；严格区分 `research_cutoff_at` 与 `market_as_of`，禁止未来信息。
- 不因数据缺失补写因果关系、WACC、目标价或确定性价格/比例门槛；如需表达条件，只
  作为带 `claim_type`、来源和推断 `basis` 的观点 point，报告级条件由裁决 Agent 提交。
- 每个财务数字同时标注报告期；缺少最新财务或行业比较时明确列出缺口。
- research_ready=ready 时 `stance` 只能从 positive/neutral/negative 中按可用事实选择；关键字段
  未 ready 时提交结构化不可用 Artifact，且不得提交 trade_ready 所属的价格、仓位、分数或执行状态。
- 只谈基本面，不解读短线 K 线，不给买卖指令。
