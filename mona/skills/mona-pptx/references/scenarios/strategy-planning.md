# 战略规划

梳理战略背景、选择依据、风险情景、路线图和执行安排。

创建时在 `slide_add_preset.content` 填 `scenario: "strategy-planning"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "strategy-planning"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#0B1020", "ink": "#F5F7FA", "muted": "#9AA6BD", "accent": "#D2FB30", "surface": "#141B30", "line": "#27324A"}
```

## 页面表达

| 页面用途 | 原生预设 | 内容关系 |
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

下图为 `strategy-decision-options` 的真实 Office 渲染；示例资料仅验证构图，不代表业务结论。

![战略规划特色页](../../assets/presets/strategy-decision-options.png)
