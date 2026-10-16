# 原生预设与模板页索引

浅色编辑式和深色产品式是可复用的通用原生构图，可在场景不适配 Dashi 源页时作为回退；它们不是按场景复制的独立主题。当前选定12个场景、每场景8页，共96条引用、81个唯一 Dashi 页 ID，来自12个来源主题的可用子集，不代表1020个来源页全部迁入。各场景对应的源页 ID 与用途见[场景目录](scenarios.md)及其子页。

选择 Dashi 页时用 `inspect capabilities` 的 `presetScenario` 筛候选；为某个 ID 指定 `templateId` 后，能力回执提供实际可填字段、例值和 `maxChars`。用 `inspect` 的 `mode:"visual"`、该 `templateId` 和 `templateFields` 可在隔离副本中按需查看 Office 实际渲染。写入用 `slide_add_template`，字段名只取能力回执。当前 Office 预览不改原稿。下表列出原生通用构图的 ID；预览方式均为按需使用 Office visual，不再列静态 PNG 路径。

## 企业汇报（business-report）

主题：light-editorial。汇报经营状况、关键指标、项目推进、差距和后续行动。

| 页面 | 预设 ID | 关系 | 按需 Office 预览 |
|---|---|---|---|
| 年度或阶段汇报封面 | light-cover-split | none | `inspect visual` (`presetId`) |
| 经营背景与目标 | light-editorial-essay | none | `inspect visual` (`presetId`) |
| 关键指标总览 | light-metric-spotlight | none | `inspect visual` (`presetId`) |
| 指标变化趋势 | light-timeline | sequence | `inspect visual` (`presetId`) |
| 经营数据证据 | light-chart-evidence | none | `inspect visual` (`presetId`) |
| 目标与实际对照 | light-comparison-split | parallel | `inspect visual` (`presetId`) |
| 问题与行动计划 | light-process-steps | sequence | `inspect visual` (`presetId`) |
| 结论与请求 | light-closing-callout | none | `inspect visual` (`presetId`) |
| 经营概览网格 | light-overview | parallel | `inspect visual` (`presetId`) |
| 单项经营指标 | light-metric | none | `inspect visual` (`presetId`) |
| 经营图表洞察 | light-chart-insight | none | `inspect visual` (`presetId`) |
| 项目状态总览 | report-project-status | parallel | `inspect visual` (`presetId`) |

## 产品展示（product-showcase）

主题：dark-product。说明产品价值、核心能力、使用场景、效果证据和发布计划。

| 页面 | 预设 ID | 关系 | 按需 Office 预览 |
|---|---|---|---|
| 产品主视觉封面 | dark-cover-split | none | `inspect visual` (`presetId`) |
| 产品价值主张 | dark-editorial-essay | none | `inspect visual` (`presetId`) |
| 核心能力矩阵 | dark-parallel-grid | parallel | `inspect visual` (`presetId`) |
| 产品效果指标 | dark-metric-spotlight | none | `inspect visual` (`presetId`) |
| 产品组成与模块关系 | dark-hierarchy-branch | hierarchy | `inspect visual` (`presetId`) |
| 典型使用场景 | dark-gallery | parallel | `inspect visual` (`presetId`) |
| 方案或版本对照 | dark-comparison-split | parallel | `inspect visual` (`presetId`) |
| 发布与采用路径 | dark-process-steps | sequence | `inspect visual` (`presetId`) |
| 产品主张与主视觉 | dark-product-hero | none | `inspect visual` (`presetId`) |
| 产品指标侧栏 | dark-metric | none | `inspect visual` (`presetId`) |
| 产品案例与图片 | dark-case | parallel | `inspect visual` (`presetId`) |
| 功能与用户价值证据 | product-feature-proof | none | `inspect visual` (`presetId`) |

## 技术方案（technical-proposal）

主题：dark-product。呈现技术背景、系统分层、方案取舍、风险和实施路线。

