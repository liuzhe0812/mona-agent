import { Activity, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover } from "radix-ui";

import { Button } from "@/components/ui/button";

export interface RunMetricsDisplay {
  latestRate: number;
  averageRate: number;
  outputTokens: number;
  peakRate: number;
  reasoningRatio?: number;
  coverage?: {
    total: number;
    reasoning?: number;
  };
  samples: readonly number[];
}

export function RunMetricsPopover({
  elapsedLabel,
  metrics,
  liveRate,
}: {
  elapsedLabel?: string | null;
  metrics?: RunMetricsDisplay;
  liveRate?: number;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.resolvedLanguage, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const percent = new Intl.NumberFormat(i18n.resolvedLanguage, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const rate = (value: number) => `${number.format(value)} tok/s`;
  const ratio = (value: number | undefined) =>
    value === undefined ? t("thread.composer.runMetrics.unreported") : percent.format(value);
  const reading = liveRate ?? metrics?.latestRate;
  if (reading === undefined) return null;
  const readingLabel = t(liveRate === undefined ? "thread.composer.runMetrics.lastRateShort" : "thread.composer.runMetrics.estimatedRate", { rate: rate(reading) });
  const triggerLabel = `${elapsedLabel ? `${elapsedLabel} · ` : ""}${readingLabel}`;
  if (!metrics) return <span className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">{triggerLabel}</span>;
  const samples = metrics.samples.filter(Number.isFinite);
  const minimum = Math.min(...samples);
  const range = Math.max(...samples) - minimum;
  const points = samples.map((value, index) => {
    const x = index * 100 / (samples.length - 1);
    const y = range === 0 ? 16 : 30 - ((value - minimum) / range * 28);
    return `${x},${y}`;
  }).join(" ");
  const rows = [
    { label: t("thread.composer.runMetrics.turnAverage"), value: rate(metrics.averageRate) },
    { label: t("thread.composer.runMetrics.output"), value: `${new Intl.NumberFormat(i18n.resolvedLanguage).format(metrics.outputTokens)} tok` },
    { label: t("thread.composer.runMetrics.peak"), value: rate(metrics.peakRate) },
    { label: t("thread.composer.runMetrics.reasoning"), value: ratio(metrics.reasoningRatio), reported: metrics.coverage?.reasoning },
  ];

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 shrink-0 rounded-full px-2 text-caption font-normal tabular-nums"
          aria-label={`${t("thread.composer.runMetrics.open")} · ${triggerLabel}`}
        >
          {triggerLabel}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label={t("thread.composer.runMetrics.open")}
          className="z-50 w-max max-w-[calc(100vw-2rem)] rounded-xl border border-border/60 bg-popover p-4 text-popover-foreground shadow-lg"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-caption text-muted-foreground">
                <Activity className="h-4 w-4 shrink-0" aria-hidden />
                <span>{t(liveRate === undefined ? "thread.composer.runMetrics.lastRequest" : "thread.composer.runMetrics.liveEstimate")}</span>
              </div>
              <p className="mt-1 text-display-sm font-semibold tabular-nums text-foreground">
                {number.format(reading)} <span className="text-body font-normal text-muted-foreground">tok/s</span>
              </p>
            </div>
            <Popover.Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label={t("thread.composer.runMetrics.close")}
                className="h-7 w-7 shrink-0 text-muted-foreground">
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </Popover.Close>
          </div>
          {samples.length >= 2 ? (
            <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true" className="mt-2 h-8 w-full text-muted-foreground/60">
              <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          ) : null}
          <dl className="scrollbar-thin mt-4 grid grid-flow-col auto-cols-max gap-x-4 overflow-x-auto whitespace-nowrap">
            {rows.map((row) => (
              <div key={row.label} className="min-w-0">
                <dt className="text-caption text-muted-foreground">{row.label}</dt>
                <dd className="mt-1 text-body font-medium tabular-nums text-foreground">
                  {row.value}
                  {row.reported !== undefined && metrics.coverage ? (
                    <span className="ml-2 text-micro font-normal text-muted-foreground">
                      {t("thread.composer.runMetrics.partialCoverage", {
                        reported: row.reported,
                        total: metrics.coverage.total,
                      })}
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
