# 战略规划

梳理战略背景、选择依据、风险情景、路线图和执行安排。

创建时在 `slide_add_preset.content` 填 `scenario: "strategy-planning"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "strategy-planning"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#0B1020", "ink": "#F5F7FA", "muted": "#9AA6BD", "accent": "#D2FB30", "surface": "#141B30", "line": "#27324A"}
```

## 页面表达

| 页面用途 | 通用原生回退 | 内容关系 |
|---|---|---|
| 战略规划封面 | `dark-cover-split` | `none` |
| 战略背景与目标 | `dark-editorial-essay` | `none` |
| 目标与关键结果 | `dark-metric-spotlight` | `none` |
| 业务组合与相互关系 | `dark-hierarchy-branch` | `hierarchy` |
| 机会与风险情景 | `dark-matrix-2x2` | `matrix` |
| 战略路线图 | `dark-timeline` | `sequence` |
| 执行步骤 | `dark-process-steps` | `sequence` |
| 战略指标与证据 | `dark-chart-evidence` | `none` |
| 战略图表洞察 | `dark-chart-insight` | `none` |
| 战略方案比较 | `dark-comparison` | `parallel` |
| 战略议题概览 | `dark-overview` | `parallel` |
| 战略选项决策矩阵 | `strategy-decision-options` | `parallel` |

正文写用户提供的实际内容；所有图片路径必须指向已取得的真实素材。数组、数字、单位、来源和关系遵守当前预设容量；不适配时组合原生对象，不删事实或缩小整页。


## 选定的 Dashi 源页

以下8页是本场景从 Dashi 真实来源模板中选出的候选；不代表全部来源页已迁入。先用 `inspect capabilities` 的 `presetScenario` 查询，再指定某个 `templateId` 查看真实文本字段与字数限制。需要看画面时，用 `inspect` 的 `mode:"visual"`、`templateId` 和能力回执中的字段进行隔离预览；写入前仍应确认字段名、证据与布局。

| 用途 | Dashi 页 ID | 来源页名 | 页面角色 | 选择理由 |
|---|---|---|---|---|
| cover | `theme06_page005` | 01 · 封面 / COVER | cover、image | 封面：战略分析报告主视觉。 |
| body | `theme06_page008` | 04 · 研究方法 / METHODOLOGY | context | 正文：说明战略研究方法、目标和约束。 |
| metrics | `theme06_page032` | 28 · 大数字 / BIG NUMBER | data、metrics、image | 指标：展示一个战略目标值及其说明。 |
| chart | `theme06_page015` | 11 · 回落季度 / Q4 PULLBACK | trend | 图表：展示关键季度或周期走势。 |
| comparison | `theme06_page029` | 25 · 机会矩阵 / QUADRANT | comparison | 对比：在机会矩阵中呈现战略选择依据。 |
| process | `theme06_page038` | 34 · 企业流程嵌入 / LOW CODE | image、process | 流程：呈现业务流程嵌入或执行环节。 |
| case-image | `theme06_page028` | 24 · 典型案例 / CASE STUDIES | case、image | 图片案例：展示典型案例并保留媒体槽。 |
| closing | `theme06_page071` | 67 · 结论 / CONCLUSION | statement、observation、result | 结尾：明确最终判断与决策建议。 |
