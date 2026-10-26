import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SshConnections } from "./SshConnections";
import { useTerminalStore } from "../terminal/store/terminalStore";
import type { ConnectionConfig } from "../terminal/types/terminal";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const passwordMarker = `__mona_ops_password__:ops_pass_${"a".repeat(64)}`;
const config: ConnectionConfig = {
  id: "fixture-ssh", name: "测试主机", protocol: "ssh", host: "192.0.2.10", port: 22, username: "fixture",
  auth: { type: "password", password: passwordMarker }, storageRevision: "revision-1",
};
const initial = useTerminalStore.getInitialState();
let nativeConnections: ConnectionConfig[] = [];
let nativeRevision = 1;
function nativeSnapshot() {
  return { connections: nativeConnections.map((item) => ({ ...item })), revision: `revision-${nativeRevision}` };
}
function maskConnection(connection: ConnectionConfig): ConnectionConfig {
  const saved = { ...connection };
  delete saved.storageRevision;
  if (saved.auth.type === "password") saved.auth = { type: "password", password: passwordMarker };
  else if (saved.auth.type === "key") saved.auth = { type: "key", keyPath: `__mona_ops_private_key__:ops_key_${"b".repeat(64)}`,
    passphrase: saved.auth.passphrase ? `__mona_ops_passphrase__:ops_phrase_${"c".repeat(64)}` : undefined };
  return saved;
}
async function nativeInvoke(command: string, args: Record<string, unknown> = {}) {
  if (command === "terminal_load_connection_state") return nativeSnapshot();
  if (command === "terminal_upsert_connection") {
    const connection = args.connection as ConnectionConfig;
    const index = nativeConnections.findIndex((item) => item.id === connection.id);
    if (index >= 0 && args.expectedRevision !== `revision-${nativeRevision}`
      || index < 0 && args.expectedRevision !== null) throw new Error("saved connection revision conflict");
    const masked = maskConnection(connection);
    if (index >= 0) nativeConnections[index] = masked;
    else nativeConnections.push(masked);
    nativeRevision += 1;
    return nativeSnapshot();
  }
  if (command === "terminal_delete_saved_connection") {
    if (args.expectedRevision !== `revision-${nativeRevision}`) throw new Error("saved connection revision conflict");
    nativeConnections = nativeConnections.filter((item) => item.id !== args.connectionId);
    nativeRevision += 1;
    return nativeSnapshot();
  }
  if (command === "ssh_connect_with_id") return;
  throw new Error("Unexpected fixture IPC: " + command);
}
beforeEach(() => {
  vi.clearAllMocks();
  nativeConnections = [maskConnection(config)];
  nativeRevision = 1;
  useTerminalStore.setState({ ...initial, savedConnections: [config], connections: [config] }, true);
  invoke.mockImplementation(nativeInvoke);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function show() { return render(<SshConnections query="" active onOpen={() => {}} />); }
async function menu(label: string) {
  fireEvent.contextMenu(screen.getByRole("button", { name: "打开 SSH 测试主机" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: label }));
}

describe("SSH sidebar edit and copy", () => {
  it.each([false, true])("offers a copy action with an icon while connected=%s", async (connected) => {
    if (connected) useTerminalStore.setState({ sessions: [{ id: "live", configId: config.id, type: "ssh", status: "connected", title: config.name }], activeSessionId: "live" });
    show();
    fireEvent.contextMenu(screen.getByRole("button", { name: "打开 SSH 测试主机" }));
    expect((await screen.findByRole("menuitem", { name: "复制会话" })).querySelector("svg")).not.toBeNull();
    if (connected) expect(screen.getByRole("menuitem", { name: "新开 SSH 会话" }).querySelector("svg")).not.toBeNull();
  });

  it("new SSH session creates another live session rather than copying the saved host", async () => {
    useTerminalStore.setState({ sessions: [{ id: "live", configId: config.id, type: "ssh", status: "connected", title: config.name }], activeSessionId: "live" });
    show();
    await menu("新开 SSH 会话");
    await waitFor(() => expect(useTerminalStore.getState().sessions).toHaveLength(2));
    expect(useTerminalStore.getState().savedConnections).toHaveLength(1);
    expect(invoke.mock.calls.filter(([name]) => name === "ssh_connect_with_id")).toHaveLength(1);
  });

  it("preserves the current saved list when native loading fails", async () => {
    invoke.mockImplementation((command: string, args: Record<string, unknown> = {}) => command === "terminal_load_connection_state"
      ? Promise.reject(new Error("fixture unavailable")) : nativeInvoke(command, args));
    await expect(useTerminalStore.getState().loadSavedConnections()).rejects.toThrow("fixture unavailable");
    expect(useTerminalStore.getState().savedConnections).toEqual([config]);
  });

  it("serializes new saved-connection writes so returned snapshots cannot clobber each other", async () => {
    const second: ConnectionConfig = { ...config, id: "fixture-ssh-two", name: "第二台主机", storageRevision: undefined };
    await Promise.all([
      useTerminalStore.getState().saveConnection({ ...config, id: "fixture-ssh-one", storageRevision: undefined }),
      useTerminalStore.getState().saveConnection(second),
    ]);
    const saved = useTerminalStore.getState().savedConnections;
    expect(saved.map((item) => item.id)).toEqual(["fixture-ssh", "fixture-ssh-one", "fixture-ssh-two"]);
    expect(saved.every((item) => item.storageRevision === "revision-3")).toBe(true);
    expect(invoke.mock.calls.filter(([command]) => command === "terminal_upsert_connection").map(([, args]) => args.expectedRevision))
      .toEqual([null, null]);
  });

  it("cancel closes the editor directly and discards the draft without a legacy dialog", async () => {
    show(); await menu("编辑");
    const dialog = await screen.findByRole("dialog", { name: "编辑会话" });
    expect(within(dialog).queryByRole("button", { name: "Agent" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "认证方式" }).querySelectorAll("button")).toHaveLength(2);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "会话名称" }), { target: { value: "未保存改名" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("会话管理")).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
    await menu("编辑");
    expect(screen.getByRole("textbox", { name: "会话名称" })).toHaveValue(config.name);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("saves an edit under the original id without exposing or clearing the saved password", async () => {
    show(); await menu("编辑");
    expect(screen.getByLabelText("密码", { selector: "input" })).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox", { name: "会话名称" }), { target: { value: "更新名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useTerminalStore.getState().savedConnections).toEqual([{ ...config, name: "更新名称", storageRevision: "revision-2" }]);
    expect(invoke).toHaveBeenCalledWith("terminal_upsert_connection", expect.objectContaining({ expectedRevision: "revision-1" }));
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it("copies settings under a new id only after confirmation and never opens an SSH session", async () => {
    show(); await menu("复制会话");
    expect(await screen.findByRole("dialog", { name: "复制会话" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "会话名称" })).toHaveValue("测试主机（副本）");
    expect(screen.getByRole("textbox", { name: "主机地址" })).toHaveValue(config.host);
    expect(screen.getByRole("button", { name: "创建副本" })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("密码", { selector: "input" }), { target: { value: "copy-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "创建副本" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const saved = useTerminalStore.getState().savedConnections;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toEqual({ ...config, storageRevision: "revision-2" });
    expect(saved[1]).toMatchObject({ name: "测试主机（副本）", host: config.host, port: config.port, username: config.username, auth: { type: "password", password: passwordMarker } });
    expect(saved[1].id).not.toBe(config.id);
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["terminal_upsert_connection"]);
    expect(invoke.mock.calls[0][1]).toMatchObject({ expectedRevision: null, connection: { auth: { password: "copy-secret" } } });
  });

  it("does not reuse an encrypted credential for a different target", async () => {
    show(); await menu("复制会话");
    fireEvent.change(screen.getByRole("textbox", { name: "主机地址" }), { target: { value: "192.0.2.11" } });
    expect(screen.getByRole("button", { name: "创建副本" })).toBeDisabled();
    expect(screen.getByText(/新目标的认证信息/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "主机地址" }), { target: { value: config.host } });
    expect(screen.getByRole("button", { name: "创建副本" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("密码", { selector: "input" }), { target: { value: "new-target-secret" } });
    expect(screen.getByRole("button", { name: "创建副本" })).toBeEnabled();
    fireEvent.change(screen.getByRole("spinbutton", { name: "端口" }), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "创建副本" })).toBeDisabled();
  });

  it("keeps saved key passphrases out of the input and retains them for unchanged targets", async () => {
    const keyed: ConnectionConfig = { ...config, auth: { type: "key", keyPath: `__mona_ops_private_key__:ops_key_${"b".repeat(64)}`,
      passphrase: `__mona_ops_passphrase__:ops_phrase_${"c".repeat(64)}` } };
    nativeConnections = [maskConnection(keyed)];
    useTerminalStore.setState({ savedConnections: [keyed], connections: [keyed] });
    show(); await menu("编辑");
    expect(screen.getByRole("button", { name: "密钥", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "密钥路径" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "密钥路径" })).toHaveAttribute("placeholder", "已保存的私钥（留空则保留）");
    expect(screen.getByLabelText("密钥密码")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useTerminalStore.getState().savedConnections[0].auth).toEqual(keyed.auth);
  });

  it("shows a save error, rolls back the original and does not duplicate pending requests", async () => {
    let rejectSave!: (error: Error) => void;
    invoke.mockImplementation((command: string, args: Record<string, unknown>) => command === "terminal_upsert_connection"
      ? new Promise((_, reject) => { rejectSave = reject; }) : nativeInvoke(command, args));
    show(); await menu("编辑");
    fireEvent.change(screen.getByRole("textbox", { name: "会话名称" }), { target: { value: "new" } });
    expect(screen.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
    const form = screen.getByRole("textbox", { name: "会话名称" }).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    await act(async () => rejectSave(new Error("fixture write failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存连接失败");
    expect(screen.getByRole("dialog", { name: "编辑会话" })).toBeInTheDocument();
    expect(useTerminalStore.getState().savedConnections).toEqual([config]);
    expect(invoke).toHaveBeenCalledWith("terminal_load_connection_state");
  });

  it("refreshes after a delete conflict and keeps the current connection active", async () => {
    nativeConnections = [maskConnection({ ...config, name: "另一设备更新" })];
    nativeRevision = 2;
    useTerminalStore.setState({ sessions: [{ id: "live", configId: config.id, type: "ssh", status: "connected", title: config.name }] });
    show();
    fireEvent.contextMenu(screen.getByRole("button", { name: "打开 SSH 测试主机" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除连接" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("terminal_delete_saved_connection", {
      connectionId: config.id, expectedRevision: "revision-1",
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent("删除连接失败，列表已刷新");
    expect(useTerminalStore.getState().savedConnections).toEqual([{ ...config, name: "另一设备更新", storageRevision: "revision-2" }]);
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("terminal_delete_saved_connection", {
      connectionId: config.id, expectedRevision: "revision-1",
    });
    expect(invoke).toHaveBeenCalledWith("terminal_load_connection_state");
    expect(invoke).not.toHaveBeenCalledWith("ssh_disconnect", expect.anything());
  });
});
