import { useState } from "react";
import { Copy, Pencil, Plug, SquarePlus, Trash2, Unplug } from "lucide-react";
import terminalIcon from "@/assets/icons/sidebar-terminal.png";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { EditConnectionDialog } from "@/components/terminal/Dialogs/EditConnectionDialog";
import { openSavedConnection } from "@/components/terminal/saved-connection";
import { useTerminalStore } from "@/components/terminal/store/terminalStore";
import type { ConnectionConfig } from "@/components/terminal/types/terminal";

export function SshConnections({ query, active, onOpen }: { query: string; active: boolean; onOpen: () => void }) {
  const saved = useTerminalStore((s) => s.savedConnections);
  const connections = useTerminalStore((s) => s.connections);
  const sessions = useTerminalStore((s) => s.sessions);
  const activeId = useTerminalStore((s) => s.activeSessionId);
  const [editing, setEditing] = useState<{ config: ConnectionConfig; mode: "edit" | "copy" } | null>(null);
  const [contextOpenId, setContextOpenId] = useState<string | null>(null);
  const configs = new Map(connections.filter((c) => c.protocol === "ssh" && sessions.some((s) => s.configId === c.id)).map((c) => [c.id, c]));
  for (const config of saved) if (config.protocol === "ssh") configs.set(config.id, config);
  const open = (config: ConnectionConfig, newSession = false) => {
    const existing = sessions.find((s) => s.type === "ssh" && s.configId === config.id && s.id === activeId)
      ?? sessions.find((s) => s.type === "ssh" && s.configId === config.id);
    if (existing && !newSession) useTerminalStore.getState().setActiveSession(existing.id);
    else openSavedConnection(config);
    onOpen();
  };
  const activateExisting = (config: ConnectionConfig) => {
    const existing = sessions.find((session) => session.type === "ssh" && session.configId === config.id && session.id === activeId)
      ?? sessions.find((session) => session.type === "ssh" && session.configId === config.id);
    if (!existing) return;
    useTerminalStore.getState().setActiveSession(existing.id);
    onOpen();
  };
  const disconnect = async (config: ConnectionConfig) => {
    const related = useTerminalStore.getState().sessions.filter((session) => session.type === "ssh" && session.configId === config.id);
    const { sshDisconnect } = await import("@/components/terminal/ipc");
    await Promise.all(related.map(async (session) => {
      try { await sshDisconnect(session.id); } catch {}
      useTerminalStore.getState().updateSessionStatus(session.id, "disconnected");
    }));
  };
  const remove = async (config: ConnectionConfig) => {
    await disconnect(config);
    for (const session of useTerminalStore.getState().sessions.filter((item) => item.type === "ssh" && item.configId === config.id)) {
      useTerminalStore.getState().removeSession(session.id);
    }
    await useTerminalStore.getState().deleteConnection(config.id);
  };
  return <>
    {[...configs.values()].filter((c) => `${c.name} ${c.host}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((config) => {
      const current = sessions.find((s) => s.configId === config.id && s.id === activeId);
      const related = sessions.filter((s) => s.configId === config.id && s.type === "ssh");
      const connected = related.some((s) => s.status === "connected");
      const connecting = related.some((s) => s.status === "connecting");
      const status = connected ? "已连接" : connecting ? "连接中" : related.some((s) => s.status === "error") ? "连接失败" : "未连接";
      const hasLiveSession = related.some((session) => session.status === "connected" || session.status === "connecting");
      const savedConfig = saved.some((item) => item.id === config.id);
      return <ContextMenu key={config.id} onOpenChange={(open) => setContextOpenId(open ? config.id : null)}>
        <ContextMenuTrigger asChild>
          <div className={cn("group relative flex min-h-8 items-center gap-1 px-3 hover:bg-accent", contextOpenId === config.id && "bg-accent", active && current && "bg-foreground/5")} data-ssh-connection={config.id}>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-ui" aria-label={`打开 SSH ${config.name || config.host}`} aria-current={active && current ? "true" : undefined}
              onClick={() => activateExisting(config)} onDoubleClick={() => open(config)}>
              <span aria-hidden="true" data-tree-expand-slot className="h-4 w-3 shrink-0" />
              <img data-tree-type-icon src={terminalIcon} alt="" draggable={false} className="h-5 w-5 shrink-0 object-contain" /><span data-tree-label className="truncate">{config.name || config.host}</span>
              <span title={status} className={cn("h-1.5 w-1.5 shrink-0 rounded-full", connected ? "bg-success-indicator" : connecting ? "bg-warning" : "bg-muted-foreground/40")}><span className="sr-only">{status}</span></span>
            </button>
            <Button variant="ghost" size="icon" disabled={!hasLiveSession} className={cn("h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-0 group-hover:disabled:opacity-35", contextOpenId === config.id && "opacity-100 disabled:opacity-35")} aria-label={`断开 SSH ${config.name || config.host}`} title={hasLiveSession ? "断开连接" : "未连接"} onClick={() => void disconnect(config)}><Unplug className="h-3 w-3" /></Button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {hasLiveSession ? <>
            <ContextMenuItem onSelect={() => open(config, true)}><SquarePlus className="mr-2 h-3.5 w-3.5" />新开 SSH 会话</ContextMenuItem>
            <ContextMenuItem onSelect={() => void disconnect(config)}><Unplug className="mr-2 h-3.5 w-3.5" />断开连接</ContextMenuItem>

          </> : <>
            <ContextMenuItem onSelect={() => open(config)}><Plug className="mr-2 h-3.5 w-3.5" />连接</ContextMenuItem>
          </>}
          {savedConfig && <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => setEditing({ config, mode: "copy" })}><Copy className="mr-2 h-3.5 w-3.5" />复制会话</ContextMenuItem>
            <ContextMenuItem onSelect={() => setEditing({ config, mode: "edit" })}><Pencil className="mr-2 h-3.5 w-3.5" />编辑</ContextMenuItem>
          </>}
          {savedConfig && <><ContextMenuSeparator /><ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => void remove(config)}><Trash2 className="mr-2 h-3.5 w-3.5" />删除连接</ContextMenuItem></>}
        </ContextMenuContent>
      </ContextMenu>;
    })}
    {editing && <EditConnectionDialog key={`${editing.mode}:${editing.config.id}`} config={editing.config} mode={editing.mode} onClose={() => setEditing(null)} />}
  </>;
}
