import { beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/tauri", () => ({
  httpFetch: boundary.fetch, isTauri: () => false, getGatewayStatus: vi.fn(), getServicesStatus: vi.fn(),
}));
import { fetchFilePreviewBlob } from "./api";

beforeEach(() => boundary.fetch.mockReset());
it("shows the actionable cloud refusal without fetching an alternate version", async () => {
  boundary.fetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: "account_changed", message: "请切回文件所属账号后重试。" } }),
    { status: 409, headers: { "Content-Type": "application/json" } }));
  await expect(fetchFilePreviewBlob("local-token", { scope: "shared", path: "file.docx", sessionKey: "websocket:one" }))
    .rejects.toMatchObject({ status: 409, message: "请切回文件所属账号后重试。" });
  expect(boundary.fetch).toHaveBeenCalledTimes(1);
});
it("does not print an unrelated internal failure body as the preview message", async () => {
  boundary.fetch.mockResolvedValue(new Response(JSON.stringify({ detail: "SYNTHETIC_PRIVATE_INTERNAL_DETAILS" }),
    { status: 500, headers: { "Content-Type": "application/json" } }));
  await expect(fetchFilePreviewBlob("local-token", { scope: "shared", path: "file.docx", sessionKey: "websocket:one" }))
    .rejects.toMatchObject({ status: 500, message: "HTTP 500" });
});
it("passes cancellation to the real fetch boundary without automatic retries", async () => {
  const controller = new AbortController();
  const aborted = new DOMException("Cancelled", "AbortError");
  boundary.fetch.mockRejectedValueOnce(aborted);
  await expect(fetchFilePreviewBlob("local-token", { scope: "shared", path: "file.docx", sessionKey: "websocket:one", signal: controller.signal }))
    .rejects.toBe(aborted);
  expect(boundary.fetch).toHaveBeenCalledTimes(1);
  expect(boundary.fetch.mock.calls[0][1].signal).toBe(controller.signal);
});
