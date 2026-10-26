---
name: mona-pptx
description: >
  制作、修改、美化 PPT、演示文稿、幻灯片、汇报材料时使用。以 Mona Design
  的视觉设计资料指导 Mona Office 实时编辑器，生成原生可编辑 PPTX。Use for creating, editing or designing
  presentations, slides, PowerPoint files and reports. 不用于只需要图片原型的任务。
---

# Mona PPTX

设计使用共享 `mona-design` 资源，制作和编辑只使用当前 `office` 会话。用户看到的是持续更新的原生可编辑 PPT，不另建 HTML 文稿、PDF 中转或第二套导出流程。

## 设计入口

新稿和涉及风格、配色、字体或构图判断的修改，先用 `skill_reference_read(skill="mona-design", ref_path="native-pptx.md")` 读取 Mona 原生 PPT 适配，再按该入口读取与内容相关的样张和设计资料。共享资源是唯一设计指导；不要执行设计资源包原始的 HTML 制作流程，也不添加强制三方向选择、代表页批准或冻结主题的步骤。普通改字、改数和用户已给出明确样式值的修改，只读取当前对象所需的操作资料，不重新启动设计。

本 Skill 只说明 Office 操作和验收契约，不提供模板、组件搭配、配色、字体或构图建议。样张效果需落实为真实可支持的对象，不把 CSS 效果当成已实现的原生效果。只有实际取得的素材才能填写路径。

## 用户资料中的图片

根据带图文档制作时，主动检查与内容相关的原图并按 Mona Design 的素材原则复用；不只提文字，也不把所有图片机械搬进 PPT。按需读取 [原图提取与复用](references/source-images.md)：通过本 Skill 的 `extract_source_images.py` 导出 DOCX/PPTX 内嵌图片、PDF 位图或完整图区域，再看实际图片并用返回的 `assetPath` 插入。保留来源与图文对应，不能把未取得的图片、页面截图或图片图表冒称为原图或原生数据图表。

## 实时制作

已有 PPT 的改色、改字、字体和布局调整直接在当前会话修改，不关闭、不重建。`open(session_id)` 恢复原会话；无活动文稿时 `open(document_type="slides")` 新建，已有活动文稿时仍复用它，只有用户明确要另一份新稿才用 `new_document:true`。用回执的真实 ID 与最新 version 执行 apply。

`open` 回执已含 `selection.slideId` 和 `version` 时，直接把它们用于第一批 `apply`，无需重复 inspect。`expected_version` 使用最近一次结果的完整 `version`；`operations` 中每项为 `{op, payload}`，操作参数都放在 `payload`。只有当前操作参数未知时，才用 `inspect capabilities` 指定该操作；不默认读取完整能力目录或全部操作参考。紧凑起步骨架和新增页示例见 [Office 操作](references/office-operations.md)。

按任务读取 `selection`、`slides`、`search` 或 `outline`。回执已覆盖目标时不换入口重复读取；明确 `partial` 时只补读缺失页面或元素，范围不重叠。用户要求保留全部资料时建立“事实/步骤/数据项 → 页面对象”的覆盖清单。公开操作数组最多50项；字段未知时用 `inspect capabilities` 并指定 `operations: ["具体操作名"]`，不靠失败猜字段。

品牌改色先 `inspect` 的 `query:{mode:"palette"}` 读取实际颜色与对象，再 `slide_replace_colors`，如 `payload:{replacements:[{from:"#实际旧色",to:"#实际橙色"}]}`；可用 slideIds/elementIds/excludeElementIds 限定范围。只改品牌强调色，保留正负值、警告、正文对比度与人工特殊配色；不重放原设计内容。`palette` 是创建参数，不是已有文稿自动换肤开关。详见 [原位续编](references/in-place-editing.md)。

使用原生文字、形状、路径、图片、数据图表或 `slide_compose` 完成 Mona Design 设计；具体操作参数按需查询能力回执，不从旧模板或预设目录选择视觉方案。

原生文字支持 paragraphs/runs、局部强调、基线和内边距；`slide_add_path` 可创建独立曲线。需要可编辑分类与数值时用原生图表，瀑布/桑基组件不能声称具有 PowerPoint 标准图表数据表。原生表格/图表用于数据或编辑需求，不要求把任意表格都改成原生对象。

按页或完整区域推进，保留已完成内容，不等所有素材、所有页面都准备好才开始。内容数量和总页数遵守用户要求，不因工具参数限制删改事实。

设计质量按共享 Mona Design 评审资料结合用户要求判断，Office 验收负责当前文稿的实际结果。用 `inspect` 的 `query:{mode:"visual",slideIds:[真实ID...],columns:2}` 看整稿节奏（每批最多12页）；总览不替代单页可读性验收。用 `query:{mode:"visual",slideId:"真实ID"}` 看真实整页。`inspect review` 定位待检查页，修正后只复查受影响内容。有意叠字需看图说明；溢出/重叠要实际修复，不能靠截图成功证明设计合格。

完成后保存并正常导出原生 PPTX。Agent 不能用 allow_unreviewed 自行跳过 PPT 验收；未完成时 save 保留进度并明确说明草稿状态，用户仍可从编辑器直接导出。版本冲突先读受影响页，断线恢复同一会话，不重建覆盖用户改动。交付说明必须与实际成品和审核状态一致。

## 按需资源

- 共享设计：`skill_reference_read(skill="mona-design", ref_path="native-pptx.md")`，继续按需读取完整设计资源，不在本 Skill 复制第二套视觉规则。
- [Office 操作](references/office-operations.md)：打开、构建、检查和导出。`capabilities` 默认给短目录；指定实际 operations 获取参数。未知名称看 unsupportedOperations 和 availableOperations，剩余参数见 nextOperations；查询失败不代表文稿不能修改。
- [原位续编](references/in-place-editing.md)、[高级对象](references/advanced-operations.md)、[审核与恢复](references/visual-review.md)：按问题选读，不必全部加载。
