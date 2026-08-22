import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearStockViewCache, StockView } from "./StockView";
import { STOCK_ROOM_CHAT_ID } from "@/lib/stock-api";
import type { WorkflowRun, WorkflowStepActivityPayload } from "@/lib/types";

// --- stock-api mocks (client itself is covered by stock-api.test.ts) ---
const fetchStockDashboard = vi.fn();
const fetchStockQuotes = vi.fn();
const fetchStockKline = vi.fn();
const fetchStockIntraday = vi.fn();
const openStockIntradayStream = vi.fn();
const fetchStockResearchContext = vi.fn();
const preflightStockResearch = vi.fn();
const fetchStockReports = vi.fn();
const fetchStockReport = vi.fn();
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
    preflightStockResearch: (...args: unknown[]) => preflightStockResearch(...args),
    fetchStockReports: (...args: unknown[]) => fetchStockReports(...args),
    fetchStockReport: (...args: unknown[]) => fetchStockReport(...args),
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

beforeEach(() => {
  vi.clearAllMocks();
  clearStockViewCache();
  runWorkflow.mockResolvedValue(undefined);
  getWorkflowRun.mockResolvedValue(null);
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
  fetchStockReport.mockResolvedValue({
    report: { report_id: "stock_report_a", kind: "deep_research" },
    markdown: "# 贵州茅台研究报告",
  });
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

  it("projects V4 watchlist conclusions without inventing a composite stance", async () => {
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
    expect(row).toHaveTextContent("短看多 · 中中性 · 长看空");
    expect(row).not.toHaveTextContent("待更新");
    expect(legacyRow).toHaveTextContent("待更新");
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
    const button = await screen.findByRole("button", { name: "启动深度投研" });
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
    fireEvent.click(await screen.findByRole("button", { name: "启动深度投研" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "启动深度投研" }));

    const error = await screen.findByText("投研启动失败：研究资料准备失败，请稍后重试");
    expect(error).toBeInTheDocument();
    expect(error.textContent).not.toContain("industry_context");
  });

  it("does not load financial-material selection during research startup", async () => {
    render(<StockView />);
    fireEvent.click(await screen.findByText("平安银行"));
    fireEvent.click(await screen.findByRole("button", { name: "启动深度投研" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "启动深度投研" }));

    expect(screen.getByRole("button", { name: "正在准备投研" })).toBeDisabled();
    expect(screen.queryByText("正在准备最新资料并启动投研")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "投研" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("正在准备研究资料并创建投研任务")).toBeTruthy();
    expect(screen.queryByText(/六位研究助手|证据包/)).not.toBeInTheDocument();
    expect(screen.getByText("技术分析师")).toBeTruthy();
    getWorkflowRun.mockResolvedValueOnce({ ...makeRunPush(), inputs: { symbols: ["XSHE:000001"] } });
    await act(async () => release?.());
    expect((await screen.findAllByText(/已完成 0\/6/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "投研" })).toHaveAttribute("aria-selected", "true");
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

    const cancel = await screen.findByRole("button", { name: "取消投研" });
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
      expect(screen.queryByRole("button", { name: "取消投研" })).not.toBeInTheDocument(),
    );
    expect(getWorkflowRun).toHaveBeenLastCalledWith(STOCK_ROOM_CHAT_ID, "run_1");
  });

  it("keeps the active run and shows a Chinese error when cancellation fails", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    await waitFor(() => expect(getWorkflowRun).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID));
    cancelWorkflowRun.mockRejectedValueOnce(new Error("cancel failed"));
    act(() => {
      runUpdatedHandler?.(STOCK_ROOM_CHAT_ID, makeRunPush());
    });

    fireEvent.click(await screen.findByRole("button", { name: "取消投研" }));
    expect(await screen.findByText("取消投研失败：取消请求失败，请稍后重试")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消投研" })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "启动深度投研" }));
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
      fireEvent.click(screen.getByRole("tab", { name: "投研" }));
    });
    expect(screen.getAllByRole("button", { name: /深度投研/ })).toHaveLength(1);
  });

  it("confirms before starting a new run when a report already exists", async () => {
    render(<StockView />);
    const button = await screen.findByRole("button", { name: "重新投研" });
    fireEvent.click(button);

    expect(await screen.findByText("重新研究贵州茅台？")).toBeTruthy();
    expect(runWorkflow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认重新投研" }));
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
    fireEvent.click(await screen.findByRole("tab", { name: "投研" }));
    expect(await screen.findByText("技术分析师")).toBeTruthy();
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
    await waitFor(() => expect(preflightStockResearch).toHaveBeenCalledWith("XSHG:600519", "贵州茅台"));
    await waitFor(() => expect(runWorkflow).toHaveBeenCalledTimes(1));
    expect(runWorkflow).toHaveBeenCalledWith(STOCK_ROOM_CHAT_ID, {
      symbols: ["XSHG:600519"],
      evidence_context_id: "ctx_preflightabc123",
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows the live research timeline on first run without a previous report", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    act(() => {
      runUpdatedHandler?.(STOCK_ROOM_CHAT_ID, makeRunPush());
    });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "投研" })).toHaveAttribute("aria-selected", "true"),
    );
    expect(await screen.findByText("技术分析师")).toBeTruthy();
  });

  it("opens the complete research process from the central research tab", async () => {
    render(<StockView />);
    await screen.findAllByText("贵州茅台");
    fireEvent.click(screen.getByRole("tab", { name: "投研" }));
    expect(screen.getByText("尚无投研结论")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新投研" })).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("tab", { name: "投研" }));
    expect(await screen.findByTestId("research-step-technical")).toHaveTextContent("正在核对价格与趋势");
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
    fireEvent.click(await screen.findByRole("tab", { name: "投研" }));
    expect(screen.queryByRole("button", { name: "查看完整观点" })).toBeNull();
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
    fireEvent.click(screen.getByRole("tab", { name: "投研" }));
    expect(await screen.findByText(/投研运行失败；已完成的分析仍保留/)).toBeTruthy();
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
      "投研",
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
    fireEvent.click(await screen.findByRole("tab", { name: "投研" }));

    expect(await screen.findByText("研究总览")).toBeTruthy();
    expect(screen.getAllByText("研究倾向").length).toBeGreaterThan(0);
    expect(screen.getAllByText("看多").length).toBeGreaterThan(0);
    expect(screen.getByText("截至日期")).toBeTruthy();
    expect(screen.getAllByText("2026-08-14").length).toBeGreaterThan(0);
    expect(screen.getByText("数据质量")).toBeTruthy();
    expect(screen.getByText("数据完整")).toBeTruthy();
    expect(screen.getByText("主审摘要")).toBeTruthy();
    expect(screen.getByText("结论失效条件")).toBeTruthy();
    expect(screen.getAllByText("该历史报告未提供判断条件").length).toBeGreaterThan(0);
    expect(screen.queryByText(/结构化条件/)).not.toBeInTheDocument();
    const questions = screen.getByText("尚未确认（1）");
    expect((questions.closest("details") as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByRole("button", { name: "查看完整证据链" })).toBeTruthy();
  });

  it("restores an active run on mount via getWorkflowRun", async () => {
    getWorkflowRun.mockResolvedValueOnce(makeRunPush());
    render(<StockView />);
    fireEvent.click(await screen.findByRole("tab", { name: "投研" }));
    expect(await screen.findByText("技术分析师")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("tab", { name: "投研" }));
    expect(screen.getByRole("tab", { name: "投研" })).toHaveAttribute("aria-selected", "true");
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
    fireEvent.click(await screen.findByRole("tab", { name: "投研" }));
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
    fireEvent.click(await screen.findByRole("tab", { name: "投研" }));
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
    fireEvent.click(await screen.findByRole("tab", { name: "投研" }));
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

  it("uses the quoteRefreshSecMs prop as the polling interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<StockView quoteRefreshSecMs={5_000} />);
    await screen.findAllByText("贵州茅台");
    expect(fetchStockQuotes).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchStockQuotes).toHaveBeenCalledTimes(2);
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
});
