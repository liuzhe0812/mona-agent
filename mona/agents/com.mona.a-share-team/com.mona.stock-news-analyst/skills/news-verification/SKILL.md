---
name: news-verification
description: Verify announcements and news by source quality, timing, cross-checking and fact-versus-opinion separation.
---

# 资讯核验

深度投研（V6）先用 `stock_evidence_read(sections=["decision_readiness"])`，以
`decision_readiness.research_ready.horizons.medium_term` 作为能否形成中线观点的唯一第一门禁；
`trade_ready` 只影响交易计划，不改变研究结论；
`evidence_coverage` 只记录增强信息局限。随后传入
`sections=["industry_context", "policy_context", "cycle_context", "event_calendar"]`，读取带来源记录的四个分区及公告和新闻；需要原文时只用
`stock_source_open` 打开当前运行的 `source_id`。不得把模型记忆、搜索摘要或无来源
传闻写成事实。

## 核验顺序

1. 以 `research_cutoff_at` 过滤未来发布或时间异常的记录，并将其与
   `market_as_of` 分开记录。
2. 来源分级：监管/交易所/公司披露 > 主流财经媒体 > 自媒体/论坛；低等级来源
   只能作为“未经证实”的风险提示。
3. 同一事件合并多来源，保留全部 `source_id`；来源冲突要分别陈述。
4. 分离事实、来源原文可支持的影响判断和仍待验证的推断，标注事件持续性。

## 语义完整性闭环（P0）

- 事件、政策、行业和周期数值只能原样引用当前 Evidence 中已有、带 `source_ids` 的字段；禁止自由算术（加减乘除、同比/环比、比例、平均、排序、聚合、单位换算、插值）或自行生成价格、仓位、分数、概率和确认阈值。
- 没有行业供需、产业链、产品价格或 `cycle_context` 证据时，不得声称行业趋势、行业周期或政策传导已确认；单一资讯只能作为催化/风险，不能代替行业或公司经营证据。缺口只能引用 `failure_reasons`/`missing_fields` 及业务影响，不得猜 provider、接口或日志原因。
- `research_ready=false` 时只提交结构化状态、缺口和来源；不可用摘要由系统按固定映射生成。用户文本不得出现内部字段、英文状态、接口名、机器码或 HTML 实体。

## 输出约束

按影响和时效排序，把事件写入 `event_calendar`，政策/行业/周期判断分别写入对应命名数组。每个 point 声明 `claim_type`：事实带 `source_ids`，
推断带 `source_ids` 和 `basis`，假设只进入待验证问题。该周期 research_ready=ready 时没有催化也要基于可追溯现有事实提交 neutral context；行业/政策/新闻缺口改写为业务风险或待观察事项，不得在面向 V6 的摘要或观点中写
`insufficient_data`、数据不足、证据不足、数据缺失、暂不判断、暂无法判断、未提供。资讯不得单独决定买卖。该周期 research_ready 未 ready 时提交结构化不可用 Artifact，不伪造 V6 结论，不用“无消息=利好/利空”。不得因缺失
数据补写因果、WACC、目标价或确定性价格/比例门槛；该周期 research_ready 未 ready 时提交结构化不可用 Artifact，不伪造成功结论。
