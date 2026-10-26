import { beforeEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ base: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/services-http-base", () => ({ getServicesHttpBase: transport.base }));
vi.mock("@/lib/tauri", () => ({ httpFetch: transport.fetch, isTauri: () => false }));
import { api } from "./api";
beforeEach(() => { transport.base.mockReset().mockResolvedValue("http://services"); transport.fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ native: [] }), { status: 200 })); });
describe("migrated native read and operation adapters", () => {
  it("routes catalog, defaults, readiness and source reads through the authenticated host", async () => {
    await api.listAlphas({ zoo: "alpha101", universe: "equity_cn", limit: 1000 }); await api.getAlphaDefaults(); await api.getAlphaReadiness(); await api.getAlpha("alpha101_001");
    expect(transport.fetch.mock.calls.map(([url]) => url)).toEqual(["http://services/api/stock-vibe/alpha/list?zoo=alpha101&universe=equity_cn&limit=1000", "http://services/api/stock-vibe/alpha/defaults", "http://services/api/stock-vibe/alpha/readiness", "http://services/api/stock-vibe/alpha/alpha101_001"]);
  });
  it("moves the original request identity into the durable header and preserves REST runner parameters", async () => {
    await api.createAlphaBench({ request_id: "a".repeat(32), zoo: "alpha101", alpha_id: "alpha101_001", universe: "csi300", period: "2020-2025", top: 20 });
    await api.createAlphaCompare({ request_id: "b".repeat(32), alpha_ids: ["alpha101_001", "gtja191_010"], universe: "csi300", period: "2020-2025", sort: "ir" });
    const [, options] = transport.fetch.mock.calls[0]; expect(new Headers(options.headers).get("X-Mona-Request-ID")).toBe("a".repeat(32));
    expect(JSON.parse(options.body)).toEqual({ operation: "alpha_bench", zoo: "alpha101", alpha_id: "alpha101_001", universe: "csi300", period: "2020-2025", top: 20 });
    expect(JSON.parse(transport.fetch.mock.calls[1][1].body)).toEqual({ operation: "alpha_compare", alpha_ids: ["alpha101_001", "gtja191_010"], universe: "csi300", period: "2020-2025", sort: "ir" });
  });
  it("uses report reads rather than the strategy-input directory and rejects unsafe identifiers", async () => {
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ native: [{ run_id: "report-1" }] }), { status: 200 }));
    expect(await api.listRuns()).toEqual([{ run_id: "report-1" }]); await api.getRun("report-1");
    expect(transport.fetch.mock.calls.map(([url]) => url)).toEqual(["http://services/api/stock-vibe/reports/runs", "http://services/api/stock-vibe/reports/runs/report-1"]);
    expect(() => api.getRun("../private")).toThrow(); expect(transport.fetch).toHaveBeenCalledTimes(2);
  });
});
