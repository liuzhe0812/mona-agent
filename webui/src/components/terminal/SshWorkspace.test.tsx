import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SshWorkspace } from "./SshWorkspace";
import { Toolbar } from "./Toolbar";
import { SessionTabBar } from "./SessionTabBar";
import { FileManager } from "./FileManager/FileManager";
import { useTerminalStore } from "./store/terminalStore";

const native = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: native }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@/hooks/useLicense", () => ({ useLicense: () => ({ licenseActive: false }) }));
vi.mock("./XtermTerminal", () => ({
  XtermTerminal: ({ sessionId }: { sessionId: string }) => <textarea aria-label={`终端 ${sessionId}`} defaultValue="shell draft" />,
}));

const initial = useTerminalStore.getInitialState();
beforeEach(() => {
  vi.clearAllMocks();
  useTerminalStore.setState({ ...initial, sessions: [
    { id: "ssh-a", configId: "config-a", type: "ssh", status: "connected", title: "主机 A" },
    { id: "ssh-b", configId: "config-b", type: "ssh", status: "connected", title: "主机 B" },
  ], activeSessionId: "ssh-a" }, true);
  native.mockImplementation(async (command: string, args: Record<string, string>) => {
    if (command === "local_desktop_dir") return "D:\\Fixtures\\Desktop";
    if (command === "local_list_dir") return [{ name: "project", path: "D:\\Fixtures\\Desktop\\project", isDir: true, size: null, modified: null }];
    if (command === "sftp_canonicalize") return `/home/${args.sessionId}`;
    if (command === "sftp_list") return [{ name: "logs", path: args.path + "/logs", isDir: true, size: null, mtime: null, permissions: null }];
    if (command === "get_file_type_icon") return null;
    if (command === "sftp_rename") return undefined;
    throw new Error("Unexpected native call: " + command);
  });
});
afterEach(cleanup);

function workspace() {
  return render(<><Toolbar embedded /><SessionTabBar embedded /><SshWorkspace sessionId="ssh-a" active /></>);
}

