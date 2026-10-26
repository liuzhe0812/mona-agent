import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ base: vi.fn(), fetch: vi.fn() }));

vi.mock("./services-http-base", () => ({ getServicesHttpBase: transport.base }));
vi.mock("./tauri", () => ({ httpFetch: transport.fetch, isTauri: () => false }));

import {
  createStockVibeRequestId,
  getStockVibeAttention,
  getStockVibeMarketData,
  getStockVibeWorkbenchMarket,
  getStockVibeForecast,
  getStockVibeWorkbench,
  searchStockVibeSymbols,
  getStockVibeRequest,
  getStockVibeScenario,
  listStockVibeScenarios,
  listStockVibeUploads,
  startStockVibeOperation,
  updateStockVibeAttention,
  updateStockVibeSchedule,
  type StockVibeAttentionPreferences,
  type StockVibeOperationInput,
} from "./stock-vibe-api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const preferences: StockVibeAttentionPreferences = {
  proactive_mode: "important_changes",
  watched_symbols: ["600519.SH"],
  notification_start: "09:30",
  notification_end: "15:00",
  attention_interval_sec: 900,
  data_sources: ["tencent", "eastmoney"],
};

beforeEach(() => {
  transport.base.mockReset().mockResolvedValue("http://services");
  transport.fetch.mockReset();
});

