import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const isTauriMock = vi.hoisted(() => vi.fn(() => false));
const popup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const close = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const menuNew = vi.hoisted(() => vi.fn().mockResolvedValue({ popup, close }));

vi.mock("@/lib/tauri", () => ({ isTauri: isTauriMock }));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: menuNew } }));

import { BrowserTabItem } from "./BrowserTab";
import type { Tab } from "@/hooks/useBrowserTabs";

const monaTab: Tab = {
  id: "mona",
  type: "mona",
  title: "Mona",
  isAiControlled: false,
  webviewCreated: false,
};

const browserTab: Tab = {
  id: "browser-1",
  type: "browser",
  title: "Example",
  url: "https://example.com",
  isAiControlled: false,
  webviewCreated: true,
};

describe("BrowserTabItem", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(false);
    menuNew.mockClear();
    popup.mockClear();
    close.mockClear();
  });

  it("keeps Mona clickable without browser-tab selection chrome", () => {
    const onClick = vi.fn();
    render(
      <BrowserTabItem
        tab={monaTab}
        active
        onClick={onClick}
        onClose={vi.fn()}
      />,
    );

    const tab = screen.getByRole("tab", { name: "Mona" });
    fireEvent.click(tab);

    expect(onClick).toHaveBeenCalledOnce();
    expect(tab).toHaveAttribute("draggable", "false");
    expect(tab).toHaveClass("font-medium", "hover:bg-transparent", "active:bg-transparent");
    expect(tab).not.toHaveClass("bg-[hsl(var(--sidebar-active-surface)/0.07)]");
    expect(tab.querySelector('[role="button"]')).toBeNull();
    expect(tab.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("keeps browser tabs on their existing active and close behavior", () => {
    const onClose = vi.fn();
    render(
      <BrowserTabItem
        tab={browserTab}
        active
        onClick={vi.fn()}
        onClose={onClose}
      />,
    );

    const tab = screen.getByRole("tab", { name: "Example" });
    expect(tab).toHaveClass("rounded-md", "bg-[hsl(var(--sidebar-active-surface)/0.07)]");
    expect(tab.querySelector('[role="button"]')).not.toBeNull();
  });

  it("uses a native title-bar tab menu above the browser WebView", async () => {
    isTauriMock.mockReturnValue(true);
    const onClose = vi.fn();
    render(
      <BrowserTabItem
        tab={browserTab}
        active
        onClick={vi.fn()}
        onPinToggle={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Example" }));
    await waitFor(() => expect(menuNew).toHaveBeenCalledOnce());
    expect(popup).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
