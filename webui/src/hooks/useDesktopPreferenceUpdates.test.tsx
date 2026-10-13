import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ listen: vi.fn(), read: vi.fn(), stop: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("@/lib/tauri", () => ({ isTauri: native.isTauri, getDesktopSettings: native.read,
  SEND_MESSAGE_SHORTCUT_EVENT: "mona:send-message-shortcut" }));
import { useDesktopPreferenceUpdates } from "./useDesktopPreferenceUpdates";

const settings = { default_view: "note", send_message_shortcut: "ctrl_enter", sidebar_modules: [{ key: "note", visible: true, order: 0 }] };
beforeEach(() => {
  native.listen.mockReset().mockResolvedValue(native.stop);
  native.read.mockReset().mockResolvedValue(settings);
  native.stop.mockReset(); native.isTauri.mockReturnValue(true);
});
async function start() {
  const callback = vi.fn();
  const hook = renderHook(() => useDesktopPreferenceUpdates(callback));
  await act(async () => { await Promise.resolve(); });
  const emit = () => native.listen.mock.calls[0][1]({ payload: { default_view: "run-command", access_token: "not-used" } });
  return { ...hook, callback, emit };
}
it("reads committed native settings rather than using event content and does not change views itself", async () => {
  const send = vi.fn(); window.addEventListener("mona:send-message-shortcut", send);
  const { callback, emit } = await start();
  expect(native.read).not.toHaveBeenCalled();
  await act(async () => { emit(); });
  expect(callback).toHaveBeenCalledWith(settings);
  expect(send.mock.calls[0][0].detail).toBe("ctrl_enter");
  window.removeEventListener("mona:send-message-shortcut", send);
});
it("ignores late results after unmount", async () => {
  let finish!: (value: unknown) => void;
  native.read.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { emit, unmount, callback } = await start();
  act(emit); unmount();
  await act(async () => finish(settings));
  expect(callback).not.toHaveBeenCalled(); expect(native.stop).toHaveBeenCalledOnce();
});
it("discards an earlier response when a newer native update arrives", async () => {
  let first!: (value: unknown) => void;
  native.read.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; })).mockResolvedValueOnce(settings);
  const { emit, callback } = await start();
  act(emit); await act(async () => { emit(); });
  await act(async () => first({ ...settings, send_message_shortcut: "enter" }));
  expect(callback).toHaveBeenCalledTimes(1); expect(callback).toHaveBeenCalledWith(settings);
});
it("does not subscribe outside the native desktop", async () => {
  native.isTauri.mockReturnValue(false);
  renderHook(() => useDesktopPreferenceUpdates(vi.fn()));
  await act(async () => { await Promise.resolve(); });
  expect(native.listen).not.toHaveBeenCalled();
});
