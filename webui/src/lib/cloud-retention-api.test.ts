import { beforeEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ getGatewayHttpBase: async () => "http://127.0.0.1:17173" }));
vi.mock("@/lib/tauri", () => ({ httpFetch: io.fetch }));
import { cloudSyncApi } from "./cloud-sync";
const draft = { draft_id: "a".repeat(32), count: 2, retention_days: 30, has_more: false, expires_at: 2000000000 };
const result = { complete: true, retired: 2, already_retired: 0, retained: 0, released_bytes: 0 };
function respond(value: unknown) { io.fetch.mockResolvedValue(new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } })); }
beforeEach(() => { io.fetch.mockReset(); });

it("uses only local confirmation and never adds a cloud credential or path", async () => {
  respond(draft);
  expect(await cloudSyncApi.retentionPreview()).toEqual(draft);
  expect(io.fetch.mock.calls[0][0]).toBe("http://127.0.0.1:17173/api/cloud-sync/retention-preview");
  respond(result);
  expect(await cloudSyncApi.retireHistory(draft.draft_id)).toEqual(result);
  expect(JSON.parse(io.fetch.mock.calls[1][1].body)).toEqual({ draft_id: draft.draft_id, confirmed: true });
  expect(io.fetch.mock.calls[1][1].headers).not.toHaveProperty("Authorization");
});
it.each([{ count: 51 }, { retention_days: 0 }, { count: 0 }, { has_more: true }, { expires_at: -1 }])("rejects malformed preview", async (change) => {
  respond({ ...draft, ...change });
  await expect(cloudSyncApi.retentionPreview()).rejects.toMatchObject({ code: "invalid_response" });
});
it.each([{ released_bytes: 64 }, { complete: false }, { retired: -1 }, { retained: 51 }])("rejects false completion or quota claims", async (change) => {
  respond({ ...result, ...change });
  await expect(cloudSyncApi.retireHistory(draft.draft_id)).rejects.toMatchObject({ code: "invalid_response" });
});
it("does not send malformed requests or replay uncertain writes", async () => {
  await expect(cloudSyncApi.retireHistory("../all")).rejects.toMatchObject({ code: "invalid_response" });
  expect(io.fetch).not.toHaveBeenCalled();
  io.fetch.mockRejectedValue(new Error("synthetic transport error"));
  await expect(cloudSyncApi.retireHistory(draft.draft_id)).rejects.toMatchObject({ code: "service_unavailable" });
  expect(io.fetch).toHaveBeenCalledOnce();
});
