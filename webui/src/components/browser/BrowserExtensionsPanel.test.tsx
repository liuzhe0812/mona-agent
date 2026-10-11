import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserExtensionsPanel } from "./BrowserExtensionsPanel";

const ipc = vi.hoisted(() => ({
  browserListExtensions: vi.fn(),
  browserInstallExtension: vi.fn(),
  browserSetExtensionEnabled: vi.fn(),
  browserRemoveExtension: vi.fn(),
}));
const dialog = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("@/lib/browser-ipc", () => ipc);
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  ipc.browserListExtensions.mockResolvedValue([]);
  ipc.browserInstallExtension.mockResolvedValue(undefined);
  ipc.browserSetExtensionEnabled.mockResolvedValue(undefined);
  ipc.browserRemoveExtension.mockResolvedValue(undefined);
  dialog.open.mockResolvedValue("D:/extensions/sample");
});

describe("BrowserExtensionsPanel", () => {
  it("waits for confirmation before installing the selected directory", async () => {
    render(<BrowserExtensionsPanel tabId="tab-1" onClose={vi.fn()} />);
    await screen.findByText("暂无扩展");

    fireEvent.click(screen.getByRole("button", { name: "加载扩展" }));
    await waitFor(() => expect(dialog.open).toHaveBeenCalledWith({ directory: true, multiple: false, title: "选择扩展目录" }));
    expect(await screen.findByText("此扩展可以读取和修改网页内容。")).toBeInTheDocument();
    expect(ipc.browserInstallExtension).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认加载" }));
    await waitFor(() => expect(ipc.browserInstallExtension).toHaveBeenCalledWith("tab-1", "D:/extensions/sample"));
  });

  it("loads the real extension list and sends enable changes through IPC", async () => {
    ipc.browserListExtensions.mockResolvedValue([{ id: "reader", name: "Reader", enabled: true }]);
    render(<BrowserExtensionsPanel tabId="tab-1" onClose={vi.fn()} />);

    const enabled = await screen.findByRole("switch", { name: "启用扩展 Reader" });
    fireEvent.click(enabled);
    await waitFor(() => expect(ipc.browserSetExtensionEnabled).toHaveBeenCalledWith("tab-1", "reader", false));
    expect(enabled).toHaveAttribute("aria-checked", "false");
  });

  it("keeps extensions visible after an enable error and lets the user retry", async () => {
    ipc.browserListExtensions.mockResolvedValue([{ id: "reader", name: "Reader", enabled: true }]);
    ipc.browserSetExtensionEnabled.mockRejectedValueOnce(new Error("Browser rejected the request"));
    render(<BrowserExtensionsPanel tabId="tab-1" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("switch", { name: "启用扩展 Reader" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("切换扩展“Reader”状态失败：Browser rejected the request");
    expect(screen.getByText("Reader")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "启用扩展 Reader" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(ipc.browserSetExtensionEnabled).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("switch", { name: "启用扩展 Reader" })).toHaveAttribute("aria-checked", "false");
  });
});
