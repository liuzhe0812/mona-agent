import { useState } from "react";

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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDbStore } from "./store/dbStore";
import { hasPendingEdits } from "./table-sql";
import {
  buildTableOperationSql,
  type TableOperationContext,
} from "./table-operation";
import * as ipc from "./ipc";

export interface TableOperationDialogContext extends TableOperationContext {
  connectionId: string;
}

export interface TableOperationDialogProps {
  context: TableOperationDialogContext;
  onClose: () => void;
  onDone: (newName?: string) => void;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason) return reason;
  return String(reason);
}

function isTargetTab(
  tab: ReturnType<typeof useDbStore.getState>["queryTabs"][number],
  context: TableOperationDialogContext,
): boolean {
  return (
    (tab.kind === "table" || tab.kind === "structure") &&
    tab.connectionId === context.connectionId &&
    tab.database === context.database &&
    tab.tableName === context.table &&
    (tab.objectType ?? "table") === context.objectType
  );
}

function isBusyTab(
  tab: ReturnType<typeof useDbStore.getState>["queryTabs"][number],
): boolean {
  return Boolean(
    hasPendingEdits(tab) ||
      tab.isSaving ||
      tab.isExecuting ||
      tab.isLoadingMetadata,
  );
}

function assertOperationReady(
  context: TableOperationDialogContext,
  tabs: ReturnType<typeof useDbStore.getState>["queryTabs"],
) {
  const conflict = tabs.find((tab) => isTargetTab(tab, context) && isBusyTab(tab));
  if (conflict) {
    throw new Error(
      `无法操作 ${context.database}.${context.table}：已打开的数据或结构标签存在未保存修改，或正在保存、执行或读取元数据。请先完成或撤销修改，避免丢失。`,
    );
  }
}

function removeCleanTargetTabs(context: TableOperationDialogContext): void {
  useDbStore.setState((state) => {
    const removedIds = new Set(
      state.queryTabs
        .filter((tab) => isTargetTab(tab, context) && !isBusyTab(tab))
        .map((tab) => tab.id),
    );
    if (!removedIds.size) return {};

    const activeRemoved = state.activeTabId !== null && removedIds.has(state.activeTabId);
    return {
      queryTabs: state.queryTabs.filter((tab) => !removedIds.has(tab.id)),
      ...(activeRemoved ? { activeTabId: null, selectedTable: null } : {}),
    };
  });
}

function targetPath(connectionName: string, context: TableOperationDialogContext): string {
  return `${connectionName} / ${context.database} / ${context.table}`;
}

function TargetDetails({
  connectionName,
  context,
}: {
  connectionName: string;
  context: TableOperationDialogContext;
}) {
  return (
    <div className="space-y-1 rounded-sm border border-border bg-muted/30 px-3 py-2 text-caption">
      <p className="break-words">连接：{connectionName}</p>
      <p className="break-words">数据库：{context.database}</p>
      <p className="break-words">{context.objectType === "view" ? "视图" : "表"}：{context.table}</p>
      <p className="break-words font-mono text-muted-foreground" aria-label="完整操作目标">
        {targetPath(connectionName, context)}
      </p>
    </div>
  );
}

function unsupportedMessage(context: TableOperationDialogContext): string | null {
  if (context.objectType !== "view") return null;
  if (context.operation === "rename") return "视图不支持重命名操作。";
  if (context.operation === "truncate") return "视图不支持清空操作。";
  return null;
}

