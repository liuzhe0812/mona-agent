import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as ipc from "./ipc";
import { TableOperationDialog } from "./TableOperationDialog";
import { useDbStore } from "./store/dbStore";
import { dbConnection, dbTab } from "@/tests/db-fixtures";

const context = {
  connectionId: dbConnection.id,
  database: "main",
  table: "users",
  objectType: "table" as const,
};

function renderOperation(operation: "rename" | "truncate" | "drop", onClose = vi.fn(), onDone = vi.fn()) {
  return render(
    <TableOperationDialog
      context={{ ...context, operation }}
      onClose={onClose}
      onDone={onDone}
    />,
  );
}

beforeEach(() => {
  useDbStore.setState({
    activeConnections: [dbConnection],
    queryTabs: [],
    activeTabId: null,
    currentView: "objects",
    selectedTable: null,
    connectError: null,
  });
  vi.spyOn(ipc, "dbExecuteQuery").mockResolvedValue(dbTab().result!);
  vi.spyOn(useDbStore.getState(), "refreshTree").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TableOperationDialog", () => {
  it("cancels without executing SQL", () => {
    const onClose = vi.fn();
    renderOperation("rename", onClose);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ipc.dbExecuteQuery).not.toHaveBeenCalled();
  });

  it("blocks an operation when the target data tab has unsaved edits", async () => {
    useDbStore.setState({
      queryTabs: [dbTab({ edits: [{ rowIdx: 0, colIdx: 1, oldValue: { type: "text", value: "Ada" }, newValue: "Changed" }] })],
    });
    renderOperation("rename");
    fireEvent.change(screen.getByRole("textbox", { name: "新表名" }), { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("未保存修改"));
    expect(ipc.dbExecuteQuery).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the dialog open and shows a write error", async () => {
    vi.mocked(ipc.dbExecuteQuery).mockRejectedValueOnce(new Error("write failed"));
    renderOperation("drop");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("write failed"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("only removes clean target tabs after a successful drop", async () => {
    const targetData = dbTab({ id: "target-data" });
    const targetStructure = dbTab({ id: "target-structure", kind: "structure" });
    const otherTable = dbTab({ id: "other-table", tableName: "orders" });
    const queryDraft = dbTab({ id: "query-draft", kind: "query", tableName: undefined });
    useDbStore.setState({
      queryTabs: [targetData, targetStructure, otherTable, queryDraft],
      activeTabId: "other-table",
      currentView: "objects",
    });
    const onClose = vi.fn();
    const onDone = vi.fn();
    renderOperation("drop", onClose, onDone);

    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(undefined));
    expect(ipc.dbExecuteQuery).toHaveBeenCalledWith("db-test", 'DROP TABLE "main"."users"', undefined, "main");
    expect(useDbStore.getState().queryTabs.map((tab) => tab.id)).toEqual(["other-table", "query-draft"]);
    expect(useDbStore.getState().currentView).toBe("objects");
    expect(useDbStore.getState().activeTabId).toBe("other-table");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
