import { describe, expect, it, vi } from "vitest";
import { createTabBoundsOwner, createWebviewBoundsQueue, type WebviewBounds } from "./webviewBoundsQueue";

const shown: WebviewBounds = { left: 500, top: 100, width: 400, height: 600, visible: true };
const hidden = { ...shown, visible: false };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

describe("native tab layout ownership across remounts", () => {
  it("waits for an old hide before showing the same tab in a new view", async () => {
    const hide = deferred(); const send = vi.fn().mockResolvedValue(undefined);
    const old = createTabBoundsOwner("remount", send, vi.fn()); old.activate();
    await old.update(shown);
    send.mockImplementationOnce(() => hide.promise);
    const closing = old.dispose();
    const next = createTabBoundsOwner("remount", send, vi.fn()); next.activate();
    const opening = next.update({ ...shown, width: 700 });
    expect(send).toHaveBeenCalledTimes(2);
    hide.resolve(); await Promise.all([closing, opening]);
    expect(send.mock.calls.map(([bounds]) => [bounds.visible, bounds.width])).toEqual([[true, 400], [false, 400], [true, 700]]);
    await old.dispose(); await old.update(hidden);
    expect(send).toHaveBeenCalledTimes(3);
    await next.dispose();
  });
  it("revokes the old view before its cleanup or delayed resize can affect the new view", async () => {
    const gate = deferred(); const send = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
    const old = createTabBoundsOwner("takeover", send, vi.fn()); old.activate();
    const started = old.update(shown);
    const next = createTabBoundsOwner("takeover", send, vi.fn()); next.activate();
    const opening = next.update({ ...shown, width: 650 });
    await old.dispose(); await old.update(hidden);
    gate.resolve(); await Promise.all([started, opening]);
    expect(send.mock.calls.map(([bounds]) => [bounds.visible, bounds.width])).toEqual([[true, 400], [true, 650]]);
    await next.dispose();
  });
  it("keeps different native tabs independent and releases completed ownership", async () => {
    const first = vi.fn().mockResolvedValue(undefined), second = vi.fn().mockResolvedValue(undefined);
    const a = createTabBoundsOwner("tab-a", first, vi.fn()), b = createTabBoundsOwner("tab-b", second, vi.fn());
    a.activate(); b.activate(); await a.update(shown); await b.update(shown); await a.dispose();
    expect(second).toHaveBeenCalledTimes(1);
    await b.dispose();
    const replacement = createTabBoundsOwner("tab-a", second, vi.fn()); replacement.activate();
    await replacement.update(shown);
    expect(second).toHaveBeenLastCalledWith(shown);
    expect(first).toHaveBeenCalledTimes(2);
    await replacement.dispose();
  });
});

describe("native webview bounds lifetime", () => {
  it("sends a final hide even when the previously applied state was hidden", async () => {
    const gate = deferred();
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = createWebviewBoundsQueue(send, vi.fn());
    await queue.update(hidden);
    send.mockImplementationOnce(() => gate.promise);
    const started = queue.update(shown);
    queue.update(hidden);
    gate.resolve(); await started;
    expect(send.mock.calls.map(([bounds]) => bounds.visible)).toEqual([false, true, false]);
  });
  it("coalesces resize bursts without overlapping native requests", async () => {
    const gate = deferred(); const send = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
    const queue = createWebviewBoundsQueue(send, vi.fn());
    const started = queue.update(shown);
    queue.update({ ...shown, width: 600 }); queue.update({ ...shown, width: 700 });
    expect(send).toHaveBeenCalledTimes(1);
    gate.resolve(); await started;
    expect(send.mock.calls.map(([bounds]) => bounds.width)).toEqual([400, 700]);
  });
  it("unmount replaces a pending show and ignores late layout callbacks", async () => {
    const gate = deferred(); const send = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
    const queue = createWebviewBoundsQueue(send, vi.fn());
    const started = queue.update(shown); queue.update({ ...shown, width: 700 });
    queue.dispose(); queue.update(shown);
    gate.resolve(); await started;
    expect(send.mock.calls.map(([bounds]) => bounds.visible)).toEqual([true, false]);
  });
  it("hides after a failed in-flight operation without retrying that operation", async () => {
    const gate = deferred(); const error = new Error("closed during resize");
    const send = vi.fn().mockImplementationOnce(async () => { await gate.promise; throw error; }).mockResolvedValue(undefined);
    const report = vi.fn(); const queue = createWebviewBoundsQueue(send, report);
    const started = queue.update(shown); queue.dispose(); gate.resolve(); await started;
    expect(send).toHaveBeenCalledTimes(2); expect(send).toHaveBeenLastCalledWith(hidden);
    expect(report).toHaveBeenCalledWith(error);
  });
  it("does not trust a formerly hidden state after a partially failed show", async () => {
    const gate = deferred(); const send = vi.fn().mockResolvedValue(undefined);
    const queue = createWebviewBoundsQueue(send, vi.fn());
    await queue.update(hidden);
    send.mockImplementationOnce(async () => { await gate.promise; throw new Error("show outcome unknown"); });
    const started = queue.update(shown); queue.dispose(); gate.resolve(); await started;
    expect(send.mock.calls.map(([bounds]) => bounds.visible)).toEqual([false, true, false]);
  });
  it("supports React effect reactivation without creating resources", async () => {
    const send = vi.fn().mockResolvedValue(undefined); const queue = createWebviewBoundsQueue(send, vi.fn());
    await queue.dispose(); expect(send).not.toHaveBeenCalled();
    queue.activate(); await queue.update(shown); await queue.update(shown); await queue.dispose();
    expect(send.mock.calls.map(([bounds]) => bounds.visible)).toEqual([true, false]);
  });
});
