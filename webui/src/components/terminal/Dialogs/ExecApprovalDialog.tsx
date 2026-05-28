import { useEffect } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { onTerminalExecRequest, terminalRespondExec } from "../ipc";

export function ExecApprovalDialog() {
  const execApproval = useTerminalStore((s) => s.execApproval);
  const closeExecApproval = useTerminalStore((s) => s.closeExecApproval);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onTerminalExecRequest((event) => {
      useTerminalStore.getState().showExecApproval({
        requestId: event.requestId,
        sessionId: event.sessionId,
        command: event.command,
        source: event.source,
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  if (!execApproval.open) return null;

  const handleApprove = async () => {
    try {
      await terminalRespondExec(execApproval.requestId, true);
    } catch {}
    closeExecApproval();
  };

  const handleReject = async () => {
    try {
      await terminalRespondExec(execApproval.requestId, false, "User rejected");
    } catch {}
    closeExecApproval();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-96 rounded-lg border bg-background p-5 shadow-xl">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          <h3 className="text-sm font-semibold">AI 请求执行命令</h3>
        </div>

        <div className="mb-3 space-y-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">来源:</span>
            <span>{execApproval.source}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">会话:</span>
            <span className="font-mono text-[11px]">
              {execApproval.sessionId.slice(0, 8)}...
            </span>
          </div>
        </div>

        <div className="mb-4 rounded bg-muted/50 p-3">
          <p className="text-xs font-medium mb-1">命令:</p>
          <code className="text-xs font-mono break-all text-foreground">
            {execApproval.command}
          </code>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={handleReject}
            className="flex items-center gap-1 rounded px-3 py-1.5 text-xs font-medium
              bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
          >
            <X className="h-3 w-3" />
            拒绝
          </button>
          <button
            onClick={handleApprove}
            className="flex items-center gap-1 rounded px-3 py-1.5 text-xs font-medium
              bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            <Check className="h-3 w-3" />
            批准执行
          </button>
        </div>
      </div>
    </div>
  );
}
