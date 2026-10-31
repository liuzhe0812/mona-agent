import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const localDesktopDir = vi.hoisted(() => vi.fn());
const localListDir = vi.hoisted(() => vi.fn());
const sftpCanonicalize = vi.hoisted(() => vi.fn());
const sftpList = vi.hoisted(() => vi.fn());
const sftpRemove = vi.hoisted(() => vi.fn());
const sftpMkdir = vi.hoisted(() => vi.fn());
const sftpStat = vi.hoisted(() => vi.fn());
const sftpUpload = vi.hoisted(() => vi.fn());
const sftpUploadFile = vi.hoisted(() => vi.fn());
const sftpUploadDir = vi.hoisted(() => vi.fn());
const sftpDownloadFile = vi.hoisted(() => vi.fn());
const sftpDownloadDir = vi.hoisted(() => vi.fn());
const sftpCancelTransfer = vi.hoisted(() => vi.fn());
const onTransferProgress = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());

vi.mock("../ipc", () => ({
  localDesktopDir,
  localListDir,
  onTransferProgress,
  sftpCanonicalize,
  sftpList,
  sftpRemove,
  sftpMkdir,
  sftpStat,
  sftpUpload,
  sftpUploadFile,
  sftpUploadDir,
  sftpDownloadFile,
  sftpDownloadDir,
  sftpCancelTransfer,
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  onTerminalSessionStatus: vi.fn().mockResolvedValue(() => {}),
  onTerminalMaintenanceUpdated: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open, save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ remove }));

import { FileManager } from "./FileManager";
import { useTerminalStore } from "../store/terminalStore";
import { getFileIconSource } from "@/lib/file-icons";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function dropFiles(target: HTMLElement, side: "local" | "remote", files: object[]) {
  fireEvent.drop(target, {
    dataTransfer: { getData: () => JSON.stringify({ side, files }) },
  });
}

function directory(name: string, entries: object[]) {
  return {
    name, isDirectory: true, isFile: false,
    createReader: () => {
      let read = false;
      return { readEntries: (resolve: (items: object[]) => void) => { resolve(read ? [] : entries); read = true; } };
    },
  };
}

