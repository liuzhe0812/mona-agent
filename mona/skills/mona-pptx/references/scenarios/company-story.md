# 企业故事

讲述企业起点、关键里程碑、团队成长和客户实践。

创建时在 `slide_add_preset.content` 填 `scenario: "company-story"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "company-story"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#0B1020", "ink": "#F5F7FA", "muted": "#9AA6BD", "accent": "#FFB27A", "surface": "#141B30", "line": "#27324A"}
```

## 页面表达

| 页面用途 | 通用原生回退 | 内容关系 |
|---|---|---|
| 企业故事封面 | `dark-cover-split` | `none` |
| 使命与初心 | `dark-transition-statement` | `none` |
| 企业起点与背景 | `dark-editorial-essay` | `none` |
| 团队与组织 | `dark-team-grid` | `hierarchy` |
| 客户与实践故事 | `dark-gallery` | `parallel` |
| 发展历程时间线 | `dark-timeline` | `sequence` |
| 成长数据 | `dark-metric-spotlight` | `none` |
| 企业价值与能力 | `dark-hierarchy-branch` | `hierarchy` |
| 未来愿景 | `dark-closing-callout` | `none` |
| 企业发展里程碑 | `story-milestones` | `sequence` |

正文写用户提供的实际内容；所有图片路径必须指向已取得的真实素材。数组、数字、单位、来源和关系遵守当前预设容量；不适配时组合原生对象，不删事实或缩小整页。


## 选定的 Dashi 源页

以下8页是本场景从 Dashi 真实来源模板中选出的候选；不代表全部来源页已迁入。先用 `inspect capabilities` 的 `presetScenario` 查询，再指定某个 `templateId` 查看真实文本字段与字数限制。需要看画面时，用 `inspect` 的 `mode:"visual"`、`templateId` 和能力回执中的字段进行隔离预览；写入前仍应确认字段名、证据与布局。

| 用途 | Dashi 页 ID | 来源页名 | 页面角色 | 选择理由 |
|---|---|---|---|---|
| cover | `theme09_page002` | 封面C 斜切 | cover | 封面：杂志式企业故事开场。 |
| body | `theme09_page101` | 篇章卡 | transition | 正文：用篇章卡组织起点、实践与成长。 |
| metrics | `theme09_page050` | 09 关键指标 | data、report、metrics | 指标：展示企业关键发展指标。 |
| chart | `theme09_page089` | 10 季度走势 | data、trend、closing | 图表：呈现企业年度或季度变化。 |
| comparison | `theme09_page103` | 12 多维对比 | comparison | 对比：多维对照企业阶段、团队或业务。 |
| process | `theme09_page104` | 13 实施路径 | process | 流程：串联企业发展和实施里程碑。 |
| case-image | `theme09_page022` | 05 典型案例 | case、image | 图片案例：讲述真实客户或实践案例。 |
| closing | `theme09_page086` | 年度计分榜 | metrics、result | 结尾：以年度计分板归纳企业阶段成果。 |
