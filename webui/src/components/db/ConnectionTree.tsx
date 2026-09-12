import { Children, useEffect, useMemo, useState } from "react";
import {
  FolderOpen,
  Unplug,
  Settings,
  LayoutDashboard,
  Users,
  HardDrive,
  List,
  GitBranch,
  FileText,
  Sliders,
  CalendarClock,
  Pencil,
  Trash2,
  Eraser,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { StatusNotice } from "@/components/ui/status-notice";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useDbStore } from "./store/dbStore";
import type { DatabaseObject } from "./types";
import { DbIcon } from "./DbIcon";
import { quoteIdentifier } from "./table-sql";

type DbObjectKind = "table" | "view";
type OpenDatabaseAction = (
  connectionId: string,
  database: string,
  objectType?: DbObjectKind,
) => void;

type QueryTabObject = {
  tableName?: string;
  kind?: "table" | "query";
  objectType?: DbObjectKind;
};

export function filterDatabaseTree(nodes: DatabaseObject[], query: string): DatabaseObject[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return nodes;

  return nodes.flatMap((node) => {
    if (node.name.toLocaleLowerCase().includes(needle)) return [node];

    const children = filterDatabaseTree(node.children, needle);
    return children.length > 0 ? [{ ...node, children }] : [];
  });
}

