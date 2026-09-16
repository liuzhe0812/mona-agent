import { AlertTriangle, CheckCircle2, Loader2, Menu, RotateCcw, Shield, ShieldOff, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
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
import { PanelCard, StatusPill } from "./SystemUi";

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
        <div className="flex items-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取...</div>
      ) : items.length === 0 ? (
        <p className="text-caption text-muted-foreground">暂无可优化的性能项。</p>
      ) : (
        <div className="flex flex-col divide-y divide-border/60">
          {items.map((item) => {
            const isLoading = acting === item.id;
            const enabled = item.isApplied;
            return (
              <div
                key={item.id}
                className={cn(
                  "flex items-center justify-between gap-3 px-3 py-2.5 transition",
                  enabled ? "bg-info/[0.04]" : "",
                  isLoading && "opacity-70",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-caption font-semibold">{item.label}</span>
                    {item.risk === "medium" && <StatusPill tone="orange">中风险</StatusPill>}
                    {item.risk === "high" && <StatusPill tone="red">高风险</StatusPill>}
                    {item.requiresReboot && <StatusPill tone="violet">需重启</StatusPill>}
                    {item.requiresAdministrator && <StatusPill tone="orange">管理员</StatusPill>}
                  </div>
                  <p className="mt-1 text-micro text-muted-foreground">{item.description}</p>
                  {item.currentDetail && <p className="mt-0.5 text-micro text-muted-foreground/70">{item.currentDetail}</p>}
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
                    enabled ? "bg-info" : "bg-muted-foreground/25",
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
      {message && <p className={cn("mt-2 text-caption", message.tone === "ok" ? "text-success" : "text-destructive")}>{message.text}</p>}
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
        <div className="flex items-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取...</div>
      ) : (
        <div className="flex flex-col divide-y divide-border/60">
          {items.map((item) => (
            <div key={item.id} className={cn(
              "flex items-center justify-between gap-3 px-3 py-3",
              item.isApplied ? "bg-info/5" : "",
            )}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-caption font-semibold">{item.label}</span>
                  {item.isApplied && <CheckCircle2 className="h-3.5 w-3.5 text-info" />}
                </div>
                <p className="mt-0.5 text-micro text-muted-foreground">{item.description}</p>
              </div>
              <Button
                type="button"
                variant={item.isApplied ? "outline" : "interaction"}
                size="sm"
                onClick={() => void handleToggle(item)}
                disabled={acting === item.id}
              >
                {acting === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : item.isApplied ? <RotateCcw className="h-3.5 w-3.5" /> : <Menu className="h-3.5 w-3.5" />}
                {item.isApplied ? "移除" : "添加"}
              </Button>
            </div>
          ))}
        </div>
      )}
      {message && <p className={cn("text-caption", message.tone === "ok" ? "text-success" : "text-destructive")}>{message.text}</p>}
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
        <div className="flex items-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取...</div>
      ) : status ? (
        <div className="flex flex-col gap-3">
          <div className={cn(
            "rounded-lg border p-3",
            isDisabled ? "border-destructive/40 bg-destructive/5" : "border-success/40 bg-success/5",
          )}>
            <div className="flex items-center gap-2">
              {isDisabled ? <ShieldOff className="h-4 w-4 text-destructive" /> : <Shield className="h-4 w-4 text-success" />}
              <span className="text-caption font-semibold">{isDisabled ? "实时保护已禁用" : "实时保护已启用"}</span>
            </div>
            <p className="mt-1 text-micro text-muted-foreground">{status.detail}</p>
            {hasThirdParty && (
              <div className="mt-2 rounded border border-info/30 bg-info/5 p-2 text-micro text-info">
                检测到第三方杀毒软件：{status.thirdPartyAv.join("、")}
              </div>
            )}
          </div>

          {status.realtimeEnabled ? (
            <div className="flex flex-col gap-2">
              <label className="flex items-start gap-2 text-micro text-muted-foreground">
                <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
                <span>
                  我已了解禁用 Defender 会降低系统安全性
                  {!hasThirdParty && <span className="font-medium text-destructive">，且当前没有第三方杀毒软件保护</span>}
                </span>
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-destructive/60 bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
                onClick={() => void handleDisable()}
                disabled={!confirmed || acting}
              >
                {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
                禁用实时保护
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="interaction"
              size="sm"
              onClick={() => void handleEnable()}
              disabled={acting}
            >
              {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shield className="h-3.5 w-3.5" />}
              启用实时保护
            </Button>
          )}

          <div className="flex items-start gap-1.5 text-micro text-muted-foreground/70">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>禁用 Defender 可能需要重启或安全模式才能完全生效。Windows 10 1903+ 客户端的 DisableAntiSpyware 注册表值会被忽略。</span>
          </div>
        </div>
      ) : null}
      {message && <p className={cn("text-caption", message.tone === "ok" ? "text-success" : "text-destructive")}>{message.text}</p>}
    </PanelCard>
  );
}
