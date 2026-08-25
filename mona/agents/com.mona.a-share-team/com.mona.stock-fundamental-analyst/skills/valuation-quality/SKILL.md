---
name: valuation-quality
description: Valuation and earnings-quality cross-check for fundamental research, with explicit comparability and missing-data rules.
---

# 估值与盈利质量

这个 Skill 只补充估值口径和盈利质量校验，事实必须来自当前 Evidence Bundle，结果
写入 `financial_quality`、`valuation_context` 或 `long_term_value`，不跨到市场与资讯分区。

## 校验规则

- 先确认估值指标对应的报告期、TTM/静态口径和标的类型；口径不一致不得横向比较。
- 盈利公司可使用 PE，亏损公司不使用 PE 作为正负判断，改看已提供的 PS/PB 或
  经营质量，并明确限制。
- 历史分位、行业比较、预测值只有在证据包提供时才可使用；没有比较基准就写
  “不可比”，不凭常识填补。
- 将收入增长、利润增长、利润率变化和现金流匹配分开，避免单一高增长掩盖质量
  下滑。
- 估值字段只来自研究截止前公开的 Evidence；`period_end` 不代替公开时间。缺失字段
  不得补写因果、WACC、目标价或确定性阈值。深度投研先使用
  `decision_readiness.research_ready.horizons.long_term` 判断能否形成长线结论；`trade_ready` 仅影响交易计划；该周期 research_ready=ready 时，
  缺失同行、政策或其他增强字段只能写成业务风险/待观察事项，不能阻断可用事实形成的观点。

## 语义完整性闭环（P0）

- Evidence 是数值唯一真值：只能原样引用当前 Evidence 中已有、带 `source_ids` 的数值；不得把上游文本当作新的数字来源。
- 禁止自由算术（加减乘除、同比/环比、比例、平均、排序、聚合、单位换算、插值），不得自行生成价格、仓位、分数、概率或确认阈值。
- 估值数值只能原样引用当前 Evidence 已提供且口径、报告期和来源明确的字段；禁止自行计算倍数、同比/环比、分位、平均、目标价、现金流收益率或确认阈值。
- 没有同行、历史区间、现金流或行业适配输入时，只记录结构化缺口及业务影响；不得从新闻、单一公告或常识补出估值与公司发展结论。缺口不得猜 provider、接口或日志原因。
- `research_ready=false` 时只提交结构化状态、缺口和来源；不可用摘要由系统按固定映射生成。用户文本不得出现内部字段、英文状态、接口名、机器码或 HTML 实体。

## 输出约束

每个估值/质量结论都声明 `claim_type`，并附 `source_ids`、报告期与比较口径；推断还要
有 `basis`。比较口径或关键财务字段尚未满足该周期 research_ready 时提交结构化不可用 Artifact；
research_ready=ready 时必须保留可用事实与来源，且不得在面向 V6 的摘要或观点中写
`insufficient_data`、数据不足、证据不足、数据缺失、暂不判断、暂无法判断、未提供。
