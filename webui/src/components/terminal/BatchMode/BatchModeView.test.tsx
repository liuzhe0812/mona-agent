import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBatchStore } from "../store/batchStore";
import { useTerminalStore } from "../store/terminalStore";

const choose = vi.hoisted(() => vi.fn());
const ipc = vi.hoisted(() => ({
  sshConnectWithId: vi.fn(), sshDisconnect: vi.fn(), sshSendInput: vi.fn(), sshTrustHostKey: vi.fn(),
  sftpList: vi.fn(), sftpDownload: vi.fn(), sftpBatchUpload: vi.fn(), sftpBatchCancel: vi.fn(), sftpBatchPause: vi.fn(), sftpBatchResume: vi.fn(),
  sftpRemove: vi.fn(), sftpRename: vi.fn(), sftpMkdir: vi.fn(), sftpDownloadFile: vi.fn(), sftpDownloadDir: vi.fn(),
  sftpCancelTransfer: vi.fn(), sftpPaste: vi.fn(), expandUploadPaths: vi.fn(), onBatchTransferProgress: vi.fn(), onTransferProgress: vi.fn(),
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  onTerminalSessionStatus: vi.fn().mockResolvedValue(() => {}),
  onTerminalMaintenanceUpdated: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../ipc", () => ipc);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: choose }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => false }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  loadAddon() {} open() {} writeln() {} write() {} focus() {} scrollToBottom() {} dispose() {} onData() {}
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

import { BatchModeView } from "./BatchModeView";
const batchInitial = useBatchStore.getInitialState();
const terminalInitial = useTerminalStore.getInitialState();
beforeEach(() => {
  vi.clearAllMocks();
  ipc.sshConnectWithId.mockReset().mockResolvedValue("session");
  ipc.sshTrustHostKey.mockReset().mockResolvedValue(undefined);
  ipc.sftpList.mockReset().mockResolvedValue([]);
  ipc.onTerminalSessionStatus.mockReset().mockResolvedValue(() => {});
  ipc.onBatchTransferProgress.mockReset().mockResolvedValue(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useBatchStore.setState({ ...batchInitial }, true);
  useTerminalStore.setState({ ...terminalInitial, activeSessionId: "batch-tab", sessions: [
    { id: "batch-tab", configId: "", type: "batch", status: "connected", title: "SSH 批量管理" },
  ] }, true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function prepareBatch(startIp = "192.0.2.20", count = 1) {
  useBatchStore.setState({ ...batchInitial, startIp, count, username: "fixture", port: 22, activeTab: "terminal",
    sessions: [], activeSessionId: null, isConnecting: false, configCollapsed: false }, true);
}

it.each([
  ["192.0.2.999", 1, /请输入有效的 IPv4 地址/],
  ["192.0.2.254", 3, /地址末段不能超过 255/],
  ["192.0.2.20", 101, /数量须为 1–100/],
])("rejects invalid batch targets %s / %i", (ip, count, message) => {
  prepareBatch();
  render(<BatchModeView />);

  fireEvent.change(screen.getByLabelText("起始 IP"), { target: { value: ip } });
  fireEvent.change(screen.getByLabelText("数量"), { target: { value: String(count) } });
  fireEvent.click(screen.getByRole("button", { name: "开始连接" }));

  expect(screen.getByText(message)).toBeInTheDocument();
  expect(ipc.sshConnectWithId).not.toHaveBeenCalled();
});

it.each([false, true])("defaults automatic trust on and honors the selected value: %s", async (enabled) => {
  prepareBatch();
  render(<BatchModeView />);
  const automaticTrust = screen.getByRole("checkbox", { name: "自动信任首次连接的主机" });
  expect(automaticTrust).toBeChecked();
  if (!enabled) fireEvent.click(automaticTrust);

  fireEvent.click(screen.getByRole("button", { name: "开始连接" }));

  await waitFor(() => expect(ipc.sshConnectWithId).toHaveBeenCalledWith(
    expect.any(String), expect.objectContaining({ host: "192.0.2.20" }), undefined, undefined, enabled,
  ));
});

it("counts and sends commands only to selected connected hosts", async () => {
  prepareBatch();
  useBatchStore.setState({ sessions: [
    { id: "connected", host: "192.0.2.20", port: 22, username: "fixture", status: "connected", selected: true },
    { id: "failed", host: "192.0.2.21", port: 22, username: "fixture", status: "error", selected: true },
    { id: "unselected", host: "192.0.2.22", port: 22, username: "fixture", status: "connected", selected: false },
  ], activeSessionId: "connected" });
  render(<BatchModeView />);

  expect(screen.getByText("发送至 1 台主机")).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText(/输入命令/), { target: { value: "pwd" } });
  fireEvent.click(screen.getByRole("button", { name: /发送/ }));

  await waitFor(() => expect(ipc.sshSendInput).toHaveBeenCalledWith("connected", "pwd\n"));
  expect(ipc.sshSendInput).toHaveBeenCalledTimes(1);
});

it("removes a closed connection from batch sending targets", async () => {
  prepareBatch();
  useBatchStore.setState({ sessions: [
    { id: "connected", host: "192.0.2.20", port: 22, username: "fixture", status: "connected", selected: true },
  ], activeSessionId: "connected" });
  render(<BatchModeView />);
  expect(screen.getByText("发送至 1 台主机")).toBeInTheDocument();

  const handleStatus = ipc.onTerminalSessionStatus.mock.calls.at(-1)![0];
  act(() => handleStatus({ sessionId: "connected", status: "disconnected" }));

  expect(useBatchStore.getState().sessions[0]).toMatchObject({ status: "disconnected", selected: false });
  expect(screen.queryByText("发送至 1 台主机")).not.toBeInTheDocument();
});

it("confirms and trusts unknown host keys separately for each host", async () => {
  prepareBatch("192.0.2.20", 2);
  const attempts = new Map<string, number>();
  ipc.sshConnectWithId.mockImplementation(async (_id: string, config: { host: string }) => {
    const attempt = (attempts.get(config.host) ?? 0) + 1;
    attempts.set(config.host, attempt);
    if (attempt === 1) throw new Error(`Host key unknown: SHA256:key-${config.host}`);
    return "session";
  });
  render(<BatchModeView />);
  fireEvent.click(screen.getByRole("checkbox", { name: "自动信任首次连接的主机" }));
  fireEvent.click(screen.getByRole("button", { name: "开始连接" }));

  await waitFor(() => expect(useBatchStore.getState().sessions.map((s) => s.status)).toEqual(["untrusted", "untrusted"]));
  expect(ipc.sshTrustHostKey).not.toHaveBeenCalled();
  for (const host of ["192.0.2.20", "192.0.2.21"]) {
    fireEvent.click(screen.getByTitle(host));
    fireEvent.click(screen.getByRole("button", { name: "信任并连接" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(host);
    expect(dialog).toHaveTextContent(`SHA256:key-${host}`);
    fireEvent.click(within(dialog).getByRole("button", { name: "信任并连接" }));
    await waitFor(() => expect(ipc.sshTrustHostKey).toHaveBeenCalledWith(host, 22, `SHA256:key-${host}`));
    await waitFor(() => expect(useBatchStore.getState().sessions.find((s) => s.host === host)?.status).toBe("connected"));
  }
  expect(ipc.sshConnectWithId).toHaveBeenCalledTimes(4);
});

it("requires explicit confirmation of a changed host key", async () => {
  prepareBatch();
  ipc.sshConnectWithId.mockRejectedValueOnce(new Error("Host key changed: expected SHA256:old-key, got SHA256:new-key"));
  render(<BatchModeView />);
  fireEvent.click(screen.getByRole("button", { name: "开始连接" }));

  await waitFor(() => expect(useBatchStore.getState().sessions[0]?.status).toBe("untrusted"));
  fireEvent.click(screen.getByTitle("192.0.2.20"));
  expect(screen.getByText("主机密钥已变更")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "核实主机身份" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("SHA256:old-key");
  expect(dialog).toHaveTextContent("SHA256:new-key");
  expect(ipc.sshTrustHostKey).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "确认更换并连接" }));
  await waitFor(() => expect(ipc.sshTrustHostKey).toHaveBeenCalledWith("192.0.2.20", 22, "SHA256:new-key"));
});
