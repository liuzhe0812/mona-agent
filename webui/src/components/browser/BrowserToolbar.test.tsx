import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserToolbar } from "./BrowserToolbar";

const popup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const close = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const menuNew = vi.hoisted(() => vi.fn().mockResolvedValue({ popup, close }));
const showAddressSuggestions = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const hideAddressSuggestions = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const showDownloads = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const toggleDownloads = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: menuNew } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));
vi.mock("@/hooks/useDownloads", () => ({
  useDownloads: () => ({
    downloads: [],
    hasActiveDownloads: false,
    cancelDownload: vi.fn(),
    pauseDownload: vi.fn(),
    resumeDownload: vi.fn(),
    openDownload: vi.fn(),
    revealDownload: vi.fn(),
    removeDownload: vi.fn(),
    clearCompleted: vi.fn(),
  }),
}));
vi.mock("@/lib/browser-ipc", () => ({
  browserIsBookmarked: vi.fn().mockResolvedValue(false),
  browserAddBookmark: vi.fn(),
  browserRemoveBookmark: vi.fn(),
  browserSearchSuggestions: vi.fn().mockResolvedValue([]),
  browserShowAddressSuggestions: showAddressSuggestions,
  browserHideAddressSuggestions: hideAddressSuggestions,
  browserShowDownloads: showDownloads,
  browserToggleDownloads: toggleDownloads,
  browserListenAddressSuggestionSelected: vi.fn().mockResolvedValue(vi.fn()),
  browserClearHistory: vi.fn(),
  browserClearCache: vi.fn(),
  browserImportBookmarks: vi.fn(),
}));

describe("BrowserToolbar", () => {
  beforeEach(() => {
    // 组件 useEffect 通过动态 import("@tauri-apps/api/event") 注册下载监听；
    // 动态 import 的外部化模块可能绕过 vi.mock，此时真实 listen 需要
    // window.__TAURI_INTERNALS__ 存在，否则会抛 unhandled rejection。
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        transformCallback: () => 0,
        unregisterListener: () => {},
        invoke: vi.fn().mockResolvedValue(0),
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      value: { unregisterListener: () => {} },
      configurable: true,
      writable: true,
    });
    menuNew.mockClear();
    popup.mockClear();
    close.mockClear();
    showAddressSuggestions.mockClear();
    hideAddressSuggestions.mockClear();
    showDownloads.mockClear();
    toggleDownloads.mockClear();
  });

  it("renders address suggestions inline instead of a native window", async () => {
    vi.useFakeTimers();
    try {
      const suggestion = {
        url: "https://example.com/article",
        title: "Example article",
        isBookmark: false,
        visitCount: 1,
        lastVisitedAt: "2026-07-15T00:00:00Z",
      };
      const { browserSearchSuggestions } = await import("@/lib/browser-ipc");
      vi.mocked(browserSearchSuggestions).mockResolvedValueOnce([suggestion]);

      render(
        <BrowserToolbar
          url="https://example.com"
          title="Example"
          isAiControlled={false}
          isAiPanelOpen={false}
          bookmarkBarVisible={true}
          onNavigate={vi.fn()}
          onGoBack={vi.fn()}
          onGoForward={vi.fn()}
          onReload={vi.fn()}
          onToggleAiPanel={vi.fn()}
          onToggleBookmarkBar={vi.fn()}
        />,
      );

      fireEvent.change(screen.getByPlaceholderText("输入网址或搜索..."), {
        target: { value: "example" },
      });
      await act(async () => vi.advanceTimersByTimeAsync(200));

      // 地址建议通过内联浮层渲染，不再调用原生窗口 IPC
      expect(showAddressSuggestions).not.toHaveBeenCalled();
      expect(screen.getByText("Example article")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a native menu without opening the WebView-hiding overlay", async () => {
    const onFind = vi.fn();
    const onCreateNote = vi.fn();

    render(
      <BrowserToolbar
        url="https://example.com"
        title="Example"
        isAiControlled={false}
        isAiPanelOpen={false}
        bookmarkBarVisible={true}
        onNavigate={vi.fn()}
        onGoBack={vi.fn()}
        onGoForward={vi.fn()}
        onReload={vi.fn()}
        onToggleAiPanel={vi.fn()}
        onToggleBookmarkBar={vi.fn()}
        onFind={onFind}
        onCreateNote={onCreateNote}
      />,
    );

    fireEvent.click(screen.getByTitle("选项"));

    await waitFor(() => expect(menuNew).toHaveBeenCalledTimes(1));
    expect(popup).toHaveBeenCalledTimes(1);

    const items = menuNew.mock.calls.at(-1)?.[0].items as Array<{ text?: string; action?: () => void }>;
    const findItem = items.find((item) => item.text === "查找 (Ctrl+F)");
    expect(findItem).toBeDefined();
    findItem?.action?.();
    expect(onFind).toHaveBeenCalledTimes(1);

    const createNoteItem = items.find((item) => item.text === "生成 Markdown 笔记");
    expect(createNoteItem).toBeUndefined();
  });

  it("triggers note creation from the toolbar button", () => {
    const onCreateNote = vi.fn();

    render(
      <BrowserToolbar
        url="https://example.com"
        title="Example"
        isAiControlled={false}
        isAiPanelOpen={false}
        bookmarkBarVisible={true}
        onNavigate={vi.fn()}
        onGoBack={vi.fn()}
        onGoForward={vi.fn()}
        onReload={vi.fn()}
        onToggleAiPanel={vi.fn()}
        onToggleBookmarkBar={vi.fn()}
        onCreateNote={onCreateNote}
      />,
    );

    fireEvent.click(screen.getByTitle("提取为笔记"));

    expect(onCreateNote).toHaveBeenCalledTimes(1);
  });

  it("opens downloads from a conventional toolbar button", () => {
    vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 720,
      top: 12,
      right: 744,
      bottom: 36,
      width: 24,
      height: 24,
    } as DOMRect);

    render(
      <BrowserToolbar
        url="https://example.com"
        title="Example"
        isAiControlled={false}
        isAiPanelOpen={false}
        bookmarkBarVisible={true}
        onNavigate={vi.fn()}
        onGoBack={vi.fn()}
        onGoForward={vi.fn()}
        onReload={vi.fn()}
        onToggleAiPanel={vi.fn()}
        onToggleBookmarkBar={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle("下载"));

    expect(toggleDownloads).toHaveBeenCalledWith({ left: 384, top: 42 });
  });
});
