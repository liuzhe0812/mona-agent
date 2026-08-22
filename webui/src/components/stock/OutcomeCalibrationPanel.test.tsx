import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StockOutcomesResponse } from "@/lib/stock-api";
import { OutcomeCalibrationPanel } from "./OutcomeCalibrationPanel";

const fetchStockOutcomes = vi.fn();
const refreshStockOutcomes = vi.fn();

vi.mock("@/lib/stock-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stock-api")>();
  return {
    ...actual,
    fetchStockOutcomes: (...args: unknown[]) => fetchStockOutcomes(...args),
    refreshStockOutcomes: (...args: unknown[]) => refreshStockOutcomes(...args),
  };
});

const response: StockOutcomesResponse = {
  reportId: "report-4",
  tracking: {
    schema_version: 1,
    tracking: { id: "tracking-4" },
    tracking_id: "tracking-4",
    report: { id: "report-4", schema_version: 4 },
    report_id: "report-4",
    run: { id: "run-4" },
    workflow_run_id: "run-4",
    instrument: { symbol: "002709", exchange: "XSHE", name: "天赐材料" },
    research_cutoff_at: "2026-08-19T14:00:00+08:00",
    market_as_of: "2026-08-19T15:00:00+08:00",
    report_as_of: "2026-08-19T15:00:00+08:00",
    horizons: {
      short_term: { stance: "positive", status: "available", conditions: [], benchmark: { name: "沪深300" } },
      medium_term: { stance: "neutral", status: "available", conditions: [], benchmark: { name: "行业指数" } },
      long_term: { stance: "negative", status: "available", conditions: [], benchmark: { name: "未提供" } },
    },
    public_market_benchmark: { name: "中证全指", instrument_id: "XSHG:000985", instrument_type: "index" },
    evidence: {},
    versions: {},
    source_ids: [],
  },
  observations: [
    {
      tracking_id: "tracking-4", report_id: "report-4", horizon: "short_term", window: 5,
      stance: "positive", source_hash: "sha256:target", benchmark_source_hash: "sha256:market",
      status: "complete", data_status: "available", entry_date: "2026-08-20", exit_date: "2026-08-26",
      entry_price: 10, exit_price: 10.5, absolute_return_pct: 5, mfe_pct: 7, mae_pct: -1,
      relative_market_return_pct: 3, relative_market_status: "available", declared_benchmark_id: null,
      declared_benchmark_return_pct: null, declared_benchmark_status: "unsupported_no_verifiable_code",
      calculation_method: "first_post_report_open_to_nth_trading_close", calculation_version: "v1",
      conditions: [
        { horizon: "short_term", condition: {}, status: "manual" },
        { horizon: "short_term", condition: {}, status: "triggered" },
      ], calculated_at: "2026-08-27T15:00:00+08:00",
    },
    {
      tracking_id: "tracking-4", report_id: "report-4", horizon: "medium_term", window: 20,
      stance: "neutral", source_hash: "sha256:target", benchmark_source_hash: "sha256:market",
      status: "incomplete", data_status: "missing_date", entry_date: "2026-08-20", exit_date: "2026-09-16",
      entry_price: null, exit_price: null, absolute_return_pct: null, mfe_pct: null, mae_pct: null,
      relative_market_return_pct: null, relative_market_status: "missing_date", declared_benchmark_id: null,
      declared_benchmark_return_pct: null, declared_benchmark_status: "unsupported_no_verifiable_code",
      calculation_method: "first_post_report_open_to_nth_trading_close", calculation_version: "v1",
      conditions: [],
    },
  ],
  pending: [
    {
      tracking_id: "tracking-4", report_id: "report-4", horizon: "long_term", window: 120,
      stance: "negative", source_hash: "sha256:target", benchmark_source_hash: "sha256:market",
      status: "pending", data_status: "available", entry_date: null, exit_date: null,
      entry_price: null, exit_price: null, absolute_return_pct: null, mfe_pct: null, mae_pct: null,
      relative_market_return_pct: null, relative_market_status: "missing_date", declared_benchmark_id: null,
      declared_benchmark_return_pct: null, declared_benchmark_status: "unsupported_no_verifiable_code",
      calculation_method: "first_post_report_open_to_nth_trading_close", calculation_version: "v1",
      conditions: [], pending_reason: "window_not_mature",
    },
  ],
  aggregate: {
    short_term: {
      "5": { horizon: "short_term", window: 5, sample_count: 2, complete_count: 2, total_count: 2, incomplete_count: 0, scored_count: 2, status: "insufficient_sample", directional_accuracy: null, average_absolute_return_pct: 5, average_mfe_pct: 7, average_mae_pct: -1 },
    },
    medium_term: {},
    long_term: {},
  },
  samples: [],
  sampleCount: 2,
  updated: false,
  appendCount: 0,
  publicMarketBenchmark: { name: "中证全指", instrument_id: "XSHG:000985", instrument_type: "index" },
};

