# 经营数据

复盘指标走势、分部表现、关键驱动因素和经营动作。

创建时在 `slide_add_preset.content` 填 `scenario: "data-review"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "data-review"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#F5F3ED", "ink": "#20242B", "muted": "#5A6270", "accent": "#D8402E", "surface": "#FFFFFF", "line": "#D8D2C4"}
```

## 页面表达

| 页面用途 | 通用原生回退 | 内容关系 |
|---|---|---|
| 经营复盘封面 | `light-cover-split` | `none` |
| 核心指标记分板 | `light-metric-spotlight` | `none` |
| 指标趋势 | `light-timeline` | `sequence` |
| 图表证据与结论 | `light-chart-evidence` | `none` |
| 区域或产品表现 | `light-parallel-grid` | `parallel` |
| 目标与实际差异 | `light-comparison-split` | `parallel` |
| 复盘后的经营动作 | `light-process-steps` | `sequence` |
| 结论摘要 | `light-closing-callout` | `none` |
| 经营驱动因素拆解 | `data-driver-review` | `none` |

正文写用户提供的实际内容；所有图片路径必须指向已取得的真实素材。数组、数字、单位、来源和关系遵守当前预设容量；不适配时组合原生对象，不删事实或缩小整页。


## 选定的 Dashi 源页

以下8页是本场景从 Dashi 真实来源模板中选出的候选；不代表全部来源页已迁入。先用 `inspect capabilities` 的 `presetScenario` 查询，再指定某个 `templateId` 查看真实文本字段与字数限制。需要看画面时，用 `inspect` 的 `mode:"visual"`、`templateId` 和能力回执中的字段进行隔离预览；写入前仍应确认字段名、证据与布局。

| 用途 | Dashi 页 ID | 来源页名 | 页面角色 | 选择理由 |
|---|---|---|---|---|
| cover | `theme06_page005` | 01 · 封面 / COVER | cover、image | 封面：深色图谱主题的报告开场。 |
| body | `theme05_page017` | 策略 Outlook | report、actions | 正文：说明策略、经营解释与执行重点。 |
| metrics | `theme05_page086` | 综合评分 Scorecard | metrics、result | 指标：用综合评分结构汇总核心表现。 |
| chart | `theme05_page029` | 累计曲线 Cumulative | trend | 图表：展示累计指标随时间的变化。 |
| comparison | `theme05_page022` | 环比对比 Delta | comparison | 对比：显示环比差异、变化方向与数值依据。 |
| process | `theme05_page052` | 评测流程 Shield | process | 流程：拆解指标评测或数据复核步骤。 |
| image | `theme05_page061` | 地理身份 Region | image | 图片：展示区域、聚类或分布身份图像。 |
| closing | `theme06_page071` | 67 · 结论 / CONCLUSION | statement、observation、result | 结尾：归纳数据复盘结论和经营判断。 |
