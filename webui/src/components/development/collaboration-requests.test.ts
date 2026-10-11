import { beforeEach, describe, expect, it, vi } from "vitest";
import { DevelopmentApiError, type DevCollaboration } from "@/lib/development-api";
import { collaborationSlot, dispatchCollaboration, type CollaborationPayload } from "./collaboration-requests";
import { useDevelopmentStore } from "./store";

const api = vi.hoisted(() => ({ delegate: vi.fn(), collaborationRequest: vi.fn() }));
const presets = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/development-api", async (original) => ({ ...(await original<typeof import("@/lib/development-api")>()), developmentApi: api }));
vi.mock("./workspace-api", () => ({ subagentApi: presets }));
const payload: CollaborationPayload = { executor: "mona", goal: "review exact diff", expectedOutput: "findings", readonly: true, presetId: "saved_reviewer" };
const record = (requestId: string, parentSessionId = "dev_a"): DevCollaboration => ({ id: "collab_record", parentSessionId,
  childSessionId: "dev_child", requestId, executor: "mona", goal: payload.goal, expectedOutput: payload.expectedOutput,
  readonly: true, state: "submitted", returnMessageId: null, sourceDiffSha: null, latestRun: null });
const pending = () => useDevelopmentStore.getState().collaborationRequests[collaborationSlot("dev_a", "review")];
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  api.collaborationRequest.mockResolvedValue(null);
  presets.run.mockImplementation(async (session: string, _preset: string, requestId: string) => record(requestId, session));
});

