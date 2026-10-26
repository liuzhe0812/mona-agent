import { beforeEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ base: vi.fn(), fetch: vi.fn() }));
vi.mock("./services-http-base", () => ({ getServicesHttpBase: transport.base }));
vi.mock("./tauri", () => ({ httpFetch: transport.fetch, isTauri: () => false }));
import { getStockVibeDataSettings, updateStockVibeDataSettings } from "./stock-vibe-data-settings-api";
beforeEach(() => { transport.base.mockReset().mockResolvedValue("http://services"); transport.fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ tushare_configured: true, source: "settings" }), { status: 200 })); });
describe("local stock data settings contract", () => {
  it("reads only redacted configuration status and source", async () => {
    const generated = crypto.randomUUID(); transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ tushare_configured: true, source: "environment", tushare_token: generated }), { status: 200 }));
    expect(await getStockVibeDataSettings()).toEqual({ tushare_configured: true, source: "environment" });
    expect(transport.fetch.mock.calls[0][0]).toBe("http://services/api/stock-vibe/data-settings");
  });
  it("uses PUT with a stable header for save and the same contract with an empty value for local clearing", async () => {
    const generated = crypto.randomUUID(); await updateStockVibeDataSettings("a".repeat(32), generated); await updateStockVibeDataSettings("b".repeat(32), "");
    const [url, options] = transport.fetch.mock.calls[0]; expect(url).toBe("http://services/api/stock-vibe/data-settings"); expect(options.method).toBe("PUT"); expect(new Headers(options.headers).get("X-Mona-Request-ID")).toBe("a".repeat(32)); expect(JSON.parse(options.body)).toEqual({ tushare_token: generated }); expect(JSON.parse(transport.fetch.mock.calls[1][1].body)).toEqual({ tushare_token: "" });
  });
});
