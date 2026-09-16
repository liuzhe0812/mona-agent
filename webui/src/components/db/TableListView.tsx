import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DbIcon } from "./DbIcon";
import { TableContextMenu } from "./TableContextMenu";
import { DdlPreviewPopover } from "./DdlPreviewPopover";
import { NewTableDialog } from "./NewTableDialog";
import { TableOperationDialog } from "./TableOperationDialog";
import { useDbStore } from "./store/dbStore";
import * as ipc from "./ipc";
import type { TableSummary } from "./types";

export interface TableListViewProps {
  connectionId: string | null;
  database: string | null;
  objectType?: "table" | "view";
  onOpenTable: (name: string, pinned?: boolean, objectType?: "table" | "view") => void;
  onNewQuery: () => void;
  onCreateTable?: () => void;
  active?: boolean;
}

type SortKey = "name" | "comment" | "row_count" | "data_size" | "index_size" | "auto_increment" | "engine" | "charset" | "update_time" | "create_time";
type SortState = { key: SortKey; direction: "asc" | "desc" };
type TableMenuAction = "open" | "structure" | "create" | "query" | "rename" | "refresh" | "copyDdl" | "truncate" | "drop";
type DdlState = {
  name: string;
  content: string | null;
  loading: boolean;
  error: string | null;
};

const SORT_COLUMNS: Array<{ key: SortKey; label: string; align?: "right" }> = [
  { key: "name", label: "名称" },
  { key: "comment", label: "注释" },
  { key: "row_count", label: "估算行", align: "right" },
  { key: "data_size", label: "数据长度", align: "right" },
  { key: "index_size", label: "索引长度", align: "right" },
  { key: "auto_increment", label: "自增", align: "right" },
  { key: "engine", label: "引擎" },
  { key: "charset", label: "编码" },
  { key: "update_time", label: "更新时间" },
  { key: "create_time", label: "创建时间" },
];

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "加载对象列表失败";
}

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString();
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let unitIndex = -1;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = amount >= 10 || Number.isInteger(amount) ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function displayText(value: string | null): string {
  return value?.trim() ? value : "—";
}

function displayField(row: TableSummary, key: SortKey): string {
  if (key === "data_size" || key === "index_size") return formatBytes(row[key]);
  if (key === "row_count" || key === "auto_increment") return formatNumber(row[key]);
  return displayText(row[key]);
}

function rowKey(row: TableSummary): string {
  return `${row.object_type}:${row.name}`;
}

