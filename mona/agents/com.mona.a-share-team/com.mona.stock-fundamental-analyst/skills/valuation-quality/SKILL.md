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
  不得补写因果、WACC、目标价或确定性阈值。

## 输出约束

每个估值/质量结论都声明 `claim_type`，并附 `source_ids`、报告期与比较口径；推断还要
有 `basis`。比较口径或关键财务字段缺失时，在提交观点中使用 `insufficient_data` 或
明确的缺失项。
