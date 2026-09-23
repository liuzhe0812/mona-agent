# 独立前向预设选择记录

这是一次独立的模型前向选择评估，不代表完整 Mona Agent 运行时、Token 消耗或生产质量结论；没有做渲染检查。候选集合来自 [catalog.json](../../mona/presets/catalog.json)，规则来自 [mona-pptx SKILL.md](../../../../mona/skills/mona-pptx/SKILL.md)。输入页原有的 `presetId` 只用于对照，选择时按内容对象、主题语境、容量和素材要求重新判断。

`agent-selection.json` 保留了原 15 页的全部文本、图表分类/系列/数值和图片路径。新增 3 页 held-out 内容均明确标注为演示或培训事实：一页测试较长中文标题，一页测试 2 节点流程，一页测试 4:1 宽幅图片；另有 3 页对最难的图表、图片案例和四节点流程重新独立选择。

| 页面 | 选择 | 候选与理由 |
| --- | --- | --- |
| report[0] | `light-metric` | `light-chart-insight` 需要图表，`light-comparison` 需要双项对比；本页是一个关键数值加两条证据，选指标聚焦页。 |
| report[1] | `light-chart-insight` | `dark-chart-insight` 也能容纳两系列三分类，但报告语境偏浅色；原生图表是页面主证据，保留图例、网格线和数据标签。 |
| report[2] | `light-comparison` | `dark-comparison` 结构可用但主题不合；两段多行方案事实正好对应左右比较面板。 |
| report[3] | `light-process-map` | `light-process-long` 支持 2–4 节点，但本页正好 3 节点且每个节点有一条交付物，横向流程更直接。 |
| report[4] | `light-overview` | `light-architecture` 也支持 4 节点，内容是四个并列关注项而非层级关系，因此选四项概览。 |
| product[0] | `dark-product-hero` | `dark-case` 要求 3 个节点；本页只有图片、标题、摘要和两条说明，深色主题的右图英雄页匹配。 |
| product[1] | `dark-metric` | `dark-comparison` 缺少一个明确的双对象对比；本页有单个 `4 步` 结论和两条证据，指标页更贴合。 |
| product[2] | `dark-architecture` | `dark-overview` 也可容纳 4 节点，四类能力连接成结构关系，层级图比并列清单更能表达语义。 |
| product[3] | `dark-chart-insight` | `dark-metric` 没有图表槽位；两分类原生柱图是唯一承载时间差异的主对象，深色产品语境一致。 |
| product[4] | `dark-case` | `dark-product-hero` 只能承载两条说明且没有节点槽；图片旁三组“主题/比例/项目”说明决定使用案例页。 |
| training[0] | `light-overview` | `light-architecture` 可放 4 节点，但四项是并列学习关注点，没有上下游层级，概览页更自然。 |
| training[1] | `light-process-long` | `light-process-map` 固定 3 节点；本页有 4 个步骤且每个步骤都有对应说明，长流程页是可用的 2–4 节点候选。 |
| training[2] | `light-case` | `light-product-hero` 没有节点/说明绑定；图片加 3 个对象/目标/材料对照，案例页保留所有槽位。 |
| training[3] | `light-comparison` | `dark-comparison` 的深色主题不合培训语境；两段任务描述和多行内容需要比较面板的宽文本槽。 |
| training[4] | `light-metric` | `light-comparison` 没有 takeaway 槽；本页的 `4 项` 结论加两条检查证据适合指标页。 |
| held-out[0] | `dark-chart-insight` | `light-chart-insight` 的标题上限为 22 字，本页 23 字会失败；深色图表页上限 52 字且仍保留 2 分类原生图表。 |
| held-out[1] | `light-process-long` | `light-process-map` 要求至少 3 节点；本页明确只有 2 个校验节点，长流程页的 2–4 节点范围可完整承载。 |
| held-out[2] | `light-product-hero` | `light-case` 要求 3 个节点，`dark-product-hero` 主题不合；本页只有图片和两条说明，英雄页的 `contain` 图片槽适合保留 4:1 宽幅素材。 |
| repeat-selection[0] | `light-chart-insight` | 重新只看图表事实：三分类、双系列和两条解释需要底部宽图表；浅色中性画面便于比较两组演示数值。 |
| repeat-selection[1] | `dark-case` | 重新只看对象绑定：同一图片旁有三组节点/说明，英雄页没有这些槽位，案例页是唯一完整结构。 |
| repeat-selection[2] | `light-process-long` | 重新只看序列关系：四个节点和四条说明形成连续步骤，固定三节点的流程页不适配。 |

容量与完整性检查结果：21 页中选定预设的容量/对象/数据维度失败为 0，未知预设 ID 为 0；原 15 页内容投影与输入逐页一致，未丢失文字、图表数据或图片路径。未发现 unsupported/manual-required 页面。包含 `assetPath` 的图片页依赖现有 harness 在展开前解析为图片数据；这属于输入准备前置条件，不是本次选择失败。
