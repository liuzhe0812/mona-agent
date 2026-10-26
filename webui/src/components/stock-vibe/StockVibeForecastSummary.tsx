import { useRef } from "react";
import type { StockVibeChartInterval, StockVibeForecast, StockVibeForecastResult } from "@/lib/stock-vibe-api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { stockNumber, stockPrice } from "@/lib/stock-vibe-market";

const UNAVAILABLE: Record<string, string> = {
  forecast_busy: "其他预测正在处理中，请稍后。",
  forecast_timeout: "预测准备超时，请稍后重试。",
  forecast_failed: "预测暂时不可用，请稍后重试。",
  market_not_supported: "暂不支持此市场的预测。",
  forecast_data_insufficient: "可用行情不足，暂无法预测。",
  intraday_market_closed: "盘中预测仅在交易时段更新。",
  intraday_no_future_minutes: "今日交易时间已结束。",
  daily_close_pending: "等待最新收盘行情。",
};

const PHASE: Record<string, string> = {
  data: "正在准备行情",
  features: "正在整理走势依据",
  validation: "正在核对历史表现",
  forecast: "正在生成预测",
  queued: "预测即将开始",
};

function forecastPointTime(point: StockVibeForecastResult["points"][number] | null, interval: StockVibeChartInterval) {
  if (!point) return null;
  if (interval === "intraday" && point.trade_date && /\d{2}:\d{2}/.test(point.trade_date) && Number.isFinite(Date.parse(point.trade_date))) {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(point.trade_date));
  }
  return point.label?.trim() || (stockNumber(point.step)
    ? `未来${point.step}${interval === "intraday" ? "个交易分钟" : "个交易日"}`
    : null);
}

function Header({ forecast, interval, loading, matching }: {
  forecast: StockVibeForecast | null; interval: StockVibeChartInterval; loading: boolean; matching: boolean;
}) {
  const status = loading || forecast?.status === "pending" ? "生成中"
    : !matching && forecast?.status === "ok" ? "行情已变化"
      : forecast?.status === "ok" && interval === "intraday" ? "盘中更新"
        : forecast?.status === "ok" && forecast.generation?.policy === "daily" && forecast.generation.reused ? "已保存结果"
          : forecast?.status === "ok" ? "模型估计" : "";
  const forecastSteps = forecast?.status === "ok"
    ? forecast.points.filter((point) => stockNumber(point.price) && point.price > 0).map((point) => point.step)
    : [];
  const steps = forecastSteps.length ? Math.max(...forecastSteps) : null;
  const horizon = steps !== null
    ? interval === "intraday" ? `未来${steps}个交易分钟` : `未来${steps}个交易日`
    : forecast?.status === "pending" ? interval === "intraday" ? "未来30个交易分钟" : "未来5个交易日"
      : null;
  return <>
    <div className="flex items-baseline gap-2">
      <h3 className="text-body font-medium text-foreground">走势预测</h3>
      {horizon && <span className="text-caption text-muted-foreground">{horizon}</span>}
    </div>
    {status && <span className="rounded-full bg-info/10 px-2 py-0.5 text-caption text-info">{status}</span>}
  </>;
}