export function ConnectionTree() {
  const savedConnections = useDbStore((s) => s.savedConnections);
  const activeConnections = useDbStore((s) => s.activeConnections);
  const connectionTree = useDbStore((s) => s.connectionTree);
  const connect = useDbStore((s) => s.connect);
  const disconnect = useDbStore((s) => s.disconnect);
  const deleteConnection = useDbStore((s) => s.deleteConnection);
  const refreshTree = useDbStore((s) => s.refreshTree);
  const selectTable = useDbStore((s) => s.selectTable);
  const openDatabase = useDbStore((s) => s.openDatabase);
  const setCurrentView = useDbStore((s) => s.setCurrentView);
  const setNewConnectionDialogOpen = useDbStore((s) => s.setNewConnectionDialogOpen);
  const setEditConnectionConfig = useDbStore((s) => s.setEditConnectionConfig);
  const setSelectedConnectionId = useDbStore((s) => s.setSelectedConnectionId);
  const setSelectedDatabase = useDbStore((s) => s.setSelectedDatabase);
  const refreshServerStats = useDbStore((s) => s.refreshServerStats);
  const refreshProcesses = useDbStore((s) => s.refreshProcesses);
  const refreshUsers = useDbStore((s) => s.refreshUsers);
  const connectingId = useDbStore((s) => s.connectingId);
  const connectError = useDbStore((s) => s.connectError);
  const setConnectError = useDbStore((s) => s.setConnectError);
  const selectedTable = useDbStore((s) => s.selectedTable);
  const selectedConnectionId = useDbStore((s) => s.selectedConnectionId);
  const selectedDatabase = useDbStore((s) => s.selectedDatabase);
  const currentView = useDbStore((s) => s.currentView);
  const queryTabs = useDbStore((s) => s.queryTabs);
  const activeTabId = useDbStore((s) => s.activeTabId);
  const [searchQuery, setSearchQuery] = useState("");

  const isConnected = (id: string) => activeConnections.some((c) => c.id === id);
  const activeTab = queryTabs.find((tab) => tab.id === activeTabId) as
    | (QueryTabObject & { connectionId?: string | null; database?: string | null })
    | undefined;
  const currentObjectName =
    currentView === "table" ? activeTab?.tableName ?? selectedTable?.name : undefined;
  const currentObjectKind =
    currentView === "table"
      ? activeTab?.objectType ?? (activeTab?.kind === "table" ? "table" : undefined) ??
        (selectedTable ? "table" : undefined)
      : undefined;
  const currentObjectKey =
    selectedConnectionId && selectedDatabase && currentObjectName && currentObjectKind
      ? `${selectedConnectionId}:${selectedDatabase}:${currentObjectKind}:${currentObjectName}`
      : null;

  const openObjectList = (connectionId: string, database: string, objectType?: DbObjectKind) => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(database);
    openDatabase(connectionId, database, objectType);
  };

  const selectObject = (
    connectionId: string,
    database: string,
    tableName: string,
    objectType: DbObjectKind,
    pinned = false,
  ) => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(database);
    void selectTable(connectionId, database, tableName, pinned, objectType).catch(() => undefined);
  };

  const isCurrentObject = (
    connectionId: string,
    database: string,
    objectName: string,
    objectType: DbObjectKind,
  ) =>
    selectedConnectionId === connectionId &&
    selectedDatabase === database &&
    currentObjectName === objectName &&
    (!currentObjectKind || currentObjectKind === objectType);

  const visibleConnections = useMemo(
    () =>
      savedConnections.flatMap((config) => {
        const query = searchQuery.trim().toLocaleLowerCase();
        if (!query || config.name.toLocaleLowerCase().includes(query)) return [config];

        const tree = filterDatabaseTree(connectionTree[config.id] ?? [], query);
        return tree.length > 0 ? [config] : [];
      }),
    [connectionTree, savedConnections, searchQuery],
  );

  return (
    <div className="flex h-full flex-col bg-card text-foreground">
      <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-2">
        <span className="text-caption font-semibold uppercase tracking-wider text-muted-foreground">
          连接
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label="新建连接"
            onClick={() => setNewConnectionDialogOpen(true)}
          >
            <DbIcon name="add" className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="relative px-2 py-2">
        <DbIcon
          name="search"
          className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="搜索连接或表"
          className="h-8 pl-8 pr-8 text-ui"
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="搜索连接或表"
          value={searchQuery}
        />
        {searchQuery && (
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label="清除搜索"
            className="absolute right-3 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => setSearchQuery("")}
          >
            <DbIcon name="close" className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {connectError && (
        <StatusNotice
          tone="danger"
          className="mx-2 mt-1 p-2 text-caption"
          action={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="关闭"
              onClick={() => setConnectError(null)}
              className="h-5 w-5 text-destructive/60 hover:text-destructive"
            >
              <DbIcon name="close" className="h-3 w-3" />
            </Button>
          }
        >
          <span className="break-all text-destructive">{connectError}</span>
        </StatusNotice>
      )}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {visibleConnections.map((config) => {
            const connected = isConnected(config.id);
            const connecting = connectingId === config.id;
            const tree = connectionTree[config.id] ?? [];
            const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
            const connectionMatches =
              normalizedSearchQuery.length > 0 &&
              config.name.toLocaleLowerCase().includes(normalizedSearchQuery);
            const visibleTree = connectionMatches
              ? tree
              : filterDatabaseTree(tree, normalizedSearchQuery);

            return (
              <div key={config.id}>
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div>
                      <TreeItem
                        icon={
                          connecting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          ) : (
                            <DbIcon name="connection" className="h-3.5 w-3.5" />
                          )
                        }
                        label={config.name}
                        badge={connecting ? "连接中" : connected ? "已连接" : "离线"}
                        badgeVariant={connecting ? "warning" : connected ? "success" : "muted"}
                        badgeDot
                        defaultOpen={connected || Boolean(searchQuery.trim())}
                        forceOpen={Boolean(searchQuery.trim())}
                        onClick={() => {
                          if (connecting) return;
                          if (!connected) {
                            void connect(config).catch(() => undefined);
                          } else {
                            setSelectedConnectionId(config.id);
                          }
                        }}
                        actions={
                          connected
                            ? [
                                {
                                  icon: <DbIcon name="refresh" className="h-3 w-3" />,
                                  label: "刷新连接树",
                                  onClick: () => refreshTree(config.id),
                                },
                                {
                                  icon: <Unplug className="h-3 w-3" />,
                                  label: "断开连接",
                                  onClick: () => disconnect(config.id),
                                },
                              ]
                            : undefined
                        }
                      >
                        {connected && visibleTree.length > 0 && (
                          <>
                            {visibleTree.map((db) => (
                              <DatabaseNode
                                key={db.name}
                                node={db}
                                connectionId={config.id}
                                onOpenDatabase={openObjectList}
                                onSelectTable={(dbName, tableName, objectType, pinned) =>
                                  selectObject(config.id, dbName, tableName, objectType, pinned)
                                }
                                isCurrentObject={isCurrentObject}
                                searchActive={Boolean(searchQuery.trim())}
                                autoExpandKey={
                                  currentObjectKey &&
                                  selectedConnectionId === config.id &&
                                  selectedDatabase === db.name
                                    ? currentObjectKey
                                    : null
                                }
                                currentObjectKind={currentObjectKind}
                              />
                            ))}
                            <Separator className="my-1 mx-3" />
                            <AdminSection
                              onShowDashboard={() => {
                                setSelectedConnectionId(config.id);
                                refreshServerStats(config.id);
                                refreshProcesses(config.id);
                                setCurrentView("dashboard");
                              }}
                              onShowUsers={() => {
                                setSelectedConnectionId(config.id);
                                refreshUsers(config.id);
                                setCurrentView("users");
                              }}
                            />
                          </>
                        )}
                      </TreeItem>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    {connected ? (
                      <>
                        <ContextMenuItem onClick={() => refreshTree(config.id)}>
                          <DbIcon name="refresh" className="mr-2 h-3.5 w-3.5" />
                          刷新
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => disconnect(config.id)}>
                          <Unplug className="mr-2 h-3.5 w-3.5" />
                          断开连接
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => setEditConnectionConfig(config)}>
                          <Pencil className="mr-2 h-3.5 w-3.5" />
                          编辑
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => {
                            disconnect(config.id);
                            deleteConnection(config.id);
                          }}
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          删除连接
                        </ContextMenuItem>
                      </>
                    ) : (
                      <>
                        <ContextMenuItem onClick={() => void connect(config).catch(() => undefined)}>
                          <DbIcon name="connection" className="mr-2 h-3.5 w-3.5" />
                          连接
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => setEditConnectionConfig(config)}>
                          <Pencil className="mr-2 h-3.5 w-3.5" />
                          编辑
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => deleteConnection(config.id)}
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          删除连接
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              </div>
            );
          })}
          {visibleConnections.length === 0 && (
            <div className="px-3 py-5 text-center text-caption text-muted-foreground">
              {searchQuery.trim() ? "未找到匹配的连接或表" : "暂无连接"}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function DatabaseNode({
  node,
  connectionId,
  onOpenDatabase,
  onSelectTable,
  isCurrentObject,
  searchActive,
  autoExpandKey,
  currentObjectKind,
}: {
  node: DatabaseObject;
  connectionId: string;
  onOpenDatabase: OpenDatabaseAction;
  onSelectTable: (
    dbName: string,
    tableName: string,
    objectType: DbObjectKind,
    pinned?: boolean,
  ) => void;
  isCurrentObject: (
    connectionId: string,
    database: string,
    objectName: string,
    objectType: DbObjectKind,
  ) => boolean;
  searchActive: boolean;
  autoExpandKey: string | null;
  currentObjectKind?: DbObjectKind;
}) {
  const addQueryTab = useDbStore((s) => s.addQueryTab);
  const setSelectedConnectionId = useDbStore((s) => s.setSelectedConnectionId);
  const setSelectedDatabase = useDbStore((s) => s.setSelectedDatabase);
  const activeConnections = useDbStore((s) => s.activeConnections);
  const refreshTree = useDbStore((s) => s.refreshTree);
  const [dropOpen, setDropOpen] = useState(false);
  const [dropLoading, setDropLoading] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [createTableOpen, setCreateTableOpen] = useState(false);
  const [createTableName, setCreateTableName] = useState("");
  const [createTableLoading, setCreateTableLoading] = useState(false);
  const [createTableError, setCreateTableError] = useState<string | null>(null);

  const handleNewQuery = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(node.name);
    addQueryTab(connectionId, node.name);
  };

  const handleDropDatabase = async () => {
    setDropLoading(true);
    setDropError(null);
    try {
      const ipc = await import("./ipc");
      await ipc.dbExecuteQuery(connectionId, `DROP DATABASE \`${node.name}\``);
      setDropOpen(false);
      refreshTree(connectionId);
    } catch (e) {
      setDropError(String(e));
    } finally {
      setDropLoading(false);
    }
  };

  const handleCreateTable = async () => {
    if (!createTableName.trim()) return;
    setCreateTableLoading(true);
    setCreateTableError(null);
    try {
      const ipc = await import("./ipc");
      const sqlite =
        activeConnections.find((connection) => connection.id === connectionId)?.config.db_type ===
        "sqlite";
      const tableTarget = sqlite
        ? quoteIdentifier(createTableName.trim(), true)
        : `${quoteIdentifier(node.name, false)}.${quoteIdentifier(createTableName.trim(), false)}`;
      const idDefinition = sqlite ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "INT AUTO_INCREMENT PRIMARY KEY";
      const sql = `CREATE TABLE ${tableTarget} (\n  id ${idDefinition}\n)`;
      await ipc.dbExecuteQuery(connectionId, sql, undefined, node.name);
      setCreateTableOpen(false);
      setCreateTableName("");
      refreshTree(connectionId);
    } catch (e) {
      setCreateTableError(String(e));
    } finally {
      setCreateTableLoading(false);
    }
  };

  const handleCopyName = () => {
    navigator.clipboard.writeText(node.name).catch(() => {});
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <TreeItem
              icon={<DbIcon name="database" className="h-3.5 w-3.5" />}
              label={node.name}
              defaultOpen={searchActive}
              forceOpen={searchActive}
              expandKey={autoExpandKey}
              onClick={() => onOpenDatabase(connectionId, node.name)}
            >
              {node.children.map((folder) => {
                const objectType: DbObjectKind | undefined =
                  folder.name === "表" ? "table" : folder.name === "视图" ? "view" : undefined;
                const folderIcon =
                  folder.name === "表" ? (
                    <DbIcon name="table" className="h-3.5 w-3.5" />
                  ) : folder.name === "视图" ? (
                    <DbIcon name="view" className="h-3.5 w-3.5" />
                  ) : folder.name === "存储过程" ? (
                    <DbIcon name="procedure" className="h-3.5 w-3.5" />
                  ) : folder.name === "索引" ? (
                    <DbIcon name="index" className="h-3.5 w-3.5" />
                  ) : folder.name === "触发器" ? (
                    <GitBranch className="h-3.5 w-3.5" />
                  ) : folder.name === "事件" ? (
                    <CalendarClock className="h-3.5 w-3.5" />
                  ) : (
                    <FolderOpen className="h-3.5 w-3.5" />
                  );

                return (
                  <TreeItem
                    key={folder.name}
                    icon={folderIcon}
                    label={folder.name}
                    count={objectType ? folder.children.length : undefined}
                    defaultOpen={searchActive || folder.name === "表"}
                    forceOpen={searchActive}
                    expandKey={
                      autoExpandKey && objectType === currentObjectKind ? autoExpandKey : null
                    }
                    onClick={
                      objectType
                        ? () => onOpenDatabase(connectionId, node.name, objectType)
                        : undefined
                    }
                  >
                    {folder.children.map((child) => {
                      const isTable = folder.name === "表";
                      const isView = folder.name === "视图";

                      return (
                        <TableNode
                          key={child.name}
                          name={child.name}
                          dbName={node.name}
                          isTable={isTable}
                          isView={isView}
                          connectionId={connectionId}
                          onSelect={(pinned = false) => {
                            if (isTable || isView) {
                              onSelectTable(node.name, child.name, isTable ? "table" : "view", pinned);
                            }
                          }}
                          selected={
                            (isTable || isView) &&
                            isCurrentObject(
                              connectionId,
                              node.name,
                              child.name,
                              isTable ? "table" : "view",
                            )
                          }
                        />
                      );
                    })}
                    {folder.children.length === 0 && (
                      <div className="px-6 py-1 text-caption text-muted-foreground italic">
                        空
                      </div>
                    )}
                  </TreeItem>
                );
              })}
            </TreeItem>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={handleNewQuery}>
            <DbIcon name="query" className="mr-2 h-3.5 w-3.5" />
            新建查询
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setCreateTableOpen(true)}>
            <DbIcon name="add" className="mr-2 h-3.5 w-3.5" />
            新建表
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleCopyName}>
            <DbIcon name="copy" className="mr-2 h-3.5 w-3.5" />
            复制数据库名
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setDropOpen(true)}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            删除数据库
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={dropOpen} onOpenChange={setDropOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除数据库</AlertDialogTitle>
          </AlertDialogHeader>
          <p className="text-body">
            确定要删除数据库{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-caption">{node.name}</code>{" "}
            吗？此操作不可撤销，所有数据将被永久删除。
          </p>
          {dropError && <p className="text-body text-destructive">{dropError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dropLoading}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={dropLoading}
              onClick={handleDropDatabase}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {dropLoading ? "删除中..." : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={createTableOpen} onOpenChange={setCreateTableOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>新建表</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-caption font-medium text-muted-foreground">
                数据库
              </label>
              <span className="text-caption">{node.name}</span>
            </div>
            <div>
              <label className="mb-1 block text-caption font-medium text-muted-foreground">
                表名
              </label>
              <Input
                value={createTableName}
                onChange={(e) => setCreateTableName(e.target.value)}
                className="h-8 text-caption"
                placeholder="table_name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateTable();
                }}
              />
            </div>
            <p className="text-micro text-muted-foreground">
              将创建包含自增 id 主键的基础表，后续可通过 SQL 修改结构。
            </p>
            {createTableError && (
              <p className="text-body text-destructive">{createTableError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreateTableOpen(false)}
            >
              取消
            </Button>
            <Button
              size="sm"
              disabled={!createTableName.trim() || createTableLoading}
              onClick={handleCreateTable}
            >
              {createTableLoading ? "创建中..." : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TableNode({
  name,
  dbName,
  isTable,
  isView,
  connectionId,
  onSelect,
  selected,
}: {
  name: string;
  dbName: string;
  isTable: boolean;
  isView: boolean;
  connectionId: string;
  onSelect: (pinned?: boolean) => void;
  selected: boolean;
}) {
  const addQueryTab = useDbStore((s) => s.addQueryTab);
  const setSelectedConnectionId = useDbStore((s) => s.setSelectedConnectionId);
  const setSelectedDatabase = useDbStore((s) => s.setSelectedDatabase);
  const updateTabSql = useDbStore((s) => s.updateTabSql);
  const refreshTree = useDbStore((s) => s.refreshTree);
  const [dropOpen, setDropOpen] = useState(false);
  const [truncateOpen, setTruncateOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleSelectData = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    onSelect(false);
  };

  const handleNewQuery = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    const tabId = addQueryTab(connectionId, dbName);
    updateTabSql(tabId, `SELECT * FROM \`${dbName}\`.\`${name}\` LIMIT 100`);
  };

  const handleGenerateSelect = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    const tabId = addQueryTab(connectionId, dbName);
    updateTabSql(tabId, `SELECT * FROM \`${dbName}\`.\`${name}\``);
  };

  const handleGenerateInsert = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    const tabId = addQueryTab(connectionId, dbName);
    updateTabSql(tabId, `INSERT INTO \`${dbName}\`.\`${name}\`\n  ()\nVALUES\n  ();`);
  };

  const handleGenerateUpdate = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    const tabId = addQueryTab(connectionId, dbName);
    updateTabSql(tabId, `UPDATE \`${dbName}\`.\`${name}\`\nSET\n  column = value\nWHERE ;`);
  };

  const handleGenerateDelete = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    const tabId = addQueryTab(connectionId, dbName);
    updateTabSql(tabId, `DELETE FROM \`${dbName}\`.\`${name}\`\nWHERE ;`);
  };

  const handleShowDDL = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    const tabId = addQueryTab(connectionId, dbName);
    updateTabSql(tabId, `SHOW CREATE TABLE \`${dbName}\`.\`${name}\`;`);
  };

  const handleDropTable = async () => {
    setActionLoading(true);
    setActionError(null);
    try {
      const ipc = await import("./ipc");
      const sql = isTable
        ? `DROP TABLE \`${dbName}\`.\`${name}\``
        : `DROP VIEW \`${dbName}\`.\`${name}\``;
      await ipc.dbExecuteQuery(connectionId, sql, undefined, dbName);
      setDropOpen(false);
      refreshTree(connectionId);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setActionLoading(false);
    }
  };

  const handleTruncateTable = async () => {
    setActionLoading(true);
    setActionError(null);
    try {
      const ipc = await import("./ipc");
      await ipc.dbExecuteQuery(
        connectionId,
        `TRUNCATE TABLE \`${dbName}\`.\`${name}\``,
        undefined,
        dbName,
      );
      setTruncateOpen(false);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <TreeItem
              icon={<DbIcon name={isView ? "view" : "table"} className="h-3 w-3" />}
              label={name}
              selected={selected}
              onClick={() => onSelect(false)}
              onDoubleClick={() => onSelect(true)}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={handleSelectData}>
            <DbIcon name={isView ? "view" : "table"} className="mr-2 h-3.5 w-3.5" />
            查看数据
          </ContextMenuItem>
          <ContextMenuItem onClick={handleNewQuery}>
            <DbIcon name="query" className="mr-2 h-3.5 w-3.5" />
            新建查询
          </ContextMenuItem>
          <ContextMenuItem onClick={handleShowDDL}>
            <DbIcon name="ddl" className="mr-2 h-3.5 w-3.5" />
            查看 DDL
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleGenerateSelect}>
            <DbIcon name="copy" className="mr-2 h-3.5 w-3.5" />
            生成 SELECT
          </ContextMenuItem>
          {isTable && (
            <>
              <ContextMenuItem onClick={handleGenerateInsert}>
                <DbIcon name="add" className="mr-2 h-3.5 w-3.5" />
                生成 INSERT
              </ContextMenuItem>
              <ContextMenuItem onClick={handleGenerateUpdate}>
                <Pencil className="mr-2 h-3.5 w-3.5" />
                生成 UPDATE
              </ContextMenuItem>
              <ContextMenuItem onClick={handleGenerateDelete}>
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                生成 DELETE
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                className="text-warning focus:text-warning"
                onClick={() => setTruncateOpen(true)}
              >
                <Eraser className="mr-2 h-3.5 w-3.5" />
                清空表
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setDropOpen(true)}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            {isTable ? "删除表" : "删除视图"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={dropOpen} onOpenChange={setDropOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isTable ? "删除表" : "删除视图"}</AlertDialogTitle>
          </AlertDialogHeader>
          <p className="text-body">
            确定要删除{isTable ? "表" : "视图"}{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-caption">
              {dbName}.{name}
            </code>{" "}
            吗？此操作不可撤销。
          </p>
          {actionError && <p className="text-body text-destructive">{actionError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={actionLoading}
              onClick={handleDropTable}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {actionLoading ? "删除中..." : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={truncateOpen} onOpenChange={setTruncateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空表</AlertDialogTitle>
          </AlertDialogHeader>
          <p className="text-body">
            确定要清空表{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-caption">
              {dbName}.{name}
            </code>{" "}
            的所有数据吗？此操作不可撤销。
          </p>
          {actionError && <p className="text-body text-destructive">{actionError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={actionLoading}
              onClick={handleTruncateTable}
              className="border border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"
            >
              {actionLoading ? "清空中..." : "清空"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AdminSection({
  onShowDashboard,
  onShowUsers,
}: {
  onShowDashboard: () => void;
  onShowUsers: () => void;
}) {
  const setCurrentView = useDbStore((s) => s.setCurrentView);
  const setSelectedConnectionId = useDbStore((s) => s.setSelectedConnectionId);
  const selectedConnectionId = useDbStore((s) => s.selectedConnectionId);

  const navigateTo = (view: Parameters<typeof setCurrentView>[0]) => {
    if (selectedConnectionId) {
      setSelectedConnectionId(selectedConnectionId);
    }
    setCurrentView(view);
  };

  return (
    <TreeItem
      icon={<Settings className="h-3.5 w-3.5" />}
      label="管理"
      defaultOpen={false}
    >
      <TreeItem
        icon={<LayoutDashboard className="h-3 w-3" />}
        label="仪表盘"
        onClick={onShowDashboard}
      />
      <TreeItem
        icon={<Users className="h-3 w-3" />}
        label="用户与权限"
        onClick={onShowUsers}
      />
      <TreeItem
        icon={<HardDrive className="h-3 w-3" />}
        label="备份与恢复"
        onClick={() => navigateTo("backup")}
      />
      <TreeItem
        icon={<List className="h-3 w-3" />}
        label="进程列表"
        onClick={() => navigateTo("processes")}
      />
      <TreeItem
        icon={<GitBranch className="h-3 w-3" />}
        label="主从复制"
        onClick={() => navigateTo("replication")}
      />
      <TreeItem
        icon={<FileText className="h-3 w-3" />}
        label="慢查询日志"
        onClick={() => navigateTo("slow-queries")}
      />
      <TreeItem
        icon={<Sliders className="h-3 w-3" />}
        label="变量配置"
        onClick={() => navigateTo("variables")}
      />
    </TreeItem>
  );
}

function TreeItem({
  icon,
  label,
  badge,
  badgeVariant = "success",
  badgeDot = false,
  count,
  defaultOpen = false,
  forceOpen = false,
  expandKey = null,
  onClick,
  onDoubleClick,
  selected = false,
  actions,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: string;
  badgeVariant?: "success" | "warning" | "muted";
  badgeDot?: boolean;
  count?: number;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  expandKey?: string | null;
  onClick?: () => void;
  onDoubleClick?: () => void;
  selected?: boolean;
  actions?: { icon: React.ReactNode; label?: string; onClick: () => void }[];
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasChildren = Boolean(children) && Children.count(children) > 0;

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  useEffect(() => {
    if (expandKey) setOpen(true);
  }, [expandKey]);

  return (
    <div>
      <div
        className={cn(
          "group relative flex cursor-pointer items-center gap-1.5 px-3 py-1 hover:bg-accent",
          !hasChildren && "pl-5",
          selected && "border-l-2 border-info bg-foreground/5",
        )}
        onClick={() => {
          if (hasChildren && !onClick) {
            setOpen(!open);
          }
          onClick?.();
        }}
        onDoubleClick={onDoubleClick}
      >
        {hasChildren && (
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label={`${open ? "收起" : "展开"}${label}`}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(!open);
            }}
          >
            <DbIcon
              name="chevronRight"
              className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
            />
          </Button>
        )}
        <span className="shrink-0">{icon}</span>
        <span className={cn("min-w-0 flex-1 truncate text-ui", selected && "font-medium")}>{label}</span>
        {count !== undefined && (
          <span className="shrink-0 text-micro tabular-nums text-muted-foreground">{count}</span>
        )}
        {actions && (
          <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 gap-0.5 rounded bg-card/95 px-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            {actions.map((action, i) => (
              <Button
                key={i}
                type="button"
                variant="ghost"
                size="icon"
                aria-label={action.label}
                className="pointer-events-auto h-5 w-5 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  action.onClick();
                }}
              >
                {action.icon}
              </Button>
            ))}
          </div>
        )}
        {badge && (
          badgeDot ? (
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                badgeVariant === "success"
                  ? "bg-success-indicator"
                  : badgeVariant === "warning"
                    ? "bg-warning"
                    : "bg-muted-foreground",
              )}
              title={badge}
            >
              <span className="sr-only">{badge}</span>
            </span>
          ) : (
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-caption font-normal",
                badgeVariant === "success"
                  ? "bg-success/15 text-success"
                  : badgeVariant === "warning"
                    ? "bg-warning/15 text-warning"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {badge}
            </span>
          )
        )}
      </div>
      {hasChildren && open && <div className="pl-3">{children}</div>}
    </div>
  );
}
