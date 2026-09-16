---
name: mona-xlsx
description: "Use Mona's live Office sheets sessions to create, edit, and analyze professional XLSX workbooks while preserving source data, formulas, styles, and native save/export."
---

# Mona Excel 工作簿

处理 `.xlsx` 的新建、修改或分析时使用本 Skill。普通操作通过 Mona 的 `office` 实时会话完成，先打开编辑器，再按数据区域分批写入并复核。

## 工作流

1. 新建用 `office` 的 `open`，设置 `document_type: "sheets"` 和 `display_name`；已有文件用 `open` 的工作区相对 `path`。`open` 回执中的当前工作表、`selection` 和 `version` 直接作为起点，不猜测 `Sheet1`。
2. 按任务选择一个原文入口：用户选中单元格用回执中的 `selection`，已知目标用 `range`，需要工作表名或规模用 `summary`。回执已完整覆盖目标时不换工具重复读取；明确为 `partial` 时，只补读缺失行列/范围，保持范围不重叠。用户要求不损失数据时，建立“原文数据项/公式/表格区域 → 输出单元格/区域”的覆盖清单，验收后再声称完整；内容多时拆成更多范围或工作表，不静默删数据。需要核对公式或格式时按需设置 `include_formula: true`、`include_style: true`。
3. 用最新 `version` 填入 `expected_version`，通过以数据区域、公式组或版式区域为单位的小批次 `apply` 写入，让用户能看到有意义的进展；每批操作不超过 50 个，读写大区域时拆分。已知操作字段直接使用；只有新操作才调用 `inspect capabilities`，并指定具体操作名（例如 `operations: ["set_formula"]`），再按需读取对应参考。
4. 每批后用 `range` 补读受影响区域，确认原始值、公式、真实结果、数据类型和样式；该读取同时完成对应目标的结构验收。随后用 `inspect review` 检查是否仍有未读回目标及本次修改公式产生的 `#REF!`、`#DIV/0!`、`#VALUE!` 等明确错误。需要版式验收时再用 `visual` 检查当前可见 viewport。Excel 的视觉图只覆盖当前 viewport，必须与 `range` 结合，不能把一张图当作全表视觉验收。用户编辑造成版本变化时先重新读取，不覆盖用户修改。
5. 会话断开或暂时失败时，用 `office` 的 `open` 携带原 `session_id` 恢复同一会话；不要新建会话或重建工作簿。完成后使用最新版本调用 `save` 或 `export`。正常导出返回 `REVIEW_REQUIRED` 时按 `nextQueries` 读取待验收范围，修复公式 `[错误]` 后再导出；`allow_unreviewed` 仅用于用户明确要求草稿。导出 `output` 必须是工作区相对 `.xlsx` 路径。

## 可用操作

外部材料先用适合其格式的读取工具获取一次；目标工作簿的选区不等于原始资料。回执明确提示截断、分页或全文另存时，按缺失范围或全文引用补读，不切换工具重复读取已完整取得的内容。

当前 schema 支持 `set_cell`、`set_range`、`set_formula`、`clear_range`、`set_style`，以及 `insert/delete_rows`、`insert/delete_columns`、`merge/unmerge_cells`、`add/delete/rename/move_sheet`、`set_column_width`、`set_row_height`。详细 payload 和完整端到端 JSON 见 [office-example.md](references/office-example.md)。

公式必须用 `set_formula` 写入并通过 `inspect` 读取真实结果；不能用手算结果替代公式，也不能把公式覆盖成静态值。原生单元格/范围用于需要编辑和数据含义的表格；仅为排版的自由文本可保持文本区域，不为形式强行增加表格结构。`set_style` 还支持字体、字号、下划线、删除线、垂直对齐、自动换行和四边框；列宽使用字符宽度，行高使用磅。数字格式、单位和可读性规则见 [professional-rules.md](references/professional-rules.md)。合并只用于确有语义的标题区域，不能用来修补数据布局。

当前 schema 还支持 `set_auto_filter`、`set_freeze_panes` 和 `set_conditional_format`，只在数据范围、滚动长度或业务阈值确实需要时使用。原生图表仍未开放给普通 Agent；不得用图片冒充可编辑图表。交付前按 [quality-acceptance.md](references/quality-acceptance.md) 验收数据、公式、格式、可读性和导出文件。
