import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVELOPMENT_WORK_TOOLS, DevelopmentTabs } from "./DevelopmentTabs";
import type { Tab } from "@/hooks/useBrowserTabs";

HTMLElement.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

describe("development browser-like tab strip", () => {
  it("places add immediately after the tab strip and the flexible spacer after add", () => {
    const props = { active: "overview" as const, maximized: false, onSelect: vi.fn(), onClose: vi.fn(), onMaximize: vi.fn(), onCollapse: vi.fn(), children: "content" };
    const view = render(<DevelopmentTabs {...props} tabs={[]} />);
    const strip = screen.getByRole("tablist", { name: "工作区标签页" });
    const add = screen.getByRole("button", { name: "打开工作标签" });
    const newTab = screen.getByRole("tab", { name: "新标签页" });
    expect(strip.nextElementSibling).toBe(add);
    expect(strip).not.toHaveClass("flex-1");
    expect(add.nextElementSibling).toHaveClass("flex-1");
    expect(newTab).toHaveAttribute("aria-selected", "true");
    expect(newTab).toHaveClass("h-8", "bg-muted/60", "text-foreground");
    view.rerender(<DevelopmentTabs {...props} active="workspace" tabs={["workspace", "terminal", "review"]} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["新标签页", "文件", "终端", "审查"]);
    expect(screen.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "关闭 文件" })).toHaveClass("opacity-100");
    expect(screen.getByRole("button", { name: "关闭 终端" })).toHaveClass("opacity-0", "group-hover:opacity-100", "group-focus-within:opacity-100");
    expect(strip.nextElementSibling).toBe(add);
    expect(screen.getByRole("button", { name: "放大侧边栏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起侧边栏" })).toBeInTheDocument();
  });
  it("opens a tool via add without replacing the launcher or invoking maximize", async () => {
    const select = vi.fn(), maximize = vi.fn();
    render(<DevelopmentTabs tabs={[]} active="overview" maximized={false} onSelect={select} onClose={vi.fn()} onMaximize={maximize} onCollapse={vi.fn()}>content</DevelopmentTabs>);
    fireEvent.pointerDown(screen.getByRole("button", { name: "打开工作标签" }), { button: 0, ctrlKey: false });
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["审查", "终端", "辅助对话", "文件"]);
    expect(DEVELOPMENT_WORK_TOOLS.map((tool) => tool.id)).toEqual(["review", "terminal", "sidechat", "workspace"]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "文件", exact: true }));
    expect(select).toHaveBeenCalledWith("workspace"); expect(maximize).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "新标签页" })).toBeInTheDocument();
    expect(DEVELOPMENT_WORK_TOOLS.find((tool) => tool.id === "sidechat")?.title).toBe("辅助对话");
  });
  it("closes the new tab through the overview close callback", () => {
    const close = vi.fn();
    render(<DevelopmentTabs tabs={[]} active="overview" maximized={false} onSelect={vi.fn()} onClose={close} onMaximize={vi.fn()} onCollapse={vi.fn()}>content</DevelopmentTabs>);
    fireEvent.click(screen.getByRole("button", { name: "关闭 新标签页" }));
    expect(close).toHaveBeenCalledWith("overview");
  });
  it("shows browser page metadata in both tabs and falls back when a favicon fails", () => {
    const browserTab: Tab = { id: "browser-1", type: "browser", title: "Example page", url: "https://example.com/docs", favicon: "https://cdn.example.com/icon.png", isAiControlled: false, webviewCreated: true };
    const props = { tabs: ["browser"] as ("browser")[], active: "overview" as const, maximized: false, browserTab,
      onSelect: vi.fn(), onClose: vi.fn(), onMaximize: vi.fn(), onCollapse: vi.fn(), children: "content" };
    const view = render(<DevelopmentTabs {...props} />);
    expect(screen.getAllByRole("tab", { name: "Example page" })).toHaveLength(2);
    expect(Array.from(view.container.querySelectorAll("img"), (image) => image.getAttribute("src")))
      .toEqual([browserTab.favicon, browserTab.favicon]);

    fireEvent.error(view.container.querySelector("img")!);
    expect(view.container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getAllByRole("tab", { name: "Example page" }).every((tab) => tab.querySelector("svg"))).toBe(true);

    view.rerender(<DevelopmentTabs {...props} browserTab={{ ...browserTab, favicon: undefined }} />);
    expect(Array.from(view.container.querySelectorAll("img"), (image) => image.getAttribute("src")))
      .toEqual(["https://example.com/favicon.ico", "https://example.com/favicon.ico"]);
    fireEvent.error(view.container.querySelector("img")!);
    expect(view.container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getAllByRole("tab", { name: "Example page" }).every((tab) => tab.querySelector("svg"))).toBe(true);
  });
  it("keeps previously opened browser and subagent tabs renderable", () => {
    render(<DevelopmentTabs tabs={["browser", "subagents"]} active="browser" maximized={false} onSelect={vi.fn()} onClose={vi.fn()} onMaximize={vi.fn()} onCollapse={vi.fn()}>content</DevelopmentTabs>);
    expect(screen.getByRole("tab", { name: "浏览器" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "子智能体配置" })).toBeInTheDocument();
  });
  it("keeps arrow-key tab selection and collapse controls", () => {
    const select = vi.fn(), collapse = vi.fn();
    render(<DevelopmentTabs tabs={["workspace", "terminal"]} active="overview" maximized onSelect={select} onClose={vi.fn()} onMaximize={vi.fn()} onCollapse={collapse}>content</DevelopmentTabs>);
    const newTab = screen.getByRole("tab", { name: "新标签页" });
    newTab.focus(); fireEvent.keyDown(newTab, { key: "ArrowRight" });
    expect(select).toHaveBeenCalledWith("workspace");
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }));
    expect(collapse).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "还原侧边栏" })).toBeInTheDocument();
  });
});
