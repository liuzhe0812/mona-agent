import { lazy, Suspense, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { isTauri } from "@/lib/tauri";
import { useDevelopmentStore } from "./store";
import { checkDevelopmentTerminal, startDevelopmentTerminal, stopDevelopmentTerminal } from "./terminal-lifecycle";

const LocalTerminal = lazy(() => import("@/components/deliver/SidebarLocalTerminal").then((m) => ({ default: m.SidebarLocalTerminal })));

export function DevelopmentLocalTerminal({ sessionId, directory, visible }: { sessionId: string; directory: string; visible: boolean }) {
  const terminal = useDevelopmentStore((s) => s.terminals[sessionId]);
  useEffect(() => {
    if (visible && isTauri()) void checkDevelopmentTerminal(sessionId);
  }, [sessionId, terminal?.id, visible]);
  const reopen = async () => {
    await stopDevelopmentTerminal(sessionId);
    if (!useDevelopmentStore.getState().terminals[sessionId]) await startDevelopmentTerminal(sessionId, directory);
  };
  if (!terminal) return <div className="space-y-3 p-4 text-ui">
    <p className="text-muted-foreground">手动终端与 Agent 的执行记录独立，初始目录为当前项目。</p>
    <Button variant="outline" disabled={!isTauri()} onClick={() => void startDevelopmentTerminal(sessionId, directory)}>打开本地终端</Button>
  </div>;
  return <div className="flex h-full min-h-0 flex-col">
    {(terminal.status === "exited" || terminal.status === "closing" || terminal.error) && <div className="shrink-0 space-y-2 border-b border-border/60 px-3 py-2 text-caption">
      <p role={terminal.error ? "alert" : "status"} className={terminal.error ? "text-destructive" : "text-muted-foreground"}>
        {terminal.error || (terminal.status === "closing" ? "正在结束此终端…" : "终端已退出，保留最后输出。")}
      </p>
      {terminal.status === "exited" && <Button variant="outline" size="sm" onClick={() => void reopen()}>重新打开终端</Button>}
      {terminal.error && terminal.id && <Button variant="outline" size="sm" onClick={() => void checkDevelopmentTerminal(sessionId)}>核对终端状态</Button>}
    </div>}
    <div className="min-h-0 flex-1"><Suspense fallback={<p className="p-3 text-caption">正在读取终端…</p>}>
      <LocalTerminal sessionId={terminal.id} status={terminal.id ? "ready" : terminal.status === "error" ? "error" : "opening"}
        error={terminal.error} interceptSsh={false} readOnly={terminal.status !== "ready"}
        onRetry={() => void startDevelopmentTerminal(sessionId, directory)} />
    </Suspense></div>
  </div>;
}
