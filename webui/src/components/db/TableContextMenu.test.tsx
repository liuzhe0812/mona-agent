import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const files = vi.hoisted(() => ({ save: vi.fn(), writeTextFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: files.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: files.writeTextFile }));
import { TableContextMenu } from "./TableContextMenu";
import * as ipc from "./ipc";
import { useDbStore } from "./store/dbStore";
import { dbConnection, dbTableInfo } from "@/tests/db-fixtures";

beforeEach(() => {
  vi.restoreAllMocks(); files.save.mockReset(); files.writeTextFile.mockReset();
  useDbStore.setState({
    activeConnections: [{ ...dbConnection, config: { ...dbConnection.config, db_type: "mysql", name: "VPS" } }],
    queryTabs: [], selectedConnectionId: "other", selectedDatabase: "other",
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

function openMenu(props: Partial<React.ComponentProps<typeof TableContextMenu>> = {}) {
  const onOpen = vi.fn();
  const onRefresh = vi.fn();
  render(<TableContextMenu connectionId={dbConnection.id} database="analytics" table="users"
    objectType="table" onOpen={onOpen} onRefresh={onRefresh} {...props}>
    <span>users row</span>
  </TableContextMenu>);
  fireEvent.contextMenu(screen.getByText("users row"));
  return { onOpen, onRefresh };
}

describe("aligned table context menu", () => {
  it("uses the reference order while exposing only implemented operations", () => {
    openMenu();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "打开表", "编辑表结构", "新建表", "新建查询",
      "重命名", "刷新", "优化表空间", "DDL复制表结构 SQL", "删除", "导出", "导入",
    ]);
    expect(screen.queryByRole("menuitem", { name: "同步" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "数据传输" })).not.toBeInTheDocument();
  });

  it("opens the table and creates queries against the right-clicked database", () => {
    const add = vi.spyOn(useDbStore.getState(), "addQueryTab").mockReturnValue("query");
    const { onOpen } = openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "打开表" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(screen.getByText("users row"));
    fireEvent.click(screen.getByRole("menuitem", { name: "新建查询" }));
    expect(add).toHaveBeenCalledWith(dbConnection.id, "analytics");
  });

  it("copies the actual DDL after explicit selection", async () => {
    vi.spyOn(ipc, "dbGetTableInfo").mockResolvedValue({ ...dbTableInfo, ddl: "CREATE TABLE users (id INT)" });
    openMenu();
    expect(ipc.dbGetTableInfo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "复制表结构 SQL" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("CREATE TABLE users (id INT)"));
    expect(await screen.findByRole("status")).toHaveTextContent("已复制表结构 SQL");
  });

  it("confirms and targets table optimization with escaped identifiers", async () => {
    const execute = vi.spyOn(ipc, "dbExecuteQuery").mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, message: null });
    vi.spyOn(useDbStore.getState(), "refreshTree").mockResolvedValue();
    openMenu({ database: "a`b", table: "c`d" });
    fireEvent.click(screen.getByRole("menuitem", { name: "优化表空间" }));
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "优化", exact: true }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(
      dbConnection.id, "OPTIMIZE TABLE `a``b`.`c``d`", undefined, "a`b",
    ));
    expect(await screen.findByRole("status")).toHaveTextContent("表空间优化完成");
  });

  it("exports only the selected table definition", async () => {
    vi.spyOn(ipc, "dbGetTableInfo").mockResolvedValue({ ...dbTableInfo, ddl: "CREATE TABLE users (id INT);" });
    files.save.mockResolvedValue("C:/exports/users.sql");
    files.writeTextFile.mockResolvedValue(undefined);
    openMenu();
    const exportItem = screen.getByRole("menuitem", { name: "导出" });
    await act(async () => { exportItem.focus(); fireEvent.keyDown(exportItem, { key: "ArrowRight" }); });
    fireEvent.click(await screen.findByRole("menuitem", { name: "表结构 SQL" }));
    await waitFor(() => expect(files.writeTextFile).toHaveBeenCalledWith(
      "C:/exports/users.sql", "CREATE TABLE users (id INT);\n",
    ));
  });
});
