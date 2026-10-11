import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Tab } from "@/hooks/useBrowserTabs";
import { BrowserOptionsButton, BrowserSettingsPanel } from "./BrowserOptions";

const ipc = vi.hoisted(() => ({
  browserClearHistory: vi.fn(),
  browserGetZoom: vi.fn(),
  browserOpenDevtools: vi.fn(),
  browserPageAction: vi.fn(),
  browserPrintPage: vi.fn(),
  browserSetZoom: vi.fn(),
}));
const menu = vi.hoisted(() => ({
  menuNew: vi.fn(),
  popup: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@/lib/browser-ipc", () => ipc);
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: menu.menuNew } }));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  menu.menuNew.mockResolvedValue({ popup: menu.popup, close: menu.close });
  menu.popup.mockResolvedValue(undefined);
  menu.close.mockResolvedValue(undefined);
  ipc.browserClearHistory.mockResolvedValue(undefined);
  ipc.browserGetZoom.mockResolvedValue(1.2);
  ipc.browserOpenDevtools.mockResolvedValue(undefined);
  ipc.browserPageAction.mockResolvedValue({});
  ipc.browserPrintPage.mockResolvedValue(undefined);
  ipc.browserSetZoom.mockResolvedValue(undefined);
});

const tab = (id: string, webviewCreated = true): Tab => ({
  id, type: "browser", title: "Example", url: "https://example.com", isAiControlled: false, webviewCreated,
});
type MenuItem = { text?: string; enabled?: boolean; items?: MenuItem[]; action?: () => void };
function capturedItems(): MenuItem[] {
  const options = menu.menuNew.mock.calls[0]?.[0] as { items: MenuItem[] } | undefined;
  return options?.items ?? [];
}

describe("BrowserOptionsButton", () => {
  it("builds page actions for the selected tab and closes the native popup", async () => {
    const onFind = vi.fn(), onOpen = vi.fn(), onError = vi.fn();
    render(<BrowserOptionsButton tab={tab("tab-a")} onFind={onFind} onDevice={vi.fn()} onOpen={onOpen} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "浏览器选项" }));

    await waitFor(() => expect(menu.menuNew).toHaveBeenCalledOnce());
    await waitFor(() => expect(menu.close).toHaveBeenCalledOnce());
    expect(ipc.browserGetZoom).toHaveBeenCalledWith("tab-a");
    expect(menu.popup).toHaveBeenCalledOnce();

    const items = capturedItems();
    expect(items.find((item) => item.text === "在页面中查找")?.enabled).toBe(true);
    items.find((item) => item.text === "打印")?.action?.();
    await waitFor(() => expect(ipc.browserPrintPage).toHaveBeenCalledWith("tab-a"));
    items.find((item) => item.text?.startsWith("缩放"))?.items?.find((item) => item.text === "放大")?.action?.();
    await waitFor(() => expect(ipc.browserSetZoom).toHaveBeenCalledWith("tab-a", 1.3));
    expect(onFind).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onError.mock.calls.flat().filter(Boolean)).toEqual([]);
  });

  it("disables page actions without a tab while history and downloads still open", async () => {
    const onOpen = vi.fn();
    render(<BrowserOptionsButton tab={null} onFind={vi.fn()} onDevice={vi.fn()} onOpen={onOpen} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "浏览器选项" }));
    await waitFor(() => expect(menu.menuNew).toHaveBeenCalledOnce());

    const items = capturedItems();
    expect(ipc.browserGetZoom).not.toHaveBeenCalled();
    expect(items.find((item) => item.text === "在页面中查找")?.enabled).toBe(false);
    expect(items.find((item) => item.text === "打印")?.enabled).toBe(false);
    expect(items.find((item) => item.text?.startsWith("缩放"))?.enabled).toBe(false);
    expect(items.find((item) => item.text === "截取网页截图")?.enabled).toBe(false);

    items.find((item) => item.text === "下载")?.action?.();
    items.find((item) => item.text === "历史记录")?.action?.();
    expect(onOpen.mock.calls).toEqual([["downloads"], ["history"]]);
  });

  it("reports print failures to the owning view", async () => {
    const onError = vi.fn();
    ipc.browserPrintPage.mockRejectedValueOnce(new Error("打印服务不可用"));
    render(<BrowserOptionsButton tab={tab("tab-b")} onFind={vi.fn()} onDevice={vi.fn()} onOpen={vi.fn()} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "浏览器选项" }));
    await waitFor(() => expect(menu.menuNew).toHaveBeenCalledOnce());

    capturedItems().find((item) => item.text === "打印")?.action?.();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("打印服务不可用"));
  });
});

describe("BrowserSettingsPanel", () => {
  it("clears only checked data after explicit confirmation", async () => {
    render(<BrowserSettingsPanel tabId="tab-c" onClose={vi.fn()} />);
    await waitFor(() => expect(ipc.browserGetZoom).toHaveBeenCalledWith("tab-c"));

    fireEvent.click(screen.getByRole("checkbox", { name: "浏览历史" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "缓存" }));
    fireEvent.click(screen.getByRole("button", { name: "清除所选数据" }));
    expect(ipc.browserClearHistory).not.toHaveBeenCalled();
    expect(ipc.browserPageAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "清除", exact: true }));
    await waitFor(() => expect(ipc.browserClearHistory).toHaveBeenCalledOnce());
    expect(ipc.browserPageAction).toHaveBeenCalledWith("tab-c", "clear_cache");
    expect(ipc.browserPageAction).not.toHaveBeenCalledWith("tab-c", "clear_cookies");
  });
});
