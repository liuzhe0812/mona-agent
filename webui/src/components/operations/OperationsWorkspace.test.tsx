import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DbClientView } from "../db/DbClientView";
import { useDbStore } from "../db/store/dbStore";
import { getQueryDraft, setQueryDraft, clearQueryDraft } from "../db/query-draft";
import { useTerminalStore } from "../terminal/store/terminalStore";
import type { ConnectionConfig } from "../terminal/types/terminal";
import { dbConnection, dbTab } from "@/tests/db-fixtures";
import { ConnectionTree } from "../db/ConnectionTree";
import terminalIcon from "@/assets/icons/sidebar-terminal.png";
import databaseIcon from "@/assets/icons/sidebar-database.png";

const native = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: native }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@/hooks/useLicense", () => ({ useLicense: () => ({ licenseActive: false }) }));
// Native rendering is independently tested by its module. Keep its local state
// here to detect accidental unmounts, without connecting to any host.
vi.mock("../ide/IdeLayout", () => ({ IdeLayout: ({ sessionId, active }: { sessionId: string; active: boolean }) => <div data-testid={`ssh-body-${sessionId}`} data-active={String(active)}><textarea aria-label={`终端草稿 ${sessionId}`} defaultValue="保留终端内容" /></div> }));
vi.mock("../terminal/BatchMode/BatchModeView", () => ({ BatchModeView: () => null }));
vi.mock("../terminal/XtermTerminal", () => ({ XtermTerminal: () => null }));
vi.mock("../terminal/VncViewer", () => ({ VncViewer: () => null }));

const ssh: ConnectionConfig = { id: "ssh-one", name: "测试 SSH", host: "192.0.2.10", port: 22, username: "fixture", protocol: "ssh", auth: { type: "agent" } };
const initialDb = useDbStore.getInitialState();
const initialTerminal = useTerminalStore.getInitialState();
const databaseTree = [{ name: "main", object_type: "database" as const, schema: null, children: [
  { name: "表", object_type: "folder" as const, schema: "main", children: [] },
] }];

beforeEach(async () => {
  vi.clearAllMocks(); localStorage.clear(); clearQueryDraft("query-one");
  window.__TAURI_INTERNALS__ = {};
  useDbStore.setState({ ...initialDb, savedConnections: [dbConnection.config], activeConnections: [dbConnection],
    connectionTree: { [dbConnection.id]: databaseTree }, connectionDatabases: { [dbConnection.id]: ["main"] },
    selectedConnectionId: dbConnection.id, selectedDatabase: null, objectScope: null }, true);
  useTerminalStore.setState({ ...initialTerminal, savedConnections: [ssh] }, true);
  native.mockImplementation(async (command: string) => {
    if (command === "terminal_load_connections") return [ssh];
    if (command === "db_load_connections") return [dbConnection.config];
    if (["db_load_saved_queries", "db_get_table_summaries"].includes(command)) return [];
    if (command === "local_desktop_dir") return "D:\\Fixtures";
    if (command === "sftp_canonicalize") return "/home/fixture";
    if (["local_list_dir", "sftp_list"].includes(command)) return [];
    if (command === "get_file_type_icon") return null;
    if (["ssh_connect_with_id", "ssh_disconnect", "terminal_save_connections"].includes(command)) return undefined;
    throw new Error(`Unexpected native call: ${command}`);
  });
  const ipc = await import("../db/ipc");
  vi.spyOn(ipc, "dbLoadConnections").mockResolvedValue([dbConnection.config]);
  vi.spyOn(ipc, "dbLoadSavedQueries").mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); clearQueryDraft("query-one"); delete window.__TAURI_INTERNALS__; });

async function openSsh() {
  fireEvent.doubleClick(await screen.findByRole("button", { name: "打开 SSH 测试 SSH" }));
  await waitFor(() => expect(useTerminalStore.getState().sessions[0]?.status).toBe("connected"));
  return useTerminalStore.getState().sessions[0].id;
}

async function openBatch() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "新建连接", exact: true }));
  await user.click(screen.getByRole("menuitem", { name: "批量连接" }));
}

function addDraft() {
  const tab = dbTab({ id: "query-one", kind: "query", title: "未保存查询", tableName: undefined, tableInfo: null, sql: "SELECT 1", result: null });
  useDbStore.setState({ queryTabs: [tab], activeTabId: tab.id, currentView: "table" });
  return tab;
}

