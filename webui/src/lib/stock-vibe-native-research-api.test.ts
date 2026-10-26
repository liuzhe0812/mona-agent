import { beforeEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ base: vi.fn(), fetch: vi.fn() }));
vi.mock("./services-http-base", () => ({ getServicesHttpBase: transport.base }));
vi.mock("./tauri", () => ({ httpFetch: transport.fetch, isTauri: () => false }));
import { getStockVibeNativeResearch, getStockVibeNativeResearchCatalog, getStockVibeNativeStrategy, startStockVibeNativeResearch } from "./stock-vibe-native-research-api";
beforeEach(() => { transport.base.mockReset().mockResolvedValue("http://services"); transport.fetch.mockReset(); });
describe("native research host contract", () => {
  it("reads the source catalog and submits the actual native preset variables using a stable request ID", async () => {
    transport.fetch.mockImplementation(async () => new Response(JSON.stringify({ native: { teams: [], strategies: { items: [] } } }), { status: 200 }));
    expect((await getStockVibeNativeResearchCatalog()).teams).toEqual([]);
    await startStockVibeNativeResearch("a".repeat(32), { preset_name: "quant_strategy_desk", user_vars: { market: "中国A股", goal: "研究波段机会" } });
    expect(transport.fetch.mock.calls[0][0]).toBe("http://services/api/stock-vibe/native-research/catalog?source=sdm&limit=20&offset=0");
    const [url, options] = transport.fetch.mock.calls[1]; expect(url).toBe("http://services/api/stock-vibe/swarm/runs");
    expect(new Headers(options.headers).get("X-Mona-Request-ID")).toBe("a".repeat(32));
    expect(JSON.parse(options.body)).toEqual({ preset_name: "quant_strategy_desk", user_vars: { market: "中国A股", goal: "研究波段机会" } });
  });
  it("requires persisted candidate source references and never extracts candidates from report prose", async () => {
    const candidate = { symbol: "600519.SH", as_of: "2026-10-20", task_id: "task-screen", artifact_id: "b".repeat(64), kind: "research_candidate", evidence_verification: "tool_result_symbol_and_date", evidence_refs: [{ receipt_id: "receipt-1", task_id: "task-screen", call_id: "call-1", tool: "factor_analysis", result_sha256: "c".repeat(64) }], name: "贵州茅台", support: ["原生筛选产物中的观测值"], risks: ["经营风险"] };
    const result = { id: "swarm-1", tasks: [], candidates: [candidate], candidate_sources: [], final_report: "建议关注 600519.SH" };
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ native: result }), { status: 200 }));
    expect((await getStockVibeNativeResearch("swarm-1")).candidates).toEqual([]);
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ native: { ...result, candidate_sources: [{ artifact_id: "b".repeat(64), task_id: "task-screen" }] } }), { status: 200 }));
    expect((await getStockVibeNativeResearch("swarm-1")).candidates).toEqual([candidate]);
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ native: { ...result, candidate_sources: [{ artifact_id: "b".repeat(64), task_id: "other-task" }] } }), { status: 200 }));
    expect((await getStockVibeNativeResearch("swarm-1")).candidates).toEqual([]);
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ native: { ...result, id: "other" } }), { status: 200 }));
    await expect(getStockVibeNativeResearch("swarm-1")).rejects.toThrow();
  });
  it("reads strategy evidence only through a validated native strategy identifier", async () => {
    await expect(getStockVibeNativeStrategy("strategy-1")).rejects.toThrow();
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ native: { strategy_id: "sdm:strategy-1", found: true } }), { status: 200 }));
    await getStockVibeNativeStrategy("sdm:strategy-1"); expect(transport.fetch.mock.calls[0][0]).toBe("http://services/api/stock-vibe/native-research/strategies/sdm%3Astrategy-1");
    await expect(getStockVibeNativeStrategy("../private")).rejects.toThrow(); expect(transport.fetch).toHaveBeenCalledTimes(1);
  });
});
