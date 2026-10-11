import * as React from "react";
import { Copy, Download, Maximize2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type TableCellValue = {
  value: string;
  align: string | null;
};

export type MarkdownTableProps = React.ComponentPropsWithoutRef<"table"> & {
  node?: unknown;
};

function readCellText(cell: HTMLTableCellElement): string {
  if (typeof cell.innerText === "string") return cell.innerText.trim();

  const textFromNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node instanceof HTMLBRElement) return "\n";
    return Array.from(node.childNodes).map(textFromNode).join("");
  };

  return textFromNode(cell).trim();
}

function readTableRows(table: HTMLTableElement): TableCellValue[][] {
  return Array.from(table.rows).map((row) =>
    Array.from(row.cells).map((cell) => ({
      value: readCellText(cell),
      align: cell.style.textAlign || cell.getAttribute("align"),
    })),
  );
}

function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function formatMarkdownRow(cells: TableCellValue[]): string {
  return `| ${cells.map(({ value }) => escapeMarkdownCell(value)).join(" | ")} |`;
}

function buildMarkdownTable(rows: TableCellValue[][]): string {
  if (rows.length === 0) return "";

  const lines = [formatMarkdownRow(rows[0])];
  lines.push(
    `| ${rows[0]
      .map(({ align }) => {
        if (align === "center") return ":---:";
        if (align === "right") return "---:";
        if (align === "left") return ":---";
        return "---";
      })
      .join(" | ")} |`,
  );
  lines.push(...rows.slice(1).map(formatMarkdownRow));
  return lines.join("\n");
}

function escapeCsvCell(value: string): string {
  const safeValue = /^[\u0000-\u0020]*[=+\-@＝＋－＠]/u.test(value) ? `'${value}` : value;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

function buildCsvTable(rows: TableCellValue[][]): string {
  return rows.map((row) => row.map(({ value }) => escapeCsvCell(value)).join(",")).join("\r\n");
}

function errorDetail(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "请稍后重试。";
}

const tableClassName = cn(
  "w-max min-w-full border-separate border-spacing-0 text-ui",
  "[&_th]:min-w-16 [&_th]:max-w-md [&_th]:whitespace-normal [&_th]:break-words [&_th]:border-b [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground",
  "[&_td]:min-w-16 [&_td]:max-w-md [&_td]:whitespace-normal [&_td]:break-words [&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top [&_td]:text-foreground",
  "[&_th[align=left]]:text-left [&_td[align=left]]:text-left [&_th[align=center]]:text-center [&_td[align=center]]:text-center [&_th[align=right]]:text-right [&_td[align=right]]:text-right",
);

export const MarkdownTable = React.forwardRef<
  HTMLTableElement,
  MarkdownTableProps
>(function MarkdownTable({ children, className, node: _node, ...tableProps }, forwardedRef) {
  const tableRef = React.useRef<HTMLTableElement>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  React.useImperativeHandle(forwardedRef, () => tableRef.current as HTMLTableElement, []);

  const handleCopyMarkdown = async () => {
    try {
      const table = tableRef.current;
      if (!table) throw new Error("表格尚未加载");
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("当前环境不支持复制");
      }

      await navigator.clipboard.writeText(buildMarkdownTable(readTableRows(table)));
      setFeedback({ kind: "success", text: "已复制为 Markdown" });
    } catch (error) {
      setFeedback({ kind: "error", text: `复制失败：${errorDetail(error)}` });
    }
  };

  const handleDownloadCsv = () => {
    let objectUrl: string | null = null;
    let link: HTMLAnchorElement | null = null;

    try {
      const table = tableRef.current;
      if (!table) throw new Error("表格尚未加载");
      if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        throw new Error("当前环境不支持下载");
      }

      const csv = `\uFEFF${buildCsvTable(readTableRows(table))}`;
      objectUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      link = document.createElement("a");
      link.href = objectUrl;
      link.download = "table.csv";
      document.body.appendChild(link);
      link.click();
      setFeedback({ kind: "success", text: "CSV 已开始下载" });
      const downloadUrl = objectUrl;
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
    } catch (error) {
      if (objectUrl && typeof URL !== "undefined") URL.revokeObjectURL(objectUrl);
      setFeedback({ kind: "error", text: `下载失败：${errorDetail(error)}` });
    } finally {
      link?.remove();
    }
  };

  const resolvedTableClassName = cn(tableClassName, className);

  return (
    <div className="my-0 flex min-w-0 w-full flex-col gap-2">
      <div className="flex flex-wrap items-center justify-end gap-1" data-markdown-table-toolbar="">
        <Button type="button" variant="outline" size="sm" onClick={() => void handleCopyMarkdown()}>
          <Copy aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          复制 Markdown
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={handleDownloadCsv}>
          <Download aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          下载 CSV
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
          <Maximize2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          表格预览
        </Button>
      </div>

      {feedback ? (
        <p
          aria-live="polite"
          className={cn(
            "text-caption",
            feedback.kind === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.text}
        </p>
      ) : null}

      <div className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded-md border border-border">
        <table {...tableProps} ref={tableRef} className={resolvedTableClassName}>
          {children}
        </table>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-hidden p-4">
          <DialogHeader className="pr-8">
            <DialogTitle>表格预览</DialogTitle>
            <DialogDescription>在独立窗口中查看完整表格。</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 w-full overflow-auto rounded-md border border-border bg-background">
            <table
              className={cn(
                resolvedTableClassName,
                "[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background",
              )}
            >
              {children}
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
});
