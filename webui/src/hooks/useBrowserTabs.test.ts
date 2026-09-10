import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createBrowserTabId,
  mergeServerTabs,
  shouldPersistBrowserSession,
  useBrowserTabs,
  type Tab,
} from "./useBrowserTabs";

const monaTab: Tab = {
  id: "mona",
  type: "mona",
  title: "Mona",
  isAiControlled: false,
  webviewCreated: false,
};

describe("mergeServerTabs", () => {
  it("keeps a local browser tab while the initial server list is empty", () => {
    const localBrowserTab: Tab = {
      id: "tab-local",
      type: "browser",
      title: "Example Domain",
      url: "https://example.com",
      isAiControlled: false,
      webviewCreated: true,
    };

    expect(mergeServerTabs([monaTab, localBrowserTab], [])).toEqual([
      monaTab,
      localBrowserTab,
    ]);
  });
});

describe("browser session persistence", () => {
  it("is disabled in every environment", () => {
    expect(shouldPersistBrowserSession(true)).toBe(false);
    expect(shouldPersistBrowserSession(false)).toBe(false);
  });
});

describe("browser tab ids", () => {
  it("uses collision-resistant UUIDs instead of a resettable counter", () => {
    const first = createBrowserTabId();
    const second = createBrowserTabId();

    expect(first).toMatch(/^tab-[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });
});

describe("local document tab callbacks", () => {
  it("keeps the canvas opener stable while tabs change", () => {
    const { result } = renderHook(() => useBrowserTabs());
    const openCanvas = result.current.addCanvasReaderTab;

    act(() => openCanvas("D:\\workspace\\diagram.mona-canvas"));

    expect(result.current.tabs.some((tab) => tab.canvasFilePath === "D:\\workspace\\diagram.mona-canvas")).toBe(true);
    expect(result.current.addCanvasReaderTab).toBe(openCanvas);
  });
});
