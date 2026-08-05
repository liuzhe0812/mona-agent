import type { JSONContent, MarkdownRendererHelpers } from "@tiptap/core";

// 对齐方式（与 @tiptap/extension-table 内部一致）
const ALIGN_LEFT = "left";
const ALIGN_RIGHT = "right";
const ALIGN_CENTER = "center";
type TableCellAlign = typeof ALIGN_LEFT | typeof ALIGN_RIGHT | typeof ALIGN_CENTER;

// 单元格内多段落分隔符（@tiptap/extension-table 内部使用 \u001F）
const CELL_LINE_SEPARATOR = "\u001F";

/**
 * 把单元格内文本中的换行（hardBreak 输出的 `  \n`、多段落分隔符 `\u001F`、
 * 普通换行 `\n`）转换为 `<br>`，其余空白 collapse 为单个空格。
 *
 * 标准markdown表格单元格不能包含换行符，换行用 `<br>` 表示。
 * 反序列化时 marked 会把 `<br>` 解析为 html token，再由 TipTap 的 HardBreak 扩展还原为 hardBreak 节点。
 */
function collapseCellWhitespace(s: string): string {
  return (s || "")
    .replace(/ {2,}\\?\n/g, "<br>") // hardBreak: `  \n` 或 `  \\\n`
    .replace(/\\?\n/g, "<br>") // 普通换行
    .replace(/\u001F/g, "<br>") // 多段落分隔符
    .replace(/\s+/g, " ") // 其他空白 collapse
    .trim();
}

/**
 * 自定义表格 markdown 序列化：覆盖 @tiptap/extension-table 默认实现，
 * 保留单元格内的换行（转为 `<br>`），避免换行被 collapseWhitespace 替换为空格。
 */
export function renderTableToMarkdown(node: JSONContent, h: MarkdownRendererHelpers): string {
  if (!node || !node.content || node.content.length === 0) {
    return "";
  }

  const rows: { text: string; isHeader: boolean; align: TableCellAlign | null }[][] = [];

  node.content.forEach((rowNode) => {
    const cells: { text: string; isHeader: boolean; align: TableCellAlign | null }[] = [];

    if (rowNode.content) {
      rowNode.content.forEach((cellNode) => {
        let raw = "";

        if (cellNode.content && Array.isArray(cellNode.content) && cellNode.content.length > 1) {
          const parts = cellNode.content.map(
            (child) => h.renderChildren(child as unknown as JSONContent),
          );
          raw = parts.join(CELL_LINE_SEPARATOR);
        } else {
          raw = cellNode.content
            ? h.renderChildren(cellNode.content as unknown as JSONContent[])
            : "";
        }

        const text = collapseCellWhitespace(raw);
        const isHeader = cellNode.type === "tableHeader";
        const align: TableCellAlign | null = cellNode.attrs?.align ?? null;

        cells.push({ text, isHeader, align });
      });
    }

    rows.push(cells);
  });

  const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  if (columnCount === 0) return "";

  const colWidths = new Array(columnCount).fill(0);
  rows.forEach((r) => {
    for (let i = 0; i < columnCount; i += 1) {
      const len = (r[i]?.text || "").length;
      if (len > colWidths[i]) colWidths[i] = len;
      if (colWidths[i] < 3) colWidths[i] = 3;
    }
  });

  const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - s.length));

  const headerRow = rows[0];
  const hasHeader = headerRow.some((c) => c.isHeader);
  const colAlignments: Array<TableCellAlign | null> = new Array(columnCount).fill(null);
  rows.forEach((r) => {
    for (let i = 0; i < columnCount; i += 1) {
      if (!colAlignments[i] && r[i]?.align) colAlignments[i] = r[i].align;
    }
  });

  let out = "\n";

  const headerTexts = new Array(columnCount)
    .fill(0)
    .map((_, i) => (hasHeader ? headerRow[i]?.text || "" : ""));

  out += `| ${headerTexts.map((t, i) => pad(t, colWidths[i])).join(" | ")} |\n`;

  out += `| ${colWidths
    .map((w, index) => {
      const dashCount = Math.max(3, w);
      const alignment = colAlignments[index];
      if (alignment === ALIGN_LEFT) return `:${"-".repeat(dashCount)}`;
      if (alignment === ALIGN_RIGHT) return `${"-".repeat(dashCount)}:`;
      if (alignment === ALIGN_CENTER) return `:${"-".repeat(dashCount)}:`;
      return "-".repeat(dashCount);
    })
    .join(" | ")} |\n`;

  const body = hasHeader ? rows.slice(1) : rows;
  body.forEach((r) => {
    out += `| ${new Array(columnCount)
      .fill(0)
      .map((_, i) => pad(r[i]?.text || "", colWidths[i]))
      .join(" | ")} |\n`;
  });

  return out;
}
