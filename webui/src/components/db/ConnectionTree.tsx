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
  Pencil,
  Trash2,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { StatusNotice } from "@/components/ui/status-notice";
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
import { DatabaseContextMenu } from "./DatabaseContextMenu";
import { DatabaseSettingsDialog } from "./DatabaseSettingsDialog";
import { DatabaseActionIcon } from "./DatabaseActionIcon";
import { RoutineContextMenu } from "./RoutineContextMenu";
import { TableFolderContextMenu } from "./TableFolderContextMenu";
import { TableContextMenu } from "./TableContextMenu";

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
  const [searchOpen, setSearchOpen] = useState(false);
  const [createDatabaseConnectionId, setCreateDatabaseConnectionId] = useState<string | null>(null);

  const isConnected = (id: string) => activeConnections.some((c) => c.id === id);
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };
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
  const [highlightedObjectKey, setHighlightedObjectKey] = useState(currentObjectKey);
  useEffect(() => setHighlightedObjectKey(currentObjectKey), [currentObjectKey]);

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
    setHighlightedObjectKey(`${connectionId}:${database}:${objectType}:${tableName}`);
    if (!pinned) return;
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
    highlightedObjectKey === `${connectionId}:${database}:${objectType}:${objectName}`;

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
    <div className="relative flex h-full flex-col bg-card text-foreground">
      <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-2">
        <span className="text-caption font-semibold uppercase tracking-wider text-muted-foreground">
          连接
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label="搜索连接或表"
            aria-pressed={searchOpen}
            onClick={() => setSearchOpen(true)}
          >
            <DbIcon name="search" className="h-3.5 w-3.5" />
          </Button>
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
      {searchOpen && (
        <div className="absolute left-2 right-2 top-11 z-30 rounded-md border border-border bg-popover p-1 shadow-float">
          <div className="relative">
            <DbIcon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              aria-label="搜索连接或表"
              className="h-9 pl-9 pr-2 text-ui"
              onBlur={() => window.setTimeout(closeSearch, 0)}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); }}
              placeholder="搜索连接或表"
              value={searchQuery}
            />
          </div>
        </div>
      )}
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
                            <DbIcon
                              name={
                                config.db_type === "mysql"
                                  ? "mysql"
                                  : config.db_type === "sqlite"
                                    ? "sqlite"
                                    : "connection"
                              }
                              className="h-5 w-5"
                            />
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
                        {config.db_type === "mysql" && <ContextMenuItem onSelect={() => setCreateDatabaseConnectionId(config.id)}>
                          <DatabaseActionIcon action="create" className="mr-2" />新建数据库
                        </ContextMenuItem>}
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
      {createDatabaseConnectionId && <DatabaseSettingsDialog connectionId={createDatabaseConnectionId}
        onClose={() => setCreateDatabaseConnectionId(null)} onSaved={() => { void refreshTree(createDatabaseConnectionId); }} />}
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
  return (
            <TreeItem
              icon={<DbIcon name="database" className="h-5 w-5" />}
              label={node.name}
              defaultOpen={searchActive}
              forceOpen={searchActive}
              expandKey={autoExpandKey}
              onClick={() => onOpenDatabase(connectionId, node.name)}
              rowWrapper={(row) => <DatabaseContextMenu connectionId={connectionId} database={node.name}>{row}</DatabaseContextMenu>}
            >
              {node.children.map((folder) => {
                const isRoutineFolder = folder.name === "存储过程/函数";
                const isQueryFolder = folder.name === "查询";
                const objectType: DbObjectKind | undefined =
                  folder.name === "表" ? "table" : folder.name === "视图" ? "view" : undefined;
                const folderIcon =
                  folder.name === "表" ? (
                    <DbIcon name="table" className="h-5 w-5" />
                  ) : folder.name === "视图" ? (
                    <DbIcon name="view" className="h-5 w-5" />
                  ) : isQueryFolder ? (
                    <DbIcon name="query" className="h-5 w-5" />
                  ) : isRoutineFolder ? (
                    <DbIcon name="procedure" className="h-5 w-5" />
                  ) : (
                    <FolderOpen className="h-3.5 w-3.5" />
                  );

                return (
                  <TreeItem
                    key={folder.name}
                    icon={folderIcon}
                    label={folder.name}
                    count={objectType || isQueryFolder || isRoutineFolder ? folder.children.length : undefined}
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
                    rowWrapper={
                      objectType === "table"
                        ? (row) => <TableFolderContextMenu connectionId={connectionId} database={node.name}>{row}</TableFolderContextMenu>
                        : isRoutineFolder
                          ? (row) => <RoutineContextMenu connectionId={connectionId} database={node.name}>{row}</RoutineContextMenu>
                          : undefined
                    }
                  >
                    {folder.children.map((child) => {
                      const isTable = folder.name === "表";
                      const isView = folder.name === "视图";

                      if (isQueryFolder && child.id) {
                        return <TreeItem
                          key={child.id}
                          icon={<DbIcon name="query" className="h-4 w-4" />}
                          label={child.name}
                          onClick={() => useDbStore.getState().openSavedQuery(child.id!)}
                        />;
                      }

                      if (isRoutineFolder && (child.object_type === "procedure" || child.object_type === "function")) {
                        const routineType = child.object_type;
                        return <TreeItem
                          key={`${child.object_type}:${child.name}`}
                          icon={<DbIcon name="procedure" className="h-4 w-4" />}
                          label={child.name}
                          rowWrapper={(row) => <RoutineContextMenu connectionId={connectionId} database={node.name} routine={{ name: child.name, type: routineType }}>{row}</RoutineContextMenu>}
                        />;
                      }

                      return (
                        <TableNode
                          key={child.name}
                          name={child.name}
                          dbName={node.name}
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
  );
}

function TableNode({
  name,
  dbName,
  isView,
  connectionId,
  onSelect,
  selected,
}: {
  name: string;
  dbName: string;
  isView: boolean;
  connectionId: string;
  onSelect: (pinned?: boolean) => void;
  selected: boolean;
}) {
  const refreshTree = useDbStore((s) => s.refreshTree);
  return (
    <TableContextMenu connectionId={connectionId} database={dbName} table={name}
      objectType={isView ? "view" : "table"} onOpen={() => onSelect(true)}
      onRefresh={() => { void refreshTree(connectionId); }}>
      <div>
        <TreeItem
          icon={<DbIcon name={isView ? "view" : "table"} className="h-5 w-5" />}
          label={name}
          selected={selected}
          onClick={() => onSelect(false)}
          onDoubleClick={() => onSelect(true)}
        />
      </div>
    </TableContextMenu>
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
  rowWrapper,
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
  rowWrapper?: (row: React.ReactElement) => React.ReactNode;
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

  const row = (
      <div
        className={cn(
          "group relative flex min-h-8 cursor-pointer items-center gap-2 px-3 py-1 hover:bg-accent data-[state=open]:bg-accent",
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
        {!hasChildren && !badge && (
          <span aria-hidden="true" data-tree-leaf-indent className="h-3 w-3 shrink-0" />
        )}
        <span className="shrink-0">{icon}</span>
        {badgeDot ? (
          <>
            <span className={cn("max-w-48 truncate text-ui", selected && "font-medium")}>{label}</span>
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
            <span className="min-w-0 flex-1" />
          </>
        ) : (
          <span className={cn("min-w-0 flex-1 truncate text-ui", selected && "font-medium")}>{label}</span>
        )}
        {count !== undefined && (
          <span className="shrink-0 text-micro tabular-nums text-muted-foreground">{count}</span>
        )}
        {actions && (
          <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 gap-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            {actions.map((action, i) => (
              <Button
                key={i}
                type="button"
                variant="ghost"
                size="icon"
                aria-label={action.label}
                className="pointer-events-auto h-5 w-5 rounded-none p-0 text-muted-foreground hover:bg-transparent hover:text-foreground active:bg-transparent"
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
        {badge && !badgeDot && (
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
        )}
      </div>
  );

  return (
    <div>
      {rowWrapper ? rowWrapper(row) : row}
      {hasChildren && open && <div className="pl-3">{children}</div>}
    </div>
  );
}
