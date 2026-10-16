# 产品展示

说明产品价值、核心能力、使用场景、效果证据和发布计划。

创建时在 `slide_add_preset.content` 填 `scenario: "product-showcase"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "product-showcase"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#0B1020", "ink": "#F5F7FA", "muted": "#9AA6BD", "accent": "#72DFC1", "surface": "#141B30", "line": "#27324A"}
```

## 页面表达

| 页面用途 | 通用原生回退 | 内容关系 |
|---|---|---|
| 产品主视觉封面 | `dark-cover-split` | `none` |
| 产品价值主张 | `dark-editorial-essay` | `none` |
| 核心能力矩阵 | `dark-parallel-grid` | `parallel` |
| 产品效果指标 | `dark-metric-spotlight` | `none` |
| 产品组成与模块关系 | `dark-hierarchy-branch` | `hierarchy` |
| 典型使用场景 | `dark-gallery` | `parallel` |
| 方案或版本对照 | `dark-comparison-split` | `parallel` |
| 发布与采用路径 | `dark-process-steps` | `sequence` |
| 产品主张与主视觉 | `dark-product-hero` | `none` |
| 产品指标侧栏 | `dark-metric` | `none` |
| 产品案例与图片 | `dark-case` | `parallel` |
| 功能与用户价值证据 | `product-feature-proof` | `none` |

正文写用户提供的实际内容；所有图片路径必须指向已取得的真实素材。数组、数字、单位、来源和关系遵守当前预设容量；不适配时组合原生对象，不删事实或缩小整页。


## 选定的 Dashi 源页

以下8页是本场景从 Dashi 真实来源模板中选出的候选；不代表全部来源页已迁入。先用 `inspect capabilities` 的 `presetScenario` 查询，再指定某个 `templateId` 查看真实文本字段与字数限制。需要看画面时，用 `inspect` 的 `mode:"visual"`、`templateId` 和能力回执中的字段进行隔离预览；写入前仍应确认字段名、证据与布局。

| 用途 | Dashi 页 ID | 来源页名 | 页面角色 | 选择理由 |
|---|---|---|---|---|
| cover | `theme02_page001` | 封面 · Cover | cover、image | 封面：产品发布主视觉，可替换封面媒体。 |
| body | `theme02_page006` | 研究方法 · Method | context | 正文：拆解产品方法、机制与能力模块。 |
| metrics | `theme04_page032` | 资本计分卡 | metrics、result | 指标：用能力记分卡总结产品表现维度。 |
| chart | `theme02_page072` | 主题河流 · Stream | trend | 图表：展示主题或功能采用趋势。 |
| comparison | `theme02_page054` | 差距图 · Dumbbell | comparison | 对比：比较产品方案或版本差距。 |
| process | `theme02_page056` | 策略路线 · Roadmap | relationship、process、actions | 流程：说明发布、部署或采用路线。 |
| case-image | `theme02_page013` | 案例图景 · Showcase | case、image | 图片案例：展示产品在真实使用场景中的效果。 |
| closing | `theme04_page074` | 核心结论 | data、report、statement、metrics、observation、result | 结尾：归纳产品核心结论与价值。 |
