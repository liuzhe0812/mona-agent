import { useState, useRef, useEffect } from "react";
import { Save, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useDbStore } from "./store/dbStore";
import * as ipc from "./ipc";
import { displayCellValue } from "./types";
import type { CellValue, QueryResult } from "./types";

type ResultTab = "result" | "message" | "plan" | "properties";

export function ResultPanel() {
  const activeTabId = useDbStore((s) => s.activeTabId);
  const queryTabs = useDbStore((s) => s.queryTabs);
  const activeTab = queryTabs.find((t) => t.id === activeTabId);
  const [activeResultTab, setActiveResultTab] = useState<ResultTab>("result");

  useEffect(() => {
    if (activeTab?.result?.message?.startsWith("保存失败")) {
      setActiveResultTab("message");
    }
  }, [activeTab?.result?.message]);

  if (!activeTab) return null;

  const { result, isExecuting, edits } = activeTab;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b border-border bg-card">
        <ResultTabButton
          active={activeResultTab === "result"}
          onClick={() => setActiveResultTab("result")}
        >
          结果集
        </ResultTabButton>
        <ResultTabButton
          active={activeResultTab === "message"}
          onClick={() => setActiveResultTab("message")}
        >
          消息
        </ResultTabButton>
        <ResultTabButton
          active={activeResultTab === "plan"}
          onClick={() => setActiveResultTab("plan")}
        >
          执行计划
        </ResultTabButton>
        <ResultTabButton
          active={activeResultTab === "properties"}
          onClick={() => setActiveResultTab("properties")}
        >
          属性
        </ResultTabButton>
        <div className="flex-1" />
        {edits.length > 0 && (
          <div className="flex items-center gap-1 px-2">
            <span className="text-[11px] text-yellow-500">
              {edits.length} 处修改
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-xs text-green-500 hover:text-green-400"
              onClick={() => activeTabId && useDbStore.getState().saveEdits(activeTabId)}
            >
              <Save className="h-3 w-3" />
              保存
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => activeTabId && useDbStore.getState().revertAllEdits(activeTabId)}
            >
              <RotateCcw className="h-3 w-3" />
              回滚
            </Button>
          </div>
        )}
        {result && result.columns.length > 0 && (
          <span className="px-3.5 py-1.5 text-[11px] text-muted-foreground">
            {result.rows.length} 行 · {result.execution_time_ms}ms · {result.columns.length} 列
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto relative">
        {isExecuting && (
          <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-center bg-background/60 py-1">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-foreground/40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-foreground/60" />
            </span>
          </div>
        )}
        {activeResultTab === "result" && result && result.columns.length > 0 ? (
          <ResultTable result={result} tabId={activeTabId!} edits={edits} />
        ) : activeResultTab === "message" && result ? (
          <div className="p-3.5 text-[13px] text-foreground">
            {result.message ?? "无消息"}
          </div>
        ) : activeResultTab === "properties" ? (
          <PropertiesContent />
        ) : null}
      </div>
    </div>
  );
}

function ResultTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={cn(
        "px-3.5 py-1.5 text-xs transition-colors border-b-2",
        active
          ? "text-foreground border-blue-500"
          : "text-muted-foreground border-transparent hover:text-foreground",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ResultTable({
  result,
  tabId,
  edits,
}: {
  result: QueryResult;
  tabId: string;
  edits: { rowIdx: number; colIdx: number; newValue: string }[];
}) {
  const editMap = new Map<string, string>();
  for (const e of edits) {
    editMap.set(`${e.rowIdx}:${e.colIdx}`, e.newValue);
  }

  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr>
          <th className="sticky top-0 z-10 w-10 bg-card px-2.5 py-1.5 text-right text-[11px] font-semibold text-muted-foreground">
            #
          </th>
          {result.columns.map((col) => (
            <th
              key={col.name}
              className="sticky top-0 z-10 bg-card px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {col.name}
              {col.is_primary_key && (
                <span className="ml-1 text-[10px] text-yellow-500">PK</span>
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, rowIdx) => (
          <tr
            key={rowIdx}
            className={cn(
              "border-b border-border/50 hover:bg-accent transition-colors",
              edits.some((e) => e.rowIdx === rowIdx) && "bg-orange-500/5",
            )}
          >
            <td className="px-2.5 py-1 text-right text-[11px] text-muted-foreground">
              {rowIdx + 1}
            </td>
            {row.map((cell, colIdx) => {
              const editKey = `${rowIdx}:${colIdx}`;
              const editValue = editMap.get(editKey);
              const isDirty = editValue !== undefined;

              return (
                <EditableCell
                  key={colIdx}
                  cell={cell}
                  isDirty={isDirty}
                  editValue={editValue ?? undefined}
                  onSave={(newValue) => {
                    useDbStore.getState().updateCell(tabId, rowIdx, colIdx, newValue);
                  }}
                  onRevert={() => {
                    useDbStore.getState().revertCell(tabId, rowIdx, colIdx);
                  }}
                />
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EditableCell({
  cell,
  isDirty,
  editValue,
  onSave,
  onRevert,
}: {
  cell: CellValue;
  isDirty: boolean;
  editValue?: string;
  onSave: (value: string) => void;
  onRevert: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const displayValue = isDirty ? editValue : displayCellValue(cell);
  const isNull = !isDirty && cell.type === "null";

  if (editing) {
    return (
      <td className="max-w-[300px] px-0.5 py-0.5">
        <input
          ref={inputRef}
          className="w-full rounded border border-blue-500 bg-background px-2 py-0.5 text-[12px] outline-none"
          defaultValue={isDirty ? editValue! : cell.type === "null" ? "" : displayCellValue(cell)}
          onBlur={(e) => {
            const val = e.target.value;
            const original = cell.type === "null" ? "" : displayCellValue(cell);
            if (val !== original) {
              onSave(val);
            } else if (isDirty) {
              onRevert();
            }
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
        />
      </td>
    );
  }

  return (
    <td
      className={cn(
        "max-w-[300px] cursor-text truncate px-2.5 py-1",
        isNull && "italic text-muted-foreground",
        isDirty && "bg-orange-500/15 text-orange-300 font-medium",
      )}
      onDoubleClick={() => setEditing(true)}
      title={isDirty ? `${displayCellValue(cell)} → ${editValue}` : displayValue}
    >
      {displayValue}
    </td>
  );
}

interface SimpleColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  key: string;
  default_val: string | null;
  extra: string;
}

function PropertiesContent() {
  const activeTabId = useDbStore((s) => s.activeTabId);
  const queryTabs = useDbStore((s) => s.queryTabs);
  const activeTab = queryTabs.find((t) => t.id === activeTabId);
  const conn = useDbStore((s) => s.activeConnections.find((c) => c.id === activeTab?.connectionId));

  const [columns, setColumns] = useState<SimpleColumnInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectionId = activeTab?.connectionId;
  const database = activeTab?.database;
  const tableName = activeTab?.title;
  const isSqlite = conn?.config.db_type === "sqlite";

  useEffect(() => {
    if (!connectionId || !database || !tableName) {
      setColumns([]);
      return;
    }
    setLoading(true);
    setError(null);

    const colSql = isSqlite
      ? `PRAGMA table_info("${tableName}")`
      : `SHOW COLUMNS FROM \`${database}\`.\`${tableName}\``;

    ipc.dbExecuteQuery(connectionId, colSql, undefined, database ?? undefined)
      .then((result) => {
        const cols: SimpleColumnInfo[] = result.rows.map((row) => {
          if (isSqlite) {
            const name = displayCellValue(row[1]);
            const type = displayCellValue(row[2]);
            const notnull = displayCellValue(row[3]);
            const dflt = row[4].type === "null" ? null : displayCellValue(row[4]);
            const pk = displayCellValue(row[5]);
            return {
              name,
              type,
              nullable: notnull === "0",
              key: pk !== "0" ? "PRI" : "",
              default_val: dflt,
              extra: pk !== "0" ? "AUTO_INCREMENT" : "",
            };
          }
          const name = displayCellValue(row[0]);
          const type = displayCellValue(row[1]);
          const nullable = displayCellValue(row[2]);
          const key = displayCellValue(row[3]);
          const dflt = row[4].type === "null" ? null : displayCellValue(row[4]);
          const extra = displayCellValue(row[5]);
          return {
            name,
            type,
            nullable: nullable === "YES",
            key,
            default_val: dflt,
            extra,
          };
        });
        setColumns(cols);
      })
      .catch((e) => {
        setError(String(e));
      })
      .finally(() => setLoading(false));
  }, [connectionId, database, tableName, isSqlite]);

  if (!connectionId || !database || !tableName) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        选择一个表查看属性
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        加载中...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-destructive">
        {error}
      </div>
    );
  }

  const pkCols = columns.filter((c) => c.key === "PRI");
  const uniqueCols = columns.filter((c) => c.key === "UNI");

  return (
    <ScrollArea className="h-full">
      <div className="p-3.5">
        <PropSection title="基本信息">
          <PropRow label="表名" value={tableName} />
          <PropRow label="数据库" value={database} />
          <PropRow label="列数" value={String(columns.length)} />
          <PropRow label="主键" value={pkCols.length > 0 ? pkCols.map((c) => c.name).join(", ") : "无"} />
        </PropSection>

        <Separator className="my-3" />

        <PropSection title="列定义">
          {columns.map((col) => (
            <div key={col.name} className="mb-2">
              <div className="text-[12px] text-foreground">
                {col.name} · <span className="text-muted-foreground">{col.type}</span>
                {col.nullable ? null : <span className="text-muted-foreground"> · NOT NULL</span>}
                {col.extra && <span className="text-muted-foreground"> · {col.extra}</span>}
                {col.default_val && (
                  <span className="text-muted-foreground"> · DEFAULT {col.default_val}</span>
                )}
              </div>
              {col.key === "PRI" && (
                <span className="text-[10px] text-yellow-500">⬥ PRIMARY KEY</span>
              )}
              {col.key === "UNI" && (
                <span className="text-[10px] text-blue-400">⬥ UNIQUE</span>
              )}
            </div>
          ))}
        </PropSection>

        {pkCols.length > 0 && (
          <>
            <Separator className="my-3" />
            <PropSection title="主键">
              <PropRow label="列" value={pkCols.map((c) => c.name).join(", ")} />
            </PropSection>
          </>
        )}

        {uniqueCols.length > 0 && (
          <>
            <Separator className="my-3" />
            <PropSection title="唯一约束">
              {uniqueCols.map((col) => (
                <PropRow key={col.name} label={col.name} value={col.type} />
              ))}
            </PropSection>
          </>
        )}
      </div>
    </ScrollArea>
  );
}

function PropSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      {children}
    </div>
  );
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}