describe("SSH shell with an embedded SFTP file area", () => {
  it("opens and closes this session's transfer panel from the toolbar", async () => {
    workspace();
    await screen.findByRole("button", { name: "远程路径" });
    fireEvent.click(screen.getByRole("button", { name: "传输记录" }));
    expect(screen.getByText("暂无传输记录")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起传输记录" }));
    expect(screen.queryByText("暂无传输记录")).not.toBeInTheDocument();
    expect(useTerminalStore.getState().sessions[0].transferPanelVisible).toBe(false);
    expect(useTerminalStore.getState().sessions[1].transferPanelVisible).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "收起文件区" }));
    fireEvent.click(screen.getByRole("button", { name: "传输记录" }));
    expect(screen.getByText("暂无传输记录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起文件区" })).toHaveAttribute("aria-expanded", "true");
  });

  it("renders shell and local/remote files together with one toolbar per side and no old file tree", async () => {
    workspace();
    await screen.findByRole("button", { name: "远程路径" });
    await waitFor(() => expect(native).toHaveBeenCalledWith("sftp_list", { sessionId: "ssh-a", path: "/home/ssh-a" }));
    expect(screen.getByRole("textbox", { name: "终端 ssh-a" })).toBeInTheDocument();
    for (const side of ["本地", "远程"]) {
      const toolbar = screen.getByRole("toolbar", { name: side + "文件工具栏" });
      expect(toolbar).toHaveClass("h-8", "flex-nowrap");
      expect(within(toolbar).getByRole("button", { name: side + "路径" })).toBeInTheDocument();
      expect(within(toolbar).getByRole("button", { name: "刷新" + side + "目录" })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("toolbar")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /文件树/ })).not.toBeInTheDocument();
    expect(native.mock.calls.some(([command]) => command === "ssh_open_sftp" || command === "ide_open_project")).toBe(false);
  });

  it("toggles only this session's bottom area without creating a tab or remounting the shell/files", async () => {
    workspace();
    await screen.findByRole("button", { name: "远程路径" });
    const shell = screen.getByRole("textbox", { name: "终端 ssh-a" });
    const path = screen.getByRole("button", { name: "远程路径" });
    const fileArea = path.closest('[aria-label="SSH 文件区"]')!;
    fireEvent.change(shell, { target: { value: "do not lose this command" } });
    fireEvent.click(screen.getByRole("button", { name: "收起文件区", exact: true }));
    expect(fileArea).toHaveAttribute("aria-hidden", "true");
    expect(useTerminalStore.getState().sessions[0].sftpVisible).toBe(false);
    expect(useTerminalStore.getState().sessions[1].sftpVisible).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "展开文件区", exact: true }));
    expect(screen.getByRole("button", { name: "远程路径" })).toBe(path);
    expect(screen.getByRole("textbox", { name: "终端 ssh-a" })).toBe(shell);
    expect(shell).toHaveValue("do not lose this command");
    expect(useTerminalStore.getState().sessions).toHaveLength(2);
    expect(useTerminalStore.getState().activeSessionId).toBe("ssh-a");
  });

  it("keeps the edge toggle available when collapsed without a redundant toolbar button", async () => {
    workspace();
    const path = await screen.findByRole("button", { name: "远程路径" });
    const shell = screen.getByRole("textbox", { name: "终端 ssh-a" });
    const fileArea = path.closest('[aria-label="SSH 文件区"]')!;
    const toggle = screen.getByRole("button", { name: "收起文件区", exact: true });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "ssh-files-ssh-a");
    expect(toggle.querySelector("svg")).toHaveClass("lucide-chevron-down");
    fireEvent.pointerDown(toggle, { button: 0 });
    expect(fileArea).toHaveAttribute("aria-hidden", "false");
    fireEvent.click(toggle);
    expect(fileArea).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button", { name: "SFTP", exact: true })).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const reopen = screen.getByRole("button", { name: "展开文件区", exact: true });
    expect(reopen).toBe(toggle);
    expect(reopen.querySelector("svg")).toHaveClass("lucide-chevron-up");
    fireEvent.click(reopen);
    expect(screen.getByRole("button", { name: "远程路径" })).toBe(path);
    expect(screen.getByRole("textbox", { name: "终端 ssh-a" })).toBe(shell);
    fireEvent.click(screen.getByRole("button", { name: "收起文件区", exact: true }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(useTerminalStore.getState().sessions[1].sftpVisible).toBeUndefined();
    expect(useTerminalStore.getState().sessions).toHaveLength(2);
  });

  it("uses the shared thin separator between local and remote file panes", async () => {
    render(<SshWorkspace sessionId="ssh-a" active />);
    await screen.findByRole("button", { name: "远程路径" });
    const separator = screen.getByRole("separator", { name: "调整本地与远程文件区域宽度", exact: true });
    expect(separator).toHaveAttribute("data-slot", "resizable-handle");
    expect(separator).toHaveClass("w-px", "after:w-2");
    expect(separator).not.toHaveClass("w-1");
    expect(screen.getByTestId("sftp-local-ssh-a").querySelector(".border-r")).toBeNull();
  });

  it("opens SFTP from a tab's context menu in that SSH tab instead of making a new tab", async () => {
    useTerminalStore.getState().updateSession("ssh-a", { sftpVisible: false });
    workspace();
    fireEvent.contextMenu(screen.getByRole("tab", { name: /主机 A/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "打开 SFTP" }));
    expect(useTerminalStore.getState().sessions[0].sftpVisible).toBe(true);
    expect(useTerminalStore.getState().sessions).toHaveLength(2);
    await screen.findByRole("button", { name: "远程路径" });
  });

  it("keeps both hosts' directory and search state isolated across hide/show", async () => {
    const view = render(<><SshWorkspace sessionId="ssh-a" active /><SshWorkspace sessionId="ssh-b" active={false} /></>);
    await waitFor(() => expect(screen.getByRole("button", { name: "远程路径" })).toHaveTextContent("/home/ssh-a"));
    fireEvent.doubleClick(within(screen.getByRole("region", { name: "远程文件" })).getByText("logs"));
    await waitFor(() => expect(screen.getByRole("button", { name: "远程路径" })).toHaveTextContent("/home/ssh-a/logs"));
    fireEvent.click(screen.getByRole("button", { name: "搜索远程文件" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索远程文件" }), { target: { value: "notes" } });
    view.rerender(<><SshWorkspace sessionId="ssh-a" active={false} /><SshWorkspace sessionId="ssh-b" active /></>);
    await waitFor(() => expect(screen.getByRole("button", { name: "远程路径" })).toHaveTextContent("/home/ssh-b"));
    view.rerender(<><SshWorkspace sessionId="ssh-a" active /><SshWorkspace sessionId="ssh-b" active={false} /></>);
    expect(screen.getByRole("button", { name: "远程路径" })).toHaveTextContent("/home/ssh-a/logs");
    expect(screen.getByRole("textbox", { name: "搜索远程文件" })).toHaveValue("notes");
  });

  it("waits for connection and refreshes the same directory after reconnect", async () => {
    useTerminalStore.getState().updateSessionStatus("ssh-a", "connecting");
    render(<SshWorkspace sessionId="ssh-a" active />);
    expect(native).not.toHaveBeenCalled();
    act(() => useTerminalStore.getState().updateSessionStatus("ssh-a", "connected"));
    await waitFor(() => expect(screen.getByRole("button", { name: "远程路径" })).toHaveTextContent("/home/ssh-a"));
    fireEvent.doubleClick(within(screen.getByRole("region", { name: "远程文件" })).getByText("logs"));
    await waitFor(() => expect(screen.getByRole("button", { name: "远程路径" })).toHaveTextContent("/home/ssh-a/logs"));
    act(() => useTerminalStore.getState().updateSessionStatus("ssh-a", "disconnected"));
    expect(screen.getByRole("status")).toHaveTextContent("连接主机后即可浏览文件");
    const reads = native.mock.calls.filter(([command]) => command === "sftp_list").length;
    act(() => useTerminalStore.getState().updateSessionStatus("ssh-a", "connected"));
    await waitFor(() => expect(native.mock.calls.filter(([command]) => command === "sftp_list")).toHaveLength(reads + 1));
    expect(native.mock.calls.filter(([command]) => command === "sftp_list").at(-1)).toEqual(["sftp_list", { sessionId: "ssh-a", path: "/home/ssh-a/logs" }]);
  });

  it("does not treat shell, path-input or hidden-panel clipboard shortcuts as file operations", async () => {
    const view = render(<><textarea aria-label="shell" /><FileManager sessionId="ssh-a" /></>);
    const remote = await screen.findByRole("region", { name: "远程文件" });
    const log = await within(remote).findByText("logs");
    fireEvent.mouseDown(log.closest("tr")!);
    expect(remote).toHaveFocus();
    fireEvent.click(log.closest("tr")!);
    fireEvent.keyDown(remote, { key: "x", ctrlKey: true });
    const shell = screen.getByRole("textbox", { name: "shell" });
    fireEvent.keyDown(shell, { key: "v", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "远程路径" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "远程路径" }), { key: "v", ctrlKey: true });
    view.rerender(<><textarea aria-label="shell" /><FileManager sessionId="ssh-a" active={false} /></>);
    fireEvent.keyDown(remote, { key: "v", ctrlKey: true });
    expect(native.mock.calls.some(([command]) => command === "sftp_rename" || command === "sftp_upload" || command === "sftp_download")).toBe(false);
    view.rerender(<><textarea aria-label="shell" /><FileManager sessionId="ssh-a" active /></>);
    fireEvent.keyDown(remote, { key: "v", ctrlKey: true });
    await waitFor(() => expect(native.mock.calls.filter(([command]) => command === "sftp_rename")).toHaveLength(1));
  });

  it("edits paths, searches and preserves the local drive when navigating up", async () => {
    render(<FileManager sessionId="ssh-a" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "本地路径" })).toHaveTextContent("D:\\Fixtures\\Desktop"));
    fireEvent.click(screen.getByRole("button", { name: "本地根目录" }));
    await waitFor(() => expect(native).toHaveBeenCalledWith("local_list_dir", { path: "D:\\" }));
    fireEvent.click(screen.getByRole("button", { name: "远程路径" }));
    const input = screen.getByRole("textbox", { name: "远程路径" });
    fireEvent.change(input, { target: { value: "/srv/app" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(native).toHaveBeenCalledWith("sftp_list", { sessionId: "ssh-a", path: "/srv/app" }));
    fireEvent.click(screen.getByRole("button", { name: "搜索远程文件" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索远程文件" }), { target: { value: "missing" } });
    expect(within(screen.getByRole("region", { name: "远程文件" })).queryByText("logs")).not.toBeInTheDocument();
  });
});
