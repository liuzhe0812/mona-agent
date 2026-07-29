import { AlertTriangle, CheckCircle2, Loader2, Menu, RotateCcw, Shield, ShieldOff, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import {
  applyContextMenuItem,
  applyPerformanceItem,
  disableDefender,
  enableDefender,
  getDefenderStatus,
  listContextMenuItems,
  listPerformanceItems,
  type ContextMenuItem,
  type DefenderStatus,
  type PerformanceItem,
} from "./advancedSystemApi";
import { PanelCard, StatusPill, primaryButtonClass, secondaryButtonClass } from "./SystemUi";

// ===== P2 性能微调 =====

export function PerformanceSection() {
  const [items, setItems] = useState<PerformanceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listPerformanceItems());
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleToggle = async (item: PerformanceItem) => {
    const mode = item.isApplied ? "restore" : "recommended";
    setActing(item.id);
    try {
      const result = await applyPerformanceItem(item.id, mode);
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

  return (
    <PanelCard title="性能微调" action={<Zap className="h-4 w-4" />}>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取...</div>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂无可优化的性能项。</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map((item) => {
            const isLoading = acting === item.id;
            const enabled = item.isApplied;
            return (
              <div
                key={item.id}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition",
                  enabled ? "border-blue-500/30 bg-blue-500/[0.04]" : "border-border/60",
                  isLoading && "opacity-70",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold">{item.label}</span>
                    {item.risk === "medium" && <StatusPill tone="orange">中风险</StatusPill>}
                    {item.risk === "high" && <StatusPill tone="red">高风险</StatusPill>}
                    {item.requiresReboot && <StatusPill tone="violet">需重启</StatusPill>}
                    {item.requiresAdministrator && <StatusPill tone="orange">管理员</StatusPill>}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{item.description}</p>
                  {item.currentDetail && <p className="mt-0.5 text-[10px] text-muted-foreground/70">{item.currentDetail}</p>}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`${enabled ? "恢复" : "应用"}${item.label}`}
                  disabled={isLoading}
                  onClick={() => void handleToggle(item)}
                  className={cn(
                    "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-40",
                    enabled ? "bg-blue-600 shadow-sm shadow-blue-500/25" : "bg-muted-foreground/25",
                  )}
                >
                  {isLoading
                    ? <Loader2 className="h-5 w-5 animate-spin text-white" />
                    : <span className={cn("h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-300", enabled ? "translate-x-5" : "translate-x-0")} />}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {message && <p className={cn("mt-2 text-xs", message.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>{message.text}</p>}
    </PanelCard>
  );
}

// ===== P3 右键菜单 =====

export function ContextMenuSection() {
  const [items, setItems] = useState<ContextMenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listContextMenuItems());
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleToggle = async (item: ContextMenuItem) => {
    const mode = item.isApplied ? "restore" : "recommended";
    setActing(item.id);
    try {
      const result = await applyContextMenuItem(item.id, mode);
      setMessage({ text: result.detail, tone: "ok" });
      await refresh();
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setActing(null);
    }
  };

  return (
    <PanelCard title="右键菜单集成" action={<Menu className="h-4 w-4" />}>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取...</div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <div key={item.id} className={cn(
              "flex items-center justify-between gap-3 rounded-lg border p-3",
              item.isApplied ? "border-blue-500/40 bg-blue-500/5" : "border-border/60",
            )}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold">{item.label}</span>
                  {item.isApplied && <CheckCircle2 className="h-3.5 w-3.5 text-blue-600" />}
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{item.description}</p>
              </div>
              <button
                type="button"
                className={item.isApplied ? secondaryButtonClass : primaryButtonClass}
                onClick={() => void handleToggle(item)}
                disabled={acting === item.id}
              >
                {acting === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : item.isApplied ? <RotateCcw className="h-3.5 w-3.5" /> : <Menu className="h-3.5 w-3.5" />}
                {item.isApplied ? "移除" : "添加"}
              </button>
            </div>
          ))}
        </div>
      )}
      {message && <p className={cn("text-xs", message.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>{message.text}</p>}
    </PanelCard>
  );
}

// ===== P6 Defender =====

export function DefenderSection() {
  const [status, setStatus] = useState<DefenderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getDefenderStatus());
      setConfirmed(false);
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleDisable = async () => {
    if (!confirmed) return;
    setActing(true);
    try {
      const result = await disableDefender();
      setMessage({ text: result.detail, tone: "ok" });
      await refresh();
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setActing(false);
    }
  };

  const handleEnable = async () => {
    setActing(true);
    try {
      const result = await enableDefender();
      setMessage({ text: result.detail, tone: "ok" });
      await refresh();
    } catch (error) {
      setMessage({ text: String(error), tone: "err" });
    } finally {
      setActing(false);
    }
  };

  const hasThirdParty = (status?.thirdPartyAv?.length ?? 0) > 0;
  const isDisabled = !status?.realtimeEnabled;

  return (
    <PanelCard title="Windows Defender 控制" action={<Shield className="h-4 w-4" />}>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取...</div>
      ) : status ? (
        <div className="flex flex-col gap-3">
          <div className={cn(
            "rounded-lg border p-3",
            isDisabled ? "border-red-500/40 bg-red-500/5" : "border-emerald-500/40 bg-emerald-500/5",
          )}>
            <div className="flex items-center gap-2">
              {isDisabled ? <ShieldOff className="h-4 w-4 text-red-600" /> : <Shield className="h-4 w-4 text-emerald-600" />}
              <span className="text-xs font-semibold">{isDisabled ? "实时保护已禁用" : "实时保护已启用"}</span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{status.detail}</p>
            {hasThirdParty && (
              <div className="mt-2 rounded border border-blue-500/30 bg-blue-500/5 p-2 text-[10px] text-blue-600 dark:text-blue-400">
                检测到第三方杀毒软件：{status.thirdPartyAv.join("、")}
              </div>
            )}
          </div>

          {status.realtimeEnabled ? (
            <div className="flex flex-col gap-2">
              <label className="flex items-start gap-2 text-[11px] text-muted-foreground">
                <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
                <span>
                  我已了解禁用 Defender 会降低系统安全性
                  {!hasThirdParty && <span className="font-medium text-red-600">，且当前没有第三方杀毒软件保护</span>}
                </span>
              </label>
              <button
                type="button"
                className={cn(primaryButtonClass, "border-red-500/60 bg-red-500/10 text-red-600 hover:bg-red-500/20")}
                onClick={() => void handleDisable()}
                disabled={!confirmed || acting}
              >
                {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
                禁用实时保护
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={cn(primaryButtonClass, "border-emerald-500/60 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20")}
              onClick={() => void handleEnable()}
              disabled={acting}
            >
              {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shield className="h-3.5 w-3.5" />}
              启用实时保护
            </button>
          )}

          <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground/70">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>禁用 Defender 可能需要重启或安全模式才能完全生效。Windows 10 1903+ 客户端的 DisableAntiSpyware 注册表值会被忽略。</span>
          </div>
        </div>
      ) : null}
      {message && <p className={cn("text-xs", message.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>{message.text}</p>}
    </PanelCard>
  );
}
