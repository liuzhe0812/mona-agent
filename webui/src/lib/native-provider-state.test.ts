import { beforeEach, describe, expect, it, vi } from "vitest";
const http = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ getGatewayHttpBase: async () => "http://127.0.0.1:1" }));
vi.mock("@/lib/tauri", () => ({ httpFetch: http }));
import { developmentApi } from "./development-api";
import { useNativeProviderState } from "./native-provider-state";

beforeEach(() => { http.mockReset(); useNativeProviderState.setState({ revision: 0 }); });
describe("native model catalog invalidation", () => {
  it("invalidates mounted consumers only after a successful probe or logout", async () => {
    http.mockResolvedValueOnce(new Response(JSON.stringify({ authentication: "ready" }), { headers: { "Content-Type": "application/json" } }));
    await developmentApi.probe(undefined, "codebuddy");
    expect(useNativeProviderState.getState().revision).toBe(1);
    http.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }));
    await developmentApi.logout("codex");
    expect(useNativeProviderState.getState().revision).toBe(2);
  });
  it("does not report a refreshed catalog when the request fails", async () => {
    http.mockRejectedValueOnce(new Error("offline"));
    await expect(developmentApi.probe(undefined, "codex")).rejects.toThrow("offline");
    expect(useNativeProviderState.getState().revision).toBe(0);
  });
});
