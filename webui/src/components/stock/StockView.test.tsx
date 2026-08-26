import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearStockViewCache, StockView } from "./StockView";
import { STOCK_DIAGNOSIS_ROOM_CHAT_ID, STOCK_ROOM_CHAT_ID } from "@/lib/stock-api";
import type { WorkflowRun, WorkflowStepActivityPayload } from "@/lib/types";

// --- stock-api mocks (client itself is covered by stock-api.test.ts) ---
const fetchStockDashboard = vi.fn();
const fetchStockQuotes = vi.fn();
const fetchStockKline = vi.fn();
const fetchStockIntraday = vi.fn();
const openStockIntradayStream = vi.fn();
const fetchStockResearchContext = vi.fn();
const fetchStockDiagnoses = vi.fn();
const fetchStockDiagnosis = vi.fn();
const deleteStockDiagnosis = vi.fn();
const preflightStockResearch = vi.fn();
const fetchStockReports = vi.fn();
const fetchStockReport = vi.fn();
const fetchStockDecisionConditions = vi.fn();
const addStockWatchlist = vi.fn();
const reorderStockWatchlist = vi.fn();
const removeStockWatchlist = vi.fn();
const setStockWatchlistFocus = vi.fn();
const deleteStockReport = vi.fn();
const searchStocks = vi.fn();
const fetchStockScreenTemplates = vi.fn();
const fetchStockScreenStrategies = vi.fn();
const fetchStockScreenHistory = vi.fn();
const fetchStockScreenResult = vi.fn();
const fetchStockMaterials = vi.fn();
const createStockMaterialBinding = vi.fn();
const confirmStockMaterialBinding = vi.fn();
const fetchStockMaterialPage = vi.fn();
const fetchSettings = vi.fn();
const updateStockSettings = vi.fn();

vi.mock("@/lib/stock-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stock-api")>();
  return {
    ...actual,
    fetchStockDashboard: (...args: unknown[]) => fetchStockDashboard(...args),
    fetchStockQuotes: (...args: unknown[]) => fetchStockQuotes(...args),
    fetchStockKline: (...args: unknown[]) => fetchStockKline(...args),
    fetchStockIntraday: (...args: unknown[]) => fetchStockIntraday(...args),
    openStockIntradayStream: (...args: unknown[]) => openStockIntradayStream(...args),
    fetchStockResearchContext: (...args: unknown[]) => fetchStockResearchContext(...args),
    fetchStockDiagnoses: (...args: unknown[]) => fetchStockDiagnoses(...args),
    fetchStockDiagnosis: (...args: unknown[]) => fetchStockDiagnosis(...args),
    deleteStockDiagnosis: (...args: unknown[]) => deleteStockDiagnosis(...args),
    preflightStockResearch: (...args: unknown[]) => preflightStockResearch(...args),
    fetchStockReports: (...args: unknown[]) => fetchStockReports(...args),
    fetchStockReport: (...args: unknown[]) => fetchStockReport(...args),
    fetchStockDecisionConditions: (...args: unknown[]) => fetchStockDecisionConditions(...args),
    addStockWatchlist: (...args: unknown[]) => addStockWatchlist(...args),
    removeStockWatchlist: (...args: unknown[]) => removeStockWatchlist(...args),
    setStockWatchlistFocus: (...args: unknown[]) => setStockWatchlistFocus(...args),
    reorderStockWatchlist: (...args: unknown[]) => reorderStockWatchlist(...args),
    deleteStockReport: (...args: unknown[]) => deleteStockReport(...args),
    searchStocks: (...args: unknown[]) => searchStocks(...args),
    fetchStockScreenTemplates: (...args: unknown[]) => fetchStockScreenTemplates(...args),
    fetchStockScreenStrategies: (...args: unknown[]) => fetchStockScreenStrategies(...args),
    fetchStockScreenHistory: (...args: unknown[]) => fetchStockScreenHistory(...args),
    fetchStockScreenResult: (...args: unknown[]) => fetchStockScreenResult(...args),
    fetchStockMaterials: (...args: unknown[]) => fetchStockMaterials(...args),
    createStockMaterialBinding: (...args: unknown[]) => createStockMaterialBinding(...args),
    confirmStockMaterialBinding: (...args: unknown[]) => confirmStockMaterialBinding(...args),
    fetchStockMaterialPage: (...args: unknown[]) => fetchStockMaterialPage(...args),
  };
});

vi.mock("@/components/MarkdownText", () => ({
  MarkdownText: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));

// --- client mock ---
const runWorkflow = vi.fn().mockResolvedValue(undefined);
const cancelWorkflowRun = vi.fn().mockResolvedValue("run_1");
const getWorkflowRun = vi.fn().mockResolvedValue(null);
const attach = vi.fn();
type RunHandler = (
  chatId: string,
  run: WorkflowRun | null,
  error?: string,
  detail?: string,
) => void;
let runUpdatedHandler: RunHandler | null = null;
type ActivityHandler = (chatId: string, payload: WorkflowStepActivityPayload) => void;
let stepActivityHandler: ActivityHandler | null = null;
const stockClient = {
  runWorkflow,
  cancelWorkflowRun,
  getWorkflowRun,
  attach,
  onWorkflowRunUpdated: (h: RunHandler) => {
    runUpdatedHandler = h;
    return () => {};
  },
  onWorkflowStepActivity: (h: ActivityHandler) => {
    stepActivityHandler = h;
    return () => {};
  },
};

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({
    client: stockClient,
    token: "tok",
  }),
}));

/** 顶栏指数并入行情轮询后的完整 id 列表。 */
const ALL_QUOTE_IDS = [
  "XSHG:000001",
  "XSHE:399001",
  "XSHE:399006",
  "XSHG:600519",
  "XSHE:000001",
];

const DASHBOARD = [
  {
    instrumentId: "XSHG:600519",
    name: "贵州茅台",
    instrumentType: "equity" as const,
    focus: false,
    latest: {
      reportId: "stock_report_a",
      runId: "run_a",
      kind: "deep_research" as const,
      asOf: "2026-08-14T15:00:00+08:00",
      stance: "positive" as const,
      dataQuality: "complete",
    },
  },
  {
    instrumentId: "XSHE:000001",
    name: "平安银行",
    instrumentType: "equity" as const,
    focus: false,
    latest: null,
  },
];

const KLINE = {
  instrumentId: "XSHG:600519",
  instrumentType: "equity",
  bars: [
    { date: "2026-08-14", open: 1680, close: 1700.5, high: 1710, low: 1670, volume: 1000 },
  ],
  indicators: {
    ma: { ma5: [1700.5], ma20: [1690], ma60: [null] },
    macd: { dif: [0.8], dea: [0.5], hist: [0.3] },
    rsi14: [49.1],
    swing: {
      support: 1600,
      resistance: 1750,
      method: "swing-high-low-v1",
      window: 20,
    },
    volumeChangePct: 12.5,
  },
  source: { provider: "eastmoney", fetchedAt: "2026-08-14T15:00:00+08:00" },
};

function makeRunPush(): WorkflowRun {
  return {
    schemaVersion: 1,
    id: "run_1",
    roomId: STOCK_ROOM_CHAT_ID,
    workflowId: "wf_generated_at_runtime",
    workflowRevision: 1,
    workflow: {
      schemaVersion: 1,
      id: "wf_generated_at_runtime",
      roomId: "stock_research",
      revision: 1,
      status: "active",
    goal: "六位研究助手深度投研",
      trigger: { type: "manual" },
      steps: [
        { id: "technical", type: "agent", agentId: "com.mona.stock-tech-analyst", dependsOn: [] },
      ],
      createdAt: "2026-08-14T07:00:00Z",
      createdBy: "test",
    },
    status: "running",
    triggerType: "manual",
    startedBy: "user",
    startedAt: "2026-08-14T07:00:00Z",
    steps: { technical: { status: "running" } },
    inputs: { symbols: ["XSHG:600519"] },
  };
}

