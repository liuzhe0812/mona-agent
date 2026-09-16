---
name: mona-docx
description: "Create, edit and analyze Word/DOCX documents in Mona. Use live Office sessions for ordinary work and bundled advanced helpers for unsupported OOXML, tracked changes, comments or legacy conversion."
---

# Mona Word 文档

处理 `.docx` 的新建、修改或分析时使用本 Skill。所有普通操作都通过 Mona 的 `office` 实时会话完成，让编辑器先打开，用户能看到并继续修改当前文档。

## 执行方式

本 Skill 是 Word 任务的统一入口。普通文字、表格、样式和分页操作使用下面的实时工作流。只有具体操作确实不受 Office 支持时，按需读取 [advanced-ooxml.md](references/advanced-ooxml.md)，使用本 Skill 的辅助脚本；不要把参数错误、版本冲突或视觉读取失败当作能力缺失。

高级处理必须基于最新会话导出的副本，保留原文件及用户后续修改；处理后重新打开结果并验证受影响内容与版式，再交付。详细的副本、版本及验证要求见高级参考。

## 工作流

1. 新建用 `office` 的 `open`，设置 `document_type: "docs"` 和 `display_name`；已有文件用 `open` 的工作区相对 `path`。如果运行时已提供活动 Office 会话，继续使用它。`open` 回执中的当前 `selection` 和 `version` 直接作为起点。
2. 按任务选择一个原文入口：用户选中内容用回执中的 `selection`，已知块用 `blocks`，需要定位文本用 `search`，需要结构概览用 `outline` 或 `summary`。回执已完整覆盖目标时不换工具重复读取；明确为 `partial` 时，只补读缺失块/章节，范围不重叠。用户要求不损失内容时，建立“原文章节/表格/数据项 → 输出块/位置”的覆盖清单，验收后再声称完整；内容多时自然分页或增加章节，不静默删细节。不要用磁盘副本或截图代替实时状态。
3. 用最新 `inspect` 或上一次 `apply` 返回的 `version` 填入 `expected_version`，以章节、表格或格式区域为单位分批 `apply`，让用户能看到有意义的进展；每批操作总数不超过 50。首次写入固定使用 `session_id`，`operations` 必须是数组，每项必须是 `{op, payload}`；不熟悉字段时先用 `inspect capabilities`，并通过 `operations: ["具体操作名"]` 只读相关字段，不靠失败试出参数。用户没有给出周期、权重、频率等业务值时，保留为待填写项或明确标成建议值。文档含图片时按阅读顺序安排，图片未准备好先提交文本/结构，不等待整套图片或假设存在后台生图 API。
4. 每批使用回执继续；需要结构或版式验收时，用 `blocks` 检查受影响块，用 `inspect review` 取得当前版本的待验收状态和页脚/表格分页提示，再用 `visual` 检查完整连续文档。图像响应也带 `version`；若发生冲突，重新读取相关结构和画面，保留用户刚做的修改，再提交调整后的操作，不重放旧版本。有意保留表格跨页拆行等 `[需检查]` 项时，先观察当前版本完整画面，再以非空 `reviewReason` 和 `acceptWarnings: true` 明确接受；任何修改后重新观察。
5. 会话断开或暂时失败时，用 `office` 的 `open` 携带原 `session_id` 恢复同一会话；不要新建会话或重建文档。完成后按请求调用一次 `save` 或 `export`，保存和导出都使用最新版本，导出 `output` 使用工作区相对路径。正常导出返回 `REVIEW_REQUIRED` 时按 `nextQueries` 完成结构/视觉验收，修复 `[错误]` 后再导出；`allow_unreviewed` 仅用于用户明确要求草稿。交付前读取 `quality-acceptance.md`，核对 `summary` 的页数和页眉页脚状态，再检查当前版本的真实画面；发现分页、断表或页码问题时先修复并复查，最后才调用交付工具。导出失败时根据结构化错误处理，不猜测多个路径，也不复制 Office 内部工作文件。

## 可用操作

外部材料先用适合其格式的读取工具获取一次；目标编辑器的选区不等于原材料。回执明确提示截断、分页或全文另存时，按缺失范围或全文引用补读，不切换工具重复读取已完整取得的内容。

当前 Docs 编辑器支持 `replace_block_text`、`delete_block`、`insert_paragraph`、`insert_title`、`insert_heading`、`insert_list`、`insert_table`、`set_table_cell`、`insert_image`、`set_block_style`、`set_table_style`、`set_page_style` 和 `set_header_footer`。新文档用一次 `insert_title` 创建文档标题，章节才使用一级到六级标题；不要用一级标题代替文档标题。用稳定块 ID 定位内容；表格的 `rowIndex`、`columnIndex` 从 0 开始。`set_page_style` 的页面尺寸和页边距使用毫米，`set_table_style` 的列宽和内边距使用像素，并支持表头字重/对齐、垂直对齐和跨页拆行控制。默认/最终节的页眉页脚和页码有实时往返验证；首节、偶数页和复杂多节变体不要宣称完全支持。详细字段和完整端到端 JSON 见 [office-example.md](references/office-example.md)。

写作和排版以事实完整、标题语义、正文节奏、表格可读和自然分页为准，具体规则见 [professional-rules.md](references/professional-rules.md)。需要后续编辑或表达数据含义的内容使用原生表格；仅为排版的自由文本可保留普通段落，不要求任意表格都变成原生对象。不擅自添加封面或目录；需要分页时用 `set_block_style` 的 `pageBreakBefore`。当前工具未提供的修订、批注或复杂 OOXML 能力不得在回复中声称已完成。

交付前按 [quality-acceptance.md](references/quality-acceptance.md) 验收内容、结构、版本和导出文件。
