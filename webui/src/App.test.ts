import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/terminal/TerminalView", () => ({
  TerminalView: () => null,
}));

import { openNewBrowserTab } from "./App";

describe("openNewBrowserTab", () => {
  it("switches to the chat surface before creating the tab", () => {
    const setView = vi.fn();
    const addEmptyTab = vi.fn();

    openNewBrowserTab(setView, addEmptyTab);

    expect(setView).toHaveBeenCalledWith("chat");
    expect(addEmptyTab).toHaveBeenCalledOnce();
    expect(setView.mock.invocationCallOrder[0]).toBeLessThan(
      addEmptyTab.mock.invocationCallOrder[0],
    );
  });
});
