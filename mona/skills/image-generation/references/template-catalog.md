# 生图模板路由索引

本文件是 22 个类别的补充路由。开放式创作先读 [案例索引](case-index.md)，匹配实际案例的构图机制；案例未覆盖任务或需要更多类别约束时，再选择这里的主模板并读取对应分组。不要只读类别摘要就结束设计。

模板内容来自 awesome-gpt-image-2 的 style-library 与模板文档，已用中文重新归纳；不复制案例提示词或图片。用户给出的主题、标题、品牌、比例、参考图和身份/产品约束优先级最高。

## 分组文件

| 按需读取文件 | 条目 | 适用路由 |
|---|---:|---|
| [templates-interface-information.md](templates-interface-information.md) | 1–3 | 界面、信息图、科学尺度 |
| [templates-poster-campaign.md](templates-poster-campaign.md) | 4–8 | 海报、运动 Campaign、字体、水墨、自然科普 |
| [templates-product-brand.md](templates-product-brand.md) | 9–12 | 商品、美妆、品牌身份、品牌触点 |
| [templates-space-photography.md](templates-space-photography.md) | 13–15 | 建筑、空间、写实摄影、街头抓拍 |
| [templates-illustration-character-story.md](templates-illustration-character-story.md) | 16–19 | 插画、角色、公仔、故事场景 |
| [templates-history-publishing-concept.md](templates-history-publishing-concept.md) | 20–22 | 历史、出版、概念产品研发 |

## 22 个模板检索关键词

| # / ID | 名称 / 关键词 |
|---|---|
| 1 / ui-screenshot-system | UI 截图：App、网页、仪表盘、社媒、直播 |
| 2 / infographic-engine | 信息图：流程、关系、时间线、技术图解 |
| 3 / scientific-scale-diagram | 科学尺度：微观、宏观、倍率、剖面 |
| 4 / poster-layout-system | 海报排版：活动、电影、产品、封面 |
| 5 / sports-campaign-poster | 运动 Campaign：运动员、球鞋、健身、广告 |
| 6 / conceptual-typography-poster | 概念字体：标题主视觉、字形、视觉隐喻 |
| 7 / ink-double-exposure-poster | 水墨双曝：人像、剪影、文化、诗意 |
| 8 / nature-science-poster | 自然科普：动物、物种、白底、知识点 |
| 9 / product-commerce-visual | 商品视觉：电商、包装、卖点、主图 |
| 10 / personalized-beauty-report | 美妆报告：自拍、肤色、口红、试色 |
| 11 / brand-identity-package | 品牌身份：Logo、VI、配色、字体、样机 |
| 12 / brand-touchpoint-board | 品牌触点：包装、名片、菜单、系统板 |
| 13 / architecture-space | 建筑空间：室内、效果图、地图、规划 |
| 14 / realistic-photography | 写实摄影：人像、街拍、商品、镜头 |
| 15 / street-accident-moment | 街头瞬间：抓拍、泼洒、掉落、手机纪实 |
| 16 / illustration-art-style | 插画艺术：动漫、水彩、水墨、厚涂 |
| 17 / character-design-sheet | 角色设定：动作表、网格、一致性 |
| 18 / 3d-collectible-toy | 3D 公仔：潮玩、收藏、vinyl、树脂 |
| 19 / scene-storytelling | 场景叙事：故事、分镜、世界观、冲突 |
| 20 / history-classical-themes | 历史古风：朝代、长卷、诗词、器物 |
| 21 / document-publishing | 文档出版：白皮书、手册、杂志、画册 |
| 22 / concept-product-breakdown | 概念研发：工业设计、爆炸图、迭代、材料 |

## 路由与组合规则

1. 按图片本身的职责选择模板；PPT 是用途，不是固定视觉风格。无字背景不自动套海报标题，城市题材不自动套人物双重曝光。
2. 读取分组文件后只取所需条目的六类字段和提示词片段；次模板最多借用一到两个兼容规则，保持主模板的输出结构不变。
3. 遵循用户要求的输出形式；只有用户需要单张场景或海报时才排除无关展示板。用户要品牌板、分镜或研发板时，保留其结构。准确文字应先确定字符串与位置。

## 字段约定

每个条目固定提供：适用场景、视觉结构 / 构图、风格 / 材质、文字与标签策略、关键约束 / 常见失败、可组合提示词片段。片段用于补齐具体 prompt，不应脱离用户需求原样套用。条目中的默认画幅、模块数量、色数、背景和文案区均为参考方案；与用户或当前文档视觉系统冲突时按任务调整。保留关系而不机械保留数字。
