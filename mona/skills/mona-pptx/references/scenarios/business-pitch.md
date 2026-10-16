# 商业路演

讲清用户问题、商业模式、增长证据、团队能力和融资诉求。

创建时在 `slide_add_preset.content` 填 `scenario: "business-pitch"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "business-pitch"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#F5F3ED", "ink": "#20242B", "muted": "#5A6270", "accent": "#F15A29", "surface": "#FFFFFF", "line": "#D8D2C4"}
```

## 页面表达

| 页面用途 | 通用原生回退 | 内容关系 |
|---|---|---|
| 路演封面 | `light-cover-split` | `none` |
| 用户问题与主张 | `light-transition-statement` | `none` |
| 市场背景 | `light-editorial-essay` | `none` |
| 商业模式 | `light-hierarchy-branch` | `hierarchy` |
| 增长与验证指标 | `light-metric-spotlight` | `none` |
| 市场与增长证据 | `light-chart-evidence` | `none` |
| 竞争格局 | `light-comparison-split` | `parallel` |
| 核心团队 | `light-team-grid` | `hierarchy` |
| 融资计划与资金用途 | `light-closing-callout` | `none` |
| 商业主张封面 | `light-product-hero` | `none` |
| 商业案例图片页 | `light-case` | `parallel` |
| 商业模式与收入闭环 | `pitch-business-model` | `parallel` |

正文写用户提供的实际内容；所有图片路径必须指向已取得的真实素材。数组、数字、单位、来源和关系遵守当前预设容量；不适配时组合原生对象，不删事实或缩小整页。


## 选定的 Dashi 源页

以下8页是本场景从 Dashi 真实来源模板中选出的候选；不代表全部来源页已迁入。先用 `inspect capabilities` 的 `presetScenario` 查询，再指定某个 `templateId` 查看真实文本字段与字数限制。需要看画面时，用 `inspect` 的 `mode:"visual"`、`templateId` 和能力回执中的字段进行隔离预览；写入前仍应确认字段名、证据与布局。

| 用途 | Dashi 页 ID | 来源页名 | 页面角色 | 选择理由 |
|---|---|---|---|---|
| cover | `theme02_page001` | 封面 · Cover | cover、image | 封面：呈现商业路演的产品或项目主视觉。 |
| body | `theme02_page055` | 结论主张 · Manifesto | statement、observation、result | 正文：用主张页讲清用户问题与价值命题。 |
| metrics | `theme11_page034` | 指标 | data、report、metrics | 指标：总结商业模式或增长的核心指标。 |
| chart | `theme02_page072` | 主题河流 · Stream | trend | 图表：展示增长或市场趋势。 |
| comparison | `theme11_page051` | 对比 | comparison | 对比：对比商业方案的关键差异。 |
| process | `theme11_page023` | 流程 | process | 流程：说明服务交付和采用步骤。 |
| case-image | `theme02_page013` | 案例图景 · Showcase | case、image | 图片案例：呈现产品或客户场景。 |
| closing | `theme11_page014` | 成果 | image、result | 结尾：用成果页收束路演证据与诉求。 |
