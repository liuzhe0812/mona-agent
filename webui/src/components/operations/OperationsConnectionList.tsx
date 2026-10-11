import terminalIcon from "@/assets/icons/sidebar-terminal.png";
import databaseIcon from "@/assets/icons/sidebar-database.png";
import { cn } from "@/lib/utils";
import { openSavedConnection } from "@/components/terminal/saved-connection";
import { useTerminalStore } from "@/components/terminal/store/terminalStore";
import { useDbStore } from "@/components/db/store/dbStore";

export function OperationsConnectionList({ onOpenTerminal }: { onOpenTerminal: () => void }) {
  const sshConnections = useTerminalStore((state) => state.savedConnections)
    .filter((connection) => connection.protocol === "ssh");
  const sshSessions = useTerminalStore((state) => state.sessions);
  const dbConnections = useDbStore((state) => state.savedConnections);
  const activeDbConnections = useDbStore((state) => state.activeConnections);
  const connectingDbId = useDbStore((state) => state.connectingId);
  const connectDb = useDbStore((state) => state.connect);

  const openSsh = (config: (typeof sshConnections)[number]) => {
    const existing = sshSessions.find((session) => session.type === "ssh" && session.configId === config.id);
    if (existing) useTerminalStore.getState().setActiveSession(existing.id);
    else openSavedConnection(config);
    onOpenTerminal();
  };

  const activateDb = (config: (typeof dbConnections)[number]) => {
    const connected = activeDbConnections.some((connection) => connection.id === config.id);
    useDbStore.setState({
      objectScope: null,
      selectedConnectionId: config.id,
      selectedDatabase: null,
      selectedTable: null,
      currentView: "objects",
    });
    if (!connected) void connectDb(config).catch(() => undefined);
  };

  const rows = [
    ...sshConnections.map((config) => {
      const sessions = sshSessions.filter((session) => session.type === "ssh" && session.configId === config.id);
      const connected = sessions.some((session) => session.status === "connected");
      const connecting = sessions.some((session) => session.status === "connecting");
      return {
        key: `ssh:${config.id}`,
        name: config.name || config.host,
        type: "SSH",
        host: config.host,
        user: config.username,
        connected,
        connecting,
        icon: terminalIcon,
        onDoubleClick: () => openSsh(config),
      };
    }),
    ...dbConnections.map((config) => {
      const connected = activeDbConnections.some((connection) => connection.id === config.id);
      return {
        key: `db:${config.id}`,
        name: config.name,
        type: config.db_type === "mysql" ? "MySQL" : config.db_type === "sqlite" ? "SQLite" : config.db_type,
        host: config.db_type === "sqlite" ? config.host : `${config.host}:${config.port}`,
        user: config.username || "—",
        connected,
        connecting: connectingDbId === config.id,
        icon: databaseIcon,
        onDoubleClick: () => activateDb(config),
      };
    }),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-caption font-medium text-foreground">连接列表</span>
        <span className="text-caption text-muted-foreground">共 {rows.length} 个连接</span>
      </div>
      <div role="table" aria-label="主机列表" className="min-h-0 flex-1 overflow-auto">
        <div role="row" className="grid h-8 grid-cols-[minmax(180px,1.4fr)_100px_minmax(160px,1fr)_120px_90px] items-center border-b border-border px-3 text-caption text-muted-foreground">
          <span role="columnheader">名称</span>
          <span role="columnheader">类型</span>
          <span role="columnheader">Host</span>
          <span role="columnheader">User</span>
          <span role="columnheader">状态</span>
        </div>
        {rows.map((row) => (
          <div
            key={row.key}
            role="row"
            tabIndex={0}
            onDoubleClick={row.onDoubleClick}
            className="grid min-h-9 cursor-default grid-cols-[minmax(180px,1.4fr)_100px_minmax(160px,1fr)_120px_90px] items-center border-b border-border/60 px-3 text-ui hover:bg-accent"
          >
            <span role="cell" className="flex min-w-0 items-center gap-2">
              <img src={row.icon} alt="" draggable={false} className="h-5 w-5 shrink-0 object-contain" />
              <span className="truncate">{row.name}</span>
            </span>
            <span role="cell" className="text-muted-foreground">{row.type}</span>
            <span role="cell" className="truncate">{row.host}</span>
            <span role="cell" className="truncate">{row.user}</span>
            <span role="cell" className="flex items-center gap-1.5">
              <span className={cn("h-1.5 w-1.5 rounded-full", row.connected ? "bg-success-indicator" : row.connecting ? "bg-warning" : "bg-muted-foreground/40")} />
              <span className="text-caption text-muted-foreground">
                {row.connected ? "已连接" : row.connecting ? "连接中" : "未连接"}
              </span>
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="flex h-32 items-center justify-center text-caption text-muted-foreground">暂无连接</div>
        )}
      </div>
    </div>
  );
}
