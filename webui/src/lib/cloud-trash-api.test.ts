import { beforeEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ getGatewayHttpBase: async () => "http://127.0.0.1:17173" }));
vi.mock("@/lib/tauri", () => ({ httpFetch: io.fetch }));
import { cloudSyncApi, type CloudTrashDraft } from "./cloud-sync";

const item = { resource_id: "a".repeat(32), kind: "note", version: 2, title: "课程笔记", deleted_at: "2026-10-13T00:00:00Z", recoverable: true };
const draft: CloudTrashDraft = { draft_id: "b".repeat(32), resource_id: item.resource_id, kind: "note", version: 2, action: "restore", expires_at: 2_000_000_000 };
const result = { complete: true, resource_id: item.resource_id, kind: "note", version: 3, action: "restore", reused: false, released_bytes: 0 };
function respond(value: unknown) { io.fetch.mockImplementation(async () => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } })); }
beforeEach(() => { io.fetch.mockReset(); });

it("uses exact local confirmation without credentials or a direct storage deletion", async () => {
  respond({ items: [item], next_before: 22, has_more: false });
  expect((await cloudSyncApi.trash()).items).toEqual([item]);
  respond(draft);
  expect(await cloudSyncApi.previewTrash(item.resource_id, 2, "restore")).toEqual(draft);
  respond(result);
  expect(await cloudSyncApi.applyTrash(draft)).toEqual(result);
  const [url, options] = io.fetch.mock.calls[2];
  expect(url).toBe("http://127.0.0.1:17173/api/cloud-sync/trash-apply");
  expect(JSON.parse(options.body)).toEqual({ draft_id: draft.draft_id, confirmed: true });
  expect(options.headers).not.toHaveProperty("Authorization");
});

it.each([{ items: null }, { items: [item, item] }, { has_more: true }, { next_before: -1 },
  { items: [{ ...item, kind: "development" }] }, { items: [{ ...item, version: 0 }] },
  { items: [{ ...item, deleted_at: "not a date" }] }])("rejects invalid pages instead of an empty success", async (change) => {
  respond({ items: [item], next_before: 22, has_more: false, ...change });
  await expect(cloudSyncApi.trash()).rejects.toMatchObject({ code: "invalid_response" });
});

it.each([{ resource_id: "c".repeat(32) }, { action: "purge" }, { version: 2 }, { complete: false }, { released_bytes: 64 }])("rejects a result for another operation or unconfirmed accounting", async (change) => {
  respond({ ...result, ...change });
  await expect(cloudSyncApi.applyTrash(draft)).rejects.toMatchObject({ code: "invalid_response" });
});

it("rejects invalid inputs before sending and does not retry unknown writes", async () => {
  await expect(cloudSyncApi.previewTrash("../other", 2, "purge")).rejects.toBeInstanceOf(Error);
  await expect(cloudSyncApi.trash(0)).rejects.toBeInstanceOf(Error);
  expect(io.fetch).not.toHaveBeenCalled();
  io.fetch.mockRejectedValue(new Error("private synthetic transport"));
  await expect(cloudSyncApi.applyTrash(draft)).rejects.toThrow("暂时无法连接云同步");
  expect(io.fetch).toHaveBeenCalledOnce();
});
