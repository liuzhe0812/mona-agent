import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addStockWatchlist,
  fetchStockDashboard,
  fetchStockIntraday,
  fetchStockKline,
  fetchStockMaterials,
  fetchStockMaterialPage,
  createStockMaterialBinding,
  confirmStockMaterialBinding,
  fetchStockOutcomes,
  fetchStockDecisionConditions,
  fetchStockQuotes,
  fetchStockResearchContext,
  fetchStockDiagnoses,
  fetchStockDiagnosis,
  createStockDiagnosis,
  cancelStockDiagnosis,
  retryStockDiagnosis,
  fetchStockScreenHistory,
  fetchStockScreenOutcomes,
  fetchStockScreenResult,
  fetchStockOpportunitySource,
  fetchStockScreenStrategies,
  fetchStockScreenTemplates,
  compareStockScreenCandidates,
  saveStockScreenStrategy,
  fetchStockReport,
  fetchStockReports,
  fetchStockPortfolioContext,
  fetchStockRiskProfile,
  fetchStockWatchlist,
  importStockWatchlist,
  isStockReportV5Document,
  isStockReportV5Projection,
  isStockReportV6Document,
  isStockReportV6Projection,
  isStockViewPoint,
  openStockIntradayStream,
  removeStockWatchlist,
  refreshStockOutcomes,
  refreshStockScreenOutcomes,
  searchStocks,
  setStockWatchlistFocus,
  saveStockPortfolioContext,
  saveStockRiskProfile,
  deleteStockPortfolioContext,
  deleteStockRiskProfile,
  STOCK_ROOM_CHAT_ID,
  STOCK_DIAGNOSIS_ROOM_CHAT_ID,
  StockApiError,
  stockClaimText,
} from "@/lib/stock-api";
import type { StockHorizonCondition, StockReportV4Document } from "@/lib/stock-api";

const httpFetch = vi.fn();
const resetServicesHttpBase = vi.fn();

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isTauri: () => false,
    httpFetch: (...args: unknown[]) => httpFetch(...args),
  };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getServicesHttpBase: vi.fn().mockResolvedValue("http://services"),
    getApiBase: vi.fn().mockResolvedValue("http://ws"),
    resetServicesHttpBase: (...args: unknown[]) => resetServicesHttpBase(...args),
  };
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
  };
}

beforeEach(() => {
  httpFetch.mockReset();
  resetServicesHttpBase.mockReset();
});

