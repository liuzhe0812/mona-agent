import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { DbIcon } from "./DbIcon";
import { DatabaseActionIcon } from "./DatabaseActionIcon";
import { DatabaseSettingsDialog } from "./DatabaseSettingsDialog";
import { DatabaseTransferDialog, type DatabaseExportMode } from "./DatabaseTransferDialog";
import { NewTableDialog } from "./NewTableDialog";
import { useDbStore } from "./store/dbStore";
import { hasPendingEdits, quoteIdentifier } from "./table-sql";
import { dbExecuteQuery } from "./ipc";

type Operation = "create" | "edit" | "drop" | "table" | "import" | "all" | "structure" | "data";

export function DatabaseContextMenu({ connectionId, database, children }: { connectionId: string; database: string; children: ReactNode }) {
  const connection = useDbStore((s) => s.activeConnections.find((c) => c.id === connectionId));
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mysql = connection?.config.db_type === "mysql";
  const protectedDatabase = ["information_schema", "mysql", "performance_schema", "sys"].includes(database.toLowerCase());
  const close = () => { setOperation(null); setError(null); };
  async function refresh() {
    try { await useDbStore.getState().refreshTree(connectionId); }
    catch (reason) { setError(String(reason)); }
  }
  async function dropDatabase() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const state = useDbStore.getState();
      if (!state.activeConnections.some((c) => c.id === connectionId)) throw new Error("连接已断开，请重新连接后重试。");
      const affected = state.queryTabs.filter((tab) => tab.connectionId === connectionId && tab.database === database);
      if (affected.some((tab) => tab.isExecuting || tab.isSaving || hasPendingEdits(tab))) throw new Error("该数据库仍有正在执行的操作或未保存的修改，请先处理后再删除。");
      await dbExecuteQuery(connectionId, `DROP DATABASE ${quoteIdentifier(database, false)}`);
      for (const tab of affected) state.patchTab(tab.id, { result: null, tableInfo: null, error: "数据库已删除，请选择其他数据库。" });
      await refresh();
      useDbStore.setState((current) => ({
        objectScope: current.objectScope?.connectionId === connectionId && current.objectScope.database === database ? null : current.objectScope,
        selectedTable: current.selectedConnectionId === connectionId && current.selectedDatabase === database ? null : current.selectedTable,
      }));
      close();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <>
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel>操作</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!mysql} onSelect={() => setOperation("create")}><DatabaseActionIcon action="create" />新建数据库</ContextMenuItem>
        <ContextMenuItem disabled={!mysql || protectedDatabase} onSelect={() => setOperation("edit")}><DatabaseActionIcon action="edit" />编辑数据库</ContextMenuItem>
        <ContextMenuItem disabled={!mysql || protectedDatabase} className="text-destructive focus:text-destructive" onSelect={() => setOperation("drop")}><DatabaseActionIcon action="drop" />删除数据库</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!connection} onSelect={() => setOperation("table")}><DbIcon name="newTable" />新建表</ContextMenuItem>
        <ContextMenuItem disabled={!connection} onSelect={() => useDbStore.getState().addQueryTab(connectionId, database)}><DbIcon name="query" />新建查询</ContextMenuItem>
        <ContextMenuSeparator />
        {mysql && <ContextMenuSub><ContextMenuSubTrigger><DatabaseActionIcon action="export" />导出</ContextMenuSubTrigger><ContextMenuSubContent>
          <ContextMenuItem onSelect={() => setOperation("structure")}>表结构（SQL）</ContextMenuItem>
          <ContextMenuItem onSelect={() => setOperation("data")}>表数据（SQL）</ContextMenuItem>
        </ContextMenuSubContent></ContextMenuSub>}
        <ContextMenuItem disabled={!connection} onSelect={() => setOperation("all")}><DatabaseActionIcon action="export" />导出数据库</ContextMenuItem>
        {mysql && <ContextMenuSub><ContextMenuSubTrigger><DatabaseActionIcon action="import" />导入</ContextMenuSubTrigger><ContextMenuSubContent>
          <ContextMenuItem onSelect={() => setOperation("import")}>SQL 文件</ContextMenuItem>
        </ContextMenuSubContent></ContextMenuSub>}
        <ContextMenuItem disabled={!connection} onSelect={() => { void refresh(); }}><DatabaseActionIcon action="refresh" />刷新</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    {(operation === "create" || operation === "edit") && <DatabaseSettingsDialog connectionId={connectionId} database={operation === "edit" ? database : undefined} onClose={close} onSaved={() => { void refresh(); }} />}
    {operation === "table" && <NewTableDialog connectionId={connectionId} database={database} onClose={close} onCreated={() => { void refresh(); }} />}
    {(operation === "all" || operation === "structure" || operation === "data" || operation === "import") && <DatabaseTransferDialog connectionId={connectionId} database={database} mode={operation === "import" ? "import" : "export"} exportMode={operation === "import" ? "all" : operation as DatabaseExportMode} onClose={close} />}
    <Dialog open={operation === "drop"} onOpenChange={(open) => { if (!open && !busy) close(); }}><DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>删除数据库</DialogTitle><DialogDescription>{connection?.config.name ?? "连接已断开"} / {database}</DialogDescription></DialogHeader>
      <p className="text-caption">删除后，库中的表和数据将永久丢失。确定删除数据库“{database}”？</p>
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <DialogFooter><Button variant="ghost" disabled={busy} onClick={close}>取消</Button><Button variant="destructive" disabled={busy || !connection} onClick={() => { void dropDatabase(); }}>{busy ? "删除中…" : "删除数据库"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
