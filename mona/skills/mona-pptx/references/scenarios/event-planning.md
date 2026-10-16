# 活动策划

组织活动目标、议程、嘉宾阵容、现场执行、风险和效果指标。

创建时在 `slide_add_preset.content` 填 `scenario: "event-planning"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "event-planning"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#0B1020", "ink": "#F5F7FA", "muted": "#9AA6BD", "accent": "#D61FB5", "surface": "#141B30", "line": "#27324A"}
```

## 页面表达

| 页面用途 | 通用原生回退 | 内容关系 |
|---|---|---|
| 活动主视觉封面 | `dark-cover-split` | `none` |
| 活动主张与目标 | `dark-transition-statement` | `none` |
| 活动内容板块 | `dark-parallel-grid` | `parallel` |
| 活动议程 | `dark-timeline` | `sequence` |
| 嘉宾与演出阵容 | `dark-team-grid` | `hierarchy` |
| 现场体验与场景 | `dark-gallery` | `parallel` |
| 观众体验流程 | `dark-process-steps` | `sequence` |
| 现场风险预案 | `dark-matrix-2x2` | `matrix` |
| 触达与活动效果 | `dark-metric-spotlight` | `none` |
| 现场执行流程表 | `event-run-of-show` | `sequence` |

正文写用户提供的实际内容；所有图片路径必须指向已取得的真实素材。数组、数字、单位、来源和关系遵守当前预设容量；不适配时组合原生对象，不删事实或缩小整页。


## 选定的 Dashi 源页

以下8页是本场景从 Dashi 真实来源模板中选出的候选；不代表全部来源页已迁入。先用 `inspect capabilities` 的 `presetScenario` 查询，再指定某个 `templateId` 查看真实文本字段与字数限制。需要看画面时，用 `inspect` 的 `mode:"visual"`、`templateId` 和能力回执中的字段进行隔离预览；写入前仍应确认字段名、证据与布局。

| 用途 | Dashi 页 ID | 来源页名 | 页面角色 | 选择理由 |
|---|---|---|---|---|
| cover | `theme12_page002` | 封面 · 声波 / Spectrum | cover | 封面：潮流活动主视觉开场。 |
| body | `theme12_page080` | 大间章 / Divider | transition | 正文：用章节页引出活动主张或环节。 |
| metrics | `theme12_page061` | 评分表 / Scorecard | metrics、result | 指标：用评分表明确活动效果衡量维度。 |
| chart | `theme12_page047` | 瀑布图 / Waterfall | data、distribution | 图表：表达活动预算、效果或资源变化。 |
| comparison | `theme12_page031` | 前后对比 / Before · After | comparison、image | 对比：展示活动前后或方案差异。 |
| process | `theme12_page011` | 流程 / How It Works | process | 流程：列出活动议程与现场执行步骤。 |
| image | `theme12_page029` | 邮票张 / Stamps | image | 图片：用真实图片展示场景或现场体验。 |
| closing | `theme08_page083` | (90) 记分卡 · Scorecard | metrics、result | 结尾：用记分板汇总活动效果与结果。 |
