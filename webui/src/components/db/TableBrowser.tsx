import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { DbToolButton } from "./DbToolButton";
import { DdlPreviewPopover } from "./DdlPreviewPopover";
import { DataGrid } from "./DataGrid";
import { useDbStore } from "./store/dbStore";
import { DEFAULT_BROWSE, canEditTable, hasPendingEdits } from "./table-sql";
import type { QueryTab, TableBrowse } from "./types";

export function TableBrowser({ tab }: { tab: QueryTab }) {
  const connections = useDbStore((s) => s.activeConnections);
  const patchTab = useDbStore((s) => s.patchTab);
  const schemaSaving = useDbStore((s) => s.queryTabs.some((item) => item.kind === "structure" && item.isSaving && item.connectionId === tab.connectionId && item.database === tab.database && item.tableName === tab.tableName));
  const connection = connections.find((c) => c.id === tab.connectionId);
  const [sqlOpen, setSqlOpen] = useState(false);
  const [ddlOpen, setDdlOpen] = useState(false);
  const [pending, setPending] = useState<{ title: string; description: string; action: () => void } | null>(null);
  const busy = tab.isExecuting || tab.isSaving || tab.isLoadingMetadata || schemaSaving;
  const readOnly = !canEditTable(tab);
  const modified = tab.edits.filter((e) => !tab.insertedRows.includes(e.rowIdx) && !tab.deletedRows?.includes(e.rowIdx)).length + tab.insertedRows.length + (tab.deletedRows?.length ?? 0);
  const browse = tab.browse ?? DEFAULT_BROWSE;
  function guard(action: () => void) {
    if (hasPendingEdits(tab)) setPending({ title: "放弃未保存的修改？", description: "刷新、翻页或改变筛选会替换当前数据。继续将放弃这个标签中尚未保存的修改。", action: () => { useDbStore.getState().revertAllEdits(tab.id); action(); } });
    else action();
  }
  function onBrowse(patch: Partial<TableBrowse>) { guard(() => { void useDbStore.getState().browseTable(tab.id, patch); }); }
  function save() {
    if (tab.deletedRows?.length) setPending({ title: `保存修改并删除 ${tab.deletedRows.length} 行？`, description: `${connection?.config.name ?? ""} / ${tab.database} / ${tab.tableName}。删除将写入数据库。`, action: () => { void useDbStore.getState().saveEdits(tab.id); } });
    else void useDbStore.getState().saveEdits(tab.id);
  }
  return <TooltipProvider delayDuration={250}>
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div role="toolbar" aria-label="数据表操作" className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2">
        <DbToolButton icon="refresh" label="刷新数据" disabled={busy || !connection} onClick={() => guard(() => { void useDbStore.getState().executeQuery(tab.id); })} />
        <DbToolButton icon="add" label="新增行" disabled={busy || readOnly || !connection} onClick={() => useDbStore.getState().insertRow(tab.id)} />
        <DbToolButton icon="remove" label="删除选中行" disabled={busy || readOnly || !connection || !tab.selectedRows?.length} onClick={() => {
          for (const row of [...(tab.selectedRows ?? [])].sort((a, b) => b - a)) void useDbStore.getState().deleteRow(tab.id, row);
        }} />
        <DbToolButton icon="save" label="保存修改" className={modified ? "text-info" : ""} disabled={busy || !modified || !connection} onClick={save} />
        <DbToolButton icon="undo" label="撤销修改" disabled={busy || !modified} onClick={() => useDbStore.getState().revertAllEdits(tab.id)} />
        {modified > 0 && <span className="shrink-0 px-2 text-caption text-warning">{modified} 处修改</span>}
        {busy && <span role="status" className="shrink-0 px-2 text-caption text-muted-foreground">{schemaSaving ? "正在更新表结构…" : tab.isSaving ? "正在保存…" : "正在读取…"}</span>}
        <div className="flex-1" />
        <DbToolButton icon="structure" label="编辑表结构" disabled={!connection || tab.objectType === "view"} onClick={() => { if (tab.connectionId && tab.database && tab.tableName) void useDbStore.getState().openTableStructure(tab.connectionId, tab.database, tab.tableName); }} />
        <DbToolButton icon="ddl" label="查看 DDL" aria-pressed={ddlOpen} disabled={!tab.tableInfo?.ddl} onClick={() => setDdlOpen((open) => !open)} />
      </div>
      <DdlPreviewPopover open={ddlOpen} title={`${tab.tableName ?? tab.title} · DDL`} sql={tab.tableInfo?.ddl} onClose={() => setDdlOpen(false)} />
      {(tab.error || tab.metadataError) && <div role="alert" className="max-h-32 shrink-0 overflow-auto whitespace-pre-wrap break-words border-b border-border px-3 py-2 text-caption text-destructive">{[tab.metadataError, tab.error].filter(Boolean).join("\n")}</div>}
      <DataGrid tab={tab} onBrowse={onBrowse} onRefresh={() => guard(() => { void useDbStore.getState().executeQuery(tab.id); })} />
      <div className="flex h-8 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-t border-border px-2 text-caption text-muted-foreground" aria-label="数据库状态栏">
        <span className={connection ? "text-success" : "text-destructive"} aria-label={connection ? "已连接" : "已断开"}>●</span>
        <span className="max-w-48 truncate" title={`${connection?.config.name ?? "已断开"} / ${tab.database}`}>{connection?.config.name ?? "已断开"} · {tab.database}</span>
        <span className="mx-1 h-4 w-px bg-border" />
        <DbToolButton icon="code" label="查看 SQL" className="h-6 w-7" onClick={() => setSqlOpen(true)} />
        {readOnly && <span title="视图或没有可靠主键的数据表只读">只读</span>}
        <div className="flex-1" />
        <span>{tab.result?.rows.length ?? 0} 行 · {tab.result?.execution_time_ms ?? 0} ms</span>
        <Select aria-label="每页行数" className="h-6 w-28 border-0 text-caption" value={String(browse.pageSize)} disabled={busy}
          options={[{ value: "100", label: "100 行/页" }, { value: "500", label: "500 行/页" }]} onValueChange={(v) => onBrowse({ page: 0, pageSize: Number(v) })} />
        <DbToolButton icon="chevronLeft" label="上一页" className="h-6 w-6" disabled={busy || browse.page === 0} onClick={() => onBrowse({ page: browse.page - 1 })} />
        <span aria-label="当前页">{browse.page + 1}</span>
        <DbToolButton icon="chevronRight" label="下一页" className="h-6 w-6" disabled={busy || !tab.hasMore} onClick={() => onBrowse({ page: browse.page + 1 })} />
      </div>
    </div>
    <Dialog open={sqlOpen} onOpenChange={setSqlOpen}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>当前浏览 SQL</DialogTitle>
          <DialogDescription>{connection?.config.name} / {tab.database} / {tab.tableName}</DialogDescription></DialogHeader>
        <div className="max-h-96 overflow-auto text-caption">
          <pre className="select-text whitespace-pre-wrap break-words font-mono">{tab.lastExecutedSql ?? tab.sql}</pre>
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => {
          const sql = tab.lastExecutedSql ?? tab.sql;
          const id = useDbStore.getState().addQueryTab(); patchTab(id, { sql, connectionId: tab.connectionId, database: tab.database }); setSqlOpen(false);
        }}>在查询中打开</Button><Button onClick={() => setSqlOpen(false)}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{pending?.title}</AlertDialogTitle><AlertDialogDescription>{pending?.description}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => { pending?.action(); setPending(null); }}>继续</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </TooltipProvider>;
}
