import { beforeEach, describe, expect, it, vi } from "vitest";
import { openSavedConnection } from "./saved-connection";
import { useTerminalStore } from "./store/terminalStore";
import type { ConnectionConfig } from "./types/terminal";

const connect = vi.hoisted(() => vi.fn());
const disconnect = vi.hoisted(() => vi.fn());
vi.mock("./ipc", () => ({
  sshConnectWithId: connect,
  sshDisconnect: disconnect,
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  onTerminalSessionStatus: vi.fn().mockResolvedValue(() => {}),
  onTerminalMaintenanceUpdated: vi.fn().mockResolvedValue(() => {}),
  terminalUpsertConnection: vi.fn().mockResolvedValue([]),
  terminalDeleteSavedConnection: vi.fn().mockResolvedValue([]),
}));
const config: ConnectionConfig = { id: "saved-one", protocol: "ssh", name: "Fixture", host: "192.0.2.20", port: 22, username: "test", auth: { type: "agent" } };
const initial = useTerminalStore.getInitialState();
beforeEach(() => { vi.clearAllMocks(); useTerminalStore.setState({ ...initial }, true); connect.mockResolvedValue("native-id"); });
const settled = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("shared saved SSH connection", () => {
  it("retains a single explicit session identity from connecting to ready", async () => {
    const id = openSavedConnection(config);
    expect(useTerminalStore.getState().sessions[0]).toMatchObject({ id, configId: config.id, status: "connecting" });
    await settled();
    expect(connect).toHaveBeenCalledWith(id, config);
    expect(useTerminalStore.getState().sessions[0]).toMatchObject({ id, status: "connected" });
  });
  it.each([
    ["Host key unknown: SHA256:fixture-new", "unknown", "SHA256:fixture-new", ""],
    ["Host key changed: expected SHA256:fixture-old, got SHA256:fixture-new", "changed", "SHA256:fixture-new", "SHA256:fixture-old"],
  ])("does not bypass host confirmation: %s", async (message, type, fingerprint, expectedFingerprint) => {
    connect.mockRejectedValueOnce(new Error(message));
    const id = openSavedConnection(config); await settled();
    expect(useTerminalStore.getState().hostKeyDialog).toMatchObject({ open: true, type, fingerprint, expectedFingerprint, pendingSessionId: id });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().sessions[0].status).not.toBe("connected");
  });
  it("credential cancellation leaves the connection failed without retrying", async () => {
    connect.mockRejectedValueOnce(new Error("authentication failed"));
    openSavedConnection(config); await settled();
    const dialog = useTerminalStore.getState().sshPasswordDialog;
    expect(dialog.open).toBe(true); dialog.onCancel();
    expect(useTerminalStore.getState().sessions[0].status).toBe("error");
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it("late credential confirmation cannot reconnect a removed session", async () => {
    connect.mockRejectedValueOnce(new Error("authentication failed"));
    const id = openSavedConnection(config); await settled();
    const dialog = useTerminalStore.getState().sshPasswordDialog;
    useTerminalStore.getState().removeSession(id);
    await expect(dialog.onConfirm("fixture-only")).rejects.toThrow("原连接已关闭");
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it("releases the same late connection when its tab was closed during connection", async () => {
    let finish!: () => void;
    connect.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const id = openSavedConnection(config);
    useTerminalStore.getState().removeSession(id);
    finish(); await settled();
    expect(disconnect).toHaveBeenCalledWith(id);
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it("does not reopen a credential prompt after the user closed a connecting tab", async () => {
    let fail!: (error: Error) => void;
    connect.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const id = openSavedConnection(config);
    useTerminalStore.getState().removeSession(id);
    fail(new Error("authentication failed")); await settled();
    expect(useTerminalStore.getState().sshPasswordDialog.open).toBe(false);
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });
  it("non-authentication errors do not open password prompts or report success", async () => {
    connect.mockRejectedValueOnce(new Error("connection refused"));
    openSavedConnection(config); await settled();
    expect(useTerminalStore.getState().sessions[0].status).toBe("error");
    expect(useTerminalStore.getState().sshPasswordDialog.open).toBe(false);
    expect(useTerminalStore.getState().hostKeyDialog.open).toBe(false);
  });
});