function compareRows(a: TableSummary, b: TableSummary, key: SortKey): number {
  const aValue = a[key];
  const bValue = b[key];

  if (aValue === null && bValue === null) return 0;
  if (aValue === null) return 1;
  if (bValue === null) return -1;
  if (typeof aValue === "number" && typeof bValue === "number") return aValue - bValue;
  return String(aValue).localeCompare(String(bValue), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function ToolbarIconButton({
  label,
  icon,
  disabled,
  onClick,
  showLabel = false,
  pressed,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
  showLabel?: boolean;
  pressed?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={showLabel ? "sm" : "icon"}
          className={cn("h-8 shrink-0 gap-2 text-caption", !showLabel && "w-8", pressed && "bg-accent text-info")}
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
        >
          {icon}
          {showLabel && <span>{label}</span>}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function TableStatus({
  role,
  children,
  action,
}: {
  role?: "status" | "alert";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex h-full min-h-32 items-center justify-center gap-2 px-4 text-caption text-muted-foreground"
      role={role}
    >
      <span>{children}</span>
      {action ? <span>{action}</span> : null}
    </div>
  );
}

function TableListRow({
  row,
  selected,
  onSelect,
  onOpen,
  onAction,
  connectionId,
  database,
  onRefresh,
  grid = false,
}: {
  row: TableSummary;
  selected: boolean;
  onSelect: (event: MouseEvent | KeyboardEvent) => void;
  onOpen: () => void;
  onAction: (action: TableMenuAction) => void;
  connectionId: string;
  database: string;
  onRefresh: (newName?: string) => void;
  grid?: boolean;
}) {
  const objectLabel = row.object_type === "view" ? "视图" : "表";

  return (
    <TableContextMenu connectionId={connectionId} database={database} table={row.name}
      objectType={row.object_type} onOpen={onOpen} onRefresh={onRefresh}>
        {grid ? <Button
          role="option" aria-selected={selected} aria-label={row.name} variant="ghost"
          className={cn("h-20 w-full justify-start gap-3 rounded-sm px-3 text-left", selected && "bg-accent ring-1 ring-inset ring-info")}
          onClick={onSelect} onDoubleClick={onOpen} onContextMenu={onSelect}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); onOpen(); }
            if (event.key === "F2" && row.object_type === "table") { event.preventDefault(); event.stopPropagation(); onAction("rename"); }
          }}>
          <DbIcon name={row.object_type} className="h-7 w-7" />
          <span className="min-w-0"><span className="block truncate text-caption" title={row.name}>{row.name}</span><span className="block truncate text-caption font-normal text-muted-foreground">{row.comment || `${formatNumber(row.row_count)} 行`}</span></span>
        </Button> : <tr
          tabIndex={0}
          aria-selected={selected}
          className={cn(
            "group h-8 cursor-default outline-none transition-colors hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            selected ? "bg-accent text-foreground" : "odd:bg-muted/30",
          )}
          onClick={onSelect}
          onDoubleClick={onOpen}
          onContextMenu={onSelect}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onOpen();
            } else if (event.key === " ") {
              event.preventDefault();
              onSelect(event);
            } else if (event.key === "F2" && row.object_type === "table") {
              event.preventDefault(); event.stopPropagation(); onAction("rename");
            }
          }}
        >
          <td
            className={cn(
              "border-l-2 py-1 pl-2 pr-3 text-left",
              selected ? "border-info" : "border-transparent",
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <DbIcon name={row.object_type} className="h-4 w-4" />
              <span className="sr-only">{objectLabel} </span>
              <span className="truncate" title={row.name}>
                {row.name}
              </span>
            </div>
          </td>
          {SORT_COLUMNS.slice(1).map((column) => <td key={column.key} className={cn("truncate whitespace-nowrap px-3 py-1 tabular-nums", column.align === "right" ? "text-right" : "text-left")} title={displayField(row, column.key)}>{displayField(row, column.key)}</td>)}
        </tr>}
    </TableContextMenu>
  );
}

