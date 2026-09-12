import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DbIcon } from "./DbIcon";
import * as ipc from "./ipc";
import type { TableSummary } from "./types";

export interface TableListViewProps {
  connectionId: string | null;
  database: string | null;
  objectType?: "table" | "view";
  onOpenTable: (name: string, pinned?: boolean, objectType?: "table" | "view") => void;
  onNewQuery: () => void;
  onCreateTable?: () => void;
}

type SortKey = "name" | "comment" | "row_count" | "data_size" | "update_time";
type SortState = { key: SortKey; direction: "asc" | "desc" };
type DdlState = {
  name: string;
  content: string | null;
  loading: boolean;
  error: string | null;
};

const SORT_COLUMNS: Array<{ key: SortKey; label: string; align?: "right" }> = [
  { key: "name", label: "名称" },
  { key: "comment", label: "注释" },
  { key: "row_count", label: "估算行数", align: "right" },
  { key: "data_size", label: "数据大小", align: "right" },
  { key: "update_time", label: "更新时间" },
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

function displayDate(value: string | null): string {
  return value?.trim() ? value : "—";
}

function rowKey(row: TableSummary): string {
  return `${row.object_type}:${row.name}`;
}

function compareRows(a: TableSummary, b: TableSummary, key: SortKey): number {
  let aValue: string | number | null;
  let bValue: string | number | null;

  switch (key) {
    case "name":
      aValue = a.name;
      bValue = b.name;
      break;
    case "comment":
      aValue = a.comment;
      bValue = b.comment;
      break;
    case "row_count":
      aValue = a.row_count;
      bValue = b.row_count;
      break;
    case "data_size":
      aValue = a.data_size;
      bValue = b.data_size;
      break;
    case "update_time":
      aValue = a.update_time;
      bValue = b.update_time;
      break;
  }

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
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {icon}
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
  onViewDdl,
  onCopy,
}: {
  row: TableSummary;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onViewDdl: () => void;
  onCopy: () => void;
}) {
  const objectLabel = row.object_type === "view" ? "视图" : "表";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          tabIndex={0}
          aria-selected={selected}
          className={cn(
            "group h-8 cursor-default border-b border-border/60 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50",
            selected && "bg-accent/40",
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
              onSelect();
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
          <td className="max-w-72 truncate px-3 py-1 text-left text-muted-foreground" title={row.comment ?? undefined}>
            {displayText(row.comment)}
          </td>
          <td className="whitespace-nowrap px-3 py-1 text-right tabular-nums">
            {formatNumber(row.row_count)}
          </td>
          <td className="whitespace-nowrap px-3 py-1 text-right tabular-nums">
            {formatBytes(row.data_size)}
          </td>
          <td className="whitespace-nowrap px-3 py-1 text-left text-muted-foreground">
            {displayDate(row.update_time)}
          </td>
        </tr>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onSelect={onOpen}>
          <DbIcon name="query" className="h-3.5 w-3.5" />
          打开数据
        </ContextMenuItem>
        <ContextMenuItem onSelect={onViewDdl}>
          <DbIcon name="ddl" className="h-3.5 w-3.5" />
          查看DDL
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCopy}>
          <DbIcon name="copy" className="h-3.5 w-3.5" />
          复制名称
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function TableListView({
  connectionId,
  database,
  objectType,
  onOpenTable,
  onNewQuery,
  onCreateTable,
}: TableListViewProps) {
  const [rows, setRows] = useState<TableSummary[]>([]);
  const [search, setSearch] = useState("");
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
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
    setSelectedKey(null);
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
  }, [connectionId, database, hasContext, refreshVersion]);

  const handleRefresh = useCallback(() => {
    requestVersionRef.current += 1;
    setRefreshVersion((version) => version + 1);
  }, []);

  const handleSort = useCallback((key: SortKey) => {
    setSortState((current) => {
      if (current?.key === key) {
        return { key, direction: current.direction === "asc" ? "desc" : "asc" };
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

  const handleViewDdl = useCallback(
    (row: TableSummary) => {
      if (!connectionId || !database) return;
      const requestVersion = ++ddlRequestVersionRef.current;
      setDdlState({ name: row.name, content: null, loading: true, error: null });

      void (async () => {
        try {
          const tableInfo = await ipc.dbGetTableInfo(connectionId, database, row.name);
          if (requestVersion !== ddlRequestVersionRef.current) return;
          setDdlState((current) =>
            current?.name === row.name
              ? { ...current, content: tableInfo.ddl, loading: false }
              : current,
          );
        } catch (requestError) {
          if (requestVersion !== ddlRequestVersionRef.current) return;
          setDdlState((current) =>
            current?.name === row.name
              ? { ...current, error: getErrorMessage(requestError), loading: false }
              : current,
          );
        }
      })();
    },
    [connectionId, database],
  );

  const handleCopy = useCallback((name: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(name);
  }, []);

  const emptyMessage = !hasContext
    ? "请选择连接和数据库"
    : search.trim()
      ? "没有匹配的对象"
      : objectType === "view"
        ? "当前数据库没有视图"
        : objectType === "table"
          ? "当前数据库没有表"
          : "当前数据库没有表或视图";

  const footerText = !hasContext
    ? "共 0 个对象"
    : search.trim() || objectType
      ? `显示 ${visibleRows.length} / ${typedRows.length} 个对象`
      : `共 ${rows.length} 个对象`;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden text-caption" data-testid="table-list-view">
      <TooltipProvider delayDuration={200}>
        <div
          className="flex h-8 shrink-0 items-center justify-between border-b border-border/60 bg-muted/20 px-2"
          role="toolbar"
          aria-label="对象工具栏"
        >
          <div className="flex items-center gap-1">
            <ToolbarIconButton
              label="新建查询"
              icon={<DbIcon name="query" />}
              disabled={!hasContext}
              onClick={onNewQuery}
            />
            {onCreateTable ? (
              <ToolbarIconButton
                label="新建表"
                icon={<DbIcon name="add" />}
                disabled={!hasContext}
                onClick={onCreateTable}
              />
            ) : null}
            <ToolbarIconButton
              label="刷新"
              icon={<DbIcon name="refresh" />}
              disabled={!hasContext}
              onClick={handleRefresh}
            />
          </div>
          <div className="relative w-56 shrink-0">
            <DbIcon name="search" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-7 pl-7 pr-2 text-caption"
              placeholder="搜索名称或注释"
              aria-label="搜索名称或注释"
              disabled={!hasContext}
            />
          </div>
        </div>
      </TooltipProvider>

      <div className="min-h-0 flex-1 overflow-auto" data-testid="table-list-body">
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
        ) : (
          <table className="w-full min-w-[44rem] border-collapse" aria-label="对象列表">
            <thead className="sticky top-0 z-10 bg-background">
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
                          "h-7 w-full justify-start gap-1 rounded-none px-3 text-caption font-medium text-muted-foreground hover:text-foreground",
                          column.align === "right" && "justify-end text-right",
                        )}
                        aria-label={sortLabel}
                        onClick={() => handleSort(column.key)}
                      >
                        <span>{column.label}</span>
                        <DbIcon name="sort" className={cn("h-3.5 w-3.5", active ? "text-foreground" : "opacity-50")} />
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
                  selected={selectedKey === rowKey(row)}
                  onSelect={() => setSelectedKey(rowKey(row))}
                  onOpen={() => onOpenTable(row.name, true, row.object_type)}
                  onViewDdl={() => handleViewDdl(row)}
                  onCopy={() => handleCopy(row.name)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div
        className="flex h-7 shrink-0 items-center border-t border-border/60 bg-muted/20 px-3 text-micro text-muted-foreground"
        data-testid="table-list-footer"
      >
        {footerText}
      </div>

      <Dialog
        open={ddlState !== null}
        onOpenChange={(open) => {
          if (!open) {
            ddlRequestVersionRef.current += 1;
            setDdlState(null);
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{ddlState ? `${ddlState.name} · DDL` : "DDL"}</DialogTitle>
            <DialogDescription className="sr-only">只读查看对象定义</DialogDescription>
          </DialogHeader>
          {ddlState?.loading ? (
            <div className="flex min-h-32 items-center justify-center text-caption text-muted-foreground" role="status">
              正在加载 DDL…
            </div>
          ) : ddlState?.error ? (
            <div className="min-h-32 text-caption text-destructive" role="alert">
              {ddlState.error}
            </div>
          ) : (
            <pre className="max-h-[60vh] min-h-32 overflow-auto whitespace-pre-wrap break-words border border-border/60 bg-muted/20 p-3 font-mono text-caption">
              {ddlState?.content?.trim() || "未返回 DDL"}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default TableListView;