| 页面 | 预设 ID | 关系 | 按需 Office 预览 |
|---|---|---|---|
| 技术方案封面 | dark-cover-split | none | `inspect visual` (`presetId`) |
| 现状与约束 | dark-editorial-essay | none | `inspect visual` (`presetId`) |
| 系统关系图 | dark-hierarchy-branch | hierarchy | `inspect visual` (`presetId`) |
| 数据流与处理步骤 | dark-process-steps | sequence | `inspect visual` (`presetId`) |
| 备选方案对比 | dark-comparison-split | parallel | `inspect visual` (`presetId`) |
| 技术风险矩阵 | dark-matrix-2x2 | matrix | `inspect visual` (`presetId`) |
| 性能与验证证据 | dark-chart-evidence | none | `inspect visual` (`presetId`) |
| 实施里程碑 | dark-timeline | sequence | `inspect visual` (`presetId`) |
| 系统架构层级 | dark-architecture | hierarchy | `inspect visual` (`presetId`) |
| 纵向实施流程 | dark-process-long | sequence | `inspect visual` (`presetId`) |
| 横向技术流程 | dark-process-map | sequence | `inspect visual` (`presetId`) |
| 技术分层堆栈 | technical-layer-stack | sequence | `inspect visual` (`presetId`) |

## 经营数据（data-review）

主题：light-editorial。复盘指标走势、分部表现、关键驱动因素和经营动作。

| 页面 | 预设 ID | 关系 | 按需 Office 预览 |
|---|---|---|---|
| 经营复盘封面 | light-cover-split | none | `inspect visual` (`presetId`) |
| 核心指标记分板 | light-metric-spotlight | none | `inspect visual` (`presetId`) |
| 指标趋势 | light-timeline | sequence | `inspect visual` (`presetId`) |
| 图表证据与结论 | light-chart-evidence | none | `inspect visual` (`presetId`) |
| 区域或产品表现 | light-parallel-grid | parallel | `inspect visual` (`presetId`) |
| 目标与实际差异 | light-comparison-split | parallel | `inspect visual` (`presetId`) |
| 复盘后的经营动作 | light-process-steps | sequence | `inspect visual` (`presetId`) |
| 结论摘要 | light-closing-callout | none | `inspect visual` (`presetId`) |
| 经营驱动因素拆解 | data-driver-review | none | `inspect visual` (`presetId`) |

## 战略规划（strategy-planning）

主题：dark-product。梳理战略背景、选择依据、风险情景、路线图和执行安排。

| 页面 | 预设 ID | 关系 | 按需 Office 预览 |
|---|---|---|---|
| 战略规划封面 | dark-cover-split | none | `inspect visual` (`presetId`) |
| 战略背景与目标 | dark-editorial-essay | none | `inspect visual` (`presetId`) |
| 目标与关键结果 | dark-metric-spotlight | none | `inspect visual` (`presetId`) |
| 业务组合与相互关系 | dark-hierarchy-branch | hierarchy | `inspect visual` (`presetId`) |
| 机会与风险情景 | dark-matrix-2x2 | matrix | `inspect visual` (`presetId`) |
| 战略路线图 | dark-timeline | sequence | `inspect visual` (`presetId`) |
| 执行步骤 | dark-process-steps | sequence | `inspect visual` (`presetId`) |
| 战略指标与证据 | dark-chart-evidence | none | `inspect visual` (`presetId`) |
| 战略图表洞察 | dark-chart-insight | none | `inspect visual` (`presetId`) |
| 战略方案比较 | dark-comparison | parallel | `inspect visual` (`presetId`) |
| 战略议题概览 | dark-overview | parallel | `inspect visual` (`presetId`) |
| 战略选项决策矩阵 | strategy-decision-options | parallel | `inspect visual` (`presetId`) |

## 调研报告（research-report）

主题：light-editorial。呈现研究问题、方法、证据、比较分析、发现和建议。