describe("stock-api services routes", () => {
  it("keeps standard diagnosis routes and the single-agent room separate from deep research", async () => {
    expect(STOCK_DIAGNOSIS_ROOM_CHAT_ID).toBe("stock_ai_diagnosis");
    expect(STOCK_ROOM_CHAT_ID).toBe("stock_research");
    const run = { diagnosisId: "diagnosis_12345678", workflowId: "stock-ai-diagnosis", status: "succeeded", report: { schema_version: 1, kind: "ai_diagnosis" } };
    httpFetch
      .mockResolvedValueOnce(jsonResponse({ items: [run] }))
      .mockResolvedValueOnce(jsonResponse(run))
      .mockResolvedValueOnce(jsonResponse(run))
      .mockResolvedValueOnce(jsonResponse(run))
      .mockResolvedValueOnce(jsonResponse(run));
    await expect(fetchStockDiagnoses("XSHG:600519")).resolves.toEqual([run]);
    await expect(fetchStockDiagnosis(run.diagnosisId)).resolves.toEqual(run);
    await createStockDiagnosis("XSHG:600519", { execute: false });
    await cancelStockDiagnosis(run.diagnosisId);
    await retryStockDiagnosis(run.diagnosisId);
    expect(httpFetch).toHaveBeenNthCalledWith(1, "http://services/api/stock/diagnosis?instrumentId=XSHG%3A600519", expect.objectContaining({ method: "GET" }));
    expect(httpFetch).toHaveBeenNthCalledWith(3, "http://services/api/stock/diagnosis", expect.objectContaining({ method: "POST", body: expect.stringContaining('"execute":false') }));
    expect(httpFetch).toHaveBeenNthCalledWith(4, "http://services/api/stock/diagnosis/diagnosis_12345678/cancel", expect.objectContaining({ method: "POST" }));
    expect(httpFetch).toHaveBeenNthCalledWith(5, "http://services/api/stock/diagnosis/diagnosis_12345678/retry", expect.objectContaining({ method: "POST" }));
  });

  it("reads and saves the local risk profile through the real endpoints", async () => {
    const profileResponse = {
      profile: {
        profile_name: "conservative_default",
        configured: true,
        risk_level: "balanced",
        max_drawdown_tolerance_pct: 10,
        total_funds_range: "100k_500k",
        risk_budget_pct: 1,
        max_single_position_pct: 20,
        max_industry_exposure_pct: 30,
        max_correlated_exposure_pct: 50,
      },
      configured: true,
    };
    httpFetch
      .mockResolvedValueOnce(jsonResponse(profileResponse))
      .mockResolvedValueOnce(jsonResponse(profileResponse))
      .mockResolvedValueOnce(jsonResponse({ ...profileResponse, configured: false }));

    const loaded = await fetchStockRiskProfile();
    expect(loaded.profile.risk_level).toBe("balanced");
    expect(httpFetch).toHaveBeenLastCalledWith("http://services/api/stock/risk-profile", expect.objectContaining({ method: "GET" }));
    await saveStockRiskProfile({
      risk_level: "balanced",
      max_drawdown_tolerance_pct: 10,
      total_funds_range: "100k_500k",
      risk_budget_pct: 1,
      max_single_position_pct: 20,
      max_industry_exposure_pct: 30,
      max_correlated_exposure_pct: 50,
    });
    expect(httpFetch).toHaveBeenLastCalledWith("http://services/api/stock/risk-profile", expect.objectContaining({ method: "PUT", body: expect.stringContaining('"risk_level":"balanced"') }));
    await deleteStockRiskProfile();
    expect(httpFetch).toHaveBeenLastCalledWith("http://services/api/stock/risk-profile", expect.objectContaining({ method: "DELETE" }));
  });

  it("reads, saves and deletes the instrument portfolio context with an encoded id", async () => {
    const contextResponse = {
      instrumentId: "XSHE:002709",
      context: {
        holding_state: "holding",
        position_input_mode: "assets_shares",
        holding_quantity: 100,
        portfolio_value_yuan: 3520,
        current_position_pct: 10,
        industry_exposure_pct: 5,
        correlated_exposure_pct: 2,
        today_bought_quantity: 100,
        holding_cost: 35.2,
      },
      configured: true,
    };
    httpFetch
      .mockResolvedValueOnce(jsonResponse(contextResponse))
      .mockResolvedValueOnce(jsonResponse(contextResponse))
      .mockResolvedValueOnce(jsonResponse(contextResponse));
    const id = "XSHE:002709";
    const loaded = await fetchStockPortfolioContext(id);
    expect(loaded.context.today_bought_quantity).toBe(100);
    expect(loaded.context.position_input_mode).toBe("assets_shares");
    expect(loaded.context.holding_quantity).toBe(100);
    expect(loaded.context.portfolio_value_yuan).toBe(3520);
    expect(httpFetch).toHaveBeenLastCalledWith("http://services/api/stock/portfolio-context?instrumentId=XSHE%3A002709", expect.objectContaining({ method: "GET" }));
    await saveStockPortfolioContext(id, contextResponse.context);
    expect(httpFetch).toHaveBeenLastCalledWith("http://services/api/stock/portfolio-context?instrumentId=XSHE%3A002709", expect.objectContaining({ method: "PUT", body: expect.stringContaining('"position_input_mode":"assets_shares"') }));
    await deleteStockPortfolioContext(id);
    expect(httpFetch).toHaveBeenLastCalledWith("http://services/api/stock/portfolio-context?instrumentId=XSHE%3A002709", expect.objectContaining({ method: "DELETE" }));
  });

  it("fetches decision-condition evaluation with a safe camelCase shape", async () => {
    httpFetch.mockResolvedValue(jsonResponse({
      reportId: "report-4",
      evaluatedAt: "2026-08-22T10:00:00+08:00",
      methodVersion: "decision-conditions-v1",
      horizons: {
        mediumTerm: {
          conditions: [{
            group: "participation",
            groupLabel: "参与条件",
            text: "收盘价高于20日均线",
            sourceIds: ["source-1"],
            status: "matched",
            statusLabel: "已满足",
            evaluatedAt: "2026-08-22T10:00:00+08:00",
            methodVersion: "decision-conditions-v1",
            reason: "当前数据已满足条件",
            internal_field: "must-not-leak",
          }],
          riskReward: { status: "matched", statusLabel: "已满足", ratio: 1.8 },
        },
        unknownHorizon: { conditions: [{ text: "内部字段不应出现" }] },
      },
    }));

    const evaluation = await fetchStockDecisionConditions("token-1", "report-4");
    expect(httpFetch).toHaveBeenCalledWith(
      "http://services/api/stock/decision-conditions?reportId=report-4",
      expect.objectContaining({ method: "GET" }),
    );
    expect(evaluation.horizons.mediumTerm?.conditions[0]).toMatchObject({
      group: "participation",
      text: "收盘价高于20日均线",
      status: "matched",
      statusLabel: "已满足",
    });
    expect(evaluation.horizons.unknownHorizon).toBeUndefined();
    expect(JSON.stringify(evaluation)).not.toContain("must-not-leak");
  });

  it("surfaces decision-condition API errors", async () => {
    httpFetch.mockResolvedValue(jsonResponse({ error: { code: "report_not_found", message: "投研报告不存在" } }, false, 404));

    await expect(fetchStockDecisionConditions("token-1", "missing-report")).rejects.toMatchObject({
      code: "report_not_found",
      status: 404,
    });
  });

  it("fetches the watchlist via GET /api/stock/watchlist", async () => {
    httpFetch.mockResolvedValue(
      jsonResponse({
        items: [
          {
            symbol: "600519",
            exchange: "XSHG",
            name: "贵州茅台",
            instrumentType: "equity",
            focus: false,
            instrumentId: "XSHG:600519",
          },
        ],
      }),
    );
    const items = await fetchStockWatchlist();
    expect(httpFetch).toHaveBeenCalledWith(
      "http://services/api/stock/watchlist",
      expect.objectContaining({ method: "GET" }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].instrumentId).toBe("XSHG:600519");
  });

  it("adds a watchlist item with a camelCase JSON body", async () => {
    httpFetch.mockResolvedValue(jsonResponse({ items: [] }));
    await addStockWatchlist({
      symbol: "600519",
      exchange: "XSHG",
      name: "贵州茅台",
      instrumentType: "equity",
    });
    const [url, init] = httpFetch.mock.calls[0];
    expect(url).toBe("http://services/api/stock/watchlist");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      symbol: "600519",
      exchange: "XSHG",
      name: "贵州茅台",
      instrumentType: "equity",
    });
  });

  it("removes a watchlist item via DELETE with an id query", async () => {
    httpFetch.mockResolvedValue(jsonResponse({ items: [] }));
    await removeStockWatchlist("XSHG:600519");
    expect(httpFetch).toHaveBeenCalledWith(
      "http://services/api/stock/watchlist?id=XSHG%3A600519",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("toggles the focus marker via POST /api/stock/watchlist/focus", async () => {
    httpFetch.mockResolvedValue(
      jsonResponse({
        items: [
          {
            symbol: "600519",
            exchange: "XSHG",
            name: "贵州茅台",
            instrumentType: "equity",
            focus: true,
            instrumentId: "XSHG:600519",
          },
        ],
      }),
    );
    const items = await setStockWatchlistFocus("XSHG:600519", true);
    const [url, init] = httpFetch.mock.calls[0];
    expect(url).toBe("http://services/api/stock/watchlist/focus");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ id: "XSHG:600519", focus: true });
    expect(items[0].focus).toBe(true);
  });

  it("imports a watchlist from pasted text", async () => {
    httpFetch.mockResolvedValue(
      jsonResponse({ imported: 2, skipped: 1, errors: [], items: [] }),
    );
    const result = await importStockWatchlist("600519,贵州茅台\n000001,平安银行");
    const [url, init] = httpFetch.mock.calls[0];
    expect(url).toBe("http://services/api/stock/watchlist/import");
    expect(JSON.parse(init.body).text).toContain("600519");
    expect(result.imported).toBe(2);
  });

  it("searches instruments with the q query parameter", async () => {
    httpFetch.mockResolvedValue(
      jsonResponse({
        results: [
          {
            instrumentId: "XSHG:600519",
            symbol: "600519",
            exchange: "XSHG",
            name: "贵州茅台",
            instrumentType: "equity",
          },
        ],
      }),
    );
    const results = await searchStocks("茅台");
    expect(httpFetch).toHaveBeenCalledWith(
      "http://services/api/stock/search?q=%E8%8C%85%E5%8F%B0",
      expect.objectContaining({ method: "GET" }),
    );
    expect(results[0].instrumentId).toBe("XSHG:600519");
  });

  it("fetches batch quotes with comma-joined ids", async () => {
    httpFetch.mockResolvedValue(
      jsonResponse({
        quotes: [
          { instrumentId: "XSHG:600519", price: 1700.5, changePct: 1.2 },
          {
            instrumentId: "XSHE:000001",
            error: { code: "upstream_unavailable", message: "boom" },
          },
        ],
      }),
    );
    const quotes = await fetchStockQuotes(["XSHG:600519", "XSHE:000001"]);
    expect(httpFetch).toHaveBeenCalledWith(
      "http://services/api/stock/quote?ids=XSHG%3A600519%2CXSHE%3A000001",
      expect.objectContaining({ method: "GET" }),
    );
    expect(quotes[0].price).toBe(1700.5);
    expect(quotes[1].error?.code).toBe("upstream_unavailable");
  });

  it("restarts a dead services connection once before failing the quote refresh", async () => {
    httpFetch
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ quotes: [] }));

    await expect(fetchStockQuotes(["XSHG:600519"])).resolves.toEqual([]);
    expect(resetServicesHttpBase).toHaveBeenCalledTimes(1);
    expect(httpFetch).toHaveBeenCalledTimes(2);
  });

  it("fetches kline with id, limit and period", async () => {
    httpFetch.mockResolvedValue(
      jsonResponse({
        instrumentId: "XSHG:600519",
        instrumentType: "equity",
        bars: [],
        indicators: { ma: { ma5: [], ma20: [], ma60: [] } },
        source: { provider: "eastmoney", fetchedAt: "2026-08-14T15:00:00+08:00" },
      }),
    );
    await fetchStockKline("XSHG:600519", 60);
    expect(httpFetch).toHaveBeenCalledWith(
      "http://services/api/stock/kline?id=XSHG%3A600519&limit=60&klt=101",
      expect.objectContaining({ method: "GET" }),
    );
    await fetchStockKline("XSHG:600519", 60, 103);
    expect(httpFetch).toHaveBeenLastCalledWith(
      "http://services/api/stock/kline?id=XSHG%3A600519&limit=60&klt=103",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fetches intraday with the camelCase contract and forwards AbortSignal", async () => {
    const signal = new AbortController().signal;
    httpFetch.mockResolvedValue(
      jsonResponse({
        instrumentId: "XSHE:000001",
        instrumentType: "equity",
        tradingDate: "2026-08-18",
        previousClose: 10,
        status: "trading",
        asOf: "2026-08-18T09:30:00+08:00",
        source: {
          id: "src_abc",
          provider: "eastmoney",
          url: "https://example.test",
          publishedAt: null,
          fetchedAt: "2026-08-18T09:30:01+08:00",
          contentHash: "sha256:abc",
          fields: ["price"],
        },
        points: [
          {
            time: "2026-08-18T09:30:00+08:00",
            open: 10,
            high: 10.1,
            low: 10,
            close: 10.1,
            price: 10.1,
            average: 10.05,
            volume: 100,
            amount: 100500,
          },
        ],
        stale: false,
        quality: "complete",
        error: null,
      }),
    );
    const response = await fetchStockIntraday("XSHE:000001", signal);
    expect(httpFetch).toHaveBeenCalledWith(
      "http://services/api/stock/intraday?id=XSHE%3A000001",
      expect.objectContaining({ method: "GET", signal }),
    );
    expect(response.previousClose).toBe(10);
    expect(response.points[0].amount).toBe(100500);
    expect(response.source.provider).toBe("eastmoney");
  });

  it("opens an injectable intraday SSE stream and closes it", async () => {
    class FakeEventSource {
      listeners = new Map<string, Array<(event: Event) => void>>();
      close = vi.fn();

      addEventListener(type: string, listener: (event: Event) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      removeEventListener(type: string, listener: (event: Event) => void) {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
      }

      emit(type: string, payload: unknown) {
        const event = { data: JSON.stringify(payload) } as MessageEvent<string>;
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    const source = new FakeEventSource();
    const onSnapshot = vi.fn();
    const stream = await openStockIntradayStream(
      "XSHE:000001",
      { onSnapshot },
      { eventSourceFactory: vi.fn(() => source) },
    );
    expect(source.listeners.has("snapshot")).toBe(true);
    source.emit("snapshot", { instrumentId: "XSHE:000001", points: [] });
    expect(onSnapshot).toHaveBeenCalledWith({ instrumentId: "XSHE:000001", points: [] });
    stream.close();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("fetches current fundamentals and news for the selected instrument", async () => {
    httpFetch.mockResolvedValue(
      jsonResponse({
        instrumentId: "XSHG:600519",
        instrumentType: "equity",
        fundamentals: { status: "available", data: null, error: null },
        news: { status: "available", items: [], error: null },
      }),
    );
    const context = await fetchStockResearchContext("XSHG:600519");
    expect(httpFetch).toHaveBeenCalledWith(
      "http://services/api/stock/research-context?id=XSHG%3A600519",
      expect.objectContaining({ method: "GET" }),
    );
    expect(context.fundamentals.status).toBe("available");
  });

  it("loads PDF evidence, preserves binding labels, and previews an extracted page", async () => {
    httpFetch.mockResolvedValueOnce(jsonResponse({
      instrumentId: "XSHG:600519",
      materials: [{
        materialId: "material_1",
        materialName: "贵州茅台半年报.pdf",
        extractionStatus: "已完成",
        extractionStatusCode: "ready",
        pageCount: 12,
        bindings: [{
          bindingId: "binding_1",
          status: "已确认",
          statusCode: "confirmed",
          reportPeriod: "2026-06-30",
          firstPublishedAt: "2026-08-20T18:00:00+08:00",
          publisher: "贵州茅台股份有限公司",
          pages: [1, 4],
          confirmedFacts: [{
            metricName: "营业收入",
            valueText: "100",
            unit: "亿元",
            page: 1,
            excerpt: "营业收入 100 亿元。",
          }],
          confirmedAt: "2026-08-21T09:00:00+08:00",
          invalidationReason: null,
        }],
      }],
    }));
    const materials = await fetchStockMaterials("XSHG:600519");
    expect(httpFetch).toHaveBeenLastCalledWith(
      "http://services/api/stock/materials?instrumentId=XSHG%3A600519",
      expect.objectContaining({ method: "GET" }),
    );
    expect(materials.materials[0]).toMatchObject({
      material_id: "material_1",
      material_name: "贵州茅台半年报.pdf",
      page_count: 12,
    });
    expect(materials.materials[0].bindings[0]).toMatchObject({
      binding_id: "binding_1",
      status: "已确认",
      status_code: "confirmed",
      first_published_at: "2026-08-20T18:00:00+08:00",
      publisher: "贵州茅台股份有限公司",
    });
    expect(materials.materials[0].bindings[0].confirmed_facts).toEqual([{
      metric_name: "营业收入",
      value_text: "100",
      unit: "亿元",
      page: 1,
      excerpt: "营业收入 100 亿元。",
    }]);

    httpFetch.mockResolvedValueOnce(jsonResponse({
      binding: {
        bindingId: "binding_2",
        status: { pending: "待用户确认", confirmed: "已确认", invalidated: "已失效" },
        statusCode: "pending",
        reportPeriod: "2026-06-30",
        firstPublishedAt: "2026-08-20T18:00:00+08:00",
        publisher: "贵州茅台股份有限公司",
        pages: [2],
      },
    }, true, 201));
    const created = await createStockMaterialBinding({
      instrument_id: "XSHG:600519",
      material_id: "material_1",
      report_period: "2026-06-30",
      first_published_at: "2026-08-20T18:00:00+08:00",
      publisher: "贵州茅台股份有限公司",
      pages: [2],
    });
    expect(created).toMatchObject({ binding_id: "binding_2", status: "待用户确认", status_code: "pending" });

    httpFetch.mockResolvedValueOnce(jsonResponse({
      binding: {
        bindingId: "binding_2",
        status: { pending: "待用户确认", confirmed: "已确认", invalidated: "已失效" },
        statusCode: "confirmed",
        pages: [2],
      },
    }));
    const confirmed = await confirmStockMaterialBinding("binding_2", [{
      metric: "revenue",
      value_text: "100",
      unit: "hundred_million_yuan",
      page: 2,
      excerpt: "营业收入 100 亿元。",
    }]);
    expect(confirmed).toMatchObject({ binding_id: "binding_2", status: "已确认", status_code: "confirmed" });
    expect(JSON.parse(httpFetch.mock.calls[2][1].body as string)).toEqual({
      bindingId: "binding_2",
      confirmedFacts: [{
        metric: "revenue",
        valueText: "100",
        unit: "hundred_million_yuan",
        page: 2,
        excerpt: "营业收入 100 亿元。",
      }],
    });

    httpFetch.mockResolvedValueOnce(jsonResponse({
      materialName: "贵州茅台半年报.pdf",
      page: 2,
      text: "第二页财报原文",
    }));
    await expect(fetchStockMaterialPage("material_1", 2)).resolves.toEqual({
      material_name: "贵州茅台半年报.pdf",
      page: 2,
      page_count: null,
      text: "第二页财报原文",
    });
    expect(httpFetch).toHaveBeenLastCalledWith(
      "http://services/api/stock/materials/preview?materialId=material_1&page=2",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reads local outcome records with GET and refreshes only with an explicit POST", async () => {
    const payload = { reportId: "report-4", observations: [], pending: [] };
    httpFetch.mockResolvedValue(jsonResponse(payload));
    await fetchStockOutcomes("report-4");
    expect(httpFetch).toHaveBeenLastCalledWith(
      "http://services/api/stock/outcomes?reportId=report-4",
      expect.objectContaining({ method: "GET" }),
    );

    await refreshStockOutcomes("report-4");
    const [url, init] = httpFetch.mock.calls[1];
    expect(url).toBe("http://services/api/stock/outcomes/refresh");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ reportId: "report-4" });
  });

  it("normalizes selection outcome payloads and keeps refresh explicit", async () => {
    httpFetch.mockResolvedValueOnce(jsonResponse({
      runId: "run_selection",
      reportId: "report_selection",
      observations: [{
        selectionTrackingId: "tracking_internal",
        reportId: "report_selection",
        workflowRunId: "run_selection",
        instrumentId: "XSHG:600519",
        rank: 1,
        name: "贵州茅台",
        window: 20,
        status: "complete",
        statusLabel: "数据完整",
        dataStatus: "available",
        dataStatusLabel: "可计算",
        entryDate: "2026-08-20",
        exitDate: "2026-09-18",
        targetReturnPct: 4.25,
        benchmarkReturnPct: 1.5,
        relativeReturnPct: 2.75,
      }],
      pending: [],
      summary: {
        candidateCount: 1,
        totalWindowCount: 3,
        matureWindowCount: 2,
        sampleCount: 1,
        dataCompletenessPct: 50,
        windows: [{ window: 20, sampleCount: 1, matureWindowCount: 1, completeCount: 1, incompleteCount: 0, pendingCount: 0, totalWindowCount: 1, dataCompletenessPct: 100 }],
        note: "选股是候选排序，不计算方向胜率。",
      },
      publicMarketBenchmark: { name: "中证全指", instrumentId: "XSHG:000985", instrumentType: "index" },
      updated: false,
      appendCount: 0,
    }));
    const local = await fetchStockScreenOutcomes("run_selection");
    expect(httpFetch).toHaveBeenCalledWith(
      "http://services/api/stock/screen/outcomes?runId=run_selection",
      expect.objectContaining({ method: "GET" }),
    );
    expect(local.report_id).toBe("report_selection");
    expect(local.observations[0]).toMatchObject({
      instrument_id: "XSHG:600519",
      window: 20,
      target_return_pct: 4.25,
      benchmark_return_pct: 1.5,
      relative_return_pct: 2.75,
    });
    expect(local.summary.data_completeness_pct).toBe(50);
    expect(local.public_market_benchmark.instrument_id).toBe("XSHG:000985");

    httpFetch.mockResolvedValueOnce(jsonResponse({ runId: "run_selection", reportId: "report_selection", observations: [], pending: [], summary: {}, publicMarketBenchmark: { name: "中证全指", instrumentId: "XSHG:000985", instrumentType: "index" }, updated: true, appendCount: 1 }));
    await refreshStockScreenOutcomes("run_selection");
    const [url, init] = httpFetch.mock.calls[1];
    expect(url).toBe("http://services/api/stock/screen/outcomes/refresh");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ runId: "run_selection" });
  });

  it("raises StockApiError with the server code and message", async () => {
    httpFetch.mockResolvedValue(
      jsonResponse(
        { error: { code: "watchlist_corrupt", message: "file broken" } },
        false,
        500,
      ),
    );
    await expect(fetchStockWatchlist()).rejects.toMatchObject({
      name: "StockApiError",
      code: "watchlist_corrupt",
      message: "file broken",
    });
    await expect(fetchStockWatchlist()).rejects.toBeInstanceOf(StockApiError);
  });
});

describe("stock-api report routes (WS port, bearer token)", () => {
  it("guards the public V6 detail and list contracts", () => {
    const horizon = (direction: "positive" | "neutral" | "negative" | "avoid", action: "wait" | "avoid") => ({
      direction,
      action,
      thesis: "结构化研究结论",
      keyReasons: ["研究理由"],
      keyRisks: ["研究风险"],
      researchStatus: "ready" as const,
      tradeStatus: "unavailable" as const,
      materializedPlan: null,
    });
    const detail = {
      schemaVersion: 6,
      resultStatus: "completed",
      reportId: "report-v6",
      runId: "run-v6",
      kind: "deep_research",
      instrument: { instrumentId: "XSHE:002709", symbol: "002709", exchange: "XSHE", name: "天赐材料", instrumentType: "equity" },
      decisionMode: "research_only",
      researchStatus: "ready",
      tradeStatus: "unavailable",
      summary: "三周期研究结论",
      researchCutoffAt: "2026-08-21T15:00:00+08:00",
      marketAsOf: "2026-08-21T15:00:00+08:00",
      generatedAt: "2026-08-21T15:05:00+08:00",
      horizonDecisions: {
        shortTerm: horizon("positive", "wait"),
        mediumTerm: horizon("neutral", "wait"),
        longTerm: horizon("avoid", "avoid"),
      },
    };
    const projection = {
      schemaVersion: 6,
      resultStatus: "completed",
      decisionMode: "research_only",
      researchStatus: "ready",
      tradeStatus: "unavailable",
      horizonDecisions: {
        shortTerm: { direction: "positive", action: "wait", researchStatus: "ready", tradeStatus: "unavailable" },
        mediumTerm: { direction: "neutral", action: "wait", researchStatus: "ready", tradeStatus: "unavailable" },
        longTerm: { direction: "avoid", action: "avoid", researchStatus: "ready", tradeStatus: "unavailable" },
      },
      researchCutoffAt: detail.researchCutoffAt,
      marketAsOf: detail.marketAsOf,
      stance: null,
      dataQuality: null,
    };
    expect(isStockReportV6Document(detail)).toBe(true);
    expect(isStockReportV6Projection(projection)).toBe(true);
    expect(isStockReportV6Document({ ...detail, decisionMode: "bad" })).toBe(false);
    expect(isStockReportV6Projection({ ...projection, horizonDecisions: { ...projection.horizonDecisions, shortTerm: { ...projection.horizonDecisions.shortTerm, direction: "bullish" } } })).toBe(false);
  });

  const v5Horizon = (direction: "positive" | "neutral" | "negative", action: "conditional_participation" | "wait" | "hold" | "reduce", expired = false) => ({
    direction,
    action,
    thesis: "确定性交易计划",
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
    positionPlan: { riskBudgetPct: 1, initialPositionPct: 10, maxPositionPct: 20, stopDistancePct: 4 },
    validUntil: "2026-09-01T15:00:00+08:00",
    reviewTrigger: "跌破止损参考后重新评估",
    keyReasons: ["趋势保持完整"],
    keyRisks: ["行业需求变化"],
    evidenceStrength: "strong",
    marketAsOf: "2026-08-21T15:00:00+08:00",
    generatedAt: "2026-08-21T15:05:00+08:00",
    isExpired: expired,
  });
  const v5Detail = {
    schemaVersion: 5,
    resultStatus: "completed",
    reportId: "report-v5",
    runId: "run-v5",
    kind: "deep_research",
    instrument: { instrumentId: "XSHE:000001", symbol: "000001", exchange: "XSHE", name: "平安银行", instrumentType: "equity" },
    summary: "三周期交易计划",
    researchCutoffAt: "2026-08-21T15:00:00+08:00",
    marketAsOf: "2026-08-21T15:00:00+08:00",
    generatedAt: "2026-08-21T15:05:00+08:00",
    isExpired: false,
    hasExpiredHorizon: false,
    horizonDecisions: {
      shortTerm: v5Horizon("positive", "conditional_participation"),
      mediumTerm: v5Horizon("neutral", "wait"),
      longTerm: v5Horizon("negative", "reduce"),
    },
  };

  it("parses the public V5 camelCase projection and detail without decisionPlan", async () => {
    const projection = {
      reportId: "report-v5",
      runId: "run-v5",
      kind: "deep_research" as const,
      instrument: v5Detail.instrument,
      symbols: ["XSHE:000001"],
      asOf: v5Detail.marketAsOf,
      modifiedAt: "2026-08-21T15:05:00+08:00",
      schemaVersion: 5 as const,
      resultStatus: "completed" as const,
      horizonDecisions: {
        shortTerm: { direction: "positive" as const, action: "conditional_participation" as const, validUntil: "2026-09-01T15:00:00+08:00", isExpired: false },
        mediumTerm: { direction: "neutral" as const, action: "wait" as const, validUntil: "2026-10-01T15:00:00+08:00", isExpired: false },
        longTerm: { direction: "negative" as const, action: "reduce" as const, validUntil: "2027-01-01T15:00:00+08:00", isExpired: false },
      },
      researchCutoffAt: v5Detail.researchCutoffAt,
      marketAsOf: v5Detail.marketAsOf,
      generatedAt: v5Detail.generatedAt,
      isExpired: false,
      hasExpiredHorizon: false,
      stance: null,
      dataQuality: null,
    };
    expect(isStockReportV5Projection(projection)).toBe(true);
    expect(isStockReportV5Projection({ ...projection, horizonDecisions: undefined })).toBe(false);
    expect(isStockReportV5Projection({
      ...projection,
      horizonDecisions: { ...projection.horizonDecisions, shortTerm: { ...projection.horizonDecisions.shortTerm, direction: "bullish" } },
    })).toBe(false);
    expect(isStockReportV5Document({
      ...v5Detail,
      horizonDecisions: {
        ...v5Detail.horizonDecisions,
        shortTerm: { ...v5Detail.horizonDecisions.shortTerm, tradingPlan: { ...v5Detail.horizonDecisions.shortTerm.tradingPlan, referenceBuyLow: Number.NaN } },
      },
    })).toBe(false);
    expect(isStockReportV5Document({
      ...v5Detail,
      horizonDecisions: {
        ...v5Detail.horizonDecisions,
        mediumTerm: { ...v5Detail.horizonDecisions.mediumTerm, action: "bullish" },
      },
    })).toBe(false);
    expect(isStockReportV5Document({
      ...v5Detail,
      horizonDecisions: {
        ...v5Detail.horizonDecisions,
        longTerm: { ...v5Detail.horizonDecisions.longTerm, action: "hold", holdingAction: "hold" },
      },
    })).toBe(false);
    expect(isStockReportV5Document({
      ...v5Detail,
      horizonDecisions: {
        ...v5Detail.horizonDecisions,
        longTerm: { ...v5Detail.horizonDecisions.longTerm, tradingPlan: { ...v5Detail.horizonDecisions.longTerm.tradingPlan, currency: "CNY" } },
      },
    })).toBe(false);
    httpFetch
      .mockResolvedValueOnce(jsonResponse({ reports: [projection] }))
      .mockResolvedValueOnce(jsonResponse({ report: v5Detail, markdown: "# V5" }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ instrumentId: "XSHE:000001", name: "平安银行", instrumentType: "equity", focus: true, latest: projection }] }));

    const [listed] = await fetchStockReports("tok");
    expect(listed.schemaVersion).toBe(5);
    if (listed.schemaVersion === 5) {
      expect(listed.horizonDecisions.shortTerm.action).toBe("conditional_participation");
      expect(listed.horizonDecisions.longTerm.direction).toBe("negative");
    }
    const detail = await fetchStockReport("tok", "report-v5");
    expect(isStockReportV5Document(detail.report)).toBe(true);
    if (isStockReportV5Document(detail.report)) {
      expect(detail.report.horizonDecisions.shortTerm.tradingPlan.referenceBuyLow).toBe(36.8);
      expect(detail.report.horizonDecisions.mediumTerm.positionPlan.maxPositionPct).toBe(20);
      expect((detail.report as Record<string, unknown>).decisionPlan).toBeUndefined();
    }
    const [dashboard] = await fetchStockDashboard("tok");
    expect(dashboard.latest?.schemaVersion).toBe(5);
  });

  it("keeps optional P6 horizon condition fields and legacy omissions", async () => {
    const legacyCondition: StockHorizonCondition = {
      kind: "manual",
      text: "观察条件",
      source_ids: ["src-legacy-condition"],
    };
    const stopCondition: StockHorizonCondition = {
      kind: "trigger",
      text: "跌破止损参考",
      claim_type: "fact",
      observed_metric_ref: "quote.close",
      operator: "lte",
      threshold_metric_ref: "valuation.stop_loss_reference",
      source_ids: ["src-stop"],
    };
    const takeCondition: StockHorizonCondition = {
      kind: "manual",
      text: "达到止盈参考",
      claim_type: "inference",
      source_ids: ["src-take"],
    };
    httpFetch.mockResolvedValueOnce(jsonResponse({
      report: {
        schema_version: 4,
        horizon_views: {
          short_term: {
            participation_conditions: [legacyCondition],
            stop_loss_conditions: [stopCondition],
            take_profit_conditions: [takeCondition],
          },
        },
      },
      markdown: "",
    }));

    const result = await fetchStockReport("tok", "report-p6");
    if (result.report.schema_version === 4) {
      expect(result.report.horizon_views.short_term.participation_conditions[0].claim_type).toBeUndefined();
      expect(result.report.horizon_views.short_term.stop_loss_conditions?.[0]).toEqual(stopCondition);
      expect(result.report.horizon_views.short_term.take_profit_conditions?.[0]).toEqual(takeCondition);
      expect(result.report.horizon_views.medium_term).toBeUndefined();
    }
  });

  it("lists reports with the bearer token", async () => {
    httpFetch.mockResolvedValue(jsonResponse({ reports: [] }));
    await fetchStockReports("tok");
    expect(httpFetch).toHaveBeenCalledWith(
      "http://ws/api/stock/reports",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("fetches one report detail by id", async () => {
    httpFetch.mockResolvedValue(
      jsonResponse({ report: { report_id: "r1" }, markdown: "# 报告" }),
    );
    const detail = await fetchStockReport("tok", "stock_report_abc");
    expect(httpFetch).toHaveBeenCalledWith(
      "http://ws/api/stock/reports/stock_report_abc",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
    expect(detail.markdown).toBe("# 报告");
  });

  it("passes V4 projections and raw detail fields through without synthesis", async () => {
    const projection = {
      reportId: "stock_report_v4",
      runId: "run_v4",
      kind: "deep_research" as const,
      instrument: {
        instrumentId: "XSHG:600519",
        symbol: "600519",
        exchange: "XSHG",
        name: "贵州茅台",
        instrumentType: "equity" as const,
      },
      symbols: ["XSHG:600519"],
      asOf: "2026-08-18T15:00:00+08:00",
      modifiedAt: "2026-08-18T15:01:00+08:00",
      schemaVersion: 4 as const,
      horizonStances: {
        shortTerm: { stance: "positive" as const, status: "available" as const },
        mediumTerm: { stance: "neutral" as const, status: "available" as const },
        longTerm: { stance: "negative" as const, status: "insufficient_data" as const },
      },
      researchCutoffAt: "2026-08-18T15:01:00+08:00",
      marketAsOf: "2026-08-18T15:00:00+08:00",
      evidenceCoverage: {
        short_term: { status: "available" as const },
        medium_term: { status: "degraded" as const },
        long_term: { status: "insufficient_data" as const },
      },
      stance: null,
      dataQuality: null,
    };
    const quantValidation: NonNullable<StockReportV4Document["quant_validation"]> = {
      selection_run_id: "run_selection",
      report_id: "stock_report_v4",
      strategy_id: "quality_growth",
      as_of: "2026-08-18T15:00:00+08:00",
      factor_algorithm_version: "screening-factor-v1",
      rank_algorithm_version: "percentile-rank-v1",
      validation_status: "uncalibrated",
      quant_signal: "insufficient_data",
      horizons: {
        short_term: {
          status: "uncalibrated",
          signal: "insufficient_data",
          factor_observations: [{
            field: "momentum20",
            raw_value: 4.2,
            percentile_or_rank: 0.8,
            direction: "desc",
            scope: "market",
            sample_count: 100,
            missing_count: 0,
            as_of: "2026-08-18T15:00:00+08:00",
            source_ids: ["src-v4"],
            method_version: "percentile-rank-v1",
            validation_status: "uncalibrated",
          }],
        },
        medium_term: { status: "insufficient_data", signal: "insufficient_data", factor_observations: [] },
        long_term: { status: "insufficient_data", signal: "insufficient_data", factor_observations: [] },
      },
      source_ids: ["src-v4"],
      snapshot_hash: "sha256:quant-v4",
      reason: "量化因子尚未经过历史校准",
    };
    const rawV4 = {
      schema_version: 4,
      report_id: "stock_report_v4",
      kind: "deep_research",
      instrument: { symbol: "600519", exchange: "XSHG", name: "贵州茅台", instrument_type: "equity" },
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
        selection_reasons: ["经营质量改善"],
        why_now: "现金流改善，值得继续研究",
        research_priority: "high",
        focus_questions: ["下一期现金流"],
        source_count: 3,
        selection_as_of: "2026-08-18T15:00:00+08:00",
        usage_note: "这是选股阶段的先验线索，不是深度投研事实；必须使用本次投研证据重新核验。",
      },
      quant_validation: quantValidation,
      research_cutoff_at: projection.researchCutoffAt,
      market_as_of: projection.marketAsOf,
      horizon_views: { short_term: { stance: "positive", status: "available" } },
      dimension_views: {
        market_environment: {
          status: "available",
          summary: "市场环境",
          points: [],
          missing_fields: [],
          source_ids: [],
          market_breadth: {
            status: "available",
            member_count: 4,
            available_change_count: 4,
            advancing: 2,
            declining: 1,
            unchanged: 1,
            suspended: 0,
            advance_ratio: 0.5,
            turnover_amount: 123456789,
            observed_at: "2026-08-18T15:00:00+08:00",
            method: "market-breadth-v1",
            coverage: { complete: true, loaded_count: 4, expected_count: 4, coverage: 1 },
            missing_fields: [],
          },
        },
        capital_positioning: {
          status: "available",
          summary: "资金与筹码",
          points: [],
          missing_fields: [],
          source_ids: [],
          public_activity: {
            status: "available",
            turnover: 987654,
            turnover_rate: 2.5,
            volume: 12345,
            price_change_pct: 3.45,
            volume_change_pct_5d: -12.5,
            observed_at: "2026-08-18T15:00:00+08:00",
            method: "public-capital-signals-v1",
            disclosure_signals: [{ event_type: "share_unlock", event_date: "2026-08-20", title: "解禁公告", source_ids: ["src-v4"] }],
            missing_fields: [],
          },
        },
      },
      cycle_states: { policy: { status: "missing" } },
      scenario_sets: { short_term: { base: { summary: "观察", conditions: [], outcome_direction: "neutral", risks: [], source_ids: [] } } },
      cross_horizon_conflict: { status: "mixed", explanation: "周期不一致", source_ids: [] },
      evidence_coverage: projection.evidenceCoverage,
      outcome_tracking_id: "stock_outcome_v4",
      risks: [{ claim: "结构化风险", claim_type: "fact", source_ids: ["src-v4"] }],
      catalysts: [],
      open_questions: [],
      sources: [{
        id: "src-v4",
        provider: "eastmoney",
        url: "https://example.test/source",
        published_at: "2026-08-18T10:00:00+08:00",
        period_end: "2026-06-30",
        fetched_at: "2026-08-18T10:01:00+08:00",
        content_hash: "sha256:test",
        fields: ["close"],
      }],
    };
    httpFetch
      .mockResolvedValueOnce(jsonResponse({ reports: [projection] }))
      .mockResolvedValueOnce(jsonResponse({ report: rawV4, markdown: "# V4" }))
      .mockResolvedValueOnce(jsonResponse({ items: [{
        instrumentId: "XSHG:600519",
        name: "贵州茅台",
        instrumentType: "equity",
        focus: false,
        latest: projection,
      }] }));

    const [listed] = await fetchStockReports("tok");
    expect(listed).toEqual(projection);
    if (listed.schemaVersion === 4) {
      expect(listed.horizonStances.shortTerm.stance).toBe("positive");
      expect(listed.researchCutoffAt).toBe(projection.researchCutoffAt);
      expect(listed.stance).toBeNull();
      expect(listed.dataQuality).toBeNull();
    }

    const detail = await fetchStockReport("tok", "stock_report_v4");
    expect(detail.report.schema_version).toBe(4);
    if (detail.report.schema_version === 4) {
      expect(detail.report.horizon_views.short_term.stance).toBe("positive");
      expect(detail.report.research_cutoff_at).toBe(projection.researchCutoffAt);
      expect(detail.report.outcome_tracking_id).toBe("stock_outcome_v4");
      expect(detail.report.selection_origin?.selection_report_id).toBe("selection_report");
      expect(detail.report.selection_origin?.strategy_horizon).toBe("medium_term");
      expect(detail.report.risks?.[0].claim_type).toBe("fact");
      expect(detail.report.sources?.[0].period_end).toBe("2026-06-30");
      expect(detail.report.dimension_views?.market_environment.market_breadth?.turnover_amount).toBe(123456789);
      expect(detail.report.dimension_views?.capital_positioning.public_activity?.disclosure_signals?.[0].event_type).toBe("share_unlock");
      expect(detail.report.quant_validation?.validation_status).toBe("uncalibrated");
      expect(detail.report.quant_validation?.quant_signal).toBe("insufficient_data");
      expect(detail.report.quant_validation?.horizons.short_term.factor_observations[0].field).toBe("momentum20");
      expect(detail.report.quant_validation?.snapshot_hash).toBe("sha256:quant-v4");
    }

    const [dashboard] = await fetchStockDashboard("tok");
    expect(dashboard.latest?.schemaVersion).toBe(4);
    expect(dashboard.latest?.stance).toBeNull();
    expect(dashboard.latest?.dataQuality).toBeNull();

    const { quant_validation: _quantValidation, ...legacyV4 } = rawV4;
    httpFetch.mockResolvedValueOnce(jsonResponse({ report: legacyV4, markdown: "# old V4" }));
    const oldDetail = await fetchStockReport("tok", "stock_report_v4_old");
    expect(oldDetail.report.schema_version).toBe(4);
    if (oldDetail.report.schema_version === 4) {
      expect(oldDetail.report.quant_validation).toBeUndefined();
    }
  });

  it("guards and renders V3 string versus V4 structured claims without conversion", () => {
    expect(stockClaimText("V3 风险")).toBe("V3 风险");
    const claim = { claim: "V4 风险", claim_type: "fact" as const, source_ids: ["src-v4"] };
    expect(isStockViewPoint(claim)).toBe(true);
    expect(stockClaimText(claim)).toBe("V4 风险");
    expect(isStockViewPoint("V3 风险")).toBe(false);
  });

  it("fetches the dashboard aggregate", async () => {
    httpFetch.mockResolvedValue(
      jsonResponse({
        items: [
          { instrumentId: "XSHG:600519", name: "贵州茅台", focus: false, latest: null },
        ],
      }),
    );
    const items = await fetchStockDashboard("tok");
    expect(httpFetch).toHaveBeenCalledWith(
      "http://ws/api/stock/dashboard",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
    expect(items[0].instrumentId).toBe("XSHG:600519");
  });
});

describe("stock-api opportunity discovery routes", () => {
  it("reads one cited opportunity source with the run and context ownership keys", async () => {
    httpFetch.mockResolvedValueOnce(jsonResponse({
      id: "src_1",
      provider: "eastmoney",
      url: "https://example.test/source",
      publishedAt: "2026-08-18T10:00:00+08:00",
      fetchedAt: "2026-08-18T10:01:00+08:00",
      contentHash: "sha256:test",
    }));
    const source = await fetchStockOpportunitySource("run_1", "ctx_abcdefghijkl", "src_1");
    expect(httpFetch).toHaveBeenCalledWith(
      "http://services/api/stock/screen/opportunity/source?runId=run_1&contextId=ctx_abcdefghijkl&sourceId=src_1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(source).toMatchObject({ id: "src_1", provider: "eastmoney", published_at: "2026-08-18T10:00:00+08:00", content_hash: "sha256:test" });
  });

  it("reads templates, strategies, history and a report from the services port", async () => {
    httpFetch
      .mockResolvedValueOnce(jsonResponse({ templates: [{ strategyId: "quality_growth", name: "业绩成长", unavailableReason: null, researchLimit: 6 }] }))
      .mockResolvedValueOnce(jsonResponse({ strategies: [] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ workflowRunId: "run_history", strategy: { strategyId: "quality_growth", name: "业绩成长" }, status: "completed", candidateCount: 1, researchStatus: "completed" }] }))
      .mockResolvedValueOnce(jsonResponse({ reportId: "r1", workflowRunId: "run1", strategy: { strategyId: "quality_growth", name: "业绩成长", source: "builtin", researchLimit: 6 }, dataQuality: { status: "available" }, candidates: [{ instrumentId: "XSHG:600519", name: "贵州茅台", selectionReasons: ["quality"], riskFlags: [], dataQuality: "available", snapshot: { price: 1700.5 } }], opportunityResearch: { status: "completed", candidateCount: 1, candidates: [{ instrumentId: "XSHG:600519", researchPriority: "high", whyNow: { text: "现金流改善", claimType: "inference", sourceIds: ["src-1"] }, dataGaps: ["机构预期缺失"] }] } }));
    expect((await fetchStockScreenTemplates())[0]).toMatchObject({ strategy_id: "quality_growth", research_limit: 6 });
    expect(await fetchStockScreenStrategies()).toEqual([]);
    expect((await fetchStockScreenHistory())[0]).toMatchObject({ run_id: "run_history", strategy_id: "quality_growth", candidate_count: 1, research_status: "completed" });
    const result = await fetchStockScreenResult("run1");
    expect(result.workflow_run_id).toBe("run1");
    expect(result.strategy.research_limit).toBe(6);
    expect(result.candidates[0].instrument_id).toBe("XSHG:600519");
    expect(result.opportunity_research?.candidates?.[0]?.why_now).toMatchObject({ text: "现金流改善", claim_type: "inference", source_ids: ["src-1"] });
    expect(httpFetch.mock.calls.map((call) => call[0])).toEqual([
      "http://services/api/stock/screen/templates",
      "http://services/api/stock/screen/strategies",
      "http://services/api/stock/screen/history",
      "http://services/api/stock/screen/results?runId=run1",
    ]);
  });

  it("normalizes nested valuation context aliases in a screening result", async () => {
    httpFetch.mockResolvedValueOnce(jsonResponse({
      reportId: "report_valuation",
      workflowRunId: "run_valuation",
      strategy: { strategyId: "quality_growth", name: "业绩成长", source: "builtin" },
      candidates: [{
        instrumentId: "XSHG:600519",
        name: "贵州茅台",
        selectionReasons: [],
        riskFlags: [],
        dataQuality: "available",
        valuationContext: {
          status: "complete",
          asOf: "2026-08-19T15:00:00+08:00",
          comparisonScope: "same_industry_current_snapshot",
          basis: "同一行业当前快照中除目标公司外的正值样本用于比较",
          currentPe: 20,
          currentPb: 5,
          pe: { value: 20, peerCount: 2, median: 20, percentile: 0 },
          pb: { value: 5, peerCount: 2, median: 2.5, percentile: 1 },
          missingFields: [],
        },
      }],
    }));

    const result = await fetchStockScreenResult("run_valuation");
    const valuation = result.candidates[0].valuation_context;
    expect(valuation).toEqual({
      status: "complete",
      as_of: "2026-08-19T15:00:00+08:00",
      comparison_scope: "same_industry_current_snapshot",
      basis: "同一行业当前快照中除目标公司外的正值样本用于比较",
      current_pe: 20,
      current_pb: 5,
      pe: { value: 20, peer_count: 2, median: 20, percentile: 0 },
      pb: { value: 5, peer_count: 2, median: 2.5, percentile: 1 },
      missing_fields: [],
    });
    expect((valuation as Record<string, unknown>).valuationContext).toBeUndefined();
  });

  it("normalizes quantitative snapshot and three-horizon observation aliases", async () => {
    httpFetch.mockResolvedValueOnce(jsonResponse({
      reportId: "report_quant",
      workflowRunId: "run_quant",
      strategy: { strategyId: "quality_growth", name: "业绩成长", source: "builtin" },
      quantSnapshot: {
        schemaVersion: 1,
        asOf: "2026-08-19T15:00:00+08:00",
        validationStatus: "uncalibrated",
        universe: { enrichedCount: 4, unprocessedAfterCap: 2 },
        dataQuality: { pointInTime: { status: "verified" } },
      },
      candidates: [{
        instrumentId: "XSHG:600519",
        name: "贵州茅台",
        selectionReasons: [],
        riskFlags: [],
        dataQuality: "available",
        quantValidation: {
          validationStatus: "uncalibrated",
          quantSignal: "insufficient_data",
          horizons: {
            short_term: {
              validationStatus: "uncalibrated",
              factorObservations: [{ field: "momentum20", rawValue: 4.2, percentileOrRank: 0.8, sourceIds: ["src_kline"] }],
            },
            medium_term: { validationStatus: "insufficient_data", factorObservations: [] },
            long_term: { validationStatus: "insufficient_data", factorObservations: [] },
          },
        },
      }],
    }));

    const result = await fetchStockScreenResult("run_quant");
    expect(result.quant_snapshot).toMatchObject({
      schema_version: 1,
      as_of: "2026-08-19T15:00:00+08:00",
      validation_status: "uncalibrated",
      universe: { enriched_count: 4, unprocessed_after_cap: 2 },
      data_quality: { point_in_time: { status: "verified" } },
    });
    expect(result.candidates[0].quant_validation?.horizons?.short_term?.factor_observations?.[0]).toMatchObject({
      field: "momentum20",
      raw_value: 4.2,
      percentile_or_rank: 0.8,
      source_ids: ["src_kline"],
    });
  });

  it("normalizes v2 opportunity horizon views and their nested claim arrays", async () => {
    httpFetch.mockResolvedValueOnce(jsonResponse({
      reportId: "report_horizons",
      workflowRunId: "run_horizons",
      strategy: { strategyId: "quality_growth", name: "业绩成长", source: "builtin" },
      candidates: [{
        instrumentId: "XSHG:600519",
        name: "贵州茅台",
        selectionReasons: [],
        riskFlags: [],
        dataQuality: "available",
      }],
      opportunityResearch: {
        schemaVersion: 2,
        status: "completed",
        candidateCount: 1,
        candidates: [{
          instrumentId: "XSHG:600519",
          deterministicRank: 1,
          researchPriority: "high",
          whyNow: { text: "当前证据支持继续研究", claimType: "inference", sourceIds: ["src_horizon"] },
          horizonViews: {
            shortTerm: {
              status: "available",
              summary: { text: "短线核心判断", claimType: "inference", sourceIds: ["src_horizon"] },
              supportingEvidence: [{ text: "短线支持", claimType: "fact", sourceIds: ["src_horizon"] }],
              counterEvidence: [{ text: "短线反证", claimType: "fact", sourceIds: ["src_horizon"] }],
              watchItems: [{ text: "短线观察", claimType: "unknown", sourceIds: [] }],
              invalidationConditions: [{ text: "短线失效", claimType: "unknown", sourceIds: [] }],
              dataGaps: [],
            },
            mediumTerm: {
              status: "insufficient_data",
              summary: { text: "中线缺少盈利预期", claimType: "unknown", sourceIds: [] },
              supportingEvidence: [],
              counterEvidence: [],
              watchItems: [],
              invalidationConditions: [],
              dataGaps: [{ text: "缺少盈利预期数据", claimType: "unknown", sourceIds: [] }],
            },
          longTerm: {
              status: "available",
              summary: { text: "长线核心判断", claimType: "inference", sourceIds: ["src_horizon"] },
              supportingEvidence: [],
              counterEvidence: [],
              watchItems: [],
              invalidationConditions: [],
              dataGaps: [],
            },
          },
          eventTransmission: {
            status: "available",
            event: { text: "公司公告确认订单落地", claimType: "fact", sourceIds: ["src_event"] },
            directImpact: { text: "订单将增加近期交付需求", claimType: "inference", sourceIds: ["src_event"] },
            industryChain: [{ text: "上游材料需求可能同步增加", claimType: "inference", sourceIds: ["src_event"] }],
            businessExposure: { text: "公司主营产品覆盖该订单", claimType: "fact", sourceIds: ["src_event"] },
            earningsPath: { text: "交付确认后观察收入与利润兑现", claimType: "inference", sourceIds: ["src_event"] },
            validationWindow: { text: "未来一个季度跟踪交付量和毛利率", claimType: "inference", sourceIds: ["src_event"] },
            pricedIn: "partially_priced_in",
            pricedInBasis: { text: "当前价格与公开预期仅部分反映该事件", claimType: "inference", sourceIds: ["src_event"] },
            counterEvidence: [{ text: "订单存在延期风险", claimType: "fact", sourceIds: ["src_event"] }],
            invalidationConditions: [{ text: "订单取消或无法交付", claimType: "inference", sourceIds: ["src_event"] }],
            dataGaps: [],
          },
          contextId: "ctx_horizon123456",
          sourceIds: ["src_horizon"],
        }],
      },
    }));

    const result = await fetchStockScreenResult("run_horizons");
    const horizons = result.opportunity_research?.candidates?.[0]?.horizon_views;
    expect(horizons?.short_term?.supporting_evidence?.[0]).toMatchObject({
      text: "短线支持",
      claim_type: "fact",
      source_ids: ["src_horizon"],
    });
    expect(horizons?.medium_term?.status).toBe("insufficient_data");
    expect(horizons?.medium_term?.data_gaps?.[0]).toMatchObject({ text: "缺少盈利预期数据" });
    expect(horizons?.long_term?.invalidation_conditions).toEqual([]);
    expect(result.opportunity_research?.candidates?.[0]?.event_transmission).toMatchObject({
      status: "available",
      event: { text: "公司公告确认订单落地", claim_type: "fact", source_ids: ["src_event"] },
      direct_impact: { text: "订单将增加近期交付需求", claim_type: "inference", source_ids: ["src_event"] },
      industry_chain: [{ text: "上游材料需求可能同步增加", claim_type: "inference", source_ids: ["src_event"] }],
      priced_in: "partially_priced_in",
      priced_in_basis: { text: "当前价格与公开预期仅部分反映该事件", claim_type: "inference", source_ids: ["src_event"] },
    });
    expect((result.opportunity_research?.candidates?.[0]?.event_transmission as Record<string, unknown>).eventTransmission).toBeUndefined();
  });

  it("uses the frozen strategy save and compare payloads", async () => {
    httpFetch
      .mockResolvedValueOnce(jsonResponse({ strategy: { strategy_id: "my_strategy", name: "我的策略", source: "user" } }))
      .mockResolvedValueOnce(jsonResponse({ items: [], dataQuality: { status: "available" }, dimensions: [{ key: "price", label: "价格", values: { "XSHG:600519": 1700.5, "XSHE:000001": 12.3 } }] }));
    const saved = await saveStockScreenStrategy({ strategy_id: "my_strategy", name: "我的策略", source: "user" });
    expect(saved.strategy_id).toBe("my_strategy");
    const compared = await compareStockScreenCandidates(["XSHG:600519", "XSHE:000001"], "run_compare");
    expect(compared.dimensions?.[0]?.values).toEqual({ "XSHG:600519": 1700.5, "XSHE:000001": 12.3 });
    expect(JSON.parse(httpFetch.mock.calls[0][1].body)).toMatchObject({ strategy_id: "my_strategy" });
    expect(JSON.parse(httpFetch.mock.calls[1][1].body)).toEqual({ runId: "run_compare", instrumentIds: ["XSHG:600519", "XSHE:000001"] });
  });
});

describe("STOCK_ROOM_CHAT_ID", () => {
  it("targets the hidden stock research room session", () => {
    expect(STOCK_ROOM_CHAT_ID).toBe("stock_research");
  });
});