beforeEach(() => {
  fetchStockOutcomes.mockReset().mockResolvedValue(response);
  refreshStockOutcomes.mockReset().mockResolvedValue({ ...response, updated: true, appendCount: 1 });
});

describe("OutcomeCalibrationPanel", () => {
  it("mounts with a local GET and never refreshes automatically", async () => {
    render(<OutcomeCalibrationPanel reportId="report-4" />);
    await waitFor(() => expect(fetchStockOutcomes).toHaveBeenCalledWith("report-4"));
    expect(refreshStockOutcomes).not.toHaveBeenCalled();
    expect(screen.getByText("报告中的比较基准仅按原文核验；无法核验时不以中证全指替代。")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-calibration-panel")).toHaveTextContent("历史追踪记录：已建立");
  });

  it("refreshes only after the user clicks the update button", async () => {
    render(<OutcomeCalibrationPanel reportId="report-4" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更新结果" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "更新结果" }));
    await waitFor(() => expect(refreshStockOutcomes).toHaveBeenCalledWith("report-4"));
  });

  it("renders mature, incomplete and pending windows without claiming small-sample accuracy", async () => {
    render(<OutcomeCalibrationPanel reportId="report-4" />);
    await waitFor(() => expect(screen.getByTestId("outcome-window-5")).toHaveTextContent("绝对收益+5.00%"));
    expect(screen.getByTestId("outcome-window-20")).toHaveTextContent("数据状态：缺少交易日");
    expect(screen.getByTestId("outcome-window-120")).toHaveTextContent("等待第 120 个交易日数据到齐后再计算");
    expect(screen.getByTestId("outcome-window-250")).toHaveTextContent("暂无记录，点击“更新结果”补算");
    expect(screen.getByTestId("outcome-window-5")).toHaveTextContent("声明基准：未提供可核验代码/暂无结果");
    expect(screen.getByTestId("outcome-window-5")).toHaveTextContent("最大有利波动（MFE：持有期间的最高有利收益）");
    expect(screen.getByTestId("outcome-window-5")).toHaveTextContent("最大不利波动（MAE：持有期间的最大不利回撤）");
    expect(screen.getByTestId("outcome-window-5")).toHaveTextContent("人工观察（不会自动触发）");
    expect(screen.getByTestId("outcome-window-5")).toHaveTextContent("当前已满足条件");
    expect(screen.getByTestId("outcome-window-5")).not.toHaveTextContent(/tracking-4|XSHG:000985/);
    expect(screen.getByTestId("outcome-calibration-panel")).toHaveTextContent("历史结果校准（所有分周期投研报告）");
    expect(screen.getByTestId("outcome-calibration-panel")).not.toHaveTextContent("V4");
    expect(screen.getByTestId("outcome-calibration-summary")).toHaveTextContent("样本不足（2/30），不展示方向准确率");
    expect(screen.getByTestId("outcome-horizon-short_term")).toHaveTextContent("第 5、10 个交易日");
    expect(screen.getByTestId("outcome-horizon-medium_term")).toHaveTextContent("第 20、60 个交易日");
    expect(screen.getByTestId("outcome-horizon-long_term")).toHaveTextContent("第 120、250 个交易日");
    expect(screen.getByTestId("outcome-calibration-summary")).toHaveTextContent("第 20 个交易日：暂无样本");
    expect(screen.getByTestId("outcome-calibration-summary")).toHaveTextContent("第 60 个交易日：暂无样本");
    expect(screen.getByTestId("outcome-calibration-summary")).toHaveTextContent("第 120 个交易日：暂无样本");
    expect(screen.getByTestId("outcome-calibration-summary")).toHaveTextContent("第 250 个交易日：暂无样本");
    expect(screen.queryByText(/方向准确率：/)).not.toBeInTheDocument();
    expect(screen.getAllByText("催化与基本面里程碑当前未提供结构化回放，需人工观察（不会自动触发）。")).toHaveLength(2);
  });

  it("does not expose unknown outcome enums or internal identifiers as user copy", async () => {
    const unknownResponse = {
      ...response,
      observations: [{
        ...response.observations[0],
        status: "mystery_status",
        data_status: "future_state",
        declared_benchmark_id: "XSHG:000985",
        declared_benchmark_status: "mystery_benchmark_status",
        conditions: [{ horizon: "short_term", condition: {}, status: "mystery_condition_status" }],
      }],
    } as StockOutcomesResponse;
    fetchStockOutcomes.mockResolvedValueOnce(unknownResponse);

    render(<OutcomeCalibrationPanel reportId="report-4" />);
    await waitFor(() => expect(screen.getByTestId("outcome-window-5")).toHaveTextContent("状态待确认"));

    const panel = screen.getByTestId("outcome-calibration-panel");
    expect(panel).not.toHaveTextContent(/mystery_status|future_state|mystery_benchmark_status|mystery_condition_status|tracking-4|XSHG:000985/);
  });
});
