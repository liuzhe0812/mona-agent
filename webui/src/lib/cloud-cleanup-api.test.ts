import { beforeEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ getGatewayHttpBase: async () => "http://127.0.0.1:17173" }));
vi.mock("@/lib/tauri", () => ({ httpFetch: io.fetch }));
import { cloudSyncApi } from "./cloud-sync";

const draft = { draft_id: "a".repeat(32), count: 2, bytes: 128, has_more: false,
  expires_at: 2_000_000_000, minimum_age_seconds: 86400 };
const result = { complete: true, removed: 2, already_removed: 0, retained: 0, failed: 0, pending: 0, released_bytes: 128 };
function respond(value: unknown) {
  io.fetch.mockResolvedValue(new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }));
}
beforeEach(() => { io.fetch.mockReset(); });

it("only sends an opaque local preview id, not credentials or object deletion paths", async () => {
  respond(draft);
  const controller = new AbortController();
  expect(await cloudSyncApi.cleanupPreview(controller.signal)).toEqual(draft);
  expect(io.fetch.mock.calls[0][0]).toBe("http://127.0.0.1:17173/api/cloud-sync/cleanup-preview");
  respond(result);
  expect(await cloudSyncApi.cleanup(draft.draft_id)).toEqual(result);
  const [url, options] = io.fetch.mock.calls[1];
  expect(url).toBe("http://127.0.0.1:17173/api/cloud-sync/cleanup");
  expect(JSON.parse(options.body)).toEqual({ draft_id: draft.draft_id, confirmed: true });
  expect(options.headers).not.toHaveProperty("Authorization");
});

it.each([{ count: 11 }, { bytes: -1 }, { draft_id: null }, { minimum_age_seconds: 0 }, { has_more: true }])("rejects malformed preview before confirmation", async (changes) => {
  respond({ ...draft, ...changes });
  await expect(cloudSyncApi.cleanupPreview()).rejects.toMatchObject({ code: "invalid_response" });
});

it.each([{ complete: true, failed: 1 }, { removed: 11 }, { released_bytes: -1 },
  { removed: 0, already_removed: 2 }, { pending: -1 }])("never presents an invalid result as success", async (changes) => {
  respond({ ...result, ...changes });
  await expect(cloudSyncApi.cleanup(draft.draft_id)).rejects.toMatchObject({ code: "invalid_response" });
});

it("does not send invalid ids or retry an unknown write automatically", async () => {
  await expect(cloudSyncApi.cleanup("../all")).rejects.toMatchObject({ code: "invalid_response" });
  expect(io.fetch).not.toHaveBeenCalled();
  io.fetch.mockRejectedValue(new Error("synthetic private endpoint"));
  await expect(cloudSyncApi.cleanup(draft.draft_id)).rejects.toThrow("暂时无法连接云同步");
  expect(io.fetch).toHaveBeenCalledOnce();
});
