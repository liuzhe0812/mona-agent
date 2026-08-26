import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearStockViewCache, StockView } from "./StockView";
import type { StockDecisionEvaluation } from "@/lib/stock-api";

const fetchStockDashboard = vi.fn();
const fetchStockQuotes = vi.fn();
const fetchStockKline = vi.fn();
const fetchStockResearchContext = vi.fn();
const fetchStockDiagnoses = vi.fn();
const fetchStockDiagnosis = vi.fn();
const fetchStockReports = vi.fn();
const fetchStockReport = vi.fn();
const fetchStockDecisionConditions = vi.fn();
const fetchStockIntraday = vi.fn();
const openStockIntradayStream = vi.fn();
const searchStocks = vi.fn();
const addStockWatchlist = vi.fn();
const removeStockWatchlist = vi.fn();
const setStockWatchlistFocus = vi.fn();
const reorderStockWatchlist = vi.fn();
const deleteStockReport = vi.fn();
const preflightStockResearch = vi.fn();
const fetchSettings = vi.fn();
const updateStockSettings = vi.fn();

vi.mock("@/lib/stock-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stock-api")>();
  return {
    ...actual,
    fetchStockDashboard: (...args: unknown[]) => fetchStockDashboard(...args),
    fetchStockQuotes: (...args: unknown[]) => fetchStockQuotes(...args),
    fetchStockKline: (...args: unknown[]) => fetchStockKline(...args),
    fetchStockResearchContext: (...args: unknown[]) => fetchStockResearchContext(...args),
    fetchStockDiagnoses: (...args: unknown[]) => fetchStockDiagnoses(...args),
    fetchStockDiagnosis: (...args: unknown[]) => fetchStockDiagnosis(...args),
    fetchStockReports: (...args: unknown[]) => fetchStockReports(...args),
    fetchStockReport: (...args: unknown[]) => fetchStockReport(...args),
    fetchStockDecisionConditions: (...args: unknown[]) => fetchStockDecisionConditions(...args),
    fetchStockIntraday: (...args: unknown[]) => fetchStockIntraday(...args),
    openStockIntradayStream: (...args: unknown[]) => openStockIntradayStream(...args),
    searchStocks: (...args: unknown[]) => searchStocks(...args),
    addStockWatchlist: (...args: unknown[]) => addStockWatchlist(...args),
    removeStockWatchlist: (...args: unknown[]) => removeStockWatchlist(...args),
    setStockWatchlistFocus: (...args: unknown[]) => setStockWatchlistFocus(...args),
    reorderStockWatchlist: (...args: unknown[]) => reorderStockWatchlist(...args),
    deleteStockReport: (...args: unknown[]) => deleteStockReport(...args),
    preflightStockResearch: (...args: unknown[]) => preflightStockResearch(...args),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSettings: (...args: unknown[]) => fetchSettings(...args),
    updateStockSettings: (...args: unknown[]) => updateStockSettings(...args),
  };
});

const client = {
  runWorkflow: vi.fn().mockResolvedValue(undefined),
  cancelWorkflowRun: vi.fn().mockResolvedValue("run_1"),
  getWorkflowRun: vi.fn().mockResolvedValue(null),
  attach: vi.fn(),
  onWorkflowRunUpdated: vi.fn(() => () => undefined),
  onWorkflowStepActivity: vi.fn(() => () => undefined),
};

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({ client, token: "tok" }),
}));

vi.mock("./InstrumentStage", () => ({
  KLINE_PERIODS: [{ key: "daily", label: "日线", klt: 101 }],
  STOCK_KLINE_FETCH_BARS: 250,
  InstrumentStage: (props: { decisionEvaluation?: StockDecisionEvaluation | null; onStartRun: () => void }) => (
    <div data-testid="instrument-stage">
      <span data-testid="decision-evaluation-id">{props.decisionEvaluation?.reportId ?? "无"}</span>
      <button type="button" onClick={props.onStartRun}>开始AI诊股</button>
    </div>
  ),
}));

vi.mock("./MarketTickerBar", () => ({
  INDEX_IDS: ["XSHG:000001"],
  MarketTickerBar: ({ onRefresh }: { onRefresh: () => void }) => (
    <button type="button" aria-label="刷新行情" onClick={onRefresh}>刷新行情</button>
  ),
}));

