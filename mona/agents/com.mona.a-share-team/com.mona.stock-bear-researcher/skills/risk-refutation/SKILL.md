---
name: risk-refutation
description: Build a rigorous bear case from shared analyst evidence, surfacing contradictions, evidence gaps, triggers and invalidation conditions.
---

# 风险反证构建

第一回合先调用 `stock_evidence_read(sections=[decision_readiness], detail=compact)` 获取三周期
`decision_readiness.research_ready.horizons`；它是能否形成对应周期反证的唯一第一门禁，`trade_ready`
只影响交易计划。随后用 `artifact_read(detail=compact)` 读取 technical、fundamental、news 三份
上游观点；只使用共享不可变 Evidence 和三路 Artifact，绝不读取 bull Artifact、bull 输出或任何对方过程。
不要读取原始 Evidence 分区。提交工具会用当前 run 的完整 Evidence 做校验与注入；不得引用观点之外的新数据。

只使用当前 run 中研究截止前公开的 Evidence；区分 `research_cutoff_at` 与
`market_as_of`，不得引入未来信息。每个 point 声明 `claim_type`：事实带 `source_ids`，
推断带 `source_ids` 和 `basis`，假设只能作为待验证问题。

## 语义完整性闭环（P0）

- 只能引用当前 run Evidence 或三路 Artifact 中已带 Evidence `source_ids` 的事实；不得引用模型记忆、对方过程或外部材料作为新事实，也不得把上游摘要当作新的数值来源。
- 禁止自由算术（加减乘除、同比/环比、比例、平均、排序、聚合、单位换算、插值），禁止自行生成价格、仓位、分数、概率、止盈止损或确认阈值。反证条件只能引用已有证据或写成非数值待验证假设。
- 不可把派生交易计划或某一路缺口改写成基础指标全部缺失；没有行业供需/周期证据时不得声称行业趋势或周期确认，也不得传播上游 provider、接口、URL、日志错误。
- `research_ready=false` 时只提交结构化状态、缺口和来源；不可用摘要由系统按固定映射生成。用户文本不得出现内部字段、英文状态、接口名、机器码或 HTML 实体。

## 反证骨架

1. 按 `short_term`、`medium_term`、`long_term` 分别组织反证，分别对应市场交易、
   行业政策周期、公司质量估值。
2. 每个 `horizon_cases` 必须包含 `status`、`summary`、`points`、`assumptions`、
   `confirmation`、`invalidation`、`source_ids`。对应 research_ready 时必须 `status=available`；
   有实质反证时 points 必须有来源，找不到实质反证时可为空但 summary 写“现有可用事实下反证有限”；
   research_ready 未 ready 时使用 `status=unavailable` 的结构化 horizon Artifact。增强分区缺口不得清空
   research_ready 周期的可用事实，也不得在面向 V6 的 summary/points 写
   `insufficient_data`、数据不足、证据不足、数据缺失、暂不判断、暂无法判断、未提供。
3. `confirmation` / `invalidation` 只能放有来源的事实或推断，禁止
   `claim_type=hypothesis`；假设只能留在 `assumptions`。
4. **证据缺陷**：逐条列出缺失、过期、单一来源或口径存疑字段，改写为业务风险或可观察条件；
   不得把增强信息缺口或 trade_ready=false 当作 research_ready 周期的失败理由。

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
相应周期提交 `status=available` 并写明“现有可用事实下反证有限”；research_ready 未 ready 时提交
`status=unavailable` 的结构化 horizon Artifact，不得输出缺口状态冒充成功，也不得输出不透明评分、目标价或买卖指令。
