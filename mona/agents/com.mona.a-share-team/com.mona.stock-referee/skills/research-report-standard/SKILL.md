---
name: research-report-standard
description: Standard for the final A-share research report — conflict adjudication rules, stance grading, data-quality marking and section discipline.
---

# 研究报告规范

## 立场分级（research_stance）

- `positive`：多空权衡后正面证据明显占优，且核心假设不脆弱。
- `neutral`：证据互抵、方向不明，或多空各有成立之处。
- `negative`：负面证据明显占优，或关键假设被空头证伪。
- `insufficient_data`：核心数据缺失/过期，任何方向性结论都不负责任——此时报告照常产出，立场为证据不足。

## 冲突裁决规则

1. 证据强度优先：有来源记录的直接数据 > 分析师推断。
2. 时效优先：距 `as_of` 更近的证据权重更高。
3. 来源等级优先：公告/官方披露 > 主流媒体报道 > 其他。
4. 裁决必须写明依据，不允许"综合考虑后认为"式模糊带过。

## 数据质量（data_quality）

- `complete`：行情、财务、资讯三类证据齐备且新鲜。
- `partial`：有缺口但不影响形成结论——在 `missing_fields` 列明。
- `insufficient`：缺口大到无法形成结论——stance 必须是 `insufficient_data`。

## 章节纪律

- 摘要（summary）：先结论后依据，不超过三句话讲清主线。
- 市场快照 / 技术位：直接引用证据包数值，注明时间与来源。
- 风险：每条风险给出证据或触发条件，不写空话。
- 催化：未来可能改变结论的事件或数据，附时间窗口。
- 待解问题：本次证据无法回答、需要后续跟踪的问题清单。

## 复盘简报（digest）附加规则

- 每只标的一行：评分倾向 + 数据质量标记 + 一句多空要点。
- 排序按倾向置信度，证据不足的标的排最后并注明缺口。
