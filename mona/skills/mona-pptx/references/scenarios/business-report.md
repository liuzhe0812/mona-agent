# 企业汇报

汇报经营状况、关键指标、项目推进、差距和后续行动。

创建时在 `slide_add_preset.content` 填 `scenario: "business-report"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "business-report"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#F5F3ED", "ink": "#20242B", "muted": "#5A6270", "accent": "#5B8DEF", "surface": "#FFFFFF", "line": "#D8D2C4"}
```

## 页面表达

| 页面用途 | 通用原生回退 | 内容关系 |
|---|---|---|
| 年度或阶段汇报封面 | `light-cover-split` | `none` |
| 经营背景与目标 | `light-editorial-essay` | `none` |
| 关键指标总览 | `light-metric-spotlight` | `none` |
| 指标变化趋势 | `light-timeline` | `sequence` |
| 经营数据证据 | `light-chart-evidence` | `none` |
| 目标与实际对照 | `light-comparison-split` | `parallel` |
| 问题与行动计划 | `light-process-steps` | `sequence` |
| 结论与请求 | `light-closing-callout` | `none` |
| 经营概览网格 | `light-overview` | `parallel` |
| 单项经营指标 | `light-metric` | `none` |
| 经营图表洞察 | `light-chart-insight` | `none` |
| 项目状态总览 | `report-project-status` | `parallel` |

正文写用户提供的实际内容；所有图片路径必须指向已取得的真实素材。数组、数字、单位、来源和关系遵守当前预设容量；不适配时组合原生对象，不删事实或缩小整页。


## 选定的 Dashi 源页

以下8页是本场景从 Dashi 真实来源模板中选出的候选；不代表全部来源页已迁入。先用 `inspect capabilities` 的 `presetScenario` 查询，再指定某个 `templateId` 查看真实文本字段与字数限制。需要看画面时，用 `inspect` 的 `mode:"visual"`、`templateId` 和能力回执中的字段进行隔离预览；写入前仍应确认字段名、证据与布局。

| 用途 | Dashi 页 ID | 来源页名 | 页面角色 | 选择理由 |
|---|---|---|---|---|
| cover | `theme01_page001` | 封面 · 编辑式双栏 | cover | 汇报封面：标明汇报主题与阶段范围。 |
| body | `theme01_page010` | 横纵分析法 | context | 正文：用横纵分析法说明经营口径与分析框架。 |
| metrics | `theme01_page007` | 关键数字一览 | data、report、metrics | 指标：并列呈现项目进度与核心指标。 |
| chart | `theme01_page079` | 甜甜圈 · 资金来源占比 | data、distribution | 图表：展示资金或指标结构占比。 |
| comparison | `theme01_page075` | 同比对比 · 分组柱状图 | comparison | 对比：展示目标与实际的同期差异。 |
| process | `theme01_page040` | 阶段性策略路线图 | relationship、process、actions | 流程：列出阶段路线与关键推进节点。 |
| case-image | `theme01_page026` | 典型案例 | case、image | 图片案例：用真实项目或客户图片支撑进展说明。 |
| closing | `theme01_page050` | 标的评分卡 · 尽调五维 | metrics、result | 结尾：用多维评分汇总审查与待决事项。 |
