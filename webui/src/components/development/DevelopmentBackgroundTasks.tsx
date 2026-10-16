import { useEffect, useMemo, useRef, useState } from "react";
import { Square, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipButton, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { developmentApi, type DevBackgroundCommand } from "@/lib/development-api";
import { refreshDevelopmentSession } from "./useDevelopmentSession";
import { useDevelopmentStore } from "./store";

function elapsedSeconds(command: DevBackgroundCommand, now: number) {
  const serverElapsed = Math.max(0, Math.floor(command.elapsedSeconds));
  if (command.status !== "running") return serverElapsed;
  const startedAt = Date.parse(command.startedAt);
  return Number.isFinite(startedAt)
    ? Math.max(serverElapsed, Math.floor((now - startedAt) / 1000))
    : serverElapsed;
}

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}分${String(remainder).padStart(2, "0")}秒` : `${remainder}秒`;
}

export function DevelopmentBackgroundTasks({ sessionId, commands, readonly = false }: {
  sessionId: string;
  commands: DevBackgroundCommand[];
  readonly?: boolean;
}) {
  const runningCommands = useMemo(() => commands.filter((command) => command.status === "running"), [commands]);
  const [now, setNow] = useState(() => Date.now());
  const [stoppingTarget, setStoppingTarget] = useState<{ sessionId: string; commandId: string } | null>(null);
  const [failure, setFailure] = useState<{ sessionId: string; message: string } | null>(null);
  const requestEpoch = useRef(0);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const isStopping = stoppingTarget?.sessionId === sessionId;
  const currentFailure = failure?.sessionId === sessionId ? failure : null;
  const hasRunningCommands = runningCommands.length > 0;

  useEffect(() => {
    setFailure(null);
    setStoppingTarget(null);
    return () => { requestEpoch.current += 1; };
  }, [sessionId]);

  useEffect(() => {
    if (!hasRunningCommands) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningCommands]);

  const stop = async (commandId: string) => {
    if (readonly || isStopping) return;
    const targetSession = sessionId;
    const epoch = requestEpoch.current;
    setStoppingTarget({ sessionId: targetSession, commandId });
    setFailure(null);
    try {
      const stopped = await developmentApi.stopCommand(targetSession, commandId);
      if (sessionRef.current !== targetSession || requestEpoch.current !== epoch) return;
      const state = useDevelopmentStore.getState();
      const snapshot = state.snapshots[targetSession];
      if (snapshot?.backgroundCommands) {
        const updatedCommand: DevBackgroundCommand = {
          id: stopped.id,
          command: stopped.command,
          cwd: stopped.cwd,
          startedAt: stopped.startedAt,
          elapsedSeconds: stopped.elapsedSeconds,
          status: stopped.status,
          exitCode: stopped.exitCode,
        };
        state.setSnapshot(targetSession, {
          ...snapshot,
          backgroundCommands: snapshot.backgroundCommands.map((command) => command.id === commandId ? updatedCommand : command),
        });
      }
      refreshDevelopmentSession(targetSession);
    } catch (cause) {
      if (sessionRef.current !== targetSession || requestEpoch.current !== epoch) return;
      setFailure({
        sessionId: targetSession,
        message: `${commands.find((command) => command.id === commandId)?.command ?? commandId}：${cause instanceof Error ? cause.message : "停止命令失败，请稍后重试。"}`,
      });
    } finally {
      if (sessionRef.current === targetSession && requestEpoch.current === epoch) setStoppingTarget(null);
    }
  };

  return <>
    {hasRunningCommands && <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TooltipButton
          type="button"
          variant="ghost"
          size="sm"
          title="查看运行中的终端命令"
          aria-label={`运行中的终端命令：${runningCommands.length}`}
          className="gap-1 px-1.5 text-caption tabular-nums text-muted-foreground"
        >
          <SquareTerminal className="h-4 w-4" aria-hidden="true" />
          <span>{runningCommands.length}</span>
        </TooltipButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-80 w-[min(28rem,calc(100vw-2rem))] overflow-y-auto">
        {runningCommands.map((command, index) => <div key={command.id}>
          {index > 0 && <DropdownMenuSeparator />}
          <div className="flex min-w-0 items-center gap-1">
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    onSelect={() => useDevelopmentStore.getState().setSide(sessionId, {
                      tab: "terminal",
                      terminalMode: "agent",
                      backgroundCommandId: command.id,
                      expanded: true,
                    })}
                    className="min-w-0 flex-1 gap-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-caption">{command.command}</span>
                    <span className="shrink-0 text-caption tabular-nums text-muted-foreground">运行 {formatElapsed(elapsedSeconds(command, now))}</span>
                  </DropdownMenuItem>
                </TooltipTrigger>
                <TooltipContent side="right">{command.command}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {!readonly && <DropdownMenuItem
              aria-label={`停止命令：${command.command}`}
              disabled={isStopping}
              onSelect={() => void stop(command.id)}
              className="shrink-0 text-destructive focus:text-destructive"
            >
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
              <span>停止</span>
            </DropdownMenuItem>}
          </div>
        </div>)}
      </DropdownMenuContent>
    </DropdownMenu>}

    <Dialog open={!!currentFailure} onOpenChange={(open) => { if (!open) setFailure(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>停止命令失败</DialogTitle>
          <DialogDescription>{currentFailure?.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setFailure(null)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

