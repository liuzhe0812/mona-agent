# 调研报告

呈现研究问题、方法、证据、比较分析、发现和建议。

创建时在 `slide_add_preset.content` 填 `scenario: "research-report"`。后续成功写入的预设页继承场景；不修改已完成页面。当前能力目录可用 `presetScenario: "research-report"` 查询容量和可用对象。

## 与自由原生构图混排

使用 `slide_add_design` 时可沿用以下 `palette`；品牌颜色与真实内容优先。

```json
{"background": "#F5F3ED", "ink": "#20242B", "muted": "#5A6270", "accent": "#8FD400", "surface": "#FFFFFF", "line": "#D8D2C4"}
```

## 页面表达

| 页面用途 | 通用原生回退 | 内容关系 |
|---|---|---|
| 调研报告封面 | `light-cover-split` | `none` |
| 研究问题与范围 | `light-editorial-essay` | `none` |
| 调研框架 | `light-parallel-columns` | `parallel` |
| 研究流程 | `light-process-steps` | `sequence` |
| 证据图表 | `light-chart-evidence` | `none` |
| 对象或样本比较 | `light-comparison-split` | `parallel` |
| 案例材料 | `light-gallery` | `parallel` |
| 研究建议 | `light-closing-callout` | `none` |
| 研究对象对比 | `light-comparison` | `parallel` |
| 研究执行流程 | `light-process-map` | `sequence` |
| 研究框架层级 | `light-architecture` | `hierarchy` |
| 方法与发现证据链 | `research-method-findings` | `parallel` |

正文写用户提供的实际内容；所有图片路径必须指向已取得的真实素材。数组、数字、单位、来源和关系遵守当前预设容量；不适配时组合原生对象，不删事实或缩小整页。


## 选定的 Dashi 源页

以下8页是本场景从 Dashi 真实来源模板中选出的候选；不代表全部来源页已迁入。先用 `inspect capabilities` 的 `presetScenario` 查询，再指定某个 `templateId` 查看真实文本字段与字数限制。需要看画面时，用 `inspect` 的 `mode:"visual"`、`templateId` 和能力回执中的字段进行隔离预览；写入前仍应确认字段名、证据与布局。

| 用途 | Dashi 页 ID | 来源页名 | 页面角色 | 选择理由 |
|---|---|---|---|---|
| cover | `theme07_page002` | 封面 链通全国 | cover、relationship、image | 封面：以视觉主题与研究标题开篇。 |
| body | `theme07_page010` | 热力 Heatmap | data、report、distribution、relationship | 正文：用热力矩阵呈现样本、类别或研究分层。 |
| metrics | `theme07_page011` | 排名 Ranking | data、distribution | 指标：用排名表给出样本或研究对象的可比结果。 |
| chart | `theme07_page021` | 季度 Q4 回落 | trend | 图表：展示周期趋势并保留数据说明字段。 |
| comparison | `theme07_page054` | 集群 区域对比 | comparison、image | 对比：比较不同地区或集群的研究发现。 |
| relationship | `theme07_page017` | 气泡 Deal Map | data、relationship | 关系：用气泡分布表达对象间的相对位置。 |
| case-image | `theme07_page056` | 案例 OpenAI | case、image | 图片案例：展示研究对象、案例或访谈场景。 |
| closing | `theme07_page067` | 结语 Closing | result、closing | 结尾：用结语收束发现和建议。 |