export function StockVibeForecastDetails({ forecast, interval, point }: {
  forecast: StockVibeForecastResult;
  interval: StockVibeChartInterval;
  point?: StockVibeForecastResult["points"][number];
}) {
  const points = forecast.points.filter((item) => stockNumber(item.price) && item.price > 0);
  const finalPoint = points.length ? points.reduce((furthest, item) => item.step > furthest.step ? item : furthest) : null;
  const referencePoint = point ?? finalPoint;
  const insufficientHistory = forecast.reason_code === "validation_history_insufficient";
  const referenceUnavailable = insufficientHistory || forecast.signal_state === "abstain";
  const priceAvailable = Boolean(!referenceUnavailable && referencePoint && stockNumber(referencePoint.price) && referencePoint.price > 0);
  const rangeAvailable = Boolean(!referenceUnavailable && referencePoint
    && stockNumber(referencePoint.lower) && stockNumber(referencePoint.upper)
    && referencePoint.lower <= referencePoint.upper);
  const mae = forecast.validation.mae;
  const baseline = forecast.validation.baseline_mae;
  const validMae = !insufficientHistory && stockNumber(mae) && mae >= 0;
  const validPrice = stockNumber(forecast.last_price) && forecast.last_price > 0;
  const errorAmount = !insufficientHistory && stockNumber(mae) && mae >= 0 && stockNumber(forecast.last_price) && forecast.last_price > 0
    ? forecast.last_price * mae : null;
  const errorPoints = !insufficientHistory && stockNumber(mae) && mae >= 0 ? mae * 100 : null;
  const historicalErrorAvailable = stockNumber(errorAmount) && stockNumber(errorPoints);
  const comparison = historicalErrorAvailable && stockNumber(mae) && mae >= 0 && stockNumber(baseline) && baseline >= 0
    ? mae < baseline ? "比假设股价不动更接近实际" : "历史误差较大，仅供参考"
    : null;
  const missingError = insufficientHistory || !validMae ? "历史验证样本不足"
    : !validPrice ? "当前股价不可用，暂无法折算"
      : "历史误差暂无法折算";
  const referenceTime = forecastPointTime(referencePoint, interval);

  return <div className="stock-vibe-forecast-details space-y-3 text-caption">
    {interval === "1D" && <p className="text-caption text-muted-foreground">预测按已收盘日K计算，图中暂不含今日未收盘K；当前报价仍显示实时行情。</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="min-w-0 space-y-1">
        <p className="text-caption text-muted-foreground">预测参考</p>
        {referenceTime && <p className="text-body text-foreground">{referenceTime}</p>}
        {priceAvailable && referencePoint
          ? <p className="text-body text-foreground">参考价 {stockPrice(referencePoint.price)}</p>
          : <p className="text-body text-foreground">参考价 暂不可用</p>}
        {rangeAvailable && referencePoint
          ? <p className="text-body text-foreground">参考范围 {stockPrice(referencePoint.lower)} – {stockPrice(referencePoint.upper)}</p>
          : <p className="text-body text-foreground">参考范围 暂不可用</p>}
      </div>
      <div className="min-w-0 space-y-1">
        <TooltipProvider delayDuration={250}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} role="note" aria-label="历史误差参考说明" className="inline-flex rounded-sm text-caption font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                历史误差参考
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-72 whitespace-normal text-left">
              {historicalErrorAvailable
                ? `历史预测的涨跌幅与实际结果平均相差 ${errorPoints.toFixed(2)} 个百分点，再按预测时股价折算。这是整体历史参考，并非该预测点未来的误差范围。`
                : "历史误差按预测时股价折算；数据不足时不显示估算金额。"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {historicalErrorAvailable
          ? <>
            <p className="text-body font-medium text-foreground">平均差约 {stockPrice(errorAmount)} 元</p>
            <p className="text-caption text-muted-foreground">按预测时股价折算</p>
            {comparison && <p className="text-caption text-muted-foreground">{comparison}</p>}
          </>
          : <p className="text-body font-medium text-foreground">{missingError}</p>}
      </div>
    </div>
    {forecast.forward_validation && forecast.forward_validation.completed_points > 0 && <dl className="flex flex-wrap gap-x-4 gap-y-1 text-caption">
      <div className="flex gap-1"><dt className="text-muted-foreground">到期核对</dt><dd>{forecast.forward_validation.completed_points} 个预测点</dd></div>
      <div className="flex gap-1"><dt className="text-muted-foreground">实际平均偏差</dt><dd>{stockNumber(forecast.forward_validation.mae)
        ? `${(forecast.forward_validation.mae * 100).toFixed(2)} 个百分点` : "暂无"}</dd></div>
    </dl>}
  </div>;
}

export function StockVibeForecastSummary({ forecast, interval, loading = false, matching = false }: {
  forecast: StockVibeForecast | null;
  interval: StockVibeChartInterval;
  loading?: boolean;
  matching?: boolean;
}) {
  const detailsTitle = useRef<HTMLHeadingElement>(null);
  if (!forecast && !loading) return null;

  const result = forecast?.status === "ok" ? forecast : null;
  const unavailableInsufficient = forecast?.status === "unavailable" && forecast.reason_code === "forecast_data_insufficient";
  const points = result && matching ? result.points.filter((point) => stockNumber(point.price) && point.price > 0) : [];
  const finalPoint = points.length ? points.reduce((furthest, point) => point.step > furthest.step ? point : furthest) : null;
  const insufficient = result?.reason_code === "validation_history_insufficient"
    || forecast?.status === "unavailable" && forecast.reason_code === "forecast_data_insufficient";
  const canComparePrice = Boolean(finalPoint && stockNumber(result?.last_price) && result.last_price > 0);
  const noDirection = insufficient || !finalPoint || result?.signal_state === "abstain" || !canComparePrice;
  const historicalMean = result?.validation.model_id === "historical_distribution"
    || result?.selection?.model_id === "historical_distribution";

  let direction = "";
  let directionClass = "text-muted-foreground";
  let expected = "";
  if (insufficient) {
    direction = "数据不足";
  } else if (noDirection && finalPoint && result?.signal_state !== "abstain") {
    direction = "数据不足";
  } else if (noDirection) {
    direction = "暂不判断";
  } else if (finalPoint && result?.last_price && stockNumber(result.last_price)) {
    const change = finalPoint.price / result.last_price - 1;
    direction = change > 0 ? "预估偏涨" : change < 0 ? "预估偏跌" : "预估持平";
    directionClass = change > 0 ? "text-stock-up" : change < 0 ? "text-stock-down" : "text-muted-foreground";
    expected = `${change > 0 ? "+" : ""}${(change * 100).toFixed(2)}%`;
  }

  return <TooltipProvider delayDuration={250}>
    <Dialog>
      <section className="stock-vibe-forecast-summary flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="走势预测摘要" aria-live={loading || forecast?.status === "pending" ? "polite" : undefined}>
        <Header forecast={forecast} interval={interval} loading={loading} matching={matching} />
        <div className="stock-vibe-forecast-metrics flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {loading && forecast?.status !== "pending" ? <span className="text-caption text-muted-foreground">正在准备走势预测。</span>
            : forecast?.status === "pending" ? <span className="text-caption text-muted-foreground">{PHASE[forecast.phase] ?? "正在准备走势预测"}</span>
              : forecast?.status === "unavailable" && unavailableInsufficient ? <>
                <span className="text-body font-medium text-muted-foreground">数据不足</span>
                <span className="text-caption text-muted-foreground">历史验证样本不足</span>
              </>
                : forecast?.status === "unavailable" ? <span className="text-caption text-muted-foreground">{UNAVAILABLE[forecast.reason_code ?? ""] ?? "暂时无法生成走势预测。"}</span>
                  : result && !matching ? <span className="text-caption text-muted-foreground">已保存结果与当前行情不一致。</span>
                    : result ? <>
                      {historicalMean && <span className="text-caption text-muted-foreground">历史走势参考</span>}
                      <span className="flex items-baseline gap-1 text-body font-medium">
                        <span className={directionClass}>{direction}</span>
                        {!noDirection && expected && <span className={`tabular-nums ${directionClass}`}>{expected}</span>}
                      </span>
                      {!noDirection && finalPoint && <span className="text-caption text-muted-foreground">参考价 {stockPrice(finalPoint.price)}</span>}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DialogTrigger asChild>
                            <Button type="button" variant="ghost" size="sm" className="h-auto px-0 py-0 text-caption">预测详情</Button>
                          </DialogTrigger>
                        </TooltipTrigger>
                        <TooltipContent side="top">查看参考区间、历史误差和到期核对</TooltipContent>
                      </Tooltip>
                    </> : null}
        </div>
      </section>
      {result && matching && <DialogContent aria-describedby={undefined} className="scrollbar-scope max-h-[80vh] overflow-y-auto sm:rounded-lg"
        onOpenAutoFocus={(event) => { event.preventDefault(); detailsTitle.current?.focus(); }}>
        <DialogHeader><DialogTitle ref={detailsTitle} tabIndex={-1}>走势预测详情</DialogTitle></DialogHeader>
        <StockVibeForecastDetails forecast={result} interval={interval} />
      </DialogContent>}
    </Dialog>
  </TooltipProvider>;
}
