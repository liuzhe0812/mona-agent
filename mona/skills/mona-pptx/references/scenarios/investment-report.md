# 金融投研

组织投资论点、市场数据、估值比较、风险情景和决策依据。

创建时在 `slide_add_preset.content` 填 `scenario: "investment-report"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "investment-report"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#0B1020", "ink": "#F5F7FA", "muted": "#9AA6BD", "accent": "#D6A84F", "surface": "#141B30", "line": "#27324A"}
```

## 页面表达

| 页面用途 | 原生预设 | 内容关系 |
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

下图为 `investment-risk-scenarios` 的真实 Office 渲染；示例资料仅验证构图，不代表业务结论。

![金融投研特色页](../../assets/presets/investment-risk-scenarios.png)
