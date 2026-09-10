import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LargeFileTable } from "./LargeFileTable";
import type { StorageTrashResult, TopFileInfo } from "../useSystemData";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

const files: TopFileInfo[] = [
  { id: "file-video", path: "C:\\Users\\Mona\\Videos\\big.mp4", parentDirName: "Videos", extension: "mp4", sizeGb: 3.2, modifiedBucket: "old" },
  { id: "file-setup", path: "C:\\Users\\Mona\\Downloads\\setup.iso", parentDirName: "Downloads", extension: "iso", sizeGb: 2.1, modifiedBucket: "90d" },
];

function trashSuccess(path: string): StorageTrashResult {
  return { trashed: [{ path, sizeGb: 3.2 }], failures: [], freedGb: 3.2 };
}

/** 右键第一行 → 点「移至回收站」→ 确认弹窗打开 */
async function openTrashDialog() {
  fireEvent.contextMenu(screen.getByText("Videos"));
  fireEvent.click(await screen.findByRole("button", { name: "移至回收站" }));
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

    fireEvent.contextMenu(screen.getByText("Videos"));

    expect(screen.queryByRole("button", { name: "移至回收站" })).toBeNull();
    expect(screen.getByRole("button", { name: "在资源管理器中显示" })).toBeTruthy();
  });
});
