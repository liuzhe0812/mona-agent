import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionTree } from "./ConnectionTree";
import { useDbStore } from "./store/dbStore";
import type { ConnectionInfo, DatabaseObject, DbConnectionConfig } from "./types";

const config: DbConnectionConfig = {
  id: "connection-1",
  name: "local mysql",
  db_type: "mysql",
  host: "localhost",
  port: 3306,
  username: "root",
  password: "",
  database: null,
  use_ssl: false,
  use_ssh_tunnel: false,
  ssh_host: null,
  ssh_port: null,
  ssh_username: null,
  ssh_auth: null,
};

const info: ConnectionInfo = {
  id: config.id,
  config,
  status: "connected",
  server_version: null,
  error_message: null,
};

const tree: DatabaseObject[] = [
  {
    name: "analytics",
    schema: null,
    object_type: "database",
    children: [
      {
        name: "表",
        schema: "analytics",
        object_type: "folder",
        children: [
          { name: "users", schema: "analytics", object_type: "table", children: [] },
        ],
      },
      { name: "视图", schema: "analytics", object_type: "folder", children: [] },
    ],
  },
];

describe("ConnectionTree", () => {
  beforeEach(() => {
    useDbStore.setState({
      savedConnections: [config],
      activeConnections: [info],
      connectionTree: { [config.id]: tree },
      selectedConnectionId: null,
      selectedDatabase: null,
      selectedTable: null,
      currentView: "objects",
      queryTabs: [],
      activeTabId: null,
      connectError: null,
      openDatabase: vi.fn(),
      selectTable: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("opens database and object scopes from labels while the arrow only expands", async () => {
    render(<ConnectionTree />);

    expect(document.querySelector("[data-symbol='mysql-dolphin']")).toBeInTheDocument();

    const expandDatabase = screen.getByRole("button", { name: "展开analytics" });
    fireEvent.click(expandDatabase);
    expect(useDbStore.getState().openDatabase).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("analytics"));
    expect(useDbStore.getState().openDatabase).toHaveBeenCalledWith("connection-1", "analytics", undefined);

    fireEvent.click(screen.getByText("表"));
    expect(useDbStore.getState().openDatabase).toHaveBeenLastCalledWith("connection-1", "analytics", "table");

    fireEvent.click(screen.getByText("users"));
    expect(useDbStore.getState().selectTable).not.toHaveBeenCalled();
    expect(screen.getByText("users")).toHaveClass("font-medium");
    expect(screen.getByText("users").closest(".group")?.querySelector("[data-tree-leaf-indent]")).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText("users"));
    expect(useDbStore.getState().selectTable).toHaveBeenLastCalledWith("connection-1", "analytics", "users", true, "table");
    expect(useDbStore.getState().selectTable).toHaveBeenCalledTimes(1);
  });

  it("keeps a table context menu scoped to the table row", () => {
    render(<ConnectionTree />);
    fireEvent.click(screen.getByRole("button", { name: "展开analytics" }));
    const databaseRow = screen.getByText("analytics").closest(".group");
    fireEvent.contextMenu(screen.getByText("users"));
    expect(screen.getByRole("menuitem", { name: "打开表" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "新建数据库" })).not.toBeInTheDocument();
    expect(databaseRow).not.toHaveAttribute("data-state", "open");
  });

  it("opens the table-folder menu from the table group row", () => {
    render(<ConnectionTree />);
    fireEvent.click(screen.getByRole("button", { name: "展开analytics" }));
    fireEvent.contextMenu(screen.getByText("表"));
    expect(screen.getByRole("menuitem", { name: "新建表" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "复制全部表结构 SQL" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "编辑数据库" })).not.toBeInTheDocument();
  });

  it("renders a saved query under its database and reopens it", () => {
    useDbStore.setState({
      savedQueries: [{ id: "query-1", name: "每日统计", connection_id: config.id, database: "analytics", sql: "SELECT 1" }],
      connectionTree: { [config.id]: [{
        ...tree[0],
        children: [...tree[0].children, {
          name: "查询", schema: "analytics", object_type: "folder", children: [
            { id: "query-1", name: "每日统计", schema: "analytics", object_type: "query", children: [] },
          ],
        }],
      }] },
    });
    render(<ConnectionTree />);
    fireEvent.click(screen.getByRole("button", { name: "展开analytics" }));
    fireEvent.click(screen.getByText("查询"));
    fireEvent.click(screen.getByText("每日统计"));
    expect(useDbStore.getState().queryTabs[0]).toMatchObject({
      title: "每日统计", sql: "SELECT 1", database: "analytics", savedQueryId: "query-1",
    });
  });

  it("filters connections and nested objects while keeping ancestors visible", async () => {
    render(<ConnectionTree />);

    fireEvent.click(screen.getByRole("button", { name: "搜索连接或表" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索连接或表" }), {
      target: { value: "users" },
    });

    expect(screen.getByText("local mysql")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("users")).toBeInTheDocument());
    expect(screen.getByText("analytics")).toBeInTheDocument();
    expect(screen.getByText("表")).toBeInTheDocument();
    expect(screen.queryByText("视图")).not.toBeInTheDocument();
  });

  it("closes and clears the floating search when it loses focus", async () => {
    render(<ConnectionTree />);

    fireEvent.click(screen.getByRole("button", { name: "搜索连接或表" }));
    const input = screen.getByRole("textbox", { name: "搜索连接或表" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "users" } });
    expect(screen.getByText("users")).toBeInTheDocument();
    fireEvent.blur(input);

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "搜索连接或表" })).not.toBeInTheDocument());
    expect(screen.getByText("视图")).toBeInTheDocument();
  });

  it("opens the current table path once and respects a later manual collapse", async () => {
    useDbStore.setState({
      currentView: "table",
      selectedConnectionId: config.id,
      selectedDatabase: "analytics",
      queryTabs: [
        {
          id: "tab-1",
          kind: "table",
          tableName: "users",
          objectType: "table",
          title: "users",
          sql: "",
          result: null,
          isExecuting: false,
          connectionId: config.id,
          database: "analytics",
          edits: [],
          insertedRows: [],
          tableInfo: null,
          agentChatId: null,
        },
      ],
      activeTabId: "tab-1",
    });

    render(<ConnectionTree />);

    expect(await screen.findByText("users")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起analytics" }));
    expect(screen.queryByText("users")).not.toBeInTheDocument();

    act(() => useDbStore.setState({ connectError: "temporary" }));
    await waitFor(() => expect(screen.getByText("temporary")).toBeInTheDocument());
    expect(screen.queryByText("users")).not.toBeInTheDocument();
  });
});
