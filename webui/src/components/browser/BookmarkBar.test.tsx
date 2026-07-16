import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BookmarkBar } from "./BookmarkBar";

const popup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const close = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const menuNew = vi.hoisted(() => vi.fn().mockResolvedValue({ popup, close }));

vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: menuNew } }));
vi.mock("@/lib/browser-ipc", () => ({
  browserListBookmarks: vi.fn().mockResolvedValue([
    { id: 1, url: "https://example.com", title: "Example", folder: "", createdAt: "2026-07-15T00:00:00Z" },
  ]),
  browserRemoveBookmark: vi.fn(),
  browserUpdateBookmark: vi.fn(),
}));

describe("BookmarkBar", () => {
  it("uses a native context menu for bookmarks", async () => {
    render(<BookmarkBar visible onNavigate={vi.fn()} />);

    const bookmark = await screen.findByTitle("https://example.com");
    fireEvent.contextMenu(bookmark);

    await waitFor(() => expect(menuNew).toHaveBeenCalledTimes(1));
    expect(popup).toHaveBeenCalledTimes(1);
  });
});
