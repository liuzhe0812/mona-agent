import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const menuNew = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: menuNew } }));

import { ArtifactSidebar, OVERVIEW_TAB_ID } from "@/components/deliver/ArtifactSidebar";
import type { DeliveredFile } from "@/lib/types";

function file(name: string): DeliveredFile {
  return {
    path: name,
    absolute_path: `/output/${name}`,
    name,
    size: 1,
    size_human: "1 B",
    mime: "text/plain",
  };
}

describe("ArtifactSidebar", () => {
  beforeEach(() => {
    menuNew.mockClear();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("keeps overview fixed and opens files as closable tabs", async () => {
    const onSelectOverview = vi.fn();
    const onSelectTab = vi.fn();
    const onCloseTab = vi.fn();
    const report = { id: "file:report.md", file: file("report.md") };
    render(
      <ArtifactSidebar
        tabs={[report]}
        activeTabId={report.id}
        maximized={false}
        onSelectOverview={onSelectOverview}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onToggleMaximized={vi.fn()}
        onCollapse={vi.fn()}
      >
        content
      </ArtifactSidebar>,
    );

    const overviewTrigger = screen.getByRole("button", { name: "概览" });
    expect(screen.queryByRole("button", { name: "选择侧边栏视图" })).not.toBeInTheDocument();
    expect(overviewTrigger).not.toHaveAttribute("aria-current");
    expect(overviewTrigger.className).not.toContain("bg-muted/60");
    fireEvent.click(overviewTrigger);
    expect(onSelectOverview).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("tab", { name: "report.md" }));
    expect(onSelectTab).toHaveBeenCalledWith(report);
    fireEvent.click(screen.getByRole("button", { name: "关闭 report.md" }));
    expect(onCloseTab).toHaveBeenCalledWith(report.id);
    const tabList = screen.getByRole("tablist", { name: "工作区标签页" });
    expect(tabList.className).toContain("[scrollbar-width:none]");
    expect(tabList.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(tabList.className).not.toContain("scrollbar-hover");
    expect(screen.getByRole("tab", { name: "report.md" }).parentElement).toHaveClass("max-w-32");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  it("keeps the active tab at the standard width", () => {
    const report = { id: "file:long-report.xlsx", file: file("静夜思·现代汉语长标题工作表.xlsx") };
    const other = { id: "file:other.md", file: file("other.md") };
    const { rerender } = render(
      <ArtifactSidebar
        tabs={[report, other]}
        activeTabId={other.id}
        maximized={false}
        onSelectOverview={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onToggleMaximized={vi.fn()}
        onCollapse={vi.fn()}
      >
        content
      </ArtifactSidebar>,
    );

    const tab = screen.getByRole("tab", { name: "静夜思·现代汉语长标题工作表.xlsx" });
    expect(tab.parentElement).toHaveClass("max-w-32");

    rerender(
      <ArtifactSidebar
        tabs={[report, other]}
        activeTabId={report.id}
        maximized={false}
        onSelectOverview={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onToggleMaximized={vi.fn()}
        onCollapse={vi.fn()}
      >
        content
      </ArtifactSidebar>,
    );

    expect(tab.parentElement).toHaveClass("max-w-32");
    expect(tab.querySelector("span")).toHaveClass("truncate");
    expect(tab.querySelector("span")).not.toHaveClass("whitespace-nowrap");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  it("collapses the overview label when the tab bar overflows", () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const observers: Array<{ element?: Element; callback: ResizeObserverCallback }> = [];
    class MockResizeObserver {
      readonly callback: ResizeObserverCallback;
      element?: Element;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }

      observe(element: Element) {
        this.element = element;
      }

      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    try {
      render(
        <ArtifactSidebar
          tabs={[{ id: "file:report.md", file: file("report.md") }]}
          activeTabId="file:report.md"
          maximized={false}
          onSelectOverview={vi.fn()}
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
          onToggleMaximized={vi.fn()}
          onCollapse={vi.fn()}
        >
          content
        </ArtifactSidebar>,
      );

      const tabList = screen.getByRole("tablist", { name: "工作区标签页" });
      Object.defineProperties(tabList, {
        clientWidth: { configurable: true, value: 100 },
        scrollWidth: { configurable: true, value: 180 },
      });
      const observer = observers.find((item) => item.element === tabList);
      if (!observer) throw new Error("tab list resize observer was not registered");
      act(() => observer.callback([], observer as unknown as ResizeObserver));

      const overview = screen.getByTitle("概览");
      expect(overview).toHaveClass("w-7", "justify-center");
      expect(overview.querySelector("span")).toBeNull();

      Object.defineProperties(tabList, {
        clientWidth: { configurable: true, value: 200 },
        scrollWidth: { configurable: true, value: 60 },
      });
      const latestObserver = observers.at(-1);
      if (!latestObserver) throw new Error("tab list resize observer was not registered");
      act(() => latestObserver.callback([], latestObserver as unknown as ResizeObserver));

      expect(screen.getByTitle("概览")).toHaveTextContent("概览");
    } finally {
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
    }
  });

  it("offers maximize, restore and collapse actions", () => {
    const onToggleMaximized = vi.fn();
    const onCollapse = vi.fn();
    const { rerender } = render(
      <ArtifactSidebar
        tabs={[]}
        activeTabId={OVERVIEW_TAB_ID}
        maximized={false}
        onSelectOverview={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onToggleMaximized={onToggleMaximized}
        onCollapse={onCollapse}
      >
        content
      </ArtifactSidebar>,
    );
    fireEvent.click(screen.getByRole("button", { name: "最大化侧边栏" }));
    expect(onToggleMaximized).toHaveBeenCalledTimes(1);

    rerender(
      <ArtifactSidebar
        tabs={[]}
        activeTabId={OVERVIEW_TAB_ID}
        maximized
        onSelectOverview={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onToggleMaximized={onToggleMaximized}
        onCollapse={onCollapse}
      >
        content
      </ArtifactSidebar>,
    );
    expect(screen.getByRole("button", { name: "还原侧边栏" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("places document controls in the existing sidebar header", () => {
    let toolbarSlot: HTMLDivElement | null = null;
    render(
      <ArtifactSidebar
        tabs={[]}
        activeTabId={OVERVIEW_TAB_ID}
        maximized={false}
        onSelectOverview={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onToggleMaximized={vi.fn()}
        onCollapse={vi.fn()}
        toolbarSlotRef={(element) => { toolbarSlot = element; }}
      >
        content
      </ArtifactSidebar>,
    );

    expect(toolbarSlot).not.toBeNull();
    expect(toolbarSlot?.parentElement).toContainElement(screen.getByRole("button", { name: "最大化侧边栏" }));
  });

  it("offers new tab actions at the end of the tab bar and forwards each kind", async () => {
    const onCreateTab = vi.fn();
    render(
      <ArtifactSidebar
        tabs={[]}
        activeTabId={OVERVIEW_TAB_ID}
        maximized={false}
        onSelectOverview={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onCreateTab={onCreateTab}
        onToggleMaximized={vi.fn()}
        onCollapse={vi.fn()}
      >
        content
      </ArtifactSidebar>,
    );

    const tabList = screen.getByRole("tablist", { name: "工作区标签页" });
    const createButton = screen.getByRole("button", { name: "新建标签页" });
    expect(createButton).toBeInTheDocument();
    expect(tabList).toContainElement(createButton);

    const items = [
      ["工作区", "workspace"],
      ["浏览器", "browser"],
      ["终端", "terminal"],
      ["流程图", "flowchart"],
      ["思维导图", "mindmap"],
      ["PPT", "ppt"],
      ["Word", "word"],
      ["Excel", "excel"],
    ] as const;
    fireEvent.pointerDown(createButton, { button: 0, ctrlKey: false });
    fireEvent.click(createButton);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(
      items.map(() => ""),
    );
    expect(screen.getByRole("menuitem", { name: "工作区" }).querySelector("span")).toHaveStyle({
      backgroundImage: "url(/brand/sidebar-app-picker-icons.png)",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "工作区" }));
    expect(onCreateTab).toHaveBeenLastCalledWith("workspace");

    for (const [label, kind] of items.slice(1)) {
      fireEvent.pointerDown(createButton, { button: 0, ctrlKey: false });
      fireEvent.click(createButton);
      expect(await screen.findByRole("menuitem", { name: label })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      expect(onCreateTab).toHaveBeenLastCalledWith(kind);
    }
  });

  it("uses the icon-only app picker in the desktop shell", async () => {
    const onCreateTab = vi.fn();
    render(
      <ArtifactSidebar
        tabs={[]}
        activeTabId={OVERVIEW_TAB_ID}
        maximized={false}
        onSelectOverview={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onCreateTab={onCreateTab}
        onToggleMaximized={vi.fn()}
        onCollapse={vi.fn()}
      >
        content
      </ArtifactSidebar>,
    );

    expect(screen.queryByRole("button", { name: "选择侧边栏视图" })).not.toBeInTheDocument();
    const createButton = screen.getByRole("button", { name: "新建标签页" });
    fireEvent.pointerDown(createButton, { button: 0, ctrlKey: false });
    fireEvent.click(createButton);
    expect(menuNew).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").every((item) => item.textContent === "")).toBe(true);

    fireEvent.click(screen.getByRole("menuitem", { name: "工作区" }));
    expect(onCreateTab).toHaveBeenCalledWith("workspace");

    fireEvent.pointerDown(createButton, { button: 0, ctrlKey: false });
    fireEvent.click(createButton);
    expect(screen.getByRole("menuitem", { name: "Word" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Excel" })).toBeInTheDocument();
  });
});
