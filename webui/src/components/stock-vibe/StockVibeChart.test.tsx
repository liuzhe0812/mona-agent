import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StockVibeChart } from "./StockVibeChart";
import type { StockVibeBar, StockVibeForecastResult, StockVibeRead, StockVibeWorkbenchMarketData } from "@/lib/stock-vibe-api";

const SYMBOL = "002460.SZ";
afterEach(() => vi.unstubAllGlobals());

function market(interval: "intraday" | "1D", bars: StockVibeBar[]): StockVibeRead<StockVibeWorkbenchMarketData> {
  return { source: null, native: {
    status: "ok", symbol: SYMBOL, interval, bars,
    quote: { price: bars[bars.length - 1].close, previous_close: 40, change: null, change_pct: null },
    trading_date: "2026-10-19", market_open: true, market_state: "open", source: "eastmoney",
    observed_at: "2026-10-19T13:02:00+08:00", volume_unit: "lots", adjustment: "none",
  } };
}

function forecast(interval: "intraday" | "1D", asOf: string, lastPrice: number): StockVibeForecastResult {
  return { symbol: SYMBOL, interval, status: "ok", experimental: true, as_of: asOf, last_price: lastPrice,
    points: [{ step: 1, price: 40.5, lower: 39, upper: 42, label: "+1交易日", trade_date: "2026-10-19T13:03:00+08:00" },
      { step: 2, price: 41, lower: 38, upper: 43, label: "+2交易日", trade_date: "2026-10-19T13:04:00+08:00" }],
    horizon_unit: interval === "1D" ? "trading_day" : "trading_minute", model_version: "test-model",
    training_cutoff: asOf, training_rows: 60, data_fingerprint: null, features: ["return"],
    computed_at: "2026-10-18T13:10:00Z", generation: { policy: interval === "1D" ? "daily" : "realtime", reused: false },
    validation: { method: "walk_forward", mae: 0.01, baseline_mae: 0.02, samples: 10, folds: 2,
      beat_baseline: true, by_horizon: [] },
  };
}

function expectPairedAxisTick(chart: HTMLElement, priceText: string, percentText: string, fill: string) {
  const price = within(chart).getByText(priceText);
  const percent = within(chart).getByText(percentText);
  expect(Number(price.getAttribute("x"))).toBeLessThan(450);
  expect(Number(percent.getAttribute("x"))).toBeGreaterThan(450);
  expect(price.getAttribute("y")).toBe(percent.getAttribute("y"));
  expect(price.getAttribute("fill") ?? price.closest("g")?.getAttribute("fill")).toBe(fill);
  expect(percent.getAttribute("fill") ?? percent.closest("g")?.getAttribute("fill")).toBe(fill);
}

