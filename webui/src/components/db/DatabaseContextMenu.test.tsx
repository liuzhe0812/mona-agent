import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseContextMenu } from "./DatabaseContextMenu";
import { useDbStore } from "./store/dbStore";
import * as ipc from "./ipc";
import { dbConnection, dbTab } from "@/tests/db-fixtures";

beforeEach(() => {
  vi.restoreAllMocks();
  useDbStore.setState({ activeConnections: [{ ...dbConnection, config: { ...dbConnection.config, db_type: "mysql" } }], queryTabs: [], selectedConnectionId: "another-connection", selectedDatabase: "another-database", objectScope: null });
});
function openMenu(database = "analytics") {
  render(<DatabaseContextMenu connectionId={dbConnection.id} database={database}><span>database row</span></DatabaseContextMenu>);
  fireEvent.contextMenu(screen.getByText("database row"));
}

describe("database context menu", () => {
  it("groups the supported actions in the reference order", () => {
    openMenu();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "新建数据库", "编辑数据库", "删除数据库", "新建表", "新建查询", "导出", "导出数据库", "导入", "刷新",
    ]);
  });
  it("creates a query bound to the right-clicked database, regardless of active selection", () => {
    const add = vi.spyOn(useDbStore.getState(), "addQueryTab").mockReturnValue("query");
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "新建查询", exact: true }));
    expect(add).toHaveBeenCalledWith(dbConnection.id, "analytics");
  });
  it("asks before deletion and targets the quoted right-clicked database", async () => {
    const execute = vi.spyOn(ipc, "dbExecuteQuery").mockResolvedValue({ rows: [], columns: [], affected_rows: 1, execution_time_ms: 1, message: null });
    vi.spyOn(useDbStore.getState(), "refreshTree").mockResolvedValue();
    openMenu("a`b");
    fireEvent.click(screen.getByRole("menuitem", { name: "删除数据库", exact: true }));
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除数据库", exact: true }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(dbConnection.id, "DROP DATABASE `a``b`"));
  });
  it("blocks deletion when the target has unsaved changes", async () => {
    const execute = vi.spyOn(ipc, "dbExecuteQuery");
    useDbStore.setState({ queryTabs: [dbTab({ database: "analytics", insertedRows: [1] })] });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "删除数据库", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "删除数据库", exact: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent("未保存的修改");
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("does not offer destructive server-schema operations for SQLite", () => {
    useDbStore.setState({ activeConnections: [dbConnection] });
    openMenu("main");
    expect(screen.getByRole("menuitem", { name: "删除数据库", exact: true })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "新建表", exact: true })).not.toHaveAttribute("data-disabled");
  });
});
