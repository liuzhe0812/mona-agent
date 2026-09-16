import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sftpRemove = vi.hoisted(() => vi.fn());

vi.mock("@/components/terminal/ipc", () => ({
  getFileTypeIcon: vi.fn().mockResolvedValue(null),
  ideCheckFile: vi.fn(),
  ideOpenProject: vi.fn(),
  ideReadFile: vi.fn(),
  ideWriteFile: vi.fn(),
  onTransferProgress: vi.fn().mockResolvedValue(() => {}),
  sftpCancelTransfer: vi.fn(),
  sftpList: vi.fn().mockResolvedValue([]),
  sftpMkdir: vi.fn(),
  sftpRemove,
  sftpRename: vi.fn(),
  sftpStat: vi.fn(),
  sftpTouch: vi.fn(),
  sftpUpload: vi.fn(),
  sftpUploadFile: vi.fn(),
  sshOpenSftp: vi.fn(),
  sftpDownloadFile: vi.fn(),
  sftpDownloadDir: vi.fn(),
}));

import { IdeFileTree } from "./IdeFileTree";
import { useIdeStore } from "./useIdeStore";

describe("IdeFileTree", () => {
  beforeEach(() => {
    sftpRemove.mockReset();
    sftpRemove.mockResolvedValue(undefined);
    useIdeStore.setState({
      sessionId: "ssh-1",
      sftpSessionId: "sftp-1",
      rootPath: "/root",
      tree: [
        {
          name: "root",
          path: "/root",
          isDir: true,
          children: [{ name: "test.txt", path: "/root/test.txt", isDir: false }],
        },
      ],
      expandedPaths: new Set(["/root"]),
      selectedPaths: new Set(),
      tabs: [],
      activeTabId: null,
      ideVisible: true,
      showHiddenFiles: false,
      conflictState: null,
      transferTask: null,
    });
  });

  it("opens a confirmation dialog before a context-menu delete", async () => {
    render(<IdeFileTree />);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "test.txt" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));

    expect(await screen.findByRole("alertdialog")).toHaveTextContent("删除这个文件？");
    expect(screen.getByText(/将删除文件「test\.txt」/)).toBeInTheDocument();
    expect(sftpRemove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
