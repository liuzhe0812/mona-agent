---
name: bull-case-building
description: Build a rigorous bull case from shared analyst evidence, with resonance, assumptions, confirmation conditions and source traceability.
---

# 正面论证构建

## 输入与论证骨架

先用 `artifact_read(detail=compact)` 读取 technical、fundamental、news 三份上游观点，
再只调用一次 `stock_evidence_read(sections=[evidence_coverage], detail=compact)` 获取覆盖状态；
不要读取原始 Evidence 分区。提交工具会用当前 run 的完整 Evidence 做校验与注入。多头只能
使用该共同证据集，不得自行补充行情或新闻。

只使用当前 run 中研究截止前公开的 Evidence；区分 `research_cutoff_at` 与
`market_as_of`，不得引入未来信息。每个 point 声明 `claim_type`：事实带 `source_ids`，
推断带 `source_ids` 和 `basis`，假设只能作为待验证问题。

1. 按 `short_term`（1—10 个交易日）、`medium_term`（2 周—6 个月）、`long_term`
   （6 个月以上）分别组织主线；短线消费市场与交易分区，中线消费行业/政策/周期，
   长线消费公司质量与估值。
2. 每个 `horizon_cases` 必须包含 `status`、`summary`、`points`、`assumptions`、
   `confirmation`、`invalidation`、`source_ids`。`status=available` 至少有一条
   `points`；`status=insufficient_data` 可全部为空，但 summary 要说明缺口。
3. **核心论点**：每条 = 论点 + 证据（`source_id` / 上游 Artifact）+ 关键假设。
4. `confirmation` / `invalidation` 只能是有来源的事实或推断，不能使用
   `claim_type=hypothesis`。

## 强度排序

- 三维共振（技术 + 基本面 + 资讯同向）> 两维印证 > 单维亮点。
- 有明确来源的数据论据 > 分析师的推断性观点。
- 近期证据 > 陈旧证据（以来源时间为准）。

## 自检清单

- 每条核心论点都能说出"空头会怎么攻击"，并提前补上防守。
- 每条论点保留 `source_ids`，没有引用任何观点之外的数据。
- 关键假设全部显式写出，没有隐藏前提。
- 证据不足的维度已收缩或剔除，没有硬凑。
- 不因缺失数据补写因果关系、WACC、目标价或确定性价格/比例门槛；如需表达条件，只
  作为带 `claim_type`、来源和推断 `basis` 的观点 point，报告级条件由裁决 Agent 提交。

若共同证据不足，仍提交三个周期的结构化结果，summary 直接说明无法建立强多头论证
以及缺失字段；不得用“高分”“确定上涨”等不透明结论替代证据。

## 禁忌

- 不用情绪化措辞（"黄金坑""千载难逢"）。
- 不把可能性写成确定性。
- 不复读分析师原文凑字数——你的价值是组织与强化，不是转述。