describe("StockVibeChart source and forecast boundaries", () => {
  it("moves between intraday points without reformatting the full session and updates after new data", () => {
    const rows = Array.from({ length: 241 }, (_, i) => ({
      trade_date: new Date(Date.UTC(2026, 9, 19, 1, 30 + i + (i > 120 ? 90 : 0))).toISOString(),
      close: 40 + i / 100, volume: 100,
    }));
    const formatting = vi.spyOn(Intl.DateTimeFormat.prototype, "format", "get");
    try {
      const { container, rerender } = render(<StockVibeChart symbol={SYMBOL} result={market("intraday", rows)} loading={false} interval="intraday" />);
      const chart = screen.getByRole("img");
      const targets = chart.querySelectorAll('g > rect[fill="transparent"]');
      for (const index of [30, 180]) {
        formatting.mockClear();
        fireEvent.pointerEnter(targets[index]);
        const tip = container.querySelector(".stock-vibe-chart-tip") as HTMLElement;
        expect(within(tip).getByText(index === 30 ? "10:00" : "14:00")).toBeVisible();
        expect(within(tip).getByText(index === 30 ? "40.30" : "41.80")).toBeVisible();
        expect(formatting.mock.calls.length).toBeLessThanOrEqual(4);
      }
      fireEvent.pointerLeave(chart);
      expect(container.querySelector(".stock-vibe-chart-tip")).toBeNull();
      const next = rows.slice(1).map((row, i) => i === 180 ? { ...row, close: 42 } : row);
      rerender(<StockVibeChart symbol={SYMBOL} result={market("intraday", next)} loading={false} interval="intraday" />);
      fireEvent.pointerEnter(chart.querySelectorAll('g > rect[fill="transparent"]')[180]);
      const tip = container.querySelector(".stock-vibe-chart-tip") as HTMLElement;
      expect(within(tip).getByText("14:01")).toBeVisible();
      expect(within(tip).getByText("42.00")).toBeVisible();
    } finally { formatting.mockRestore(); }
  });

  it("shows pending progress without requiring prediction points or exposing job identifiers", () => {
    const data = market("1D", [{ trade_date: "2026-10-16", open: 39, high: 41, low: 38, close: 40, volume: 100 }]);
    const { container } = render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D" forecastLoading
      forecast={{ symbol: SYMBOL, interval: "1D", status: "pending", experimental: true, phase: "validation", retry_after_ms: 2000, job_id: "internal-job" }} />);
    expect(screen.getByText("正在核对历史表现")).toBeVisible();
    expect(screen.queryByText("正在准备走势预测。")).not.toBeInTheDocument();
    expect(screen.queryByText(/暂未取得与当前行情匹配/)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("internal-job");
    expect(container.querySelectorAll('line[stroke-dasharray="5 4"]')).toHaveLength(0);
  });

  it("does not draw an explicitly abstained result as a forecast", () => {
    const data = market("1D", [{ trade_date: "2026-10-16", open: 39, high: 41, low: 38, close: 40, volume: 100 }]);
    const prediction = forecast("1D", "2026-10-16", 40);
    prediction.signal_state = "abstain";
    prediction.points = [];
    prediction.selection = { method: "nested-time-selection", model_id: "zero-return-internal", model_name: "横盘参考", baseline_selected: true,
      candidate_count: 6, feature_count: 120, coverage: { registered: 478, eligible: 200, computed: 120, excluded: 358 }, basis: "nested_walk_forward" };
    prediction.forward_validation = { status: "waiting", forecasts: 1, completed_points: 0, mae: null, baseline_mae: null, coverage: null,
      revised_points: 0, last_scored_at: null, by_horizon: [] };
    const { container } = render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D" forecast={prediction} />);
    const chart = screen.getByRole("img");
    expect(screen.getByText("暂不判断")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
    expect(screen.getByText("平均差约 0.40 元")).toBeVisible();
    expect(screen.getByText("按预测时股价折算")).toBeVisible();
    expect(chart.getAttribute("aria-label")).not.toMatch(/横盘|预测|参考范围/);
    expect(container.querySelectorAll('line[stroke-dasharray="5 4"]')).toHaveLength(0);
    expect(container.querySelector("polygon")).not.toBeInTheDocument();
    expect(screen.queryByText("价格不变对照")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("6 组方案");
    expect(container.textContent).not.toContain("zero-return-internal");
    expect(container.textContent).not.toContain("478");
    expect(container.textContent).not.toContain("等待预测到期");
  });

  it("draws a computed price path even when its history is worse than a no-change reference", () => {
    const data = market("1D", [{ trade_date: "2026-10-16", open: 39, high: 41, low: 38, close: 40, volume: 100 }]);
    const prediction = forecast("1D", "2026-10-16", 40);
    prediction.validation = { ...prediction.validation, mae: 0.03, baseline_mae: 0.02, beat_baseline: false };
    const { container } = render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D" forecast={prediction} />);
    const chart = screen.getByRole("img");
    expect(screen.getByText("预估偏涨")).toBeVisible();
    expect(screen.getByText("参考价 41.00")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
    expect(screen.getByText("平均差约 1.20 元")).toBeVisible();
    expect(screen.getByText("历史误差较大，仅供参考")).toBeVisible();
    expect(chart.getAttribute("aria-label")).toContain("附预测走势");
    expect(container.querySelectorAll('line[stroke-dasharray="5 4"]')).toHaveLength(2);
  });

  it.each(["baseline", "unavailable"] as const)("does not report validation results when history is insufficient (%s)", (mode) => {
    const data = market("1D", [{ trade_date: "2026-10-16", open: 39, high: 41, low: 38, close: 40, volume: 100 }]);
    const prediction = forecast("1D", "2026-10-16", 40);
    prediction.points = [];
    prediction.validation = { ...prediction.validation, mae: 0.1, baseline_mae: 0.1, samples: 3 };
    const response = mode === "baseline"
      ? Object.assign(prediction, { reason_code: "validation_history_insufficient" })
      : { ...prediction, status: "unavailable" as const, reason_code: "forecast_data_insufficient" };
    if (mode === "baseline") response.selection = { method: "nested-time-selection", model_id: "zero-return-internal", model_name: "横盘参考", baseline_selected: true,
      candidate_count: 6, feature_count: 120, coverage: { registered: 478, eligible: 200, computed: 120, excluded: 358 }, basis: "nested_walk_forward" };
    const { container } = render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D" forecast={response} />);
    expect(screen.getByText("数据不足")).toBeVisible();
    if (mode === "baseline") {
      fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
      expect(screen.getByText("历史验证样本不足")).toBeVisible();
      expect(screen.queryByText(/平均差约/)).not.toBeInTheDocument();
    } else {
      expect(screen.getByText("历史验证样本不足")).toBeVisible();
    }
    expect(screen.queryByText(/暂未证明能准确预测|3 次历史对照|平均偏差|等待预测到期/)).not.toBeInTheDocument();
    expect(container.querySelectorAll('line[stroke-dasharray="5 4"]')).toHaveLength(0);
    expect(container.querySelector("polygon")).not.toBeInTheDocument();
  });

  it("explains unavailable predictions without exposing backend terminology", () => {
    const asOf = "2026-10-19T13:02:00+08:00";
    const data = market("intraday", [{ trade_date: asOf, close: 40, volume: 100 }]);
    const unavailable = { ...forecast("intraday", asOf, 40), status: "unavailable" as const,
      reason_code: "forecast_data_insufficient", reason: "复权历史或样本外验证数据不足" };
    const { rerender } = render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="intraday" forecast={unavailable} />);
    expect(screen.getByText("数据不足")).toBeVisible();
    expect(screen.getByText("历史验证样本不足")).toBeVisible();
    expect(screen.queryByText(unavailable.reason)).not.toBeInTheDocument();
    rerender(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="intraday"
      forecast={{ ...unavailable, reason_code: "intraday_market_closed" }} />);
    expect(screen.getByText("盘中预测仅在交易时段更新。")).toBeVisible();
  });

  it("shows concise prediction results without model identifiers or developer diagnostics", () => {
    const end = Date.parse("2026-10-16T00:00:00Z");
    const bars = Array.from({ length: 81 }, (_, index) => ({
      trade_date: new Date(end - (80 - index) * 86400000).toISOString().slice(0, 10),
      open: 39, high: 41, low: 38, close: 40, volume: 100,
    }));
    const data = market("1D", bars); data.native.source = "tencent";
    const prediction = forecast("1D", "2026-10-16", 40);
    prediction.model_version = "mona-ridge-walkforward-v1";
    prediction.training_rows = 966;
    prediction.points = [{ step: 5, price: 41, lower: 39, upper: 42, label: "+5交易日" }];
    prediction.validation = { ...prediction.validation, mae: 0.0378, baseline_mae: 0.0373, samples: 725, beat_baseline: false };
    prediction.forward_validation = { status: "waiting", forecasts: 1, completed_points: 0, mae: null, baseline_mae: null, coverage: null,
      revised_points: 0, last_scored_at: null, by_horizon: [] };
    const { container } = render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D" forecast={prediction} />);

    expect(screen.getByRole("heading", { name: "走势预测" })).toBeVisible();
    expect(screen.getByText("未来5个交易日")).toBeVisible();
    expect(screen.getByText("模型估计")).toBeVisible();
    expect(screen.getByText("预估偏涨")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
    expect(screen.getByText("走势预测详情")).toBeVisible();
    expect(screen.getByText("平均差约 1.512 元")).toBeVisible();
    expect(screen.getByText("历史误差较大，仅供参考")).toBeVisible();
    expect(screen.queryByText(/生成于|收盘后更新|行情说明|图中时间|上次刷新/)).not.toBeInTheDocument();
    for (const diagnostic of ["mona-ridge", "训练", "样本外", "基线", "原生", "残差", "前向", "方案"]) {
      expect(container.textContent).not.toContain(diagnostic);
    }
  });

  it("shows a concise comparison without raw validation details", () => {
    const data = market("1D", [{ trade_date: "2026-10-16", open: 39, high: 41, low: 38, close: 40, volume: 100 }]);
    const prediction = forecast("1D", "2026-10-16", 40);
    prediction.validation = { ...prediction.validation, mae: 0.0378, baseline_mae: 0.0373, samples: 328 };
    prediction.forward_validation = { status: "tracking", forecasts: 1, completed_points: 8, mae: 0.015,
      baseline_mae: 0.02, coverage: 0.75, revised_points: 0, last_scored_at: "2026-10-18T12:00:00Z", by_horizon: [] };
    render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D" forecast={prediction} />);
    fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
    expect(screen.getByText("平均差约 1.512 元")).toBeVisible();
    expect(screen.getByText("按预测时股价折算")).toBeVisible();
    expect(screen.queryByText("实际涨跌幅偏差")).not.toBeInTheDocument();
    expect(screen.queryByText("等待预测到期，暂时没有实际结果。")).not.toBeInTheDocument();
  });

  it("does not present a mismatched baseline response as a neutral forecast", () => {
    const data = market("1D", [{ trade_date: "2026-10-16", open: 39, high: 41, low: 38, close: 40, volume: 100 }]);
    const mismatched = forecast("1D", "2026-10-16", 40);
    mismatched.last_price = 99;
    mismatched.selection = { method: "nested-time-selection", model_id: "zero-return-internal", model_name: "横盘参考", baseline_selected: true,
      candidate_count: 6, feature_count: 120, coverage: { registered: 478, eligible: 200, computed: 120, excluded: 358 }, basis: "nested_walk_forward" };
    const { container } = render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D" forecast={mismatched} />);
    expect(screen.getByText("已保存结果与当前行情不一致。")).toBeVisible();
    expect(screen.queryByText(/横盘|暂不判断/)).not.toBeInTheDocument();
    expect(screen.getByRole("img").getAttribute("aria-label")).not.toMatch(/横盘|预测|参考范围/);
    expect(container.querySelectorAll('line[stroke-dasharray="5 4"]')).toHaveLength(0);
    expect(container.querySelector("polygon")).not.toBeInTheDocument();
  });

  it.each(["1D", "1W"] as const)("does not reuse a previous intraday response as %s candles while the period changes", (interval) => {
    const intraday = market("intraday", [
      { trade_date: "2026-10-19T15:00:00+08:00", close: 40, volume: 30 },
    ]);
    const { rerender } = render(<StockVibeChart symbol={SYMBOL} result={intraday} loading={false} interval="intraday" />);
    expect(screen.getByRole("img", { name: /最近交易日真实分时/ })).toBeInTheDocument();

    rerender(<StockVibeChart symbol={SYMBOL} result={intraday} loading interval={interval} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在读取行情");

    const bars = [{ trade_date: "2026-10-19", open: 39, high: 41, low: 38, close: 40, volume: 30 }];
    const next = interval === "1D" ? market("1D", bars) : { source: null, native: { [SYMBOL]: bars } };
    rerender(<StockVibeChart symbol={SYMBOL} result={next} loading={false} interval={interval} />);
    expect(screen.getByRole("img", { name: /1根真实行情K线/ })).toBeInTheDocument();
    expect(screen.getByText("开 39.00")).toBeInTheDocument();
  });

  it("does not draw daily candles as intraday data after switching back", () => {
    const data = market("1D", [
      { trade_date: "2026-10-19", open: 39, high: 41, low: 38, close: 40, volume: 30 },
    ]);
    const { rerender } = render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D" />);
    rerender(<StockVibeChart symbol={SYMBOL} result={data} loading interval="intraday" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在读取行情");
  });

  it("omits candles with missing or invalid OHLC instead of inventing prices", () => {
    const data = market("1D", [
      { trade_date: "2026-10-15", open: 39, high: 41, low: 38, close: 40, volume: 100 },
      { trade_date: "2026-10-16", close: 39.29, volume: 110 },
      { trade_date: "2026-10-19", open: 40, high: Number.NaN, low: 39, close: 42, volume: 50 },
    ]);
    const { rerender } = render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D" />);
    const chart = screen.getByRole("img", { name: /1根真实行情K线/ });
    expect(screen.getByText("收 40.00")).toBeInTheDocument();
    expect(chart.innerHTML).not.toMatch(/NaN|undefined/);
    rerender(<StockVibeChart symbol={SYMBOL} result={market("1D", data.native.bars.slice(1))} loading={false} interval="1D" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("暂无可显示的行情")).toBeInTheDocument();
  });

  it("keeps candle, volume, and date coordinates inside a resized chart and preserves keyboard selection", () => {
    let resize!: (width: number, height: number) => void;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        resize = (width, height) => callback([{ contentRect: { width, height } }] as ResizeObserverEntry[], this as unknown as ResizeObserver);
      }
      observe() { resize(900, 370); }
      disconnect() {}
    });
    const data = market("1D", [
      { trade_date: "2026-10-15", open: 39, high: 41, low: 38, close: 40, volume: 100 },
      { trade_date: "2026-10-16", open: 40, high: 41, low: 39, close: 39.5, volume: 80 },
      { trade_date: "2026-10-19", open: 39.5, high: 42, low: 39, close: 40.5, volume: 120 },
    ]);
    render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D" />);
    const chart = screen.getByRole("img");
    expect(chart).toHaveAttribute("viewBox", "0 0 900 370");
    act(() => resize(600, 220));
    expect(chart).toHaveAttribute("viewBox", "0 0 600 220");

    const expectInside = (value: number, maximum: number) => {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(maximum);
    };
    for (const line of chart.querySelectorAll("line")) {
      for (const name of ["x1", "x2"]) expectInside(Number(line.getAttribute(name)), 600);
      for (const name of ["y1", "y2"]) expectInside(Number(line.getAttribute(name)), 220);
    }
    const volumes = chart.querySelectorAll('rect[opacity="0.3"]');
    expect(volumes).toHaveLength(3);
    for (const volume of volumes) {
      expectInside(Number(volume.getAttribute("x")), 600);
      expect(Number(volume.getAttribute("x")) + Number(volume.getAttribute("width"))).toBeLessThanOrEqual(600);
      expect(Number(volume.getAttribute("y"))).toBeGreaterThanOrEqual(0);
      expect(Number(volume.getAttribute("y")) + Number(volume.getAttribute("height"))).toBeLessThanOrEqual(220);
    }
    const lastDate = within(chart).getByText("2026-10-19");
    expectInside(Number(lastDate.getAttribute("x")), 600);
    expectInside(Number(lastDate.getAttribute("y")), 220);
    expect(screen.getByText("收 40.50")).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByText("收 39.50")).toBeInTheDocument();
  });
  it("keeps forecast point keyboard navigation separate from historical candle selection", () => {
    const data = market("1D", [
      { trade_date: "2026-10-16", open: 39, high: 41, low: 38, close: 39.5, volume: 100 },
      { trade_date: "2026-10-19", open: 39.5, high: 41, low: 39, close: 40, volume: 120 },
    ]);
    const prediction = forecast("1D", "2026-10-19", 40);
    render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D" forecast={prediction} />);
    const chart = screen.getByRole("img");
    const forecastTrigger = screen.getByRole("button", { name: /查看预测走势详情/ });

    fireEvent.pointerEnter(forecastTrigger);
    let tooltip = screen.getByRole("tooltip");
    expect(within(tooltip).getByText("+2交易日")).toBeVisible();
    expect(within(tooltip).getByText("参考价 41.00")).toBeVisible();
    fireEvent.keyDown(forecastTrigger, { key: "ArrowLeft" });
    tooltip = screen.getByRole("tooltip");
    expect(within(tooltip).getByText("+1交易日")).toBeVisible();
    expect(within(tooltip).getByText("参考价 40.50")).toBeVisible();
    expect(screen.getByText("收 40.00")).toBeInTheDocument();
    fireEvent.keyDown(forecastTrigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.focus(forecastTrigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(within(screen.getByRole("tooltip")).getByText("+2交易日")).toBeVisible();
    fireEvent.keyDown(forecastTrigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    chart.focus();
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByText("收 39.50")).toBeInTheDocument();
  });
  it("draws actual intraday points with lunch compressed and overlays only the matching forecast", () => {
    const lastTime = "2026-10-19T13:02:00+08:00";
    const data = market("intraday", [
      { trade_date: "2026-10-19T11:29:00+08:00", close: 39, volume: 20 },
      { trade_date: "2026-10-19T13:01:00+08:00", close: 39.5, volume: 10 },
      { trade_date: lastTime, close: 40, volume: 30 },
      { trade_date: "2026-10-19T13:03:00+08:00", close: 0, volume: 50 },
    ]);
    const { container, rerender } = render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="intraday" />);
    const chart = screen.getByRole("img", { name: /最近交易日真实分时/ });
    const segments = chart.querySelectorAll('line[stroke-width="1.8"]');
    expect(segments).toHaveLength(2);
    const plotWidth = Number(within(chart).getByText("15:00").getAttribute("x")) - Number(within(chart).getByText("09:30").getAttribute("x"));
    expect(Number(segments[0].getAttribute("x2")) - Number(segments[0].getAttribute("x1"))).toBeCloseTo(plotWidth * 2 / 240);
    expect(chart.querySelectorAll('rect[opacity="0.3"]')).toHaveLength(3);
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByText("价格 39.50")).toBeInTheDocument();

    const matching = forecast("intraday", lastTime, 40);
    rerender(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="intraday"
      forecast={{ ...matching, as_of: "2026-10-19T13:01:00+08:00" }} />);
    expect(container.querySelectorAll('line[stroke-dasharray="5 4"]')).toHaveLength(0);
    expect(screen.queryByText("了解预测表现")).not.toBeInTheDocument();
    rerender(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="intraday"
      forecast={{ ...matching, last_price: 99 }} />);
    expect(container.querySelectorAll('line[stroke-dasharray="5 4"]')).toHaveLength(0);
    rerender(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="intraday" forecast={matching} />);
    expect(screen.getByText("未来2个交易分钟")).toBeInTheDocument();
    expect(container.querySelectorAll('line[stroke-dasharray="5 4"]')).toHaveLength(2);
    expect(chart.querySelectorAll('rect[opacity="0.3"]')).toHaveLength(3);
  });

  it("pairs left prices with right percentages on the same red, gray, and green rows", () => {
    const data = market("intraday", [
      { trade_date: "2026-10-19T13:01:00+08:00", close: 38, volume: 20 },
      { trade_date: "2026-10-19T13:02:00+08:00", close: 42, volume: 30 },
    ]);
    render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="intraday" />);
    const chart = screen.getByRole("img", { name: /最近交易日真实分时/ });
    expectPairedAxisTick(chart, "42.00", "+5.00%", "hsl(var(--stock-up))");
    expectPairedAxisTick(chart, "40.00", "0.00%", "hsl(var(--muted-foreground))");
    expectPairedAxisTick(chart, "38.00", "-5.00%", "hsl(var(--stock-down))");
    const highY = Number(within(chart).getByText("42.00").getAttribute("y"));
    const middleY = Number(within(chart).getByText("40.00").getAttribute("y"));
    const lowY = Number(within(chart).getByText("38.00").getAttribute("y"));
    expect(middleY).toBeCloseTo((highY + lowY) / 2);
    expect(Array.from(chart.querySelectorAll("text")).filter((text) => /^[+-]?\d+\.\d{2}%$/.test(text.textContent?.trim() ?? ""))).toHaveLength(3);
  });

  it("keeps paired axes symmetric when a matching forecast expands the range", () => {
    const lastTime = "2026-10-19T13:02:00+08:00";
    const data = market("intraday", [
      { trade_date: "2026-10-19T13:01:00+08:00", close: 38, volume: 20 },
      { trade_date: lastTime, close: 42, volume: 30 },
    ]);
    const prediction = forecast("intraday", lastTime, 42);
    render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="intraday" forecast={prediction} />);
    const chart = screen.getByRole("img", { name: /最近交易日真实分时/ });

    expectPairedAxisTick(chart, "43.00", "+7.50%", "hsl(var(--stock-up))");
    expectPairedAxisTick(chart, "40.00", "0.00%", "hsl(var(--muted-foreground))");
    expectPairedAxisTick(chart, "37.00", "-7.50%", "hsl(var(--stock-down))");
  });

  it("uses quote high and low beyond minute closes for paired axis bounds", () => {
    const data = market("intraday", [
      { trade_date: "2026-10-19T13:01:00+08:00", close: 38, volume: 20 },
      { trade_date: "2026-10-19T13:02:00+08:00", close: 42, volume: 30 },
    ]);
    data.native.quote.high = 43;
    data.native.quote.low = 37;
    render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="intraday" />);
    const chart = screen.getByRole("img", { name: /最近交易日真实分时/ });
    expectPairedAxisTick(chart, "43.00", "+7.50%", "hsl(var(--stock-up))");
    expectPairedAxisTick(chart, "40.00", "0.00%", "hsl(var(--muted-foreground))");
    expectPairedAxisTick(chart, "37.00", "-7.50%", "hsl(var(--stock-down))");
  });

  it("keeps a flat intraday range narrow, finite, and centered at zero", () => {
    const data = market("intraday", [
      { trade_date: "2026-10-19T13:01:00+08:00", close: 40, volume: 20 },
      { trade_date: "2026-10-19T13:02:00+08:00", close: 40, volume: 30 },
    ]);
    data.native.quote.high = 40;
    data.native.quote.low = 40;
    render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="intraday" />);
    const chart = screen.getByRole("img", { name: /最近交易日真实分时/ });

    expectPairedAxisTick(chart, "40.04", "+0.10%", "hsl(var(--stock-up))");
    expectPairedAxisTick(chart, "40.00", "0.00%", "hsl(var(--muted-foreground))");
    expectPairedAxisTick(chart, "39.96", "-0.10%", "hsl(var(--stock-down))");
    expect(chart.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("colors the selected intraday price and change against previous close", () => {
    const data = market("intraday", [
      { trade_date: "2026-10-19T13:01:00+08:00", close: 38, volume: 20 },
      { trade_date: "2026-10-19T13:02:00+08:00", close: 42, volume: 1695 },
    ]);
    render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="intraday" />);
    const chart = screen.getByRole("img", { name: /最近交易日真实分时/ });
    expect(screen.getByText("价格 42.00")).toHaveStyle({ color: "hsl(var(--stock-up))" });
    expect(screen.getByText("涨跌幅 +5.00%")).toHaveStyle({ color: "hsl(var(--stock-up))" });
    expect(screen.getByText("量 1,695 手")).toBeInTheDocument();
    expect(screen.queryByText(/1,695\.00/)).not.toBeInTheDocument();

    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByText("价格 38.00")).toHaveStyle({ color: "hsl(var(--stock-down))" });
    expect(screen.getByText("涨跌幅 -5.00%")).toHaveStyle({ color: "hsl(var(--stock-down))" });
    expect(screen.getByText("量 20 手")).toBeInTheDocument();
    expect(screen.queryByText(/量 20\.00 手/)).not.toBeInTheDocument();
  });

  it.each([["missing", null], ["zero", 0]] as const)("omits intraday percentages with a %s previous close", (_case, previousClose) => {
    const data = market("intraday", [
      { trade_date: "2026-10-19T13:01:00+08:00", close: 38, volume: 20 },
      { trade_date: "2026-10-19T13:02:00+08:00", close: 42, volume: 30 },
    ]);
    data.native.quote.previous_close = previousClose;
    render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="intraday" />);
    const chart = screen.getByRole("img", { name: /最近交易日真实分时/ });

    expect(within(chart).queryByText(/[+-]?\d+\.\d{2}%/)).not.toBeInTheDocument();
    expect(chart.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("does not add percentage labels to daily candles", () => {
    const data = market("1D", [
      { trade_date: "2026-10-19", open: 39, high: 42, low: 38, close: 42, volume: 100 },
    ]);
    render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D" />);
    const chart = screen.getByRole("img");

    expect(Number(within(chart).getByText("42.32").getAttribute("x"))).toBeGreaterThan(450);
    expect(within(chart).queryByText(/[+-]?\d+\.\d{2}%/)).not.toBeInTheDocument();
  });

  it("anchors daily prediction at the last complete candle without drawing unfinished or future candles", () => {
    const data = market("1D", [
      { trade_date: "2026-10-15", open: 39, high: 41, low: 38, close: 40, volume: 100 },
      { trade_date: "2026-10-16", open: 41, high: 41.5, low: 38.7, close: 39.29, volume: 110 },
      { trade_date: "2026-10-19", open: 40, high: 43, low: 39, close: 42, volume: 50 },
    ]);
    const { container } = render(<StockVibeChart symbol={SYMBOL} result={data} loading={false} interval="1D"
      forecast={forecast("1D", "2026-10-16", 39.29)} />);
    const chart = screen.getByRole("img", { name: /2根真实行情K线，附预测走势/ });
    // 口径说明收进「预测详情」，图表区不再常显解释文字。
    expect(screen.queryByText(/预测按已收盘日K计算/)).not.toBeInTheDocument();
    expect(screen.getByText("收 39.29")).toBeInTheDocument();
    expect(within(chart).queryByText("2026-10-19")).not.toBeInTheDocument();
    const candles = chart.querySelectorAll('rect[fill^="hsl"]:not([opacity])');
    expect(candles).toHaveLength(2);
    expect(candles[1]).toHaveAttribute("fill", "hsl(var(--stock-down))");
    expect(chart.querySelectorAll('rect[opacity="0.3"]')).toHaveLength(2);
    expect(container.querySelectorAll('line[stroke-dasharray="5 4"]')).toHaveLength(2);
  });
});

