import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTerminalStore } from "../store/terminalStore";

export function BatchOutputArea() {
  const sessions = useTerminalStore((s) => s.sessions);
  const batchSelectedIds = useTerminalStore((s) => s.batchSelectedIds);
  const batchOutputs = useTerminalStore((s) => s.batchOutputs);
  const batchActiveTabId = useTerminalStore((s) => s.batchActiveTabId);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const displaySessions = batchActiveTabId
    ? sessions.filter((s) => s.id === batchActiveTabId)
    : sessions.filter((s) => batchSelectedIds.has(s.id));

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (displaySessions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        选择会话并执行命令以查看输出
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col gap-2 p-3">
        {displaySessions.map((session) => {
          const output = batchOutputs[session.id] ?? "";
          const isCollapsed = collapsed.has(session.id);

          return (
            <div
              key={session.id}
              className="rounded-md border bg-card text-card-foreground"
            >
              <button
                onClick={() => toggleCollapse(session.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium hover:bg-accent/50"
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                )}
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    session.status === "connected"
                      ? "bg-emerald-500"
                      : session.status === "error"
                        ? "bg-red-500"
                        : "bg-muted-foreground/40"
                  }`}
                />
                <span className="truncate">{session.title}</span>
              </button>
              {!isCollapsed && (
                <pre className="max-h-48 overflow-auto border-t bg-muted/30 px-3 py-2 font-mono text-xs leading-relaxed">
                  {output || (
                    <span className="text-muted-foreground">暂无输出</span>
                  )}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