function makeV5Report(reportId = "stock_report_v5") {
  const decision = (
    direction: "positive" | "neutral" | "negative",
    action: "conditional_participation" | "wait" | "hold",
    label: string,
  ) => ({
    direction,
    action,
    thesis: `${label}交易计划由确定性模型计算`,
    notHoldingAction: action === "conditional_participation" ? "participate" : "wait",
    holdingAction: action === "hold" ? "hold" : "reduce",
    tradingPlan: {
      referenceBuyLow: 36.8,
      referenceBuyHigh: 37.2,
      pullbackBuyLow: 35.8,
      pullbackBuyHigh: 36.2,
      stopLoss: 35.2,
      firstTakeProfit: 39.8,
      firstReduceFraction: 0.33,
      secondTakeProfit: 41.2,
      secondReduceFraction: 0.33,
      riskRewardFirst: 3.5,
      riskRewardSecond: 5.5,
      currency: "元",
    },
    positionPlan: {
      riskBudgetPct: 1,
      initialPositionPct: 10,
      maxPositionPct: 20,
      stopDistancePct: 4,
    },
    validUntil: "2026-09-01T15:00:00+08:00",
    reviewTrigger: "跌破止损参考后重新评估",
    keyReasons: ["趋势保持完整"],
    keyRisks: ["行业需求变化"],
    evidenceStrength: "strong",
    marketAsOf: "2026-08-21T15:00:00+08:00",
    generatedAt: "2026-08-21T15:05:00+08:00",
    isExpired: false,
  });
  return {
    schemaVersion: 5,
    resultStatus: "completed",
    reportId,
    runId: "run_v5",
    kind: "deep_research",
    instrument: {
      instrumentId: "XSHE:000001",
      symbol: "000001",
      exchange: "XSHE",
      name: "平安银行",
      instrumentType: "equity",
    },
    summary: "三周期交易计划",
    researchCutoffAt: "2026-08-21T15:00:00+08:00",
    marketAsOf: "2026-08-21T15:00:00+08:00",
    generatedAt: "2026-08-21T15:05:00+08:00",
    isExpired: false,
    hasExpiredHorizon: false,
    horizonDecisions: {
      shortTerm: decision("positive", "conditional_participation", "短线"),
      mediumTerm: decision("neutral", "wait", "中线"),
      longTerm: decision("negative", "wait", "长线"),
    },
  };
}

