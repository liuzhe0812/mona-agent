import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TableFolderContextMenu } from "./TableFolderContextMenu";
import * as ipc from "./ipc";
import { useDbStore } from "./store/dbStore";
import { dbConnection, dbTableInfo } from "@/tests/db-fixtures";

beforeEach(() => {
  vi.restoreAllMocks();
  useDbStore.setState({
    activeConnections: [{ ...dbConnection, config: { ...dbConnection.config, db_type: "mysql" } }],
    queryTabs: [],
    selectedConnectionId: "another-connection",
    selectedDatabase: "another-database",
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

function openMenu() {
  render(<TableFolderContextMenu connectionId={dbConnection.id} database="analytics">
    <span>表</span>
  </TableFolderContextMenu>);
  fireEvent.contextMenu(screen.getByText("表"));
}

describe("table folder context menu", () => {
  it("shows executable table-folder actions without shortcut labels", () => {
    openMenu();
    expect(screen.getByRole("menuitem", { name: "新建表" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "新建查询" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "刷新" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "复制全部表结构 SQL" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "导出" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "导入" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "同步" })).not.toBeInTheDocument();
  });

  it("creates a query for the right-clicked database", () => {
    const add = vi.spyOn(useDbStore.getState(), "addQueryTab").mockReturnValue("query");
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "新建查询" }));
    expect(add).toHaveBeenCalledWith(dbConnection.id, "analytics");
  });

  it("refreshes the right-clicked connection", async () => {
    const refresh = vi.spyOn(useDbStore.getState(), "refreshTree").mockResolvedValue();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "刷新" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith(dbConnection.id));
  });

  it("copies every table DDL only after the explicit menu action", async () => {
    const summaries = vi.spyOn(ipc, "dbGetTableSummaries").mockResolvedValue([
      { name: "users", object_type: "table", comment: null, row_count: null, data_size: null, index_size: null, auto_increment: null, engine: null, charset: null, create_time: null, update_time: null },
      { name: "active_users", object_type: "view", comment: null, row_count: null, data_size: null, index_size: null, auto_increment: null, engine: null, charset: null, create_time: null, update_time: null },
      { name: "orders", object_type: "table", comment: null, row_count: null, data_size: null, index_size: null, auto_increment: null, engine: null, charset: null, create_time: null, update_time: null },
    ]);
    const tableInfo = vi.spyOn(ipc, "dbGetTableInfo").mockImplementation(async (_connection, _database, table) => ({
      ...dbTableInfo,
      name: table,
      ddl: `CREATE TABLE \`${table}\` (id INT);`,
    }));
    openMenu();
    expect(summaries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "复制全部表结构 SQL" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "CREATE TABLE `users` (id INT);\n\nCREATE TABLE `orders` (id INT);",
    ));
    expect(tableInfo.mock.calls.map((call) => call[2])).toEqual(["users", "orders"]);
    expect(await screen.findByRole("status")).toHaveTextContent("已复制 2 张表");
  });

  it("keeps SQLite export to the supported database-file option", async () => {
    useDbStore.setState({ activeConnections: [dbConnection] });
    openMenu();
    const exportItem = screen.getByRole("menuitem", { name: "导出" });
    await act(async () => {
      exportItem.focus();
      fireEvent.keyDown(exportItem, { key: "ArrowRight" });
    });
    expect(await screen.findByRole("menuitem", { name: "SQLite 数据库" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "表结构（SQL）" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "导入" })).not.toBeInTheDocument();
  });
});
