# 品牌提案

呈现品牌主张、受众定位、创意概念、视觉方向和传播计划。

创建时在 `slide_add_preset.content` 填 `scenario: "brand-proposal"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "brand-proposal"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#F5F3ED", "ink": "#20242B", "muted": "#5A6270", "accent": "#C9A227", "surface": "#FFFFFF", "line": "#D8D2C4"}
```

## 页面表达

| 页面用途 | 通用原生回退 | 内容关系 |
|---|---|---|
| 品牌提案封面 | `light-cover-split` | `none` |
| 品牌主张 | `light-transition-statement` | `none` |
| 受众与市场背景 | `light-editorial-essay` | `none` |
| 品牌价值结构 | `light-hierarchy-branch` | `hierarchy` |
| 视觉方向与情绪板 | `light-gallery` | `parallel` |
| 品牌定位比较 | `light-comparison-split` | `parallel` |
| 传播与发布节奏 | `light-timeline` | `sequence` |
| 创意与执行团队 | `light-team-grid` | `hierarchy` |
| 品牌概念与创意论证 | `brand-concept-proposal` | `none` |

正文写用户提供的实际内容；所有图片路径必须指向已取得的真实素材。数组、数字、单位、来源和关系遵守当前预设容量；不适配时组合原生对象，不删事实或缩小整页。


## 选定的 Dashi 源页

以下8页是本场景从 Dashi 真实来源模板中选出的候选；不代表全部来源页已迁入。先用 `inspect capabilities` 的 `presetScenario` 查询，再指定某个 `templateId` 查看真实文本字段与字数限制。需要看画面时，用 `inspect` 的 `mode:"visual"`、`templateId` 和能力回执中的字段进行隔离预览；写入前仍应确认字段名、证据与布局。

| 用途 | Dashi 页 ID | 来源页名 | 页面角色 | 选择理由 |
|---|---|---|---|---|
| cover | `theme08_page005` | ① 封面 · Cover | cover、image | 封面：高对比品牌主视觉，可替换封面媒体。 |
| body | `theme04_page007` | 研究方法 | context、image | 正文：说明研究方法和创意概念的推导过程。 |
| metrics | `theme08_page078` | (84) 大数字 · Gauge | metrics | 指标：用仪表结构表达品牌目标或评估结果。 |
| chart | `theme08_page024` | ㉒ 贡献瀑布 · Waterfall | data、distribution | 图表：展示品牌贡献或传播阶段变化。 |
| comparison | `theme04_page053` | 估值跃迁 | comparison | 对比：比较品牌定位、价值主张或创意方向。 |
| process | `theme08_page081` | (87) 路线图 · Roadmap | relationship、process、actions | 流程：表达品牌传播与发布路线图。 |
| case-image | `theme04_page059` | 焦点机位 | case、image | 图片案例：用真实视觉素材论证品牌概念。 |
| closing | `theme04_page074` | 核心结论 | data、report、statement、metrics、observation、result | 结尾：归纳品牌主张与提案结论。 |
