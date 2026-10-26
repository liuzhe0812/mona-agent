import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ base: vi.fn(), fetch: vi.fn() }));
vi.mock("./services-http-base", () => ({ getServicesHttpBase: transport.base }));
vi.mock("./tauri", () => ({ httpFetch: transport.fetch, isTauri: () => false }));
import * as opportunityApi from "./stock-vibe-opportunity-api";
import { createStockVibeOpportunitySession, getStockVibeOpportunityHistory, getStockVibeOpportunityHistoryBatch, getStockVibeOpportunityPlans, getStockVibeOpportunitySession, parseStockVibeOpportunityHistory, parseStockVibeOpportunityHistoryRange, parseStockVibeOpportunityResult, startStockVibeOpportunity } from "./stock-vibe-opportunity-api";

beforeEach(() => {
  transport.base.mockReset().mockResolvedValue("http://services");
  transport.fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ native: { plans: [] }, source: null }), { status: 200 }));
});

describe("opportunity host contract", () => {
  it("reads paginated saved history without creating or continuing a test", async () => {
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ native: { items: [], total: 0, limit: 20, offset: 20 }, source: null }), { status: 200 }));
    await expect(getStockVibeOpportunityHistory(20, 20)).resolves.toEqual({ items: [], total: 0, limit: 20, offset: 20 });
    expect(transport.fetch.mock.calls[0][0]).toBe("http://services/api/stock-vibe/opportunity-history?limit=20&offset=20");
    await expect(getStockVibeOpportunityHistory(20, -1)).rejects.toThrow(); await expect(getStockVibeOpportunityHistoryBatch("../operation", "batch-1")).rejects.toThrow();
    expect(transport.fetch).toHaveBeenCalledOnce(); expect(transport.fetch.mock.calls[0][1]?.method).not.toBe("POST");
  });

  it("does not export the retired historical dispatch and continuation API", () => {
    expect(opportunityApi).not.toHaveProperty("startStockVibeOpportunityHistory");
    expect(opportunityApi).not.toHaveProperty("startStockVibeOpportunityHistoryRange");
    expect(opportunityApi).not.toHaveProperty("continueStockVibeOpportunityHistory");
  });

  it("distinguishes standard daily sampling from saved interval sampling and validates additional result evidence", () => {
    const summary = { total_batches: 0, complete_batches: 0, average_return: null, market_return: null, industry_return: null, excess_market: null, excess_industry: null, outperform_market_count: 0, comparable_market_batches: 0 };
    const result = { kind: "opportunity_history_range", version: 1, status: "unavailable", start_date: "2025-10-10", end_date: "2025-10-20", horizon: 5, top_n: 5, plan_ids: ["multifactor"], universe: "csi300", frequency_trading_days: 5, batches: [], summary, calculation: { start_basis: "次日开盘", end_basis: "第H日收盘", weighting: "等金额", fees: "未扣费用", adjustment: "同源复权" }, limitations: [], request: { plan_id: "multifactor", mode: "swing", universe: "csi300", start_date: "2025-10-10", end_date: "2025-10-20", horizon: 5, top_n: 5 } };
    expect(parseStockVibeOpportunityHistoryRange(result)).toEqual(result);
    expect(parseStockVibeOpportunityHistoryRange({ ...result, frequency_trading_days: 1 })).toBeNull();
    expect(parseStockVibeOpportunityHistoryRange({ ...result, summary: { ...summary, average_return: "8%" } })).toBeNull();
    const standard = { ...result, frequency_trading_days: 1, sampling: "all_market_days_v1", summary: { ...summary, evaluated_start_date: null, evaluated_end_date: null, incomplete_batches: 0, unavailable_batches: 0, empty_batches: 0 }, period_summaries: [{ label: "2025年", start_date: "2025-10-10", end_date: "2025-10-20", total_batches: 0, complete_batches: 0, average_return: null, market_return: null, industry_return: null, excess_market: null, excess_industry: null }], offset_stability: { groups: [{ offset: 0, total_batches: 0, complete_batches: 0, average_return: null, excess_market: null }], min_average_return: null, max_average_return: null } };
    expect(parseStockVibeOpportunityHistoryRange(standard)).toEqual(standard);
    expect(parseStockVibeOpportunityHistoryRange({ ...standard, frequency_trading_days: 5 })).toBeNull();
    expect(parseStockVibeOpportunityHistoryRange({ ...standard, offset_stability: { ...standard.offset_stability, min_average_return: NaN } })).toBeNull();
    expect(parseStockVibeOpportunityHistoryRange({ ...standard, period_summaries: [{ ...standard.period_summaries[0], average_return: "8%" }] })).toBeNull();
    expect(parseStockVibeOpportunityHistoryRange({ ...standard, roster_scopes: ["current_scope_historical_check"] })).not.toBeNull();
    expect(parseStockVibeOpportunityHistoryRange({ ...standard, roster_scopes: [1] })).toBeNull();
  });
  it("accepts explicit unavailable history and rejects a trading simulation or malformed price result", () => {
    const result = { kind: "opportunity_history", version: 1, status: "unavailable", selection_date: "2025-10-10", horizon: 5, top_n: 5, plan_ids: ["multifactor"], universe: "csi300", window: { start_date: null, end_date: null, available_trading_days: 0 }, candidates: [], summary: { selected: 0, observed: 0, average_return: null, market_return: null, industry_return: null, excess_market: null, excess_industry: null }, benchmark: { name: "沪深300", symbol: "000300.SH", return: null, start_price: null, end_price: null, status: "missing" }, calculation: { start_basis: "次日开盘", end_basis: "第H日收盘", weighting: "等金额", fees: "未扣费用", adjustment: "同源复权" }, method: {}, coverage: {}, limitations: ["缺少历史成分。"] };
    expect(parseStockVibeOpportunityHistory(result)).toEqual(result);
    expect(parseStockVibeOpportunityHistory({ backtests: [{ metrics: { total_return: -.1351 } }], candidates: [] })).toBeNull();
    expect(parseStockVibeOpportunityHistory({ ...result, summary: { ...result.summary, average_return: NaN } })).toBeNull();
    expect(parseStockVibeOpportunityHistory({ ...result, candidates: [{ symbol: "600519.SH", rank: 1, status: "observed", start_price: 100, end_price: 108, return: "8%", market_excess: null }] })).toBeNull();
  });
  it("uses host routes, stable request IDs and opportunity-specific metadata", async () => {
    const id = "a".repeat(32), input = { plan_id: "multifactor", mode: "swing" as const, universe: "csi300" as const };
    await expect(getStockVibeOpportunityPlans()).resolves.toEqual({ plans: [] });
    await startStockVibeOpportunity(id, input);
    await createStockVibeOpportunitySession(id, "自定义", { ...input, plan_id: "custom", conditions: "经营改善" });
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ native: { version: 1, candidates: [], limitations: ["尚未保存结构化候选"] }, source: { instance_id: "example" } }), { status: 200 }));
    await expect(getStockVibeOpportunitySession("session-1", "attempt-1")).resolves.toEqual({ version: 1, candidates: [], limitations: ["尚未保存结构化候选"] });
    expect(transport.fetch.mock.calls[0][0]).toBe("http://services/api/stock-vibe/opportunity-plans");
    const [url, init] = transport.fetch.mock.calls[1];
    expect(url).toBe("http://services/api/stock-vibe/operations");
    expect(new Headers(init.headers).get("X-Mona-Request-ID")).toBe(id);
    expect(JSON.parse(init.body)).toEqual({ operation: "opportunity_screen", ...input });
    expect(JSON.parse(transport.fetch.mock.calls[2][1].body)).toEqual({ title: "自定义", opportunity: { ...input, plan_id: "custom", conditions: "经营改善" } });
    expect(transport.fetch.mock.calls[3][0]).toBe("http://services/api/stock-vibe/opportunity-sessions/session-1?attempt_id=attempt-1");
  });
  it("rejects unsafe identifiers and keeps only explicit structured candidate identities", async () => {
    await expect(getStockVibeOpportunitySession("../session")).rejects.toThrow();
    await expect(startStockVibeOpportunity("bad-id", { plan_id: "multifactor", mode: "swing", universe: "csi300" })).rejects.toThrow();
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(parseStockVibeOpportunityResult({ report_markdown: "600519.SH 是候选" })).toBeNull();
    expect(parseStockVibeOpportunityResult({ candidates: [{ symbol: "600519.SH", support: ["依据", 1] }, { symbol: "not-a-stock" }] })?.candidates).toEqual([{ symbol: "600519.SH", support: ["依据"], risks: [] }]);
  });
});
