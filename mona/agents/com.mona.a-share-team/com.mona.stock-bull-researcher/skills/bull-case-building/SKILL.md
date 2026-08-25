---
name: bull-case-building
description: Build a rigorous bull case from shared analyst evidence, with resonance, assumptions, confirmation conditions and source traceability.
---

# 正面论证构建

## 输入与论证骨架

第一回合先调用 `stock_evidence_read(sections=[decision_readiness], detail=compact)` 获取三周期
`decision_readiness.research_ready.horizons`；它是能否形成对应周期论证的唯一第一门禁，
`trade_ready` 只影响交易计划。随后用 `artifact_read(detail=compact)` 读取 technical、
fundamental、news 三份上游观点；只使用共享不可变 Evidence 和三路 Artifact，绝不读取 bear Artifact、
bear 输出或任何对方过程。不要读取原始 Evidence 分区。提交工具会用当前 run 的完整 Evidence 做校验与注入。

只使用当前 run 中研究截止前公开的 Evidence；区分 `research_cutoff_at` 与
`market_as_of`，不得引入未来信息。每个 point 声明 `claim_type`：事实带 `source_ids`，
推断带 `source_ids` 和 `basis`，假设只能作为待验证问题。

1. 按 `short_term`（1—10 个交易日）、`medium_term`（2 周—6 个月）、`long_term`
   （6 个月以上）分别组织主线；短线消费市场与交易分区，中线消费行业/政策/周期，
   长线消费公司质量与估值。
2. 每个 `horizon_cases` 必须包含 `status`、`summary`、`points`、`assumptions`、
   `confirmation`、`invalidation`、`source_ids`。对应 research_ready 时必须 `status=available`
   且至少有一条有来源的 `points`；未 ready 时使用 `status=unavailable` 的结构化 horizon Artifact；增强分区缺口改写为业务风险或待观察事项，不得在面向 V6
   的 summary/points 写 `insufficient_data`、数据不足、证据不足、数据缺失、暂不判断、
   暂无法判断、未提供。
3. **核心论点**：每条 = 论点 + 证据（`source_id` / 上游 Artifact）+ 关键假设。
4. `confirmation` / `invalidation` 只能是有来源的事实或推断，不能使用
   `claim_type=hypothesis`。

## 语义完整性闭环（P0）

- 只能引用当前 run Evidence 或三路 Artifact 中已带 Evidence `source_ids` 的事实；不得引用模型记忆、对方过程或外部材料作为新事实，也不得把上游摘要当作新的数值来源。
- 禁止自由算术（加减乘除、同比/环比、比例、平均、排序、聚合、单位换算、插值），禁止自行生成价格、仓位、分数、概率、止盈止损或确认阈值。成立、确认和失效条件只能引用已有证据或写成非数值待验证假设。
- 不可把派生交易计划或某一路缺口改写成基础指标全部缺失；没有行业供需/周期证据时不得声称行业趋势或周期确认，也不得传播上游 provider、接口、URL、日志错误。
- `research_ready=false` 时只提交结构化状态、缺口和来源；不可用摘要由系统按固定映射生成。用户文本不得出现内部字段、英文状态、接口名、机器码或 HTML 实体。

## 强度排序

- 三维共振（技术 + 基本面 + 资讯同向）> 两维印证 > 单维亮点。
- 有明确来源的数据论据 > 分析师的推断性观点。
- 近期证据 > 陈旧证据（以来源时间为准）。

## 自检清单

- 每条核心论点都能说出"空头会怎么攻击"，并提前补上防守。
- 每条论点保留 `source_ids`，没有引用任何观点之外的数据。
- 关键假设全部显式写出，没有隐藏前提。
- 非核心增强维度可收缩为业务风险或待观察事项，但不得清空 research_ready 周期的可用事实。
- 不因缺失数据补写因果关系、WACC、目标价或确定性价格/比例门槛；如需表达条件，只
  作为带 `claim_type`、来源和推断 `basis` 的观点 point，报告级条件由裁决 Agent 提交。

若某周期 research_ready 未 ready，提交结构化不可用 horizon Artifact，不提交缺口状态冒充成功；不得用
“高分”“确定上涨”等不透明结论替代证据。

## 禁忌

- 不用情绪化措辞（"黄金坑""千载难逢"）。
- 不把可能性写成确定性。
- 不复读分析师原文凑字数——你的价值是组织与强化，不是转述。
