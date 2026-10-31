import { FileCode2, Plus } from "lucide-react";
import terminalIcon from "@/assets/icons/sidebar-terminal.png";
import databaseIcon from "@/assets/icons/sidebar-database.png";
import batchSshIcon from "@/assets/icons/sidebar-ssh-batch.png";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useDbStore } from "@/components/db/store/dbStore";
import { useTerminalStore } from "@/components/terminal/store/terminalStore";

export function OperationsCreateMenu({ onOpenTerminal, onNewQuery, queryConnectionId }: {
  onOpenTerminal: () => void;
  onNewQuery?: (connectionId: string) => void;
  queryConnectionId?: string | null;
}) {
  const connections = useDbStore((state) => state.activeConnections).filter((connection) => connection.status === "connected");
  const queryConnection = connections.find((connection) => connection.id === queryConnectionId)
    ?? (connections.length === 1 ? connections[0] : null);
  const label = onNewQuery ? "新建标签" : "新建连接";
  const handleBatch = () => {
    const { sessions, setActiveSession, addSession } = useTerminalStore.getState();
    const existing = sessions.find((session) => session.type === "batch");
    if (existing) {
      setActiveSession(existing.id);
    } else {
      addSession({
        id: crypto.randomUUID(),
        configId: "",
        type: "batch",
        status: "connected",
        title: "SSH 批量管理",
      });
    }
    onOpenTerminal();
  };

  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button type="button" variant="ghost" size="icon" className={onNewQuery ? "h-7 w-7 shrink-0" : "h-6 w-6"} aria-label={label} title={label}><Plus className="h-3.5 w-3.5" /></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem onSelect={() => useTerminalStore.getState().setNewConnectionDialogOpen(true, "ssh")}><img src={terminalIcon} alt="" draggable={false} className="mr-2 h-4 w-4 shrink-0 object-contain" />SSH 会话</DropdownMenuItem>
      {!onNewQuery && <DropdownMenuItem onSelect={() => useDbStore.getState().setNewConnectionDialogOpen(true)}><img src={databaseIcon} alt="" draggable={false} className="mr-2 h-4 w-4 shrink-0 object-contain" />数据库</DropdownMenuItem>}
      <DropdownMenuItem onSelect={handleBatch}><img src={batchSshIcon} alt="" draggable={false} className="mr-2 h-4 w-4 shrink-0 object-contain" />SSH 批量管理</DropdownMenuItem>
      {onNewQuery && (connections.length > 1 && !queryConnection ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger><FileCode2 className="mr-2 h-4 w-4" />数据库查询</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {connections.map((connection) => (
              <DropdownMenuItem key={connection.id} onSelect={() => onNewQuery(connection.id)}>
                <span>{connection.config.name}</span>
                <span className="ml-2 text-caption text-muted-foreground">{connection.config.host}:{connection.config.port}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : (
        <DropdownMenuItem disabled={!queryConnection} onSelect={() => { if (queryConnection) onNewQuery(queryConnection.id); }}>
          <FileCode2 className="mr-2 h-4 w-4" />数据库查询
          {!queryConnection && <span className="ml-2 text-caption text-muted-foreground">请先连接数据库</span>}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>;
}
