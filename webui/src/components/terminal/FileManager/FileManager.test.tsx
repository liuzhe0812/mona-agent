import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const localDesktopDir = vi.hoisted(() => vi.fn());
const localListDir = vi.hoisted(() => vi.fn());
const sftpCanonicalize = vi.hoisted(() => vi.fn());
const sftpList = vi.hoisted(() => vi.fn());
const sftpRemove = vi.hoisted(() => vi.fn());

vi.mock("../ipc", () => ({
  localDesktopDir,
  localListDir,
  onTransferProgress: vi.fn().mockResolvedValue(() => {}),
  sftpCanonicalize,
  sftpList,
  sftpRemove,
}));

import { FileManager } from "./FileManager";
import { getFileIconSource } from "@/lib/file-icons";

describe("FileManager", () => {
  beforeEach(() => {
    localDesktopDir.mockResolvedValue("C:\\Users\\Test\\Desktop");
    localListDir.mockResolvedValue([]);
    sftpCanonicalize.mockResolvedValue("/root");
    sftpList.mockResolvedValue([
      {
        name: "test.txt",
        path: "/root/test.txt",
        isDir: false,
        size: 12,
        permissions: 0o644,
        mtime: null,
        owner: null,
        group: null,
      },
    ]);
    sftpRemove.mockResolvedValue(undefined);
  });

  it("asks for confirmation before deleting a file", async () => {
    render(<FileManager sessionId="session-1" />);

    await waitFor(() => expect(screen.getByText("test.txt")).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByText("test.txt").closest("tr")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent("确认删除");
    expect(screen.getByText(/确定要删除「test\.txt」吗/)).toBeInTheDocument();
    expect(sftpRemove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses the shared file icon parser for remote files", async () => {
    sftpList.mockResolvedValue([
      {
        name: "deploy.py",
        path: "/root/deploy.py",
        isDir: false,
        size: 12,
        permissions: 0o644,
        mtime: null,
        owner: null,
        group: null,
      },
    ]);

    render(<FileManager sessionId="session-1" />);

    const file = await screen.findByText("deploy.py");
    expect(file.closest("tr")?.querySelector("img")).toHaveAttribute("src", getFileIconSource("deploy.py"));
  });
});