describe("durable collaboration request identity", () => {
  it("rejects new temporary delegation without persisting or sending a request", async () => {
    await expect(dispatchCollaboration("dev_a", "review", { ...payload, presetId: undefined })).rejects.toThrow("临时协作任务已移除");
    expect(api.delegate).not.toHaveBeenCalled(); expect(presets.run).not.toHaveBeenCalled();
    expect(pending()).toBeUndefined();
  });
  it("recovers an already accepted request by exact identity without dispatching it again", async () => {
    presets.run.mockRejectedValueOnce(new Error("response lost"));
    await expect(dispatchCollaboration("dev_a", "review", payload)).rejects.toThrow("response lost");
    const original = pending();
    const saved = JSON.parse(localStorage.getItem("mona.development.workbench.v1")!).state;
    expect(saved.collaborationRequests[collaborationSlot("dev_a", "review")]).toEqual(original);
    useDevelopmentStore.setState({ collaborationRequests: {} });
    localStorage.setItem("mona.development.workbench.v1", JSON.stringify({ state: saved, version: 2 }));
    await useDevelopmentStore.persist.rehydrate();
    expect(presets.run).toHaveBeenCalledTimes(1); expect(api.collaborationRequest).not.toHaveBeenCalled();
    api.collaborationRequest.mockResolvedValueOnce(record(original.requestId));
    const preflight = vi.fn();
    await dispatchCollaboration("dev_a", "review", payload, preflight);
    expect(api.collaborationRequest).toHaveBeenCalledWith("dev_a", original.requestId);
    expect(presets.run).toHaveBeenCalledTimes(1); expect(preflight).not.toHaveBeenCalled(); expect(pending()).toBeUndefined();
    expect(api.delegate).not.toHaveBeenCalled();
  });
  it("retries a missing request with the same exact original body and request id", async () => {
    presets.run.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(dispatchCollaboration("dev_a", "review", payload)).rejects.toThrow();
    const original = presets.run.mock.calls[0];
    await dispatchCollaboration("dev_a", "review", payload);
    expect(presets.run.mock.calls[1]).toEqual(original);
  });
  it("does not overwrite an unresolved request with edited goal or permissions", async () => {
    presets.run.mockRejectedValueOnce(new Error("unknown"));
    await expect(dispatchCollaboration("dev_a", "review", payload)).rejects.toThrow();
    const original = pending();
    await expect(dispatchCollaboration("dev_a", "review", { ...payload, readonly: false })).rejects.toThrow("核对原派发");
    expect(pending()).toBe(original); expect(presets.run).toHaveBeenCalledTimes(1);
  });
  it("deduplicates simultaneous clicks even while the first diff validation is pending", async () => {
    const gate = deferred<void>(); const preflight = vi.fn(() => gate.promise);
    const first = dispatchCollaboration("dev_a", "review", payload, preflight);
    expect(dispatchCollaboration("dev_a", "review", payload, preflight)).toBe(first);
    await expect(dispatchCollaboration("dev_a", "review", { ...payload, goal: "another task" })).rejects.toThrow();
    gate.resolve(); await first;
    expect(preflight).toHaveBeenCalledOnce(); expect(presets.run).toHaveBeenCalledOnce();
  });
  it("does not persist or dispatch a review rejected by its version preflight", async () => {
    await expect(dispatchCollaboration("dev_a", "review", payload, async () => { throw new Error("diff changed"); })).rejects.toThrow("diff changed");
    expect(api.delegate).not.toHaveBeenCalled(); expect(presets.run).not.toHaveBeenCalled(); expect(pending()).toBeUndefined();
  });
  it("keeps an uncertain request if the status lookup fails and does not resend", async () => {
    presets.run.mockRejectedValueOnce(new Error("unknown"));
    await expect(dispatchCollaboration("dev_a", "review", payload)).rejects.toThrow();
    api.collaborationRequest.mockRejectedValueOnce(new Error("read unavailable"));
    await expect(dispatchCollaboration("dev_a", "review", payload)).rejects.toThrow("read unavailable");
    expect(presets.run).toHaveBeenCalledTimes(1); expect(pending()).toBeDefined();
  });
  it("allows correction after a definite validation rejection", async () => {
    presets.run.mockRejectedValueOnce(new DevelopmentApiError(422, "invalid_collaboration", "invalid goal"));
    await expect(dispatchCollaboration("dev_a", "review", payload)).rejects.toThrow("invalid goal");
    expect(pending()).toBeUndefined();
    await dispatchCollaboration("dev_a", "review", { ...payload, goal: "corrected" });
    expect(presets.run).toHaveBeenCalledTimes(2);
  });
  it("observes the original preset request after that preset changed without using a new route", async () => {
    const configured = { ...payload, presetId: "reviewer" };
    presets.run.mockRejectedValueOnce(new Error("lost response"));
    await expect(dispatchCollaboration("dev_a", "review", configured)).rejects.toThrow();
    api.collaborationRequest.mockResolvedValueOnce(record(pending().requestId));
    await dispatchCollaboration("dev_a", "review", configured);
    expect(presets.run).toHaveBeenCalledTimes(1); expect(api.delegate).not.toHaveBeenCalled();
    expect(presets.run.mock.calls[0][5]).toBe(true);
  });
  it("retains the exact review version after a lost reply and refuses a different version", async () => {
    const versioned = { ...payload, reviewSource: { path: "src/a.ts", version: "a".repeat(64) } };
    presets.run.mockRejectedValueOnce(new Error("reply lost"));
    await expect(dispatchCollaboration("dev_a", "review", versioned)).rejects.toThrow("reply lost");
    const original = pending();
    expect(original.payload.reviewSource).toEqual(versioned.reviewSource);
    await expect(dispatchCollaboration("dev_a", "review", { ...versioned,
      reviewSource: { path: "src/a.ts", version: "b".repeat(64) } })).rejects.toThrow("核对原派发");
    api.collaborationRequest.mockResolvedValueOnce(record(original.requestId));
    await dispatchCollaboration("dev_a", "review", versioned);
    expect(presets.run).toHaveBeenCalledTimes(1); expect(pending()).toBeUndefined();
  });
  it("allows rereading after the server definitively rejects stale review evidence", async () => {
    presets.run.mockRejectedValueOnce(new DevelopmentApiError(422, "review_source_changed", "代码已变化"));
    await expect(dispatchCollaboration("dev_a", "review", { ...payload,
      reviewSource: { path: "src/a.ts", version: "a".repeat(64) } })).rejects.toThrow("代码已变化");
    expect(pending()).toBeUndefined();
    await dispatchCollaboration("dev_a", "review", { ...payload,
      reviewSource: { path: "src/a.ts", version: "b".repeat(64) } });
    expect(presets.run).toHaveBeenCalledTimes(2);
    expect(presets.run.mock.calls[0][2]).not.toBe(presets.run.mock.calls[1][2]);
    expect(presets.run.mock.calls[1][6]).toEqual({ path: "src/a.ts", version: "b".repeat(64) });
  });
  it("keeps review requests in different sessions independent", async () => {
    await Promise.all([dispatchCollaboration("dev_a", "review", payload),
      dispatchCollaboration("dev_b", "review", payload)]);
    expect(presets.run).toHaveBeenCalledTimes(2);
    expect(new Set(presets.run.mock.calls.map(([, , requestId]) => requestId)).size).toBe(2);
    expect(api.delegate).not.toHaveBeenCalled();
  });
});