| 页面 | 预设 ID | 关系 | 按需 Office 预览 |
|---|---|---|---|
| 调研报告封面 | light-cover-split | none | `inspect visual` (`presetId`) |
| 研究问题与范围 | light-editorial-essay | none | `inspect visual` (`presetId`) |
| 调研框架 | light-parallel-columns | parallel | `inspect visual` (`presetId`) |
| 研究流程 | light-process-steps | sequence | `inspect visual` (`presetId`) |
| 证据图表 | light-chart-evidence | none | `inspect visual` (`presetId`) |
| 对象或样本比较 | light-comparison-split | parallel | `inspect visual` (`presetId`) |
| 案例材料 | light-gallery | parallel | `inspect visual` (`presetId`) |
| 研究建议 | light-closing-callout | none | `inspect visual` (`presetId`) |
| 研究对象对比 | light-comparison | parallel | `inspect visual` (`presetId`) |
| 研究执行流程 | light-process-map | sequence | `inspect visual` (`presetId`) |
| 研究框架层级 | light-architecture | hierarchy | `inspect visual` (`presetId`) |
| 方法与发现证据链 | research-method-findings | parallel | `inspect visual` (`presetId`) |

## 商业路演（business-pitch）

主题：light-editorial。讲清用户问题、商业模式、增长证据、团队能力和融资诉求。

| 页面 | 预设 ID | 关系 | 按需 Office 预览 |
|---|---|---|---|
| 路演封面 | light-cover-split | none | `inspect visual` (`presetId`) |
| 用户问题与主张 | light-transition-statement | none | `inspect visual` (`presetId`) |
| 市场背景 | light-editorial-essay | none | `inspect visual` (`presetId`) |
| 商业模式 | light-hierarchy-branch | hierarchy | `inspect visual` (`presetId`) |
| 增长与验证指标 | light-metric-spotlight | none | `inspect visual` (`presetId`) |
| 市场与增长证据 | light-chart-evidence | none | `inspect visual` (`presetId`) |
| 竞争格局 | light-comparison-split | parallel | `inspect visual` (`presetId`) |
| 核心团队 | light-team-grid | hierarchy | `inspect visual` (`presetId`) |
| 融资计划与资金用途 | light-closing-callout | none | `inspect visual` (`presetId`) |
| 商业主张封面 | light-product-hero | none | `inspect visual` (`presetId`) |
| 商业案例图片页 | light-case | parallel | `inspect visual` (`presetId`) |
| 商业模式与收入闭环 | pitch-business-model | parallel | `inspect visual` (`presetId`) |

## 金融投研（investment-report）

主题：dark-product。组织投资论点、市场数据、估值比较、风险情景和决策依据。

| 页面 | 预设 ID | 关系 | 按需 Office 预览 |
|---|---|---|---|
| 投研封面 | dark-cover-split | none | `inspect visual` (`presetId`) |
| 投资论点 | dark-editorial-essay | none | `inspect visual` (`presetId`) |
| 核心财务指标 | dark-metric-spotlight | none | `inspect visual` (`presetId`) |
| 估值与市场证据 | dark-chart-evidence | none | `inspect visual` (`presetId`) |
| 业绩与市场走势 | dark-timeline | sequence | `inspect visual` (`presetId`) |
| 可比公司与估值对照 | dark-comparison-split | parallel | `inspect visual` (`presetId`) |
| 风险分类矩阵 | dark-matrix-2x2 | matrix | `inspect visual` (`presetId`) |
| 组合配置 | dark-parallel-grid | parallel | `inspect visual` (`presetId`) |
| 投资结论 | dark-closing-callout | none | `inspect visual` (`presetId`) |
| 投资论点横向比较 | dark-parallel-columns | parallel | `inspect visual` (`presetId`) |
| 风险与情景分析 | investment-risk-scenarios | parallel | `inspect visual` (`presetId`) |

## 品牌提案（brand-proposal）

主题：light-editorial。呈现品牌主张、受众定位、创意概念、视觉方向和传播计划。

