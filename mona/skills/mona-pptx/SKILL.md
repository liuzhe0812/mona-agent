---
name: mona-pptx
description: >
  使用 Mona Office 实时编辑器创建和修改原生、可编辑的 PPTX；按受众、论证和内容选择布局，
  分页小批次写入并实时预览。适用于制作、补写、重排或美化 PowerPoint 幻灯片，
  不用于仅需要图片原型的任务。
---

# Mona PPTX 原生编辑

创建页面后直接使用 `apply.createdSlides` 返回的页面 ID、顺序和尺寸；创建元素后使用 `createdElements` 的稳定 ID，不为重新获取这些信息单独检查整份文稿。

只检查样式时可在 `inspect slides` 中设置 `includeData: false`，省去图表数值；修改数据时保持默认值或显式设置为 `true`。

这个 Skill 处理 Office 编辑器里的原生幻灯片。交付目标是用户可以继续手工编辑的 PPTX，设计和写入同时进行，编辑器里的用户修改优先于 Agent 之前的计划。

用户提供的外部材料先用适合其格式的读取工具获取一次；目标编辑器的选区和概览不等于这些原材料。只有回执明确提示截断、分页或全文另存时，才按缺失范围或全文引用继续读取，不切换工具重复读取已完整取得的内容。

## 工作边界

- 新建演示文稿先调用 `office` 的 `open`，使用 `document_type: "slides"` 打开空白编辑器；已有 PPTX 才用 `path` 打开。`open` 回执中的当前 `selection`、页面尺寸和 `version` 直接作为起点，不为已返回的信息重复读取。
- 按任务选择一个合适的原文入口：已有选区用回执中的 `selection`，已知页面用 `inspect slides`，需要全稿范围时用 `summary` 或 `slides`。回执已完整覆盖目标时继续使用它；明确标为 `partial` 时，只补读缺失页面/元素，不重复扫描已有范围。用户要求保留全部内容时，建立“原文页面/章节/表格/数据项 → 输出页面/元素”的覆盖清单，验收清单后再声称完整；内容过多就增加页面，不静默删细节。
- 先做内容和受众判断，再按页内完整区域拆成有意义的小批次 `apply`，让标题、正文和关键证据尽早在编辑器中出现。图片按页面使用顺序安排；未准备好的图片不应阻塞首批文字/结构写入，也不要假设存在后台生图 API。每一批成功后使用回执继续，只有缺少后续所需信息时才补读受影响页面。
- 每次 `apply` 都带最新的 `expected_version`；遇到版本冲突，重新 `inspect` 受影响页面并根据用户当前内容重计划，不能重放旧 JSON。
- 会话断开或暂时失败时，用 `office` 的 `open` 携带原 `session_id` 恢复同一会话，再继续当前文档；不要新建替代会话或重建文档。完成后按用户要求调用 `save` 或 `export`。保存/导出前确认最后一批已经成功提交；不关闭编辑器来掩盖未保存状态。

## 按任务分流

- 精准局部修改（例如已知元素的简单改色、改字或微调几何）不需要先读完整设计指南。先使用 `open` 回执中的 `selection`；只有选区过期或缺少目标详情时才 `inspect selection`。已知操作字段直接提交；只有要做新操作时才 `inspect capabilities`，并在查询中指定具体操作名，随后只阅读对应的操作参考。
- 新建页面、重排、混排或其它布局任务按需阅读 [references/design-method.md](references/design-method.md)，再按需阅读 [references/office-operations.md](references/office-operations.md)。新建整稿、产品发布或明显需要设计提升时，再阅读 [references/visual-recipes.md](references/visual-recipes.md) 选择一个视觉方向和页面家族。不要为了同一个已知字段重复打开多本参考。网格只负责对齐和留白，不要求填满每个格子或把页面做成同质卡片模板。
- `inspect` 的 `slides` 支持 `slideIds` 和 `elementIds`；已有稳定 ID 时只读取相关页面和元素。`selection` 的结果包含当前选区元素详情，不能只依赖元素 ID 猜类型。读取返回 `partial` 时按缺失 ID 或页面补读，并保持范围不重叠。
- `inspect visual` 支持 `slideId`，也支持 `elementIds` 或 `region` 搭配 `padding` 的局部捕获。新布局、复杂图表或修改效果可疑时保留真实画面验证；精准局部改色优先依据结构回执，只有需要确认视觉效果时才截图。
- 成功的 `apply` 回执包含 `createdElements`、`updatedElements` 和 `warnings` 时，优先使用回执继续工作，避免为了取得刚刚已返回的 ID 而无必要地重复 `inspect`。版本冲突或回执缺少继续操作所需信息时才重新读取。

