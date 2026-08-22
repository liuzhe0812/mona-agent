---
name: risk-refutation
description: Build a rigorous bear case from shared analyst evidence, surfacing contradictions, evidence gaps, triggers and invalidation conditions.
---

# 风险反证构建

先用 `artifact_read(detail=compact)` 读取 technical、fundamental、news 三份上游观点，
再只调用一次 `stock_evidence_read(sections=[evidence_coverage], detail=compact)` 获取覆盖状态；
不要读取原始 Evidence 分区。提交工具会用当前 run 的完整 Evidence 做校验与注入。空头与多头
必须共享这组证据；不得引用观点之外的新数据。

只使用当前 run 中研究截止前公开的 Evidence；区分 `research_cutoff_at` 与
`market_as_of`，不得引入未来信息。每个 point 声明 `claim_type`：事实带 `source_ids`，
推断带 `source_ids` 和 `basis`，假设只能作为待验证问题。

## 反证骨架

1. 按 `short_term`、`medium_term`、`long_term` 分别组织反证，分别对应市场交易、
   行业政策周期、公司质量估值。
2. 每个 `horizon_cases` 必须包含 `status`、`summary`、`points`、`assumptions`、
   `confirmation`、`invalidation`、`source_ids`。`status=available` 至少有一条
   `points`；`status=insufficient_data` 可全部为空，但 summary 要说明缺口。
3. `confirmation` / `invalidation` 只能放有来源的事实或推断，禁止
   `claim_type=hypothesis`；假设只能留在 `assumptions`。
4. **证据缺陷**：逐条列出缺失、过期、单一来源或口径存疑字段，给出可观察的条件。

## 攻击角度

- 检查上游结论是否依赖单一来源、极端外推或陈旧数据。
- 对照三份观点与原始证据，明确列出矛盾而不是简单否定。
- 评估技术破位、基本面恶化和资讯利空的下行触发条件。
- 观点高度一致时检查是否存在一致预期风险，但没有证据就不能写成事实。
- 不因缺失数据补写因果关系、WACC、目标价或确定性价格/比例门槛；如需表达条件，只
  作为带 `claim_type`、来源和推断 `basis` 的观点 point，报告级条件由裁决 Agent 提交。

## 输出

调用 `submit_bear_case` 提交公共字段和完整的三个 `horizon_cases`。每条声明带
`claim_type`，事实/推断附 `source_ids`（推断还要有 `basis`）。找不到实质反证时对
相应周期提交 `status=insufficient_data` 并写明“现有证据下反证有限”；不得输出不透明
评分、目标价或买卖指令。
