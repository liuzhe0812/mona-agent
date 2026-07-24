import { AlertTriangle, CheckCircle2, Cpu, Loader2, Menu, RotateCcw, Shield, ShieldOff, Zap } from "lucide-react";
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

export function AdvancedOptimizationPanel() {
  return (
    <div className="flex flex-col gap-4">
      <PerformanceSection />
      <ContextMenuSection />
      <DefenderSection />
    </div>
  );
}

// ===== P2 性能微调 =====

function PerformanceSection() {
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

  const handleApply = async (item: PerformanceItem, mode: string) => {
    setActing(`${item.id}-${mode}`);
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
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <div key={item.id} className={cn(
              "rounded-lg border p-3",
              item.isApplied ? "border-blue-500/40 bg-blue-500/5" : "border-border/60",
            )}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-semibold">{item.label}</span>
                    {item.risk === "medium" && <StatusPill tone="orange">中风险</StatusPill>}
                    {item.isApplied && <CheckCircle2 className="h-3.5 w-3.5 text-blue-600" />}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{item.description}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground/70">{item.currentDetail}</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  {item.isApplied ? (
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      onClick={() => void handleApply(item, "restore")}
                      disabled={acting === `${item.id}-restore`}
                    >
                      {acting === `${item.id}-restore"` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      恢复
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={primaryButtonClass}
                      onClick={() => void handleApply(item, "recommended")}
                      disabled={acting === `${item.id}-recommended`}
                    >
                      {acting === `${item.id}-recommended` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                      应用
                    </button>
                  )}
                </div>
              </div>
              {item.requiresReboot && (
                <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-400">需要重启生效</p>
              )}
            </div>
          ))}
        </div>
      )}
      {message && <p className={cn("text-xs", message.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>{message.text}</p>}
    </PanelCard>
  );
}

// ===== P3 右键菜单 =====

function ContextMenuSection() {
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

function DefenderSection() {
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
