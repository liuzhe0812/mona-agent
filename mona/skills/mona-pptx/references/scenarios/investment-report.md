# 金融投研

组织投资论点、市场数据、估值比较、风险情景和决策依据。

创建时在 `slide_add_preset.content` 填 `scenario: "investment-report"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "investment-report"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#0B1020", "ink": "#F5F7FA", "muted": "#9AA6BD", "accent": "#D6A84F", "surface": "#141B30", "line": "#27324A"}
```

## 页面表达

| 页面用途 | 通用原生回退 | 内容关系 |
|---|---|---|
| 投研封面 | `dark-cover-split` | `none` |
| 投资论点 | `dark-editorial-essay` | `none` |
| 核心财务指标 | `dark-metric-spotlight` | `none` |
| 业绩与市场走势 | `dark-timeline` | `sequence` |
| 估值与市场证据 | `dark-chart-evidence` | `none` |
| 可比公司与估值对照 | `dark-comparison-split` | `parallel` |
| 风险分类矩阵 | `dark-matrix-2x2` | `matrix` |
| 组合配置 | `dark-parallel-grid` | `parallel` |
| 投资结论 | `dark-closing-callout` | `none` |
| 投资论点横向比较 | `dark-parallel-columns` | `parallel` |
| 风险与情景分析 | `investment-risk-scenarios` | `parallel` |

正文写用户提供的实际内容；所有图片路径必须指向已取得的真实素材。数组、数字、单位、来源和关系遵守当前预设容量；不适配时组合原生对象，不删事实或缩小整页。


## 选定的 Dashi 源页

以下8页是本场景从 Dashi 真实来源模板中选出的候选；不代表全部来源页已迁入。先用 `inspect capabilities` 的 `presetScenario` 查询，再指定某个 `templateId` 查看真实文本字段与字数限制。需要看画面时，用 `inspect` 的 `mode:"visual"`、`templateId` 和能力回执中的字段进行隔离预览；写入前仍应确认字段名、证据与布局。

| 用途 | Dashi 页 ID | 来源页名 | 页面角色 | 选择理由 |
|---|---|---|---|---|
| cover | `theme10_page005` | 封面 | cover | 封面：使用指数风格的投资报告封面。 |
| body | `theme10_page006` | 章节索引 | transition | 正文：以章节索引组织投资论点与分析分部。 |
| metrics | `theme10_page025` | 数据仪表盘 | data、metrics | 指标：汇总组合或标的仪表指标。 |
| chart | `theme05_page029` | 累计曲线 Cumulative | trend | 图表：展示投资相关走势或周期变化。 |
| comparison | `theme10_page018` | 抉择双栏 | comparison | 对比：并列评估投资决策选项。 |
| process | `theme10_page068` | 旅程进度 | process | 流程：展示投资决策旅程和阶段目标。 |
| case-image | `theme06_page028` | 24 · 典型案例 / CASE STUDIES | case、image | 图片案例：展示投研标的或典型案例。 |
| closing | `theme10_page095` | 结束 | image、result、closing | 结尾：用结束页呈现最终投资判断。 |
