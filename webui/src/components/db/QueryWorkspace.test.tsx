import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryWorkspace } from "./QueryWorkspace";
import { QueryDatabaseSelect } from "./QueryDatabaseSelect";
import { useDbStore } from "./store/dbStore";
import { dbConnection, dbTab } from "@/tests/db-fixtures";
import * as ipc from "./ipc";

describe("QueryDatabaseSelect", () => {
  it("filters databases and marks the current selection", async () => {
    const user = userEvent.setup();
    let selected = "";
    render(<QueryDatabaseSelect databases={["app", "analytics", "archive"]} value="app" onSelect={(value) => { selected = value; }} />);
    const combobox = screen.getByRole("combobox", { name: "查询数据库" });
    await user.click(screen.getByRole("button", { name: "展开数据库列表" }));
    expect(screen.getByRole("listbox", { name: "数据库列表" })).toBeInTheDocument();
    expect(screen.getByLabelText("当前数据库")).toBeInTheDocument();
    await user.click(combobox);
    await user.clear(combobox);
    await user.type(combobox, "arch");
    expect(screen.queryByRole("option", { name: /analytics/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /archive/ }));
    expect(selected).toBe("archive");
  });
});

describe("QueryWorkspace", () => {
  it("uses a stable empty database snapshot before the connection catalog arrives", () => {
    const tab = dbTab({ kind: "query", tableName: undefined, tableInfo: null, sql: "", database: "app" });
    useDbStore.setState({ activeConnections: [dbConnection], connectionDatabases: {}, queryTabs: [tab], activeTabId: tab.id });

    expect(() => render(<QueryWorkspace tab={tab} />)).not.toThrow();
    expect(screen.getByRole("combobox", { name: "查询数据库" })).toHaveValue("app");
  });

  it("defaults to the tab database and switches to a filtered database", async () => {
    const user = userEvent.setup();
    const tab = dbTab({ kind: "query", tableName: undefined, tableInfo: null, sql: "", database: "app" });
    useDbStore.setState({ activeConnections: [dbConnection], connectionDatabases: { [dbConnection.id]: ["app", "audit"] }, queryTabs: [tab], activeTabId: tab.id });
    render(<QueryWorkspace tab={tab} />);

    expect(screen.getByRole("toolbar", { name: "查询操作" })).toHaveClass("h-10", "overflow-visible");
    expect(screen.getByLabelText("SQL 编辑器").closest(".text-body")).toBeInTheDocument();
    expect(screen.getByLabelText("调整查询编辑器和结果区高度")).toHaveAttribute("data-slot", "resizable-handle");

    const combobox = screen.getByRole("combobox", { name: "查询数据库" });
    expect(combobox).toHaveValue("app");
    await user.click(combobox);
    await user.clear(combobox);
    await user.type(combobox, "audit");
    await user.click(screen.getByRole("option", { name: /audit/ }));
    expect(useDbStore.getState().queryTabs[0].database).toBe("audit");
  });

  it("names and saves a query under its database", async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(ipc, "dbSaveQuery").mockResolvedValue();
    const tab = dbTab({ kind: "query", title: "新查询", tableName: undefined, tableInfo: null, sql: "SELECT 1", database: "app" });
    useDbStore.setState({
      activeConnections: [dbConnection],
      connectionDatabases: { [dbConnection.id]: ["app"] },
      savedQueries: [],
      connectionTree: { [dbConnection.id]: [{ name: "app", schema: null, object_type: "database", children: [{ name: "查询", schema: "app", object_type: "folder", children: [] }] }] },
      queryTabs: [tab],
      activeTabId: tab.id,
    });
    render(<QueryWorkspace tab={tab} />);
    await user.click(screen.getByRole("button", { name: "保存查询（Ctrl+S）" }));
    await user.type(screen.getByRole("textbox", { name: "查询名称" }), "每日统计");
    await user.click(screen.getByRole("button", { name: "保存", exact: true }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(useDbStore.getState().savedQueries[0]).toMatchObject({ name: "每日统计", database: "app", sql: "SELECT 1" });
    expect(useDbStore.getState().connectionTree[dbConnection.id][0].children[0].children[0]).toMatchObject({ name: "每日统计", object_type: "query" });
  });

  it("does not open the save dialog from Ctrl+S when the query is empty", () => {
    const tab = dbTab({ kind: "query", title: "新查询", tableName: undefined, tableInfo: null, sql: "", database: "app" });
    useDbStore.setState({ activeConnections: [dbConnection], connectionDatabases: { [dbConnection.id]: ["app"] }, queryTabs: [tab], activeTabId: tab.id });
    render(<QueryWorkspace tab={tab} />);
    fireEvent.keyDown(screen.getByLabelText("SQL 编辑器"), { key: "s", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "保存查询" })).not.toBeInTheDocument();
  });
});
