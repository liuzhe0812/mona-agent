---
name: market-context
description: Build time-bounded market context from the current evidence bundle, separating index backdrop, catalysts, sentiment and data gaps.
---

# 市场背景

将行业/政策事件放回周期背景，但只使用本次运行证据包中的 `industry_context`、
`policy_context`、`cycle_context`、`event_calendar` 记录。先读取 `research_cutoff_at` 与 `market_as_of`，再区分“当日事实”“近期背景”和
“待观察催化”，排除研究截止后的信息。

## 语义完整性闭环（P0）

- 市场、行业、政策和周期数值只能原样引用当前 Evidence 中已有、带 `source_ids` 的字段；禁止自由算术（加减乘除、同比/环比、比例、平均、排序、聚合、单位换算、插值）或自行生成价格、仓位、分数、概率和确认阈值。
- 没有行业供需、产业链、产品价格或周期证据时，不得声称行业趋势/周期已确认；新闻只能作为催化或风险，不能替代公司经营证据。缺口只能引用 `failure_reasons`/`missing_fields` 及业务影响，不得猜 provider、接口或日志原因。
- `research_ready=false` 时只提交结构化状态、缺口和来源；不可用摘要由系统按固定映射生成。用户文本不得出现内部字段、英文状态、接口名、机器码或 HTML 实体。

## 输出框架

- **背景**：行业方向、政策阶段和周期信息（字段存在才写）。
- **影响窗口**：事件对短期情绪、中期经营或长期逻辑的可能作用，明确是假设还是
  已验证事实。
- **催化与风险**：给出可观察的后续信号和失效条件，不给目标价。
- **数据质量**：将缺少的指数、行业、资金或时效字段写成业务风险或待观察事项，不把增强
  信息缺口当作中线结论门禁。

所有事实和数值带 `source_ids`，并声明 `claim_type`；市场背景缺失时不要用常识补齐；只剩单一来源或
过期信息时说明业务风险。深度投研（V6）以 `decision_readiness.research_ready.horizons.medium_term` 作为唯一第一门禁；`trade_ready` 只影响交易计划：
该周期 research_ready=ready 时仍须基于可用事实形成 neutral 或有方向的 context，不得在面向 V6 的摘要或观点中写
`insufficient_data`、数据不足、证据不足、数据缺失、暂不判断、暂无法判断、未提供。
