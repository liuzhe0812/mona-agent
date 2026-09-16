import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DbToolButton } from "./DbToolButton";
import { DbIcon } from "./DbIcon";
import { useDbStore } from "./store/dbStore";
import { DEFAULT_BROWSE, canEditTable, cellLiteral, quoteIdentifier, textLiteral } from "./table-sql";
import { displayCellValue, NULL_MARKER, DEFAULT_MARKER, type QueryResult, type QueryTab, type TableBrowse, type TableFilter } from "./types";

export function recordHighlightKey(result: QueryResult, rowIdx: number, page: number) {
  const primaryKeys = result.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.is_primary_key);
  if (primaryKeys.length) {
    return `pk:${primaryKeys.map(({ column, index }) => `${column.name}=${JSON.stringify(result.rows[rowIdx]?.[index])}`).join("|")}`;
  }
  return `page:${page}:row:${rowIdx}`;
}

export function preferredColumnWidth(name: string, values: string[]): number {
  const longest = values.reduce((width, value) => Math.max(width, value.length), name.length);
  return Math.max(96, Math.min(320, longest * 8 + 32));
}

export function DataGrid({ tab, onBrowse, onRefresh }: { tab: QueryTab; onBrowse?: (patch: Partial<TableBrowse>) => void; onRefresh?: () => void }) {
  const patchTab = useDbStore((s) => s.patchTab);
  const schemaSaving = useDbStore((s) => s.queryTabs.some((item) => item.kind === "structure" && item.isSaving && item.connectionId === tab.connectionId && item.database === tab.database && item.tableName === tab.tableName));
  const [cell, setCell] = useState<{ row: number; col: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [columnViewOpen, setColumnViewOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [valueType, setValueType] = useState("text");
  const [format, setFormat] = useState<"text" | "json" | "xml" | "php">("text");
  const [error, setError] = useState<string | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [pinnedColumns, setPinnedColumns] = useState<string[]>([]);
  const [selectedColumns, setSelectedColumns] = useState<number[]>([]);
  const [selectionMode, setSelectionMode] = useState<"cell" | "range" | "row" | "column" | "all">("cell");
  const resize = useRef<{ name: string; x: number; width: number } | null>(null);
  const rowSelectionAnchor = useRef<number | null>(null);
  const cellSelectionAnchor = useRef<{ row: number; col: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const cancelEdit = useRef(false);
  const inputChanged = useRef(false);
  const busy = tab.isExecuting || tab.isSaving || tab.isLoadingMetadata || schemaSaving;
  const editable = canEditTable(tab) && !busy;
  const result = tab.result;
  const rows = tab.selectedRows ?? [];
  const browse = tab.browse ?? DEFAULT_BROWSE;
  const visible = result?.columns.map((col, index) => ({ ...col, index })).filter((col) => !tab.hiddenColumns?.includes(col.name)) ?? [];
  const preferredWidths = useMemo(() => result ? Object.fromEntries(visible.map((column) => [column.name, preferredColumnWidth(column.name, result.rows.slice(0, 100).map((row) => displayCellValue(row[column.index])))])) : {}, [result, tab.hiddenColumns]);
  const widthFor = (columnName: string) => widths[columnName] ?? preferredWidths[columnName] ?? 96;
  const connection = useDbStore((state) => state.activeConnections.find((item) => item.id === tab.connectionId));
  const sqlite = connection?.config.db_type === "sqlite";
  const pinnedOffsets = new Map<string, number>();
  let pinnedOffset = 48;
  for (const name of pinnedColumns) {
    const column = visible.find((item) => item.name === name);
    if (!column) continue;
    pinnedOffsets.set(name, pinnedOffset);
    pinnedOffset += widthFor(name);
  }
  const valueAt = (r: number, c: number) => {
    const edit = tab.edits.find((e) => e.rowIdx === r && e.colIdx === c);
    if (edit) return edit.newValue;
    const value = result!.rows[r][c];
    return value.type === "null" ? NULL_MARKER : displayCellValue(value);
  };
  const display = (value: string) => value === NULL_MARKER ? "NULL" : value === DEFAULT_MARKER ? "DEFAULT" : value;

  function rowHighlightKey(rowIdx: number) {
    return result ? recordHighlightKey(result, rowIdx, browse.page) : `page:${browse.page}:row:${rowIdx}`;
  }

  function selectRow(rowIdx: number, event: React.MouseEvent<HTMLTableCellElement>) {
    setSelectionMode("row");
    setSelectedColumns(visible.map((column) => column.index));
    let nextRows: number[];
    if (event.shiftKey) {
      const anchor = rowSelectionAnchor.current ?? rows.at(-1) ?? rowIdx;
      const start = Math.min(anchor, rowIdx);
      const end = Math.max(anchor, rowIdx);
      const range = Array.from({ length: end - start + 1 }, (_, index) => start + index);
      nextRows = event.ctrlKey || event.metaKey
        ? Array.from(new Set([...rows, ...range])).sort((a, b) => a - b)
        : range;
    } else if (event.ctrlKey || event.metaKey) {
      nextRows = rows.includes(rowIdx) ? rows.filter((index) => index !== rowIdx) : [...rows, rowIdx].sort((a, b) => a - b);
    } else {
      nextRows = [rowIdx];
    }
    if (!event.shiftKey) rowSelectionAnchor.current = rowIdx;
    patchTab(tab.id, { selectedRows: nextRows });
  }

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const start = resize.current;
      if (start) setWidths((old) => ({ ...old, [start.name]: Math.max(100, Math.min(800, start.width + event.clientX - start.x)) }));
    };
    const end = () => { resize.current = null; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", end); };
  }, []);
  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);
  useEffect(() => {
    setCell(null); setEditing(false); setExpanded(false);
    setSelectedColumns([]); setSelectionMode("cell");
    if (!tab.insertedRows.length) scrollRef.current?.scrollTo?.({ top: 0 });
  }, [tab.id, browse.page, result?.rows]);
  useEffect(() => {
    const row = tab.insertedRows[tab.insertedRows.length - 1];
    if (row === undefined) return;
    const element = scrollRef.current?.querySelector<HTMLTableRowElement>(`[data-row-index="${row}"]`);
    element?.scrollIntoView?.({ block: "nearest" });
    element?.querySelector<HTMLElement>('td[tabindex="0"]')?.focus();
  }, [tab.insertedRows.length]);

  function startEdit(r: number, c: number, forceExpanded = false) {
    setCell({ row: r, col: c });
    const value = valueAt(r, c);
    setDraft(value === NULL_MARKER || value === DEFAULT_MARKER ? "" : value);
    setValueType(value === NULL_MARKER ? "null" : value === DEFAULT_MARKER ? "default" : "text");
    setFormat("text"); setError(null); cancelEdit.current = false; inputChanged.current = false;
    if (forceExpanded || !editable || result!.rows[r][c].type === "blob") setExpanded(true);
    else setEditing(true);
  }
  function applyValue(value: string) {
    if (!cell || !editable) return;
    useDbStore.getState().updateCell(tab.id, cell.row, cell.col, value);
  }
  function commitInline() {
    if (!cancelEdit.current && inputChanged.current && cell && draft !== valueAt(cell.row, cell.col)) applyValue(draft);
    setEditing(false);
  }
  function focusCell(r: number, c: number) {
    setCell({ row: r, col: c });
    setSelectedColumns([c]);
    setSelectionMode("cell");
  }

  function chooseCell(r: number, c: number) {
    focusCell(r, c);
    cellSelectionAnchor.current = { row: r, col: c };
    rowSelectionAnchor.current = r;
    patchTab(tab.id, { selectedRows: [r] });
  }

  function selectCellRange(r: number, c: number) {
    const anchor = cellSelectionAnchor.current ?? cell ?? { row: r, col: c };
    const rowStart = Math.min(anchor.row, r);
    const rowEnd = Math.max(anchor.row, r);
    const colStart = Math.min(anchor.col, c);
    const colEnd = Math.max(anchor.col, c);
    setCell({ row: r, col: c });
    setSelectedColumns(Array.from({ length: colEnd - colStart + 1 }, (_, index) => colStart + index));
    setSelectionMode("range");
    patchTab(tab.id, { selectedRows: Array.from({ length: rowEnd - rowStart + 1 }, (_, index) => rowStart + index) });
  }

  async function copyText(value: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("当前环境不支持复制到剪贴板。");
      await navigator.clipboard.writeText(value);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function currentValueLiteral(rowIdx: number, colIdx: number): string {
    const edit = tab.edits.find((item) => item.rowIdx === rowIdx && item.colIdx === colIdx);
    if (!edit) return cellLiteral(result!.rows[rowIdx][colIdx], sqlite);
    if (edit.newValue === NULL_MARKER) return "NULL";
    if (edit.newValue === DEFAULT_MARKER) return "DEFAULT";
    return textLiteral(edit.newValue, sqlite);
  }

  type CopyKind = "where" | "insert-batch" | "insert" | "upsert" | "insert-selection" | "insert-selection-batch" | "update" | "delete" | "headers-data" | "data" | "headers";

  function copyRowAs(kind: CopyKind) {
    if (!cell || !result || !tab.database || !tab.tableName) return;
    const selectedRowIndexes = selectionMode === "column"
      ? result.rows.map((_row, index) => index)
      : rows.length ? rows : [cell.row];
    const allColumnIndexes = result.columns.map((_column, index) => index);
    const regionColumns = selectedColumns.length ? selectedColumns : [cell.col];
    const normalColumns = allColumnIndexes.filter((index) => !result.columns[index].is_auto_increment);
    const regionRows = selectedRowIndexes.filter((index) => result.rows[index]);
    try {
      const target = `${quoteIdentifier(tab.database, sqlite)}.${quoteIdentifier(tab.tableName, sqlite)}`;
      const primaryKeyIndexes = (tab.tableInfo?.columns.filter((column) => column.is_primary_key) ?? []).map((column) => {
        const index = result.columns.findIndex((item) => item.name === column.name);
        if (index < 0) throw new Error("结果中缺少主键字段，无法生成安全的 SQL。");
        return index;
      });
      const whereFor = (rowIdx: number) => {
        const indexes = primaryKeyIndexes.length ? primaryKeyIndexes : [cell.col];
        return indexes.map((index) => `${quoteIdentifier(result.columns[index].name, sqlite)} = ${cellLiteral(result.rows[rowIdx][index], sqlite)}`).join(" AND ");
      };
      const insertSql = (rowIndexes: number[], columnIndexes: number[]) => {
        const fields = columnIndexes.map((index) => quoteIdentifier(result.columns[index].name, sqlite)).join(", ");
        const values = rowIndexes.map((rowIdx) => `(${columnIndexes.map((index) => currentValueLiteral(rowIdx, index)).join(", ")})`).join(",\n  ");
        return `INSERT INTO ${target} (${fields}) VALUES\n  ${values}`;
      };
      let output: string;
      switch (kind) {
        case "where":
          output = regionRows.map((row) => `(${whereFor(row)})`).join(" OR ");
          break;
        case "insert":
          output = `${insertSql([cell.row], normalColumns)};`;
          break;
        case "insert-batch":
          output = `${insertSql(regionRows, normalColumns)};`;
          break;
        case "insert-selection":
          output = `${insertSql([cell.row], regionColumns.filter((index) => !result.columns[index].is_auto_increment))};`;
          break;
        case "insert-selection-batch":
          output = `${insertSql(regionRows, regionColumns.filter((index) => !result.columns[index].is_auto_increment))};`;
          break;
        case "upsert": {
          if (sqlite) throw new Error("InsertOnUpdateSQL 目前仅支持 MySQL / MariaDB。");
          const updateColumns = normalColumns.filter((index) => !result.columns[index].is_primary_key);
          output = `${insertSql(regionRows, normalColumns)} ON DUPLICATE KEY UPDATE ${updateColumns.map((index) => {
            const name = quoteIdentifier(result.columns[index].name, false);
            return `${name} = VALUES(${name})`;
          }).join(", ")};`;
          break;
        }
        case "update": {
          if (!primaryKeyIndexes.length) throw new Error("当前表没有可靠主键，无法生成 UPDATE SQL。");
          const updateColumns = normalColumns.filter((index) => !result.columns[index].is_primary_key);
          output = regionRows.map((row) => `UPDATE ${target} SET ${updateColumns.map((index) => `${quoteIdentifier(result.columns[index].name, sqlite)} = ${currentValueLiteral(row, index)}`).join(", ")} WHERE ${whereFor(row)};`).join("\n");
          break;
        }
        case "delete":
          if (!primaryKeyIndexes.length) throw new Error("当前表没有可靠主键，无法生成 DELETE SQL。");
          output = regionRows.map((row) => `DELETE FROM ${target} WHERE ${whereFor(row)};`).join("\n");
          break;
        case "headers":
          output = regionColumns.map((index) => result.columns[index].name).join("\t");
          break;
        case "data":
        case "headers-data": {
          const data = regionRows.map((rowIdx) => regionColumns.map((index) => display(valueAt(rowIdx, index))).join("\t")).join("\n");
          output = kind === "headers-data" ? `${regionColumns.map((index) => result.columns[index].name).join("\t")}\n${data}` : data;
          break;
        }
      }
      void copyText(output);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function paste(mode: "grid" | "text" | "selection" | "new") {
    if (!cell || !editable || !result) return;
    try {
      if (!navigator.clipboard?.readText) throw new Error("当前环境不支持读取剪贴板。");
      const value = await navigator.clipboard.readText();
      const matrix = value.replace(/\r\n/g, "\n").split("\n").filter((line, index, lines) => line.length || index < lines.length - 1).map((line) => line.split("\t"));
      if (mode === "text") applyValue(value);
      if (mode === "grid") {
        for (let rowOffset = 0; rowOffset < matrix.length; rowOffset += 1) {
          const rowIdx = cell.row + rowOffset;
          if (!result?.rows[rowIdx]) break;
          for (let colOffset = 0; colOffset < matrix[rowOffset].length; colOffset += 1) {
            const colIdx = cell.col + colOffset;
            if (!result.columns[colIdx]) break;
            useDbStore.getState().updateCell(tab.id, rowIdx, colIdx, matrix[rowOffset][colOffset]);
          }
        }
      }
      if (mode === "selection") {
        const targetRows = selectionMode === "column" ? result.rows.map((_row, index) => index) : rows.length ? rows : [cell.row];
        const targetColumns = selectedColumns.length ? selectedColumns : [cell.col];
        const firstValue = matrix[0]?.[0] ?? "";
        for (const row of targetRows) for (const column of targetColumns) useDbStore.getState().updateCell(tab.id, row, column, firstValue);
      }
      if (mode === "new") {
        for (const values of matrix) {
          useDbStore.getState().insertRow(tab.id);
          const next = useDbStore.getState().queryTabs.find((item) => item.id === tab.id);
          const row = (next?.result?.rows.length ?? 1) - 1;
          for (let index = 0; index < values.length && cell.col + index < (next?.result?.columns.length ?? 0); index += 1) {
            useDbStore.getState().updateCell(tab.id, row, cell.col + index, values[index]);
          }
        }
      }
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function fill(value: string) {
    if (!cell || !editable) return;
    const targetRows = selectionMode === "column" ? result!.rows.map((_row, index) => index) : rows.length ? rows : [cell.row];
    const targetColumns = selectedColumns.length ? selectedColumns : [cell.col];
    for (const row of targetRows) for (const column of targetColumns) useDbStore.getState().updateCell(tab.id, row, column, value);
  }

  function jumpTo(row: number) {
    const bounded = Math.max(0, Math.min(result!.rows.length - 1, row));
    const element = scrollRef.current?.querySelector<HTMLTableRowElement>(`[data-row-index="${bounded}"]`);
    element?.scrollIntoView({ block: "center" });
    const col = cell?.col ?? visible[0]?.index ?? 0;
    chooseCell(bounded, col);
    element?.querySelector<HTMLElement>(`td[data-col-index="${col}"]`)?.focus();
  }

  if (!result) return <EmptyState className="flex-1" title={tab.isLoadingMetadata ? "正在读取表结构" : tab.isExecuting ? "正在读取数据" : "尚无结果"} />;
  const selectionContainsCell = Boolean(cell && rows.includes(cell.row) && (
    selectionMode === "row" || selectionMode === "all" || selectionMode === "range" && selectedColumns.includes(cell.col)
  ));
  const operationRows = selectionContainsCell ? rows.filter((row) => result.rows[row]) : cell ? [cell.row] : [];
  const operationColumns = selectionContainsCell && selectedColumns.length ? selectedColumns : cell ? [cell.col] : [];
  const canUndoSelection = operationRows.some((row) => tab.insertedRows.includes(row) || tab.deletedRows?.includes(row) || tab.edits.some((edit) => edit.rowIdx === row && operationColumns.includes(edit.colIdx)));
  const cloneSelection = () => {
    let failed = 0;
    for (const row of operationRows) if (!useDbStore.getState().cloneRow(tab.id, row)) failed += 1;
    if (failed) setError(`${failed} 行包含不可克隆的数据。`);
  };
  const deleteSelection = () => {
    for (const row of [...operationRows].sort((a, b) => b - a)) void useDbStore.getState().deleteRow(tab.id, row);
  };
  const undoSelection = () => {
    for (const row of [...operationRows].filter((item) => tab.insertedRows.includes(item)).sort((a, b) => b - a)) void useDbStore.getState().deleteRow(tab.id, row);
    const latest = useDbStore.getState().queryTabs.find((item) => item.id === tab.id);
    if (!latest) return;
    const rowSet = new Set(operationRows);
    const columnSet = new Set(operationColumns);
    patchTab(tab.id, {
      deletedRows: latest.deletedRows?.filter((row) => !rowSet.has(row)),
      edits: latest.edits.filter((edit) => !rowSet.has(edit.rowIdx) || !columnSet.has(edit.colIdx)),
    });
  };
  const highlightSelection = (tone?: "warning" | "success" | "destructive") => {
    const next = { ...(tab.rowHighlights ?? {}) };
    for (const row of operationRows) {
      const key = rowHighlightKey(row);
      if (tone) next[key] = tone;
      else delete next[key];
    }
    patchTab(tab.id, { rowHighlights: next });
  };
  return (
    <TooltipProvider delayDuration={250}>
      <div ref={scrollRef} className="scrollbar-thin scrollbar-track-transparent relative min-h-0 flex-1 overflow-auto bg-background" aria-busy={busy}>
        {error && !expanded && <p role="alert" className="p-2 text-caption text-destructive">{error}</p>}
        <ContextMenu>
          <ContextMenuTrigger className="block min-h-full">
            <table className="min-w-full table-fixed border-collapse text-caption" style={{ width: visible.reduce((sum, col) => sum + widthFor(col.name), 0) + 48 }}>
              <colgroup><col style={{ width: 48 }} />{visible.map((col) => <col key={col.name} style={{ width: widthFor(col.name) }} />)}</colgroup>
              <thead>
                <tr className="h-8">
                  <th className="sticky left-0 top-0 z-30 border-b border-r border-border bg-muted px-2 font-normal text-muted-foreground" aria-label="行号" />
                  {visible.map((col) => <th key={col.name} aria-sort={browse.sort?.column === col.name ? browse.sort.direction === "asc" ? "ascending" : "descending" : "none"}
                    style={pinnedOffsets.has(col.name) ? { left: pinnedOffsets.get(col.name) } : undefined}
                    className={cn("sticky top-0 z-10 h-8 border-b border-r border-border bg-muted px-2 text-left font-medium", pinnedOffsets.has(col.name) && "z-20", (selectionMode === "column" || selectionMode === "all") && selectedColumns.includes(col.index) && "bg-accent")}>
                    <div className="flex items-center gap-0">
                      <span className="min-w-0 flex-1 truncate" title={col.data_type}>{col.name}</span>
                      {onBrowse && <>
                        <ColumnFilter column={col.name} filter={browse.filters.find((f) => f.column === col.name)} disabled={busy}
                          onApply={(filter) => onBrowse({ page: 0, filters: [...browse.filters.filter((f) => f.column !== col.name), ...(filter ? [filter] : [])] })} />
                        <DbToolButton icon={browse.sort?.column === col.name ? browse.sort.direction === "asc" ? "sortAsc" : "sortDesc" : "sort"} label={`排序 ${col.name}`} className={cn("h-6 w-6 hover:bg-transparent active:bg-transparent [&>svg]:h-3.5 [&>svg]:w-3.5", browse.sort?.column === col.name && "text-info")}
                          disabled={busy} onClick={() => onBrowse({ page: 0, sort: browse.sort?.column !== col.name ? { column: col.name, direction: "asc" } : browse.sort.direction === "asc" ? { column: col.name, direction: "desc" } : null })} />
                      </>}
                    </div>
                    <div role="separator" aria-label={`调整 ${col.name} 列宽`} aria-orientation="vertical" tabIndex={0}
                      className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-info/30 focus-visible:bg-info/30"
                      onMouseDown={(e) => { e.preventDefault(); resize.current = { name: col.name, x: e.clientX, width: widthFor(col.name) }; }}
                      onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setWidths((old) => ({ ...old, [col.name]: Math.max(100, widthFor(col.name) + (e.key === "ArrowRight" ? 20 : -20)) })); } }} />
                  </th>)}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, r) => {
                  const removed = tab.deletedRows?.includes(r);
                  const inserted = tab.insertedRows.includes(r);
                  const highlight = tab.rowHighlights?.[rowHighlightKey(r)];
                  const highlightStyle = highlight === "warning"
                    ? "hsl(var(--warning) / 0.1)"
                    : highlight === "success"
                      ? "hsl(var(--success) / 0.1)"
                      : highlight === "destructive"
                        ? "hsl(var(--destructive) / 0.1)"
                        : undefined;
                  const selectedRow = rows.includes(r) && selectionMode !== "column";
                  return <tr key={r} data-row-index={r} style={highlightStyle ? { backgroundColor: highlightStyle } : undefined} className={cn("h-7 border-b border-border/40 hover:bg-accent/50", !inserted && "odd:bg-muted/20", removed && "text-muted-foreground line-through", inserted && "bg-success/5", highlight === "warning" && "bg-warning/10", highlight === "success" && "bg-success/10", highlight === "destructive" && "bg-destructive/10")}>
                    <td className={cn("sticky left-0 z-10 cursor-default select-none border-r border-border/40 bg-inherit px-2 text-center tabular-nums text-muted-foreground", selectedRow && "bg-muted")} aria-label={`选择第 ${r + 1} 行`} onPointerDown={(event) => { if (event.button !== 0) return; if (event.shiftKey) event.preventDefault(); selectRow(r, event); }}>{inserted ? "+" : selectedRow ? "•" : browse.page * browse.pageSize + r + 1}</td>
                    {visible.map((col) => {
                      const c = col.index;
                      const value = valueAt(r, c);
                      const active = cell?.row === r && cell.col === c;
                      const selectedCell = active || selectionMode === "range" && rows.includes(r) && selectedColumns.includes(c);
                      const dirty = tab.edits.some((e) => e.rowIdx === r && e.colIdx === c);
                      return <td key={col.name} data-col-index={c} tabIndex={0} title={display(value)}
                        style={pinnedOffsets.has(col.name) ? { left: pinnedOffsets.get(col.name) } : undefined}
                        className={cn("h-7 truncate border-r border-border/40 px-2 py-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring", pinnedOffsets.has(col.name) && "sticky z-10 bg-inherit", selectionMode === "column" && selectedColumns.includes(c) && "bg-accent", selectedCell && !(active && editing) && "bg-info/25", active && editing && "bg-background p-0", dirty && "bg-warning/15", value === NULL_MARKER && "italic text-muted-foreground", (row[c].type === "integer" || row[c].type === "float") && "text-right")}
                        onPointerDown={(event) => {
                          if ((event.target as HTMLElement).closest("input, textarea, select, button")) return;
                          if (event.shiftKey) event.preventDefault();
                          if (event.button === 2) {
                            const insideSelection = rows.includes(r) && (
                              selectionMode === "row" || selectionMode === "all" || selectionMode === "range" && selectedColumns.includes(c)
                            );
                            if (insideSelection) setCell({ row: r, col: c });
                            else chooseCell(r, c);
                            return;
                          }
                          if (event.button !== 0) return;
                          if (event.shiftKey) selectCellRange(r, c);
                          else if (event.ctrlKey || event.metaKey) {
                            focusCell(r, c);
                            selectRow(r, event);
                          }
                          else {
                            focusCell(r, c);
                            cellSelectionAnchor.current = { row: r, col: c };
                            rowSelectionAnchor.current = r;
                            patchTab(tab.id, { selectedRows: [r] });
                          }
                        }}
                        onDoubleClick={() => !removed && startEdit(r, c)}
                        onKeyDown={(e) => {
                          if (editing) return;
                          if (e.key === "F2" || e.key === "Enter") { e.preventDefault(); if (!removed) startEdit(r, c); }
                          if ((e.ctrlKey || e.metaKey) && e.key === "c") { e.preventDefault(); navigator.clipboard.writeText(display(value)).catch((err) => setError(String(err))); }
                        }}>
                        {active && editing ? <div className="relative h-7 w-full text-left">
                          <Input ref={inputRef} aria-label={`编辑 ${col.name}`} value={draft}
                            className="h-7 w-full rounded-none border-0 border-b-2 border-info bg-transparent px-2 py-0 pr-7 text-caption shadow-none focus-visible:border-info focus-visible:ring-0"
                            onChange={(e) => { inputChanged.current = true; setDraft(e.target.value); }} onBlur={commitInline}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); e.currentTarget.blur(); } if (e.key === "Escape") { e.stopPropagation(); cancelEdit.current = true; setEditing(false); } }} />
                          <Button type="button" variant="ghost" size="icon" aria-label={`打开完整编辑器 ${col.name}`}
                            className="absolute right-1 top-1/2 h-5 w-5 -translate-y-1/2 rounded-none p-0 text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={(event) => { event.stopPropagation(); setEditing(false); setExpanded(true); }}>
                            <span aria-hidden="true" className="text-caption font-semibold leading-none tracking-wider">•••</span>
                          </Button>
                        </div> : display(value)}
                      </td>;
                    })}
                  </tr>;
                })}
              </tbody>
            </table>
            {!result.rows.length && <EmptyState title="没有匹配的数据" description="调整筛选条件，或新增一行。" />}
          </ContextMenuTrigger>
          <ContextMenuContent className="max-h-[calc(100vh-2rem)] w-60 overflow-y-auto">
            <ContextMenuLabel>操作</ContextMenuLabel>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!cell} onSelect={() => setColumnViewOpen(true)}><DbIcon name="view" />{operationRows.length > 1 ? `进入列式对比视图（${operationRows.length} 行）` : "进入列式视图"}</ContextMenuItem>
            <ContextMenuItem disabled={!editable} onSelect={() => useDbStore.getState().insertRow(tab.id)}><DbIcon name="add" />添加</ContextMenuItem>
            <ContextMenuItem disabled={!operationRows.length || !editable} onSelect={cloneSelection}><DbIcon name="copy" />克隆数据</ContextMenuItem>
            <ContextMenuItem disabled={!operationRows.length || busy || !canUndoSelection} onSelect={undoSelection}><DbIcon name="undo" />撤销</ContextMenuItem>
            <ContextMenuItem disabled={!operationRows.length || !editable} onSelect={deleteSelection}><DbIcon name="remove" />删除记录</ContextMenuItem>
            <ContextMenuItem disabled={!onRefresh || busy} onSelect={onRefresh}><DbIcon name="refresh" />刷新</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!cell || !onBrowse || busy} onSelect={() => {
              if (!cell || !onBrowse) return;
              const value = valueAt(cell.row, cell.col);
              const filter: TableFilter = { column: result.columns[cell.col].name, operator: value === NULL_MARKER ? "is_null" : "eq", value: value === NULL_MARKER ? "" : value };
              onBrowse({ page: 0, filters: [...browse.filters.filter((item) => item.column !== filter.column), filter] });
            }}><DbIcon name="filter" />填充到筛选条件</ContextMenuItem>
            <ContextMenuSub><ContextMenuSubTrigger disabled={!cell || !editable}><DbIcon name="database" />填充</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onSelect={() => fill("")}>空字符串</ContextMenuItem>
                <ContextMenuItem onSelect={() => fill(NULL_MARKER)}>NULL</ContextMenuItem>
                <ContextMenuItem onSelect={() => fill(DEFAULT_MARKER)}>默认值</ContextMenuItem>
                <ContextMenuItem onSelect={() => cell && startEdit(cell.row, cell.col, true)}>自定义…</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub><ContextMenuSubTrigger disabled={!cell}><DbIcon name="highlight" />行高亮</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onSelect={() => highlightSelection("warning")}>黄色</ContextMenuItem>
                <ContextMenuItem onSelect={() => highlightSelection("success")}>绿色</ContextMenuItem>
                <ContextMenuItem onSelect={() => highlightSelection("destructive")}>红色</ContextMenuItem>
                <ContextMenuItem onSelect={() => highlightSelection()}>清除高亮</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuSub><ContextMenuSubTrigger disabled={!cell}><DbIcon name="copy" />复制为</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuLabel>复制</ContextMenuLabel>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => copyRowAs("where")}>Where 条件</ContextMenuItem>
                <ContextMenuItem onSelect={() => copyRowAs("insert-batch")}>InsertSQL（批量）</ContextMenuItem>
                <ContextMenuItem onSelect={() => copyRowAs("insert")}>InsertSQL</ContextMenuItem>
                <ContextMenuItem disabled={sqlite} onSelect={() => copyRowAs("upsert")}>InsertOnUpdateSQL</ContextMenuItem>
                <ContextMenuItem onSelect={() => copyRowAs("insert-selection")}>InsertSQL（选中区域）</ContextMenuItem>
                <ContextMenuItem onSelect={() => copyRowAs("insert-selection-batch")}>InsertSQL（选中区域＋批量）</ContextMenuItem>
                <ContextMenuItem onSelect={() => copyRowAs("update")}>UpdateSQL</ContextMenuItem>
                <ContextMenuItem onSelect={() => copyRowAs("delete")}>DeleteSQL</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => copyRowAs("headers-data")}>表格文本－字段和数据</ContextMenuItem>
                <ContextMenuItem onSelect={() => copyRowAs("data")}>表格文本－数据</ContextMenuItem>
                <ContextMenuItem onSelect={() => copyRowAs("headers")}>表格文本－字段</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub><ContextMenuSubTrigger disabled={!cell || !editable}><DbIcon name="paste" />粘贴到</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuLabel>粘贴</ContextMenuLabel>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => { void paste("grid"); }}>粘贴</ContextMenuItem>
                <ContextMenuItem onSelect={() => { void paste("text"); }}>仅粘贴文本</ContextMenuItem>
                <ContextMenuItem onSelect={() => { void paste("selection"); }}>粘贴至选中区</ContextMenuItem>
                <ContextMenuItem onSelect={() => { void paste("new"); }}>新建并粘贴</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuSub><ContextMenuSubTrigger disabled={!result.rows.length}><DbIcon name="jump" />跳转行</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onSelect={() => jumpTo(0)}>顶部</ContextMenuItem>
                <ContextMenuItem onSelect={() => jumpTo(result.rows.length - 1)}>底部</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub><ContextMenuSubTrigger disabled={!result.rows.length}><DbIcon name="selectAll" />全选</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuLabel>选择</ContextMenuLabel>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => { setSelectionMode("all"); setSelectedColumns(visible.map((column) => column.index)); patchTab(tab.id, { selectedRows: result.rows.map((_row, index) => index) }); }}>全选</ContextMenuItem>
                <ContextMenuItem onSelect={() => { if (!cell) return; setSelectionMode("row"); setSelectedColumns(visible.map((column) => column.index)); patchTab(tab.id, { selectedRows: [cell.row] }); }}>行全选</ContextMenuItem>
                <ContextMenuItem onSelect={() => { if (!cell) return; setSelectionMode("column"); setSelectedColumns([cell.col]); patchTab(tab.id, { selectedRows: [] }); }}>列全选</ContextMenuItem>
                <ContextMenuItem onSelect={() => { setSelectionMode("cell"); setSelectedColumns([]); setCell(null); patchTab(tab.id, { selectedRows: [] }); }}>取消选择</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub><ContextMenuSubTrigger disabled={!cell}><DbIcon name="lockColumn" />列锁定</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem disabled={cell ? pinnedColumns.includes(result.columns[cell.col].name) : true} onSelect={() => cell && setPinnedColumns((state) => [...state, result.columns[cell.col].name])}>锁定当前列</ContextMenuItem>
                <ContextMenuItem disabled={cell ? !pinnedColumns.includes(result.columns[cell.col].name) : true} onSelect={() => cell && setPinnedColumns((state) => state.filter((name) => name !== result.columns[cell.col].name))}>解锁当前列</ContextMenuItem>
                <ContextMenuItem disabled={!pinnedColumns.length} onSelect={() => setPinnedColumns([])}>全部解锁</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub><ContextMenuSubTrigger disabled={!cell || !onBrowse || busy}><DbIcon name="sort" />排序</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onSelect={() => cell && onBrowse?.({ page: 0, sort: { column: result.columns[cell.col].name, direction: "asc" } })}>升序</ContextMenuItem>
                <ContextMenuItem onSelect={() => cell && onBrowse?.({ page: 0, sort: { column: result.columns[cell.col].name, direction: "desc" } })}>降序</ContextMenuItem>
                <ContextMenuItem disabled={!browse.sort} onSelect={() => onBrowse?.({ page: 0, sort: null })}>清除排序</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuContent>
        </ContextMenu>
      </div>
      <Dialog open={expanded} onOpenChange={(open) => { setExpanded(open); if (!open) setError(null); }}>
        <DialogContent className="flex h-2/3 min-h-96 max-w-5xl flex-col gap-3 p-3">
          <DialogHeader className="shrink-0"><DialogTitle>{cell ? result.columns[cell.col].name : "单元格"}</DialogTitle>
            <DialogDescription>{tab.tableName ?? tab.title} · 第 {cell ? browse.page * browse.pageSize + cell.row + 1 : ""} 行 · {cell ? result.columns[cell.col].data_type : ""}{!editable ? " · 只读" : " · 应用后仍需保存修改"}</DialogDescription></DialogHeader>
          <div className="flex shrink-0 items-center justify-between gap-3">
            <Select aria-label="值类型" className="h-8 w-36 text-caption" value={valueType} disabled={!editable} onValueChange={setValueType}
              options={[{ value: "text", label: "文本值" }, { value: "null", label: "NULL" }, { value: "default", label: "默认值" }]} />
            <div role="tablist" aria-label="内容格式" className="flex items-center rounded-md bg-muted p-0.5">
              {([['text', '文本'], ['json', 'JSON'], ['xml', 'XML'], ['php', 'PHP 序列化']] as const).map(([value, label]) => (
                <Button key={value} type="button" role="tab" aria-selected={format === value} variant="ghost" size="sm"
                  className={cn("h-7 rounded-sm px-3 text-caption font-normal", format === value && "bg-background text-foreground shadow-sm")}
                  onClick={() => setFormat(value)}>{label}</Button>
              ))}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 overflow-hidden border border-border border-t-2 border-t-info bg-editor-surface">
            <div ref={gutterRef} aria-hidden="true" className="w-12 shrink-0 overflow-hidden border-r border-border bg-muted/50 py-2 text-right font-mono text-caption leading-6 text-muted-foreground">
              {Array.from({ length: Math.max(1, draft.split("\n").length) }, (_, index) => <div key={index} className="h-6 pr-3">{index + 1}</div>)}
            </div>
            <Textarea aria-label="完整内容" wrap="off"
              className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-3 py-2 font-mono text-caption leading-6 shadow-none focus-visible:ring-0"
              value={draft} readOnly={!editable || (cell ? result.rows[cell.row]?.[cell.col]?.type === "blob" : false)} disabled={valueType !== "text"}
              onScroll={(event) => { if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop; }}
              onChange={(e) => setDraft(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
          <DialogFooter className="shrink-0"><Button variant="ghost" onClick={() => setExpanded(false)}>取消</Button><Button disabled={!editable || (cell ? result.rows[cell.row]?.[cell.col]?.type === "blob" : false)} onClick={() => { applyValue(valueType === "null" ? NULL_MARKER : valueType === "default" ? DEFAULT_MARKER : draft); setExpanded(false); }}>应用</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={columnViewOpen} onOpenChange={setColumnViewOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader><DialogTitle>{operationRows.length > 1 ? "列式对比视图" : "列式视图"}</DialogTitle>
            <DialogDescription>{tab.tableName ?? tab.title} · {operationRows.length > 1 ? `${operationRows.length} 行` : `第 ${cell ? browse.page * browse.pageSize + cell.row + 1 : ""} 行`}</DialogDescription></DialogHeader>
          <div className="max-h-[60vh] overflow-auto border border-border">
            <table className="min-w-full table-fixed text-caption"><thead><tr className="border-b border-border/50 bg-muted/50"><th className="w-48 px-3 py-2 text-left font-medium">字段</th>{operationRows.map((row) => <th key={row} className="min-w-48 border-l border-border/50 px-3 py-2 text-left font-medium">第 {browse.page * browse.pageSize + row + 1} 行</th>)}</tr></thead><tbody>
              {result.columns.map((column, index) => <tr key={column.name} className="border-b border-border/50 last:border-0">
                <th className="bg-muted/30 px-3 py-2 text-left font-medium" title={column.data_type}>{column.name}</th>
                {operationRows.map((row) => <td key={row} className="select-text break-all border-l border-border/50 px-3 py-2 font-mono">{display(valueAt(row, index))}</td>)}
              </tr>)}
            </tbody></table>
          </div>
          <DialogFooter><Button onClick={() => setColumnViewOpen(false)}>关闭</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

function ColumnFilter({ column, filter, disabled, onApply }: { column: string; filter?: TableFilter; disabled?: boolean; onApply: (filter: TableFilter | null) => void }) {
  const [open, setOpen] = useState(false);
  const [operator, setOperator] = useState<TableFilter["operator"]>(filter?.operator ?? "eq");
  const [value, setValue] = useState(filter?.value ?? "");
  return <DropdownMenu open={open} onOpenChange={(next) => { if (next) { setOperator(filter?.operator ?? "eq"); setValue(filter?.value ?? ""); } setOpen(next); }}>
    <DropdownMenuTrigger asChild><DbToolButton icon="filter" label={`筛选 ${column}`} disabled={disabled} className={cn("h-6 w-6 hover:bg-transparent active:bg-transparent [&>svg]:h-3.5 [&>svg]:w-3.5", filter && "text-info")} /></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-64 p-3" onKeyDown={(e) => e.stopPropagation()}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onApply({ column, operator, value }); setOpen(false); }}>
        <p className="truncate text-caption font-medium">筛选 {column}</p>
        <Select aria-label="筛选条件" value={operator} onValueChange={(v) => setOperator(v as TableFilter["operator"])} options={[{ value: "eq", label: "等于" }, { value: "contains", label: "包含" }, { value: "gt", label: "大于" }, { value: "lt", label: "小于" }, { value: "is_null", label: "为 NULL" }, { value: "not_null", label: "非 NULL" }]} />
        {operator !== "is_null" && operator !== "not_null" && <Input aria-label="筛选值" value={value} onChange={(e) => setValue(e.target.value)} />}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={() => { onApply(null); setOpen(false); }}>清除</Button><Button type="submit" size="sm">应用</Button></div>
      </form>
    </DropdownMenuContent>
  </DropdownMenu>;
}
