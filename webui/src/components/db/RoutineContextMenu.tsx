import { useState, type ReactNode } from "react";
import { Copy, FileCode2, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DbIcon } from "./DbIcon";
import { dbExecuteQuery, dbGetRoutineDefinition } from "./ipc";
import { duplicateRoutineSql, routineListSql, routineTemplate, type RoutineType } from "./routine-sql";
import { quoteIdentifier } from "./table-sql";
import { useDbStore } from "./store/dbStore";

type Routine = { name: string; type: RoutineType };

export function RoutineContextMenu({
  connectionId,
  database,
  routine,
  children,
}: {
  connectionId: string;
  database: string;
  routine?: Routine;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openSql(title: string, sql: string) {
    const state = useDbStore.getState();
    const tabId = state.addQueryTab(connectionId, database);
    state.patchTab(tabId, { title, sql });
    return tabId;
  }

  function createRoutine(type: RoutineType) {
    openSql(type === "function" ? "新建函数" : "新建存储过程", routineTemplate(type));
  }

  async function loadDefinition(action: "open" | "copy-sql" | "duplicate") {
    if (!routine || busy) return;
    setBusy(true);
    setError(null);
    try {
      const definition = await dbGetRoutineDefinition(
        connectionId,
        database,
        routine.name,
        routine.type,
      );
      if (action === "copy-sql") {
        await navigator.clipboard.writeText(definition);
      } else if (action === "duplicate") {
        openSql(`${routine.name}_copy`, duplicateRoutineSql(definition, routine.name));
      } else {
        openSql(routine.name, definition);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function openList() {
    if (busy) return;
    const tabId = openSql("存储过程/函数", routineListSql(database));
    await useDbStore.getState().executeQuery(tabId);
  }

  async function refresh() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await useDbStore.getState().refreshTree(connectionId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function dropRoutine() {
    if (!routine || busy) return;
    setBusy(true);
    setError(null);
    try {
      const keyword = routine.type === "function" ? "FUNCTION" : "PROCEDURE";
      await dbExecuteQuery(
        connectionId,
        `DROP ${keyword} ${quoteIdentifier(database, false)}.${quoteIdentifier(routine.name, false)}`,
        undefined,
        database,
      );
      await useDbStore.getState().refreshTree(connectionId);
      setDeleteOpen(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel className="font-normal text-muted-foreground">操作</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={busy} onSelect={() => { void (routine ? loadDefinition("open") : openList()); }}>
          <FolderOpen className="h-4 w-4" />打开
        </ContextMenuItem>
        <ContextMenuItem disabled={busy} onSelect={() => createRoutine("function")}>
          <DbIcon name="procedure" className="h-4 w-4" />新建函数
        </ContextMenuItem>
        <ContextMenuItem disabled={busy} onSelect={() => createRoutine("procedure")}>
          <DbIcon name="procedure" className="h-4 w-4" />新建存储过程
        </ContextMenuItem>
        <ContextMenuItem disabled={!routine || busy} onSelect={() => { void loadDefinition("copy-sql"); }}>
          <FileCode2 className="h-4 w-4" />复制 SQL
        </ContextMenuItem>
        <ContextMenuItem disabled={!routine || busy} onSelect={() => { void loadDefinition("duplicate"); }}>
          <Copy className="h-4 w-4" />复制
        </ContextMenuItem>
        <ContextMenuItem disabled={!routine || busy} className="text-destructive focus:text-destructive" onSelect={() => setDeleteOpen(true)}>
          <Trash2 className="h-4 w-4" />删除
        </ContextMenuItem>
        <ContextMenuItem disabled={busy} onSelect={() => { void refresh(); }}>
          <RefreshCw className="h-4 w-4" />刷新
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    <AlertDialog open={deleteOpen} onOpenChange={(open) => !busy && setDeleteOpen(open)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除{routine?.type === "function" ? "函数" : "存储过程"}</AlertDialogTitle>
          <AlertDialogDescription>删除后无法恢复。确定删除“{database}.{routine?.name}”吗？</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={busy} onClick={(event) => { event.preventDefault(); void dropRoutine(); }}>
            {busy ? "删除中…" : "删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={Boolean(error) && !deleteOpen} onOpenChange={(open) => !open && setError(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>操作失败</DialogTitle></DialogHeader>
        <p role="alert" className="break-all text-caption text-destructive">{error}</p>
        <DialogFooter><Button onClick={() => setError(null)}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
