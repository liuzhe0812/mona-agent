import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResultPanel } from "@/components/db/ResultPanel";
import { TableBrowser } from "@/components/db/TableBrowser";
import { useDbStore } from "@/components/db/store/dbStore";
import * as ipc from "@/components/db/ipc";
import { NULL_MARKER } from "@/components/db/types";
import { dbConnection, dbTab } from "./db-fixtures";

function Browser() {
  const tab = useDbStore((s) => s.queryTabs[0]);
  return <TableBrowser tab={tab} />;
}
beforeEach(() => {
  vi.restoreAllMocks();
  useDbStore.setState({ activeConnections: [dbConnection], queryTabs: [dbTab()], activeTabId: "tab-1" });
});
describe("database browser interactions", () => {
  it("uses one icon-only toolbar and exposes filter and sort on every data header", () => {
    render(<Browser />);
    const toolbar = screen.getByRole("toolbar", { name: "数据表操作" });
    expect(within(toolbar).getByRole("button", { name: "保存修改" })).toHaveTextContent("");
    expect(screen.getAllByRole("toolbar")).toHaveLength(1);
    for (const name of ["id", "name"]) {
      const header = screen.getByRole("columnheader", { name: new RegExp(name) });
      expect(within(header).getByRole("button", { name: `筛选 ${name}` })).toBeInTheDocument();
      expect(within(header).getByRole("button", { name: `排序 ${name}` })).toBeInTheDocument();
    }
    expect(screen.getAllByLabelText("数据库状态栏")).toHaveLength(1);
    expect(screen.queryByLabelText("SQL 编辑器")).not.toBeInTheDocument();
  });
  it("edits a cell locally and enables save without sending SQL", async () => {
    const query = vi.spyOn(ipc, "dbExecuteQuery").mockRejectedValue(new Error("Unexpected query"));
    render(<Browser />);
    fireEvent.doubleClick(screen.getByText("Ada"));
    const input = screen.getByRole("textbox", { name: "编辑 name" });
    fireEvent.change(input, { target: { value: "Grace" } });
    fireEvent.blur(input);
    expect(useDbStore.getState().queryTabs[0].edits[0].newValue).toBe("Grace");
    expect(screen.getByRole("button", { name: "保存修改" })).toBeEnabled();
    expect(query).not.toHaveBeenCalled();
  });
  it("canceling an inline edit leaves the original value unchanged", () => {
    render(<Browser />);
    fireEvent.doubleClick(screen.getByText("Ada"));
    const input = screen.getByRole("textbox", { name: "编辑 name" });
    fireEvent.change(input, { target: { value: "Discard" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useDbStore.getState().queryTabs[0].edits).toHaveLength(0);
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });
  it("distinguishes editing NULL to an empty string", () => {
    const tab = dbTab();
    tab.result!.rows[0][1] = { type: "null" };
    useDbStore.setState({ queryTabs: [tab] });
    render(<Browser />);
    fireEvent.doubleClick(screen.getByText("NULL"));
    fireEvent.change(screen.getByRole("textbox", { name: "编辑 name" }), { target: { value: "x" } });
    fireEvent.change(screen.getByRole("textbox", { name: "编辑 name" }), { target: { value: "" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "编辑 name" }));
    expect(useDbStore.getState().queryTabs[0].edits[0].newValue).toBe("");
    expect(useDbStore.getState().queryTabs[0].edits[0].newValue).not.toBe(NULL_MARKER);
  });
  it("requires confirmation before discarding edits to change pages", async () => {
    const query = vi.spyOn(ipc, "dbExecuteQuery").mockResolvedValue(dbTab().result!);
    useDbStore.setState({ queryTabs: [dbTab({ hasMore: true, edits: [{ rowIdx: 0, colIdx: 1, oldValue: { type: "text", value: "Ada" }, newValue: "Changed" }] })] });
    render(<Browser />);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("放弃未保存的修改");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(useDbStore.getState().queryTabs[0].browse?.page).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
  it("opens the column filter and submits a value to the table query", async () => {
    const user = userEvent.setup();
    const query = vi.spyOn(ipc, "dbExecuteQuery").mockResolvedValue(dbTab().result!);
    render(<Browser />);
    await user.click(screen.getByRole("button", { name: "筛选 name" }));
    await user.type(screen.getByRole("textbox", { name: "筛选值" }), "Ada");
    await user.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() => expect(query).toHaveBeenCalled());
    expect(useDbStore.getState().queryTabs[0].browse?.filters).toEqual([{ column: "name", operator: "eq", value: "Ada" }]);
  });
  it("opens a complete long value without truncating the editable draft", () => {
    const tab = dbTab(); const long = "A long field ".repeat(25);
    tab.result!.rows[0][1] = { type: "text", value: long };
    useDbStore.setState({ queryTabs: [tab] });
    render(<Browser />);
    fireEvent.doubleClick(screen.getByTitle(long.trim()));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "完整内容" })).toHaveValue(long);
    fireEvent.change(screen.getByRole("textbox", { name: "完整内容" }), { target: { value: "Shorter" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(useDbStore.getState().queryTabs[0].edits[0].newValue).toBe("Shorter");
  });
});
describe("query results", () => {
  it("opens full execution errors while identifying preserved previous results", () => {
    const tab = dbTab({ kind: "query", error: "SQL syntax error at line 1", tableInfo: null });
    render(<ResultPanel tab={tab} />);
    expect(screen.getByRole("alert")).toHaveTextContent("SQL syntax error at line 1");
    expect(screen.getByText("上次成功结果")).toBeInTheDocument();
  });
  it("keeps arbitrary query results read-only", () => {
    const tab = dbTab({ kind: "query", tableInfo: null });
    render(<ResultPanel tab={tab} />);
    fireEvent.doubleClick(screen.getByText("Ada"));
    expect(screen.getByRole("textbox", { name: "完整内容" })).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "应用" })).toBeDisabled();
  });
});