## 设计先行

场景与构图示例不是封闭选项。按用户目的、受众、观看方式和内容结构组织整稿，逐页选择表达；支持其它场景及混合场景，不要求用户从汇报、产品介绍、培训中三选一。选择与追问原则见下述设计指南。

新建、重排和混排页面先阅读 [references/design-method.md](references/design-method.md)。它负责内容取舍、受众、论证顺序、布局、字体比例、颜色、图标、密度、节奏、图表取舍和图文关系；局部改色等小修改按上面的分流直接处理，不要求固定模板、八项确认、封面、目录或结束页。新建整稿默认只写一个最终版本；只有用户明确要求比较或备选方案时才复制页面。页面文案要保持标题（结论）、摘要（范围/口径）、含义/行动（影响/下一步）和要点列表（同维度事实）的语义边界，无需另建 JSON 文案包，不能为了填满版式重复或拼接字段。

原生操作和 JSON 示例见 [references/office-operations.md](references/office-operations.md)。完成结构写入后，按需阅读 [references/visual-review.md](references/visual-review.md)，先用 `inspect review` 找待观察页面，再用当前版本的 `inspect visual` 审核真实编辑器画面，最后做局部微调。写入成功、截图成功和布局验收通过是三个不同状态；任何一个都不能替代后一个。

## 原生操作规则

- 当前直接支持的幻灯片操作是 `slide_set_text`、`slide_set_font`、`slide_set_chart_style`、`slide_set_geometry`、`slide_set_fill`、`slide_set_stroke`、`slide_add_text`、`slide_add_chart`、`slide_add_shape`、`slide_add_image`、`slide_add_svg`、`slide_compose`、`slide_delete_element`、`slide_add`、`slide_duplicate`、`slide_delete` 和 `slide_move`。新增文本/形状可在同一操作中携带 `font`、`align`、`fillColor`、`strokeColor`、`strokeWidthPt` 与几何字段；新增结构只创建，不替换页面或已有元素。
- 已知元素类型和操作字段时直接使用，不再重复读取参考。只有需要新操作时才用 `inspect capabilities`，按具体操作名过滤（例如 `operations: ["slide_set_font"]`），并只使用该结果列出的字段；不要凭经验拼接未列出的操作或字段。`inspect` 的 `slides` 结果包含轻量 `style` 摘要并支持 `elementIds` 过滤；`selection` 一次返回当前页面、稳定 `slideId`/`elementIds`、`elements` 和版本。这些是实时编辑器状态，不是截图或底层 AST。
- `inspect` 的 `visual` 模式接受 `slideId`，以及可选的 `elementIds` 或 `region`/`padding` 局部捕获；省略目标时使用当前选区页面，返回真实 `SlideCanvas` PNG 的 `dataUrl`、`width`、`height`、`target` 和 `warnings`。捕获前后版本必须一致；收到 `VERSION_CONFLICT` 时先重新 `inspect`，不要继续沿用旧页面或旧操作。
- 需要后续编辑或表达数据含义的原生表格、图表、SmartArt 或段落格式时，按需阅读 [references/advanced-operations.md](references/advanced-operations.md)。只列出已验证的 `slide_apply_txn` payload；排版性自由文本可以保持普通文本，不要求把任意表格都改成原生对象。新增结构后必须取得稳定元素 ID，再做单独编辑和视觉复核。
- `slide_apply_txn` 只接收已在当前 GenOffice 注册表中验证过的操作，最多 50 个；普通操作使用 [office-operations.md](references/office-operations.md)，表格、图表、SmartArt 和段落格式使用 [advanced-operations.md](references/advanced-operations.md)，不凭经验发明字段。
- 局部修改快速路径：先从 `selection` 取得选中的稳定 `slideId`、`elementId` 和最新版本，确认元素是 `chart` 还是 `text`，一次 `apply` 正确操作后依次做结构和视觉验证。用户已经提供稳定 ID 时直接使用，不要反复扫描整份文件。字段失败时按明确 schema 修正；schema 不支持就说明能力边界并停止，不循环试拼字段。
- 图表文字改色优先使用 `slide_set_chart_style`，payload 为 `{slideId,elementId,style:{textColor?,titleColor?,axisLabelColor?,axisTitleColor?,legendColor?,dataLabelColor?}}`；颜色使用 `#RRGGBB` 或 6 位 HEX，`textColor` 统一修改图表文字，局部字段覆盖对应角色。图表只传 `slide_set_font` 的 `font.color` 时会路由为 `textColor`，其它图表字体字段会拒绝；普通文本继续使用 `slide_set_font`。
- `setChart` 的 `patch` 只接受高级操作文档列出的字段；未知参数、空 patch、错误类型、非有限数字和数据维度不匹配会明确拒绝。实际没有变化时返回 `unchanged`，不算新编辑。
- 新建或重做常见数据图表时，优先使用 `slide_add_chart`，直接传预览像素位置和 `{kind:"bar"|"line"|"area"|"pie"|"doughnut",categories:string[],series:[{name,values}]}`；可选 `title`、`legendPos`、`gridlines`、`dataLabels`、`valAxisTitle` 也只能按当前能力返回使用。说明性示例：`kind:"bar", categories:["阶段一","阶段二"], series:[{name:"完成率（示例）",values:[35,68]}]`。复杂图表或修改已有图表数据再阅读 [references/advanced-operations.md](references/advanced-operations.md) 使用已验证的高级操作。数据图表禁止用字符块、空格或重复符号模拟；对比对象拆成独立模块并保持比较维度一致。
- `slide_add_image` 写入的是图片元素；它不是原生数据图表。只有使用已验证的 `addChart`/`setChart` 注册表操作，且保留数据模型，才称为原生图表。SVG/PNG 图表即使视觉上像图表，也仍是图片。
- 编辑器支持的数据关系不要因省操作或样式方便而改用矩形加文字、SVG/PNG 代替原生图表；仅在用户明确要求图片/特殊表达或当前能力不支持时采用替代方式，并说明可编辑性限制。局部修改不据此擅自替换用户已有图表。
- `slide_add_svg` 写入的是一个整体的 SVG 矢量图片，可移动和缩放；SVG 内部的路径、文字和形状不会因此变成可逐项编辑的原生元素。只插入封闭的静态 SVG，不用整页 SVG 取代原生页面；安全格式和外链约束见当前操作能力。
- `slide_compose` 的完整网格 payload 与混排示例见 [references/office-operations.md](references/office-operations.md)。payload 是 `{slideId,x?,y?,width?,height?,columns,rows,gap?,items}`；`columns`/`rows` 是正权重数组，item 的 `column`/`row` 从 0 开始，可用 `columnSpan`、`rowSpan`、`inset`。默认页面边缘 48px、`gap` 24px。`items` 按数组顺序叠放，同一 grid area 可以重叠，文本仍逐项独立可编辑。按类型使用 `text`/`font`/`align`、`shape`/`fillColor`/`strokeColor`/`strokeWidthPt`、图片的 `dataUrl`/`assetPath` 或 SVG 的 `svg`。大照片优先传工作区内 `assetPath`，由 Gateway 转成 `dataUrl`，避免模型输出 base64。
- `slide_add_text`、`slide_add_shape` 和几何字段使用 `inspect` 返回的预览像素；`slide_set_font` 的 `font.fontSize` 使用磅值。不要把像素尺寸直接写进字体字段，也不要把 EMU 直接写进几何字段。
- 只改已明确的页面和元素。不要为了方便把整页转成一张图片、批量重建整份演示文稿、用脚本先生成整份 PPTX，或覆盖用户尚未保存的编辑。

