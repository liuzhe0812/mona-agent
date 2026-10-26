import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktop: true,
  invoke: vi.fn(),
  emitTo: vi.fn(),
  listen: vi.fn(),
  show: vi.fn(),
  unminimize: vi.fn(),
  setFocus: vi.fn(),
  message: vi.fn(),
}));

vi.mock("./tauri", () => ({ isTauri: () => mocks.desktop }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo, listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: mocks.message }));

import { listenForBrowserUrls, openBrowserUrl } from "./browser-ipc";

describe("web links opening in the main browser", () => {
  beforeEach(() => {
    mocks.desktop = true;
    for (const mock of [mocks.invoke, mocks.emitTo, mocks.show, mocks.unminimize, mocks.setFocus, mocks.message]) {
      mock.mockReset().mockResolvedValue(undefined);
    }
    mocks.listen.mockReset().mockResolvedValue(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("routes a preview request to main, creates one native tab and restores the main window", async () => {
    const onOpen = vi.fn();
    await listenForBrowserUrls(onOpen);
    const [eventName, receive] = mocks.listen.mock.calls[0];
    mocks.emitTo.mockImplementation(async (_target, _event, payload) => receive({ payload }));

    await openBrowserUrl("https://example.com/task?id=42");

    expect(mocks.emitTo).toHaveBeenCalledWith("main", eventName, { url: "https://example.com/task?id=42" });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("browser_create_tab", {
      id: expect.stringMatching(/^tab-[0-9a-f-]{36}$/),
      url: "https://example.com/task?id=42", isIncognito: false, adBlockEnabled: true,
    });
    expect(mocks.show).toHaveBeenCalledOnce();
    expect(mocks.unminimize).toHaveBeenCalledOnce();
    expect(mocks.setFocus).toHaveBeenCalledOnce();
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("rejects unsafe schemes at both sides of the window boundary", async () => {
    await expect(openBrowserUrl("javascript:alert(1)")).rejects.toThrow();
    expect(mocks.emitTo).not.toHaveBeenCalled();
    const onOpen = vi.fn();
    await listenForBrowserUrls(onOpen);
    await mocks.listen.mock.calls[0][1]({ payload: { url: "file:///C:/private.txt" } });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(mocks.message).toHaveBeenCalledOnce();
  });

  it("reports native creation failure without retrying or claiming a tab was opened", async () => {
    mocks.invoke.mockRejectedValue(new Error("native failure"));
    await listenForBrowserUrls(vi.fn());
    await mocks.listen.mock.calls[0][1]({ payload: { url: "https://example.com" } });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.setFocus).not.toHaveBeenCalled();
    expect(mocks.message).toHaveBeenCalledWith("链接未能打开，请重试。", { title: "打开链接失败", kind: "error" });
  });

  it("preserves the created tab result if restoring the main window fails", async () => {
    mocks.setFocus.mockRejectedValue(new Error("focus failure"));
    await listenForBrowserUrls(vi.fn());
    await mocks.listen.mock.calls[0][1]({ payload: { url: "https://example.com" } });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.message).toHaveBeenCalledWith("网页已在新标签页打开，请切回 Mona 查看。", {
      title: "请切回 Mona 查看", kind: "info",
    });
  });

  it("uses a safe browser fallback outside the desktop app", async () => {
    mocks.desktop = false;
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openBrowserUrl("https://example.com");
    expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });
});
