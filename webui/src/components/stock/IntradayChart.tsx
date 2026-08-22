import { useEffect, useMemo, useRef, useState } from "react";

import type {
  StockIntradayPoint,
  StockIntradaySeries,
} from "@/lib/stock-api";
import { cn } from "@/lib/utils";

const CHART_HEIGHT = 300;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 60;
const PLOT_TOP = 20;
const PLOT_HEIGHT = 182;
const VOLUME_TOP = 226;
const VOLUME_HEIGHT = 42;

export type IntradayChartState = "idle" | "loading" | "ready" | "error";

export interface IntradayPriceDomain {
  min: number;
  max: number;
  previousClose: number;
}

export interface IntradaySummary {
  latest: StockIntradayPoint | null;
  high: number | null;
  low: number | null;
  volume: number;
  amount: number;
  changePct: number | null;
}

export interface IntradayTooltip {
  time: string;
  price: number;
  changePct: number;
  average: number;
  volume: number;
  amount: number;
}

export interface IntradayVolumeBar {
  point: StockIntradayPoint;
  x: number;
  width: number;
  y: number;
  height: number;
}

function minuteOfDay(value: string): number | null {
  const match = /(?:T|\s)(\d{2}):(\d{2})/.exec(value) ?? /^(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Map the two A-share sessions to equal-width chart segments, omitting lunch. */
export function intradayMinuteRatio(value: string): number | null {
  const minute = minuteOfDay(value);
  if (minute == null) return null;
  if (minute >= 570 && minute <= 690) return (minute - 570) / 240;
  if (minute >= 780 && minute <= 900) return (120 + minute - 780) / 240;
  return null;
}

export function intradayMinuteX(
  value: string,
  left: number,
  width: number,
): number | null {
  const ratio = intradayMinuteRatio(value);
  return ratio == null ? null : left + ratio * width;
}

function intradaySessionSegment(value: string): 0 | 1 | null {
  const minute = minuteOfDay(value);
  if (minute == null) return null;
  if (minute >= 570 && minute <= 690) return 0;
  if (minute >= 780 && minute <= 900) return 1;
  return null;
}

/** Split points by actual exchange session; 11:30 stays morning, 13:00 afternoon. */
export function splitIntradayPoints(points: StockIntradayPoint[]): StockIntradayPoint[][] {
  const segments: StockIntradayPoint[][] = [];
  let current: StockIntradayPoint[] = [];
  let segment: 0 | 1 | null = null;
  for (const point of points) {
    const nextSegment = intradaySessionSegment(point.time);
    if (nextSegment == null) {
      if (current.length > 0) segments.push(current);
      current = [];
      segment = null;
      continue;
    }
    if (segment != null && nextSegment !== segment && current.length > 0) {
      segments.push(current);
      current = [];
    }
    segment = nextSegment;
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Strictly symmetric around the previous close so the two axes share a baseline. */
export function symmetricPriceDomain(
  previousClose: number,
  points: StockIntradayPoint[],
): IntradayPriceDomain {
  const center = Number.isFinite(previousClose) && previousClose > 0 ? previousClose : 1;
  const values = points.flatMap((point) => [point.high, point.low, point.price, point.average]);
  const delta = values.reduce(
    (max, value) => (Number.isFinite(value) ? Math.max(max, Math.abs(value - center)) : max),
    0,
  );
  const span = Math.max(delta, center * 0.01, 0.01);
  return { min: center - span, max: center + span, previousClose: center };
}

function pathY(value: number, domain: IntradayPriceDomain, top: number, height: number): number {
  const span = domain.max - domain.min || 1;
  return top + height * (1 - (value - domain.min) / span);
}

/** Build separate SVG paths for morning and afternoon; never bridges lunch. */
export function buildIntradayPaths(
  points: StockIntradayPoint[],
  value: "price" | "average",
  left: number,
  width: number,
  domain: IntradayPriceDomain,
  top = PLOT_TOP,
  height = PLOT_HEIGHT,
): string[] {
  return splitIntradayPoints(points).flatMap((segmentPoints) => {
    const path: string[] = [];
    for (const point of segmentPoints) {
      const ratio = intradayMinuteRatio(point.time);
      const valueAtPoint = point[value];
      if (ratio == null || !Number.isFinite(valueAtPoint)) continue;
      const x = left + ratio * width;
      const y = pathY(valueAtPoint, domain, top, height);
      path.push(`${x},${y}`);
    }
    return path.length > 0 ? [path.join(" ")] : [];
  });
}

export function buildIntradayVolumeBars(
  points: StockIntradayPoint[],
  left: number,
  width: number,
  top = VOLUME_TOP,
  height = VOLUME_HEIGHT,
): IntradayVolumeBar[] {
  const maxVolume = Math.max(...points.map((point) => point.volume), 1);
  const barWidth = Math.max(1, (width / 240) * 0.72);
  return points.flatMap((point) => {
    const x = intradayMinuteX(point.time, left, width);
    if (x == null) return [];
    const barHeight = Math.max(1, (point.volume / maxVolume) * height);
    return [{ point, x, width: barWidth, y: top + height - barHeight, height: barHeight }];
  });
}

export function summarizeIntraday(series: StockIntradaySeries): IntradaySummary {
  const points = series.points;
  const latest = points.at(-1) ?? null;
  const high = points.length ? Math.max(...points.map((point) => point.high)) : null;
  const low = points.length ? Math.min(...points.map((point) => point.low)) : null;
  const volume = points.reduce((sum, point) => sum + point.volume, 0);
  const amount = points.reduce((sum, point) => sum + point.amount, 0);
  const changePct = latest
    ? ((latest.price - series.previousClose) / series.previousClose) * 100
    : null;
  return { latest, high, low, volume, amount, changePct };
}

export function intradayTooltip(
  point: StockIntradayPoint,
  previousClose: number,
): IntradayTooltip {
  return {
    time: point.time,
    price: point.price,
    changePct: ((point.price - previousClose) / previousClose) * 100,
    average: point.average,
    volume: point.volume,
    amount: point.amount,
  };
}

function formatPrice(value: number | null | undefined): string {
  return value == null ? "—" : value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatVolume(value: number): string {
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿手`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(2)}万手`;
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}手`;
}

function formatAmount(value: number): string {
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿元`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(2)}万元`;
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}元`;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const match = /(?:T|\s)(\d{2}:\d{2})(?::\d{2})?/.exec(value);
  return match?.[1] ?? value.slice(0, 8);
}

function formatLatency(value: string | null): string {
  if (!value) return "延迟 —";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "延迟 —";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return seconds < 60 ? `延迟 ${seconds}s` : `延迟 ${Math.floor(seconds / 60)}m`;
}

const STATUS_LABELS: Record<StockIntradaySeries["status"], string> = {
  preopen: "盘前",
  trading: "交易中",
  lunch_break: "午间休市",
  closed: "已收盘",
  suspended: "停牌",
  unavailable: "不可用",
};

function sourceLabel(series: StockIntradaySeries): string {
  const provider = series.source.provider.toLowerCase();
  if (provider.includes("tencent")) return "腾讯行情 · 备用行情";
  if (provider.includes("eastmoney")) return "东方财富";
  return series.source.provider;
}

export interface IntradayChartProps {
  series: StockIntradaySeries | null;
  state?: IntradayChartState;
  error?: string | null;
  disconnected?: boolean;
  className?: string;
}

export function IntradayChart({
  series,
  state = "ready",
  error,
  disconnected = false,
  className,
}: IntradayChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(720);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const chartWidth = Math.max(320, width);
    const plotWidth = Math.max(100, chartWidth - PLOT_LEFT - PLOT_RIGHT);
    const domain = series ? symmetricPriceDomain(series.previousClose, series.points) : null;
    const pricePaths = domain && series
      ? buildIntradayPaths(series.points, "price", PLOT_LEFT, plotWidth, domain)
      : [];
    const averagePaths = domain && series
      ? buildIntradayPaths(series.points, "average", PLOT_LEFT, plotWidth, domain)
      : [];
    const volumeBars = series
      ? buildIntradayVolumeBars(series.points, PLOT_LEFT, plotWidth)
      : [];
    return { chartWidth, plotWidth, domain, pricePaths, averagePaths, volumeBars };
  }, [series, width]);

  const summary = series ? summarizeIntraday(series) : null;
  const stale = Boolean(series?.stale || disconnected);
  const lastMinute = series?.points.at(-1) ? minuteOfDay(series.points.at(-1)!.time) : null;
  const closed = series?.status === "closed";
  const closedComplete = closed && lastMinute === 900;
  const closedIncomplete = closed && !closedComplete;
  const showWarning = closedIncomplete || (stale && !closedComplete);
  const hoverPoint = series && hoverIndex != null ? series.points[hoverIndex] ?? null : null;
  const hoverTooltip = hoverPoint && series ? intradayTooltip(hoverPoint, series.previousClose) : null;
  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!series?.points.length) return;
    const rect = svgRef.current?.getBoundingClientRect();
    const renderedWidth = rect?.width || geometry.chartWidth;
    const svgX = ((event.clientX - (rect?.left ?? 0)) / renderedWidth) * geometry.chartWidth;
    const normalized = Math.max(0, Math.min(1, (svgX - PLOT_LEFT) / geometry.plotWidth));
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    series.points.forEach((point, index) => {
      const pointRatio = intradayMinuteRatio(point.time);
      if (pointRatio == null) return;
      const distance = Math.abs(pointRatio - normalized);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    setHoverIndex(bestIndex);
  };

  if (!series && state === "loading") {
    return <div className={cn("flex h-80 items-center justify-center text-caption text-muted-foreground", className)}>正在加载分时行情…</div>;
  }
  if (!series && state === "error") {
    return <div className={cn("flex h-80 items-center justify-center text-caption text-muted-foreground", className)}>{error ?? "分时行情暂不可用"}</div>;
  }
  if (!series) {
    return <div className={cn("flex h-80 items-center justify-center text-caption text-muted-foreground", className)}>暂无分时数据</div>;
  }

  const domain = geometry.domain ?? symmetricPriceDomain(series.previousClose, series.points);
  const latestChange = summary?.changePct ?? null;
  const latestColor = latestChange == null || latestChange >= 0 ? "text-stock-up" : "text-stock-down";
  const crossX = hoverPoint ? intradayMinuteX(hoverPoint.time, PLOT_LEFT, geometry.plotWidth) : null;
  const ticks = [
    { label: "09:30", time: "09:30" },
    { label: "10:30", time: "10:30" },
    { label: "11:30/13:00", time: "11:30" },
    { label: "14:00", time: "14:00" },
    { label: "15:00", time: "15:00" },
  ];
  return (
    <div ref={containerRef} className={cn("relative space-y-2", className)}>
      <div className="grid grid-cols-3 gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-caption md:grid-cols-6">
        <div><div className="text-muted-foreground">最新价</div><div className={cn("mt-0.5 text-title-sm font-medium tabular-nums", latestColor)}>{formatPrice(summary?.latest?.price)}</div></div>
        <div><div className="text-muted-foreground">涨跌幅</div><div className={cn("mt-0.5 font-medium tabular-nums", latestColor)}>{latestChange == null ? "—" : `${latestChange >= 0 ? "+" : ""}${latestChange.toFixed(2)}%`}</div></div>
        <div><div className="text-muted-foreground">最高 / 最低</div><div className="mt-0.5 tabular-nums">{formatPrice(summary?.high)} / {formatPrice(summary?.low)}</div></div>
        <div><div className="text-muted-foreground">成交量</div><div className="mt-0.5 tabular-nums">{formatVolume(summary?.volume ?? 0)}</div></div>
        <div><div className="text-muted-foreground">成交额</div><div className="mt-0.5 tabular-nums">{formatAmount(summary?.amount ?? 0)}</div></div>
        <div><div className="text-muted-foreground">行情状态</div><div className="mt-0.5">{STATUS_LABELS[series.status]}</div></div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground">
        <span>截至 {formatTime(series.asOf)}</span>
        <span>{sourceLabel(series)}</span>
        <span>{formatLatency(series.asOf)}</span>
        {showWarning && <span className="text-warning">{closedIncomplete ? "已收盘，显示最近快照" : "连接中断，保留最近快照"}</span>}
      </div>
      {showWarning && <div className="rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5 text-caption text-warning">{closedIncomplete ? "收盘快照暂未补齐，图表显示最近可用数据" : error ?? series.error ?? "行情暂未恢复，图表显示最近快照"}</div>}
      <div className="relative">
        <svg
          ref={svgRef}
          role="img"
          aria-label="分时图"
          viewBox={`0 0 ${geometry.chartWidth} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          className="block h-72 w-full select-none 2xl:h-80"
          style={{ touchAction: "none" }}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = PLOT_TOP + PLOT_HEIGHT * ratio;
            const price = domain.max - (domain.max - domain.min) * ratio;
            const pct = ((price - domain.previousClose) / domain.previousClose) * 100;
            return (
              <g key={ratio}>
                <line x1={PLOT_LEFT} x2={geometry.chartWidth - PLOT_RIGHT} y1={y} y2={y} stroke="hsl(var(--border))" strokeWidth={0.7} />
                <text x={PLOT_LEFT - 4} y={y + 3} textAnchor="end" fill="hsl(var(--muted-foreground))" fontSize={9}>{price.toFixed(2)}</text>
                <text x={geometry.chartWidth - PLOT_RIGHT + 4} y={y + 3} fill="hsl(var(--muted-foreground))" fontSize={9}>{`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}</text>
              </g>
            );
          })}
          {ticks.map((tick) => {
            const x = intradayMinuteX(`2026-01-01T${tick.time}:00+08:00`, PLOT_LEFT, geometry.plotWidth) ?? PLOT_LEFT;
            return <g key={tick.label}><line data-testid={tick.label === "11:30/13:00" ? "intraday-session-midline" : undefined} x1={x} x2={x} y1={PLOT_TOP} y2={VOLUME_TOP + VOLUME_HEIGHT} stroke="hsl(var(--border))" strokeWidth={0.45} strokeDasharray={tick.label === "11:30/13:00" ? "3 3" : undefined} /><text x={x} y={CHART_HEIGHT - 5} textAnchor="middle" fill="hsl(var(--muted-foreground))" fontSize={9}>{tick.label}</text></g>;
          })}
          <line x1={PLOT_LEFT} x2={geometry.chartWidth - PLOT_RIGHT} y1={pathY(domain.previousClose, domain, PLOT_TOP, PLOT_HEIGHT)} y2={pathY(domain.previousClose, domain, PLOT_TOP, PLOT_HEIGHT)} stroke="hsl(var(--muted-foreground))" strokeWidth={0.8} strokeDasharray="4 3" />
          {geometry.pricePaths.map((path, index) => <polyline key={`price-${index}`} data-testid="intraday-price-path" points={path} fill="none" stroke="hsl(var(--stock-up))" strokeWidth={1.6} />)}
          {geometry.averagePaths.map((path, index) => <polyline key={`average-${index}`} data-testid="intraday-average-path" points={path} fill="none" stroke="hsl(var(--warning))" strokeWidth={1.2} />)}
          {geometry.volumeBars.map((bar) => <rect key={bar.point.time} data-testid="intraday-volume-bar" x={bar.x - bar.width / 2} y={bar.y} width={bar.width} height={bar.height} fill={bar.point.price >= series.previousClose ? "hsl(var(--stock-up))" : "hsl(var(--stock-down))"} opacity={0.55} />)}
          {crossX != null && hoverTooltip && <g data-testid="intraday-crosshair"><line x1={crossX} x2={crossX} y1={PLOT_TOP} y2={VOLUME_TOP + VOLUME_HEIGHT} stroke="hsl(var(--muted-foreground))" strokeWidth={0.8} strokeDasharray="3 3" /><circle cx={crossX} cy={pathY(hoverTooltip.price, domain, PLOT_TOP, PLOT_HEIGHT)} r={2.5} fill="hsl(var(--stock-up))" /></g>}
        </svg>
        {hoverTooltip && (
          <div className="pointer-events-none absolute left-2 top-1 rounded border bg-background/95 px-2 py-1 text-micro tabular-nums shadow-sm">
            <span>{formatTime(hoverTooltip.time)}</span><span className="ml-2">价 {formatPrice(hoverTooltip.price)}</span><span className={cn("ml-2", hoverTooltip.changePct >= 0 ? "text-stock-up" : "text-stock-down")}>{`${hoverTooltip.changePct >= 0 ? "+" : ""}${hoverTooltip.changePct.toFixed(2)}%`}</span><span className="ml-2">均价 {formatPrice(hoverTooltip.average)}</span><span className="ml-2">量 {formatVolume(hoverTooltip.volume)}</span><span className="ml-2">额 {formatAmount(hoverTooltip.amount)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default IntradayChart;
