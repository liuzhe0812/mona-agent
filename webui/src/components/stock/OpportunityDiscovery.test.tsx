import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OpportunityDiscovery } from "./OpportunityDiscovery";
import type { MonaClient } from "@/lib/mona-client";

const fetchTemplates = vi.fn();
const fetchStrategies = vi.fn();
const fetchHistory = vi.fn();
const fetchResult = vi.fn();
const compareCandidates = vi.fn();
const fetchOutcomes = vi.fn();
const refreshOutcomes = vi.fn();
const fetchOpportunitySource = vi.fn();
const saveStrategy = vi.fn();
const deleteStrategy = vi.fn();

vi.mock("@/lib/stock-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stock-api")>();
  return {
    ...actual,
    fetchStockScreenTemplates: (...args: unknown[]) => fetchTemplates(...args),
    fetchStockScreenStrategies: (...args: unknown[]) => fetchStrategies(...args),
    fetchStockScreenHistory: (...args: unknown[]) => fetchHistory(...args),
    compareStockScreenCandidates: (...args: unknown[]) => compareCandidates(...args),
    fetchStockScreenOutcomes: (...args: unknown[]) => fetchOutcomes(...args),
    fetchStockScreenResult: (...args: unknown[]) => fetchResult(...args),
    refreshStockScreenOutcomes: (...args: unknown[]) => refreshOutcomes(...args),
    fetchStockOpportunitySource: (...args: unknown[]) => fetchOpportunitySource(...args),
    saveStockScreenStrategy: (...args: unknown[]) => saveStrategy(...args),
    deleteStockScreenStrategy: (...args: unknown[]) => deleteStrategy(...args),
  };
});

function makeClient() {
  return {
    attach: vi.fn(),
    onWorkflowRunUpdated: vi.fn(() => () => undefined),
    getWorkflowRun: vi.fn().mockResolvedValue(null),
    runWorkflow: vi.fn().mockResolvedValue(undefined),
    syncStockScreenSchedule: vi.fn().mockResolvedValue({ status: "disabled" }),
  } as unknown as MonaClient;
}

function eventTransmissionFixture(pricedIn: string = "partially_priced_in") {
  return {
    status: "available",
    event: { text: "公司公告确认订单落地", claim_type: "fact", source_ids: ["src_event"] },
    direct_impact: { text: "订单将增加近期交付需求", claim_type: "inference", source_ids: ["src_event"] },
    industry_chain: [{ text: "上游材料需求可能同步增加", claim_type: "inference", source_ids: ["src_event"] }],
    business_exposure: { text: "公司主营产品覆盖该订单", claim_type: "fact", source_ids: ["src_event"] },
    earnings_path: { text: "交付确认后观察收入与利润兑现", claim_type: "inference", source_ids: ["src_event"] },
    validation_window: { text: "未来一个季度跟踪交付量和毛利率", claim_type: "inference", source_ids: ["src_event"] },
    priced_in: pricedIn,
    priced_in_basis: pricedIn === "unknown" ? null : { text: "当前价格与公开预期仅部分反映该事件", claim_type: "inference", source_ids: ["src_event"] },
    counter_evidence: [{ text: "订单存在延期风险", claim_type: "fact", source_ids: ["src_event"] }],
    invalidation_conditions: [{ text: "订单取消或无法交付", claim_type: "inference", source_ids: ["src_event"] }],
    data_gaps: [],
  };
}

function queueOpportunityResult(
  eventTransmission: unknown,
  snapshot: Record<string, unknown> = {},
) {
  fetchHistory.mockResolvedValueOnce([
    { run_id: "run_event", report_id: "report_event", strategy_id: "recent_catalyst", strategy_name: "近期催化", status: "completed", candidate_count: 1, research_status: "completed" },
  ]);
  fetchResult.mockResolvedValueOnce({
    report_id: "report_event",
    workflow_run_id: "run_event",
    strategy: { strategy_id: "recent_catalyst", name: "近期催化", source: "builtin" },
    candidates: [{ instrument_id: "XSHG:600519", name: "贵州茅台", snapshot, selection_reasons: [], risk_flags: [], data_quality: "available", rank: 1 }],
    opportunity_research: {
      status: "completed",
      candidate_count: 1,
      candidates: [{ instrument_id: "XSHG:600519", context_id: "ctx_event123456", research_priority: "high", why_now: { text: "事件值得继续研究", claim_type: "inference", source_ids: ["src_event"] }, event_transmission: eventTransmission }],
    },
  });
}

