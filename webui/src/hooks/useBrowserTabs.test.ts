import { act, renderHook, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBrowserTabId,
  mergeServerTabs,
  shouldPersistBrowserSession,
  useBrowserTabs,
  type Tab,
} from "./useBrowserTabs";

afterEach(() => {
  clearMocks();
  delete window.__TAURI_INTERNALS__;
});

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

it("keeps conversation pages outside top tab activation and bulk close", async () => {
  mockIPC((command) => command === "browser_list_tabs" ? [] : undefined, { shouldMockEvents: true });
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} } });
  const { result, unmount } = renderHook(() => useBrowserTabs());
  const create = (id: string, conversationId?: string) => act(() => emit("browser-tab-created", {
    id, title: id, url: "https://example.com/", conversation_id: conversationId,
  }));
  await waitFor(async () => {
    await create("page-a", "chat-a");
    expect(result.current.tabs.find((tab) => tab.id === "page-a")?.conversationId).toBe("chat-a");
  });
  expect(result.current.activeTabId).toBe("mona");

  await create("top-a");
  await create("top-b");
  expect(result.current.activeTabId).toBe("top-b");
  await act(() => result.current.closeOtherTabs("top-b"));
  expect(result.current.tabs.map((tab) => tab.id)).toEqual(["mona", "page-a", "top-b"]);
  unmount();
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