describe("StockVibeChart 分时视觉", () => {
  const intradayMarket = () => market("intraday", [
    { trade_date: "2026-10-19T13:01:00+08:00", close: 38, volume: 20 },
    { trade_date: "2026-10-19T13:02:00+08:00", close: 42, volume: 30 },
  ]);

  it("铺面积、画均价线，并用悬停卡片替代图上方那行读数", () => {
    const { container } = render(<StockVibeChart symbol={SYMBOL} result={intradayMarket()} loading={false} interval="intraday" />);
    const chart = screen.getByRole("img", { name: /最近交易日真实分时/ });

    // 价格区下面是渐变面积，不是一条孤立的折线。
    const area = container.querySelector('path[fill*="stock-vibe-area"]');
    expect(area?.getAttribute("d")).toMatch(/^M[\d.,\s L]+Z$/);
    // 成交量加权均价线：虚线，且不等于收盘价序列。
    const average = container.querySelector('polyline[stroke-dasharray="4 3"]');
    expect(average?.getAttribute("points")).toBeTruthy();

    fireEvent.keyDown(chart, { key: "ArrowRight" });
    const tip = container.querySelector(".stock-vibe-chart-tip") as HTMLElement;
    expect(tip).toBeInTheDocument();
    expect(within(tip).getByText("均价")).toBeVisible();
    expect(within(tip).getByText("40.40")).toBeVisible();
    expect(within(tip).getByText("成交量")).toBeVisible();
    expect(tip.getAttribute("style")).toMatch(/left: \d+(\.\d+)?px/);
  });

  it("读屏仍能拿到时间、价格与成交量，视觉上不再占一条横带", () => {
    const { container } = render(<StockVibeChart symbol={SYMBOL} result={intradayMarket()} loading={false} interval="intraday" />);
    const readout = container.querySelector(".stock-vibe-chart .sr-only") as HTMLElement;
    expect(readout).toBeInTheDocument();
    expect(within(readout).getByText("价格 42.00")).toBeVisible();
  });
});
