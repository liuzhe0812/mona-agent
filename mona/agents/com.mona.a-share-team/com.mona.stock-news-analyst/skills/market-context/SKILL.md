---
name: market-context
description: Build time-bounded market context from the current evidence bundle, separating index backdrop, catalysts, sentiment and data gaps.
---

# 市场背景

将行业/政策事件放回周期背景，但只使用本次运行证据包中的 `industry_context`、
`policy_context`、`cycle_context`、`event_calendar` 记录。先读取 `research_cutoff_at` 与 `market_as_of`，再区分“当日事实”“近期背景”和
“待观察催化”，排除研究截止后的信息。

## 输出框架

- **背景**：行业方向、政策阶段和周期信息（字段存在才写）。
- **影响窗口**：事件对短期情绪、中期经营或长期逻辑的可能作用，明确是假设还是
  已验证事实。
- **催化与风险**：给出可观察的后续信号和失效条件，不给目标价。
- **数据质量**：列出缺少的指数、行业、资金或时效字段。

所有事实和数值带 `source_ids`，并声明 `claim_type`；市场背景缺失时不要用常识补齐；只剩单一来源或
过期信息时降低 stance，必要时提交 `insufficient_data`。