| 页面 | 预设 ID | 关系 | 按需 Office 预览 |
|---|---|---|---|
| 品牌提案封面 | light-cover-split | none | `inspect visual` (`presetId`) |
| 品牌主张 | light-transition-statement | none | `inspect visual` (`presetId`) |
| 受众与市场背景 | light-editorial-essay | none | `inspect visual` (`presetId`) |
| 品牌价值结构 | light-hierarchy-branch | hierarchy | `inspect visual` (`presetId`) |
| 视觉方向与情绪板 | light-gallery | parallel | `inspect visual` (`presetId`) |
| 品牌定位比较 | light-comparison-split | parallel | `inspect visual` (`presetId`) |
| 传播与发布节奏 | light-timeline | sequence | `inspect visual` (`presetId`) |
| 创意与执行团队 | light-team-grid | hierarchy | `inspect visual` (`presetId`) |
| 品牌概念与创意论证 | brand-concept-proposal | none | `inspect visual` (`presetId`) |

## 企业故事（company-story）

主题：dark-product。讲述企业起点、关键里程碑、团队成长和客户实践。

| 页面 | 预设 ID | 关系 | 按需 Office 预览 |
|---|---|---|---|
| 企业故事封面 | dark-cover-split | none | `inspect visual` (`presetId`) |
| 使命与初心 | dark-transition-statement | none | `inspect visual` (`presetId`) |
| 企业起点与背景 | dark-editorial-essay | none | `inspect visual` (`presetId`) |
| 发展历程时间线 | dark-timeline | sequence | `inspect visual` (`presetId`) |
| 团队与组织 | dark-team-grid | hierarchy | `inspect visual` (`presetId`) |
| 客户与实践故事 | dark-gallery | parallel | `inspect visual` (`presetId`) |
| 成长数据 | dark-metric-spotlight | none | `inspect visual` (`presetId`) |
| 企业价值与能力 | dark-hierarchy-branch | hierarchy | `inspect visual` (`presetId`) |
| 未来愿景 | dark-closing-callout | none | `inspect visual` (`presetId`) |
| 企业发展里程碑 | story-milestones | sequence | `inspect visual` (`presetId`) |

## 活动策划（event-planning）

主题：dark-product。组织活动目标、议程、嘉宾阵容、现场执行、风险和效果指标。

| 页面 | 预设 ID | 关系 | 按需 Office 预览 |
|---|---|---|---|
| 活动主视觉封面 | dark-cover-split | none | `inspect visual` (`presetId`) |
| 活动主张与目标 | dark-transition-statement | none | `inspect visual` (`presetId`) |
| 活动内容板块 | dark-parallel-grid | parallel | `inspect visual` (`presetId`) |
| 活动议程 | dark-timeline | sequence | `inspect visual` (`presetId`) |
| 嘉宾与演出阵容 | dark-team-grid | hierarchy | `inspect visual` (`presetId`) |
| 现场体验与场景 | dark-gallery | parallel | `inspect visual` (`presetId`) |
| 观众体验流程 | dark-process-steps | sequence | `inspect visual` (`presetId`) |
| 现场风险预案 | dark-matrix-2x2 | matrix | `inspect visual` (`presetId`) |
| 触达与活动效果 | dark-metric-spotlight | none | `inspect visual` (`presetId`) |
| 现场执行流程表 | event-run-of-show | sequence | `inspect visual` (`presetId`) |

## 教学培训（education-training）

主题：light-editorial。设计学习目标、知识结构、讲解示例、练习实验和学习检查。

| 页面 | 预设 ID | 关系 | 按需 Office 预览 |
|---|---|---|---|
| 课程或培训封面 | light-cover-split | none | `inspect visual` (`presetId`) |
| 学习目标 | light-transition-statement | none | `inspect visual` (`presetId`) |
| 课程结构 | light-parallel-grid | parallel | `inspect visual` (`presetId`) |
| 核心概念关系图 | light-hierarchy-branch | hierarchy | `inspect visual` (`presetId`) |
| 讲解示例 | light-gallery | parallel | `inspect visual` (`presetId`) |
| 实验对照 | light-comparison-split | parallel | `inspect visual` (`presetId`) |
| 课堂讲解流程 | light-process-steps | sequence | `inspect visual` (`presetId`) |
| 学习检查点 | light-metric-spotlight | none | `inspect visual` (`presetId`) |
| 知识回顾 | light-closing-callout | none | `inspect visual` (`presetId`) |
| 长流程教学步骤 | light-process-long | sequence | `inspect visual` (`presetId`) |
| 知识掌握四象限 | light-matrix-2x2 | matrix | `inspect visual` (`presetId`) |
| 课堂练习与反馈 | education-practice | sequence | `inspect visual` (`presetId`) |

