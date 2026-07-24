import { Ban, CheckCircle2, FileSearch, Loader2, Lock, RotateCcw, Wrench, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  blockProcess,
  checkSystemIntegrity,
  findFileLocks,
  listBlockedProcesses,
  repairItem,
  terminateLockHolder,
  unblockProcess,
  type BlockedProcess,
  type FileLockResult,
  type RepairItem,
} from "./advancedSystemApi";
import { PanelCard, StatusPill, primaryButtonClass, secondaryButtonClass } from "./SystemUi";

export function SystemToolsPanel() {
  return (
    <div className="flex flex-col gap-4">
      <ProcessBlacklistSection />
      <FileLockSection />
      <SystemRepairSection />
    </div>
  );
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

// ===== P4 文件锁句柄 =====

function FileLockSection() {
  const [path, setPath] = useState("");
  const [result, setResult] = useState<FileLockResult | null>(null);
  const [acting, setActing] = useState(false);
  const [terminating, setTerminating] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  const handleSearch = async () => {
    const p = path.trim();
    if (!p) return;
    setActing(true);
    try {
      const r = await findFileLocks(p);
      setResult(r);
      setMessage(null);
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setActing(false);
    }
  };

  const handleTerminate = async (pid: number) => {
    setTerminating(pid);
    try {
      const detail = await terminateLockHolder(pid);
      setMessage({ text: detail, tone: "ok" });
      if (path.trim()) {
        const r = await findFileLocks(path.trim());
        setResult(r);
      }
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setTerminating(null);
    }
  };

  return (
    <PanelCard title="文件锁查询" action={<Lock className="h-4 w-4" />}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Input
            className="h-8 min-w-[120px] flex-1 rounded-lg text-xs"
            placeholder="文件或目录路径"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
          />
          <button type="button" className={primaryButtonClass} onClick={() => void handleSearch()} disabled={acting}>
            {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSearch className="h-3.5 w-3.5" />}
            查询
          </button>
        </div>

        {result && (
          <div>
            {result.holders.length > 0 ? (
              <div className="rounded-lg border border-border/60">
                {result.holders.map((holder) => (
                  <div key={holder.pid} className="flex items-center gap-2 border-b border-border/40 px-3 py-2 text-xs last:border-b-0">
                    <Lock className="h-3 w-3 text-amber-500" />
                    <span className="font-mono text-[11px]">PID={holder.pid}</span>
                    <span className="min-w-0 flex-1 truncate">{holder.name}</span>
                    {holder.path && <span className="max-w-[200px] truncate text-[10px] text-muted-foreground" title={holder.path}>{holder.path}</span>}
                    <button
                      type="button"
                      className={cn(secondaryButtonClass, "text-red-600 hover:bg-red-500/10")}
                      onClick={() => void handleTerminate(holder.pid)}
                      disabled={terminating === holder.pid}
                    >
                      {terminating === holder.pid ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                      终止
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{result.detail}</p>
            )}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground/70">
          查找占用指定文件/目录的进程，支持终止占用进程以释放文件锁。
        </p>

        {message && <p className={cn("text-xs", message.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>{message.text}</p>}
      </div>
    </PanelCard>
  );
}

// ===== P5 注册表修复 =====

function SystemRepairSection() {
  const [items, setItems] = useState<RepairItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await checkSystemIntegrity());
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleRepair = async (item: RepairItem) => {
    setActing(item.id);
    try {
      const result = await repairItem(item.id);
      setMessage({
        text: result.detail + (result.requiresRestart ? "（需重启生效）" : ""),
        tone: "ok",
      });
      await refresh();
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setActing(null);
    }
  };

  const brokenCount = items.filter((i) => i.isBroken).length;

  return (
    <PanelCard title="系统完整性修复" action={<Wrench className="h-4 w-4" />}>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在检查...</div>
      ) : (
        <div className="flex flex-col gap-2">
          {brokenCount > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-[11px] text-amber-600 dark:text-amber-400">
              检测到 {brokenCount} 个系统组件异常，建议修复
            </div>
          )}
          {brokenCount === 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-2 text-[11px] text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              所有检查项正常
            </div>
          )}
          {items.map((item) => (
            <div key={item.id} className={cn(
              "flex items-center justify-between gap-3 rounded-lg border p-3",
              item.isBroken ? "border-amber-500/40 bg-amber-500/5" : "border-border/60",
            )}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold">{item.label}</span>
                  {item.isBroken ? (
                    <StatusPill tone="orange">异常</StatusPill>
                  ) : (
                    <StatusPill tone="green">正常</StatusPill>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{item.description}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground/70">{item.currentDetail}</p>
              </div>
              {item.isBroken && (
                <button
                  type="button"
                  className={primaryButtonClass}
                  onClick={() => void handleRepair(item)}
                  disabled={acting === item.id}
                >
                  {acting === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                  修复
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {message && <p className={cn("text-xs", message.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>{message.text}</p>}
    </PanelCard>
  );
}
