import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevSnapshot } from "@/lib/development-api";
import { useDevelopmentStore } from "./store";
import { useDevelopmentSession } from "./useDevelopmentSession";
const api = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("@/lib/development-api", async (original) => ({ ...(await original<typeof import("@/lib/development-api")>()), developmentApi: api }));
const snapshot: DevSnapshot = { session: { id: "watch_a", projectId: "project_a", title: "A", executor: "mona", model: null, readonly: false, parentSessionId: null, archived: false, pinned: false, revision: 0, updatedAt: "" }, messages: [], runs: [], events: [], pendingInputs: [], before: null, messageCount: 0, live: null, eventCursor: 0, watchVersion: "server:1" };
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("development event-driven observation", () => {
  it("holds a single read until the server wakes it instead of polling idle snapshots", async () => {
    let reply: (value: DevSnapshot) => void = () => {};
    api.snapshot.mockResolvedValueOnce(snapshot).mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; })).mockImplementation(() => new Promise(() => {}));
    renderHook(() => useDevelopmentSession("watch_a"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.snapshot).toHaveBeenCalledTimes(2);
    expect(api.snapshot.mock.calls[1]).toEqual(["watch_a", 0, undefined, "server:1"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    expect(api.snapshot).toHaveBeenCalledTimes(2);
    await act(async () => { reply({ ...snapshot, watchVersion: "server:2", live: { runId: "run_a", content: "new text" } }); await vi.advanceTimersByTimeAsync(1); });
    expect(useDevelopmentStore.getState().snapshots.watch_a.live?.content).toBe("new text");
    expect(api.snapshot.mock.calls[2][3]).toBe("server:2");
  });
  it("shares observers and ignores a late response after the last view closes", async () => {
    let reply: (value: DevSnapshot) => void = () => {};
    api.snapshot.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    const a = renderHook(() => useDevelopmentSession("watch_a"));
    const b = renderHook(() => useDevelopmentSession("watch_a"));
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    a.unmount(); b.unmount();
    await act(async () => { reply(snapshot); await vi.advanceTimersByTimeAsync(10000); });
    expect(useDevelopmentStore.getState().snapshots.watch_a).toBeUndefined();
    expect(api.snapshot).toHaveBeenCalledTimes(1);
  });
  it("drains pending event pages without entering an idle wait", async () => {
    api.snapshot.mockResolvedValueOnce({ ...snapshot, eventCursor: 100, moreEvents: true }).mockImplementation(() => new Promise(() => {}));
    renderHook(() => useDevelopmentSession("watch_a"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.snapshot.mock.calls[1]).toEqual(["watch_a", 100, undefined, undefined]);
  });
});
