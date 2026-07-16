import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserToolbar } from "./BrowserToolbar";

const popup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const close = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const menuNew = vi.hoisted(() => vi.fn().mockResolvedValue({ popup, close }));
const showAddressSuggestions = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const hideAddressSuggestions = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const showDownloads = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: menuNew } }));
vi.mock("@/lib/browser-ipc", () => ({
  browserIsBookmarked: vi.fn().mockResolvedValue(false),
  browserAddBookmark: vi.fn(),
  browserRemoveBookmark: vi.fn(),
  browserSearchSuggestions: vi.fn().mockResolvedValue([]),
  browserShowAddressSuggestions: showAddressSuggestions,
  browserHideAddressSuggestions: hideAddressSuggestions,
  browserShowDownloads: showDownloads,
  browserListenAddressSuggestionSelected: vi.fn().mockResolvedValue(vi.fn()),
  browserClearHistory: vi.fn(),
  browserClearCache: vi.fn(),
  browserImportBookmarks: vi.fn(),
}));

describe("BrowserToolbar", () => {
  beforeEach(() => {
    menuNew.mockClear();
    popup.mockClear();
    close.mockClear();
    showAddressSuggestions.mockClear();
    hideAddressSuggestions.mockClear();
    showDownloads.mockClear();
  });

  it("uses a native window for address suggestions", async () => {
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
      vi.spyOn(HTMLInputElement.prototype, "getBoundingClientRect").mockReturnValue({
        left: 120,
        top: 20,
        right: 720,
        bottom: 44,
        width: 600,
        height: 24,
      } as DOMRect);

      render(
        <BrowserToolbar
          tabId="tab-1"
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

      expect(showAddressSuggestions).toHaveBeenCalledWith(expect.objectContaining({
        left: 120,
        top: 48,
        width: 600,
        suggestions: [suggestion],
      }));
      expect(screen.queryByText("Example article")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a native menu without opening the WebView-hiding overlay", async () => {
    const onFind = vi.fn();
    const onCreateNote = vi.fn();

    render(
      <BrowserToolbar
        tabId="tab-1"
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
    expect(createNoteItem).toBeDefined();
    createNoteItem?.action?.();
    expect(onCreateNote).toHaveBeenCalledTimes(1);
  });

  it("opens the browser download bubble from the toolbar", () => {
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
        tabId="tab-1"
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

    expect(showDownloads).toHaveBeenCalledWith({ left: 384, top: 42 });
  });
});
