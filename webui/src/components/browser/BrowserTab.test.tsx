import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({ isTauri: () => false }));

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
});