describe("FileManager", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useTerminalStore.setState({ sessions: [{ id: "session-1", configId: "", type: "ssh", status: "connected", title: "主机" }], activeSessionId: "session-1" });
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
    sftpMkdir.mockResolvedValue(undefined);
    sftpStat.mockResolvedValue({ isDir: true });
    sftpUpload.mockResolvedValue(undefined);
    sftpUploadFile.mockResolvedValue(undefined);
    sftpUploadDir.mockResolvedValue(undefined);
    sftpDownloadFile.mockResolvedValue(undefined);
    sftpDownloadDir.mockResolvedValue(undefined);
    sftpCancelTransfer.mockResolvedValue(undefined);
    onTransferProgress.mockResolvedValue(() => {});
    open.mockResolvedValue(null);
    save.mockResolvedValue(null);
    remove.mockResolvedValue(undefined);
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

  it("waits for the progress listener and cancels the active file without starting another transfer", async () => {
    const listener = deferred<() => void>();
    const active = deferred<void>();
    const unlisten = vi.fn();
    onTransferProgress.mockReturnValueOnce(listener.promise);
    sftpUploadFile.mockReturnValueOnce(active.promise);
    render(<FileManager sessionId="session-1" />);
    await screen.findByText("test.txt");
    const remote = screen.getByRole("region", { name: "远程文件" });
    const files = ["a.txt", "b.txt"].map((name) => ({ name, path: `C:\\data\\${name}`, isDir: false, size: 1 }));
    dropFiles(remote, "local", files);
    await waitFor(() => expect(onTransferProgress).toHaveBeenCalledTimes(1));
    expect(sftpUploadFile).not.toHaveBeenCalled();

    await act(async () => { listener.resolve(unlisten); });
    await waitFor(() => expect(sftpUploadFile).toHaveBeenCalledTimes(1));
    const fileTaskId = sftpUploadFile.mock.calls[0][3];
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(sftpCancelTransfer).toHaveBeenCalledWith(fileTaskId));
    expect(screen.getByText("正在取消…")).toBeInTheDocument();
    dropFiles(remote, "local", [files[1]]);
    expect(sftpUploadFile).toHaveBeenCalledTimes(1);

    await act(async () => { active.reject(new Error("Transfer cancelled")); });
    await screen.findByText("已取消，部分内容可能已传输");
    expect(sftpUploadFile).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(1);
    dropFiles(remote, "local", [files[1]]);
    await waitFor(() => expect(sftpUploadFile).toHaveBeenCalledTimes(2));
  });

  it("does not start writing if cancelled while the progress listener is being registered", async () => {
    const listener = deferred<() => void>();
    const unlisten = vi.fn();
    onTransferProgress.mockReturnValueOnce(listener.promise);
    render(<FileManager sessionId="session-1" />);
    await screen.findByText("test.txt");
    dropFiles(screen.getByRole("region", { name: "远程文件" }), "local", [
      { name: "a.txt", path: "C:\\data\\a.txt", isDir: false, size: 1 },
    ]);
    await waitFor(() => expect(onTransferProgress).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => { listener.resolve(unlisten); });
    await screen.findByText("已取消，部分内容可能已传输");
    expect(sftpUploadFile).not.toHaveBeenCalled();
    expect(sftpCancelTransfer).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("keeps a transfer running and its progress when the panel is hidden and reopened", async () => {
    const active = deferred<void>();
    let progress!: (value: object) => void;
    onTransferProgress.mockImplementation((_sessionId, _taskId, handler) => {
      progress = handler;
      return Promise.resolve(() => {});
    });
    sftpUploadFile.mockReturnValueOnce(active.promise);
    render(<FileManager sessionId="session-1" />);
    await screen.findByText("test.txt");
    dropFiles(screen.getByRole("region", { name: "远程文件" }), "local", [
      { name: "a.txt", path: "C:\\data\\a.txt", isDir: false, size: 100 },
    ]);
    await waitFor(() => expect(sftpUploadFile).toHaveBeenCalledTimes(1));
    act(() => progress({ percentage: 40, speed: 256, bytesTransferred: 40, totalBytes: 100 }));
    expect(screen.getByText("40%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起传输记录" }));
    expect(useTerminalStore.getState().sessions[0].transferPanelVisible).toBe(false);
    expect(screen.queryByText("40%")).not.toBeInTheDocument();
    act(() => progress({ percentage: 70, speed: 256, bytesTransferred: 70, totalBytes: 100 }));
    act(() => useTerminalStore.getState().updateSession("session-1", { transferPanelVisible: true }));
    expect(screen.getByText("70%")).toBeInTheDocument();
    expect(sftpCancelTransfer).not.toHaveBeenCalled();
    await act(async () => { active.resolve(); });
    await screen.findByText("上传完成");
  });

  it("keeps the task active and reports a failed cancellation", async () => {
    const active = deferred<void>();
    sftpUploadFile.mockReturnValueOnce(active.promise);
    sftpCancelTransfer.mockRejectedValueOnce(new Error("not registered"));
    render(<FileManager sessionId="session-1" />);
    await screen.findByText("test.txt");
    const remote = screen.getByRole("region", { name: "远程文件" });
    const file = { name: "a.txt", path: "C:\\data\\a.txt", isDir: false, size: 1 };
    dropFiles(remote, "local", [file]);
    await waitFor(() => expect(sftpUploadFile).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findByRole("dialog", { name: "操作未完成" })).toHaveTextContent("取消传输失败");
    dropFiles(remote, "local", [file]);
    expect(sftpUploadFile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await act(async () => { active.resolve(); });
    await screen.findByText("已取消，部分内容可能已传输");
  });

  it("streams picker upload and context-menu download and reports failures", async () => {
    open.mockResolvedValue("C:\\data\\picked.txt");
    save.mockResolvedValue("C:\\data\\saved.txt");
    sftpDownloadFile.mockRejectedValueOnce(new Error("private transport detail"));
    render(<FileManager sessionId="session-1" />);
    await screen.findByText("test.txt");
    fireEvent.click(screen.getByRole("button", { name: "上传文件" }));
    await waitFor(() => expect(sftpUploadFile).toHaveBeenCalledWith("session-1", "C:\\data\\picked.txt", "/root/picked.txt", expect.any(String)));
    await screen.findByText("上传完成");
    fireEvent.contextMenu(screen.getByText("test.txt").closest("tr")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "下载" }));
    await waitFor(() => expect(sftpDownloadFile).toHaveBeenCalledWith("session-1", "/root/test.txt", "C:\\data\\saved.txt", expect.any(String)));
    const dialog = await screen.findByRole("dialog", { name: "操作未完成" });
    expect(dialog).toHaveTextContent("下载失败");
    expect(dialog).not.toHaveTextContent("private transport detail");
  });

  it("preserves an empty system folder and reports directory read failures", async () => {
    render(<FileManager sessionId="session-1" />);
    await screen.findByText("test.txt");
    const remote = screen.getByRole("region", { name: "远程文件" });
    const item = (entry: object) => ({ webkitGetAsEntry: () => entry, getAsFile: () => null });
    const dataTransfer = (entry: object) => ({ getData: () => "", items: [item(entry)], files: [] });
    fireEvent.drop(remote, { dataTransfer: dataTransfer(directory("folder", [directory("empty", [])])) });
    await waitFor(() => expect(sftpMkdir).toHaveBeenCalledWith("session-1", "/root/folder/empty"));
    expect(sftpMkdir).toHaveBeenCalledWith("session-1", "/root/folder");
    await screen.findByText("上传完成");

    const broken = { name: "broken.txt", isFile: true, isDirectory: false, file: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error("unavailable")) };
    fireEvent.drop(remote, { dataTransfer: dataTransfer(directory("unreadable", [broken])) });
    expect(await screen.findByRole("dialog", { name: "操作未完成" })).toHaveTextContent("读取拖入的文件夹失败");
    expect(sftpMkdir).not.toHaveBeenCalledWith("session-1", "/root/unreadable");
  });

  it("keeps a cut directory when upload fails and removes it only after successful transfer", async () => {
    localListDir.mockResolvedValue([{ name: "project", path: "C:\\data\\project", isDir: true, size: null, modified: null }]);
    sftpUploadDir.mockRejectedValueOnce(new Error("connection lost"));
    render(<FileManager sessionId="session-1" />);
    await screen.findByText("project");
    await screen.findByText("test.txt");
    fireEvent.contextMenu(screen.getByText("project").closest("tr")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "剪切" }));
    fireEvent.contextMenu(screen.getByText("test.txt").closest("tr")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "粘贴" }));
    await screen.findByRole("dialog", { name: "操作未完成" });
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    fireEvent.contextMenu(screen.getByText("test.txt").closest("tr")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "粘贴" }));
    await waitFor(() => expect(sftpUploadDir).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("C:\\data\\project", { recursive: true }));
  });

  it("rejects multiple downloads that would overwrite the same local name", async () => {
    render(<FileManager sessionId="session-1" />);
    await screen.findByText("test.txt");
    dropFiles(screen.getByRole("region", { name: "本地文件" }), "remote", [
      { name: "a:b", path: "/root/a:b", isDir: false, size: 1 },
      { name: "a?b", path: "/root/a?b", isDir: false, size: 1 },
    ]);
    expect(await screen.findByRole("dialog", { name: "操作未完成" })).toHaveTextContent("文件名在本地会重复");
    expect(sftpDownloadFile).not.toHaveBeenCalled();
    expect(sftpRemove).not.toHaveBeenCalled();
  });

  it("rejects system files with the same remote destination before uploading", async () => {
    render(<FileManager sessionId="session-1" />);
    await screen.findByText("test.txt");
    const files = [new File(["first"], "same.txt"), new File(["second"], "same.txt")];
    fireEvent.drop(screen.getByRole("region", { name: "远程文件" }), {
      dataTransfer: {
        getData: () => "",
        items: files.map((file) => ({
          webkitGetAsEntry: () => ({ isDirectory: false }),
          getAsFile: () => file,
        })),
        files,
      },
    });
    expect(await screen.findByRole("dialog", { name: "操作未完成" })).toHaveTextContent("远程目标相同");
    expect(onTransferProgress).not.toHaveBeenCalled();
    expect(sftpUpload).not.toHaveBeenCalled();
    expect(sftpUploadFile).not.toHaveBeenCalled();
  });

  it("does not upload to the default root while the remote directory is still loading", async () => {
    const home = deferred<string>();
    sftpCanonicalize.mockReturnValueOnce(home.promise);
    render(<FileManager sessionId="session-1" />);
    dropFiles(screen.getByRole("region", { name: "远程文件" }), "local", [
      { name: "a.txt", path: "C:\\data\\a.txt", isDir: false, size: 1 },
    ]);
    expect(await screen.findByRole("dialog", { name: "操作未完成" })).toHaveTextContent("远程目录尚未加载");
    expect(sftpUploadFile).not.toHaveBeenCalled();
    await act(async () => { home.resolve("/root"); });
  });
});
