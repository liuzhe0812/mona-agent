import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SidebarBrowserPanel } from "@/components/deliver/SidebarBrowserPanel";

vi.mock("@/components/browser/BrowserTabView", () => ({
  BrowserTabView: ({ tab, isVisible, onNavigate }: {
    tab: { id: string };
    isVisible: boolean;
    onNavigate: (url: string) => void;
  }) => (
    <button
      type="button"
      data-testid="sidebar-browser"
      data-tab-id={tab.id}
      data-visible={String(isVisible)}
      onClick={() => onNavigate("https://example.com")}
    >
      browser
    </button>
  ),
}));

describe("SidebarBrowserPanel", () => {
  it("renders the App-owned browser tab and forwards navigation", () => {
    const navigate = vi.fn();
    render(
      <SidebarBrowserPanel
        session={null}
        visible
        controller={{
          tab: {
            id: "sidebar-tab",
            type: "browser",
            title: "New Tab",
            url: "",
            isAiControlled: false,
            webviewCreated: false,
          },
          navigate,
          goBack: vi.fn(),
          goForward: vi.fn(),
          reload: vi.fn(),
          updateUrl: vi.fn(),
        }}
      />,
    );
    const browser = screen.getByTestId("sidebar-browser");
    expect(browser).toHaveAttribute("data-tab-id", "sidebar-tab");
    expect(browser).toHaveAttribute("data-visible", "true");
    fireEvent.click(browser);
    expect(navigate).toHaveBeenCalledWith("https://example.com");
  });

  it("shows a loading state until App provides the shared tab", () => {
    render(<SidebarBrowserPanel session={null} visible />);
    expect(screen.getByText("正在打开浏览器…")).toBeInTheDocument();
  });
});
