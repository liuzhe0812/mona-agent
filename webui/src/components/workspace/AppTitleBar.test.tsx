import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startDragging = vi.fn().mockResolvedValue(undefined);

vi.mock("@/components/ConnectionBadge", () => ({ ConnectionBadge: () => null }));
vi.mock("@/components/browser/BrowserTab", () => ({ BrowserTabItem: () => null }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging }),
}));

import { AppTitleBar } from "./AppTitleBar";

describe("AppTitleBar", () => {
  beforeEach(() => {
    startDragging.mockClear();
  });

  it("marks non-interactive title bar content as a native drag region", () => {
    const { container } = render(
      <AppTitleBar
        tabs={[]}
        activeTabId="mona"
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );

    expect(container.querySelector("header")?.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  it("does not issue a second drag command alongside Tauri's native drag region", () => {
    const { container } = render(
      <AppTitleBar
        tabs={[]}
        activeTabId="mona"
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );

    fireEvent.mouseDown(container.querySelector("header > div")!, { button: 0 });

    expect(startDragging).not.toHaveBeenCalled();
  });

  it("names the browser-tab creation control", () => {
    render(
      <AppTitleBar
        tabs={[]}
        activeTabId="mona"
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "New browser tab" })).toBeInTheDocument();
  });
});