describe("operations workspace reuses database and SSH views", () => {
  it("uses bundled image icons for SSH connections and SSH/database creation choices", async () => {
    const user = userEvent.setup();
    render(<ConnectionTree onOpenTerminal={() => {}} />);
    const row = screen.getByRole("button", { name: "打开 SSH 测试 SSH" });
    expect(row.querySelector("img")).toHaveAttribute("src", terminalIcon);
    expect(row.querySelector("img")).toHaveAttribute("alt", "");
    await user.click(screen.getByRole("button", { name: "新建连接", exact: true }));
    expect(screen.getByRole("menuitem", { name: "SSH 连接" }).querySelector("img")).toHaveAttribute("src", terminalIcon);
    expect(screen.getByRole("menuitem", { name: "数据库" }).querySelector("img")).toHaveAttribute("src", databaseIcon);
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    expect(native).not.toHaveBeenCalled();
  });

  it("keeps fixed arrow and type-icon slots before, during and after database connection", () => {
    useDbStore.setState({ activeConnections: [], connectionTree: {}, connectingId: null });
    render(<ConnectionTree onOpenTerminal={() => {}} />);
    const row = screen.getByText("Local").closest(".group")!;
    const slot = row.querySelector("[data-tree-expand-slot]");
    const icon = row.querySelector("[data-tree-type-icon]");
    const sshRow = screen.getByRole("button", { name: "打开 SSH 测试 SSH" });
    expect(slot).toHaveClass("h-4", "w-3", "shrink-0");
    expect(icon).toHaveClass("h-5", "w-5", "shrink-0");
    expect(sshRow.querySelector("[data-tree-expand-slot]")).toHaveClass("h-4", "w-3", "shrink-0");
    expect(sshRow.querySelector("[data-tree-type-icon]")).toHaveClass("h-5", "w-5", "shrink-0");
    expect(slot?.querySelector("button")).toBeNull();
    const unchanged = () => {
      expect(row.querySelector("[data-tree-expand-slot]")).toBe(slot);
      expect(row.querySelector("[data-tree-type-icon]")).toBe(icon);
    };
    act(() => useDbStore.setState({ connectingId: dbConnection.id }));
    unchanged();
    act(() => useDbStore.setState({ connectingId: null, activeConnections: [dbConnection], connectionTree: { [dbConnection.id]: databaseTree } }));
    unchanged();
    fireEvent.click(screen.getByRole("button", { name: "展开Local" }));
    unchanged();
    expect(screen.getByText("main")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起Local" }));
    unchanged();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
    act(() => useDbStore.setState({ activeConnections: [], connectionTree: {} }));
    unchanged();
    expect(slot?.querySelector("button")).toBeNull();
    expect(native).not.toHaveBeenCalled();
  });

  it("loads flat mixed connections without starting a local shell or connecting automatically", async () => {
    render(<DbClientView />);
    expect(await screen.findByRole("button", { name: "打开 SSH 测试 SSH" })).toBeInTheDocument();
    await waitFor(() => expect(useDbStore.getState().savedConnections).toEqual([dbConnection.config]));
    await waitFor(() => expect(screen.getAllByText("Local").length).toBeGreaterThan(0));
    expect(screen.getByRole("tablist", { name: "运维工作标签" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "列表" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("table", { name: "主机列表" })).toBeInTheDocument();
    expect(useDbStore.getState().objectScope).toBeNull();
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.queryByText("本地终端")).not.toBeInTheDocument();
    expect(screen.queryByText("SSH 会话")).not.toBeInTheDocument();
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
    expect(native.mock.calls.some(([cmd]) => /shell_spawn|ssh_connect|db_connect/.test(cmd))).toBe(false);
  });

  it("offers SSH, database and batch connections, then opens the existing typed dialogs", async () => {
    const user = userEvent.setup(); render(<DbClientView />);
    await user.click(screen.getByRole("button", { name: "新建连接", exact: true }));
    expect(screen.getAllByRole("menuitem").map((row) => row.textContent)).toEqual(["SSH 连接", "数据库", "批量连接"]);
    await user.click(screen.getByRole("menuitem", { name: "SSH 连接" }));
    const dialog = await screen.findByRole("dialog", { name: "新建 SSH 连接" });
    expect(within(dialog).queryByRole("button", { name: "VNC" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "SFTP" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "新建连接", exact: true }));
    await user.click(screen.getByRole("menuitem", { name: "数据库" }));
    expect(useDbStore.getState().newConnectionDialogOpen).toBe(true);
    expect(useTerminalStore.getState().newConnectionDialogOpen).toBe(false);
    expect(native.mock.calls.some(([cmd]) => /shell_spawn|ssh_connect|db_connect/.test(cmd))).toBe(false);
  });

  it("opens batch mode from the creation menu and reuses it after returning to the list", async () => {
    render(<DbClientView />);
    await openBatch();
    const session = useTerminalStore.getState().sessions[0];
    expect(session).toMatchObject({ type: "batch", title: "批量模式" });
    expect(screen.getByRole("tab", { name: "批量模式" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "批量", exact: true })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "列表" }));
    expect(screen.getByRole("tab", { name: "批量模式" })).toHaveAttribute("aria-selected", "false");
    await openBatch();
    expect(useTerminalStore.getState().sessions).toEqual([session]);
    expect(useTerminalStore.getState().activeSessionId).toBe(session.id);
    expect(screen.getByRole("tab", { name: "批量模式" })).toHaveAttribute("aria-selected", "true");
    expect(native.mock.calls.some(([cmd]) => /shell_spawn|ssh_connect|db_connect/.test(cmd))).toBe(false);
  });

  it("always exposes the disconnect hover affordance and disables it while offline", async () => {
    useDbStore.setState({ activeConnections: [], connectionTree: {}, connectingId: null });
    render(<DbClientView />);
    const sshRow = (await screen.findByRole("button", { name: "打开 SSH 测试 SSH" })).closest("[data-ssh-connection]")!;
    expect(within(sshRow).getByRole("button", { name: "断开 SSH 测试 SSH" })).toBeDisabled();
    const dbRow = screen.getAllByText("Local")[0].closest(".group")!;
    expect(within(dbRow).getByRole("button", { name: "断开连接" })).toBeDisabled();
  });

  it("connects SSH only on double click and uses disconnect as the hover action", async () => {
    render(<DbClientView />);
    const sshButton = await screen.findByRole("button", { name: "打开 SSH 测试 SSH" });
    fireEvent.click(sshButton);
    expect(native.mock.calls.filter(([cmd]) => cmd === "ssh_connect_with_id")).toHaveLength(0);
    fireEvent.doubleClick(sshButton);
    await waitFor(() => expect(useTerminalStore.getState().sessions[0]?.status).toBe("connected"));
    const sshRow = sshButton.closest("[data-ssh-connection]")!;
    expect(within(sshRow).getByRole("button", { name: "断开 SSH 测试 SSH" })).toBeInTheDocument();
    const dbRow = screen.getAllByText("Local")[0].closest(".group")!;
    expect(within(dbRow).getByRole("button", { name: "断开连接" })).toBeInTheDocument();
    expect(within(dbRow).queryByRole("button", { name: "刷新连接树" })).not.toBeInTheDocument();
  });

  it("keeps the SSH row highlighted while its database-style context menu is open", async () => {
    render(<DbClientView />);
    const sshButton = await screen.findByRole("button", { name: "打开 SSH 测试 SSH" });
    const row = sshButton.closest("[data-ssh-connection]")!;
    fireEvent.contextMenu(sshButton);
    expect(row).toHaveClass("bg-accent");
    expect(screen.getByRole("menuitem", { name: "连接" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "编辑" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "删除连接" })).toBeInTheDocument();
  });

  it("opens the SSH view in the shared tab row and repeated clicks reuse the same session", async () => {
    render(<DbClientView />); const id = await openSsh();
    const tab = within(screen.getByRole("tablist")).getByRole("tab", { name: /测试 SSH/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveClass("h-8", "border-b-2", "border-b-info", "border-r", "bg-muted/20");
    expect(tab.querySelector("img")).toHaveAttribute("src", terminalIcon);
    const closeButton = within(tab).getByRole("button", { name: "关闭 测试 SSH" });
    expect(closeButton).toHaveClass("absolute", "right-1", "h-6", "w-6", "opacity-0");
    expect(screen.getByTestId(`ssh-body-${id}`)).toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByRole("button", { name: "打开 SSH 测试 SSH" }));
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
    expect(native.mock.calls.filter(([cmd]) => cmd === "ssh_connect_with_id")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "新建 Shell" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开", exact: true })).not.toBeInTheDocument();
  });

  it("omits the SSH status footer in every connection state but keeps other session footers", async () => {
    render(<DbClientView />);
    const id = await openSsh();
    await screen.findByRole("button", { name: "远程路径" });
    for (const status of ["connected", "disconnected", "connecting", "error"] as const) {
      act(() => useTerminalStore.getState().updateSessionStatus(id, status));
      expect(screen.queryByText("UTF-8", { exact: true })).not.toBeInTheDocument();
    }
    await openBatch();
    expect(screen.getByText("UTF-8", { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /测试 SSH/ }));
    expect(screen.queryByText("UTF-8", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起文件区", exact: true })).toBeInTheDocument();
  });

  it("preserves the shell and file pane when visiting batch mode", async () => {
    render(<DbClientView />);
    const id = await openSsh();
    const path = await screen.findByRole("button", { name: "远程路径" });
    const shell = screen.getByRole("textbox", { name: `终端草稿 ${id}` });
    fireEvent.change(shell, { target: { value: "unsubmitted command" } });
    await openBatch();
    fireEvent.click(screen.getByRole("tab", { name: /测试 SSH/ }));
    expect(screen.getByRole("button", { name: "远程路径" })).toBe(path);
    expect(screen.getByRole("textbox", { name: `终端草稿 ${id}` })).toBe(shell);
    expect(shell).toHaveValue("unsubmitted command");
  });

  it("keeps SQL drafts and terminal state mounted across tab and module visibility changes", async () => {
    addDraft(); const view = render(<DbClientView />);
    const editor = screen.getByLabelText("SQL 编辑器");
    setQueryDraft("query-one", "SELECT 2 -- 未保存");
    const id = await openSsh();
    const terminalDraft = screen.getByRole("textbox", { name: `终端草稿 ${id}` });
    fireEvent.change(terminalDraft, { target: { value: "尚未提交的命令" } });
    fireEvent.click(screen.getByRole("tab", { name: "未保存查询" }));
    expect(screen.getByLabelText("SQL 编辑器")).toBe(editor);
    expect(getQueryDraft("query-one")).toBe("SELECT 2 -- 未保存");
    fireEvent.click(screen.getByRole("tab", { name: /测试 SSH/ }));
    view.rerender(<DbClientView visible={false} />);
    view.rerender(<DbClientView visible />);
    expect(screen.getByRole("textbox", { name: `终端草稿 ${id}` })).toBe(terminalDraft);
    expect(terminalDraft).toHaveValue("尚未提交的命令");
    expect(useTerminalStore.getState().activeSessionId).toBe(id);
    expect(native.mock.calls.some(([cmd]) => /ssh_disconnect|db_execute_query|shell_spawn/.test(cmd))).toBe(false);
  });

  it("keeps inactive SSH close scoped to SSH, and still confirms unsaved SQL on close", async () => {
    addDraft(); render(<DbClientView />); await openSsh();
    fireEvent.click(screen.getByRole("tab", { name: "未保存查询" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭 测试 SSH" }));
    await waitFor(() => expect(useTerminalStore.getState().sessions).toHaveLength(0));
    expect(screen.getByRole("tab", { name: "未保存查询" })).toHaveAttribute("aria-selected", "true");
    expect(useDbStore.getState().queryTabs[0].sql).toBe("SELECT 1");
    fireEvent.click(screen.getByRole("button", { name: "关闭 未保存查询" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("SQL 草稿");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(useDbStore.getState().queryTabs).toHaveLength(1);
    expect(native.mock.calls.filter(([cmd]) => cmd === "ssh_disconnect")).toHaveLength(1);
  });

  it("returns to database content on a database selection and not on a late SSH status event", async () => {
    render(<DbClientView />); const id = await openSsh();
    await waitFor(() => expect(useDbStore.getState().savedConnections).toEqual([dbConnection.config]));
    fireEvent.click(await screen.findByText("main"));
    expect(screen.getByRole("tab", { name: "列表" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("table", { name: "主机列表" })).not.toBeInTheDocument();
    act(() => useTerminalStore.getState().updateSessionStatus(id, "error"));
    expect(screen.getByRole("tab", { name: "列表" })).toHaveAttribute("aria-selected", "true");
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
    fireEvent.click(screen.getAllByText("Local")[0]);
    expect(screen.getByRole("table", { name: "主机列表" })).toBeInTheDocument();
    expect(useDbStore.getState().objectScope).toBeNull();
  });

  it("keeps host-key confirmation when opening SSH from the shared connection list", async () => {
    native.mockImplementation(async (command: string) => {
      if (command === "ssh_connect_with_id") throw new Error("Host key unknown: SHA256:fixture-key");
      if (command === "terminal_load_connections") return [ssh];
      if (command === "db_load_connections") return [dbConnection.config];
      return [];
    });
    render(<DbClientView />);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "打开 SSH 测试 SSH" }));
    await waitFor(() => expect(useTerminalStore.getState().hostKeyDialog.open).toBe(true));
    expect(useTerminalStore.getState().hostKeyDialog.pendingSessionId).toBe(useTerminalStore.getState().activeSessionId);
    expect(useTerminalStore.getState().sessions[0].status).toBe("connecting");
    expect(native.mock.calls.filter(([cmd]) => cmd === "ssh_connect_with_id")).toHaveLength(1);
  });
});
