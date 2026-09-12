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

    const expandDatabase = screen.getByRole("button", { name: "展开analytics" });
    fireEvent.click(expandDatabase);
    expect(useDbStore.getState().openDatabase).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("analytics"));
    expect(useDbStore.getState().openDatabase).toHaveBeenCalledWith("connection-1", "analytics", undefined);

    fireEvent.click(screen.getByText("表"));
    expect(useDbStore.getState().openDatabase).toHaveBeenLastCalledWith("connection-1", "analytics", "table");

    fireEvent.click(screen.getByText("users"));
    expect(useDbStore.getState().selectTable).toHaveBeenLastCalledWith("connection-1", "analytics", "users", false, "table");
    fireEvent.doubleClick(screen.getByText("users"));
    expect(useDbStore.getState().selectTable).toHaveBeenLastCalledWith("connection-1", "analytics", "users", true, "table");
  });

  it("filters connections and nested objects while keeping ancestors visible", async () => {
    render(<ConnectionTree />);

    fireEvent.change(screen.getByRole("textbox", { name: "搜索连接或表" }), {
      target: { value: "users" },
    });

    expect(screen.getByText("local mysql")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("users")).toBeInTheDocument());
    expect(screen.getByText("analytics")).toBeInTheDocument();
    expect(screen.getByText("表")).toBeInTheDocument();
    expect(screen.queryByText("视图")).not.toBeInTheDocument();
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