describe("stock-vibe attention and scenario APIs", () => {
  it("updates only the schedule cadence on the same job with a stable request id", async () => {
    const record = { request_id: "a".repeat(32), status: "completed" };
    const input = { schedule: "30 17 * * 1-5", timezone: "Asia/Shanghai" as const };
    transport.fetch.mockResolvedValue(jsonResponse(record));
    await expect(updateStockVibeSchedule("followup_1", record.request_id, input)).resolves.toEqual(record);
    const [url, init] = transport.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://services/api/stock-vibe/scheduled-runs/followup_1");
    expect(init.method).toBe("PATCH");
    expect(new Headers(init.headers).get("X-Mona-Request-ID")).toBe(record.request_id);
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it("searches names through Services with an encoded query and no write dispatch", async () => {
    const body = { native: { candidates: [{ symbol: "002460.SZ", name: "赣锋锂业" }] }, source: null };
    transport.fetch.mockResolvedValue(jsonResponse(body));
    await expect(searchStockVibeSymbols(" 赣锋 ")).resolves.toEqual(body);
    const [url, options] = transport.fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe("/api/stock-vibe/symbol-search");
    expect(new URL(url).searchParams.get("q")).toBe("赣锋");
    expect(options.method).toBe("GET");
    expect(new Headers(options.headers).has("X-Mona-Request-ID")).toBe(false);
  });
  it("reads workbench data and forecasts through their authenticated Services routes without dispatching writes", async () => {
    transport.fetch.mockImplementation(() => Promise.resolve(jsonResponse({ native: {}, source: null })));
    await getStockVibeWorkbenchMarket("002460.SZ", "intraday");
    await getStockVibeForecast("002460.SZ", "1D");
    await getStockVibeWorkbench("002460.SZ");
    expect(transport.fetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ["http://services/api/stock-vibe/workbench-market?symbol=002460.SZ&interval=intraday", "GET"],
      ["http://services/api/stock-vibe/forecast?symbol=002460.SZ&interval=1D", "GET"],
      ["http://services/api/stock-vibe/workbench?symbol=002460.SZ", "GET"],
    ]);
  });
  it("reads attention preferences and runtime through the host endpoint", async () => {
    const body = { preferences, execution_allowed: false, runtime: null };
    transport.fetch.mockResolvedValue(jsonResponse(body));

    await expect(getStockVibeAttention()).resolves.toEqual(body);
    expect(transport.fetch).toHaveBeenCalledWith(
      "http://services/api/stock-vibe/attention",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("saves only preferences with a stable request ID using PUT", async () => {
    const record = { request_id: "a".repeat(32), status: "completed" };
    transport.fetch.mockResolvedValue(jsonResponse(record));

    await expect(updateStockVibeAttention(record.request_id, preferences)).resolves.toEqual(record);
    const [url, init] = transport.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://services/api/stock-vibe/attention");
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("X-Mona-Request-ID")).toBe(record.request_id);
    expect(JSON.parse(String(init.body))).toEqual(preferences);
  });

  it("creates opaque UUID request IDs", () => {
    expect(createStockVibeRequestId()).toMatch(/^[a-f0-9]{32}$/);
  });

  it("reads full scenario artifacts from list and opaque detail paths", async () => {
    const response = { native: { scenarios: [] }, source: null };
    transport.fetch.mockResolvedValueOnce(jsonResponse(response)).mockResolvedValueOnce(jsonResponse(response));

    await expect(listStockVibeScenarios()).resolves.toEqual(response);
    await expect(getStockVibeScenario("a".repeat(32))).resolves.toEqual(response);
    expect(transport.fetch).toHaveBeenNthCalledWith(
      1,
      "http://services/api/stock-vibe/scenarios",
      expect.objectContaining({ method: "GET" }),
    );
    expect(transport.fetch).toHaveBeenNthCalledWith(
      2,
      `http://services/api/stock-vibe/scenarios/${"a".repeat(32)}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("queries an uncertain attention receipt with GET only", async () => {
    const record = { request_id: "b".repeat(32), status: "unknown" };
    transport.fetch.mockResolvedValue(jsonResponse(record));

    await expect(getStockVibeRequest(record.request_id)).resolves.toEqual(record);
    expect(transport.fetch).toHaveBeenCalledOnce();
    expect(transport.fetch.mock.calls[0][1]).toMatchObject({ method: "GET" });
  });

  it("lists previously confirmed upload receipts without starting a write", async () => {
    const result = { uploads: [{ upload_id: "c".repeat(32), filename: "trades.csv", size_bytes: 12 }] };
    transport.fetch.mockResolvedValue(jsonResponse(result));

    await expect(listStockVibeUploads()).resolves.toEqual(result);
    expect(transport.fetch).toHaveBeenCalledWith(
      "http://services/api/stock-vibe/uploads",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("submits an OOS validation through the existing operation endpoint with a stable request ID", async () => {
    const requestId = "d".repeat(32);
    const input: StockVibeOperationInput = {
      operation: "strategy_oos_validation",
      run_id: "mona-run-1",
      window_start: "2026-06-23",
      window_end: "2026-07-01",
      cost_scenarios: [
        { scenario_id: "source_config", overrides: {} },
        { scenario_id: "stress_costs", overrides: { commission_rate: 0.001, slippage: 0.01 } },
      ],
    };
    const receipt = { request_id: requestId, status: "completed" };
    transport.fetch.mockResolvedValue(jsonResponse(receipt));

    await expect(startStockVibeOperation(requestId, input)).resolves.toEqual(receipt);
    const [url, init] = transport.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://services/api/stock-vibe/operations");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-Mona-Request-ID")).toBe(requestId);
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it("submits strict-factor bounds without sending a universe, threshold, path, or credential", async () => {
    const requestId = "e".repeat(32);
    const input: StockVibeOperationInput = {
      operation: "strict_factor_validation",
      zoo: "alpha101",
      start_date: "2022-01-01",
      end_date: "2025-01-01",
      oos_cutoff: "2024-01-01",
      n_random_seeds: 3,
      horizon: 5,
      top: 10,
    };
    const receipt = { request_id: requestId, status: "completed" };
    transport.fetch.mockResolvedValue(jsonResponse(receipt));

    await expect(startStockVibeOperation(requestId, input)).resolves.toEqual(receipt);
    const [, init] = transport.fetch.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload).toEqual(input);
    expect(payload).not.toHaveProperty("universe");
    expect(payload).not.toHaveProperty("threshold");
    expect(payload).not.toHaveProperty("zoo_root");
    expect(payload).not.toHaveProperty("token");
  });

  it("maps a request conflict to safe user guidance", async () => {
    transport.fetch.mockResolvedValue(jsonResponse({
      error: "request_conflict",
    }, 409));

    await expect(listStockVibeScenarios()).rejects.toMatchObject({
      status: 409,
      code: "request_conflict",
      message: "此请求标识已用于另一项操作，请核对请求状态。",
    });
  });

  it.each([
    [502, "market_data_unavailable", "未能取得所选行情，请稍后刷新行情或切换周期。"],
    [400, "market_query_unsupported", "当前数据源不支持所选行情，请核对代码或切换周期。"],
  ])("reports a market failure without sending users to model settings (%s)", async (status, code, message) => {
    transport.fetch.mockResolvedValue(jsonResponse({ error: code, message: "private provider details" }, status));

    await expect(getStockVibeMarketData({
      symbol: "002460.SZ", interval: "1D", start_date: "2026-06-20", end_date: "2026-10-18",
    })).rejects.toMatchObject({ status, code, message });
    expect(transport.fetch).toHaveBeenCalledOnce();
  });
});
