import { Ban, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  blockProcess,
  listBlockedProcesses,
  unblockProcess,
  type BlockedProcess,
} from "./advancedSystemApi";
import { PanelCard, primaryButtonClass, secondaryButtonClass } from "./SystemUi";

export function ProcessBlacklistPanel() {
  return <ProcessBlacklistSection />;
}

// ===== P4 进程黑名单 =====

function ProcessBlacklistSection() {
  const [blocked, setBlocked] = useState<BlockedProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setBlocked(await listBlockedProcesses());
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleBlock = async () => {
    const name = newName.trim();
    if (!name) return;
    setActing(true);
    try {
      const result = await blockProcess(name);
      setMessage({ text: result.detail, tone: "ok" });
      setNewName("");
      await refresh();
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setActing(false);
    }
  };

  const handleUnblock = async (exeName: string) => {
    setActing(true);
    try {
      const result = await unblockProcess(exeName);
      setMessage({ text: result.detail, tone: "ok" });
      await refresh();
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setActing(false);
    }
  };

  return (
    <PanelCard title="进程黑名单" action={<Ban className="h-4 w-4" />}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Input
            className="h-8 min-w-[120px] flex-1 rounded-lg text-xs"
            placeholder="进程名（如 notepad.exe）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleBlock(); }}
          />
          <button type="button" className={primaryButtonClass} onClick={() => void handleBlock()} disabled={acting}>
            {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
            阻止
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取...</div>
        ) : blocked.length > 0 ? (
          <div className="rounded-lg border border-border/60">
            {blocked.map((proc) => (
              <div key={proc.exeName} className="flex items-center gap-2 border-b border-border/40 px-3 py-2 text-xs last:border-b-0">
                <Ban className="h-3 w-3 text-red-500" />
                <span className="min-w-0 flex-1 truncate font-mono">{proc.exeName}</span>
                <button
                  type="button"
                  className={secondaryButtonClass}
                  onClick={() => void handleUnblock(proc.exeName)}
                  disabled={acting}
                >
                  <RotateCcw className="h-3 w-3" />
                  解除
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">没有阻止任何进程</p>
        )}

        <p className="text-[10px] text-muted-foreground/70">
          通过 IFEO（Image File Execution Options）劫持阻止 exe 启动。系统关键进程被保护，不允许阻止。
        </p>

        {message && <p className={cn("text-xs", message.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>{message.text}</p>}
      </div>
    </PanelCard>
  );
}
