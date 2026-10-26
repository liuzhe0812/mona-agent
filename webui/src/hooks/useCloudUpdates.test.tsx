import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ listen: vi.fn(), isTauri: vi.fn(), stop: vi.fn(), loadSavedConnections: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: state.listen }));
vi.mock("@/lib/tauri", () => ({ isTauri: state.isTauri }));
vi.mock("@/components/terminal/store/terminalStore", () => ({ useTerminalStore: { getState: () => ({ loadSavedConnections: state.loadSavedConnections }) } }));
import { useCloudUpdates } from "./useCloudUpdates";

beforeEach(() => {
  vi.useFakeTimers();
  state.isTauri.mockReturnValue(true);
  state.stop.mockReset();
  state.loadSavedConnections.mockReset().mockResolvedValue(undefined);
  state.listen.mockReset().mockResolvedValue(state.stop);
});
afterEach(() => { vi.useRealTimers(); });

async function setup(callback = vi.fn()) {
  const hook = renderHook(({ cb }) => useCloudUpdates(cb), { initialProps: { cb: callback } });
  await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
  expect(state.listen).toHaveBeenCalledWith("mona-cloud-updated", expect.any(Function));
  expect(state.listen).toHaveBeenCalledWith("operations-connections-changed", expect.any(Function));
  const emit = (payload: unknown) => state.listen.mock.calls.find(([event]) => event === "mona-cloud-updated")![1]({ payload });
  const emitOperations = () => state.listen.mock.calls.find(([event]) => event === "operations-connections-changed")![1]({ payload: undefined });
  return { ...hook, emit, emitOperations, callback };
}

it("coalesces successful imports and passes no source payload or credentials to consumers", async () => {
  const { callback, emit } = await setup();
  act(() => {
    emit({ work_keys: ["websocket:a"], planning: false, content: "private" });
    emit({ work_keys: ["websocket:a", "websocket:b"], planning: true, binding: "private" });
  });
  expect(callback).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(75); });
  expect(callback).toHaveBeenCalledOnce();
  expect(callback).toHaveBeenCalledWith({ work_keys: ["websocket:a", "websocket:b"], planning: true });
});

it("uses the current consumer without re-registering native listeners", async () => {
  const { callback, emit, rerender } = await setup();
  const next = vi.fn();
  rerender({ cb: next });
  act(() => { emit({ work_keys: [], planning: true }); vi.advanceTimersByTime(75); });
  expect(callback).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
  expect(state.listen).toHaveBeenCalledTimes(2);
});

it("refreshes the saved host list after an operations import without opening a connection", async () => {
  const { emitOperations } = await setup();
  await act(async () => { emitOperations(); await Promise.resolve(); await Promise.resolve(); });
  expect(state.loadSavedConnections).toHaveBeenCalledOnce();
});

it.each([null, {}, { work_keys: ["development:x"], planning: false },
  { work_keys: ["websocket:../x"], planning: true }, { work_keys: [], planning: "true" },
  { work_keys: Array(101).fill("websocket:a"), planning: false },
])("rejects malformed and non-Work native events: %j", async (payload) => {
  const { callback, emit } = await setup();
  act(() => { emit(payload); vi.advanceTimersByTime(100); });
  expect(callback).not.toHaveBeenCalled();
});

it("cancels pending refreshes and releases a late native subscription on unmount", async () => {
  let ready!: (stop: () => void) => void;
  state.listen.mockReturnValue(new Promise((resolve) => { ready = resolve; }));
  const callback = vi.fn();
  const { unmount } = renderHook(() => useCloudUpdates(callback));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const emit = (payload: unknown) => state.listen.mock.calls[0][1]({ payload });
  act(() => emit({ work_keys: ["websocket:a"], planning: false }));
  unmount();
  await act(async () => { ready(state.stop); await Promise.resolve(); vi.advanceTimersByTime(100); });
  expect(callback).not.toHaveBeenCalled();
  expect(state.stop).toHaveBeenCalledOnce();
});

it("does not create a native subscription outside the desktop host", async () => {
  state.isTauri.mockReturnValue(false);
  renderHook(() => useCloudUpdates(vi.fn()));
  await act(async () => { await Promise.resolve(); });
  expect(state.listen).not.toHaveBeenCalled();
});
