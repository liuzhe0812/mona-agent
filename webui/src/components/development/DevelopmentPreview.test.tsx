import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevSession, DevSnapshot } from "@/lib/development-api";
import type { DevelopmentBrowserHost } from "./DevelopmentSidebar";
import type { Tab } from "@/hooks/useBrowserTabs";

const api = vi.hoisted(() => ({ bindBrowser: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/development-api", () => ({ developmentApi: api }));
vi.mock("./useDevelopmentSession", () => ({ refreshDevelopmentSession: api.refresh }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@/components/deliver/SidebarBrowserPanel", () => ({
  SidebarBrowserPanel: ({ controller, visible }: { controller: { tab: Tab; reload: () => void }; visible: boolean }) =>
    <div data-testid="browser-page" data-page-id={controller.tab.id} data-visible={String(visible)}>
      <button onClick={controller.reload}>刷新当前预览</button>
    </div>,
}));
import { DevelopmentPreview, openDevelopmentPreview } from "./DevelopmentPreview";
import { useDevelopmentStore } from "./store";

const session: DevSession = { id: "dev-a", projectId: "project-a", title: "test", executor: "mona", model: null,
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "" };
const binding = { id: "preview-a", tabId: "page-a", origin: "http://localhost:3000" };
const snapshot: DevSnapshot = { session, messages: [], before: null, messageCount: 0, runs: [], events: [], eventCursor: 0, pendingInputs: [], live: null };
const tab = (id: string, url = "http://localhost:3000"): Tab => ({ id, type: "browser", title: id, url, isAiControlled: false, webviewCreated: true });
let host: DevelopmentBrowserHost;
beforeEach(() => {
  vi.clearAllMocks(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  useDevelopmentStore.getState().setSnapshot(session.id, snapshot);
  host = { tabs: [tab("page-a"), tab("page-b"), tab("work-page")], create: vi.fn().mockReturnValue("new-page"), retain: vi.fn(),
    navigate: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), updateUrl: vi.fn(), openDevtools: vi.fn(), setVisible: vi.fn() };
});
afterEach(cleanup);

describe("development preview lifetime", () => {
  it("accepts a URL on the new page and creates one target before navigating", () => {
    const view = render(<DevelopmentPreview session={session} host={host} visible layoutVersion="normal"><p>工具入口</p></DevelopmentPreview>);
    const address = screen.getByRole("textbox", { name: "搜索或输入网址" });
    expect(screen.getByText("工具入口")).toBeInTheDocument();
    expect(host.create).not.toHaveBeenCalled();
    fireEvent.change(address, { target: { value: "https://example.com/project" } });
    fireEvent.submit(address.closest("form")!);
    fireEvent.submit(address.closest("form")!);
    expect(host.create).toHaveBeenCalledTimes(1);
    expect(host.navigate).not.toHaveBeenCalled();
    host = { ...host, tabs: [...host.tabs, { ...tab("new-page", ""), webviewCreated: false }] };
    view.rerender(<DevelopmentPreview session={session} host={host} visible layoutVersion="normal" />);
    expect(host.navigate).toHaveBeenCalledTimes(1);
    expect(host.navigate).toHaveBeenCalledWith("new-page", "https://example.com/project");
    expect(api.bindBrowser).not.toHaveBeenCalled();
  });

  it("navigates the current page and uses its back, forward and reload controls", () => {
    host.tabs = [{ ...tab("page-a"), canGoBack: true, canGoForward: true }];
    useDevelopmentStore.getState().setBrowser(session.id, "page-a");
    render(<DevelopmentPreview session={session} host={host} visible layoutVersion="normal" />);
    const address = screen.getByRole("textbox", { name: "搜索或输入网址" });
    expect(address).toHaveValue("http://localhost:3000");
    fireEvent.change(address, { target: { value: "example.com" } });
    fireEvent.submit(address.closest("form")!);
    expect(host.navigate).toHaveBeenCalledWith("page-a", "https://example.com");
    fireEvent.click(screen.getByRole("button", { name: "后退" }));
    fireEvent.click(screen.getByRole("button", { name: "前进" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新网页" }));
    expect(host.goBack).toHaveBeenCalledWith("page-a");
    expect(host.goForward).toHaveBeenCalledWith("page-a");
    expect(host.reload).toHaveBeenCalledWith("page-a");
    expect(host.create).not.toHaveBeenCalled();
  });

  it("opens once even before the browser host has rerendered", () => {
    openDevelopmentPreview(session.id, host); openDevelopmentPreview(session.id, host);
    expect(host.create).toHaveBeenCalledTimes(1);
    expect(useDevelopmentStore.getState().browserTabs[session.id]).toBe("new-page");
    expect(api.bindBrowser).not.toHaveBeenCalled();
  });
  it("restores the exact associated page rather than opening a substitute", () => {
    useDevelopmentStore.getState().setSnapshot(session.id, { ...snapshot, browserBinding: binding });
    openDevelopmentPreview(session.id, host);
    render(<DevelopmentPreview session={session} host={host} visible layoutVersion="normal" />);
    expect(screen.getByTestId("browser-page")).toHaveAttribute("data-page-id", "page-a");
    expect(useDevelopmentStore.getState().browserTabs[session.id]).toBe("page-a");
    expect(host.create).not.toHaveBeenCalled();
    expect(host.retain).toHaveBeenCalledWith("page-a"); expect(api.bindBrowser).not.toHaveBeenCalled();
  });
  it("hides without closing or navigating and restores the original page", () => {
    useDevelopmentStore.getState().setBrowser(session.id, "page-a");
    const view = render(<DevelopmentPreview session={session} host={host} visible layoutVersion="normal" />);
    expect(host.setVisible).toHaveBeenLastCalledWith("page-a");
    view.rerender(<DevelopmentPreview session={session} host={host} visible={false} layoutVersion="normal" />);
    expect(host.setVisible).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId("browser-page")).toHaveAttribute("data-visible", "false");
    view.rerender(<DevelopmentPreview session={session} host={host} visible layoutVersion="maximized" />);
    expect(host.setVisible).toHaveBeenLastCalledWith("page-a");
    expect(host.create).not.toHaveBeenCalled(); expect(host.navigate).not.toHaveBeenCalled();
    view.unmount(); expect(host.setVisible).toHaveBeenLastCalledWith(null);
    expect(useDevelopmentStore.getState().browserTabs[session.id]).toBe("page-a");
  });
  it("does not recreate an unavailable page until explicitly requested", () => {
    useDevelopmentStore.getState().setSnapshot(session.id, { ...snapshot, browserBinding: { ...binding, tabId: "closed-page" } });
    openDevelopmentPreview(session.id, host);
    render(<DevelopmentPreview session={session} host={host} visible layoutVersion="normal" />);
    expect(host.create).not.toHaveBeenCalled(); expect(host.setVisible).toHaveBeenLastCalledWith(null);
    expect(screen.getByText(/不会自动新建替代页/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建预览页" }));
    fireEvent.click(screen.getByRole("button", { name: "新建预览页" }));
    expect(host.create).toHaveBeenCalledTimes(1); expect(api.bindBrowser).not.toHaveBeenCalled();
  });
  it("keeps session targets separate and never selects an unrelated Work page", () => {
    useDevelopmentStore.getState().setBrowser("dev-a", "page-a");
    useDevelopmentStore.getState().setBrowser("dev-b", "page-b");
    const view = render(<DevelopmentPreview key="dev-a" session={session} host={host} visible layoutVersion="normal" />);
    view.rerender(<DevelopmentPreview key="dev-b" session={{ ...session, id: "dev-b" }} host={host} visible layoutVersion="normal" />);
    fireEvent.click(screen.getByRole("button", { name: "刷新当前预览" }));
    expect(host.reload).toHaveBeenCalledTimes(1); expect(host.reload).toHaveBeenCalledWith("page-b");
    expect(host.setVisible).toHaveBeenLastCalledWith("page-b");
    expect(useDevelopmentStore.getState().browserTabs["dev-a"]).toBe("page-a");
    expect(host.create).not.toHaveBeenCalled();
  });
  it("does not claim a different origin is still linked", async () => {
    useDevelopmentStore.getState().setSnapshot(session.id, { ...snapshot, browserBinding: binding });
    host.tabs = [tab("page-a", "https://other.invalid/page")];
    render(<DevelopmentPreview session={session} host={host} visible layoutVersion="normal" />);
    expect(screen.getByRole("button", { name: "重新关联" })).toBeInTheDocument();
    expect(api.bindBrowser).not.toHaveBeenCalled();
    api.bindBrowser.mockResolvedValueOnce({ binding: { ...binding, id: "preview-new", origin: "https://other.invalid:443" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重新关联" })); });
    expect(api.bindBrowser).toHaveBeenCalledTimes(1); expect(api.bindBrowser).toHaveBeenCalledWith("dev-a", "page-a", "preview-a");
  });
});
