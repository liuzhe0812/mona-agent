import { History, ListChecks, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { AIChat } from "./AIChat";
import { MaintenanceHistory } from "./MaintenanceHistory";
import { MaintenanceTaskCard } from "./MaintenanceTaskCard";
import { useTerminalStore } from "../store/terminalStore";
import { terminalMaintenanceGetActive } from "../ipc";

interface Props {
  sessionId: string | null;
}

type PanelTab = "task" | "history";

export function AIPanel({ sessionId }: Props) {
  const [tab, setTab] = useState<PanelTab>("task");
  const [messageKey, setMessageKey] = useState(0);
  const setAiStreaming = useTerminalStore((s) => s.setAiStreaming);
  const setActiveMaintenanceTask = useTerminalStore((s) => s.setActiveMaintenanceTask);
  const activeTask = useTerminalStore((s) =>
    sessionId ? (s.activeMaintenanceTasks[sessionId] ?? null) : null,
  );

  // Restore the active task when the panel remounts or the session changes.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    terminalMaintenanceGetActive(sessionId)
      .then((detail) => {
        if (!cancelled) setActiveMaintenanceTask(sessionId, detail);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, setActiveMaintenanceTask]);

  const handleResetChat = useCallback(() => {
    setMessageKey((prev) => prev + 1);
    setAiStreaming(false);
  }, [setAiStreaming]);

  const handleStreamingChange = useCallback(
    (streaming: boolean) => {
      setAiStreaming(streaming);
    },
    [setAiStreaming],
  );

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/65 px-3">
        <h2 className="truncate text-[12px] font-semibold text-foreground">Mona</h2>
        <button
          type="button"
          aria-label="重置会话"
          title="重置会话"
          onClick={handleResetChat}
          className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/65 px-2">
        <PanelTabButton
          active={tab === "task"}
          onClick={() => setTab("task")}
          icon={<ListChecks className="h-3 w-3" />}
          label="当前任务"
        />
        <PanelTabButton
          active={tab === "history"}
          onClick={() => setTab("history")}
          icon={<History className="h-3 w-3" />}
          label="维护记录"
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "task" ? (
          <>
            {activeTask && (
              <div className="shrink-0 border-b border-border/50 px-2.5 py-2">
                <MaintenanceTaskCard detail={activeTask} />
              </div>
            )}
            <div className="min-h-0 flex-1">
              <AIChat
                key={messageKey}
                sessionId={sessionId}
                onStreamingChange={handleStreamingChange}
              />
            </div>
          </>
        ) : (
          <MaintenanceHistory />
        )}
      </div>
    </div>
  );
}

function PanelTabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
        active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
