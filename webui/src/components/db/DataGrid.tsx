import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DbToolButton } from "./DbToolButton";
import { useDbStore } from "./store/dbStore";
import { DEFAULT_BROWSE, canEditTable } from "./table-sql";
import { displayCellValue, NULL_MARKER, DEFAULT_MARKER, type QueryTab, type TableBrowse, type TableFilter } from "./types";

export function DataGrid({ tab, onBrowse }: { tab: QueryTab; onBrowse?: (patch: Partial<TableBrowse>) => void }) {
  const patchTab = useDbStore((s) => s.patchTab);
  const [cell, setCell] = useState<{ row: number; col: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [valueType, setValueType] = useState("text");
  const [format, setFormat] = useState("text");
  const [error, setError] = useState<string | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const resize = useRef<{ name: string; x: number; width: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelEdit = useRef(false);
  const inputChanged = useRef(false);
  const busy = tab.isExecuting || tab.isSaving || tab.isLoadingMetadata;
  const editable = canEditTable(tab) && !busy;
  const result = tab.result;
  const rows = tab.selectedRows ?? [];
  const browse = tab.browse ?? DEFAULT_BROWSE;
  const visible = result?.columns.map((col, index) => ({ ...col, index })).filter((col) => !tab.hiddenColumns?.includes(col.name)) ?? [];
  const valueAt = (r: number, c: number) => {
    const edit = tab.edits.find((e) => e.rowIdx === r && e.colIdx === c);
    if (edit) return edit.newValue;
    const value = result!.rows[r][c];
    return value.type === "null" ? NULL_MARKER : displayCellValue(value);
  };
  const display = (value: string) => value === NULL_MARKER ? "NULL" : value === DEFAULT_MARKER ? "DEFAULT" : value;

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
    if (forceExpanded || !editable || result!.rows[r][c].type === "blob" || value.length > 120 || value.includes("\n") || /^[{[]/.test(value.trim())) setExpanded(true);
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
  function chooseCell(r: number, c: number) {
    setCell({ row: r, col: c });
    patchTab(tab.id, { selectedRows: [r] });
  }

  if (!result) return <EmptyState className="flex-1" title={tab.isLoadingMetadata ? "正在读取表结构" : tab.isExecuting ? "正在读取数据" : "尚无结果"} />;
  return (
    <TooltipProvider delayDuration={250}>
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto bg-background" aria-busy={busy}>
        {error && !expanded && <p role="alert" className="p-2 text-caption text-destructive">{error}</p>}
        <ContextMenu>
          <ContextMenuTrigger className="block min-h-full">
            <table className="min-w-full table-fixed border-collapse text-caption" style={{ width: visible.reduce((sum, col) => sum + (widths[col.name] ?? 180), 0) + 68 }}>
              <colgroup><col style={{ width: 28 }} /><col style={{ width: 40 }} />{visible.map((col) => <col key={col.name} style={{ width: widths[col.name] ?? 180 }} />)}</colgroup>
              <thead>
                <tr className="h-8">
                  <th className="sticky top-0 z-10 border-b border-r border-border bg-muted px-1">
                    <Checkbox className="rounded-xs border-border" aria-label="选择当前页所有行" checked={result.rows.length > 0 && rows.length === result.rows.length}
                      onCheckedChange={(checked) => patchTab(tab.id, { selectedRows: checked ? result.rows.map((_, i) => i) : [] })} />
                  </th>
                  <th className="sticky top-0 z-10 border-b border-r border-border bg-muted px-2 font-normal text-muted-foreground">#</th>
                  {visible.map((col) => <th key={col.name} aria-sort={browse.sort?.column === col.name ? browse.sort.direction === "asc" ? "ascending" : "descending" : "none"}
                    className="sticky top-0 z-10 h-8 border-b border-r border-border bg-muted px-2 text-left font-medium">
                    <div className="flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate" title={col.data_type}>{col.name}</span>
                      {onBrowse && <>
                        <ColumnFilter column={col.name} filter={browse.filters.find((f) => f.column === col.name)} disabled={busy}
                          onApply={(filter) => onBrowse({ page: 0, filters: [...browse.filters.filter((f) => f.column !== col.name), ...(filter ? [filter] : [])] })} />
                        <DbToolButton icon={browse.sort?.column === col.name ? browse.sort.direction === "asc" ? "sortAsc" : "sortDesc" : "sort"} label={`排序 ${col.name}`} className={cn("h-8 w-8", browse.sort?.column === col.name && "text-info")}
                          disabled={busy} onClick={() => onBrowse({ page: 0, sort: browse.sort?.column !== col.name ? { column: col.name, direction: "asc" } : browse.sort.direction === "asc" ? { column: col.name, direction: "desc" } : null })} />
                      </>}
                    </div>
                    <div role="separator" aria-label={`调整 ${col.name} 列宽`} aria-orientation="vertical" tabIndex={0}
                      className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-info/30 focus-visible:bg-info/30"
                      onMouseDown={(e) => { e.preventDefault(); resize.current = { name: col.name, x: e.clientX, width: widths[col.name] ?? 180 }; }}
                      onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setWidths((old) => ({ ...old, [col.name]: Math.max(100, (old[col.name] ?? 180) + (e.key === "ArrowRight" ? 20 : -20)) })); } }} />
                  </th>)}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, r) => {
                  const removed = tab.deletedRows?.includes(r);
                  const inserted = tab.insertedRows.includes(r);
                  return <tr key={r} data-row-index={r} className={cn("h-7 border-b border-border/40 hover:bg-accent/50", !rows.includes(r) && !inserted && "odd:bg-muted/20", rows.includes(r) && "bg-accent", removed && "text-muted-foreground line-through", inserted && "bg-success/5")}>
                    <td className="border-r border-border/40 px-1 text-center"><Checkbox className="rounded-xs border-border" aria-label={`选择第 ${r + 1} 行`} checked={rows.includes(r)}
                      onCheckedChange={(checked) => patchTab(tab.id, { selectedRows: checked ? [...rows, r] : rows.filter((i) => i !== r) })} /></td>
                    <td className="border-r border-border/40 px-2 text-right text-muted-foreground">{inserted ? "+" : browse.page * browse.pageSize + r + 1}</td>
                    {visible.map((col) => {
                      const c = col.index;
                      const value = valueAt(r, c);
                      const active = cell?.row === r && cell.col === c;
                      const dirty = tab.edits.some((e) => e.rowIdx === r && e.colIdx === c);
                      return <td key={col.name} tabIndex={0} title={display(value)}
                        className={cn("h-7 truncate border-r border-border/40 px-2 py-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring", active && "ring-1 ring-inset ring-info/50", dirty && "bg-warning/15", value === NULL_MARKER && "italic text-muted-foreground", (row[c].type === "integer" || row[c].type === "float") && "text-right")}
                        onClick={() => chooseCell(r, c)} onPointerDown={(e) => { if (e.button === 2) chooseCell(r, c); }}
                        onDoubleClick={() => !removed && startEdit(r, c)}
                        onKeyDown={(e) => {
                          if (editing) return;
                          if (e.key === "F2" || e.key === "Enter") { e.preventDefault(); if (!removed) startEdit(r, c); }
                          if ((e.ctrlKey || e.metaKey) && e.key === "c") { e.preventDefault(); navigator.clipboard.writeText(display(value)).catch((err) => setError(String(err))); }
                        }}>
                        {active && editing ? <Input ref={inputRef} aria-label={`编辑 ${col.name}`} value={draft}
                          className="h-6 rounded-none px-1 text-caption" onChange={(e) => { inputChanged.current = true; setDraft(e.target.value); }} onBlur={commitInline}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); e.currentTarget.blur(); } if (e.key === "Escape") { e.stopPropagation(); cancelEdit.current = true; setEditing(false); } }} /> : display(value)}
                      </td>;
                    })}
                  </tr>;
                })}
              </tbody>
            </table>
            {!result.rows.length && <EmptyState title="没有匹配的数据" description="调整筛选条件，或新增一行。" />}
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem disabled={!cell} onClick={() => cell && navigator.clipboard.writeText(display(valueAt(cell.row, cell.col))).catch((err) => setError(String(err)))}>复制单元格</ContextMenuItem>
            <ContextMenuItem disabled={!cell} onClick={() => cell && startEdit(cell.row, cell.col, true)}>查看 / 编辑完整内容</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!cell || !editable} onClick={() => applyValue(NULL_MARKER)}>设置为 NULL</ContextMenuItem>
            <ContextMenuItem disabled={!cell || !editable} onClick={() => applyValue("")}>设置为空字符串</ContextMenuItem>
            <ContextMenuItem disabled={!cell || !editable} onClick={() => applyValue(DEFAULT_MARKER)}>设置为默认值</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>{cell ? result.columns[cell.col].name : "单元格"}</DialogTitle>
            <DialogDescription>{tab.tableName ?? tab.title} · 第 {cell ? browse.page * browse.pageSize + cell.row + 1 : ""} 行 · {cell ? result.columns[cell.col].data_type : ""}{!editable ? " · 只读" : " · 应用后仍需保存修改"}</DialogDescription></DialogHeader>
          <div className="flex gap-2">
            <Select aria-label="值类型" className="w-36" value={valueType} disabled={!editable} onValueChange={setValueType}
              options={[{ value: "text", label: "文本" }, { value: "null", label: "NULL" }, { value: "default", label: "默认值" }]} />
            <Select aria-label="内容格式" className="w-36" value={format} onValueChange={setFormat} options={[{ value: "text", label: "文本" }, { value: "json", label: "JSON" }]} />
            {format === "json" && <Button variant="ghost" onClick={() => { try { setDraft(JSON.stringify(JSON.parse(draft), null, 2)); setError(null); } catch { setError("内容不是有效的 JSON，原文已保留。"); } }}>格式化</Button>}
          </div>
          <Textarea aria-label="完整内容" className="h-80 resize-y font-mono text-caption" value={draft} readOnly={!editable || (cell ? result.rows[cell.row]?.[cell.col]?.type === "blob" : false)} disabled={valueType !== "text"} onChange={(e) => setDraft(e.target.value)} />
          {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
          <DialogFooter><Button variant="ghost" onClick={() => setExpanded(false)}>取消</Button><Button disabled={!editable || (cell ? result.rows[cell.row]?.[cell.col]?.type === "blob" : false)} onClick={() => { applyValue(valueType === "null" ? NULL_MARKER : valueType === "default" ? DEFAULT_MARKER : draft); setExpanded(false); }}>应用</Button></DialogFooter>
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
    <DropdownMenuTrigger asChild><DbToolButton icon="filter" label={`筛选 ${column}`} disabled={disabled} className={cn("h-8 w-8", filter && "text-info")} /></DropdownMenuTrigger>
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
