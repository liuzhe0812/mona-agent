---
name: event-theme-mapping
description: Map verified company or market events to themes, industry chains, catalysts and risks without turning a theme into a forecast.
---

# 事件与主题映射

只处理 `stock_evidence_read` 返回并可追溯的 `industry_context`、`policy_context`、
`cycle_context`、`event_calendar`。先确认事件事实与发布时间，再按
“事件 → 直接影响 → 行业/产业链主题 → 可能的观察标的”组织信息。

## 规则

- 直接影响和产业链推断分开写；推断必须标注为待验证，不得冒充公告原意。
- 主题映射要说明受益/受损环节、传导假设和时间窗口；没有产业链证据就保留在
  事件层，不强行扩展标的。
- 事件只作为催化或风险候选，不能单独产生正负立场；与价格、基本面或其他资讯
  交叉后再提交。
- 每条事件、数字和映射依据带 `source_ids`；未核验传闻不进入主题主线。
- 事实、推断、假设分别声明 `claim_type`；推断必须写 `basis`。只使用研究截止前公开的
  Evidence，不补写因果、WACC、目标价或确定性价格/比例门槛。

缺少足以完成映射的来源、行业关系或时点时，在对应命名数组保留空列表，提交
`insufficient_data` 并列明缺口。
