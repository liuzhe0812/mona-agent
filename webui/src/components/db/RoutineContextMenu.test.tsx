import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbConnection } from "@/tests/db-fixtures";
import * as ipc from "./ipc";
import { RoutineContextMenu } from "./RoutineContextMenu";
import { useDbStore } from "./store/dbStore";

beforeEach(() => {
  vi.restoreAllMocks();
  useDbStore.setState({
    activeConnections: [{ ...dbConnection, config: { ...dbConnection.config, db_type: "mysql" } }],
    queryTabs: [],
    activeTabId: null,
    selectedConnectionId: dbConnection.id,
    selectedDatabase: "analytics",
  });
});

function open(routine?: { name: string; type: "procedure" | "function" }) {
  render(<RoutineContextMenu connectionId={dbConnection.id} database="analytics" routine={routine}><span>routine row</span></RoutineContextMenu>);
  fireEvent.contextMenu(screen.getByText("routine row"));
}

describe("routine context menu", () => {
  it("matches the reference action order and disables object-only folder actions", () => {
    open();
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.replace(/^fx/, ""))).toEqual([
      "打开", "新建函数", "新建存储过程", "复制 SQL", "复制", "删除", "刷新",
    ]);
    expect(screen.getByRole("menuitem", { name: "复制 SQL" })).toHaveAttribute("data-disabled");
  });

  it("opens a real routine definition in a database-bound query tab", async () => {
    vi.spyOn(ipc, "dbGetRoutineDefinition").mockResolvedValue("CREATE PROCEDURE `sync_data`() SELECT 1");
    open({ name: "sync_data", type: "procedure" });
    fireEvent.click(screen.getByRole("menuitem", { name: "打开", exact: true }));
    await waitFor(() => expect(useDbStore.getState().queryTabs).toHaveLength(1));
    expect(ipc.dbGetRoutineDefinition).toHaveBeenCalledWith(dbConnection.id, "analytics", "sync_data", "procedure");
    expect(useDbStore.getState().queryTabs[0]).toMatchObject({ title: "sync_data", database: "analytics", sql: "CREATE PROCEDURE `sync_data`() SELECT 1" });
  });

  it("confirms and drops the exact quoted routine before refreshing", async () => {
    const execute = vi.spyOn(ipc, "dbExecuteQuery").mockResolvedValue({ rows: [], columns: [], affected_rows: 0, execution_time_ms: 1, message: null });
    vi.spyOn(useDbStore.getState(), "refreshTree").mockResolvedValue();
    open({ name: "sync`data", type: "function" });
    fireEvent.click(screen.getByRole("menuitem", { name: "删除", exact: true }));
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除", exact: true }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(dbConnection.id, "DROP FUNCTION `analytics`.`sync``data`", undefined, "analytics"));
  });
});
