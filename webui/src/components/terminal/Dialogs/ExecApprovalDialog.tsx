import { useEffect } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm dark:bg-black/60">
      <div className="w-96 rounded-2xl border bg-background p-5 shadow-lg">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-5 w-5 text-warning" />
          <h3 className="text-body font-semibold">AI 请求执行命令</h3>
        </div>

        <div className="mb-3 space-y-2 text-caption text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">来源:</span>
            <span>{execApproval.source}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">会话:</span>
            <span className="font-mono text-micro">
              {execApproval.sessionId.slice(0, 8)}...
            </span>
          </div>
        </div>

        <div className="mb-4 rounded bg-muted/50 p-3">
          <p className="text-caption font-medium mb-1">命令:</p>
          <code className="text-caption font-mono break-all text-foreground">
            {execApproval.command}
          </code>
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReject}
            className="gap-1 bg-destructive/10 text-caption text-destructive hover:bg-destructive/20"
          >
            <X className="h-3 w-3" />
            拒绝
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleApprove}
            className="gap-1 bg-primary/10 text-caption text-primary hover:bg-primary/20"
          >
            <Check className="h-3 w-3" />
            批准执行
          </Button>
        </div>
      </div>
    </div>
  );
}
