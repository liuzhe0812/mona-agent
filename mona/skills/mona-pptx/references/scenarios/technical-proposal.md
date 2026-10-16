# 技术方案

呈现技术背景、系统分层、方案取舍、风险和实施路线。

创建时在 `slide_add_preset.content` 填 `scenario: "technical-proposal"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "technical-proposal"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#0B1020", "ink": "#F5F7FA", "muted": "#9AA6BD", "accent": "#6C7CFF", "surface": "#141B30", "line": "#27324A"}
```

## 页面表达

| 页面用途 | 通用原生回退 | 内容关系 |
|---|---|---|
| 技术方案封面 | `dark-cover-split` | `none` |
| 现状与约束 | `dark-editorial-essay` | `none` |
| 系统关系图 | `dark-hierarchy-branch` | `hierarchy` |
| 数据流与处理步骤 | `dark-process-steps` | `sequence` |
| 备选方案对比 | `dark-comparison-split` | `parallel` |
| 技术风险矩阵 | `dark-matrix-2x2` | `matrix` |
| 性能与验证证据 | `dark-chart-evidence` | `none` |
| 实施里程碑 | `dark-timeline` | `sequence` |
| 系统架构层级 | `dark-architecture` | `hierarchy` |
| 纵向实施流程 | `dark-process-long` | `sequence` |
| 横向技术流程 | `dark-process-map` | `sequence` |
| 技术分层堆栈 | `technical-layer-stack` | `sequence` |

正文写用户提供的实际内容；所有图片路径必须指向已取得的真实素材。数组、数字、单位、来源和关系遵守当前预设容量；不适配时组合原生对象，不删事实或缩小整页。


## 选定的 Dashi 源页

以下8页是本场景从 Dashi 真实来源模板中选出的候选；不代表全部来源页已迁入。先用 `inspect capabilities` 的 `presetScenario` 查询，再指定某个 `templateId` 查看真实文本字段与字数限制。需要看画面时，用 `inspect` 的 `mode:"visual"`、`templateId` 和能力回执中的字段进行隔离预览；写入前仍应确认字段名、证据与布局。

| 用途 | Dashi 页 ID | 来源页名 | 页面角色 | 选择理由 |
|---|---|---|---|---|
| cover | `theme03_page001` | 封面 | cover、image | 封面：使用技术主视觉与主题文字。 |
| body | `theme03_page039` | 金句页 | statement、observation | 正文：提出技术方案的核心判断与原则。 |
| metrics | `theme03_page065` | 投资记分卡 | metrics、result | 指标：按检查维度汇总技术成熟度或方案得分。 |
| chart | `theme03_page061` | 资金版图 | distribution、relationship | 图表：表达资金、资源或技术组件的分布。 |
| comparison | `theme03_page021` | 案例对比 | comparison、case | 对比：并列展示两种技术案例或路径。 |
| process | `theme03_page048` | 旅程图 | process | 流程：展示系统旅程、处理阶段和节点说明。 |
| case-image | `theme03_page019` | 案例聚焦 | case、image | 图片案例：展示实验室、产品或技术现场。 |
| closing | `theme03_page077` | 封底 | closing | 结尾：以封底页收束技术方案。 |