export function TableListView({
  connectionId,
  database,
  objectType,
  onOpenTable,
  onNewQuery,
  onCreateTable,
  active = true,
}: TableListViewProps) {
  const connectionTree = useDbStore((state) => connectionId ? state.connectionTree[connectionId] : undefined);
  const [rows, setRows] = useState<TableSummary[]>([]);
  const [search, setSearch] = useState("");
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const selectionAnchor = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [layout, setLayout] = useState<"list" | "grid">("list");
  const [ddlOpen, setDdlOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [operation, setOperation] = useState<{ row: TableSummary; action: "rename" | "truncate" | "drop"; connectionId: string; database: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [ddlState, setDdlState] = useState<DdlState | null>(null);
  const requestVersionRef = useRef(0);
  const ddlRequestVersionRef = useRef(0);
  const hasContext = Boolean(connectionId && database);

  useEffect(() => {
    setSearch("");
    setSortState(null);
    setSelectedKeys([]);
    selectionAnchor.current = null;
    setCreateOpen(false);
    setOperation(null);
    setActionError(null);
    setDdlState(null);
    ddlRequestVersionRef.current += 1;
  }, [connectionId, database]);

  useEffect(() => {
    const requestVersion = ++requestVersionRef.current;
    let cancelled = false;

    setRows([]);
    setError(null);
    setLoading(hasContext);

    if (!connectionId || !database) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const nextRows = await ipc.dbGetTableSummaries(connectionId, database);
        if (cancelled || requestVersion !== requestVersionRef.current) return;
        setRows(nextRows);
        setLoading(false);
      } catch (requestError) {
        if (cancelled || requestVersion !== requestVersionRef.current) return;
        setError(getErrorMessage(requestError));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connectionId, database, hasContext, refreshVersion, connectionTree]);

  const handleRefresh = useCallback(() => {
    requestVersionRef.current += 1;
    setRefreshVersion((version) => version + 1);
  }, []);

  const handleSort = useCallback((key: SortKey) => {
    setSortState((current) => {
      if (current?.key === key) {
        return current.direction === "asc" ? { key, direction: "desc" } : null;
      }
      return { key, direction: "asc" };
    });
  }, []);

  const typedRows = useMemo(
    () => rows.filter((row) => !objectType || row.object_type === objectType),
    [objectType, rows],
  );

  const visibleRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = query
      ? typedRows.filter((row) => `${row.name}\n${row.comment ?? ""}`.toLocaleLowerCase().includes(query))
      : typedRows;

    if (!sortState) return filtered;
    return [...filtered].sort((a, b) => {
      const result = compareRows(a, b, sortState.key);
      return sortState.direction === "asc" ? result : -result;
    });
  }, [search, sortState, typedRows]);

  const selectedRows = visibleRows.filter((row) => selectedKeys.includes(rowKey(row)));
  const ddlRow = visibleRows.find((row) => rowKey(row) === selectedKeys[selectedKeys.length - 1]);

  function selectRow(row: TableSummary, event: MouseEvent | KeyboardEvent) {
    const key = rowKey(row);
    if (event.type === "contextmenu") { setSelectedKeys([key]); selectionAnchor.current = key; return; }
    const keys = visibleRows.map(rowKey);
    const start = keys.indexOf(selectionAnchor.current ?? "");
    if (event.shiftKey && start >= 0) {
      const end = keys.indexOf(key);
      setSelectedKeys(keys.slice(Math.min(start, end), Math.max(start, end) + 1));
    } else {
      setSelectedKeys((current) => event.ctrlKey || event.metaKey ? current.includes(key) ? current.filter((item) => item !== key) : [...current, key] : [key]);
      selectionAnchor.current = key;
    }
  }

  const handleCreate = useCallback(() => onCreateTable ? onCreateTable() : setCreateOpen(true), [onCreateTable]);

  const handleRowAction = useCallback(async (row: TableSummary, action: TableMenuAction) => {
    if (!connectionId || !database) return;
    setActionError(null);
    try {
      switch (action) {
        case "open": onOpenTable(row.name, true, row.object_type); break;
        case "structure": await useDbStore.getState().openTableStructure(connectionId, database, row.name); break;
        case "create": handleCreate(); break;
        case "query": onNewQuery(); break;
        case "refresh": handleRefresh(); break;
        case "rename": case "truncate": case "drop": setOperation({ row, action, connectionId, database }); break;
        case "copyDdl": {
          const info = await ipc.dbGetTableInfo(connectionId, database, row.name);
          if (!info.ddl?.trim()) throw new Error("未返回对象定义，无法复制。");
          if (!navigator.clipboard?.writeText) throw new Error("当前环境不支持复制到剪贴板。");
          await navigator.clipboard.writeText(info.ddl);
          break;
        }
      }
    } catch (reason) { setActionError(getErrorMessage(reason)); }
  }, [connectionId, database, handleCreate, handleRefresh, onNewQuery, onOpenTable]);

  useEffect(() => {
    if (!active || !hasContext) return;
    const shortcuts = (event: globalThis.KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]:not([data-state="closed"]),[role="alertdialog"]:not([data-state="closed"])')) return;
      const key = event.key.toLowerCase();
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && key === "f") { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
      else if (modifier && event.shiftKey && key === "t") { event.preventDefault(); handleCreate(); }
      else if (modifier && event.shiftKey && key === "q") { event.preventDefault(); onNewQuery(); }
      else if (key === "f5") { event.preventDefault(); handleRefresh(); }
      else if (key === "f2" && selectedRows.length === 1 && selectedRows[0].object_type === "table" && !(event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]'))) {
        event.preventDefault(); void handleRowAction(selectedRows[0], "rename");
      }
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [active, hasContext, handleCreate, handleRefresh, onNewQuery, selectedRows, handleRowAction]);

  useEffect(() => {
      const requestVersion = ++ddlRequestVersionRef.current;
      if (!ddlOpen || !ddlRow || !connectionId || !database) { setDdlState(null); return; }
      const name = ddlRow.name;
      setDdlState({ name, content: null, loading: true, error: null });

      void (async () => {
        try {
          const tableInfo = await ipc.dbGetTableInfo(connectionId, database, name);
          if (requestVersion !== ddlRequestVersionRef.current) return;
          setDdlState((current) =>
            current?.name === name
              ? { ...current, content: tableInfo.ddl, loading: false }
              : current,
          );
        } catch (requestError) {
          if (requestVersion !== ddlRequestVersionRef.current) return;
          setDdlState((current) =>
            current?.name === name
              ? { ...current, error: getErrorMessage(requestError), loading: false }
              : current,
          );
        }
      })();
      return () => { ddlRequestVersionRef.current += 1; };
  }, [connectionId, database, ddlOpen, ddlRow?.name, refreshVersion]);

  const emptyMessage = !hasContext
    ? "请选择连接和数据库"
    : search.trim()
      ? "没有匹配的对象"
      : objectType === "view"
        ? "当前数据库没有视图"
        : objectType === "table"
          ? "当前数据库没有表"
          : "当前数据库没有表或视图";

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden text-caption" data-testid="table-list-view"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !(event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]'))) {
          event.preventDefault(); setSelectedKeys(visibleRows.map(rowKey));
        }
      }}>
      <TooltipProvider delayDuration={200}>
        <div
          className="flex h-10 min-w-0 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-b border-border/60 px-2"
          role="toolbar"
          aria-label="对象工具栏"
        >
          <div className="flex shrink-0 items-center gap-1">
            <ToolbarIconButton
              label="新建查询"
              icon={<DbIcon name="query" className="text-success" />}
              disabled={!hasContext}
              onClick={onNewQuery}
              showLabel
            />
              <ToolbarIconButton
                label="新建"
                icon={<DbIcon name="newTable" className="text-info" />}
                disabled={!hasContext || objectType === "view"}
                onClick={handleCreate}
                showLabel
              />
            <ToolbarIconButton
              label="刷新"
              icon={<DbIcon name="refreshTable" className="text-info" />}
              disabled={!hasContext}
              onClick={handleRefresh}
              showLabel
            />
          </div>
          <span className="flex-1 text-center tabular-nums" data-testid="table-list-selection">已选择 {selectedRows.length} 项，共 {visibleRows.length} 项</span>
          <div className="flex shrink-0 items-center gap-1" role="group" aria-label="显示方式">
            <ToolbarIconButton label="列表视图" icon={<DbIcon name="list" />} disabled={false} pressed={layout === "list"} onClick={() => setLayout("list")} />
            <ToolbarIconButton label="网格视图" icon={<DbIcon name="grid" />} disabled={false} pressed={layout === "grid"} onClick={() => setLayout("grid")} />
          </div>
          <span className="h-5 w-px shrink-0 bg-border" />
          <div className="relative w-48 shrink-0">
            <DbIcon name="search" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-7 pl-7 pr-2 text-caption"
              placeholder="名称/注释筛选 (Ctrl+F)"
              aria-label="搜索名称或注释"
              disabled={!hasContext}
            />
          </div>
          <ToolbarIconButton label="DDL" icon={<DbIcon name={ddlOpen ? "eye" : "eyeOff"} />} disabled={!hasContext} pressed={ddlOpen} showLabel onClick={() => setDdlOpen((open) => !open)} />
        </div>
      </TooltipProvider>
      {actionError && <p role="alert" className="shrink-0 px-3 py-2 text-caption text-destructive">{actionError}</p>}

      <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="scrollbar-thin scrollbar-track-transparent min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain" data-testid="table-list-body">
        {loading ? (
          <TableStatus role="status">正在加载对象…</TableStatus>
        ) : error ? (
          <TableStatus
            role="alert"
            action={
              <Button type="button" variant="ghost" size="xs" onClick={handleRefresh}>
                重试
              </Button>
            }
          >
            {error}
          </TableStatus>
        ) : visibleRows.length === 0 ? (
          <TableStatus>{emptyMessage}</TableStatus>
        ) : layout === "grid" ? (
          <div role="listbox" aria-label="对象网格" aria-multiselectable className="grid grid-cols-2 gap-1 p-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleRows.map((row) => <TableListRow key={rowKey(row)} row={row} grid selected={selectedKeys.includes(rowKey(row))}
              connectionId={connectionId!} database={database!}
              onSelect={(event) => selectRow(row, event)} onOpen={() => onOpenTable(row.name, true, row.object_type)}
              onAction={(action) => { void handleRowAction(row, action); }}
              onRefresh={(newName) => { if (newName) setSelectedKeys([`table:${newName}`]); handleRefresh(); }} />)}
          </div>
        ) : (
          <table className="w-full table-fixed border-collapse" style={{ minWidth: 1280 }} aria-label="对象列表">
            <colgroup>{SORT_COLUMNS.map((column) => <col key={column.key} style={{ width: column.key === "name" ? 240 : column.key.endsWith("time") ? 168 : column.key === "comment" ? 160 : 105 }} />)}</colgroup>
            <thead className="sticky top-0 z-10 bg-muted">
              <tr className="h-8 border-b border-border">
                {SORT_COLUMNS.map((column) => {
                  const active = sortState?.key === column.key;
                  const direction = active ? sortState.direction : null;
                  const sortLabel = active
                    ? `按${column.label}排序，当前${direction === "asc" ? "升序" : "降序"}`
                    : `按${column.label}排序`;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-label={column.label}
                      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
                      className={cn(
                        "px-0 text-left text-caption font-medium text-muted-foreground",
                        column.align === "right" && "text-right",
                      )}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={cn(
                          "h-8 w-full justify-between gap-1 rounded-none px-3 text-caption font-medium text-muted-foreground hover:text-foreground",
                        )}
                        aria-label={sortLabel}
                        onClick={() => handleSort(column.key)}
                      >
                        <span>{column.label}</span>
                        <DbIcon name={direction === "asc" ? "sortAsc" : direction === "desc" ? "sortDesc" : "sort"} className={cn("h-3.5 w-3.5", active ? "text-foreground" : "opacity-50")} />
                      </Button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <TableListRow
                  key={rowKey(row)}
                  row={row}
                  selected={selectedKeys.includes(rowKey(row))}
                  connectionId={connectionId!}
                  database={database!}
                  onSelect={(event) => selectRow(row, event)}
                  onOpen={() => onOpenTable(row.name, true, row.object_type)}
                  onAction={(action) => { void handleRowAction(row, action); }}
                  onRefresh={(newName) => { if (newName) setSelectedKeys([`table:${newName}`]); handleRefresh(); }}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
      </div>
      <DdlPreviewPopover open={ddlOpen} title={ddlState ? `${ddlState.name} · DDL` : "DDL"} sql={ddlState?.content}
        loading={ddlState?.loading} error={ddlState?.error} onClose={() => setDdlOpen(false)} />
      {createOpen && connectionId && database && <NewTableDialog key={`${connectionId}:${database}`} connectionId={connectionId} database={database} onClose={() => setCreateOpen(false)} onCreated={handleRefresh} />}
      {operation && <TableOperationDialog context={{ connectionId: operation.connectionId, database: operation.database, table: operation.row.name, objectType: operation.row.object_type, operation: operation.action }} onClose={() => setOperation(null)} onDone={(newName) => { setSelectedKeys(newName ? [`table:${newName}`] : []); handleRefresh(); }} />}
    </div>
  );
}

export default TableListView;
