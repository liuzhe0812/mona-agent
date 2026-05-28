import { X } from "lucide-react";
import { useTerminalStore } from "./store/terminalStore";
import { sshDisconnect, shellKill, shellSpawn } from "./ipc";
import { isTauri } from "@/lib/tauri";

export function SessionTabBar() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const removeSession = useTerminalStore((s) => s.removeSession);
  const updateSessionStatus = useTerminalStore((s) => s.updateSessionStatus);
  const addSession = useTerminalStore((s) => s.addSession);

  const handleClose = async (sessionId: string, sessionType: string) => {
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
  };

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

  return (
    <div className="flex h-8 shrink-0 items-end border-b border-border bg-sidebar/50 px-1">
      {sessions.map((session, index) => {
        const isActive = session.id === activeSessionId;
        return (
          <div
            key={session.id}
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
