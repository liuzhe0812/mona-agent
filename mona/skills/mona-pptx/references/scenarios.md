# PPT 用途场景

先按内容和受众选择用途。每个场景共享成熟通用页，并提供特色原生构图；浅色编辑式、深色产品式是基础视觉方向，用户品牌和观看距离优先。不是固定整稿顺序或必须套用的白名单。

每个场景另选了8个真实 Dashi 源页作为候选，共96条场景引用、81个唯一 ID，来自12个来源主题的可用子集；不是将 Dashi 的1020页全部迁入。使用 `inspect capabilities` 的 `presetScenario` 查看当前候选，再指定 `templateId` 读取准确的可填字段、例值和 `maxChars`。查看画面时用 `inspect` 的 `mode:"visual"`、同一 `templateId` 和 `templateFields`，预览在隔离副本中完成，不改现有文稿。实际使用 `slide_add_template` 时只填写能力回执中的字段名，并在空白16:9页创建。文字、形状和独立素材保留；复杂 SVG 以图片保留，不能当成有数据表的 PowerPoint 图表，也不要替换其数字文字；数据需编辑时用原生图表操作。若源页与事实或关系不匹配，改用现有通用原生构图。

| 场景 | 场景 ID | 用途与真实参考 |
|---|---|---|
| 企业汇报 | `business-report` | [汇报经营状况、关键指标、项目推进、差距和后续行动。](scenarios/business-report.md) |
| 产品展示 | `product-showcase` | [说明产品价值、核心能力、使用场景、效果证据和发布计划。](scenarios/product-showcase.md) |
| 技术方案 | `technical-proposal` | [呈现技术背景、系统分层、方案取舍、风险和实施路线。](scenarios/technical-proposal.md) |
| 经营数据 | `data-review` | [复盘指标走势、分部表现、关键驱动因素和经营动作。](scenarios/data-review.md) |
| 战略规划 | `strategy-planning` | [梳理战略背景、选择依据、风险情景、路线图和执行安排。](scenarios/strategy-planning.md) |
| 调研报告 | `research-report` | [呈现研究问题、方法、证据、比较分析、发现和建议。](scenarios/research-report.md) |
| 商业路演 | `business-pitch` | [讲清用户问题、商业模式、增长证据、团队能力和融资诉求。](scenarios/business-pitch.md) |
| 金融投研 | `investment-report` | [组织投资论点、市场数据、估值比较、风险情景和决策依据。](scenarios/investment-report.md) |
| 品牌提案 | `brand-proposal` | [呈现品牌主张、受众定位、创意概念、视觉方向和传播计划。](scenarios/brand-proposal.md) |
| 企业故事 | `company-story` | [讲述企业起点、关键里程碑、团队成长和客户实践。](scenarios/company-story.md) |
| 活动策划 | `event-planning` | [组织活动目标、议程、嘉宾阵容、现场执行、风险和效果指标。](scenarios/event-planning.md) |
| 教学培训 | `education-training` | [设计学习目标、知识结构、讲解示例、练习实验和学习检查。](scenarios/education-training.md) |

## 最小调用

```json
{"op":"slide_add_preset","payload":{"slideId":"<当前真实ID>","content":{"scenario":"education-training","role":"process","relation":"sequence","title":"练习：检查一个数据结论","summary":"先看证据，再判断，最后复核。","nodes":["观察","练习","检查"],"items":["确认原始数据和口径","独立说明一个判断","逐项检查证据与结论"],"takeaway":"保留推理过程"}}}
```

场景是选页提示，内容和真实关系决定能否使用某一页。默认自动选页没有合适候选时说明原因，保留事实并用现有原生构图；不把用户内容替换成样例。

各场景选定的 Dashi 页 ID、页面用途和说明见对应子页；具体字段始终以当前 `capabilities` 回执为准。