## 完成判据

每个页面都应有清楚的主信息、在页面边界内的元素、可读的文字、与数据含义匹配的视觉表达和一致的字体/颜色/图标系统。完成顺序是“先结构、再 review/视觉、最后微调”：先用 `inspect slides`/`selection` 验收元素和稳定 ID；布局写入或收到布局 `warnings` 后，调用 `inspect review`，按回执的 `pendingSlideIds` 用当前版本逐页 `inspect visual`，处理警告后才 `save`/`export`。普通内容页的纵向平衡和 70%–90%/80% 参考见 [references/design-method.md](references/design-method.md)，封面、章节、引用和刻意留白页不按该参考判断。先完成一张代表性内容页检查，再批量延续布局；同一问题连续两轮调整仍无改善时报告“待完善”，不把未通过说成完成。自动 warning 也不全部是 bug：`[错误]` 表示必须修复的越界、文字溢出或文字相互重叠；截图不会清除这类问题。`[需检查]` 表示图文交叠等需要看真实画面判断的情况：非有意叠放必须修复；有意且可读时，先用当前版本获取整页 `visual` 截图，只有确有理由才在同一版本、非局部查询中增加非空 `reviewReason` 和 `acceptWarnings: true` 明确接受，并在交付说明中列出；缺少同版本整页前置观察、仅有局部/过期截图或存在 `[错误]` 时不能接受。任何变更后都要用最新版本重新 review 和视觉观察。普通导出遇到 `REVIEW_REQUIRED` 时先完成同一流程。`allow_unreviewed` 只用于用户明确要求草稿或跳过审阅，草稿不能称为已验收。具体视觉检查见 [references/visual-review.md](references/visual-review.md)。
