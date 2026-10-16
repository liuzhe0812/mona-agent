# 教学培训

设计学习目标、知识结构、讲解示例、练习实验和学习检查。

创建时在 `slide_add_preset.content` 填 `scenario: "education-training"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "education-training"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#F5F3ED", "ink": "#20242B", "muted": "#5A6270", "accent": "#3458B4", "surface": "#FFFFFF", "line": "#D8D2C4"}
```

## 页面表达

| 页面用途 | 通用原生回退 | 内容关系 |
|---|---|---|
| 课程或培训封面 | `light-cover-split` | `none` |
| 学习目标 | `light-transition-statement` | `none` |
| 课程结构 | `light-parallel-grid` | `parallel` |
| 核心概念关系图 | `light-hierarchy-branch` | `hierarchy` |
| 讲解示例 | `light-gallery` | `parallel` |
| 实验对照 | `light-comparison-split` | `parallel` |
| 课堂讲解流程 | `light-process-steps` | `sequence` |
| 学习检查点 | `light-metric-spotlight` | `none` |
| 知识回顾 | `light-closing-callout` | `none` |
| 长流程教学步骤 | `light-process-long` | `sequence` |
| 知识掌握四象限 | `light-matrix-2x2` | `matrix` |
| 课堂练习与反馈 | `education-practice` | `sequence` |

正文写用户提供的实际内容；所有图片路径必须指向已取得的真实素材。数组、数字、单位、来源和关系遵守当前预设容量；不适配时组合原生对象，不删事实或缩小整页。


## 选定的 Dashi 源页

以下8页是本场景从 Dashi 真实来源模板中选出的候选；不代表全部来源页已迁入。先用 `inspect capabilities` 的 `presetScenario` 查询，再指定某个 `templateId` 查看真实文本字段与字数限制。需要看画面时，用 `inspect` 的 `mode:"visual"`、`templateId` 和能力回执中的字段进行隔离预览；写入前仍应确认字段名、证据与布局。

| 用途 | Dashi 页 ID | 来源页名 | 页面角色 | 选择理由 |
|---|---|---|---|---|
| cover | `theme01_page001` | 封面 · 编辑式双栏 | cover | 封面：清晰说明课程或培训主题。 |
| body | `theme07_page010` | 热力 Heatmap | data、report、distribution、relationship | 正文：以热力矩阵组织知识分类或掌握情况。 |
| metrics | `theme01_page007` | 关键数字一览 | data、report、metrics | 指标：用卡片列出学习目标或检查结果。 |
| chart | `theme07_page021` | 季度 Q4 回落 | trend | 图表：说明实验数据或学习趋势。 |
| comparison | `theme03_page021` | 案例对比 | comparison、case | 对比：比较练习案例、解法或实验结果。 |
| process | `theme03_page048` | 旅程图 | process | 流程：按步骤呈现课堂练习和检查过程。 |
| image | `theme03_page063` | 实验室影像 | image | 图片：展示实验室、课堂或概念应用场景。 |
| closing | `theme03_page077` | 封底 | closing | 结尾：以封底收束知识回顾与行动提示。 |
