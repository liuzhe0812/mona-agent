---
name: event-theme-mapping
description: Map verified company or market events to themes, industry chains, catalysts and risks without turning a theme into a forecast.
---

# 事件与主题映射

只处理 `stock_evidence_read` 返回并可追溯的 `industry_context`、`policy_context`、
`cycle_context`、`event_calendar`。先确认事件事实与发布时间，再按
“事件 → 直接影响 → 行业/产业链主题 → 可能的观察标的”组织信息。

## 语义完整性闭环（P0）

- 事件映射只能复述当前 Evidence 中已有、带 `source_ids` 的事实；禁止自由算术（加减乘除、同比/环比、比例、平均、排序、聚合、单位换算、插值）或自行生成价格、仓位、分数、概率和确认阈值。
- “事件 → 行业/产业链 → 标的”是待核验的业务假设，不等于行业趋势、周期或公司业务发展已确认；缺少行业供需、产品价格或周期证据时不得越级下结论。
- `research_ready=false` 时只提交结构化状态、缺口和来源；不可用摘要由系统按固定映射生成。用户文本不得出现内部字段、英文状态、接口名、机器码或 HTML 实体。

## 规则

- 直接影响和产业链推断分开写；推断必须标注为待验证，不得冒充公告原意。
- 主题映射要说明受益/受损环节、传导假设和时间窗口；没有产业链证据就保留在
  事件层，不强行扩展标的。
- 事件只作为催化或风险候选，不能单独产生正负立场；与价格、基本面或其他资讯
  交叉后再提交。
- 每条事件、数字和映射依据带 `source_ids`；未核验传闻不进入主题主线。
- 事实、推断、假设分别声明 `claim_type`；推断必须写 `basis`。只使用研究截止前公开的
  Evidence，不补写因果、WACC、目标价或确定性价格/比例门槛。

深度投研（V6）先检查 `decision_readiness.research_ready.horizons.medium_term`。`trade_ready` 只影响交易计划；该周期 research_ready=ready 时，
缺少行业关系、政策传导或事件催化只能记录为业务风险/待观察事项；仍须从可用事实形成
neutral 或有方向的中线 context，不得在面向 V6 的摘要或观点中写
`insufficient_data`、数据不足、证据不足、数据缺失、暂不判断、暂无法判断、未提供。
该周期 research_ready 未 ready 时提交结构化不可用 Artifact，不伪造成功结论；只有全部三周期均未 ready 才由主审终止报告。
