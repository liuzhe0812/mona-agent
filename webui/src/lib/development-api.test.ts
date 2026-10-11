import { afterEach, beforeEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ base: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ getGatewayHttpBase: transport.base }));
vi.mock("@/lib/tauri", () => ({ httpFetch: transport.fetch }));

import { DevelopmentApiError, developmentApi, developmentRequest } from "./development-api";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  transport.base.mockResolvedValue("http://localhost");
});
afterEach(() => { vi.useRealTimers(); });

it.each([
  ["projects", () => developmentApi.projects(), "/projects"],
  ["sessions", () => developmentApi.sessions("project"), "/projects/project/sessions"],
  ["subtasks", () => developmentApi.collaborations("parent"), "/sessions/parent/collaborations"],
] as const)("recovers the first failed %s read before reporting an error", async (_name, read, path) => {
  const rows = [{ id: "existing" }];
  transport.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(json(rows));
  const result = read();
  const check = expect(result).resolves.toEqual(rows);
  await vi.advanceTimersByTimeAsync(249);
  expect(transport.fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await check;
  expect(transport.fetch).toHaveBeenCalledTimes(2);
  expect(transport.fetch.mock.calls[1][0]).toBe(`http://localhost/api/development${path}`);
});

it.each([502, 503, 504])("recovers a temporary HTTP %s read failure", async (status) => {
  transport.fetch.mockResolvedValueOnce(new Response("temporarily unavailable", { status })).mockResolvedValueOnce(json([]));
  const check = expect(developmentApi.projects()).resolves.toEqual([]);
  await vi.runAllTimersAsync(); await check;
  expect(transport.fetch).toHaveBeenCalledTimes(2);
});

it("reports the final transport failure after three reads", async () => {
  const error = new Error("service still unavailable");
  transport.fetch.mockRejectedValue(error);
  const check = expect(developmentApi.projects()).rejects.toBe(error);
  await vi.runAllTimersAsync(); await check;
  expect(transport.fetch).toHaveBeenCalledTimes(3);
});

it.each([401, 403, 404, 409, 422, 500, 503])("preserves an explicit HTTP %s business failure without retrying", async (status) => {
  transport.fetch.mockResolvedValue(json({ error: { code: "explicit_failure", message: "读取无法完成" } }, status));
  const check = expect(developmentApi.projects()).rejects.toMatchObject({
    status, code: "explicit_failure", message: "读取无法完成",
  });
  await vi.runAllTimersAsync(); await check;
  expect(transport.fetch).toHaveBeenCalledTimes(1);
});

it.each(["POST", "PUT", "DELETE"])("does not repeat an uncertain %s operation", async (method) => {
  const error = new TypeError("response lost");
  transport.fetch.mockRejectedValue(error);
  const check = expect(developmentRequest("/sessions/parent", method, { revision: 1 })).rejects.toBe(error);
  await vi.runAllTimersAsync(); await check;
  expect(transport.fetch).toHaveBeenCalledTimes(1);
  expect(transport.fetch.mock.calls[0][1]).toMatchObject({ method, body: '{"revision":1}' });
});

it("stops a read cancelled during retry backoff", async () => {
  const controller = new AbortController();
  transport.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
  const check = expect(developmentRequest("/projects", "GET", undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await check; await vi.runAllTimersAsync();
  expect(transport.fetch).toHaveBeenCalledTimes(1);
});

it("does not retry a malformed success response", async () => {
  transport.fetch.mockResolvedValue(new Response("{", { headers: { "Content-Type": "application/json" } }));
  const check = expect(developmentApi.projects()).rejects.toBeInstanceOf(SyntaxError);
  await vi.runAllTimersAsync(); await check;
  expect(transport.fetch).toHaveBeenCalledTimes(1);
});

it("keeps a non-JSON response failure visible after retries are exhausted", async () => {
  transport.fetch.mockImplementation(async () => new Response("temporarily unavailable", { status: 503 }));
  const check = expect(developmentApi.projects()).rejects.toBeInstanceOf(DevelopmentApiError);
  await vi.runAllTimersAsync(); await check;
  expect(transport.fetch).toHaveBeenCalledTimes(3);
});