## 全部预设资源与兼容 ID

| 分组 | 预设 ID | 家族 | 主题 | 关系 | 角色 | 按需 Office 预览 |
|---|---|---|---|---|---|---|
| catalog | dark-chart-insight | chart-insight | dark-product | none | metrics、trend、distribution、comparison、observation | `inspect visual` (`presetId`) |
| catalog | dark-product-hero | claim-image | dark-product | none | cover、statement、image | `inspect visual` (`presetId`) |
| catalog | light-chart-insight | chart-insight | light-editorial | none | metrics、trend、distribution、comparison、observation | `inspect visual` (`presetId`) |
| catalog | light-comparison | comparison | light-editorial | parallel | comparison、context、observation | `inspect visual` (`presetId`) |
| catalog | light-process-map | process-map | light-editorial | sequence | process、actions、breakdown | `inspect visual` (`presetId`) |
| catalog | light-product-hero | claim-image | light-editorial | none | cover、statement、image | `inspect visual` (`presetId`) |
| catalog | dark-metric | spotlight | dark-product | none | metrics、result、statement | `inspect visual` (`presetId`) |
| catalog | dark-comparison | comparison | dark-product | parallel | comparison、context、observation | `inspect visual` (`presetId`) |
| catalog | dark-process-map | process-map | dark-product | sequence | process、actions、breakdown | `inspect visual` (`presetId`) |
| catalog | dark-architecture | hierarchy | dark-product | hierarchy | relationship、context、breakdown | `inspect visual` (`presetId`) |
| catalog | dark-case | case | dark-product | parallel | case、image、observation | `inspect visual` (`presetId`) |
| catalog | dark-overview | overview | dark-product | parallel | breakdown、context、observation | `inspect visual` (`presetId`) |
| catalog | dark-process-long | process-map | dark-product | sequence | process、actions、breakdown | `inspect visual` (`presetId`) |
| catalog | light-metric | spotlight | light-editorial | none | metrics、result、statement | `inspect visual` (`presetId`) |
| catalog | light-architecture | hierarchy | light-editorial | hierarchy | relationship、context、breakdown | `inspect visual` (`presetId`) |
| catalog | light-case | case | light-editorial | parallel | case、image、observation | `inspect visual` (`presetId`) |
| catalog | light-overview | overview | light-editorial | parallel | breakdown、context、observation | `inspect visual` (`presetId`) |
| catalog | light-process-long | process-map | light-editorial | sequence | process、actions、breakdown | `inspect visual` (`presetId`) |
| extended | dark-cover-split | cover | dark-product | none | cover、statement、image | `inspect visual` (`presetId`) |
| extended | light-cover-split | cover | light-editorial | none | cover、statement、image | `inspect visual` (`presetId`) |
| extended | dark-transition-statement | editorial | dark-product | none | transition、statement、ambient | `inspect visual` (`presetId`) |
| extended | light-transition-statement | editorial | light-editorial | none | transition、statement、ambient | `inspect visual` (`presetId`) |
| extended | dark-closing-callout | closing | dark-product | none | closing、result、actions | `inspect visual` (`presetId`) |
| extended | light-closing-callout | closing | light-editorial | none | closing、result、actions | `inspect visual` (`presetId`) |
| extended | dark-editorial-essay | editorial | dark-product | none | statement、context、observation | `inspect visual` (`presetId`) |
| extended | light-editorial-essay | editorial | light-editorial | none | statement、context、observation | `inspect visual` (`presetId`) |
| extended | dark-team-grid | team | dark-product | hierarchy | team、relationship、context | `inspect visual` (`presetId`) |
| extended | light-team-grid | team | light-editorial | hierarchy | team、relationship、context | `inspect visual` (`presetId`) |
| extended | dark-parallel-columns | parallel | dark-product | parallel | breakdown、comparison、context | `inspect visual` (`presetId`) |
| extended | light-parallel-columns | parallel | light-editorial | parallel | breakdown、comparison、context | `inspect visual` (`presetId`) |
| extended | dark-parallel-grid | parallel | dark-product | parallel | breakdown、comparison、distribution | `inspect visual` (`presetId`) |
| extended | light-parallel-grid | parallel | light-editorial | parallel | breakdown、comparison、distribution | `inspect visual` (`presetId`) |
| extended | dark-timeline | timeline | dark-product | sequence | trend、process、actions | `inspect visual` (`presetId`) |
| extended | light-timeline | timeline | light-editorial | sequence | trend、process、actions | `inspect visual` (`presetId`) |
| extended | dark-matrix-2x2 | matrix | dark-product | matrix | comparison、distribution、risks | `inspect visual` (`presetId`) |
| extended | light-matrix-2x2 | matrix | light-editorial | matrix | comparison、distribution、risks | `inspect visual` (`presetId`) |
| extended | dark-gallery | gallery | dark-product | parallel | image、case、ambient | `inspect visual` (`presetId`) |
| extended | light-gallery | gallery | light-editorial | parallel | image、case、ambient | `inspect visual` (`presetId`) |
| extended | dark-comparison-split | comparison | dark-product | parallel | comparison、context、result | `inspect visual` (`presetId`) |
| extended | light-comparison-split | comparison | light-editorial | parallel | comparison、context、result | `inspect visual` (`presetId`) |
| extended | dark-metric-spotlight | metric | dark-product | none | metrics、result、statement | `inspect visual` (`presetId`) |
| extended | light-metric-spotlight | metric | light-editorial | none | metrics、result、statement | `inspect visual` (`presetId`) |
| extended | dark-process-steps | process-map | dark-product | sequence | process、actions、breakdown | `inspect visual` (`presetId`) |
| extended | light-process-steps | process-map | light-editorial | sequence | process、actions、breakdown | `inspect visual` (`presetId`) |
| extended | dark-hierarchy-branch | hierarchy | dark-product | hierarchy | relationship、team、breakdown | `inspect visual` (`presetId`) |
| extended | light-hierarchy-branch | hierarchy | light-editorial | hierarchy | relationship、team、breakdown | `inspect visual` (`presetId`) |
| extended | dark-chart-evidence | chart-insight | dark-product | none | observation、metrics、result | `inspect visual` (`presetId`) |
| extended | light-chart-evidence | chart-insight | light-editorial | none | observation、metrics、result | `inspect visual` (`presetId`) |
| scenario-pages | report-project-status | overview | light-editorial | parallel | metrics、observation、actions | `inspect visual` (`presetId`) |
| scenario-pages | product-feature-proof | case | dark-product | none | case、image、result | `inspect visual` (`presetId`) |
| scenario-pages | technical-layer-stack | hierarchy | dark-product | sequence | relationship、process、team | `inspect visual` (`presetId`) |
| scenario-pages | data-driver-review | chart-insight | light-editorial | none | metrics、observation、result | `inspect visual` (`presetId`) |
| scenario-pages | strategy-decision-options | comparison | dark-product | parallel | comparison、actions、risks | `inspect visual` (`presetId`) |
| scenario-pages | research-method-findings | comparison | light-editorial | parallel | context、observation、result | `inspect visual` (`presetId`) |
| scenario-pages | pitch-business-model | comparison | light-editorial | parallel | comparison、context、result | `inspect visual` (`presetId`) |
| scenario-pages | investment-risk-scenarios | comparison | dark-product | parallel | risks、comparison、observation | `inspect visual` (`presetId`) |
| scenario-pages | brand-concept-proposal | editorial | light-editorial | none | statement、image、ambient | `inspect visual` (`presetId`) |
| scenario-pages | story-milestones | process-map | dark-product | sequence | trend、process、result | `inspect visual` (`presetId`) |
| scenario-pages | event-run-of-show | process-map | dark-product | sequence | process、actions、breakdown | `inspect visual` (`presetId`) |
| scenario-pages | education-practice | process-map | light-editorial | sequence | process、actions、result | `inspect visual` (`presetId`) |