vi.mock("./WatchGrid", () => ({
  WatchGrid: ({ items, onSelect }: { items: Array<{ instrumentId: string; name: string }>; onSelect: (id: string) => void }) => (
    <div data-testid="watch-grid">
      {items.map((item) => <button type="button" key={item.instrumentId} onClick={() => onSelect(item.instrumentId)}>{item.name}</button>)}
    </div>
  ),
}));

vi.mock("./ReviewHeroCard", () => ({
  ReviewHeroCard: ({ onOpenReport }: { onOpenReport: (reportId: string) => void }) => (
    <button type="button" onClick={() => onOpenReport("report_a")}>打开报告</button>
  ),
}));
vi.mock("./OpportunityDiscovery", () => ({ OpportunityDiscovery: () => null }));
vi.mock("./ReportDetail", () => ({
  ReportDetail: ({ onDeleteReport }: { onDeleteReport: (reportId: string) => void }) => (
    <button type="button" onClick={() => onDeleteReport("report_a")}>删除报告</button>
  ),
}));

const DASHBOARD = [
  {
    instrumentId: "XSHG:600519",
    name: "贵州茅台",
    instrumentType: "equity",
    focus: false,
    latest: { reportId: "report_a", runId: "run_a", kind: "deep_research", asOf: "2026-08-22T15:00:00+08:00", stance: null, dataQuality: "complete" },
  },
  {
    instrumentId: "XSHE:000001",
    name: "平安银行",
    instrumentType: "equity",
    focus: false,
    latest: { reportId: "report_b", runId: "run_b", kind: "deep_research", asOf: "2026-08-22T15:00:00+08:00", stance: null, dataQuality: "complete" },
  },
];

const KLINE = {
  instrumentId: "XSHG:600519",
  instrumentType: "equity",
  bars: [],
  indicators: { ma: { ma5: [], ma20: [], ma60: [] }, macd: { dif: [], dea: [], hist: [] }, rsi14: [], swing: { support: null, resistance: null, method: "", window: 20 }, volumeChangePct: null },
  source: { provider: "test", fetchedAt: "2026-08-22T15:00:00+08:00" },
};

function evaluation(reportId: string): StockDecisionEvaluation {
  return { reportId, evaluatedAt: "2026-08-22T15:00:00+08:00", methodVersion: "decision-conditions-v1", horizons: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearStockViewCache();
  client.getWorkflowRun.mockResolvedValue(null);
  fetchStockDashboard.mockResolvedValue(DASHBOARD);
  fetchStockQuotes.mockResolvedValue([]);
  fetchStockKline.mockResolvedValue(KLINE);
  fetchStockResearchContext.mockResolvedValue(null);
  fetchStockDiagnoses.mockResolvedValue([]);
  fetchStockDiagnosis.mockRejectedValue(new Error("no diagnosis"));
  fetchStockReports.mockResolvedValue([]);
  fetchStockReport.mockImplementation(async (_token: string, reportId: string) => ({
    report: { schema_version: 4, report_id: reportId, kind: "deep_research" },
    markdown: "",
  }));
  fetchStockDecisionConditions.mockResolvedValue(evaluation("report_a"));
  deleteStockReport.mockResolvedValue(undefined);
  fetchStockIntraday.mockResolvedValue(null);
  openStockIntradayStream.mockResolvedValue({ close: vi.fn() });
  preflightStockResearch.mockResolvedValue({ contextId: "ctx_test" });
  fetchSettings.mockResolvedValue({
    stock: {
      quote_refresh_sec: 30,
      auto_review_enabled: false,
      review_time: "15:30",
      review_scope: "focus",
    },
  });
  updateStockSettings.mockResolvedValue({
    stock: {
      quote_refresh_sec: 30,
      auto_review_enabled: false,
      review_time: "15:30",
      review_scope: "focus",
    },
  });
});

