import { LoaderCircle, SquareTerminal } from "lucide-react";

import { XtermTerminal } from "@/components/terminal/XtermTerminal";
import { Button } from "@/components/ui/button";

interface SidebarLocalTerminalProps {
  sessionId?: string;
  status?: "opening" | "ready" | "error";
  error?: string;
  onRetry: () => void;
}

export function SidebarLocalTerminal({
  sessionId,
  status = "opening",
  error,
  onRetry,
}: SidebarLocalTerminalProps) {
  if (status === "ready" && sessionId) {
    return (
      <div className="h-full min-h-0 bg-[#1a1a1a] p-1">
        <XtermTerminal sessionId={sessionId} />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#1a1a1a] px-6 text-center text-sm text-zinc-300">
        <SquareTerminal className="h-7 w-7 text-zinc-500" />
        <p>{error || "本地终端启动失败"}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          重新打开
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center gap-2 bg-[#1a1a1a] text-sm text-zinc-400">
      <LoaderCircle className="h-4 w-4 animate-spin" />
      正在打开本地终端…
    </div>
  );
}
