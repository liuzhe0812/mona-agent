import { Popover } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ContextUsageRing } from "@/components/thread/ThreadComposer";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, fetchSessionContext, updateSessionContext, type SessionContextSettings } from "@/lib/api";
import type { ContextUsage } from "@/lib/context-usage";
import type { SessionUsageSummary, UIMessage } from "@/lib/types";

export function SessionUsagePopover({
  usage, contextUsage, contextSession, liveMeasurement,
}: {
  usage: SessionUsageSummary | null;
  contextUsage?: ContextUsage | null;
  contextSession?: { token: string; key: string; disabled?: boolean };
  liveMeasurement?: UIMessage["tokenUsage"];
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [unit, setUnit] = useState<"K" | "M">("K");
  const [override, setOverride] = useState<number | null | undefined>(undefined);
  const [pending, setPending] = useState<"load" | "save" | "compact" | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [validation, setValidation] = useState("");
  const [failure, setFailure] = useState("");
  const [notice, setNotice] = useState("");
  const [readVersion, setReadVersion] = useState(0);
  const [sessionContext, setSessionContext] = useState<SessionContextSettings | null>(null);
  const [autoBase, setAutoBase] = useState<ContextUsage | null | undefined>(undefined);
  const [compacted, setCompacted] = useState<{ used: number | null; liveAtResult?: UIMessage["tokenUsage"] } | null>(null);
  const inputId = useId();
  const pendingRef = useRef<"load" | "save" | "compact" | null>(null);
  const unitRef = useRef<"K" | "M">("K");
  const contextRef = useRef(contextUsage);
  contextRef.current = contextUsage;
  const liveRef = useRef(liveMeasurement);
  liveRef.current = liveMeasurement;
  const sessionIdentity = contextSession ? JSON.stringify([contextSession.token, contextSession.key]) : "";
  const identityRef = useRef(sessionIdentity);
  identityRef.current = sessionIdentity;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    pendingRef.current = null;
    unitRef.current = "K";
    setUnit("K");
    setOverride(undefined);
    setDraft("");
    setExpanded(false);
    setSessionContext(null);
    setAutoBase(undefined);
    setCompacted(null);
    setLoadError(false);
    setValidation("");
    setFailure("");
    setNotice("");
    setPending(null);
  }, [sessionIdentity]);

  const applyContext = (result: SessionContextSettings, action: "load" | "save" | "compact") => {
    setOverride(result.windowTokens);
    setDraft(result.windowTokens === null ? "" : String(result.windowTokens / (unitRef.current === "M" ? 1_000_000 : 1_000)));
    setLoadError(false);
    setSessionContext(result);
    setAutoBase(contextRef.current);
    if (action === "compact" || result.compacted) setCompacted({
      used: typeof result.contextTokens === "number" && Number.isSafeInteger(result.contextTokens) && result.contextTokens >= 0
        ? result.contextTokens : null,
      liveAtResult: liveRef.current,
    });
    else if (action === "load") setCompacted(null);
  };

  useEffect(() => {
    if (!contextSession || pendingRef.current) return;
    let active = true;
    pendingRef.current = "load";
    setPending("load");
    setLoadError(false);
    void fetchSessionContext(contextSession.token, contextSession.key).then((result) => {
      if (active) applyContext(result, "load");
    }).catch(() => {
      if (active) setLoadError(true);
    }).finally(() => {
      if (active) { pendingRef.current = null; setPending(null); }
    });
    return () => { active = false; if (pendingRef.current === "load") pendingRef.current = null; };
  }, [sessionIdentity, readVersion]);

  const changeUnit = (next: string) => {
    if (next !== "K" && next !== "M") return;
    unitRef.current = next;
    setUnit(next);
    setValidation("");
  };

  const updateContext = async (action: "save" | "compact", windowTokens?: number | null) => {
    if (!contextSession || contextSession.disabled || pendingRef.current) return;
    const identity = sessionIdentity;
    pendingRef.current = action;
    setPending(action);
    setValidation("");
    setFailure("");
    setNotice("");
    try {
      const result = await updateSessionContext(contextSession.token, contextSession.key,
        action === "compact" ? { compact: true } : { windowTokens: windowTokens ?? null });
      if (!mounted.current || identityRef.current !== identity) return;
      applyContext(result, action);
      if (action === "compact") setNotice(t("thread.composer.contextUsage.compacted"));
    } catch (error) {
      if (!mounted.current || identityRef.current !== identity) return;
      const message = error instanceof ApiError && error.status >= 400 && error.status < 500 ? error.message : "";
      setFailure(message === "目前没有可压缩的早期对话。" ? t("thread.composer.contextUsage.nothingToCompact")
        : message && !/^HTTP \d+$/.test(message) ? message
          : t(action === "compact" ? "thread.composer.contextUsage.compactFailed" : "thread.composer.contextUsage.saveFailed"));
    } finally {
      if (mounted.current && identityRef.current === identity) { pendingRef.current = null; setPending(null); }
    }
  };

  const saveWindow = () => {
    const amount = Number(draft);
    const raw = amount * (unit === "M" ? 1_000_000 : 1_000);
    const value = Math.round(raw);
    if (!draft.trim() || !Number.isFinite(raw) || Math.abs(raw - value) > 0.000001 || !Number.isSafeInteger(value) || value < 4096) {
      setValidation(t("thread.composer.contextUsage.invalidWindow"));
      return;
    }
    void updateContext("save", value);
  };
  const number = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 });
  const decimal = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(i18n.resolvedLanguage, { style: "percent", maximumFractionDigits: 1 });
  const unreported = t("thread.composer.sessionUsage.unreported");
  const cacheHit = usage?.cacheHitRate == null ? unreported : percent.format(usage.cacheHitRate);
  const count = (value: number | null) => {
    if (value === null) return unreported;
    if (value >= 1_000_000) return `${decimal.format(value / 1_000_000)}M`;
    if (value >= 1_000) return `${decimal.format(value / 1_000)}k`;
    return number.format(value);
  };
  const total = usage ? usage.promptTokens + usage.completionTokens : 0;
  const rows = usage ? [
    {
      label: t("thread.composer.sessionUsage.token"),
      value: t("thread.composer.sessionUsage.tokenDetail", {
        total: count(total), input: count(usage.promptTokens), output: count(usage.completionTokens),
      }),
    },
    {
      label: t("thread.composer.sessionUsage.cache"),
      value: cacheHit,
    },
    {
      label: t("thread.composer.sessionUsage.elapsed"),
      value: usage.latencyMs === null ? unreported : t("thread.composer.sessionUsage.seconds", { value: number.format(usage.latencyMs / 1000) }),
    },
    {
      label: t("thread.composer.sessionUsage.speed"),
      value: usage.outputTokensPerSecond === null ? unreported : t("thread.composer.sessionUsage.tokensPerSecond", { value: decimal.format(usage.outputTokensPerSecond) }),
    },
    {
      label: t("thread.composer.sessionUsage.models"),
      value: usage.models.length ? (
        <ul className="list-none space-y-1">
          {usage.models.map((model) => <li key={model}>{model}</li>)}
        </ul>
      ) : unreported,
      wrap: true,
    },
  ] : [];
  const accessibleName = t("thread.composer.contextUsage.panel");
  const freshLive = !!liveMeasurement && liveMeasurement !== compacted?.liveAtResult && typeof liveMeasurement.contextTokens === "number";
  useEffect(() => { if (compacted && freshLive) setCompacted(null); }, [compacted, freshLive]);
  const used = compacted && !freshLive ? compacted.used : contextUsage?.used ?? null;
  const hasOverride = sessionContext?.windowTokens != null;
  const useAutomaticResult = sessionContext && !hasOverride && autoBase === contextUsage;
  const savedLimit = sessionContext?.effectiveWindowTokens ?? sessionContext?.windowTokens ?? null;
  const windowTotal = hasOverride ? autoBase !== contextUsage && contextUsage?.total != null && savedLimit !== null
    ? Math.min(savedLimit, contextUsage.total) : savedLimit
    : (useAutomaticResult ? sessionContext?.effectiveWindowTokens : contextUsage?.total) ?? sessionContext?.effectiveWindowTokens ?? null;
  const isBudget = hasOverride ? sessionContext?.isBudget ?? true
    : useAutomaticResult ? sessionContext?.isBudget ?? contextUsage?.isBudget : contextUsage?.isBudget ?? sessionContext?.isBudget;
  const displayContext = used === null ? null : { used, total: windowTotal, ...(isBudget ? { isBudget: true } : {}) };
  const totalContext = displayContext?.total ?? 0;
  const ratio = displayContext && totalContext > 0 && displayContext.used >= 0 ? displayContext.used / totalContext : null;
  const contextSummary = displayContext == null ? t("thread.composer.contextUsage.empty")
    : ratio === null ? t("thread.composer.contextUsage.unknown", { used: count(displayContext.used) })
    : t(displayContext.isBudget ? "thread.composer.contextUsage.budgetDetail" : "thread.composer.contextUsage.detail", {
      percent: percent.format(ratio), used: count(displayContext.used), total: count(displayContext.total),
    });

  return (
    <><Popover.Root open={open} onOpenChange={(value) => { setOpen(value); if (value && contextSession && !pendingRef.current) setReadVersion((current) => current + 1); }}>
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Popover.Trigger asChild>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 rounded-full text-muted-foreground hover:text-foreground" aria-label={accessibleName}>
                <ContextUsageRing ratio={ratio} />
              </Button>
            </Popover.Trigger>
          </TooltipTrigger>
          {!open && (
            <TooltipContent side="top" sideOffset={8} className="space-y-1 text-center">
              <div className="opacity-70">{t("thread.composer.contextUsage.tooltipTitle")}</div>
              {ratio === null ? <div>{contextSummary}</div> : (
                <>
                  <div>{t("thread.composer.contextUsage.tooltipPercent", {
                    used: percent.format(ratio), remaining: percent.format(Math.max(0, 1 - ratio)),
                  })}</div>
                  <div>{t("thread.composer.contextUsage.tooltipTokens", { used: count(used), total: count(windowTotal) })}</div>
                </>
              )}
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label={accessibleName}
          className="z-50 max-h-[var(--radix-popover-content-available-height)] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border/60 bg-popover p-4 text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">{t("thread.composer.contextUsage.title")}</h2>
            {contextSession && <Button type="button" variant="outline" size="sm" disabled={contextSession.disabled || pending !== null}
              onClick={() => void updateContext("compact")}>
              {t(pending === "compact" ? "thread.composer.contextUsage.compacting" : "thread.composer.contextUsage.compact")}
            </Button>}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="min-w-0 text-caption text-muted-foreground">{contextSummary}</p>
            {contextSession && <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0"
              aria-label={t("thread.composer.contextUsage.editWindow")} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
              <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
            </Button>}
          </div>
          {ratio !== null ? (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full rounded-full bg-foreground/70" style={{ width: `${Math.min(1, ratio) * 100}%` }} />
            </div>
          ) : null}
          {contextSession && expanded && <div className="mt-3 space-y-2 text-caption">
            <label htmlFor={inputId}>{t("thread.composer.contextUsage.window")}</label>
            <div className="flex items-center gap-2">
              <Input id={inputId} type="number" min={0} step="any" value={draft} disabled={contextSession.disabled || pending !== null}
                placeholder={t("thread.composer.contextUsage.automatic")} onChange={(event) => { setDraft(event.currentTarget.value); setValidation(""); }} />
              <Select aria-label={t("thread.composer.contextUsage.unit")} value={unit} onValueChange={changeUnit}
                options={[{ value: "K", label: "K" }, { value: "M", label: "M" }]} disabled={contextSession.disabled || pending !== null} className="w-20 shrink-0" />
              <Button type="button" size="sm" disabled={contextSession.disabled || pending !== null} onClick={saveWindow}>{t("thread.composer.contextUsage.save")}</Button>
            </div>
            {validation && <p role="alert" className="text-destructive">{validation}</p>}
            <Button type="button" variant="ghost" size="sm" disabled={contextSession.disabled || pending !== null || override === undefined}
              onClick={() => void updateContext("save", null)}>{t("thread.composer.contextUsage.resetWindow")}</Button>
          </div>}
          {loadError && <p className="mt-2 text-caption text-muted-foreground">{t("thread.composer.contextUsage.loadFailed")}</p>}
          {notice && <p role="status" className="mt-2 text-caption text-muted-foreground">{notice}</p>}
          <h2 className="mb-2 mt-3 border-t pt-3 text-caption font-medium">{t("thread.composer.sessionUsage.accessibleName")}</h2>
          {usage ? (
            <dl className="space-y-2 text-caption">
              {rows.map((row) => (
                <div key={row.label} className="flex justify-between gap-6">
                  <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
                  <dd className={`min-w-0 text-right tabular-nums ${row.wrap ? "[overflow-wrap:anywhere]" : "sm:whitespace-nowrap"}`}>
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-caption text-muted-foreground">{t("thread.composer.sessionUsage.empty")}</p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    <AlertDialog open={!!failure} onOpenChange={(value) => { if (!value) setFailure(""); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("thread.composer.contextUsage.failedTitle")}</AlertDialogTitle>
        <AlertDialogDescription>{failure}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>{t("thread.composer.contextUsage.close")}</AlertDialogCancel></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog></>
  );
}
