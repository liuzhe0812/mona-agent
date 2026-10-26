import { useEffect, useId, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { StockVibeChartInterval, StockVibeForecast, StockVibeRead } from "@/lib/stock-vibe-api";
import { stockBars, stockNumber, stockPrice, stockRecord, workbenchMarket } from "@/lib/stock-vibe-market";
import { StockVibeForecastDetails, StockVibeForecastSummary } from "./StockVibeForecastSummary";

const UP = "hsl(var(--stock-up))", DOWN = "hsl(var(--stock-down))", NEUTRAL = "hsl(var(--muted-foreground))";
const color = (value: number, baseline: number | null | undefined) => stockNumber(baseline)
  ? value > baseline ? UP : value < baseline ? DOWN : NEUTRAL : "hsl(var(--data-1))";
const percent = (value: number, baseline: number) => `${value > baseline ? "+" : ""}${((value / baseline - 1) * 100).toFixed(2)}%`;
const clockFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
});
const clock = (value: string) => clockFormatter.format(new Date(value));
const minute = (value: string) => {
  const [h, m] = clock(value).split(":").map(Number);
  return h * 60 + m <= 690 ? h * 60 + m - 570 : h * 60 + m - 660;
};

export function StockVibeChart({ symbol, result, loading, interval = "1D", forecast = null, forecastLoading = false }: {
  symbol: string; result: StockVibeRead | null; loading: boolean; interval?: StockVibeChartInterval;
  forecast?: StockVibeForecast | null; forecastLoading?: boolean;
}) {
  const readyForecast = forecast?.status === "ok" ? forecast : null;
  const { bars: all } = useMemo(() => stockBars(result, symbol, interval), [result, symbol, interval]);
  const completeOnly = interval === "1D" && readyForecast?.symbol === symbol && readyForecast.interval === interval
    && typeof readyForecast.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(readyForecast.as_of)
    && all.some((bar) => bar.trade_date > readyForecast.as_of!);
  const bars = useMemo(() => (completeOnly ? all.filter((bar) => bar.trade_date <= readyForecast!.as_of!) : all)
    .slice(interval === "intraday" ? -300 : -80), [all, completeOnly, readyForecast?.as_of, interval]);
  const barMinutes = useMemo(() => interval === "intraday" ? bars.map((bar) => minute(bar.trade_date)) : [], [bars, interval]);
  const [focus, setFocus] = useState<number | null>(null);
  const [forecastFocus, setForecastFocus] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const areaId = `stock-vibe-area-${useId().replace(/:/g, "")}`;
  const [canvasWidth, setCanvasWidth] = useState(900);
  const [canvasHeight, setCanvasHeight] = useState(370);
  useEffect(() => {
    const element = svgRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setCanvasWidth(Math.max(320, Math.round(entry.contentRect.width)));
      if (entry.contentRect.height > 0) setCanvasHeight(Math.max(192, Math.round(entry.contentRect.height)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [bars.length]);
  const data = workbenchMarket(result, symbol);
  const native = stockRecord(result?.native);
  const provenance = stockRecord(stockRecord(native?._provenance)?.[symbol]);
  const intraday = interval === "intraday", last = bars[bars.length - 1];
  const match = readyForecast?.symbol === symbol && readyForecast.interval === interval
    && last && readyForecast.as_of === last.trade_date && stockNumber(readyForecast.last_price)
    && Math.abs(readyForecast.last_price - last.close) <= Math.max(0.00001, last.close * 0.000001);
  const points = match ? readyForecast.points.filter((p) => stockNumber(p.price) && p.price > 0) : [];
  const abstained = Boolean(match && readyForecast?.signal_state === "abstain");
  const chartPoints = abstained ? [] : points;
  useEffect(() => { setFocus(null); setForecastFocus(null); }, [symbol, interval, forecast]);
  if (loading && !bars.length) return <div className="stock-vibe-chart-empty flex items-center justify-center text-body text-muted-foreground" role="status">正在读取行情…</div>;
  if (!bars.length) return <EmptyState title="暂无可显示的行情" description={data?.reason || "暂未取得有效行情，可以换一个周期或刷新。"} className="stock-vibe-chart-empty" />;
  const focused = bars[focus === null ? bars.length - 1 : Math.min(focus, bars.length - 1)];
  const previous = stockNumber(data?.quote.previous_close) && data.quote.previous_close > 0 ? data.quote.previous_close : null;
  const values = bars.flatMap((b) => intraday ? [b.close] : [b.low!, b.high!]);
  if (intraday) values.push(...[data?.quote.high, data?.quote.low].filter((value): value is number => stockNumber(value) && value > 0));
  if (intraday && previous !== null) values.push(previous);
  chartPoints.forEach((p) => { values.push(p.price); if (stockNumber(p.lower)) values.push(p.lower); if (stockNumber(p.upper)) values.push(p.upper); });
  const low = Math.min(...values), high = Math.max(...values), pad = Math.max((high - low) * 0.08, high * 0.001, 0.01);
  // 分时均价按成交量加权累计，只是把真实成交价按量摊平，不引入任何外部数值。
  const average = intraday ? (() => {
    let amount = 0, volume = 0;
    return bars.map((bar) => {
      const size = stockNumber(bar.volume) && bar.volume > 0 ? bar.volume : 0;
      amount += bar.close * size; volume += size;
      return volume > 0 ? amount / volume : null;
    });
  })() : [];
  const volumeHeight = Math.min(64, Math.max(30, canvasHeight * 0.17));
  const axisY = canvasHeight - 8, volumeBottom = canvasHeight - 26, chartBottom = volumeBottom;
  const priceTop = 10, priceBottom = Math.max(priceTop + 60, volumeBottom - volumeHeight - 16);
  const extent = intraday && previous !== null ? Math.max(high - previous, previous - low) || Math.max(high * 0.001, 0.01) : null;
  const bottom = extent !== null ? previous! - extent : low - pad, top = extent !== null ? previous! + extent : high + pad;
  const y = (n: number) => priceTop + (top - n) / (top - bottom) * (priceBottom - priceTop);
  const predictionSteps = points.length ? Math.max(...points.map((point) => point.step)) : 0;
  const futureSteps = intraday || abstained ? 0 : predictionSteps;
  const plotLeft = intraday ? 64 : 20, plotRight = canvasWidth - 85;
  const plotWidth = canvasWidth - plotLeft - 90;
  const step = plotWidth / (bars.length + futureSteps);
  const minuteX = (value: number) => plotLeft + Math.max(0, Math.min(240, value)) / 240 * plotWidth;
  const tx = (time: string) => minuteX(minute(time));
  const x = (i: number) => intraday ? minuteX(barMinutes[i]) : 20 + (i + 0.5) * step;
  const fx = (p: typeof chartPoints[number]) => intraday && p.trade_date ? tx(p.trade_date)
    : x(bars.length - 1) + p.step * step;
  const maxVolume = Math.max(...bars.map((b) => stockNumber(b.volume) ? b.volume : 0), 1);
  const range = chartPoints.length > 0 && chartPoints.every((p) => stockNumber(p.lower) && stockNumber(p.upper));
  const labels: Record<string, string> = { lots: "手", shares: "股" };
  const unit = data?.volume_unit ?? provenance?.volume_unit;
  const forecastPoint = forecastFocus !== null ? chartPoints[Math.min(forecastFocus, chartPoints.length - 1)] : null;
  const forecastLeft = x(bars.length - 1), forecastRight = chartPoints.length ? fx(chartPoints[chartPoints.length - 1]) : forecastLeft;
  return <div className="stock-vibe-chart min-w-0" aria-busy={loading}>
    {/* 读数以悬停卡片呈现，这一行保留给键盘与读屏，视觉上不再占一条横带。 */}
    <div className="sr-only">
      <span>{intraday ? clock(focused.trade_date) : focused.trade_date.replace("T", " ").slice(0, 16)}</span>
      {!intraday && <><span>开 {stockPrice(focused.open!)}</span><span>高 {stockPrice(focused.high!)}</span><span>低 {stockPrice(focused.low!)}</span></>}
      <span style={{ color: intraday ? color(focused.close, previous) : undefined }}>{intraday ? "价格" : "收"} {stockPrice(focused.close)}</span>
      {intraday && previous !== null && <span style={{ color: color(focused.close, previous) }}>涨跌幅 {percent(focused.close, previous)}</span>}
      <span style={{ color: intraday ? color(focused.close, previous) : undefined }}>量 {stockNumber(focused.volume) ? focused.volume.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) : "未报告"} {labels[String(unit)] ?? "（单位未报告）"}</span>
    </div>
    <div className="stock-vibe-chart-surface" onPointerLeave={() => { setFocus(null); setForecastFocus(null); }}>
    <svg ref={svgRef} viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} height={370} className="stock-vibe-chart-plot w-full text-muted-foreground" role="img" tabIndex={0}
      aria-label={`${symbol.slice(0, 6)}，${intraday ? "最近交易日真实分时" : `${bars.length}根真实行情K线`}${chartPoints.length ? "，附预测走势与参考范围" : ""}，左右方向键查看数据`}
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        e.preventDefault(); setFocus((i) => Math.max(0, Math.min(bars.length - 1, (i ?? bars.length - 1) + (e.key === "ArrowLeft" ? -1 : 1))));
      }} onPointerLeave={() => setFocus(null)}>
      {[0, 1, 2, 3, 4].map((n) => {
        const baseline = intraday && previous !== null && n === 2;
        const value = baseline ? previous : bottom + (top - bottom) * n / 4;
        const fill = intraday && previous !== null ? color(value, previous) : "currentColor";
        return <g key={n}>
          <line x1={plotLeft} x2={plotRight} y1={y(value)} y2={y(value)}
            className={baseline ? "stroke-muted-foreground" : "stroke-border"} strokeDasharray={baseline ? "4 4" : undefined} opacity={baseline ? 0.5 : undefined} />
          {(!intraday || n % 2 === 0) && <>
            <text x={intraday ? plotLeft - 12 : canvasWidth - 73} y={y(value) + 4} textAnchor={intraday ? "end" : "start"}
              fill={fill} className="text-micro">{stockPrice(value)}</text>
            {intraday && previous !== null && <text x={canvasWidth - 73} y={y(value) + 4} fill={fill} className="text-micro">{percent(value, previous)}</text>}
          </>}
        </g>;
      })}
      {intraday && <>
        <defs>
          <linearGradient id={areaId} x1="0" y1={priceTop} x2="0" y2={priceBottom} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={color(last.close, previous)} stopOpacity="0.2" />
            <stop offset="1" stopColor={color(last.close, previous)} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`M${bars.map((bar, i) => `${x(i)},${y(bar.close)}`).join(" L")} L${x(bars.length - 1)},${priceBottom} L${x(0)},${priceBottom} Z`}
          fill={`url(#${areaId})`} />
        {average.some((value) => value !== null) && <polyline fill="none" strokeWidth={1.2} strokeDasharray="4 3"
          stroke="hsl(var(--data-1))"
          points={average.map((value, i) => value === null ? "" : `${x(i)},${y(value)}`).filter(Boolean).join(" ")} />}
      </>}
      {bars.map((b, i) => {
        const c = color(b.close, intraday ? (i ? bars[i - 1].close : previous) : b.open);
        return <g key={b.trade_date} onPointerEnter={() => setFocus(i)}>
          <rect x={x(i) - Math.max(step, 3) / 2} width={Math.max(step, 3)} y={priceTop} height={chartBottom - priceTop} fill="transparent" />
          {intraday ? i > 0 && <line x1={x(i - 1)} x2={x(i)} y1={y(bars[i - 1].close)} y2={y(b.close)}
            stroke={color(b.close, previous)} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /> : <>
            <line x1={x(i)} x2={x(i)} y1={y(b.high!)} y2={y(b.low!)} stroke={c} />
            <rect x={x(i) - Math.max(1, step * 0.65) / 2} width={Math.max(1, step * 0.65)}
              y={Math.min(y(b.open!), y(b.close))} height={Math.max(1, Math.abs(y(b.open!) - y(b.close)))} fill={c} /></>}
          {stockNumber(b.volume) && b.volume >= 0 && <rect x={x(i) - Math.max(1, Math.min(step, 6) * 0.7) / 2}
            width={Math.max(1, Math.min(step, 6) * 0.7)} y={volumeBottom - b.volume / maxVolume * volumeHeight}
            height={b.volume / maxVolume * volumeHeight} fill={c} opacity={0.3} />}
        </g>;
      })}
      {chartPoints.length > 0 && <>
        <line x1={x(bars.length - 1)} x2={x(bars.length - 1)} y1={priceTop} y2={chartBottom} className="stroke-muted-foreground" strokeDasharray="4 4" />
        {range && <polygon points={[`${x(bars.length - 1)},${y(last.close)}`,
          ...chartPoints.map((p) => `${fx(p)},${y(p.upper!)}`), ...[...chartPoints].reverse().map((p) => `${fx(p)},${y(p.lower!)}`)].join(" ")}
          fill={color(chartPoints[chartPoints.length - 1].price, last.close)} opacity={0.08} />}
        {chartPoints.map((p, i) => <line key={p.step} x1={i ? fx(chartPoints[i - 1]) : x(bars.length - 1)}
          y1={y(i ? chartPoints[i - 1].price : last.close)} x2={fx(p)} y2={y(p.price)}
          stroke={color(p.price, last.close)} strokeWidth={1.5} strokeDasharray="5 4" />)}
        {!intraday && chartPoints.slice(-1).map((p) =>
          <text key={p.step} x={fx(p)} y={axisY} textAnchor="end" className="fill-current text-micro">{p.label}</text>)}
      </>}
      {focus !== null && <line x1={x(Math.min(focus, bars.length - 1))} x2={x(Math.min(focus, bars.length - 1))}
        y1={priceTop} y2={chartBottom} className="stroke-muted-foreground" strokeDasharray="3 3" />}
      {forecastPoint && <g pointerEvents="none">
        <line x1={fx(forecastPoint)} x2={fx(forecastPoint)} y1={priceTop} y2={chartBottom} className="stroke-muted-foreground" strokeDasharray="3 3" />
        <circle cx={fx(forecastPoint)} cy={y(forecastPoint.price)} r={3} fill={color(forecastPoint.price, last.close)} />
      </g>}
      {intraday ? [["09:30", 0], ["10:30", 60], ["11:30", 120], ["13:30", 150], ["14:00", 180], ["15:00", 240]].map(([label, m]) =>
        <text key={label} x={plotLeft + Number(m) / 240 * plotWidth} y={axisY} textAnchor={m === 0 ? "start" : m === 240 ? "end" : "middle"}
          className="fill-current text-micro">{label}</text>) : <>
        <text x={20} y={axisY} className="fill-current text-micro">{bars[0].trade_date.slice(0, 10)}</text>
        <text x={chartPoints.length ? x(bars.length - 1) : canvasWidth - 90} y={chartPoints.length ? axisY - 13 : axisY} textAnchor="end" className="fill-current text-micro">{last.trade_date.slice(0, 10)}</text></>}
    </svg>
      {focus !== null && (() => {
        const index = Math.min(focus, bars.length - 1);
        const bar = bars[index];
        const averageText = intraday && stockNumber(average[index]) ? stockPrice(average[index]!) : null;
        return <div className="stock-vibe-chart-tip shadow-float" style={{ left: Math.min(Math.max(x(index) + 14, 8), Math.max(8, canvasWidth - 186)), top: priceTop + 4 }}>
          <p className="stock-vibe-chart-tip-time">{intraday ? clock(bar.trade_date) : bar.trade_date.slice(0, 10)}</p>
          <dl>
            <div><dt>价格</dt><dd style={{ color: intraday ? color(bar.close, previous) : undefined }}>{stockPrice(bar.close)}</dd></div>
            {averageText && <div><dt>均价</dt><dd>{averageText}</dd></div>}
            {!intraday && <div><dt>开 / 高</dt><dd>{stockPrice(bar.open!)} / {stockPrice(bar.high!)}</dd></div>}
            {!intraday && <div><dt>低 / 收</dt><dd>{stockPrice(bar.low!)} / {stockPrice(bar.close)}</dd></div>}
            <div><dt>成交量</dt><dd>{stockNumber(bar.volume) ? bar.volume.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) : "未报告"} {labels[String(unit)] ?? ""}</dd></div>
          </dl>
        </div>;
      })()}
      {chartPoints.length > 0 && readyForecast && <TooltipProvider delayDuration={0}>
        <Tooltip open={forecastPoint !== null} onOpenChange={(open) => { if (!open) setForecastFocus(null); }}>
          <TooltipTrigger asChild><button type="button" aria-label="查看预测走势详情，左右方向键切换预测点"
            className="absolute cursor-crosshair rounded-sm bg-transparent p-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring"
            style={{ left: `${forecastLeft / canvasWidth * 100}%`, top: `${priceTop / canvasHeight * 100}%`,
              width: `${Math.max(16, forecastRight - forecastLeft) / canvasWidth * 100}%`, height: `${(chartBottom - priceTop) / canvasHeight * 100}%` }}
            onPointerEnter={() => { setFocus(null); setForecastFocus(chartPoints.length - 1); }}
            onPointerMove={(event) => {
              const bounds = svgRef.current?.getBoundingClientRect();
              if (!bounds?.width) return;
              const pointerX = (event.clientX - bounds.left) / bounds.width * canvasWidth;
              setForecastFocus(chartPoints.reduce((nearest, p, i) => Math.abs(fx(p) - pointerX) < Math.abs(fx(chartPoints[nearest]) - pointerX) ? i : nearest, 0));
            }}
            onFocus={() => setForecastFocus(chartPoints.length - 1)}
            onClick={(event) => { event.preventDefault(); setForecastFocus((value) => value ?? chartPoints.length - 1); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") { setForecastFocus(null); event.stopPropagation(); }
              if (["ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key)) {
                event.preventDefault(); event.stopPropagation();
                setForecastFocus((value) => Math.max(0, Math.min(chartPoints.length - 1, (value ?? chartPoints.length - 1) + (event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0))));
              }
            }} /></TooltipTrigger>
          <TooltipContent side="top" className="max-w-sm border border-border bg-popover text-popover-foreground [&>svg]:fill-popover">
            {forecastPoint && <StockVibeForecastDetails forecast={readyForecast} interval={interval} point={forecastPoint} />}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>}
    </div>
    {forecast?.symbol === symbol && forecast.interval === interval && <StockVibeForecastSummary
      forecast={forecast} interval={interval} matching={Boolean(match)} />}
    {!forecast && forecastLoading && <StockVibeForecastSummary forecast={null} interval={interval} loading />}
  </div>;
}
