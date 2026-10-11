import { useEffect, useId, useState } from "react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { NativeAccountUsage } from "@/lib/development-api";

const STALE_AFTER_MS = 5 * 60_000;

const NATIVE_PLAN_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  self_serve_business_usage_based: "Self Serve Business Usage Based",
  business: "Business",
  enterprise_cbp_usage_based: "Enterprise CBP Usage Based",
  enterprise: "Enterprise",
  edu: "Edu",
};

export function formatNativePlan(planType: string | null | undefined): string {
  const key = typeof planType === "string" ? planType.trim().toLowerCase() : "";
  const label = NATIVE_PLAN_LABELS[key];
  return key ? `ChatGPT ${label ?? key.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())}` : "ChatGPT订阅";
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function quotaWindowLabel(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return "限额";
  if (minutes === 10_080) return "周限";
  if (minutes === 300) return "5 小时";
  if (minutes % 1440 === 0) return `${minutes / 1440}天限额`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

function formatResetCountdown(resetsAt: number | null | undefined, nowMs: number): string | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const remainingMs = resetsAt * 1000 - nowMs;
  if (remainingMs <= 0) return "等待重置数据更新";
  const minutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  const duration = days > 0
    ? [`${days}天`, ...(hours ? [`${hours}小时`] : [])].join(" ")
    : hours > 0
      ? [`${hours}小时`, ...(remainder ? [`${remainder}分钟`] : [])].join(" ")
      : `${minutes}分钟`;
  return `${duration}后重置`;
}

function formatDateAt(resetsAt: number | null | undefined, nowMs: number): string | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const date = new Date(resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const now = new Date(nowMs);
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const dateLabel = sameDay
    ? time
    : `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)} ${time}`;
  return dateLabel;
}

function formatResetAt(resetsAt: number | null | undefined, nowMs: number): string | null {
  const at = formatDateAt(resetsAt, nowMs);
  return at === null ? null : `${at} 重置`;
}

function creditDetails(usage: NativeAccountUsage, nowMs: number): string[] {
  const details: string[] = [];
  const credits = usage.credits;
  if (credits) {
    const balance = typeof credits.balance === "string" ? credits.balance.trim().replace(/,/g, "") : "";
    const numericBalance = balance ? Number(balance) : Number.NaN;
    const hasBalance = Number.isFinite(numericBalance);
    if (hasBalance) {
      details.push(`剩余 ${numericBalance.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} credits`);
    }
    if (credits.unlimited) details.push("余额不限");
    else if (!credits.hasCredits) details.push("余额已耗尽");
    else if (!hasBalance) details.push("余额可用");
  }
  if (typeof usage.availableResets === "number" && Number.isFinite(usage.availableResets)) {
    details.push(`可用重置：${usage.availableResets.toLocaleString()} 次`);
  }
  const resetCreditsExpireAt = formatDateAt(usage.resetCreditsExpireAt, nowMs);
  if (resetCreditsExpireAt !== null) details.push(`最早过期：${resetCreditsExpireAt}`);
  return details;
}

export function NativeAccountQuota({ usage, nowMs }: { usage: NativeAccountUsage; nowMs?: number }) {
  const [clockMs, setClockMs] = useState(() => Date.now());
  const detailsId = useId();
  useEffect(() => {
    if (nowMs !== undefined) return;
    const timer = window.setInterval(() => setClockMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [nowMs]);

  if (!usage.connected) return null;

  const currentMs = nowMs ?? clockMs;
  const windows = (Array.isArray(usage.limits) ? usage.limits : []).flatMap((limit, limitIndex) =>
    (["primary", "secondary"] as const).flatMap((windowKey) => {
      const window = limit?.[windowKey];
      if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return [];
      const limitName = !["codex", "__default__"].includes(limit.limitId ?? "") && typeof limit.limitName === "string" ? limit.limitName.trim() : "";
      return [{
        key: `${limitIndex}-${limit.limitId ?? "limit"}-${windowKey}`,
        title: [limitName, quotaWindowLabel(window.windowDurationMins)].filter(Boolean).join(" "),
        window,
      }];
    }),
  );
  const details = creditDetails(usage, currentMs);
  const observedAt = typeof usage.fetchedAt === "number" && Number.isFinite(usage.fetchedAt)
    ? usage.fetchedAt
    : null;
  const staleMinutes = observedAt !== null && currentMs - observedAt > STALE_AFTER_MS
    ? Math.floor((currentMs - observedAt) / 60_000)
    : null;

  return (
    <div data-testid="native-account-quota" className="space-y-3 border-b px-5 py-4 text-caption text-foreground">
      <div
        id={detailsId}
        role="region"
        aria-label="ChatGPT 额度用量"
        className="space-y-3"
      >
        {windows.map(({ key, title, window }) => {
          const usedPercent = clampPercent(window.usedPercent);
          const remainingPercent = 100 - usedPercent;
          const percentText = `剩余 ${Math.round(remainingPercent)}%`;
          const severity = usedPercent >= 90 ? "crit" : usedPercent > 70 ? "warn" : "normal";
          const resetAt = formatResetAt(window.resetsAt, currentMs);
          const resetCountdown = formatResetCountdown(window.resetsAt, currentMs);
          const titleId = `${detailsId}-${key}`;

          return (
            <section key={key} data-testid="quota-window" className="space-y-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  id={titleId}
                  data-severity={severity}
                  className={cn(
                    "font-medium",
                    severity === "crit" ? "text-destructive dark:brightness-200" : severity === "warn" ? "text-warning" : "text-foreground",
                  )}
                >
                  {title}
                  {severity !== "normal" ? (
                    <span className="sr-only">，{severity === "crit" ? "用量较高" : "用量偏高"}</span>
                  ) : null}
                </span>
                <Progress
                  value={remainingPercent}
                  indicatorStyle={{ width: `${remainingPercent}%`, minWidth: remainingPercent > 0 ? 7 : 0, transform: "none" }}
                  aria-labelledby={titleId}
                  aria-valuenow={Math.round(remainingPercent)}
                  aria-valuetext={percentText}
                  data-severity={severity}
                  className={cn(
                    "h-2 min-w-28 flex-1 bg-muted [&>div]:rounded-full motion-reduce:[&>div]:transition-none",
                    severity === "warn" && "[&>div]:bg-warning",
                    severity === "crit" && "[&>div]:bg-destructive dark:[&>div]:brightness-200",
                  )}
                />
                <div className="flex shrink-0 items-baseline justify-between gap-4 tabular-nums">
                  <span className="font-medium">{percentText}</span>
                  {resetCountdown ? (
                    <span title={resetAt ?? undefined} className="text-muted-foreground">
                      {resetCountdown}
                    </span>
                  ) : null}
                </div>
              </div>
            </section>
          );
        })}
        {windows.length === 0 ? <div className="text-muted-foreground">暂无配额窗口数据</div> : null}
        {windows.some(({ window }) => window.usedPercent >= 99.95) && usage.rateLimitReachedType && !usage.rateLimitReachedType.includes("credits_depleted") && (
          <p className="font-medium text-destructive dark:brightness-200" role="status">已达到账号用量上限。</p>
        )}
        {details.length > 0 ? (
          <section className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums text-muted-foreground">
            {details.map((detail) => <div key={detail}>{detail}</div>)}
          </section>
        ) : null}
      </div>
      {staleMinutes !== null ? (
        <div className="text-muted-foreground">数据更新于 {staleMinutes} 分钟前</div>
      ) : null}
    </div>
  );
}
