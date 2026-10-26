import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ base: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ getGatewayHttpBase: mocks.base }));
vi.mock("@/lib/tauri", () => ({ httpFetch: mocks.fetch }));
import { cloudSyncApi, ensureCloudFile } from "./cloud-sync";

beforeEach(() => { mocks.base.mockReset().mockResolvedValue("http://127.0.0.1:17173"); mocks.fetch.mockReset(); });
it("uses the authenticated local native bridge and exact selected Work payload", async () => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ enabled: true }), { headers: { "Content-Type": "application/json" } }));
  await cloudSyncApi.enable("a".repeat(32), ["websocket:one"]);
  const [url, init] = mocks.fetch.mock.calls[0];
  expect(url).toBe("http://127.0.0.1:17173/api/cloud-sync/enable");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ draft_id: "a".repeat(32), session_keys: ["websocket:one"], confirmed: true });
  expect(init.headers).not.toHaveProperty("Authorization");
});
it("resumes receiving without sending upload authorization or a request payload", async () => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ enabled: true }), { headers: { "Content-Type": "application/json" } }));
  await expect(cloudSyncApi.resume()).resolves.toEqual({ enabled: true });
  const [url, init] = mocks.fetch.mock.calls[0];
  expect(url).toBe("http://127.0.0.1:17173/api/cloud-sync/resume");
  expect(init.method).toBe("POST");
  expect(init).not.toHaveProperty("body");
});
it("passes explicit operations host and credential upload scope to enable and scope", async () => {
  respond({ enabled: true });
  await cloudSyncApi.enable("a".repeat(32), [], false, false, false, false, true, true);
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ draft_id: "a".repeat(32), session_keys: [], confirmed: true,
    sync_new_conversations: false, sync_planning: false, sync_notes: false, sync_preferences: false,
    sync_operations: true, sync_operations_credentials: true });
  respond({ selected_keys: [], sync_new_conversations: false, sync_planning: false, sync_preferences: false,
    sync_operations: true, sync_operations_credentials: true });
  await cloudSyncApi.scope([], false, false, false, false, true, true);
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({ session_keys: [], sync_new_conversations: false,
    sync_planning: false, sync_notes: false, sync_preferences: false, sync_operations: true, sync_operations_credentials: true });
});
it("never retries unknown writes and does not echo arbitrary network exceptions", async () => {
  mocks.fetch.mockRejectedValue(new Error("SYNTHETIC_INTERNAL_ENDPOINT_AND_TOKEN"));
  await expect(cloudSyncApi.prepare("synthetic-recovery")).rejects.toThrow("暂时无法连接云同步");
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
it("propagates structured local service refusal instead of false success", async () => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: "sync_disabled", message: "请先开启云同步。" } }),
    { status: 409, headers: { "Content-Type": "application/json" } }));
  await expect(cloudSyncApi.sync()).rejects.toMatchObject({ code: "sync_disabled", message: "请先开启云同步。" });
});

function respond(value: unknown) {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }));
}
it("history fetch carries a bounded cursor and validates the ordered result", async () => {
  respond({ items: [{ version: 4, created_at: "2026-10-12T00:00:00Z", deleted: false }], has_more: true, next_before: 4 });
  const controller = new AbortController();
  expect((await cloudSyncApi.history("a".repeat(32), 5, controller.signal)).items).toHaveLength(1);
  const init = mocks.fetch.mock.calls[0][1];
  expect(JSON.parse(init.body)).toEqual({ resource_id: "a".repeat(32), before: 5 });
  expect(init.signal).toBe(controller.signal);
});
it.each([
  { items: [], has_more: true, next_before: 5 },
  { items: [{ version: 5, created_at: "2026-10-12", deleted: false }], has_more: false, next_before: 5 },
  { items: [{ version: 4, created_at: "invalid", deleted: false }], has_more: false, next_before: 4 },
])("invalid history is never displayed as a successful empty result", async (value) => {
  respond(value);
  await expect(cloudSyncApi.history("a".repeat(32), 5)).rejects.toMatchObject({ code: "invalid_response" });
});
it("file downloads and restore validate the confirmed target and operation", async () => {
  respond({ downloaded: false, file_id: "b".repeat(64) });
  await expect(cloudSyncApi.download("a".repeat(32), "b".repeat(64))).rejects.toThrow("云端记录返回异常");
  respond({ restored: true, key: "development:some-project", reused: false });
  await expect(cloudSyncApi.restore("a".repeat(32), 2, "c".repeat(32))).rejects.toThrow("云端记录返回异常");
  respond({ restored: true, key: "websocket:restored-one", reused: true });
  await expect(cloudSyncApi.restore("a".repeat(32), 2, "c".repeat(32))).resolves.toMatchObject({ reused: true });
  expect(JSON.parse(mocks.fetch.mock.calls[2][1].body)).toEqual({ resource_id: "a".repeat(32), version: 2, request_id: "c".repeat(32), confirmed: true });
});
it("file listing rejects duplicate ids and malformed sizes", async () => {
  const item = { id: "b".repeat(64), name: "file.txt", size: 1, local: false };
  respond({ files: [item, item] });
  await expect(cloudSyncApi.files("a".repeat(32))).rejects.toMatchObject({ code: "invalid_response" });
  respond({ files: [{ ...item, size: -1 }] });
  await expect(cloudSyncApi.files("a".repeat(32))).rejects.toMatchObject({ code: "invalid_response" });
});
it("ordinary file opens never request cloud hydration", async () => {
  await ensureCloudFile("D:\\documents\\local.docx");
  await ensureCloudFile("/home/user/cloud/readme.md");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("hydrates only the exact immutable path and keeps the caller's abort signal", async () => {
  const path = `D:\\data\\cloud\\${"a".repeat(32)}\\${"b".repeat(64)}\\报告.docx`;
  const controller = new AbortController();
  respond({ available: true });
  await ensureCloudFile(path, "websocket:one", controller.signal);
  expect(mocks.fetch.mock.calls[0][0]).toBe("http://127.0.0.1:17173/api/cloud-sync/ensure-file");
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ path, session_key: "websocket:one" });
  expect(mocks.fetch.mock.calls[0][1].signal).toBe(controller.signal);
});
it.each([null, {}, { available: false }])("never reports incomplete hydration as success: %j", async (result) => {
  respond(result);
  await expect(ensureCloudFile(`/files/cloud/${"a".repeat(32)}/${"b".repeat(64)}/file.txt`))
    .rejects.toMatchObject({ code: result === null ? "service_unavailable" : "file_unavailable" });
});
it("rejects Code owners and cancelled opens before requesting any file", async () => {
  const path = `/files/cloud/${"a".repeat(32)}/${"b".repeat(64)}/file.txt`;
  await expect(ensureCloudFile(path, "development:one")).rejects.toMatchObject({ code: "invalid_response" });
  const controller = new AbortController(); controller.abort();
  await expect(ensureCloudFile(path, null, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("invalid resource never reaches the local service", async () => {
  await expect(cloudSyncApi.restore("../invalid", 1, "c".repeat(32))).rejects.toMatchObject({ code: "invalid_resource" });
  expect(mocks.fetch).not.toHaveBeenCalled();
});
