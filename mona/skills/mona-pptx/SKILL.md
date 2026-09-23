---
name: mona-pptx
description: >
  制作、修改、美化 PPT、演示文稿、幻灯片、汇报材料时使用。通过 Mona Office
  实时编辑器生成原生可编辑的 PPTX。Use for creating, editing or designing
  presentations, slides, PowerPoint files and reports. 不用于只需要图片原型的任务。
---

# Mona PPTX

用 `office` 实时制作原生可编辑 PPT。附带图片只是设计完成度的参照，不是待复刻的答案，也不是版式清单。根据用户内容、受众和展示场景提出自己的表达；学习参考中的主次、比例和细节，不照搬其布局、装饰或配色。你负责叙事和视觉判断，组件减少机械排版；不需要审批、冻结主题或额外 design brief。

## 设计判断

围绕用户目的、受众、资料和页数组织整稿。每页明确主信息与证据，用构图表现信息权重：主图表、大数字、对照、时间线、关系图、案例大图或编辑式文字均可。统一字体层级、配色、对齐与图片处理，变化来自内容，不为求变化硬换版式；比较同类信息时可以重复构图。

高设计感来自清楚的焦点、恰当的比例和有意义的留白，不是给每段文字套圆角卡片。信息密集时调整分组和布局，不靠持续缩字。标题结论需有证据；数字、单位、基期和来源保留，真实关系不能为套模板改写。用户素材优先，只有实际取得的图片才填写素材路径，不用生成图冒充产品截图或数据证据。

## 实时制作

已有 PPT 的改色、改字、字体和布局调整直接在当前会话修改，不关闭、不重建。`open(session_id)` 恢复原会话；无活动文稿时 `open(document_type="slides")` 新建，已有活动文稿时仍复用它，只有用户明确要另一份新稿才用 `new_document:true`。用回执的真实 ID 与最新 version 执行 apply。

品牌改色先 `inspect` 的 `query:{mode:"palette"}` 读取实际颜色与对象，再 `slide_replace_colors`，如 `payload:{replacements:[{from:"#实际旧色",to:"#实际橙色"}]}`；可用 slideIds/elementIds/excludeElementIds 限定范围。只改品牌强调色，保留正负值、警告、正文对比度与人工特殊配色；不重放原设计内容。`palette` 是创建参数，不是已有文稿自动换肤开关。详见 [原位续编](references/in-place-editing.md)。

内容适合时，用 `slide_add_design` 复用已打磨的表达：`statement` 大观点、`metric` 主指标、`evidence` 图表解读、`waterfall` 变化瀑布、`sankey` 流向、`agenda` 信息地图、`comparison` 对照、`roadmap` 路线、`matrix` 象限、`image` 主图、`items` 编辑式列表。它不是填空模板：可改 palette、focusIndex，或指定 region 组合局部区域。详细字段与参考图见 [原生设计组件](references/components.md)。简单调用形式是 `{op:"slide_add_design",payload:{slideId:"真实ID",design:"metric",content:{title:"有证据的判断",metric:{label:"指标名",value:实际值,unit:"单位",detail:"解释"},items:[{label:"辅助指标",value:实际值,unit:"单位"}],source:"真实来源"}}}`。

组件只是起点：即使能够套入，也可以为更好的叙事自由组合、修改或原生定制；不要把所有任务都压成经营汇报，不为使用组件改变内容。不重复试字段。`slide_compose` 提供网格，原生文字支持 paragraphs/runs、局部强调、基线和内边距；`slide_add_path` 可创建独立曲线形状。标准图表保留数据模型；瀑布/桑基等组件是可编辑形状与文本，不能声称具有 PowerPoint 原生图表数据表。

按页或完整区域推进，保留已完成内容，不等所有素材、所有页面都准备好才开始。预设不适配时根据具体原因换表达，或直接原生定制；不为通过匹配删事实、反复试字段或把整稿退化为通用双栏。明确的总页数约束仍需遵守。

用 `inspect` 的 `query:{mode:"visual",slideIds:[真实ID...],columns:2}` 看整稿节奏（每批最多12页）；总览不替代单页可读性验收。用 `query:{mode:"visual",slideId:"真实ID"}` 看真实整页，判断主次、裁切、图表与解释，而不仅是对象有没有写入。`inspect review` 定位待检查页，修正后只复查受影响内容。有意叠字需看图说明；溢出/重叠要实际修复，不能靠截图成功证明设计合格。

完成后保存并正常导出原生 PPTX。Agent 不能用 allow_unreviewed 自行跳过 PPT 验收；未完成时 save 保留进度，用户仍可从编辑器直接导出草稿。版本冲突先读受影响页，断线恢复同一会话，不重建覆盖用户改动。交付说明必须与实际成品和审核状态一致。

## 按需资源

- [原生设计组件](references/components.md)：成熟构图、真实预览和内容字段，读取时直接获得图像。
- [视觉语言与构图](references/visual-recipes.md)：两类设计方向、层级和页面表达；不是风格限制。
- [完整原生设计示例](references/native-design-examples.md)：可组合、可调整的原生构图与真实预览。
- [预设预览索引](references/preset-index.md)：需要参考现成页面时选读；用 `skill_asset_copy` 复制后通过 `read_file` 实际看图。
- [Office 操作](references/office-operations.md)：打开、构建、检查和导出。`capabilities` 默认给短目录；指定实际 operations 获取参数。未知名称看 unsupportedOperations 和 availableOperations，剩余参数见 nextOperations；查询失败不代表文稿不能修改。
- [内容设计](references/design-method.md)、[高级对象](references/advanced-operations.md)、[审核与恢复](references/visual-review.md)：按问题选读，不必全部加载。
