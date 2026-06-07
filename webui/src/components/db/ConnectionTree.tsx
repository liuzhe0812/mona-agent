import { useState } from "react";
import {
  ChevronRight,
  Database,
  FolderOpen,
  Table2,
  Eye,
  Plus,
  RefreshCw,
  Unplug,
  Settings,
  LayoutDashboard,
  Users,
  HardDrive,
  List,
  GitBranch,
  FileText,
  Sliders,
  Zap,
  Link2,
  CalendarClock,
  Pencil,
  Trash2,
  Copy,
  Terminal,
  FileCode,
  Eraser,
  Loader2,
  AlertCircle,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
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

export function ConnectionTree() {
  const savedConnections = useDbStore((s) => s.savedConnections);
  const activeConnections = useDbStore((s) => s.activeConnections);
  const connectionTree = useDbStore((s) => s.connectionTree);
  const connect = useDbStore((s) => s.connect);
  const disconnect = useDbStore((s) => s.disconnect);
  const deleteConnection = useDbStore((s) => s.deleteConnection);
  const refreshTree = useDbStore((s) => s.refreshTree);
  const selectTable = useDbStore((s) => s.selectTable);
  const setCurrentView = useDbStore((s) => s.setCurrentView);
  const setNewConnectionDialogOpen = useDbStore((s) => s.setNewConnectionDialogOpen);
  const setSelectedConnectionId = useDbStore((s) => s.setSelectedConnectionId);
  const setSelectedDatabase = useDbStore((s) => s.setSelectedDatabase);
  const refreshServerStats = useDbStore((s) => s.refreshServerStats);
  const refreshProcesses = useDbStore((s) => s.refreshProcesses);
  const refreshUsers = useDbStore((s) => s.refreshUsers);
  const connectingId = useDbStore((s) => s.connectingId);
  const connectError = useDbStore((s) => s.connectError);
  const setConnectError = useDbStore((s) => s.setConnectError);

  const isConnected = (id: string) => activeConnections.some((c) => c.id === id);

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          连接
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setNewConnectionDialogOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {connectError && (
        <div className="mx-2 mt-1 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="flex-1 break-all">{connectError}</span>
          <button
            type="button"
            onClick={() => setConnectError(null)}
            className="shrink-0 text-destructive/60 hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {savedConnections.map((config) => {
            const connected = isConnected(config.id);
            const connecting = connectingId === config.id;
            const tree = connectionTree[config.id];

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
                            <Database className="h-3.5 w-3.5" />
                          )
                        }
                        label={config.name}
                        badge={connecting ? "连接中" : connected ? "已连接" : "离线"}
                        badgeVariant={connecting ? "warning" : connected ? "success" : "muted"}
                        defaultOpen={connected}
                        onClick={() => {
                          if (connecting) return;
                          if (!connected) {
                            connect(config);
                          } else {
                            setSelectedConnectionId(config.id);
                          }
                        }}
                        actions={
                          connected
                            ? [
                                {
                                  icon: <RefreshCw className="h-3 w-3" />,
                                  onClick: () => refreshTree(config.id),
                                },
                                {
                                  icon: <Unplug className="h-3 w-3" />,
                                  onClick: () => disconnect(config.id),
                                },
                              ]
                            : undefined
                        }
                      >
                        {connected && tree && (
                          <>
                            {tree.map((db) => (
                              <DatabaseNode
                                key={db.name}
                                node={db}
                                connectionId={config.id}
                                onSelectTable={(dbName, tableName) => {
                                  setSelectedConnectionId(config.id);
                                  setSelectedDatabase(dbName);
                                  selectTable(config.id, dbName, tableName);
                                }}
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
                          <RefreshCw className="mr-2 h-3.5 w-3.5" />
                          刷新
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => disconnect(config.id)}>
                          <Unplug className="mr-2 h-3.5 w-3.5" />
                          断开连接
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
                        <ContextMenuItem onClick={() => connect(config)}>
                          <Database className="mr-2 h-3.5 w-3.5" />
                          连接
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
        </div>
      </ScrollArea>
    </div>
  );
}

function DatabaseNode({
  node,
  connectionId,
  onSelectTable,
}: {
  node: DatabaseObject;
  connectionId: string;
  onSelectTable: (dbName: string, tableName: string) => void;
}) {
  const addQueryTab = useDbStore((s) => s.addQueryTab);
  const setSelectedConnectionId = useDbStore((s) => s.setSelectedConnectionId);
  const setSelectedDatabase = useDbStore((s) => s.setSelectedDatabase);
  const updateTabSql = useDbStore((s) => s.updateTabSql);
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
    const tabId = addQueryTab();
    updateTabSql(tabId, `USE \`${node.name}\`;\n`);
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
      const sql = `CREATE TABLE \`${node.name}\`.\`${createTableName.trim()}\` (\n  id INT AUTO_INCREMENT PRIMARY KEY\n)`;
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
              icon={<FolderOpen className="h-3.5 w-3.5" />}
              label={node.name}
              defaultOpen={false}
            >
              {node.children.map((folder) => {
                const folderIcon =
                  folder.name === "表" ? (
                    <Table2 className="h-3.5 w-3.5" />
                  ) : folder.name === "视图" ? (
                    <Eye className="h-3.5 w-3.5" />
                  ) : folder.name === "存储过程" ? (
                    <Zap className="h-3.5 w-3.5" />
                  ) : folder.name === "索引" ? (
                    <Link2 className="h-3.5 w-3.5" />
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
                    defaultOpen={folder.name === "表"}
                  >
                    {folder.children.map((child) => {
                      const isTable = folder.name === "表";
                      const isView = folder.name === "视图";

                      return (
                        <TableNode
                          key={child.name}
                          name={child.name}
                          dbName={node.name ?? ""}
                          isTable={isTable}
                          isView={isView}
                          connectionId={connectionId}
                          onSelect={() => onSelectTable(node.name ?? "", child.name)}
                        />
                      );
                    })}
                    {folder.children.length === 0 && (
                      <div className="px-6 py-1 text-xs text-muted-foreground italic">
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
            <Terminal className="mr-2 h-3.5 w-3.5" />
            新建查询
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setCreateTableOpen(true)}>
            <Plus className="mr-2 h-3.5 w-3.5" />
            新建表
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleCopyName}>
            <Copy className="mr-2 h-3.5 w-3.5" />
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
          <p className="text-sm">
            确定要删除数据库{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[12px]">{node.name}</code>{" "}
            吗？此操作不可撤销，所有数据将被永久删除。
          </p>
          {dropError && <p className="text-sm text-destructive">{dropError}</p>}
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
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                数据库
              </label>
              <span className="text-[12px]">{node.name}</span>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                表名
              </label>
              <input
                value={createTableName}
                onChange={(e) => setCreateTableName(e.target.value)}
                className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-ring"
                placeholder="table_name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateTable();
                }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              将创建包含自增 id 主键的基础表，后续可通过 SQL 修改结构。
            </p>
            {createTableError && (
              <p className="text-sm text-destructive">{createTableError}</p>
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
  connectionId,
  onSelect,
}: {
  name: string;
  dbName: string;
  isTable: boolean;
  isView: boolean;
  connectionId: string;
  onSelect: () => void;
}) {
  const addQueryTab = useDbStore((s) => s.addQueryTab);
  const setSelectedConnectionId = useDbStore((s) => s.setSelectedConnectionId);
  const setSelectedDatabase = useDbStore((s) => s.setSelectedDatabase);
  const updateTabSql = useDbStore((s) => s.updateTabSql);
  const selectTable = useDbStore((s) => s.selectTable);
  const refreshTree = useDbStore((s) => s.refreshTree);
  const [dropOpen, setDropOpen] = useState(false);
  const [truncateOpen, setTruncateOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleSelectData = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    selectTable(connectionId, dbName, name);
  };

  const handleNewQuery = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    const tabId = addQueryTab();
    updateTabSql(tabId, `SELECT * FROM \`${dbName}\`.\`${name}\` LIMIT 100`);
  };

  const handleGenerateSelect = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    const tabId = addQueryTab();
    updateTabSql(tabId, `SELECT * FROM \`${dbName}\`.\`${name}\``);
  };

  const handleGenerateInsert = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    const tabId = addQueryTab();
    updateTabSql(tabId, `INSERT INTO \`${dbName}\`.\`${name}\`\n  ()\nVALUES\n  ();`);
  };

  const handleGenerateUpdate = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    const tabId = addQueryTab();
    updateTabSql(tabId, `UPDATE \`${dbName}\`.\`${name}\`\nSET\n  column = value\nWHERE ;`);
  };

  const handleGenerateDelete = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    const tabId = addQueryTab();
    updateTabSql(tabId, `DELETE FROM \`${dbName}\`.\`${name}\`\nWHERE ;`);
  };

  const handleShowDDL = () => {
    setSelectedConnectionId(connectionId);
    setSelectedDatabase(dbName);
    const tabId = addQueryTab();
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
              icon={<Table2 className="h-3 w-3 text-blue-400" />}
              label={name}
              onClick={onSelect}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={handleSelectData}>
            <Table2 className="mr-2 h-3.5 w-3.5" />
            查看数据
          </ContextMenuItem>
          <ContextMenuItem onClick={handleNewQuery}>
            <Terminal className="mr-2 h-3.5 w-3.5" />
            新建查询
          </ContextMenuItem>
          <ContextMenuItem onClick={handleShowDDL}>
            <FileCode className="mr-2 h-3.5 w-3.5" />
            查看 DDL
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={handleGenerateSelect}>
            <Copy className="mr-2 h-3.5 w-3.5" />
            生成 SELECT
          </ContextMenuItem>
          {isTable && (
            <>
              <ContextMenuItem onClick={handleGenerateInsert}>
                <Plus className="mr-2 h-3.5 w-3.5" />
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
                className="text-orange-500 focus:text-orange-500"
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
          <p className="text-sm">
            确定要删除{isTable ? "表" : "视图"}{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[12px]">
              {dbName}.{name}
            </code>{" "}
            吗？此操作不可撤销。
          </p>
          {actionError && <p className="text-sm text-destructive">{actionError}</p>}
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
          <p className="text-sm">
            确定要清空表{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[12px]">
              {dbName}.{name}
            </code>{" "}
            的所有数据吗？此操作不可撤销。
          </p>
          {actionError && <p className="text-sm text-destructive">{actionError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={actionLoading}
              onClick={handleTruncateTable}
              className="bg-orange-500 text-white hover:bg-orange-600"
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
  defaultOpen = false,
  onClick,
  actions,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: string;
  badgeVariant?: "success" | "warning" | "muted";
  defaultOpen?: boolean;
  onClick?: () => void;
  actions?: { icon: React.ReactNode; onClick: () => void }[];
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasChildren = Boolean(children);

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 px-3 py-1 cursor-pointer hover:bg-sidebar-accent group",
          !hasChildren && "pl-5",
        )}
        onClick={() => {
          if (hasChildren) {
            setOpen(!open);
          }
          onClick?.();
        }}
      >
        {hasChildren && (
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        )}
        <span className="shrink-0">{icon}</span>
        <span className="flex-1 truncate text-[13px]">{label}</span>
        {actions && (
          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {actions.map((action, i) => (
              <button
                key={i}
                className="flex h-5 w-5 items-center justify-center rounded hover:bg-sidebar-accent text-muted-foreground hover:text-sidebar-accent-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  action.onClick();
                }}
              >
                {action.icon}
              </button>
            ))}
          </div>
        )}
        {badge && (
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              badgeVariant === "success"
                ? "bg-green-500/15 text-green-500"
                : badgeVariant === "warning"
                  ? "bg-amber-500/15 text-amber-500"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {badge}
          </span>
        )}
      </div>
      {hasChildren && open && <div className="pl-3">{children}</div>}
    </div>
  );
}
