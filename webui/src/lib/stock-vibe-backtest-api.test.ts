import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ base: vi.fn(), fetch: vi.fn() }));
vi.mock("./services-http-base", () => ({ getServicesHttpBase: transport.base }));
vi.mock("./tauri", () => ({ httpFetch: transport.fetch, isTauri: () => false }));
import { getStockVibeBacktestDefaults, getStockVibeBacktestInputs, getStockVibeBacktestRun, listStockVibeBacktestStrategyHistory, parseStockVibeBacktestOperation, startStockVibeBacktest, stockVibeBacktestRunId, type StockVibeStrategyScope } from "./stock-vibe-backtest-api";

beforeEach(() => {
  transport.base.mockReset().mockResolvedValue("http://services");
  transport.fetch.mockReset().mockResolvedValue(new Response(JSON.stringify({ native: { defaults: { source: "tushare" }, inputs: [] } }), { status: 200 }));
});
describe("native backtest settings contract", () => {
  it("reads defaults and existing native strategy inputs without inventing browser defaults", async () => {
    expect((await getStockVibeBacktestDefaults()).defaults.source).toBe("tushare");
    transport.fetch.mockResolvedValue(new Response(JSON.stringify({ native: { inputs: [] } }), { status: 200 }));
    expect(await getStockVibeBacktestInputs()).toEqual([]);
    expect(transport.fetch.mock.calls.map(([url]) => url)).toEqual(["http://services/api/stock-vibe/backtest-settings/defaults", "http://services/api/stock-vibe/backtest-settings/inputs"]);
  });
  it("dispatches explicit native settings and supported template parameters with the stable request ID", async () => {
    const settings = { source: "tushare", initial_cash: 1000000, commission_rate: .0003, start_date: "2020-01-01", end_date: "2021-01-01" };
    await startStockVibeBacktest("a".repeat(32), { template_id: "vibe_multifactor_example", settings, strategy_parameters: { top_n: 3 } });
    const [url, options] = transport.fetch.mock.calls[0];
    expect(url).toBe("http://services/api/stock-vibe/operations");
    expect(new Headers(options.headers).get("X-Mona-Request-ID")).toBe("a".repeat(32));
    expect(JSON.parse(options.body)).toEqual({ operation: "backtest", template_id: "vibe_multifactor_example", settings, strategy_parameters: { top_n: 3 } });
  });
  it("dispatches a pinned strategy version and rejects mixed or unsafe strategy references", async () => {
    const strategyVersion = "a".repeat(64), settings = { source: "tushare", codes: ["600519.SH"] };
    await startStockVibeBacktest("b".repeat(32), { strategy_id: "builtin:technical-basic", strategy_version: strategyVersion, settings });
    expect(JSON.parse(transport.fetch.mock.calls[0][1].body)).toEqual({ operation: "backtest", strategy_id: "builtin:technical-basic", strategy_version: strategyVersion, settings });
    expect(() => startStockVibeBacktest("c".repeat(32), { strategy_id: "sdm:strategy_1", settings })).toThrow();
    expect(() => startStockVibeBacktest("d".repeat(32), { strategy_id: "builtin:../escape", strategy_version: strategyVersion, settings })).toThrow();
    expect(() => startStockVibeBacktest("e".repeat(32), { strategy_id: "builtin:technical-basic", strategy_version: "unknown", run_id: "existing", settings })).toThrow();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });
  it("reads paginated history for a strategy identity", async () => {
    transport.fetch.mockResolvedValue(new Response(JSON.stringify({ native: { items: [{ operation_id: "op-1", operation: "backtest", status: "completed" }], total: 21, limit: 20, offset: 20 } }), { status: 200 }));
    expect(await listStockVibeBacktestStrategyHistory("builtin:technical-basic", 20, 20)).toEqual({ items: [{ operation_id: "op-1", operation: "backtest", status: "completed" }], total: 21, limit: 20, offset: 20 });
    expect(transport.fetch.mock.calls[0][0]).toBe("http://services/api/stock-vibe/strategy-library/history?strategy_id=builtin%3Atechnical-basic&operation=backtest&limit=20&offset=20");
    await expect(listStockVibeBacktestStrategyHistory("builtin:../unsafe")).rejects.toThrow();
    await expect(listStockVibeBacktestStrategyHistory("sdm:strategy_1", 20, -1)).rejects.toThrow();
  });
  it("sends the same explicit market, industry or watchlist scope without old sample codes", async () => {
    transport.fetch.mockImplementation(async () => new Response(JSON.stringify({ request_id: "b".repeat(32), status: "completed" }), { status: 200 }));
    const scopes: StockVibeStrategyScope[] = [{ kind: "all_a" }, { kind: "industry", industry_code: "BK0475" }, { kind: "watchlist", codes: ["600519.SH"] }];
    const identity = { strategy_id: "sdm:strategy_1", strategy_version: "a".repeat(64) };
    for (const scope of scopes) await startStockVibeBacktest("b".repeat(32), { ...identity, scope, settings: { source: "eastmoney" } });
    expect(transport.fetch.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual(scopes.map((scope) => ({ operation: "backtest", ...identity, scope, settings: { source: "eastmoney" } })));
    expect(() => startStockVibeBacktest("b".repeat(32), { ...identity, scope: { kind: "all_a" }, settings: { codes: ["600519.SH"] } })).toThrow();
    expect(() => startStockVibeBacktest("b".repeat(32), { run_id: "old", scope: { kind: "all_a" }, settings: {} })).toThrow();
    expect(transport.fetch).toHaveBeenCalledTimes(3);
  });
  it("uses the output native run rather than input strategy and rejects unsafe report identifiers", async () => {
    const row = parseStockVibeBacktestOperation({ operation: "backtest", operation_id: "op-1", status: "completed", references: { input_run_id: "old", run_id: "new" } });
    expect(row && stockVibeBacktestRunId(row)).toBe("new");
    expect(parseStockVibeBacktestOperation({ operation: "opportunity_history", operation_id: "op-1", status: "completed" })).toBeNull();
    await expect(getStockVibeBacktestRun("../other")).rejects.toThrow();
    expect(() => startStockVibeBacktest("a".repeat(32), { run_id: "old", template_id: "example", settings: {} })).toThrow();
    expect(transport.fetch).not.toHaveBeenCalled();
  });
});