function queueQuantResult(validationStatus: string = "uncalibrated") {
  fetchHistory.mockResolvedValueOnce([
    { run_id: "run_quant_ui", report_id: "report_quant_ui", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "completed", candidate_count: 1 },
  ]);
  fetchResult.mockResolvedValueOnce({
    report_id: "report_quant_ui",
    workflow_run_id: "run_quant_ui",
    as_of: "2026-08-19T15:00:00+08:00",
    strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
    quant_snapshot: {
      schema_version: 1,
      as_of: "2026-08-19T15:00:00+08:00",
      validation_status: validationStatus,
      reason: validationStatus === "uncalibrated" ? "量化因子尚未经过历史校准" : "部分排序因子缺少可核验数据",
      universe: { universe_count: 100, hard_filter_count: 80, cheap_count: 50, enriched_count: 4, unprocessed_after_cap: 2 },
      factor_scopes: { roe: { scope: "industry", sample_count: 2, missing_count: 0, direction: "desc", weight: 0.4 } },
      data_quality: { status: "available", quant_validation_status: validationStatus, point_in_time: { status: "verified" } },
    },
    candidates: [{
      instrument_id: "XSHG:600519",
      name: "贵州茅台",
      selection_reasons: ["确定性条件命中"],
      risk_flags: [],
      data_quality: "available",
      rank: 1,
      quant_validation: {
        validation_status: validationStatus,
        quant_signal: validationStatus === "support" ? "positive" : "insufficient_data",
        horizons: {
          short_term: {
            validation_status: "uncalibrated",
            quant_signal: "insufficient_data",
            factor_observations: [
              { field: "momentum20", raw_value: 4.2, percentile_or_rank: 0.8, direction: "desc", scope: "market", sample_count: 100, missing_count: 0, as_of: "2026-08-19T15:00:00+08:00", source_ids: ["src_kline"], method_version: "percentile-rank-v1", validation_status: "uncalibrated" },
              { field: "volume", raw_value: 126000, percentile_or_rank: 0.6, direction: "desc", scope: "market", sample_count: 100, missing_count: 0, as_of: "2026-08-19T15:00:00+08:00", source_ids: ["src_quote"], method_version: "percentile-rank-v1", validation_status: "uncalibrated" },
              { field: "turnover", raw_value: 126000, percentile_or_rank: 0.7, direction: "desc", scope: "market", sample_count: 100, missing_count: 0, as_of: "2026-08-19T15:00:00+08:00", source_ids: ["src_quote"], method_version: "percentile-rank-v1", validation_status: "uncalibrated" },
            ],
          },
          medium_term: {
            validation_status: validationStatus === "uncalibrated" ? "uncalibrated" : "insufficient_data",
            quant_signal: "insufficient_data",
            factor_observations: [
              { field: "roe", raw_value: 12.3, percentile_or_rank: 0.7, direction: "desc", scope: "industry", sample_count: 2, missing_count: 0, as_of: "2026-08-19T15:00:00+08:00", source_ids: ["src_fundamentals"], method_version: "percentile-rank-v1", validation_status: "uncalibrated" },
              { field: "profit_yoy", raw_value: null, percentile_or_rank: null, direction: "desc", scope: "industry", sample_count: 1, missing_count: 1, as_of: "2026-08-19T15:00:00+08:00", source_ids: ["src_fundamentals"], method_version: "percentile-rank-v1", validation_status: "insufficient_data" },
            ],
          },
          long_term: {
            validation_status: "uncalibrated",
            quant_signal: "insufficient_data",
            factor_observations: [
              { field: "pe", raw_value: 20, percentile_or_rank: 0.4, direction: "asc", scope: "industry", sample_count: 2, missing_count: 0, as_of: "2026-08-19T15:00:00+08:00", source_ids: ["src_quote"], method_version: "percentile-rank-v1", validation_status: "uncalibrated" },
              { field: "custom_metric", raw_value: 4.2, percentile_or_rank: 0.4, direction: "desc", scope: "market", sample_count: 100, missing_count: 0, as_of: "2026-08-19T15:00:00+08:00", source_ids: ["src_custom"], method_version: "custom-v1", validation_status: "uncalibrated" },
            ],
          },
        },
      },
    }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchTemplates.mockResolvedValue([]);
  fetchStrategies.mockResolvedValue([]);
  fetchHistory.mockResolvedValue([]);
  fetchResult.mockResolvedValue({
    report_id: "report_1",
    workflow_run_id: "run_1",
    strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
    candidates: [],
  });
  compareCandidates.mockResolvedValue({});
  fetchOutcomes.mockResolvedValue({
    run_id: "run_1",
    report_id: "report_1",
    tracking: null,
    observations: [],
    pending: [],
    summary: { candidate_count: 0, total_window_count: 0, mature_window_count: 0, sample_count: 0, data_completeness_pct: null, windows: [], note: "选股是候选排序，不计算方向胜率。" },
    calculation: {},
    public_market_benchmark: { name: "中证全指", instrument_id: "XSHG:000985", instrument_type: "index" },
    updated: false,
    append_count: 0,
  });
  refreshOutcomes.mockResolvedValue({
    run_id: "run_1",
    report_id: "report_1",
    tracking: null,
    observations: [],
    pending: [],
    summary: { candidate_count: 0, total_window_count: 0, mature_window_count: 0, sample_count: 0, data_completeness_pct: null, windows: [], note: "选股是候选排序，不计算方向胜率。" },
    calculation: {},
    public_market_benchmark: { name: "中证全指", instrument_id: "XSHG:000985", instrument_type: "index" },
    updated: true,
    append_count: 0,
  });
  fetchOpportunitySource.mockResolvedValue({
    id: "src_1",
    provider: "eastmoney",
    url: "https://example.test/source",
    published_at: "2026-08-18T10:00:00+08:00",
    fetched_at: "2026-08-18T10:01:00+08:00",
    content_hash: "sha256:test",
  });
  saveStrategy.mockImplementation(async (strategy: unknown) => strategy);
  deleteStrategy.mockResolvedValue(undefined);
});

describe("OpportunityDiscovery", () => {
  it("reads local selection outcomes without POST, renders three windows, and refreshes only by button", async () => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_outcomes", report_id: "report_outcomes", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "succeeded", candidate_count: 1 },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "report_outcomes",
      workflow_run_id: "run_outcomes",
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
      validation: { status: "available", t5: 99, t20: 88, t60: 77, sample_count: 3 },
      candidates: [{ instrument_id: "XSHG:600519", name: "贵州茅台", selection_reasons: ["现金流改善"], risk_flags: [], data_quality: "available", rank: 1 }],
    });
    fetchOutcomes.mockResolvedValueOnce({
      run_id: "run_outcomes",
      report_id: "report_outcomes",
      tracking: null,
      observations: [
        { instrument_id: "XSHG:600519", window: 5, status: "complete", status_label: "数据完整", data_status_label: "可计算", target_return_pct: 2.25, benchmark_return_pct: 1.1, relative_return_pct: 1.15, entry_date: "2026-08-20", exit_date: "2026-08-26" },
        { instrument_id: "XSHG:600519", window: 20, status: "incomplete", status_label: "数据不完整", data_status_label: "标的缺少对应交易日行情", target_return_pct: null, benchmark_return_pct: null, relative_return_pct: null, entry_date: "2026-08-20", exit_date: null },
      ],
      pending: [{ instrument_id: "XSHG:600519", window: 60, status: "pending", status_label: "窗口尚未成熟", data_status_label: "尚未达到观察窗口", target_return_pct: null, benchmark_return_pct: null, relative_return_pct: null, entry_date: null, exit_date: null }],
      summary: { candidate_count: 1, total_window_count: 3, mature_window_count: 2, sample_count: 1, data_completeness_pct: 50, windows: [], note: "选股是候选排序，不计算方向胜率。" },
      calculation: { method: "selection-forward-v1", version: "selection-forward-v1" },
      public_market_benchmark: { name: "中证全指", instrument_id: "XSHG:000985", instrument_type: "index" },
      updated: false,
      append_count: 0,
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    const panel = await screen.findByTestId("selection-outcomes");
    expect(fetchOutcomes).toHaveBeenCalledWith("run_outcomes", expect.any(AbortSignal));
    expect(refreshOutcomes).not.toHaveBeenCalled();
    await screen.findByText("候选数");
    expect(panel).toHaveTextContent("选股是候选排序，不计算涨跌胜率。");
    expect(panel).toHaveTextContent("候选数");
    expect(panel).toHaveTextContent("已到观察日期的结果数");
    expect(panel).toHaveTextContent("数据完整的结果数");
    expect(panel).toHaveTextContent("数据完整度");
    expect(panel).toHaveTextContent("第 5 个交易日");
    expect(panel).toHaveTextContent("标的收益");
    expect(panel).toHaveTextContent("+2.25%");
    expect(panel).toHaveTextContent("基准收益（中证全指）");
    expect(panel).toHaveTextContent("相对收益（标的减基准）");
    expect(panel).toHaveTextContent("2026-08-20 至 2026-08-26");
    expect(panel).toHaveTextContent("标的缺少对应交易日行情");
    expect(panel).toHaveTextContent("尚未到观察日期");
    expect(panel.textContent).not.toMatch(/selection-forward-v1|available|pending|incomplete|run_outcomes|report_outcomes|tracking/);
    expect(panel).not.toHaveTextContent("成熟窗口数");
    expect(panel).not.toHaveTextContent("有效样本数");
    expect(panel).not.toHaveTextContent("99%");
    expect(screen.queryByText("AI发现")).toBeNull();
    expect(screen.queryByText("AI研究")).toBeNull();

    refreshOutcomes.mockRejectedValueOnce(new Error("行情服务不可用"));
    fireEvent.click(screen.getByRole("button", { name: "更新历史结果" }));
    await waitFor(() => expect(refreshOutcomes).toHaveBeenCalledWith("run_outcomes", expect.any(AbortSignal)));
    expect(await screen.findByText(/历史结果更新失败/)).toBeTruthy();
    expect(panel).toHaveTextContent("+2.25%");
    expect(panel).toHaveTextContent("第 5 个交易日");
  });

  it("shows only the batch summary when a selection report has no candidates", async () => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_empty_outcomes", report_id: "report_empty_outcomes", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "succeeded", candidate_count: 0 },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "report_empty_outcomes",
      workflow_run_id: "run_empty_outcomes",
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
      validation: { status: "available", t5: 99, t20: 88, t60: 77, sample_count: 3 },
      candidates: [],
    });
    fetchOutcomes.mockResolvedValueOnce({
      run_id: "run_empty_outcomes",
      report_id: "report_empty_outcomes",
      tracking: null,
      observations: [],
      pending: [],
      summary: { candidate_count: 0, total_window_count: 0, mature_window_count: 0, sample_count: 0, data_completeness_pct: null, windows: [], note: "选股是候选排序，不计算方向胜率。" },
      calculation: {},
      public_market_benchmark: { name: "中证全指", instrument_id: "XSHG:000985", instrument_type: "index" },
      updated: false,
      append_count: 0,
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    const panel = await screen.findByTestId("selection-outcomes");
    await waitFor(() => expect(panel).toHaveTextContent("尚未形成历史结果"));
    expect(panel).toHaveTextContent("当前未选中具体候选，仅显示本批次汇总");
    expect(panel).not.toHaveTextContent("99%");
    expect(panel).not.toHaveTextContent("第 5 个交易日");
  });

  it("enables the recent-catalyst entry and shows its event window before running", async () => {
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    const catalyst = await screen.findByRole("button", { name: /近期催化/ });
    expect(catalyst).not.toBeDisabled();
    expect(screen.getByText("从近期可核验公告中发现值得继续研究的事件线索。")).toBeTruthy();
    fireEvent.click(catalyst);
    expect(await screen.findByText("事件窗口：近 7 日")).toBeTruthy();
    expect(screen.getByText("公告覆盖：运行时确认公告覆盖范围")).toBeTruthy();
  });

  it("renders catalyst coverage and up to two traceable event facts", async () => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_catalyst", report_id: "report_catalyst", strategy_id: "recent_catalyst", strategy_name: "近期催化", status: "succeeded", candidate_count: 1 },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "report_catalyst",
      workflow_run_id: "run_catalyst",
      strategy: { strategy_id: "recent_catalyst", name: "近期催化", source: "builtin" },
      catalyst_capture: { complete: true, status: "complete", expected_count: 12, loaded_count: 12 },
      candidates: [{
        instrument_id: "XSHG:600519",
        name: "贵州茅台",
        snapshot: {
          catalyst_events: [
            { event_id: "evt_1", event_type: "业绩预告", title: "年度业绩预增公告", published_at: "2026-08-18T10:00:00+08:00", source_id: "src_evt_1", url: "https://example.test/event-1" },
            { event_id: "evt_2", event_type: "回购", title: "回购进展公告", published_at: "2026-08-17T09:00:00+08:00", source_id: "src_evt_2", url: "https://example.test/event-2" },
            { event_id: "evt_3", event_type: "分红", title: "分红实施公告", published_at: "2026-08-16T09:00:00+08:00", source_id: "src_evt_3", url: "https://example.test/event-3" },
          ],
        },
        selection_reasons: ["命中可核验材料事件"],
        risk_flags: [],
        data_quality: "available",
        rank: 1,
      }],
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect(await screen.findByText("公告覆盖：已核验 12 条公告")).toBeTruthy();
    expect(screen.getAllByText(/业绩预告 · 年度业绩预增公告/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/回购 · 回购进展公告/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/分红 · 分红实施公告/).length).toBe(1);
    expect(screen.getAllByRole("link", { name: "查看来源" }).length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["unavailable", { status: "unavailable", error: "公告接口超时" }, "近期催化事件源暂不可用"],
    ["partial", { status: "partial", complete: false, loaded_count: 4, expected_count: 12 }, "事件覆盖不完整，暂未生成可靠候选"],
    ["truncated", { complete: false, error: "result truncated", loaded_count: 4, expected_count: 12 }, "事件覆盖不完整，暂未生成可靠候选"],
    ["stale", { status: "stale", cache_status: "stale_cache", loaded_count: 12, expected_count: 12 }, "当前使用过期事件缓存"],
  ] as const)("distinguishes %s catalyst data state from no-hit", async (_state, capture, message) => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: `run_${_state}`, report_id: `report_${_state}`, strategy_id: "recent_catalyst", strategy_name: "近期催化", status: "succeeded", candidate_count: 0 },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: `report_${_state}`,
      workflow_run_id: `run_${_state}`,
      strategy: { strategy_id: "recent_catalyst", name: "近期催化", source: "builtin" },
      catalyst_capture: capture,
      candidates: [],
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it("distinguishes a complete capture with no material event hits", async () => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_no_hit", report_id: "report_no_hit", strategy_id: "recent_catalyst", strategy_name: "近期催化", status: "succeeded", candidate_count: 0 },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "report_no_hit",
      workflow_run_id: "run_no_hit",
      strategy: { strategy_id: "recent_catalyst", name: "近期催化", source: "builtin" },
      catalyst_capture: { complete: true, status: "complete", expected_count: 12, loaded_count: 12 },
      candidates: [],
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect(await screen.findByText("近 7 日没有命中材料事件")).toBeTruthy();
    expect(screen.queryByText("近期催化事件源暂不可用")).toBeNull();
  });

  it("labels compared dimension values with each candidate name and code", async () => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_compare", report_id: "report_compare", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "succeeded", candidate_count: 2 },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "report_compare",
      workflow_run_id: "run_compare",
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
      candidates: [
        { instrument_id: "XSHG:600519", name: "贵州茅台", symbol: "600519", selection_reasons: [], risk_flags: [], data_quality: "available", rank: 1 },
        { instrument_id: "XSHE:000001", name: "平安银行", symbol: "000001", selection_reasons: [], risk_flags: [], data_quality: "available", rank: 2 },
      ],
    });
    compareCandidates.mockResolvedValueOnce({
      dimensions: [{ key: "pe", label: "市盈率", values: { "XSHG:600519": 20, "XSHE:000001": 10 } }],
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "加入比较 贵州茅台" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "加入比较 平安银行" }));
    fireEvent.click(screen.getByRole("button", { name: "比较 (2)" }));

    expect(await screen.findByText("贵州茅台 · 股票代码 600519")).toBeTruthy();
    expect(screen.getByText("平安银行 · 股票代码 000001")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toContain("XSHG:600519");
    expect(document.body.textContent ?? "").not.toContain("XSHE:000001");
    expect(document.body.textContent ?? "").not.toContain("候选 ID");
  });

  it("uses readable labels for empty-result filter statistics without leaking fields", async () => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_empty_filters", report_id: "report_empty_filters", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "succeeded", candidate_count: 0 },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "report_empty_filters",
      workflow_run_id: "run_empty_filters",
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
      candidates: [],
      filter_statistics: [
        { field: "operating_cashflow", removed: 2 },
        { field: "private_internal_factor", removed: 1 },
      ],
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect(await screen.findByText("经营活动现金流")).toBeTruthy();
    expect(screen.getByText("其他筛选条件")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toContain("operating_cashflow");
    expect(document.body.textContent ?? "").not.toContain("private_internal_factor");
  });

  it("resolves historical strategy names without showing internal strategy IDs", async () => {
    fetchStrategies.mockResolvedValueOnce([
      { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
    ]);
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_strategy_name", strategy_id: "quality_growth", status: "succeeded", candidate_count: 0 },
      { run_id: "run_unknown_strategy", strategy_id: "private_strategy_42", status: "succeeded", candidate_count: 0 },
    ]);
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));

    expect(await screen.findByText("业绩成长")).toBeTruthy();
    expect(screen.getByText("选股策略（名称待确认）")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toContain("private_strategy_42");
  });

  it("turns both beginner answers into a visible strategy and research count", async () => {
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    await screen.findByText("说说你想找什么机会");
    fireEvent.click(screen.getByRole("button", { name: /不知道怎么选/ }));
    fireEvent.click(screen.getByRole("button", { name: "业绩成长" }));
    fireEvent.click(screen.getByRole("button", { name: "一到几个月" }));
    expect(await screen.findByText(/观察周期：中线（约2周至6个月）/)).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "人工智能研究排名前几只" })).toHaveValue(1);
  });

  it("combines multiple beginner directions and researches the chosen top N", async () => {
    const client = makeClient();
    render(<OpportunityDiscovery client={client} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /经营稳健/ }));
    fireEvent.click(screen.getByRole("button", { name: /业绩成长/ }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "人工智能研究排名前几只" }), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并开始" }));
    await waitFor(() => expect(client.runWorkflow).toHaveBeenCalledWith(
      "stock_research",
      expect.objectContaining({
        research_limit: 4,
        strategy: expect.objectContaining({
          strategy_id: "combined_discovery",
          included_strategy_ids: ["stable_business", "quality_growth"],
          research_limit: 4,
        }),
      }),
      "package://com.mona.a-share-team/workflows/stock-selection.json",
    ));
  });

  it("rejects non-integer AI research counts", async () => {
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /经营稳健/ }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "人工智能研究排名前几只" }), { target: { value: "1.5" } });
    expect(screen.getByText("请输入 1至8的整数。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认并开始" })).toBeDisabled();
  });

  it("opens a historical result without manufacturing a workflow run", async () => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_history", report_id: "report_history", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "succeeded", candidate_count: 1 },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "report_history",
      workflow_run_id: "run_history",
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
      data_quality: { status: "available" },
      candidates: [{ instrument_id: "XSHG:600519", name: "贵州茅台", snapshot: { price: 1700.5, change_pct: 1.2 }, selection_reasons: ["测试原因"], risk_flags: [], missing_fields: ["operating_cashflow"], matched_conditions: [{ field: "momentum20", op: ">=", value: 1 }], score_contributions: { volatility20: 2 }, data_quality: "unrecognized_status", rank: 1 }],
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    await waitFor(() => expect(screen.getAllByText("贵州茅台").length).toBeGreaterThan(0));
    expect(screen.getByText("1 只候选 · 按策略排序")).toBeTruthy();
    expect(screen.getByText("1,700.5")).toBeTruthy();
    expect(screen.getAllByText("数据状态待确认").length).toBeGreaterThan(0);
    expect(screen.getByText("缺失：经营活动现金流")).toBeTruthy();
    fireEvent.click(screen.getByText("查看筛选条件与依据"));
    expect(screen.getByText(/20日价格动量大于或等于1/)).toBeTruthy();
    expect(screen.getByText(/20日波动幅度：2/)).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/short_term|swing|medium_term|long_term|operating_cashflow|momentum20|volatility20|partial|stale|unavailable|ctx_/);
  });

  it("renders only descriptive uncalibrated quantitative observations", async () => {
    queueQuantResult();
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect((await screen.findAllByText("量化未校准")).length).toBeGreaterThan(0);
    expect(screen.getByTestId("quant-observation-panel")).toBeTruthy();
    expect(screen.getByText("因子计算覆盖")).toBeTruthy();
    expect(screen.getByText("处理 4 只 / 未处理 2 只")).toBeTruthy();
    expect(screen.getByText("中线可用因子")).toBeTruthy();
    expect(screen.getByText("仅展示确定性因子观察，尚未经过样本外校准，不构成支持或反对结论")).toBeTruthy();

    fireEvent.click(screen.getByText("查看量化因子详情"));
    expect(screen.getByText("20日价格动量")).toBeTruthy();
    expect(screen.getByText("净资产收益率")).toBeTruthy();
    expect(screen.getByText("市盈率")).toBeTruthy();
    expect(screen.getAllByText("同行业比较").length).toBeGreaterThan(0);
    expect(screen.getAllByText("当前分位数排序版本").length).toBeGreaterThan(0);
    expect(document.body.textContent ?? "").not.toMatch(/quant_signal|source_ids|method_version|strategy_fingerprint|上涨概率/);
  });

  it("adds units and readable scaling to raw quantitative values", async () => {
    queueQuantResult();
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    await screen.findByTestId("quant-observation-panel");
    fireEvent.click(screen.getByText("查看量化因子详情"));

    expect(screen.getByText("4.2%")).toBeTruthy();
    expect(screen.getByText("12.6万股")).toBeTruthy();
    expect(screen.getByText("12.6万元")).toBeTruthy();
    expect(screen.getByText("20倍")).toBeTruthy();
    expect(screen.getByText("4.2（单位未提供）")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/custom_metric/);
  });

  it("shows data insufficiency without filling missing quantitative values", async () => {
    queueQuantResult("insufficient_data");
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect((await screen.findAllByText("尚未形成量化结论")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("查看量化因子详情"));
    expect(screen.getByText("暂无可核验数值")).toBeInTheDocument();
    expect(screen.getByText("暂无可核验分位")).toBeInTheDocument();
    expect(screen.queryByText("支持")).toBeNull();
    expect(screen.queryByText("反对")).toBeNull();
  });

  it.each(["support", "oppose", "unconfirmed"])("downgrades uncalibrated UI for hostile quant status %s", async (status) => {
    queueQuantResult(status);
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect((await screen.findAllByText("量化状态待验证")).length).toBeGreaterThan(0);
    expect(screen.queryByText("量化支持")).toBeNull();
    expect(screen.queryByText("量化反对")).toBeNull();
  });

  it("keeps old selection results free of an empty quantitative card and preserves actions", async () => {
    const onAddWatchlist = vi.fn().mockResolvedValue(undefined);
    const onDeepResearch = vi.fn();
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_old_quant", report_id: "report_old_quant", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "completed", candidate_count: 1 },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "report_old_quant",
      workflow_run_id: "run_old_quant",
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin", horizon: "medium_term" },
      candidates: [{ instrument_id: "XSHG:600519", name: "贵州茅台", selection_reasons: ["条件命中"], risk_flags: [], data_quality: "available", rank: 1 }],
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={onAddWatchlist} onDeepResearch={onDeepResearch} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect((await screen.findAllByText("贵州茅台")).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("quant-observation-panel")).toBeNull();
    expect(screen.queryByText("量化未校准")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "加入自选" }));
    fireEvent.click(screen.getByRole("button", { name: "深度投研" }));
    await waitFor(() => expect(onAddWatchlist).toHaveBeenCalledTimes(1));
    expect(onDeepResearch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["高优先级", "high", [], "可进入深度投研", null],
    ["中优先级", "medium", [], "可继续研究", null],
    ["低优先级有具体缺口", "low", [{ text: "缺少未来盈利预期", claim_type: "unknown", source_ids: [] }], "暂不形成买卖建议", "暂不形成买卖建议：缺少未来盈利预期"],
    ["低优先级无具体缺口", "low", [], "暂不形成买卖建议", "暂不形成买卖建议：关键条件待确认"],
    ["未知优先级", "unknown", [], "尚不能形成买卖建议", null],
  ] as const)("shows a user-facing research priority and low-priority reason (%s)", async (_case, priority, dataGaps, priorityText, lowPriorityText) => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: `run_priority_${priority}`, report_id: `report_priority_${priority}`, strategy_id: "quality_growth", strategy_name: "业绩成长", status: "succeeded", candidate_count: 1, research_status: "completed", has_opportunity_research: true },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: `report_priority_${priority}`,
      workflow_run_id: `run_priority_${priority}`,
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
      candidates: [{ instrument_id: "XSHG:600519", name: "贵州茅台", selection_reasons: ["确定性条件命中"], risk_flags: [], data_quality: "available", rank: 1 }],
      opportunity_research: {
        status: "completed",
        candidate_count: 1,
        candidates: [{ instrument_id: "XSHG:600519", context_id: "ctx_priority123456", research_priority: priority, why_now: { text: "当前值得研究候选线索", claim_type: "inference", source_ids: [] }, data_gaps: dataGaps }],
      },
    });

    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect((await screen.findAllByText(priorityText)).length).toBeGreaterThanOrEqual(2);
    const rowWhyNow = screen.getAllByText("当前值得研究候选线索")[0];
    if (lowPriorityText) {
      expect(rowWhyNow.nextElementSibling).toHaveTextContent(lowPriorityText);
    } else {
      expect(rowWhyNow.nextElementSibling).not.toHaveTextContent("暂不形成买卖建议：");
    }
  });

  it.each([
    ["complete", {
      status: "complete",
      as_of: "2026-08-19T15:00:00+08:00",
      comparison_scope: "same_industry_current_snapshot",
      basis: "同一行业当前快照中除目标公司外的正值样本用于比较",
      current_pe: 20,
      current_pb: 5,
      pe: { value: 20, peer_count: 2, median: 20, percentile: 0 },
      pb: { value: 5, peer_count: 2, median: 2.5, percentile: 1 },
      missing_fields: [],
    }, "估值数据完整"],
    ["partial", {
      status: "partial",
      as_of: "2026-08-19T15:00:00+08:00",
      comparison_scope: "same_industry_current_snapshot",
      basis: "同一行业当前快照中除目标公司外的正值样本用于比较",
      current_pe: 20,
      current_pb: null,
      pe: { value: 20, peer_count: 1, median: null, percentile: null },
      pb: { value: null, peer_count: 0, median: null, percentile: null },
      missing_fields: ["current_pb", "peer_pe", "peer_pb", "peer_valuation"],
    }, "估值参考不完整"],
    ["unavailable", {
      status: "unavailable",
      as_of: "2026-08-19T15:00:00+08:00",
      comparison_scope: "same_industry_current_snapshot",
      basis: "同一行业当前快照中除目标公司外的正值样本用于比较",
      current_pe: null,
      current_pb: null,
      pe: { value: null, peer_count: 0, median: null, percentile: null },
      pb: { value: null, peer_count: 0, median: null, percentile: null },
      missing_fields: ["current_pe", "current_pb", "peer_valuation"],
    }, "估值暂不判断"],
  ] as const)("renders %s valuation reference in the selected candidate detail", async (_status, valuation, statusLabel) => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: `run_valuation_${_status}`, report_id: `report_valuation_${_status}`, strategy_id: "quality_growth", strategy_name: "业绩成长", status: "succeeded", candidate_count: 1 },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: `report_valuation_${_status}`,
      workflow_run_id: `run_valuation_${_status}`,
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
      candidates: [{
        instrument_id: "XSHG:600519",
        name: "贵州茅台",
        selection_reasons: ["确定性条件命中"],
        risk_flags: [],
        data_quality: "available",
        rank: 1,
        valuation_context: valuation,
      }],
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect(await screen.findByText("估值参考")).toBeTruthy();
    expect(screen.getByText(statusLabel)).toBeTruthy();
    expect(screen.getByText("市盈率（PE）")).toBeTruthy();
    expect(screen.getByText("市净率（PB）")).toBeTruthy();
    expect(screen.getAllByText("同行样本（不含当前公司）").length).toBe(2);
    expect(screen.getByText("同行业当前行情快照比较")).toBeTruthy();
    expect(screen.getByText("数值越高表示相对同行估值越高")).toBeTruthy();
    expect(screen.getByText(/数据时点：/)).toBeTruthy();
    if (_status === "complete") {
      expect(screen.getAllByText("同行中位数")).toHaveLength(2);
      expect(screen.getByText("0%")).toBeTruthy();
      expect(screen.getByText("100%")).toBeTruthy();
    } else if (_status === "partial") {
      expect(screen.getAllByText("同行比较待确认，暂不能判断相对高低").length).toBeGreaterThan(0);
      expect(screen.getByText("估值参考暂不完整，缺少：当前市净率、同行市盈率样本、同行市净率样本、同行估值比较")).toBeTruthy();
    } else {
      expect(screen.getByText("无法形成估值参考，缺少：当前市盈率、当前市净率、同行估值比较")).toBeTruthy();
    }
    expect(document.body.textContent ?? "").not.toMatch(/comparison_scope|current_pe|current_pb|peer_count|complete|partial|unavailable/);
  });

  it("renders v2 short, medium and long horizon research with an insufficient-data explanation", async () => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_horizons", report_id: "report_horizons", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "succeeded", candidate_count: 1, research_status: "completed", has_opportunity_research: true },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "report_horizons",
      workflow_run_id: "run_horizons",
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
      candidates: [{ instrument_id: "XSHG:600519", name: "贵州茅台", selection_reasons: ["确定性条件命中"], risk_flags: [], data_quality: "available", rank: 1 }],
      opportunity_research: {
        schema_version: 2,
        status: "completed",
        candidate_count: 1,
        candidates: [{
          instrument_id: "XSHG:600519",
          context_id: "ctx_horizon123456",
          research_priority: "high",
          why_now: { text: "当前证据支持继续研究", claim_type: "inference", source_ids: ["src_now"] },
          horizon_views: {
            short_term: {
              status: "available",
              summary: { text: "短线核心判断", claim_type: "inference", source_ids: ["src_short"] },
              supporting_evidence: [{ text: "短线支持证据", claim_type: "fact", source_ids: ["src_short"] }],
              counter_evidence: [{ text: "短线最重要反证", claim_type: "fact", source_ids: ["src_short"] }],
              watch_items: [{ text: "短线后续观察", claim_type: "unknown", source_ids: [] }],
              invalidation_conditions: [{ text: "短线失效条件", claim_type: "unknown", source_ids: [] }],
              data_gaps: [],
            },
            medium_term: {
              status: "insufficient_data",
              summary: { text: "缺少未来盈利预期和政策兑现证据", claim_type: "unknown", source_ids: [] },
              supporting_evidence: [],
              counter_evidence: [],
              watch_items: [],
              invalidation_conditions: [],
              data_gaps: [{ text: "缺少未来盈利预期", claim_type: "unknown", source_ids: [] }, "政策兑现信息不足"],
            },
            long_term: {
              status: "available",
              summary: { text: "长线核心判断", claim_type: "inference", source_ids: ["src_long"] },
              supporting_evidence: [{ text: "长线支持证据", claim_type: "fact", source_ids: ["src_long"] }],
              counter_evidence: [{ text: "长线最重要反证", claim_type: "fact", source_ids: ["src_long"] }],
              watch_items: [{ text: "长线后续观察", claim_type: "unknown", source_ids: [] }],
              invalidation_conditions: [{ text: "长线失效条件", claim_type: "unknown", source_ids: [] }],
              data_gaps: [],
            },
          },
        }],
      },
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect(await screen.findByText("三周期候选研究")).toBeTruthy();
    expect(screen.getByText("短线 · 1—10 个交易日")).toBeTruthy();
    expect(screen.getByText("中线 · 2 周—6 个月")).toBeTruthy();
    expect(screen.getByText("长线 · 6 个月以上")).toBeTruthy();
    expect(screen.getByText("回答：当前时点和交易风险")).toBeTruthy();
    expect(screen.getByText("回答：预期是否持续上修或下修")).toBeTruthy();
    expect(screen.getByText("回答：价值与竞争力能否持续")).toBeTruthy();
    expect(screen.getAllByText("证据可用")).toHaveLength(2);
    expect(screen.getByText("当前周期待确认")).toBeTruthy();
    expect(screen.getByText("短线核心判断")).toBeTruthy();
    expect(screen.getByText(/当前无法形成中线判断，原因：缺少未来盈利预期和政策兑现证据；缺少未来盈利预期；政策兑现信息不足/)).toBeTruthy();
    expect(screen.getByText("长线核心判断")).toBeTruthy();
    expect(screen.getByText("缺少未来盈利预期")).toBeTruthy();
    expect(screen.getByText("政策兑现信息不足")).toBeTruthy();
    expect(screen.getByText("跨周期共同信息")).toBeTruthy();
    expect(screen.getByText("跨周期机会假设")).toBeTruthy();
    expect(screen.getAllByText("相对候选特点")).toHaveLength(1);
    expect(screen.queryByText("机会假设")).toBeNull();
    expect(screen.queryByText("反对证据")).toBeNull();
    expect(screen.getAllByText("后续观察")).toHaveLength(3);
    expect(screen.getAllByText("失效条件")).toHaveLength(3);

    fireEvent.click(screen.getByText("短线 · 1—10 个交易日"));
    expect(screen.getByText("短线支持证据")).toBeTruthy();
    expect(screen.getByText("短线最重要反证")).toBeTruthy();
    expect(screen.getByText("短线后续观察")).toBeTruthy();
    expect(screen.getByText("短线失效条件")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/short_term|medium_term|long_term|insufficient_data|context_id|source_id/);
  });

  it("renders an available event transmission in order with traceable claims", async () => {
    queueOpportunityResult(eventTransmissionFixture("partially_priced_in"));
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect(await screen.findByText("事件影响传导")).toBeTruthy();
    expect(screen.getByText("证据可用")).toBeTruthy();
    expect(screen.getByText("1. 可核验事件")).toBeTruthy();
    expect(screen.getByText("2. 直接影响")).toBeTruthy();
    expect(screen.getByText("3. 行业与产业链传导（按顺序）")).toBeTruthy();
    expect(screen.getByText("4. 公司业务敞口")).toBeTruthy();
    expect(screen.getByText("5. 收入与利润验证路径")).toBeTruthy();
    expect(screen.getByText("验证时间与观察内容")).toBeTruthy();
    expect(screen.getByText("部分反映")).toBeTruthy();
    expect(screen.getByText("计价依据")).toBeTruthy();
    expect(screen.getByText("公司公告确认订单落地")).toBeTruthy();
    expect(screen.getByText("上游材料需求可能同步增加")).toBeTruthy();
    expect(screen.getAllByText("事实").length).toBeGreaterThan(0);
    expect(screen.getAllByText("推断").length).toBeGreaterThan(0);
    expect(screen.getByText("题材联想不等于业务受益，业务涉及不等于收入或利润兑现。")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/event_transmission|direct_impact|industry_chain|business_exposure|earnings_path|priced_in|source_id|context_id/);
  });

  it("shows concrete missing evidence without rendering an insufficient-data chain", async () => {
    queueOpportunityResult({
      status: "insufficient_data",
      data_gaps: [
        { text: "缺少事件来源与公司业务敞口证据", claim_type: "unknown", source_ids: [] },
        "缺少收入确认时间表",
      ],
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect(await screen.findByRole("heading", { name: "事件传导待确认" })).toBeTruthy();
    expect(screen.getByText(/当前无法形成事件影响传导判断，原因：缺少事件来源与公司业务敞口证据；缺少收入确认时间表/)).toBeTruthy();
    expect(screen.getByText("还缺什么")).toBeTruthy();
    expect(screen.getByText("缺少收入确认时间表")).toBeTruthy();
    expect(screen.queryByText("1. 可核验事件")).toBeNull();
    expect(screen.queryByText("无法核验")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/event_transmission|direct_impact|industry_chain|business_exposure|earnings_path|priced_in|source_id|context_id/);
  });

  it.each([
    ["not_priced_in", "尚未反映"],
    ["partially_priced_in", "部分反映"],
    ["fully_priced_in", "已经充分反映"],
    ["unknown", "无法判断"],
  ] as const)("maps the %s pricing state to Chinese UI text", async (pricedIn, label) => {
    queueOpportunityResult(eventTransmissionFixture(pricedIn));
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect(await screen.findByText(label)).toBeTruthy();
    if (pricedIn === "unknown") {
      expect(screen.getByText("缺少可核验的价格与预期证据时只能显示无法判断。")).toBeTruthy();
      expect(screen.queryByText("计价依据")).toBeNull();
    } else {
      expect(screen.getByText("计价依据")).toBeTruthy();
    }
    expect(document.body.textContent ?? "").not.toMatch(/not_priced_in|partially_priced_in|fully_priced_in|unknown/);
  });

  it("does not show an empty event card for a non-event candidate", async () => {
    queueOpportunityResult(null);
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    await screen.findByText("人工智能机会研究");
    expect(screen.queryByText("事件影响传导")).toBeNull();
  });

  it("explains when a historical catalyst has no traceable event chain", async () => {
    queueOpportunityResult(null, {
      catalyst_events: [{ event_id: "evt_history", event_type: "业绩预告", title: "历史业绩预告", source_id: "src_event" }],
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect(await screen.findByText("这份历史候选研究未生成可追溯的事件传导链")).toBeTruthy();
  });

  it("passes the exact canonical selection origin when starting deep research", async () => {
    const onDeepResearch = vi.fn();
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_selection", report_id: "selection_report", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "completed", candidate_count: 1, research_status: "completed" },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "selection_report",
      workflow_run_id: "run_selection",
      as_of: "2026-08-19T15:00:00+08:00",
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin", horizon: "medium_term" },
      candidates: [{ instrument_id: "XSHG:600519", name: "贵州茅台", selection_reasons: ["operating_cashflow 改善", "现金流改善"], risk_flags: [], data_quality: "available", rank: 5 }],
      opportunity_research: {
        report_id: "opportunity_report",
        status: "completed",
        candidate_count: 1,
        candidates: [{ instrument_id: "XSHG:600519", deterministic_rank: 2, context_id: "ctx_selection123456", research_priority: "high", why_now: { text: "momentum20 与 industry_context 需要核验", claim_type: "inference", source_ids: ["src_a", " src_a", "src_b"] }, watch_items: [{ text: "policy_context 尚未确认", claim_type: "unknown", source_ids: [] }, { text: "policy_context 尚未确认", claim_type: "unknown", source_ids: [] }], data_gaps: ["机构盈利预期", "机构盈利预期"], source_ids: ["src_a", "src_a", "src_b"] }],
      },
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={onDeepResearch} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    fireEvent.click(await screen.findByRole("button", { name: "深度投研" }));

    expect(onDeepResearch.mock.calls).toEqual([[
      "XSHG:600519",
      {
        schema_version: 1,
        selection_run_id: "run_selection",
        selection_report_id: "selection_report",
        opportunity_report_id: "opportunity_report",
        instrument_id: "XSHG:600519",
        strategy_id: "quality_growth",
        strategy_name: "业绩成长",
        strategy_horizon: "medium_term",
        deterministic_rank: 2,
        selection_reasons: ["operating_cashflow 改善", "现金流改善"],
        why_now: "momentum20 与 industry_context 需要核验",
        research_priority: "high",
        focus_questions: ["policy_context 尚未确认", "机构盈利预期"],
        source_count: 2,
        selection_as_of: "2026-08-19T15:00:00+08:00",
        usage_note: "这是选股阶段的先验线索，不是深度投研事实；必须使用本次投研证据重新核验。",
      },
    ]]);
  });

  it("renders an opportunity report while keeping selection-only fields visible", async () => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_opportunity", report_id: "report_opportunity", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "succeeded", candidate_count: 1, research_status: "completed", has_opportunity_research: true },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "report_opportunity",
      workflow_run_id: "run_opportunity",
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin", research_limit: 5 },
      candidates: [{ instrument_id: "XSHG:600519", name: "贵州茅台", snapshot: { price: 1700.5, change_pct: 1.2 }, selection_reasons: ["确定性条件命中"], risk_flags: [], data_quality: "available", rank: 1 }],
      opportunity_research: {
        status: "completed",
        candidate_count: 1,
        candidates: [{ instrument_id: "XSHG:600519", context_id: "ctx_abcdefghijkl", research_priority: "high", why_now: { text: "现金流改善，值得继续研究", claim_type: "inference", source_ids: ["src_1"] }, supporting_evidence: [{ text: "经营现金流同比改善", claim_type: "fact", source_ids: ["src_1"] }], counter_evidence: [{ text: "估值仍需核验", claim_type: "unknown", source_ids: [] }], relative_edge: [{ text: "同批候选中现金流更稳定", claim_type: "inference", source_ids: ["src_1"] }], watch_items: [{ text: "下一期现金流", claim_type: "unknown", source_ids: [] }], invalidation_conditions: [{ text: "现金流再次恶化", claim_type: "inference", source_ids: ["src_1"] }], data_gaps: ["缺少机构预期"] }],
      },
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect((await screen.findAllByText("现金流改善，值得继续研究")).length).toBeGreaterThan(0);
    expect(screen.getByText("人工智能机会研究")).toBeTruthy();
    expect(screen.queryByText("人工智能机会研究（AI）")).toBeNull();
    expect(screen.getAllByText("推断").length).toBeGreaterThan(0);
    expect(screen.getByText("经营现金流同比改善")).toBeTruthy();
    expect(screen.getByText("估值仍需核验")).toBeTruthy();
    expect(screen.getByText("缺少机构预期")).toBeTruthy();
    expect(screen.getByText("这份历史候选研究未生成短线、中线、长线独立分析")).toBeTruthy();
    expect(screen.getByText("机会假设")).toBeTruthy();
    expect(screen.getByText("支持证据")).toBeTruthy();
    expect(screen.getByText("反对证据")).toBeTruthy();
    expect(screen.getByText("相对候选特点")).toBeTruthy();
    expect(screen.getByText("后续观察")).toBeTruthy();
    expect(screen.getByText("失效条件")).toBeTruthy();
  });

  it("opens a cited source record inside the opportunity detail and can close it", async () => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_source", report_id: "report_source", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "completed", candidate_count: 1, research_status: "completed" },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "report_source",
      workflow_run_id: "run_source",
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
      candidates: [{ instrument_id: "XSHG:600519", name: "贵州茅台", selection_reasons: [], risk_flags: [], data_quality: "available", rank: 1 }],
      opportunity_research: {
        status: "completed",
        candidate_count: 1,
        candidates: [{ instrument_id: "XSHG:600519", context_id: "ctx_abcdefghijkl", research_priority: "medium", supporting_evidence: [{ text: "现金流改善", claim_type: "fact", source_ids: ["src_1"] }], counter_evidence: [{ text: "仍需观察", claim_type: "unknown", source_ids: [] }] }],
      },
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    const sourceButtons = await screen.findAllByRole("button", { name: "来源 1" });
    fireEvent.click(sourceButtons[0]);
    expect(fetchOpportunitySource).toHaveBeenCalledWith("run_source", "ctx_abcdefghijkl", "src_1");
    expect(await screen.findByText("东方财富")).toBeTruthy();
    expect(screen.getByText("https://example.test/source")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByText("https://example.test/source")).toBeNull();
  });

  it("keeps cited source IDs readable without a valid workflow context", async () => {
    fetchHistory.mockResolvedValueOnce([
      { run_id: "run_without_context", report_id: "report_without_context", strategy_id: "quality_growth", strategy_name: "业绩成长", status: "completed", candidate_count: 1, research_status: "completed" },
    ]);
    fetchResult.mockResolvedValueOnce({
      report_id: "report_without_context",
      workflow_run_id: "run_without_context",
      strategy: { strategy_id: "quality_growth", name: "业绩成长", source: "builtin" },
      candidates: [{ instrument_id: "XSHG:600519", name: "贵州茅台", selection_reasons: [], risk_flags: [], data_quality: "available", rank: 1 }],
      opportunity_research: {
        status: "completed",
        candidate_count: 1,
        candidates: [{ instrument_id: "XSHG:600519", research_priority: "medium", supporting_evidence: [{ text: "现金流改善", claim_type: "fact", source_ids: ["src_1"] }] }],
      },
    });
    render(<OpportunityDiscovery client={makeClient()} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect((await screen.findAllByText("来源 1")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "来源 1" })).toBeNull();
    expect(fetchOpportunitySource).not.toHaveBeenCalled();
  });

  it("passes natural-language intent as user_question to the hidden workflow", async () => {
    const client = makeClient();
    render(<OpportunityDiscovery client={client} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    const input = await screen.findByPlaceholderText("例如：找经营稳健、估值不过高、走势没有明显转弱的股票");
    fireEvent.change(input, { target: { value: "找低波动且现金流稳健的股票" } });
    fireEvent.click(screen.getByRole("button", { name: "确认目标" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并开始" }));
    await waitFor(() => expect(client.runWorkflow).toHaveBeenCalledWith(
      "stock_research",
      expect.objectContaining({ user_question: "找低波动且现金流稳健的股票", research_limit: 1, strategy: expect.objectContaining({ research_limit: 1 }) }),
      "package://com.mona.a-share-team/workflows/stock-selection.json",
    ));
  });

  it("shows the hidden agent clarification instead of a generic missing-result error", async () => {
    let notify: ((chatId: string, run: unknown) => void) | undefined;
    const client = makeClient() as unknown as {
      onWorkflowRunUpdated: ReturnType<typeof vi.fn>;
    } & MonaClient;
    client.onWorkflowRunUpdated = vi.fn((handler) => {
      notify = handler;
      return () => undefined;
    });
    fetchResult.mockRejectedValueOnce(new Error("not found"));
    render(<OpportunityDiscovery client={client} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    await screen.findByText("说说你想找什么机会");
    await act(async () => {
      notify?.("stock_research", {
        id: "run_clarify",
        status: "succeeded",
        inputs: { mode: "stock_selection" },
        workflow: { steps: [{ id: "selection" }] },
        steps: { selection: { status: "succeeded", output: { summary: "请确认观察周期和估值上限。" } } },
      });
    });
    await waitFor(() => expect(fetchResult).toHaveBeenCalledWith("run_clarify"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("请确认观察周期和估值上限"));
  });

  it("disables a saved schedule before deleting a user strategy", async () => {
    fetchStrategies.mockResolvedValueOnce([
      { strategy_id: "my_strategy", name: "我的策略", source: "user", schedule: { mode: "daily_after_close", enabled: true } },
    ]);
    const client = makeClient();
    render(<OpportunityDiscovery client={client} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(deleteStrategy).toHaveBeenCalledWith("my_strategy"));
    expect(saveStrategy).toHaveBeenCalledWith(expect.objectContaining({
      strategy_id: "my_strategy",
      schedule: { mode: "manual", enabled: false, time: "15:30" },
    }));
    expect(client.syncStockScreenSchedule).toHaveBeenCalledWith(
      "stock_research",
      "my_strategy",
      { mode: "manual", enabled: false, time: "15:30" },
    );
  });

  it("includes edited advanced conditions in the workflow strategy input", async () => {
    const client = makeClient();
    render(<OpportunityDiscovery client={client} onAddWatchlist={vi.fn()} onDeepResearch={vi.fn()} />);
    fireEvent.click(await screen.findByText("业绩成长"));
    fireEvent.click(screen.getByRole("button", { name: "高级条件" }));
    fireEvent.click(screen.getByRole("button", { name: "添加条件" }));
    fireEvent.change(screen.getByRole("textbox", { name: "筛选比较值 1" }), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并开始" }));
    await waitFor(() => expect(client.runWorkflow).toHaveBeenCalledWith(
      "stock_research",
      expect.objectContaining({
        strategy: expect.objectContaining({
          filters: [expect.objectContaining({ field: "change_pct", op: ">=", value: 15 })],
        }),
      }),
      "package://com.mona.a-share-team/workflows/stock-selection.json",
    ));
  });
});
