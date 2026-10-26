import { beforeEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ base: vi.fn(), fetch: vi.fn() }));
vi.mock("./services-http-base", () => ({ getServicesHttpBase: transport.base }));
vi.mock("./tauri", () => ({ httpFetch: transport.fetch, isTauri: () => false }));
import { deleteStockVibeLibraryStrategy, getStockVibeLibraryStrategy, getStockVibeStrategyIndustries, getStockVibeStrategyHistory, getStockVibeStrategyLibrary, parseStockVibeStrategyDeleteOperation, parseStockVibeStrategyOperation, startStockVibeStrategyScan, stockVibeBuiltinStrategies, stockVibeBuiltinStrategy, stockVibeStrategyDeleteConfirmed, stockVibeStrategyScanResult } from "./stock-vibe-strategy-library-api";
const version = "a".repeat(64), strategy_id = "builtin:multi-factor";
beforeEach(() => { transport.base.mockReset().mockResolvedValue("http://services"); transport.fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ native: { items: [], total: 0, offset: 0, limit: 20 } }), { status: 200 })); });
describe("unified strategy transport", () => {
  it("reads fixed builtin lists, rules and versions locally without starting transport", async () => {
    const rows = stockVibeBuiltinStrategies({ market: "all" }); expect(rows).toHaveLength(20);
    const first = rows[0], detail = await getStockVibeLibraryStrategy(first.strategy_id);
    expect(detail).toEqual(first); expect(detail.rules.length).toBeGreaterThan(0); expect(detail.version).toMatch(/^[a-f\d]{64}$/);
    const page = await getStockVibeStrategyLibrary({ source: "builtin", market: "all", offset: 10, limit: 5 });
    expect(page).toEqual({ items: rows.slice(10, 15), total: 20, offset: 10, limit: 5 });
    expect(stockVibeBuiltinStrategies({ q: first.name, market: "all" }).some((item) => item.strategy_id === first.strategy_id)).toBe(true);
    detail.rules.length = 0; expect(stockVibeBuiltinStrategy(first.strategy_id)?.rules.length).toBeGreaterThan(0);
    await expect(getStockVibeLibraryStrategy("builtin:missing")).rejects.toThrow("unknown_builtin_strategy");
    expect(transport.base).not.toHaveBeenCalled(); expect(transport.fetch).not.toHaveBeenCalled();
  });
  it("reads paginated real catalogue and scan-only history without running work", async () => {
    await getStockVibeStrategyLibrary({ q: "动量", source: "custom", market: "all", limit: 20, offset: 20 });
    const url = new URL(transport.fetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/api/stock-vibe/strategy-library"); expect(url.searchParams.get("q")).toBe("动量"); expect(url.searchParams.get("source")).toBe("custom"); expect(url.searchParams.get("offset")).toBe("20");
    await getStockVibeStrategyHistory({ strategy_id, operation: "strategy_scan" });
    expect(new URL(transport.fetch.mock.calls[1][0]).searchParams.get("operation")).toBe("strategy_scan");
    expect(transport.fetch.mock.calls.every(([, options]) => !options.method || options.method === "GET")).toBe(true);
  });
  it("dispatches selected immutable strategy reference and settings with a stable request ID", async () => {
    await startStockVibeStrategyScan("b".repeat(32), { strategy_id, strategy_version: version, scope: { kind: "all_a" }, settings: { source: "local" }, strategy_parameters: { top_n: 3 } });
    const [url, options] = transport.fetch.mock.calls[0]; expect(url).toBe("http://services/api/stock-vibe/operations"); expect(new Headers(options.headers).get("X-Mona-Request-ID")).toBe("b".repeat(32));
    expect(JSON.parse(options.body)).toEqual({ operation: "strategy_scan", strategy_id, strategy_version: version, scope: { kind: "all_a" }, settings: { source: "local" }, strategy_parameters: { top_n: 3 } });
  });
  it("rejects unsafe IDs, wrong versions and invalid pagination before transport", async () => {
    await expect(getStockVibeLibraryStrategy("builtin:../other")).rejects.toThrow(); await expect(getStockVibeStrategyLibrary({ offset: -1 })).rejects.toThrow();
    expect(() => startStockVibeStrategyScan("b".repeat(32), { strategy_id, strategy_version: "latest", scope: { kind: "all_a" }, settings: {} })).toThrow(); expect(transport.fetch).not.toHaveBeenCalled();
    expect(() => startStockVibeStrategyScan("b".repeat(32), { strategy_id, strategy_version: version, scope: { kind: "all_a" }, settings: { codes: ["600519.SH"] } })).toThrow("strategy_scope_codes_conflict");
  });
  it("loads actual industry identifiers and names through a read-only catalogue", async () => {
    const catalogue = { items: [{ code: "BK0475", name: "银行" }], source: "eastmoney", as_of: "2026-10-22", fetched_at: "2026-10-22T01:00:00Z" };
    transport.fetch.mockImplementation(async () => new Response(JSON.stringify({ native: catalogue }), { status: 200 }));
    expect(await getStockVibeStrategyIndustries()).toEqual(catalogue);
    expect(transport.fetch.mock.calls[0][0]).toBe("http://services/api/stock-vibe/strategy-library/industries");
    expect(transport.fetch.mock.calls[0][1].method ?? "GET").toBe("GET");
  });
  it("deletes only a custom immutable strategy through the existing request ledger", async () => {
    expect(() => deleteStockVibeLibraryStrategy("b".repeat(32), { strategy_id, strategy_version: version })).toThrow("only_custom_strategy_can_be_deleted");
    expect(transport.fetch).not.toHaveBeenCalled();
    await deleteStockVibeLibraryStrategy("b".repeat(32), { strategy_id: "sdm:custom1", strategy_version: version });
    const [url, options] = transport.fetch.mock.calls[0];
    expect(url).toBe("http://services/api/stock-vibe/operations"); expect(new Headers(options.headers).get("X-Mona-Request-ID")).toBe("b".repeat(32));
    expect(JSON.parse(options.body)).toEqual({ operation: "strategy_delete", strategy_id: "sdm:custom1", strategy_version: version });
  });
  it("confirms deletion only from a completed result bound to the same custom strategy and version", () => {
    const row = parseStockVibeStrategyDeleteOperation({ operation_id: "b".repeat(32), operation: "strategy_delete", status: "completed", references: { strategy_id: "sdm:custom1", strategy_version: version }, tool_result: { status: "ok", kind: "strategy_delete", deleted: true, strategy_id: "sdm:custom1", strategy_version: version, already_deleted: false } })!;
    expect(stockVibeStrategyDeleteConfirmed(row)).toBe(true);
    expect(stockVibeStrategyDeleteConfirmed({ ...row, status: "running" })).toBe(false);
    expect(stockVibeStrategyDeleteConfirmed({ ...row, references: { strategy_id: "sdm:other", strategy_version: version } })).toBe(false);
    expect(stockVibeStrategyDeleteConfirmed({ ...row, references: { strategy_id: "sdm:custom1", strategy_version: "c".repeat(64) } })).toBe(false);
    expect(stockVibeStrategyDeleteConfirmed({ ...row, tool_result: { status: "ok", deleted: false } })).toBe(false);
  });
  it("accepts native signal values only when the operation source matches the result", () => {
    const row = parseStockVibeStrategyOperation({ operation_id: "b".repeat(32), operation: "strategy_scan", status: "completed", references: { strategy_id, strategy_version: version }, tool_result: { status: "ok", kind: "strategy_scan", strategy_id, strategy_version: version, as_of: "2026-10-20", data_as_of: "2026-10-20", effective_at: null, data_sources: [], missing: [], signals: [{ symbol: "600519.SH", signal: -1, signal_date: "2026-10-20" }] } })!;
    expect(stockVibeStrategyScanResult(row)?.signals[0].signal).toBe(-1);
    expect(stockVibeStrategyScanResult({ ...row, references: { strategy_id: "sdm:other", strategy_version: version } })).toBeNull();
    expect(stockVibeStrategyScanResult({ ...row, status: "running" })).toBeNull();
  });
});
