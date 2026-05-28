import { X } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";

export function BatchTabBar() {
  const sessions = useTerminalStore((s) => s.sessions);
  const batchSelectedIds = useTerminalStore((s) => s.batchSelectedIds);
  const batchActiveTabId = useTerminalStore((s) => s.batchActiveTabId);
  const setBatchActiveTabId = useTerminalStore((s) => s.setBatchActiveTabId);

  const selectedSessions = sessions.filter((s) => batchSelectedIds.has(s.id));

  if (selectedSessions.length === 0) return null;

  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b bg-sidebar/50 px-1">
      <button
        onClick={() => setBatchActiveTabId(null)}
        className={`rounded px-2.5 py-1 text-xs transition-colors ${
          batchActiveTabId === null
            ? "bg-background text-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/50"
        }`}
      >
        全部
      </button>
      {selectedSessions.map((session) => (
        <button
          key={session.id}
          onClick={() => setBatchActiveTabId(session.id)}
          className={`group flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors ${
            session.id === batchActiveTabId
              ? "bg-background text-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/50"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              session.status === "connected"
                ? "bg-emerald-500"
                : session.status === "error"
                  ? "bg-red-500"
                  : "bg-muted-foreground/40"
            }`}
          />
          <span className="max-w-[100px] truncate">{session.title}</span>
          <X
            className="h-3 w-3 opacity-0 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              if (batchActiveTabId === session.id) {
                setBatchActiveTabId(null);
              }
            }}
          />
        </button>
      ))}
    </div>
  );
}
