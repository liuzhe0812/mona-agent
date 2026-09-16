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
import {
  DatabaseTransferDialog,
  type DatabaseExportMode,
} from "./DatabaseTransferDialog";
import { DbIcon } from "./DbIcon";
import { NewTableDialog } from "./NewTableDialog";
import * as ipc from "./ipc";
import { useDbStore } from "./store/dbStore";

type Operation = "create" | "copyDdl" | "import" | DatabaseExportMode;

export function TableFolderContextMenu({
  connectionId,
  database,
  children,
}: {
  connectionId: string;
  database: string;
  children: ReactNode;
}) {
  const connection = useDbStore((state) =>
    state.activeConnections.find((item) => item.id === connectionId),
  );
  const [operation, setOperation] = useState<Operation | null>(null);
  const [copyState, setCopyState] = useState<"loading" | "done" | "error">("loading");
  const [copyMessage, setCopyMessage] = useState("");
  const mysql = connection?.config.db_type === "mysql";

  function close() {
    setOperation(null);
    setCopyMessage("");
  }

  async function refresh() {
    await useDbStore.getState().refreshTree(connectionId);
  }

  async function copyAllDdl() {
    if (!connection || operation === "copyDdl") return;
    setOperation("copyDdl");
    setCopyState("loading");
    setCopyMessage("");
    try {
      const summaries = await ipc.dbGetTableSummaries(connectionId, database);
      const tables = summaries.filter((item) => item.object_type === "table");
      if (!tables.length) throw new Error("当前数据库没有可复制的表结构。");
      const ddl: string[] = [];
      for (const table of tables) {
        const info = await ipc.dbGetTableInfo(connectionId, database, table.name);
        if (info.ddl?.trim()) ddl.push(`${info.ddl.trim().replace(/;+$/, "")};`);
      }
      if (!ddl.length) throw new Error("服务器没有返回可复制的表结构 SQL。");
      await navigator.clipboard.writeText(ddl.join("\n\n"));
      setCopyState("done");
      setCopyMessage(`已复制 ${ddl.length} 张表的结构 SQL。`);
    } catch (reason) {
      setCopyState("error");
      setCopyMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return <>
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuLabel>操作</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!connection} onSelect={() => setOperation("create")}>
          <DbIcon name="newTable" />新建表
        </ContextMenuItem>
        <ContextMenuItem disabled={!connection} onSelect={() => useDbStore.getState().addQueryTab(connectionId, database)}>
          <DbIcon name="query" />新建查询
        </ContextMenuItem>
        <ContextMenuItem disabled={!connection} onSelect={() => { void refresh(); }}>
          <DbIcon name="refreshTable" />刷新
        </ContextMenuItem>
        <ContextMenuItem disabled={!connection} onSelect={() => { void copyAllDdl(); }}>
          <DbIcon name="ddl" />复制全部表结构 SQL
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={!connection}>
            <DatabaseActionIcon action="export" />导出
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {mysql ? <>
              <ContextMenuItem onSelect={() => setOperation("structure")}>表结构（SQL）</ContextMenuItem>
              <ContextMenuItem onSelect={() => setOperation("data")}>表数据（SQL）</ContextMenuItem>
              <ContextMenuItem onSelect={() => setOperation("all")}>结构和数据（SQL）</ContextMenuItem>
            </> : <ContextMenuItem onSelect={() => setOperation("all")}>SQLite 数据库</ContextMenuItem>}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {mysql && <ContextMenuSub>
          <ContextMenuSubTrigger><DatabaseActionIcon action="import" />导入</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => setOperation("import")}>SQL 文件</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>}
      </ContextMenuContent>
    </ContextMenu>

    {operation === "create" && <NewTableDialog connectionId={connectionId} database={database}
      onClose={close} onCreated={() => { void refresh(); }} />}
    {(operation === "all" || operation === "structure" || operation === "data" || operation === "import") &&
      <DatabaseTransferDialog connectionId={connectionId} database={database}
        mode={operation === "import" ? "import" : "export"}
        exportMode={operation === "import" ? "all" : operation}
        onClose={close} />}
    <Dialog open={operation === "copyDdl"} onOpenChange={(open) => { if (!open && copyState !== "loading") close(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>复制全部表结构 SQL</DialogTitle>
          <DialogDescription>{connection?.config.name ?? "连接已断开"} / {database}</DialogDescription>
        </DialogHeader>
        <p role={copyState === "error" ? "alert" : "status"}
          className={copyState === "error" ? "text-caption text-destructive" : "text-caption text-muted-foreground"}>
          {copyState === "loading" ? "正在读取表结构…" : copyMessage}
        </p>
        <DialogFooter><Button disabled={copyState === "loading"} onClick={close}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