export function TableOperationDialog({
  context,
  onClose,
  onDone,
}: TableOperationDialogProps) {
  const connection = useDbStore((state) =>
    state.activeConnections.find((item) => item.id === context.connectionId),
  );
  const [newName, setNewName] = useState(context.table);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsupported = unsupportedMessage(context);
  const connectionName = connection?.config.name || context.connectionId;
  const isRename = context.operation === "rename";

  async function executeOperation(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);

    const normalizedName = isRename ? newName.trim() : undefined;
    try {
      if (unsupported) throw new Error(unsupported);
      // Read the connection and tab state again immediately before issuing SQL.
      const latestState = useDbStore.getState();
      const latestConnection = latestState.activeConnections.find((item) => item.id === context.connectionId);
      if (!latestConnection) throw new Error("连接已断开，请重新连接后操作。");
      assertOperationReady(context, latestState.queryTabs);
      if (isRename && normalizedName === context.table) {
        throw new Error("新表名必须与当前表名不同。");
      }
      const sql = buildTableOperationSql(
        context,
        normalizedName,
        latestConnection.config.db_type === "sqlite",
      );
      await ipc.dbExecuteQuery(context.connectionId, sql, undefined, context.database);
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
      return;
    }

    if (context.operation === "truncate") {
      const tableTabs = useDbStore
        .getState()
        .queryTabs.filter((tab) => isTargetTab(tab, context) && tab.kind === "table");
      for (const tab of tableTabs) {
        const state = useDbStore.getState();
        state.patchTab(tab.id, { result: null, error: null });
        try {
          await state.executeQuery(tab.id);
        } catch (reason) {
          state.patchTab(tab.id, { isExecuting: false, error: errorMessage(reason) });
        }
      }
    } else {
      removeCleanTargetTabs(context);
    }

    // A successful write must stay successful if catalog refresh fails. The store
    // records its own refresh error, while the list view performs its own refresh.
    try {
      await useDbStore.getState().refreshTree(context.connectionId);
    } catch (reason) {
      useDbStore.getState().setConnectError(`操作已完成，但刷新对象列表失败：${errorMessage(reason)}`);
    }

    setBusy(false);
    onDone(isRename ? normalizedName : undefined);
    onClose();
  }

  const operationName = context.operation === "drop"
    ? context.objectType === "view" ? "删除视图" : "删除表"
    : context.operation === "truncate" ? "清空表" : "重命名表";
  const operationDescription = context.operation === "drop"
    ? `${context.objectType === "view" ? "该视图" : "该表"}及其定义将被永久删除，此操作不可撤销。`
    : "该表中的所有数据将被清空，此操作不可撤销。";

  if (context.operation === "rename") {
    return (
      <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
        <DialogContent className="max-w-md">
          <form onSubmit={(event) => { event.preventDefault(); void executeOperation(); }}>
            <DialogHeader>
              <DialogTitle>重命名表</DialogTitle>
              <DialogDescription>为当前表输入新的名称。</DialogDescription>
            </DialogHeader>
            <TargetDetails connectionName={connectionName} context={context} />
            <label className="my-4 block space-y-2 text-caption" htmlFor="table-operation-new-name">
              新表名
              <Input
                id="table-operation-new-name"
                aria-label="新表名"
                autoFocus
                value={newName}
                disabled={busy || Boolean(unsupported)}
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
            {unsupported && <p role="alert" className="mb-3 text-caption text-destructive">{unsupported}</p>}
            {error && <p role="alert" className="mb-3 break-words text-caption text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
              <Button type="submit" disabled={busy || Boolean(unsupported) || !newName.trim() || newName.trim() === context.table}>
                {busy ? "重命名中…" : "重命名"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{operationName}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-caption">
              <TargetDetails connectionName={connectionName} context={context} />
              <p>{operationDescription}</p>
              {unsupported && <p role="alert" className="text-destructive">{unsupported}</p>}
              {error && <p role="alert" className="break-words text-destructive">{error}</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || Boolean(unsupported)}
            onClick={(event) => { event.preventDefault(); void executeOperation(); }}
            className={context.operation === "drop"
              ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              : "border border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"}
          >
            {busy ? `${context.operation === "drop" ? "删除" : "清空"}中…` : context.operation === "drop" ? "删除" : "清空"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { buildTableOperationSql } from "./table-operation";
export type { TableOperation, TableOperationContext } from "./table-operation";
