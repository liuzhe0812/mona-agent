import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StockVibeForecastResult } from "@/lib/stock-vibe-api";
import { StockVibeForecastDetails, StockVibeForecastSummary } from "./StockVibeForecastSummary";

const base = (interval: "intraday" | "1D"): StockVibeForecastResult => ({
  symbol: "002460.SZ", interval, status: "ok", experimental: true,
  as_of: interval === "1D" ? "2026-10-16" : "2026-10-19T10:30:00+08:00", last_price: 40,
  points: [{ step: interval === "1D" ? 5 : 15, price: 41, lower: 39, upper: 42, label: "+5交易日" }],
  horizon_unit: interval === "1D" ? "trading_day" : "trading_minute", model_version: "internal-model-id",
  training_cutoff: "2026-10-16", training_rows: 900, data_fingerprint: null, features: [],
  computed_at: "2026-10-18T13:10:00Z", generation: { policy: interval === "1D" ? "daily" : "realtime", reused: false },
  validation: { method: "walk_forward", mae: 0.03, baseline_mae: 0.04, samples: 100, folds: 3, beat_baseline: true, by_horizon: [] },
});

describe("StockVibeForecastSummary", () => {
  it("shows concise daily forecast values and explains the converted history error", async () => {
    const prediction = base("1D");
    const { container } = render(<StockVibeForecastSummary forecast={prediction} interval="1D" matching />);

    expect(screen.getByRole("heading", { name: "走势预测" })).toBeVisible();
    expect(screen.getByText("未来5个交易日")).toBeVisible();
    expect(screen.getByText("模型估计")).toBeVisible();
    expect(screen.getByText("预估偏涨")).toHaveClass("text-stock-up");
    expect(screen.getByText("+2.50%")).toBeVisible();
    expect(screen.getByText("参考价 41.00")).toBeVisible();
    expect(screen.queryByText("参考范围 39.00 – 42.00")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
    expect(screen.getByRole("dialog", { name: "走势预测详情" })).toBeVisible();
    expect(screen.getByText("参考范围 39.00 – 42.00")).toBeVisible();
    expect(screen.getByText("历史误差参考")).toBeVisible();
    expect(screen.getByText("平均差约 1.20 元")).toBeVisible();
    expect(screen.getByText("按预测时股价折算")).toBeVisible();
    expect(screen.getByText("比假设股价不动更接近实际")).toBeVisible();
    fireEvent.focus(screen.getByRole("note", { name: "历史误差参考说明" }));
    expect(await screen.findByText(/历史预测的涨跌幅与实际结果平均相差 3\.00 个百分点/, { selector: ".max-w-72" })).toBeVisible();
    expect(container.textContent).not.toMatch(/生成于|基于 .*收盘|收盘后更新|数据截至|随盘中行情更新/);
    expect(container.textContent).not.toContain("internal-model-id");
    expect(container.textContent).not.toContain("训练");
  });

  it("shows a saved result without suggesting that a cached daily forecast was regenerated", () => {
    const prediction = { ...base("1D"), generation: { policy: "daily" as const, reused: true } };
    render(<StockVibeForecastSummary forecast={prediction} interval="1D" matching />);
    expect(screen.getByText("已保存结果")).toBeVisible();
    expect(screen.queryByText("模型估计")).not.toBeInTheDocument();
  });

  it("keeps legacy cache wording neutral and tolerates invalid display timestamps", () => {
    const legacy = { ...base("1D"), generation: undefined };
    const { rerender, container } = render(<StockVibeForecastSummary forecast={legacy} interval="1D" matching />);
    expect(screen.getByText("模型估计")).toBeVisible();
    expect(screen.queryByText("本次生成")).not.toBeInTheDocument();

    const invalidTime = { ...base("intraday"), as_of: "not-a-date", computed_at: "not-a-date", issued_at: undefined };
    expect(() => rerender(<StockVibeForecastSummary forecast={invalidTime} interval="intraday" matching />)).not.toThrow();
    expect(container.textContent).not.toMatch(/生成于|基于 .*收盘|收盘后更新|数据截至|随盘中行情更新/);
  });

  it("shows intraday direction and reliability without a separate time row", () => {
    const prediction = { ...base("intraday"), points: [
      { step: 5, price: 39, lower: null, upper: null, label: "+5交易分钟" },
      { step: 15, price: 39, lower: null, upper: null, label: "+15交易分钟" },
    ], validation: { ...base("intraday").validation, mae: 0.03, baseline_mae: 0.04 } };
    const { container } = render(<StockVibeForecastSummary forecast={prediction} interval="intraday" matching />);
    expect(screen.getByText("未来15个交易分钟")).toBeVisible();
    expect(screen.getByText("盘中更新")).toBeVisible();
    expect(screen.getByText("预估偏跌")).toHaveClass("text-stock-down");
    fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
    expect(screen.getByText("平均差约 1.20 元")).toBeVisible();
    expect(container.textContent).not.toMatch(/生成于|基于 .*收盘|收盘后更新|数据截至|随盘中行情更新/);
  });

  it("uses two key values when the model abstains, without turning it into a flat prediction", () => {
    const prediction = { ...base("1D"), signal_state: "abstain" as const, points: [],
      selection: { method: "nested", model_id: "zero", model_name: "internal", baseline_selected: true,
        candidate_count: 7, feature_count: 10, coverage: { registered: 20, eligible: 10, computed: 10, excluded: 10 }, basis: "nested_walk_forward" as const },
      validation: { ...base("1D").validation, beat_baseline: false } };
    const { container } = render(<StockVibeForecastSummary forecast={prediction} interval="1D" matching />);
    expect(screen.getByText("暂不判断")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
    expect(screen.getByText("平均差约 1.20 元")).toBeVisible();
    expect(screen.queryByText(/参考价 (?!暂)|参考范围 (?!暂)|%/)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("横盘");
  });

  it("shows insufficient history without inventing a price or validation score", () => {
    const prediction = { ...base("1D"), reason_code: "validation_history_insufficient", points: [],
      validation: { ...base("1D").validation, mae: null, baseline_mae: null, samples: 0 } };
    render(<StockVibeForecastSummary forecast={prediction} interval="1D" matching />);
    expect(screen.getByText("数据不足")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
    expect(screen.getByText("历史验证样本不足")).toBeVisible();
    expect(screen.queryByText(/参考价 (?!暂)|参考范围 (?!暂)|%/)).not.toBeInTheDocument();

    render(<StockVibeForecastSummary forecast={{ ...prediction, status: "unavailable", reason_code: "forecast_data_insufficient" }} interval="1D" />);
    expect(screen.getAllByText("数据不足")).toHaveLength(2);
    expect(screen.getAllByText("历史验证样本不足")).toHaveLength(2);
  });

  it("keeps mismatched market data from displaying stale results", () => {
    const prediction = base("1D");
    const { container } = render(<StockVibeForecastSummary forecast={prediction} interval="1D" matching={false} />);
    expect(screen.getByText("行情已变化")).toBeVisible();
    expect(screen.getByText("已保存结果与当前行情不一致。")).toBeVisible();
    expect(screen.queryByText("偏涨")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("+2.50%");
  });

  it("uses brief pending and unavailable states without technical detail", () => {
    render(<StockVibeForecastSummary forecast={{ symbol: "002460.SZ", interval: "1D", status: "pending", experimental: true,
      phase: "features", retry_after_ms: 2000, job_id: "internal-job" }} interval="1D" />);
    expect(screen.getByText("正在整理走势依据")).toBeVisible();
    expect(screen.queryByText("internal-job")).not.toBeInTheDocument();

    render(<StockVibeForecastSummary forecast={{ ...base("1D"), status: "unavailable", reason_code: "intraday_market_closed",
      reason: "native technical explanation" }} interval="1D" />);
    expect(screen.getByText("盘中预测仅在交易时段更新。")).toBeVisible();
    expect(screen.queryByText("native technical explanation")).not.toBeInTheDocument();
  });

  it("reports finite zero baselines as a comparison and never substitutes invalid metrics with zero", () => {
    const prediction = { ...base("1D"), validation: { ...base("1D").validation, mae: 0.02, baseline_mae: 0 } };
    render(<StockVibeForecastSummary forecast={prediction} interval="1D" matching />);
    fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
    expect(screen.getByText("平均差约 0.80 元")).toBeVisible();
    expect(screen.getByText("历史误差较大，仅供参考")).toBeVisible();

    const invalid = { ...base("1D"), validation: { ...base("1D").validation, mae: null, baseline_mae: Number.NaN } };
    const { rerender } = render(<StockVibeForecastSummary forecast={invalid} interval="1D" matching />);
    fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
    expect(screen.getByText("历史验证样本不足")).toBeVisible();
    expect(screen.queryByText(/平均差约 0\.00/)).not.toBeInTheDocument();
    rerender(<StockVibeForecastSummary forecast={invalid} interval="1D" matching={false} />);
    expect(screen.getByText("行情已变化")).toBeVisible();
  });

  it("shows a model price path despite weaker historical results and uses its actual last horizon", () => {
    const prediction = { ...base("1D"), points: [
      { step: 1, price: 40.5, lower: 39.8, upper: 41, label: "+1交易日" },
      { step: 3, price: 42, lower: 40, upper: 43, label: "+3交易日" },
    ], selection: { method: "nested" as const, model_id: "ridge", model_name: "internal", baseline_selected: true,
      candidate_count: 7, feature_count: 10, coverage: { registered: 20, eligible: 10, computed: 10, excluded: 10 }, basis: "nested_walk_forward" as const },
      validation: { ...base("1D").validation, mae: 0.05, baseline_mae: 0.04, beat_baseline: false } };
    const { container } = render(<StockVibeForecastSummary forecast={prediction} interval="1D" matching />);
    expect(screen.getByText("未来3个交易日")).toBeVisible();
    expect(screen.queryByText("未来5个交易日")).not.toBeInTheDocument();
    expect(screen.getByText("预估偏涨")).toBeVisible();
    expect(screen.getByText("+5.00%")).toBeVisible();
    expect(screen.getByText("参考价 42.00")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
    expect(screen.getByText("参考范围 40.00 – 43.00")).toBeVisible();
    expect(screen.getByText("平均差约 2.00 元")).toBeVisible();
    expect(screen.getByText("历史误差较大，仅供参考")).toBeVisible();
    expect(container.textContent).not.toMatch(/准确率|上涨概率|预测概率/);
  });

  it("shows actual tracking only after forecasts mature and leaves a missing error blank", () => {
    const prediction = { ...base("1D"), forward_validation: {
      status: "tracking" as const, forecasts: 2, completed_points: 3, mae: null, baseline_mae: null, coverage: null,
      revised_points: 0, last_scored_at: "2026-10-19T08:00:00Z", by_horizon: [],
    } };
    const { rerender } = render(<StockVibeForecastSummary forecast={prediction} interval="1D" matching />);
    fireEvent.click(screen.getByRole("button", { name: "预测详情" }));
    expect(screen.getByText("到期核对").nextElementSibling).toHaveTextContent("3 个预测点");
    expect(screen.getByText("实际平均偏差").nextElementSibling).toHaveTextContent("暂无");

    rerender(<StockVibeForecastSummary forecast={prediction} interval="1D" matching={false} />);
    expect(screen.queryByText("到期核对")).not.toBeInTheDocument();
  });

  it("keeps a user-facing historical-reference label without exposing its model id", () => {
    const prediction = { ...base("1D"), validation: { ...base("1D").validation, model_id: "historical_distribution" } };
    render(<StockVibeForecastSummary forecast={prediction} interval="1D" matching />);
    expect(screen.getByText("历史走势参考")).toBeVisible();
    expect(screen.queryByText("historical_distribution")).not.toBeInTheDocument();
    expect(screen.getByText("参考价 41.00")).toBeVisible();
  });

  it("uses a supplied chart point while keeping the history error tied to the full forecast", () => {
    const prediction = base("1D");
    render(<StockVibeForecastDetails forecast={prediction} interval="1D" point={{
      step: 2, price: 42, lower: 41, upper: 43, label: "+2交易日", trade_date: "2026-10-20",
    }} />);

    expect(screen.getByText("+2交易日")).toBeVisible();
    expect(screen.getByText("参考价 42.00")).toBeVisible();
    expect(screen.getByText("参考范围 41.00 – 43.00")).toBeVisible();
    expect(screen.getByText("平均差约 1.20 元")).toBeVisible();
  });

  it("does not convert missing prices or invalid MAE into a displayed zero", () => {
    const noPrice = { ...base("1D"), last_price: 0 };
    const { rerender } = render(<StockVibeForecastDetails forecast={noPrice} interval="1D" />);
    expect(screen.getByText("当前股价不可用，暂无法折算")).toBeVisible();
    expect(screen.queryByText(/平均差约 .*元/)).not.toBeInTheDocument();

    const negativeMae = { ...base("1D"), validation: { ...base("1D").validation, mae: -0.01 } };
    rerender(<StockVibeForecastDetails forecast={negativeMae} interval="1D" />);
    expect(screen.getByText("历史验证样本不足")).toBeVisible();
    expect(screen.queryByText(/平均差约 .*元/)).not.toBeInTheDocument();
  });

  it("preserves the insufficient-history reason even when a numeric MAE is present", () => {
    const prediction = { ...base("1D"), reason_code: "validation_history_insufficient",
      validation: { ...base("1D").validation, mae: 0.03, baseline_mae: 0.04 } };
    render(<StockVibeForecastDetails forecast={prediction} interval="1D" />);

    expect(screen.getByText("历史验证样本不足")).toBeVisible();
    expect(screen.queryByText(/平均差约 .*元/)).not.toBeInTheDocument();
    expect(screen.queryByText("比假设股价不动更接近实际")).not.toBeInTheDocument();
    expect(screen.getByText("参考价 暂不可用")).toBeVisible();
    expect(screen.getByText("参考范围 暂不可用")).toBeVisible();
  });

  it("formats an intraday forecast point time in China time", () => {
    render(<StockVibeForecastDetails forecast={base("intraday")} interval="intraday" point={{
      step: 15, price: 42, lower: 41, upper: 43, label: "+15交易分钟", trade_date: "2026-10-19T13:04:00+08:00",
    }} />);

    expect(screen.getByText("13:04")).toBeVisible();
    expect(screen.queryByText("+15交易分钟")).not.toBeInTheDocument();
  });
});
