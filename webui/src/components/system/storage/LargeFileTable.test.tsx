import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { LargeFileTable } from "./LargeFileTable";
import type { StorageTrashResult, TopFileInfo } from "../useSystemData";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

const files: TopFileInfo[] = [
  { id: "file-video", path: "C:\\Users\\Mona\\Videos\\big.mp4", parentDirName: "Videos", extension: "mp4", sizeGb: 3.2, modifiedBucket: "old" },
  { id: "file-setup", path: "C:\\Users\\Mona\\Downloads\\setup.iso", parentDirName: "Downloads", extension: "iso", sizeGb: 2.1, modifiedBucket: "90d" },
];

function openMoreMenu(fileName: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: `更多操作 ${fileName}` }), { button: 0, ctrlKey: false });
}

function trashSuccess(path: string): StorageTrashResult {
  return { trashed: [{ path, sizeGb: 3.2 }], failures: [], freedGb: 3.2 };
}

describe("LargeFileTable", () => {
  it("shows a failure dialog when opening the file location fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("文件不存在"));
    render(<LargeFileTable files={files} />);
    openMoreMenu("big.mp4");
    fireEvent.click(await screen.findByRole("menuitem", { name: "打开位置" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("无法打开文件位置");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("shows file details and two named icon actions without analyzing automatically", () => {
    const onAnalyze = vi.fn();
    render(<LargeFileTable files={files} onAnalyze={onAnalyze} />);

    expect(screen.getByText("big.mp4")).toBeTruthy();
    expect(screen.getByText("Videos")).toBeTruthy();
    expect(screen.getByText(".mp4")).toBeTruthy();
    expect(screen.getByText("一年以上")).toBeTruthy();
    expect(screen.getByText("3.2 GB")).toBeTruthy();
    expect(screen.queryByText(/大文件 Top/)).toBeNull();
    expect(screen.queryByRole("button", { name: "交给 Mona 评估" })).toBeNull();
    expect(screen.getByRole("button", { name: "分析 big.mp4" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "更多操作 big.mp4" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开位置" })).toBeNull();
    expect(onAnalyze).not.toHaveBeenCalled();
  });

  it("analyzes only the file whose icon was clicked and shows a per-file spinner", () => {
    const onAnalyze = vi.fn();
    const { rerender } = render(<LargeFileTable files={files} onAnalyze={onAnalyze} />);

    fireEvent.click(screen.getByRole("button", { name: "分析 setup.iso" }));
    expect(onAnalyze).toHaveBeenCalledTimes(1);
    expect(onAnalyze).toHaveBeenCalledWith(files[1]);

    rerender(<LargeFileTable files={files} onAnalyze={onAnalyze} analyzingFileId={files[1].id} />);
    expect(screen.getByRole("button", { name: "正在分析 setup.iso" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在分析 setup.iso" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "分析 big.mp4" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "更多操作 setup.iso" })).toBeEnabled();
  });

  it("opens the shared more menu and supports opening and copying the selected file path", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<LargeFileTable files={files} />);

    openMoreMenu("big.mp4");
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制路径" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(files[0].path));

    openMoreMenu("big.mp4");
    fireEvent.click(await screen.findByRole("menuitem", { name: "打开位置" }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("system_reveal_in_explorer", { path: files[0].path });
    });
  });

  it("shows an error when copying the file path fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error("剪贴板访问被拒绝"))) },
    });
    render(<LargeFileTable files={files} />);

    openMoreMenu("big.mp4");
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制路径" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("无法复制路径");
    expect(dialog).toHaveTextContent("写入剪贴板失败");
  });
});

/** 在更多菜单中选择「移至回收站」→ 确认弹窗打开 */
async function openTrashDialog() {
  openMoreMenu("big.mp4");
  fireEvent.click(await screen.findByRole("menuitem", { name: "移至回收站" }));
  return screen.findByRole("alertdialog");
}

describe("LargeFileTable 回收站", () => {
  it("shows the recycle-bin confirmation with recoverable wording", async () => {
    const onTrash = vi.fn(() => Promise.resolve(trashSuccess(files[0].path)));
    render(<LargeFileTable files={files} onTrash={onTrash} />);

    const dialog = await openTrashDialog();

    expect(dialog.textContent).toContain("删除这个大文件？");
    expect(dialog.textContent).toContain("将被移至系统回收站，需要时可以从回收站恢复");
    expect(dialog.textContent).toContain("Videos");
    expect(dialog.textContent).toContain("3.2 GB");
  });

  it("calls onTrash with the file path and closes the dialog on success", async () => {
    const onTrash = vi.fn(() => Promise.resolve(trashSuccess(files[0].path)));
    render(<LargeFileTable files={files} onTrash={onTrash} />);

    const dialog = await openTrashDialog();
    fireEvent.click(screen.getByRole("button", { name: "移至回收站" }));

    await waitFor(() => expect(onTrash).toHaveBeenCalledWith([files[0].path]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(dialog).toBeTruthy();
  });

  it("keeps the dialog open and shows the reason when the trash call reports failures", async () => {
    const onTrash = vi.fn(() =>
      Promise.resolve({ trashed: [], failures: [{ path: files[0].path, error: "文件正在被使用" }], freedGb: 0 }),
    );
    render(<LargeFileTable files={files} onTrash={onTrash} />);

    await openTrashDialog();
    fireEvent.click(screen.getByRole("button", { name: "移至回收站" }));

    expect(await screen.findByText(/移至回收站失败：文件正在被使用/)).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("keeps the dialog open and shows the reason when the trash call rejects", async () => {
    const onTrash = vi.fn(() => Promise.reject(new Error("回收站任务失败")));
    render(<LargeFileTable files={files} onTrash={onTrash} />);

    await openTrashDialog();
    fireEvent.click(screen.getByRole("button", { name: "移至回收站" }));

    expect(await screen.findByText(/移至回收站失败：回收站任务失败/)).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("hides the trash entry when onTrash is not provided", () => {
    render(<LargeFileTable files={files} />);

    openMoreMenu("big.mp4");
    expect(screen.queryByRole("menuitem", { name: "移至回收站" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.contextMenu(screen.getByText("Videos"));

    expect(screen.queryByRole("button", { name: "移至回收站" })).toBeNull();
    expect(screen.getByRole("button", { name: "在资源管理器中显示" })).toBeTruthy();
  });

  it("keeps the previous right-click menu available", async () => {
    render(<LargeFileTable files={files} />);

    fireEvent.contextMenu(screen.getByText("Videos"));

    expect(await screen.findByRole("button", { name: "在资源管理器中显示" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制路径" })).toBeTruthy();
  });
});
