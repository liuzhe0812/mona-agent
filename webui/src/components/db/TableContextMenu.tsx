import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DatabaseActionIcon } from "./DatabaseActionIcon";
import { DatabaseTransferDialog } from "./DatabaseTransferDialog";
import { DbIcon } from "./DbIcon";
import { NewTableDialog } from "./NewTableDialog";
import { TableOperationDialog } from "./TableOperationDialog";
import * as ipc from "./ipc";
import { useDbStore } from "./store/dbStore";
import { hasPendingEdits, quoteIdentifier } from "./table-sql";

type ObjectType = "table" | "view";
type Operation = "create" | "rename" | "optimize" | "truncate" | "drop" | "export" | "import" | "notice";

export function TableContextMenu({
  connectionId,
  database,
  table,
  objectType,
  children,
  onOpen,
  onRefresh,
}: {
  connectionId: string;
  database: string;
  table: string;
  objectType: ObjectType;
  children: ReactNode;
  onOpen: () => void;
  onRefresh?: (newName?: string) => void;
}) {
  const connection = useDbStore((state) =>
    state.activeConnections.find((item) => item.id === connectionId),
  );
  const [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"normal" | "error">("normal");
  const mysqlTable = connection?.config.db_type === "mysql" && objectType === "table";
  const label = objectType === "view" ? "视图" : "表";

  function close() {
    if (busy) return;
    setOperation(null);
    setMessage("");
  }

  function assertReady() {
    const state = useDbStore.getState();
    if (!state.activeConnections.some((item) => item.id === connectionId)) {
      throw new Error("连接已断开，请重新连接后操作。");
    }
    const conflict = state.queryTabs.find((tab) =>
      tab.connectionId === connectionId && tab.database === database && tab.tableName === table &&
      (tab.isExecuting || tab.isSaving || tab.isLoadingMetadata || hasPendingEdits(tab)),
    );
    if (conflict) throw new Error(`“${table}”存在未保存修改或正在执行的操作，请先处理。`);
  }

  async function refresh() {
    await useDbStore.getState().refreshTree(connectionId);
    onRefresh?.();
  }

  async function copyDdl() {
    try {
      assertReady();
      const info = await ipc.dbGetTableInfo(connectionId, database, table);
      if (!info.ddl?.trim()) throw new Error(`服务器没有返回${label}定义。`);
      if (!navigator.clipboard?.writeText) throw new Error("当前环境不支持复制到剪贴板。");
      await navigator.clipboard.writeText(info.ddl);
      setMessage(`已复制${label}结构 SQL。`);
      setMessageTone("normal");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setMessageTone("error");
    }
    setOperation("notice");
  }

  async function exportDdl() {
    setBusy(true);
    setMessage("");
    try {
      assertReady();
      const info = await ipc.dbGetTableInfo(connectionId, database, table);
      if (!info.ddl?.trim()) throw new Error(`服务器没有返回${label}定义。`);
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        title: `导出${label}结构`,
        defaultPath: `${table}.sql`,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (!path) {
        setOperation(null);
        return;
      }
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, `${info.ddl.trim().replace(/;+$/, "")};\n`);
      setMessage(`已导出${label}结构。`);
      setMessageTone("normal");
      setOperation("notice");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setMessageTone("error");
      setOperation("notice");
    } finally {
      setBusy(false);
    }
  }

  async function optimize() {
    setBusy(true);
    setMessage("");
    try {
      assertReady();
      await ipc.dbExecuteQuery(
        connectionId,
        `OPTIMIZE TABLE ${quoteIdentifier(database, false)}.${quoteIdentifier(table, false)}`,
        undefined,
        database,
      );
      await refresh();
      setMessage("表空间优化完成。");
      setMessageTone("normal");
      setOperation("notice");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setMessageTone("error");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <ContextMenuLabel>操作</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onOpen}>
          <DbIcon name="view" />打开{label}
        </ContextMenuItem>
        {objectType === "table" && <ContextMenuItem onSelect={() => { void useDbStore.getState().openTableStructure(connectionId, database, table); }}>
          <DbIcon name="structure" />编辑表结构
        </ContextMenuItem>}
        {objectType === "table" && <ContextMenuItem onSelect={() => setOperation("create")}>
          <DbIcon name="newTable" />新建表
        </ContextMenuItem>}
        <ContextMenuItem onSelect={() => useDbStore.getState().addQueryTab(connectionId, database)}>
          <DbIcon name="query" />新建查询
        </ContextMenuItem>
        {objectType === "table" && <ContextMenuItem onSelect={() => setOperation("rename")}>
          <DbIcon name="rename" />重命名
        </ContextMenuItem>}
        <ContextMenuItem onSelect={() => { void refresh(); }}>
          <DbIcon name="refreshTable" />刷新
        </ContextMenuItem>
        {mysqlTable && <ContextMenuItem onSelect={() => setOperation("optimize")}>
          <DbIcon name="database" />优化表空间
        </ContextMenuItem>}
        <ContextMenuItem onSelect={() => { void copyDdl(); }}>
          <DbIcon name="ddl" />复制{label}结构 SQL
        </ContextMenuItem>
        <ContextMenuSeparator />
        {objectType === "table" && <ContextMenuSub>
          <ContextMenuSubTrigger><DbIcon name="dropTable" />删除</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => setOperation("truncate")}>清空表数据</ContextMenuItem>
            <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => setOperation("drop")}>删除表</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>}
        {objectType === "view" && <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => setOperation("drop")}>
          <DbIcon name="dropTable" />删除视图
        </ContextMenuItem>}
        <ContextMenuSub>
          <ContextMenuSubTrigger><DatabaseActionIcon action="export" />导出</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => { setOperation("export"); void exportDdl(); }}>{label}结构 SQL</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        {connection?.config.db_type === "mysql" && <ContextMenuSub>
          <ContextMenuSubTrigger><DatabaseActionIcon action="import" />导入</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => setOperation("import")}>SQL 文件到当前数据库</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>}
      </ContextMenuContent>
    </ContextMenu>

    {operation === "create" && <NewTableDialog connectionId={connectionId} database={database}
      onClose={close} onCreated={() => { void refresh(); }} />}
    {(operation === "rename" || operation === "truncate" || operation === "drop") &&
      <TableOperationDialog context={{ connectionId, database, table, objectType, operation }}
        onClose={close} onDone={(newName) => { close(); onRefresh?.(newName); }} />}
    {operation === "import" && <DatabaseTransferDialog connectionId={connectionId} database={database}
      mode="import" onClose={close} />}
    <Dialog open={operation === "optimize"} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>优化表空间</DialogTitle>
          <DialogDescription>{connection?.config.name ?? "连接已断开"} / {database} / {table}</DialogDescription>
        </DialogHeader>
        <p className="text-caption">MySQL 可能重建并短暂锁定该表。建议在低峰期执行。</p>
        {message && <p role="alert" className="text-caption text-destructive">{message}</p>}
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={close}>取消</Button>
          <Button disabled={busy || !connection} onClick={() => { void optimize(); }}>{busy ? "优化中…" : "优化"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={operation === "notice"} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="max-w-md"><DialogHeader><DialogTitle>{messageTone === "error" ? "操作失败" : "操作完成"}</DialogTitle>
        <DialogDescription>{connection?.config.name ?? "连接已断开"} / {database} / {table}</DialogDescription></DialogHeader>
        <p role={messageTone === "error" ? "alert" : "status"} className={messageTone === "error" ? "text-caption text-destructive" : "text-caption"}>{message}</p>
        <DialogFooter><Button onClick={close}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
