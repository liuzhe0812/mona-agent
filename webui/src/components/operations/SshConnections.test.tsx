import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SshConnections } from "./SshConnections";
import { useTerminalStore } from "../terminal/store/terminalStore";
import type { ConnectionConfig } from "../terminal/types/terminal";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const config: ConnectionConfig = {
  id: "fixture-ssh", name: "测试主机", protocol: "ssh", host: "192.0.2.10", port: 22, username: "fixture",
  auth: { type: "password", password: "__encrypted__" },
};
const initial = useTerminalStore.getInitialState();
beforeEach(() => {
  vi.clearAllMocks();
  useTerminalStore.setState({ ...initial, savedConnections: [config], connections: [config] }, true);
  invoke.mockImplementation(async (command: string) => {
    if (command === "terminal_save_connections" || command === "ssh_connect_with_id") return;
    throw new Error("Unexpected fixture IPC: " + command);
  });
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
    expect(useTerminalStore.getState().savedConnections).toEqual([{ ...config, name: "更新名称" }]);
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it("copies settings under a new id only after confirmation and never opens an SSH session", async () => {
    show(); await menu("复制会话");
    expect(await screen.findByRole("dialog", { name: "复制会话" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "会话名称" })).toHaveValue("测试主机（副本）");
    expect(screen.getByRole("textbox", { name: "主机地址" })).toHaveValue(config.host);
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "创建副本" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const saved = useTerminalStore.getState().savedConnections;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toEqual(config);
    expect(saved[1]).toMatchObject({ name: "测试主机（副本）", host: config.host, port: config.port, username: config.username, auth: config.auth });
    expect(saved[1].id).not.toBe(config.id);
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["terminal_save_connections"]);
  });

  it("does not reuse an encrypted credential for a different target", async () => {
    show(); await menu("复制会话");
    fireEvent.change(screen.getByRole("textbox", { name: "主机地址" }), { target: { value: "192.0.2.11" } });
    expect(screen.getByRole("button", { name: "创建副本" })).toBeDisabled();
    expect(screen.getByText(/新目标的认证信息/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "主机地址" }), { target: { value: config.host } });
    expect(screen.getByRole("button", { name: "创建副本" })).toBeEnabled();
    fireEvent.change(screen.getByRole("spinbutton", { name: "端口" }), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "创建副本" })).toBeDisabled();
  });

  it("keeps saved key passphrases out of the input and retains them for unchanged targets", async () => {
    const keyed: ConnectionConfig = { ...config, auth: { type: "key", keyPath: "D:/fixtures/id_ed25519", passphrase: "__encrypted__" } };
    useTerminalStore.setState({ savedConnections: [keyed], connections: [keyed] });
    show(); await menu("编辑");
    expect(screen.getByRole("button", { name: "密钥", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("密钥密码")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useTerminalStore.getState().savedConnections[0].auth).toEqual(keyed.auth);
  });

  it("shows a save error, rolls back the original and does not duplicate pending requests", async () => {
    let rejectSave!: (error: Error) => void;
    invoke.mockImplementation(() => new Promise((_, reject) => { rejectSave = reject; }));
    show(); await menu("编辑");
    fireEvent.change(screen.getByRole("textbox", { name: "会话名称" }), { target: { value: "new" } });
    const form = screen.getByRole("textbox", { name: "会话名称" }).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    await act(async () => rejectSave(new Error("fixture write failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存连接失败");
    expect(screen.getByRole("dialog", { name: "编辑会话" })).toBeInTheDocument();
    expect(useTerminalStore.getState().savedConnections).toEqual([config]);
  });
});