describe("StockView decision evaluation integration", () => {
  it("loads evaluation once with the selected report id and passes it through", async () => {
    render(<StockView />);

    await waitFor(() => expect(fetchStockDecisionConditions).toHaveBeenCalledWith("tok", "report_a"));
    expect(fetchStockDecisionConditions).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("decision-evaluation-id")).toHaveTextContent("report_a");
  });

  it("reloads evaluation from the existing manual refresh action", async () => {
    render(<StockView />);
    await waitFor(() => expect(fetchStockDecisionConditions).toHaveBeenCalledTimes(1));
    fetchStockDecisionConditions.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "刷新行情" }));

    await waitFor(() => expect(fetchStockDecisionConditions).toHaveBeenCalledWith("tok", "report_a"));
    expect(fetchStockDecisionConditions).toHaveBeenCalledTimes(1);
  });

  it("does not let a late report evaluation overwrite a newer selected report", async () => {
    let resolveA!: (value: StockDecisionEvaluation) => void;
    let resolveB!: (value: StockDecisionEvaluation) => void;
    fetchStockDecisionConditions.mockImplementation((_token: string, reportId: string) => new Promise<StockDecisionEvaluation>((resolve) => {
      if (reportId === "report_a") resolveA = resolve;
      else resolveB = resolve;
    }));
    render(<StockView />);
    await waitFor(() => expect(fetchStockDecisionConditions).toHaveBeenCalledWith("tok", "report_a"));

    fireEvent.click(screen.getByRole("button", { name: "平安银行" }));
    await waitFor(() => expect(fetchStockDecisionConditions).toHaveBeenCalledWith("tok", "report_b"));
    resolveB(evaluation("report_b"));
    await waitFor(() => expect(screen.getByTestId("decision-evaluation-id")).toHaveTextContent("report_b"));
    resolveA(evaluation("report_a"));
    await Promise.resolve();
    expect(screen.getByTestId("decision-evaluation-id")).toHaveTextContent("report_b");
  });

  it("keeps the report view usable when evaluation fails", async () => {
    fetchStockDecisionConditions.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<StockView />);

    await waitFor(() => expect(fetchStockDecisionConditions).toHaveBeenCalledWith("tok", "report_a"));
    await waitFor(() => expect(screen.getByTestId("decision-evaluation-id")).toHaveTextContent("无"));
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("clears evaluation immediately when switching to a stock without a report", async () => {
    fetchStockDashboard.mockResolvedValueOnce([DASHBOARD[0], { ...DASHBOARD[1], latest: null }]);
    render(<StockView />);
    await waitFor(() => expect(screen.getByTestId("decision-evaluation-id")).toHaveTextContent("report_a"));

    fireEvent.click(screen.getByRole("button", { name: "平安银行" }));

    await waitFor(() => expect(screen.getByTestId("decision-evaluation-id")).toHaveTextContent("无"));
    expect(fetchStockDecisionConditions).toHaveBeenCalledTimes(1);
  });

  it("does not request evaluation for an old-format report", async () => {
    fetchStockReport.mockResolvedValueOnce({
      report: { schema_version: 3, report_id: "report_a", kind: "deep_research" },
      markdown: "历史报告",
    });
    render(<StockView />);

    await waitFor(() => expect(fetchStockReport).toHaveBeenCalledWith("tok", "report_a"));
    expect(fetchStockDecisionConditions).not.toHaveBeenCalled();
    expect(screen.getByTestId("decision-evaluation-id")).toHaveTextContent("无");
  });

  it("clears evaluation after deleting the current report", async () => {
    render(<StockView />);
    await waitFor(() => expect(screen.getByTestId("decision-evaluation-id")).toHaveTextContent("report_a"));

    fireEvent.click(screen.getByRole("button", { name: "打开报告" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));

    await waitFor(() => expect(deleteStockReport).toHaveBeenCalledWith("tok", "report_a"));
    expect(screen.getByTestId("decision-evaluation-id")).toHaveTextContent("无");
  });

  it("clears evaluation when a new research run starts", async () => {
    render(<StockView />);
    await waitFor(() => expect(screen.getByTestId("decision-evaluation-id")).toHaveTextContent("report_a"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "开始AI诊股" }));
    });

    expect(screen.getByTestId("decision-evaluation-id")).toHaveTextContent("无");
  });
});
