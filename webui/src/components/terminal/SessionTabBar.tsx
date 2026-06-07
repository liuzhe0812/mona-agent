import { useCallback } from "react";
import {
  Pencil,
  Copy,
  FolderOpen,
  X,
  XCircle,
  ArrowRightFromLine,
} from "lucide-react";
import { useTerminalStore } from "./store/terminalStore";
import { sshConnect, sshDisconnect, shellKill, shellSpawn, sshOpenSftp } from "./ipc";
import { isTauri } from "@/lib/tauri";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export function SessionTabBar() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const removeSession = useTerminalStore((s) => s.removeSession);
  const updateSessionStatus = useTerminalStore((s) => s.updateSessionStatus);
  const updateSessionTitle = useTerminalStore((s) => s.updateSessionTitle);
  const addSession = useTerminalStore((s) => s.addSession);
  const connections = useTerminalStore((s) => s.connections);

  const handleClose = useCallback(
    async (sessionId: string, sessionType: string) => {
      if (!isTauri()) {
        removeSession(sessionId);
        return;
      }
      try {
        if (sessionType === "ssh" || sessionType === "sftp") {
          await sshDisconnect(sessionId);
        } else if (sessionType === "local") {
          await shellKill(sessionId);
        }
      } catch {
        updateSessionStatus(sessionId, "disconnected");
      }
      removeSession(sessionId);
    },
    [removeSession, updateSessionStatus],
  );

  const handleNewShell = async () => {
    if (!isTauri()) return;
    try {
      const sessionId = await shellSpawn(80, 24);
      addSession({
        id: sessionId,
        configId: "",
        type: "local",
        status: "connected",
        title: "本地终端",
      });
    } catch {}
  };

  const handleRename = useCallback(
    (session: { id: string; title: string }) => {
      const newTitle = window.prompt("重命名标签页", session.title)?.trim();
      if (newTitle) {
        updateSessionTitle(session.id, newTitle);
      }
    },
    [updateSessionTitle],
  );

  const handleDuplicate = useCallback(
    async (session: { id: string; type: string; configId: string }) => {
      if (session.type === "ssh" || session.type === "sftp") {
        const config = connections.find((c) => c.id === session.configId);
        if (!config) return;
        try {
          const newSessionId = await sshConnect(config);
          addSession({
            id: newSessionId,
            configId: config.id,
            type: session.type,
            status: "connected",
            title: config.host,
          });
        } catch {}
      } else if (session.type === "local") {
        try {
          const newSessionId = await shellSpawn(80, 24);
          addSession({
            id: newSessionId,
            configId: "",
            type: "local",
            status: "connected",
            title: "本地终端",
          });
        } catch {}
      }
    },
    [connections, addSession],
  );

  const handleOpenSftp = useCallback(
    async (session: { id: string; configId: string }) => {
      try {
        const sftpSessionId = await sshOpenSftp(session.id);
        const config = connections.find((c) => c.id === session.configId);
        addSession({
          id: sftpSessionId,
          configId: session.configId,
          type: "sftp",
          status: "connected",
          title: config ? `SFTP ${config.host}` : "SFTP",
        });
      } catch {}
    },
    [connections, addSession],
  );

  const handleCloseOthers = useCallback(
    (keepSessionId: string) => {
      const toClose = sessions.filter((s) => s.id !== keepSessionId);
      for (const s of toClose) {
        void handleClose(s.id, s.type);
      }
    },
    [sessions, handleClose],
  );

  const handleCloseToRight = useCallback(
    (sessionId: string) => {
      const idx = sessions.findIndex((s) => s.id === sessionId);
      if (idx < 0) return;
      const toClose = sessions.slice(idx + 1);
      for (const s of toClose) {
        void handleClose(s.id, s.type);
      }
    },
    [sessions, handleClose],
  );

  return (
    <div className="flex h-8 shrink-0 items-end border-b border-border bg-sidebar/50 px-1">
      {sessions.map((session, index) => {
        const isActive = session.id === activeSessionId;
        const isSsh = session.type === "ssh";
        const canDuplicate = session.type === "ssh" || session.type === "sftp" || session.type === "local";

        return (
          <ContextMenu key={session.id}>
            <ContextMenuTrigger asChild>
              <div
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs transition-colors cursor-pointer select-none relative ${
                  index > 0 ? "border-l border-border" : ""
                } ${
                  isActive
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50"
                }`}
                onClick={() => setActiveSession(session.id)}
              >
                {isActive && (
                  <span
                    className="absolute bottom-0 left-0 right-0 h-0.5"
                    style={{ backgroundColor: "hsl(var(--theme))" }}
                  />
                )}
                <span
                  className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                    session.type === "local"
                      ? "bg-amber-500"
                      : session.status === "connected"
                        ? "bg-emerald-500"
                        : session.status === "connecting"
                          ? "bg-amber-500"
                          : session.status === "error"
                            ? "bg-red-500"
                            : "bg-muted-foreground/40"
                  }`}
                />
                <span className="max-w-[120px] truncate">{session.title}</span>
                <X
                  className="h-3 w-3 shrink-0 opacity-0 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClose(session.id, session.type);
                  }}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <ContextMenuItem onClick={() => handleRename(session)}>
                <Pencil className="mr-2 h-3.5 w-3.5" /> 重命名
              </ContextMenuItem>
              {canDuplicate && (
                <ContextMenuItem onClick={() => handleDuplicate(session)}>
                  <Copy className="mr-2 h-3.5 w-3.5" /> 复制会话
                </ContextMenuItem>
              )}
              {isSsh && (
                <ContextMenuItem onClick={() => handleOpenSftp(session)}>
                  <FolderOpen className="mr-2 h-3.5 w-3.5" /> 打开 SFTP
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => handleClose(session.id, session.type)}>
                <X className="mr-2 h-3.5 w-3.5" /> 关闭
              </ContextMenuItem>
              <ContextMenuItem onClick={() => handleCloseOthers(session.id)}>
                <XCircle className="mr-2 h-3.5 w-3.5" /> 关闭其他
              </ContextMenuItem>
              <ContextMenuItem onClick={() => handleCloseToRight(session.id)}>
                <ArrowRightFromLine className="mr-2 h-3.5 w-3.5" /> 关闭右侧
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      <button
        onClick={handleNewShell}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent/50"
        title="新建 Shell"
      >
        <span className="text-sm leading-none">+</span>
      </button>
    </div>
  );
}