function makeDiagnosisReport() {
  const decision = (direction: "positive" | "neutral" | "negative") => ({
    direction,
    action: "conditional_participation",
    factor_score: 0.7,
    market_percentile: 0.8,
    industry_percentile: 0.6,
    factor_contributions: { momentum: 0.1 },
    validation_status: "descriptive",
    not_holding_action: "conditional_participation",
    holding_action: "hold",
    materialized_plan: { value_status: "unavailable", boundaries: [] },
    position_plan: { value_status: "unavailable" },
    review_trigger: "盈利假设变化时复评",
    key_reasons: [{ text: "现金流改善", source_ids: ["source-1"] }],
    key_risks: [{ text: "行业需求变化", source_ids: ["source-1"] }],
    confidence: "medium",
    source_ids: ["source-1"],
  });
  return {
    schema_version: 1,
    kind: "ai_diagnosis",
    diagnosis_id: "diagnosis_12345678",
    instrument: { symbol: "600519", exchange: "XSHG", name: "贵州茅台", instrument_type: "equity" },
    research_cutoff_at: "2026-08-25T15:00:00+08:00",
    market_as_of: "2026-08-25T15:00:00+08:00",
    generated_at: "2026-08-25T15:01:00+08:00",
    evidence_context_id: "ctx-1",
    source_ids: ["source-1"],
    data_quality: { status: "available", confidence: "medium" },
    fundamental_research: { status: "available", business_model_summary: "主营业务清晰", source_ids: ["source-1"] },
    fundamental_factors: { short_term: { status: "unavailable", validation_status: "unavailable", factors: [] }, medium_term: { status: "unavailable", validation_status: "unavailable", factors: [] }, long_term: { status: "unavailable", validation_status: "unavailable", factors: [] } },
    quant_factors: { short_term: { status: "available", validation_status: "descriptive", factor_score: 0.7, market_percentile: 0.8, industry_percentile: 0.6, sample_count: 35, factors: [{ name: "动量", contribution: 0.1, percentile: 0.8 }] }, medium_term: { status: "available", validation_status: "descriptive", factor_score: 0.7, market_percentile: 0.8, industry_percentile: 0.6, sample_count: 35, factors: [] }, long_term: { status: "unavailable", validation_status: "unavailable", factors: [] } },
    technical_execution: { status: "unavailable" },
    horizon_decisions: { short_term: decision("positive"), medium_term: decision("neutral"), long_term: decision("negative") },
    decision_radar: { short_term: decision("positive"), medium_term: decision("neutral"), long_term: decision("negative"), deterministic: true },
    method_versions: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearStockViewCache();
  // Clear queued one-shot implementations as well as call history; tests
  // intentionally script the same async client methods in different orders.
  for (const mock of [
    runWorkflow,
    cancelWorkflowRun,
    getWorkflowRun,
    preflightStockResearch,
    fetchStockDashboard,
    fetchStockReports,
    fetchStockReport,
    fetchStockDiagnoses,
    fetchStockDiagnosis,
    deleteStockDiagnosis,
  ]) mock.mockReset();
  runWorkflow.mockResolvedValue(undefined);
  getWorkflowRun.mockResolvedValue(null);
  preflightStockResearch.mockResolvedValue({ contextId: "ctx_preflightabc123" });
  runUpdatedHandler = null;
  stepActivityHandler = null;
  fetchStockDashboard.mockResolvedValue(DASHBOARD);
  fetchStockQuotes.mockResolvedValue([
    { instrumentId: "XSHG:000001", price: 3200.15, changePct: 0.42 },
    { instrumentId: "XSHE:399001", price: 10500.5, changePct: -0.3 },
    { instrumentId: "XSHE:399006", price: 2100.8, changePct: 1.1 },
    { instrumentId: "XSHG:600519", price: 1700.5, changePct: 1.25 },
    { instrumentId: "XSHE:000001", price: 10.2, changePct: -0.5 },
  ]);
  fetchStockKline.mockResolvedValue(KLINE);
  fetchStockIntraday.mockResolvedValue({
    instrumentId: "XSHG:600519",
    instrumentType: "equity",
    tradingDate: "2026-08-14",
    previousClose: 1680,
    status: "closed",
    asOf: "2026-08-14T15:00:00+08:00",
    source: { id: "src_intraday", provider: "test", url: "", publishedAt: null, fetchedAt: "2026-08-14T15:00:00+08:00", contentHash: "test", fields: [] },
    points: [],
    stale: false,
    quality: "complete",
    error: null,
  });
  openStockIntradayStream.mockResolvedValue({ source: { close: vi.fn() }, close: vi.fn() });
  fetchStockResearchContext.mockResolvedValue({
    instrumentId: "XSHG:600519",
    instrumentType: "equity",
    fundamentals: { status: "available", data: null, error: null },
    news: { status: "available", items: [], error: null },
  });
  fetchStockReports.mockResolvedValue([]);
  fetchStockDiagnoses.mockResolvedValue([]);
  fetchStockDiagnosis.mockRejectedValue(new Error("no diagnosis"));
  deleteStockDiagnosis.mockResolvedValue(undefined);
  fetchStockReport.mockResolvedValue({
    report: { report_id: "stock_report_a", kind: "deep_research" },
    markdown: "# 贵州茅台研究报告",
  });
  fetchStockDecisionConditions.mockResolvedValue(null);
  addStockWatchlist.mockResolvedValue(undefined);
  removeStockWatchlist.mockResolvedValue(undefined);
  setStockWatchlistFocus.mockResolvedValue(undefined);
  reorderStockWatchlist.mockResolvedValue([]);
  deleteStockReport.mockResolvedValue(undefined);
  searchStocks.mockResolvedValue([]);
  fetchStockScreenTemplates.mockResolvedValue([]);
  fetchStockScreenStrategies.mockResolvedValue([]);
  fetchStockScreenHistory.mockResolvedValue([]);
  fetchStockScreenResult.mockResolvedValue({ report_id: "selection_report", workflow_run_id: "run_selection", strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin", horizon: "medium_term" }, candidates: [] });
  fetchStockMaterials.mockResolvedValue({ instrument_id: "XSHG:600519", materials: [] });
  createStockMaterialBinding.mockResolvedValue(null);
  confirmStockMaterialBinding.mockResolvedValue(null);
  fetchStockMaterialPage.mockResolvedValue({ material_name: "", page: 1, page_count: null, text: "" });
  fetchSettings.mockResolvedValue({
    stock: {
      quote_refresh_sec: 30,
      auto_review_enabled: false,
      review_time: "15:30",
      review_scope: "focus",
    },
  });
  updateStockSettings.mockImplementation(async (_token: string, update: { quoteRefreshSec?: number }) => ({
    stock: {
      quote_refresh_sec: update.quoteRefreshSec ?? 30,
      auto_review_enabled: false,
      review_time: "15:30",
      review_scope: "focus",
    },
  }));
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSettings: (...args: unknown[]) => fetchSettings(...args),
    updateStockSettings: (...args: unknown[]) => updateStockSettings(...args),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StockView", () => {
  it("switches the primary workspace from the stock research header", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");

    const watchTab = screen.getByRole("tab", { name: "自选观察" });
    const opportunityTab = screen.getByRole("tab", { name: "机会发现" });
    expect(watchTab).toHaveAttribute("aria-selected", "true");
    expect(opportunityTab).toHaveAttribute("aria-selected", "false");

    fireEvent.click(opportunityTab);
    expect(opportunityTab).toHaveAttribute("aria-selected", "true");
    expect(watchTab).toHaveAttribute("aria-selected", "false");
    expect(await screen.findByRole("heading", { name: "机会发现" })).toBeTruthy();
  });

  it("silently prepares research and sends the exact selection context", async () => {
    fetchStockScreenHistory.mockResolvedValueOnce([
      { run_id: "run_selection", report_id: "selection_report", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "completed", candidate_count: 1, research_status: "completed" },
    ]);
    fetchStockScreenResult.mockResolvedValueOnce({
      report_id: "selection_report",
      workflow_run_id: "run_selection",
      as_of: "2026-08-19T15:00:00+08:00",
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin", horizon: "medium_term" },
      candidates: [{ instrument_id: "XSHG:600519", name: "贵州茅台", selection_reasons: ["operating_cashflow 改善"], risk_flags: [], data_quality: "available", rank: 5 }],
      opportunity_research: {
        report_id: "opportunity_report",
        status: "completed",
        candidate_count: 1,
        candidates: [{ instrument_id: "XSHG:600519", deterministic_rank: 2, context_id: "ctx_selection123456", research_priority: "high", why_now: { text: "momentum20 与 industry_context 需要核验", claim_type: "inference", source_ids: ["src_a", "src_b"] }, watch_items: [{ text: "policy_context 尚未确认", claim_type: "unknown", source_ids: [] }], data_gaps: ["机构盈利预期"], source_ids: ["src_a", "src_a", "src_b"] }],
      },
    });
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    fireEvent.click(screen.getByRole("tab", { name: "机会发现" }));
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    fireEvent.click(await screen.findByRole("button", { name: "深度投研" }));

    await waitFor(() => expect(runWorkflow).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID, {
      symbols: ["XSHG:600519"],
      evidence_context_id: "ctx_preflightabc123",
      selection_origin: {
        schema_version: 1,
        selection_run_id: "run_selection",
        selection_report_id: "selection_report",
        opportunity_report_id: "opportunity_report",
        instrument_id: "XSHG:600519",
        strategy_id: "quality_growth",
        strategy_name: "业绩成长",
        strategy_horizon: "medium_term",
        deterministic_rank: 2,
        selection_reasons: ["operating_cashflow 改善"],
        why_now: "momentum20 与 industry_context 需要核验",
        research_priority: "high",
        focus_questions: ["policy_context 尚未确认", "机构盈利预期"],
        source_count: 2,
        selection_as_of: "2026-08-19T15:00:00+08:00",
        usage_note: "这是选股阶段的先验线索，不是深度投研事实；必须使用本次投研证据重新核验。",
      },
    }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("selection-origin-preflight")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stock-material-evidence-panel")).not.toBeInTheDocument();
    expect(fetchStockMaterials).not.toHaveBeenCalled();
  });

  preflightStockResearch.mockResolvedValue({
    contextId: "ctx_preflightabc123",
    instrument: { symbol: "600519", exchange: "XSHG", instrumentType: "equity", name: "贵州茅台" },
    researchCutoffAt: "2026-08-19T15:00:00+08:00",
    marketAsOf: "2026-08-19T15:00:00+08:00",
    evidenceCoverage: {
      short_term: { status: "available", missing_sections: [], degraded_sections: [] },
      medium_term: {
        status: "degraded",
        missing_sections: ["industry_context", "operating_cashflow", "unknown_internal_field"],
        degraded_sections: ["operating_cashflow", "unknown_degraded_field"],
      },
      long_term: { status: "insufficient_data", missing_sections: ["company_quality"], degraded_sections: [] },
    },
    dataQuality: {},
  });

  it("loads dashboard, quotes (with indices), sparklines and the first instrument's kline", async () => {
    render(<StockView />);
    // The name shows up in both the watch card and the stage header.
    expect((await screen.findAllByText("贵州茅台")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("平安银行")).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(fetchStockQuotes).toHaveBeenCalledWith(ALL_QUOTE_IDS),
    );
    // Stage kline fetches the full 250-bar window (klt=101 daily);
    // sparklines use 30 daily bars.
    await waitFor(() =>
      expect(fetchStockKline).toHaveBeenCalledWith("XSHG:600519", 250, 101),
    );
    await waitFor(() =>
      expect(fetchStockKline).toHaveBeenCalledWith("XSHE:000001", 30, 101),
    );
    await waitFor(() =>
      expect(fetchStockResearchContext).toHaveBeenCalledWith("XSHG:600519"),
    );
    fireEvent.click(screen.getByRole("button", { name: "日线" }));
    expect(await screen.findByRole("img", { name: "K线图" })).toBeTruthy();
    // Index ticker renders the market reference.
    expect(screen.getByTestId("index-XSHG:000001").textContent).toContain(
      "3,200.15",
    );
    // Selected instrument header shows the quote.
    expect((await screen.findAllByText("1,700.50")).length).toBeGreaterThan(0);
  });

  it("collapses the watchlist to clickable stock initials", async () => {
    const { container } = render(<StockView />);
    await screen.findAllByText("贵州茅台");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "收起自选观察" }));
    });
    const firstRow = container.querySelector('[data-instrument-id="XSHG:600519"]');
    const secondRow = container.querySelector('[data-instrument-id="XSHE:000001"]');
    expect(firstRow?.textContent).toBe("贵");
    expect(secondRow?.textContent).toBe("平");

    await act(async () => {
      fireEvent.click(secondRow!);
    });
    expect(secondRow).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("button", { name: "展开自选观察" })).toBeTruthy();
  });

  it("renders a V4 report date without a synthetic watchlist opinion", async () => {
    fetchStockDashboard.mockResolvedValueOnce([
      {
        ...DASHBOARD[0],
        latest: {
          reportId: "stock_report_v4",
          runId: "run_v4",
          kind: "deep_research" as const,
          asOf: "2026-08-18T15:00:00+08:00",
          schemaVersion: 4,
          stance: null,
          dataQuality: null,
          horizonStances: {
            shortTerm: { stance: "positive" as const, status: "available" as const },
            mediumTerm: { stance: "neutral" as const, status: "available" as const },
            longTerm: { stance: "negative" as const, status: "available" as const },
          },
          researchCutoffAt: "2026-08-18T14:00:00+08:00",
          marketAsOf: "2026-08-18T15:00:00+08:00",
          evidenceCoverage: {},
        },
      },
      DASHBOARD[1],
    ]);
    const { container } = render(<StockView />);
    await screen.findAllByText("贵州茅台");
    const row = container.querySelector('[data-instrument-id="XSHG:600519"]');
    const legacyRow = container.querySelector('[data-instrument-id="XSHE:000001"]');
    expect(row).not.toBeNull();
    expect(legacyRow).not.toBeNull();
    expect(row).toHaveTextContent("08-18");
    expect(row).not.toHaveTextContent("短看多 · 中中性 · 长看空");
    expect(row).not.toHaveTextContent("观点");
    expect(row).not.toHaveTextContent("中性");
    expect(legacyRow).toHaveTextContent("—");
  });

  it("opens the news tab when the latest-event date is clicked", async () => {
    render(<StockView />);

    fireEvent.click(await screen.findByRole("button", { name: "查看贵州茅台资讯公告" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "资讯公告" })).toHaveAttribute("aria-selected", "true");
    });
  });

  it("renders scalar volume change and swing levels from the kline response", async () => {
    render(<StockView />);
    expect(await screen.findByText("+12.5%")).toBeTruthy();
    expect(screen.getByText("支撑位").parentElement?.textContent).toContain("1600.00");
    expect(screen.getByText("压力位").parentElement?.textContent).toContain("1750.00");
    expect(screen.getByText("快线（DIF）：0.80 / 慢线（DEA）：0.50")).toBeTruthy();
    expect(screen.getByText("多头")).toBeTruthy();
  });

  it("starts a deep-research run with the selected instrument as inputs", async () => {
    render(<StockView />);
    fireEvent.click(await screen.findByText("平安银行"));
    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    const button = await screen.findByRole("button", { name: "启动专家团论证" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(preflightStockResearch).toHaveBeenCalledWith("XSHE:000001", "平安银行"));
    await waitFor(() => expect(runWorkflow).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID, {
      symbols: ["XSHE:000001"],
      evidence_context_id: "ctx_preflightabc123",
    }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows a Chinese startup error when research preparation fails", async () => {
    preflightStockResearch.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<StockView />);
    fireEvent.click(await screen.findByText("平安银行"));
    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    fireEvent.click(await screen.findByRole("button", { name: "启动专家团论证" }));

    const error = await screen.findByText("投研启动失败：研究资料准备失败，请稍后重试");
    expect(error).toBeInTheDocument();
    expect(error.textContent).not.toContain("Failed to fetch");
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("hides mixed-language internal fields from startup errors", async () => {
    preflightStockResearch.mockRejectedValueOnce(new Error("industry_context 缺失"));
    render(<StockView />);
    fireEvent.click(await screen.findByText("平安银行"));
    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    fireEvent.click(await screen.findByRole("button", { name: "启动专家团论证" }));

    const error = await screen.findByText("投研启动失败：研究资料准备失败，请稍后重试");
    expect(error).toBeInTheDocument();
    expect(error.textContent).not.toContain("industry_context");
  });

  it("does not load financial-material selection during research startup", async () => {
    render(<StockView />);
    fireEvent.click(await screen.findByText("平安银行"));
    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    fireEvent.click(await screen.findByRole("button", { name: "启动专家团论证" }));
    await waitFor(() => expect(runWorkflow).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID, {
      symbols: ["XSHE:000001"],
      evidence_context_id: "ctx_preflightabc123",
    }));
    expect(runWorkflow.mock.calls[0][1]).not.toHaveProperty("material_binding_ids");
    expect(fetchStockMaterials).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stock-material-evidence-panel")).not.toBeInTheDocument();
    expect(screen.queryByText(/上传财报|刷新财报资料|研究截止|行情截至|证据包/)).not.toBeInTheDocument();
  });

  it("shows launch progress and then the authoritative workflow steps", async () => {
    let release: (() => void) | undefined;
    runWorkflow.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    render(<StockView />);
    fireEvent.click(await screen.findByText("平安银行"));
    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    fireEvent.click(await screen.findByRole("button", { name: "启动专家团论证" }));

    expect(screen.getByRole("button", { name: "准备中" })).toBeDisabled();
    expect(screen.queryByText("正在准备最新资料并启动投研")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "专家团论证" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "专家团论证" })).toBeTruthy();
    expect(screen.queryByText(/六位研究助手|证据包/)).not.toBeInTheDocument();
    getWorkflowRun.mockResolvedValueOnce({ ...makeRunPush(), inputs: { symbols: ["XSHE:000001"] } });
    await act(async () => release?.());
    expect(await screen.findByTestId("expert-panel")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "专家团论证" })).toHaveAttribute("aria-selected", "true");
    const radar = screen.getByTestId("decision-radar");
    expect(within(radar).queryByText(/报告后变化|新增事件与未来催化|已完成.*\/6/)).not.toBeInTheDocument();
  });

  it("cancels the active run by its exact id and adopts the server state", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    await waitFor(() => expect(getWorkflowRun).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID));
    const cancelledRun = { ...makeRunPush(), status: "cancelled" as const };
    getWorkflowRun.mockResolvedValueOnce(cancelledRun);
    act(() => {
      runUpdatedHandler?.(STOCK_ROOM_CHAT_ID, makeRunPush());
    });

    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    const cancel = await screen.findByRole("button", { name: "取消论证" });
    let releaseCancel: ((runId: string) => void) | undefined;
    cancelWorkflowRun.mockImplementationOnce(
      () => new Promise<string>((resolve) => {
        releaseCancel = resolve;
      }),
    );
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    expect(cancelWorkflowRun).toHaveBeenCalledTimes(1);
    expect(cancelWorkflowRun).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID, "run_1");
    expect(screen.getByText("取消中")).toBeInTheDocument();

    await act(async () => releaseCancel?.("run_1"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "取消论证" })).not.toBeInTheDocument(),
    );
    expect(getWorkflowRun).toHaveBeenLastCalledWith(STOCK_ROOM_CHAT_ID, "run_1");
  });

  it("keeps cancellation pending when the acknowledgement GET is still running", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    await waitFor(() => expect(getWorkflowRun).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID));
    act(() => {
      runUpdatedHandler?.(STOCK_ROOM_CHAT_ID, makeRunPush());
    });

    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    const runningRun = makeRunPush();
    getWorkflowRun.mockResolvedValueOnce(runningRun);
    cancelWorkflowRun.mockResolvedValueOnce("run_1");
    fireEvent.click(await screen.findByRole("button", { name: "取消论证" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "取消中" })).toBeDisabled());
    await waitFor(() => expect(getWorkflowRun).toHaveBeenLastCalledWith(STOCK_ROOM_CHAT_ID, "run_1"));
    expect(screen.getByRole("button", { name: "取消中" })).toBeDisabled();

    act(() => {
      runUpdatedHandler?.(STOCK_ROOM_CHAT_ID, {
        ...runningRun,
        status: "cancelled",
      });
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "取消中" })).not.toBeInTheDocument());
  });

  it("keeps the active run and shows a Chinese error when cancellation fails", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    await waitFor(() => expect(getWorkflowRun).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID));
    cancelWorkflowRun.mockRejectedValueOnce(new Error("cancel failed"));
    act(() => {
      runUpdatedHandler?.(STOCK_ROOM_CHAT_ID, makeRunPush());
    });

    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消论证" }));
    expect(await screen.findByText("取消投研失败：取消请求失败，请稍后重试")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消论证" })).toBeInTheDocument();
    expect(cancelWorkflowRun).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID, "run_1");
  });

  it("surfaces workflow error pushes instead of dropping them", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    act(() => {
      runUpdatedHandler?.(
        STOCK_ROOM_CHAT_ID,
        null,
        "run_failed",
        "证据准备失败",
      );
    });
    expect(await screen.findByText(/投研运行失败：证据准备失败/)).toBeTruthy();
  });

  it("shows a warning when the accepted run has no synchronized state", async () => {
    render(<StockView />);
    fireEvent.click(await screen.findByText("平安银行"));
    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    fireEvent.click(await screen.findByRole("button", { name: "启动专家团论证" }));
    expect(await screen.findByText(/运行状态暂未同步/)).toBeTruthy();
  });

  it("shows only the decision-context launch action in the empty conclusion tab", async () => {
    render(<StockView />);
    const item = await screen.findByText("平安银行");
    await act(async () => {
      fireEvent.click(item);
    });
    await waitFor(() =>
      expect(fetchStockResearchContext).toHaveBeenCalledWith("XSHE:000001"),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "AI诊股" }));
    });
    expect(screen.getByRole("button", { name: "开始AI诊股" })).toBeInTheDocument();
    expect(screen.getByText("尚未生成 AI 诊股结论")).toBeInTheDocument();
    expect(screen.queryByTestId("decision-radar-prototype-panel")).not.toBeInTheDocument();
  });

  it("wires a V5 report into the real radar without showing prototype data", async () => {
    const v5Report = makeV5Report();
    fetchStockDashboard.mockResolvedValueOnce([
      DASHBOARD[0],
      {
        ...DASHBOARD[1],
        latest: {
          reportId: "stock_report_v5",
          runId: "run_v5",
          kind: "deep_research",
          instrument: {
            instrumentId: "XSHE:000001",
            symbol: "000001",
            exchange: "XSHE",
            name: "平安银行",
            instrumentType: "equity",
          },
          symbols: ["XSHE:000001"],
          asOf: "2026-08-21T15:00:00+08:00",
          modifiedAt: "2026-08-21T15:05:00Z",
          schemaVersion: 5,
          resultStatus: "completed",
          horizonDecisions: {
            shortTerm: { direction: "positive", action: "conditional_participation", validUntil: "2026-09-01T15:00:00+08:00", isExpired: false },
            mediumTerm: { direction: "neutral", action: "wait", validUntil: "2026-10-01T15:00:00+08:00", isExpired: false },
            longTerm: { direction: "negative", action: "wait", validUntil: "2027-01-01T15:00:00+08:00", isExpired: false },
          },
          researchCutoffAt: "2026-08-21T15:00:00+08:00",
          marketAsOf: "2026-08-21T15:00:00+08:00",
          generatedAt: "2026-08-21T15:05:00+08:00",
          isExpired: false,
          hasExpiredHorizon: false,
          stance: null,
          dataQuality: null,
        },
      },
    ]);
    fetchStockReport.mockImplementation(async (_token: string, reportId: string) => ({
      report: reportId === "stock_report_v5"
        ? v5Report
        : { report_id: "stock_report_a", kind: "deep_research" },
      markdown: "",
    }));

    render(<StockView />);
    fireEvent.click(await screen.findByText("平安银行"));
    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));

    expect(await screen.findByTestId("expert-panel")).toBeInTheDocument();
    expect(screen.getByTestId("expert-role-list")).toHaveTextContent("技术分析师");
    expect(screen.getByTestId("expert-role-list")).toHaveTextContent("主审");
    expect(screen.queryByTestId("decision-radar-prototype-panel")).not.toBeInTheDocument();
    expect(screen.queryByText("示例数据，仅用于原型展示")).not.toBeInTheDocument();
  });

  it("confirms before starting a new run when a report already exists", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    const button = await screen.findByRole("button", { name: "重新论证" });
    fireEvent.click(button);

    expect(await screen.findByText("重新论证贵州茅台？")).toBeTruthy();
    expect(runWorkflow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认重新论证" }));
    await waitFor(() => expect(preflightStockResearch).toHaveBeenCalledWith("XSHG:600519", "贵州茅台"));
    await waitFor(() =>
      expect(runWorkflow).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID, {
        symbols: ["XSHG:600519"],
        evidence_context_id: "ctx_preflightabc123",
      }),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("renders run progress when the stock room pushes workflow_run_updated", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    expect(attach).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID);
    expect(runUpdatedHandler).toBeTruthy();
    act(() => {
      runUpdatedHandler?.(STOCK_ROOM_CHAT_ID, makeRunPush());
    });
    fireEvent.click(await screen.findByRole("tab", { name: "专家团论证" }));
    expect(await screen.findByTestId("expert-role-technical")).toBeTruthy();
    // A run push from another room must not leak into the stock view.
    act(() => {
      runUpdatedHandler?.("websocket:other", {
        ...makeRunPush(),
        id: "run_other",
        workflow: {
          ...makeRunPush().workflow,
          steps: [
            { id: "mystery", type: "agent", agentId: "x", dependsOn: [] },
          ],
        },
        steps: { mystery: { status: "running" } },
      });
    });
    expect(screen.queryByText("mystery")).toBeNull();
  });

  it("starts directly from the analyst confirmation-card entry", async () => {
    const consumed = vi.fn();
    render(<StockView autoRunSymbol="XSHG:600519" onConsumeAutoRun={consumed} />);
    await screen.findAllByText("贵州茅台");
    expect(consumed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(preflightStockResearch).not.toHaveBeenCalled());
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows the live research timeline on first run without a previous report", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    act(() => {
      runUpdatedHandler?.(STOCK_ROOM_CHAT_ID, makeRunPush());
    });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "专家团论证" })).toHaveAttribute("aria-selected", "true"),
    );
    expect(await screen.findByTestId("expert-role-technical")).toBeTruthy();
  });

  it("opens the complete research process from the central research tab", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    fireEvent.click(await screen.findByText("平安银行"));
    fireEvent.click(screen.getByRole("tab", { name: "AI诊股" }));
    expect(screen.getByText("尚未生成 AI 诊股结论")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始AI诊股" })).toBeTruthy();
    expect(screen.queryByTestId("decision-radar-prototype-panel")).not.toBeInTheDocument();
    expect(screen.queryByText("研究委员会主席")).toBeNull();
    expect(screen.queryByRole("button", { name: "查看完整观点" })).toBeNull();
  });

  it("shows the active research assistant's real research activity", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    act(() => {
      runUpdatedHandler?.(STOCK_ROOM_CHAT_ID, makeRunPush());
      stepActivityHandler?.(STOCK_ROOM_CHAT_ID, {
        runId: "run_1",
        stepId: "technical",
        authorId: "com.mona.stock-tech-analyst",
        toolEvents: [
          {
            phase: "start",
            call_id: "call_1",
            name: "stock_evidence_read",
          },
        ],
      });
    });
    fireEvent.click(await screen.findByRole("tab", { name: "专家团论证" }));
    expect(await screen.findByTestId("expert-role-technical")).toHaveTextContent("进行中");
  });

  it("expands a completed research card on demand", async () => {
    fetchStockReport.mockResolvedValueOnce({
      report: {
        report_id: "stock_report_a",
        kind: "deep_research",
        workflow_run_id: "run_a",
        research_stance: "neutral",
        summary: "主席完整裁决内容",
        risks: ["风险证据"],
      },
      markdown: "# 贵州茅台研究报告",
    });
    render(<StockView />);
    fireEvent.click(await screen.findByRole("tab", { name: "专家团论证" }));
    expect(screen.getByTestId("expert-panel")).toBeInTheDocument();
  });

  it("shows a visible failure when evidence preparation stops a run", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    act(() => {
      runUpdatedHandler?.(STOCK_ROOM_CHAT_ID, {
        ...makeRunPush(),
        status: "failed",
        steps: { technical: { status: "queued" } },
      });
    });
    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    expect(await screen.findByText(/本次专家团论证失败/)).toBeTruthy();
  });

  it("loads the kline of the newly selected instrument", async () => {
    render(<StockView />);
    fireEvent.click(await screen.findByText("平安银行"));
    await waitFor(() =>
      expect(fetchStockKline).toHaveBeenCalledWith("XSHE:000001", 250, 101),
    );
  });

  it("reuses cached stock data when switching back to an instrument", async () => {
    render(<StockView />);
    await waitFor(() =>
      expect(fetchStockResearchContext).toHaveBeenCalledWith("XSHG:600519"),
    );
    fireEvent.click(await screen.findByText("平安银行"));
    await waitFor(() =>
      expect(fetchStockResearchContext).toHaveBeenCalledWith("XSHE:000001"),
    );
    await waitFor(() =>
      expect(fetchStockKline).toHaveBeenCalledWith("XSHE:000001", 250, 101),
    );

    await act(async () => {
      fireEvent.click(screen.getAllByText("贵州茅台")[0]);
    });

    expect(
      fetchStockKline.mock.calls.filter(
        ([id, limit, klt]) => id === "XSHG:600519" && limit === 250 && klt === 101,
      ),
    ).toHaveLength(1);
    expect(
      fetchStockResearchContext.mock.calls.filter(
        ([id]) => id === "XSHG:600519",
      ),
    ).toHaveLength(1);
  });

  it("reuses the module cache when the stock view is remounted", async () => {
    const first = render(<StockView />);
    await waitFor(() =>
      expect(fetchStockDashboard).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(fetchStockKline).toHaveBeenCalledWith("XSHG:600519", 250, 101),
    );
    await waitFor(() => expect(fetchStockQuotes).toHaveBeenCalledTimes(1));
    const calls = {
      dashboard: fetchStockDashboard.mock.calls.length,
      reports: fetchStockReports.mock.calls.length,
      quotes: fetchStockQuotes.mock.calls.length,
      kline: fetchStockKline.mock.calls.length,
      research: fetchStockResearchContext.mock.calls.length,
    };
    first.unmount();

    render(<StockView />);
    expect(await screen.findAllByText("贵州茅台")).not.toHaveLength(0);
    expect(fetchStockDashboard).toHaveBeenCalledTimes(calls.dashboard);
    expect(fetchStockReports).toHaveBeenCalledTimes(calls.reports);
    expect(fetchStockQuotes).toHaveBeenCalledTimes(calls.quotes);
    expect(fetchStockKline).toHaveBeenCalledTimes(calls.kline);
    expect(fetchStockResearchContext).toHaveBeenCalledTimes(calls.research);
  });

  it("fetches each kline period once and reuses it when switching back", async () => {
    render(<StockView />);
    await waitFor(() =>
      expect(fetchStockKline).toHaveBeenCalledWith("XSHG:600519", 250, 101),
    );
    // 切到月线：klt=103。
    fireEvent.click(screen.getByRole("button", { name: "月线" }));
    await waitFor(() =>
      expect(fetchStockKline).toHaveBeenCalledWith("XSHG:600519", 250, 103),
    );
    // 切回日线：直接复用首屏缓存，不再请求。
    fireEvent.click(screen.getByRole("button", { name: "日线" }));
    expect(
      fetchStockKline.mock.calls.filter(
        ([id, limit, klt]) => id === "XSHG:600519" && limit === 250 && klt === 101,
      ),
    ).toHaveLength(1);
    // 周线：klt=102。
    fireEvent.click(screen.getByRole("button", { name: "周线" }));
    await waitFor(() =>
      expect(fetchStockKline).toHaveBeenLastCalledWith("XSHG:600519", 250, 102),
    );
  });

  it("exposes the four research views", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    const researchTabs = within(screen.getByRole("tablist", { name: "标的研究视图" }));
    expect(researchTabs.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "行情",
      "基本面",
      "资讯公告",
      "AI诊股",
      "专家团论证",
    ]);
  });

  it("shows the structured conclusion labels", async () => {
    fetchStockReport.mockResolvedValueOnce({
      report: {
        report_id: "stock_report_a",
        kind: "deep_research",
        research_stance: "positive",
        as_of: "2026-08-14T15:00:00+08:00",
        data_quality: "complete",
        summary: "主审摘要内容",
        risks: ["结论失效条件内容"],
        catalysts: ["后续观察信号内容"],
        open_questions: ["尚未确认内容"],
      },
      markdown: "# 贵州茅台研究报告",
    });
    render(<StockView />);
    fireEvent.click(await screen.findByRole("tab", { name: "专家团论证" }));
    expect(await screen.findByTestId("expert-panel")).toBeInTheDocument();
    expect(screen.getByTestId("expert-role-list")).toHaveTextContent("主审");
    expect(screen.queryByTestId("ai-diagnosis-result")).not.toBeInTheDocument();
  });

  it("restores an active run on mount via getWorkflowRun", async () => {
    getWorkflowRun.mockResolvedValueOnce(makeRunPush());
    render(<StockView />);
    fireEvent.click(await screen.findByRole("tab", { name: "专家团论证" }));
    expect(await screen.findByTestId("expert-role-technical")).toBeTruthy();
    expect(getWorkflowRun).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID);
  });

  it("opens the central research tab from the attention radar", async () => {
    fetchStockReports.mockResolvedValue([
      {
        reportId: "stock_report_a",
        runId: "run_a",
        kind: "deep_research",
        instrument: {
          instrumentId: "XSHG:600519",
          symbol: "600519",
          exchange: "XSHG",
          name: "贵州茅台",
          instrumentType: "equity",
        },
        symbols: ["XSHG:600519"],
        asOf: "2026-08-14T15:00:00+08:00",
        stance: "positive",
        dataQuality: "complete",
        modifiedAt: "2026-08-14T07:10:00Z",
      },
    ]);
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    fireEvent.click(screen.getByRole("tab", { name: "AI诊股" }));
    expect(screen.getByRole("tab", { name: "AI诊股" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: /完整投研/ })).not.toBeInTheDocument();
  });

  it("opens a report from the research archive timeline", async () => {
    fetchStockReports.mockResolvedValue([
      {
        reportId: "stock_report_a",
        runId: "run_a",
        kind: "deep_research",
        instrument: {
          instrumentId: "XSHG:600519",
          symbol: "600519",
          exchange: "XSHG",
          name: "贵州茅台",
          instrumentType: "equity",
        },
        symbols: ["XSHG:600519"],
        asOf: "2026-08-14T15:00:00+08:00",
        stance: "positive",
        dataQuality: "complete",
        modifiedAt: "2026-08-14T07:10:00Z",
      },
    ]);
    render(<StockView />);
    fireEvent.click(await screen.findByRole("tab", { name: "专家团论证" }));
    const history = await screen.findByText("历史版本（1）");
    expect((history.closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(history);
    expect((history.closest("details") as HTMLDetailsElement).open).toBe(true);
    const card = await screen.findByRole("button", {
      name: /深度投研 看多 · 数据完整 2026-08-14/,
    });
    fireEvent.click(card);
    await waitFor(() =>
      expect(fetchStockReport).toHaveBeenCalledWith("tok", "stock_report_a"),
    );
    expect((await screen.findByTestId("markdown")).textContent).toContain(
      "贵州茅台研究报告",
    );
  });

  it("deletes a report from the reading overlay after confirmation", async () => {
    fetchStockReports.mockResolvedValueOnce([{
      reportId: "stock_report_a",
      runId: "run_a",
      kind: "deep_research",
      instrument: { instrumentId: "XSHG:600519", symbol: "600519", exchange: "XSHG", name: "贵州茅台", instrumentType: "equity" },
      symbols: ["XSHG:600519"],
      asOf: "2026-08-14T15:00:00+08:00",
      stance: "positive",
      dataQuality: "complete",
      modifiedAt: "2026-08-14T07:10:00Z",
    }]);
    render(<StockView />);
    fireEvent.click(await screen.findByRole("tab", { name: "专家团论证" }));
    const history = await screen.findByText("历史版本（1）");
    fireEvent.click(history);
    fireEvent.click(await screen.findByRole("button", { name: /深度投研 看多/ }));
    await screen.findByTestId("markdown");
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "确认删除" }),
    );
    await waitFor(() =>
      expect(deleteStockReport).toHaveBeenCalledWith("tok", "stock_report_a"),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("markdown")).toBeNull(),
    );
  });

  it("deletes a historical report from its context menu after confirmation", async () => {
    fetchStockReports.mockResolvedValueOnce([{
      reportId: "stock_report_a",
      runId: "run_a",
      kind: "deep_research",
      instrument: { instrumentId: "XSHG:600519", symbol: "600519", exchange: "XSHG", name: "贵州茅台", instrumentType: "equity" },
      symbols: ["XSHG:600519"],
      asOf: "2026-08-14T15:00:00+08:00",
      stance: "positive",
      dataQuality: "complete",
      modifiedAt: "2026-08-14T07:10:00Z",
    }]);
    render(<StockView />);
    fireEvent.click(await screen.findByRole("tab", { name: "专家团论证" }));
    fireEvent.click(await screen.findByText("历史版本（1）"));
    const card = await screen.findByRole("button", { name: /深度投研 看多/ });

    fireEvent.contextMenu(card);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除历史报告" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(deleteStockReport).toHaveBeenCalledWith("tok", "stock_report_a"),
    );
  });

  it("shows today's review digest in the hero when a daily_review exists today", async () => {
    fetchStockReports.mockResolvedValue([
      {
        reportId: "stock_review_today",
        runId: "run_today",
        kind: "daily_review",
        instrument: null,
        symbols: ["XSHG:600519", "XSHE:000001"],
        asOf: new Date().toISOString(),
        stance: "neutral",
        dataQuality: "complete",
        modifiedAt: new Date().toISOString(),
      },
    ]);
    fetchStockReport.mockResolvedValue({
      report: { report_id: "stock_review_today", kind: "daily_review" },
      markdown: "# 每日复盘简报",
    });
    render(<StockView />);
    expect(await screen.findByText("今日复盘简报")).toBeTruthy();
    expect(screen.getByText("已覆盖 2 只 · 重点 0 只")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /查看今日复盘/ }));
    await waitFor(() =>
      expect(fetchStockReport).toHaveBeenCalledWith(
        "tok",
        "stock_review_today",
      ),
    );
  });

  // 复盘通知点击进入（T20）：focusRunId 命中报告列表即打开对应简报。
  const REVIEW_REPORT = {
    reportId: "stock_review_x",
    runId: "run_x",
    kind: "daily_review",
    instrument: null,
    symbols: ["XSHG:600519"],
    asOf: "2026-08-14T15:30:00+08:00",
    stance: "neutral",
    dataQuality: "complete",
    modifiedAt: "2026-08-14T07:40:00Z",
  };

  it("opens the digest report when focusRunId matches a loaded report", async () => {
    fetchStockReports.mockResolvedValue([REVIEW_REPORT]);
    fetchStockReport.mockResolvedValue({
      report: { report_id: "stock_review_x", kind: "daily_review" },
      markdown: "# 每日复盘简报",
    });
    const onConsume = vi.fn();
    render(<StockView focusRunId="run_x" onConsumeFocusRun={onConsume} />);
    await waitFor(() =>
      expect(fetchStockReport).toHaveBeenCalledWith("tok", "stock_review_x"),
    );
    expect((await screen.findByTestId("markdown")).textContent).toContain(
      "每日复盘简报",
    );
    expect(onConsume).toHaveBeenCalledTimes(1);
  });

  it("does not open anything when focusRunId has no matching report", async () => {
    fetchStockReports.mockResolvedValue([REVIEW_REPORT]);
    const onConsume = vi.fn();
    render(<StockView focusRunId="run_missing" onConsumeFocusRun={onConsume} />);
    await screen.findAllByText("贵州茅台");
    await waitFor(() => expect(fetchStockReports).toHaveBeenCalled());
    expect(screen.queryByTestId("markdown")).toBeNull();
    expect(onConsume).not.toHaveBeenCalled();
  });

  // --- 商用可用性：错误态、重试、轮询治理 ---

  it("shows an error notice with retry when the dashboard fails to load", async () => {
    fetchStockDashboard.mockRejectedValueOnce(new Error("network down"));
    render(<StockView />);
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("自选股加载失败");
    // Retry recovers once the upstream is back.
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect((await screen.findAllByText("贵州茅台")).length).toBeGreaterThan(0);
  });

  it("shows a stale-quotes banner when quote polling fails and clears on recovery", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    fetchStockQuotes.mockRejectedValueOnce(new Error("upstream down"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText(/行情刷新失败/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.queryByText(/行情刷新失败/)).toBeNull();
  });

  it("shows a kline error with retry when the kline fetch fails", async () => {
    // 仅主区 K 线失败（60 根窗口）；sparkline（30 根）不受影响。
    let failStage = true;
    fetchStockKline.mockImplementation((_id: string, limit?: number) =>
      failStage && limit !== 30
        ? Promise.reject(new Error("kline down"))
        : Promise.resolve(KLINE),
    );
    render(<StockView />);
    fireEvent.click(await screen.findByRole("button", { name: "日线" }));
    await screen.findByText(/K线加载失败/);
    failStage = false;
    fireEvent.click(screen.getByRole("button", { name: "重试K线" }));
    expect(await screen.findByRole("img", { name: "K线图" })).toBeTruthy();
  });

  it("surfaces an action error when toggling focus fails", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    setStockWatchlistFocus.mockRejectedValueOnce(new Error("save failed"));
    const buttons = await screen.findAllByRole("button", { name: "标为重点" });
    fireEvent.click(buttons[0]);
    expect(await screen.findByText(/操作失败/)).toBeTruthy();
  });

  it("spins the refresh button while quotes load and refetches on click", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    // 首轮行情落地后图标静止。
    await waitFor(() =>
      expect(screen.getByTestId("index-XSHG:000001").textContent).toContain("3,200.15"),
    );
    const refreshBtn = () => screen.getByRole("button", { name: "刷新行情" });
    expect(refreshBtn().querySelector("svg")?.getAttribute("class")).not.toContain(
      "animate-spin",
    );
    // 手动刷新挂起期间：图标旋转、按钮禁用。
    let release: (() => void) | undefined;
    fetchStockQuotes.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    const callsBefore = fetchStockQuotes.mock.calls.length;
    fireEvent.click(refreshBtn());
    expect(fetchStockQuotes.mock.calls.length).toBe(callsBefore + 1);
    expect(fetchStockQuotes).toHaveBeenLastCalledWith(ALL_QUOTE_IDS);
    expect(refreshBtn().querySelector("svg")?.getAttribute("class")).toContain(
      "animate-spin",
    );
    expect((refreshBtn() as HTMLButtonElement).disabled).toBe(true);
    // 请求完成：旋转停止、按钮恢复。
    await act(async () => {
      release?.();
    });
    await waitFor(() =>
      expect(refreshBtn().querySelector("svg")?.getAttribute("class")).not.toContain(
        "animate-spin",
      ),
    );
    expect((refreshBtn() as HTMLButtonElement).disabled).toBe(false);
  });

  it("reorders watch rows by drag and drop and rolls back on failure", async () => {
    const THREE = [
      DASHBOARD[0],
      DASHBOARD[1],
      {
        instrumentId: "XSHE:300750",
        name: "宁德时代",
        instrumentType: "equity" as const,
        focus: false,
        latest: null,
      },
    ];
    const dataTransfer = {
      setData: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };
    const rowIds = () =>
      Array.from(container.querySelectorAll("[data-instrument-id]")).map(
        (el) => el.getAttribute("data-instrument-id"),
      );

    // 成功：拖第三行（宁德时代）到第一行（茅台）下方 → [茅台, 宁德, 平安]。
    fetchStockDashboard.mockResolvedValueOnce(THREE);
    const { container } = render(<StockView />);
    await screen.findAllByText("宁德时代");
    const rows = () => container.querySelectorAll("[data-instrument-id]");
    expect(rowIds()).toEqual(["XSHG:600519", "XSHE:000001", "XSHE:300750"]);
    fireEvent.dragStart(rows()[2], { dataTransfer });
    fireEvent.dragOver(rows()[0], { dataTransfer });
    fireEvent.drop(rows()[0], { dataTransfer });
    fireEvent.dragEnd(rows()[0]);
    await waitFor(() =>
      expect(reorderStockWatchlist).toHaveBeenCalledWith([
        "XSHG:600519",
        "XSHE:300750",
        "XSHE:000001",
      ]),
    );
    expect(rowIds()).toEqual(["XSHG:600519", "XSHE:300750", "XSHE:000001"]);

    // 失败：回滚原顺序并提示。
    reorderStockWatchlist.mockRejectedValueOnce(new Error("save failed"));
    fireEvent.dragStart(rows()[1], { dataTransfer });
    fireEvent.dragOver(rows()[2], { dataTransfer });
    fireEvent.drop(rows()[2], { dataTransfer });
    fireEvent.dragEnd(rows()[2]);
    expect(await screen.findByText(/排序保存失败/)).toBeTruthy();
    expect(rowIds()).toEqual(["XSHG:600519", "XSHE:300750", "XSHE:000001"]);
  });

  it("aligns volume bars with candles and shows a linked volume readout on hover", async () => {
    const bars = [
      { date: "2026-08-12", open: 10, close: 11, high: 12, low: 9, volume: 2000 },
      { date: "2026-08-13", open: 11, close: 10, high: 11.5, low: 10, volume: 5000 },
      { date: "2026-08-14", open: 10, close: 10.5, high: 11, low: 10, volume: 1000 },
    ];
    fetchStockKline.mockImplementation((_id: string, limit?: number) =>
      Promise.resolve(
        limit === 30 ? KLINE : { ...KLINE, bars },
      ),
    );
    const { container } = render(<StockView />);
    fireEvent.click(await screen.findByRole("button", { name: "日线" }));
    const svg = await screen.findByRole("img", { name: "K线图" });
    const volSvg = await screen.findByRole("img", { name: "成交量" });

    // 坐标对齐：每根蜡烛中心 X 与成交量柱中心 X 一致（viewBox 坐标）。
    const candleCx = (i: number) => {
      const line = container.querySelectorAll("[data-candle]")[i].querySelector("line");
      return Number(line?.getAttribute("x1"));
    };
    const volCx = (i: number) => {
      const rect = volSvg.querySelectorAll("rect")[i];
      return Number(rect.getAttribute("x")) + Number(rect.getAttribute("width")) / 2;
    };
    for (let i = 0; i < bars.length; i += 1) {
      expect(volCx(i)).toBeCloseTo(candleCx(i), 6);
    }

    // 初始（无悬停）读数为最后一根；悬停第一根联动为该根成交量。
    expect(screen.getByTestId("volume-readout").textContent).toBe("成交量 1,000手");
    fireEvent.pointerMove(svg, { clientX: 20, clientY: 100, pointerId: 1 });
    expect(screen.getByTestId("volume-readout").textContent).toBe("成交量 2,000手");
    fireEvent.pointerOut(svg, { relatedTarget: null });
    expect(screen.getByTestId("volume-readout").textContent).toBe("成交量 1,000手");
  });

  it("uses the saved refresh interval as the polling interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchSettings.mockResolvedValueOnce({
      stock: {
        quote_refresh_sec: 5,
        auto_review_enabled: false,
        review_time: "15:30",
        review_scope: "focus",
      },
    });
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchStockQuotes).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchStockQuotes).toHaveBeenCalledTimes(2);
  });

  it("auto-saves the refresh interval from the stock settings menu", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");

    fireEvent.pointerDown(screen.getByRole("button", { name: "股票设置" }), {
      button: 0,
      ctrlKey: false,
    });
    const input = await screen.findByRole("spinbutton", { name: "行情刷新间隔（秒）" });
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(updateStockSettings).toHaveBeenCalledWith("tok", { quoteRefreshSec: 60 }),
    );
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("stops polling while the page is hidden and resumes on visibility", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    expect(fetchStockQuotes).toHaveBeenCalledTimes(1);
    act(() => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchStockQuotes).toHaveBeenCalledTimes(1);
    act(() => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() =>
      expect(fetchStockQuotes.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("starts AI diagnosis only in stock_ai_diagnosis and keeps the expert workflow idle", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    fireEvent.click(screen.getByRole("tab", { name: "AI诊股" }));
    fireEvent.click(screen.getByRole("button", { name: "开始AI诊股" }));
    await waitFor(() => expect(runWorkflow).toHaveBeenCalledWith(STOCK_DIAGNOSIS_ROOM_CHAT_ID, expect.objectContaining({ symbols: ["XSHG:600519"] })));
    expect(runWorkflow).not.toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID, expect.anything());
  });

  it("starts the six-agent expert workflow only after its own tab action", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    expect(runWorkflow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    fireEvent.click(screen.getByRole("button", { name: /启动专家团论证|重新论证/ }));
    const confirm = screen.queryByRole("button", { name: "确认重新论证" });
    if (confirm) fireEvent.click(confirm);
    await waitFor(() => expect(runWorkflow).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID, expect.objectContaining({ symbols: ["XSHG:600519"] })));
    expect(runWorkflow).not.toHaveBeenCalledWith(STOCK_DIAGNOSIS_ROOM_CHAT_ID, expect.anything());
  });

  it("renders a successful StockDiagnosisV1 result and keeps deep history in the expert tab", async () => {
    fetchStockDiagnoses.mockResolvedValueOnce([{ diagnosisId: "diagnosis_12345678", workflowId: "stock-ai-diagnosis", status: "succeeded", instrument: { symbol: "600519", exchange: "XSHG" } }]);
    fetchStockDiagnosis.mockResolvedValueOnce({ report: makeDiagnosisReport(), markdown: "" });
    fetchStockReports.mockResolvedValueOnce([{ reportId: "deep-1", runId: "deep-run", kind: "deep_research", instrument: { instrumentId: "XSHG:600519" }, symbols: ["XSHG:600519"], asOf: "2026-08-25", modifiedAt: "2026-08-25", schemaVersion: 5, resultStatus: "completed", horizonDecisions: {} }]);
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    fireEvent.click(screen.getByRole("tab", { name: "AI诊股" }));
    expect(await screen.findByTestId("ai-diagnosis-result")).toHaveTextContent("四层分析");
    expect(screen.queryByText("深度投研")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    expect(await screen.findByText(/专家团历史记录/)).toBeInTheDocument();
  });

  it("deletes a terminal AI diagnosis from the history context menu", async () => {
    fetchStockDiagnoses.mockResolvedValueOnce([{ diagnosisId: "diagnosis_12345678", workflowId: "stock-ai-diagnosis", status: "succeeded", instrument: { symbol: "600519", exchange: "XSHG" }, createdAt: "2026-08-25T15:00:00+08:00", updatedAt: "2026-08-25T15:01:00+08:00" }]);
    fetchStockDiagnosis.mockResolvedValueOnce({ report: makeDiagnosisReport(), markdown: "" });
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    fireEvent.click(screen.getByRole("tab", { name: "AI诊股" }));
    await screen.findByTestId("ai-diagnosis-result");

    const history = screen.getByTestId("ai-diagnosis-history");
    fireEvent.click(within(history).getByText(/AI诊股历史/));
    fireEvent.contextMenu(within(history).getByRole("button", { name: /AI诊股.*已完成/ }));
    fireEvent.click(await screen.findByText("删除诊股记录"));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(deleteStockDiagnosis).toHaveBeenCalledWith("diagnosis_12345678"));
    await waitFor(() => expect(fetchStockDiagnoses).toHaveBeenCalledTimes(2));
  });

  it("retries initial diagnosis loading and shows the latest result without starting a new run", async () => {
    fetchStockDiagnoses
      .mockRejectedValueOnce(new Error("service warming up"))
      .mockResolvedValueOnce([{ diagnosisId: "diagnosis_12345678", workflowId: "stock-ai-diagnosis", status: "succeeded", instrument: { symbol: "600519", exchange: "XSHG" } }]);
    fetchStockDiagnosis.mockResolvedValueOnce({ report: makeDiagnosisReport(), markdown: "" });

    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    fireEvent.click(screen.getByRole("tab", { name: "AI诊股" }));

    expect(await screen.findByTestId("ai-diagnosis-result")).toBeInTheDocument();
    expect(fetchStockDiagnoses).toHaveBeenCalledTimes(2);
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("cancels AI and expert runs through their own workflow room", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    const baseRun = makeRunPush();
    const aiRun = { ...baseRun, id: "diagnosis-run", roomId: STOCK_DIAGNOSIS_ROOM_CHAT_ID, workflow: { ...baseRun.workflow, roomId: STOCK_DIAGNOSIS_ROOM_CHAT_ID }, inputs: { symbols: ["XSHG:600519"] } } as WorkflowRun;
    act(() => runUpdatedHandler?.(STOCK_DIAGNOSIS_ROOM_CHAT_ID, aiRun));
    cancelWorkflowRun.mockResolvedValueOnce("diagnosis-run");
    getWorkflowRun.mockResolvedValueOnce({ ...aiRun, status: "cancelled" });
    fireEvent.click(await screen.findByRole("button", { name: "取消AI诊股" }));
    await waitFor(() => expect(cancelWorkflowRun).toHaveBeenCalledWith(STOCK_DIAGNOSIS_ROOM_CHAT_ID, "diagnosis-run"));
    cleanup();
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    const expertRun = makeRunPush();
    act(() => runUpdatedHandler?.(STOCK_ROOM_CHAT_ID, expertRun));
    cancelWorkflowRun.mockResolvedValueOnce("run_1");
    getWorkflowRun.mockResolvedValueOnce({ ...expertRun, status: "cancelled" });
    fireEvent.click(screen.getByRole("tab", { name: "专家团论证" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消论证" }));
    await waitFor(() => expect(cancelWorkflowRun).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID, "run_1"));
  });
});
