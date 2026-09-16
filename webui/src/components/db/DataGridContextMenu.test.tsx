import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TableBrowser } from "./TableBrowser";
import { preferredColumnWidth, recordHighlightKey } from "./DataGrid";
import * as ipc from "./ipc";
import { useDbStore } from "./store/dbStore";
import { dbConnection, dbTab } from "@/tests/db-fixtures";

function Browser() {
  const tab = useDbStore((state) => state.queryTabs[0]);
  return <TableBrowser tab={tab} />;
}

beforeEach(() => {
  vi.restoreAllMocks();
  useDbStore.setState({ activeConnections: [dbConnection], queryTabs: [dbTab()], activeTabId: "tab-1" });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn().mockResolvedValue("Pasted") },
  });
});

function openCellMenu() {
  const cell = screen.getByText("Ada");
  fireEvent.pointerDown(cell, { button: 2 });
  fireEvent.contextMenu(cell);
}

async function openSubmenu(name: string) {
  const item = screen.getByRole("menuitem", { name });
  await act(async () => { item.focus(); fireEvent.keyDown(item, { key: "ArrowRight" }); });
}

describe("data grid context menu", () => {
  it("uses content-aware widths while retaining a compact range", () => {
    expect(preferredColumnWidth("name", ["Ada"])).toBe(96);
    expect(preferredColumnWidth("token", ["x".repeat(100)])).toBe(320);
  });

  it("uses the row number gutter for selection and selected-row markers", () => {
    const tab = dbTab();
    const firstRow = tab.result!.rows[0];
    useDbStore.setState({ queryTabs: [{ ...tab, result: { ...tab.result!, rows: Array.from({ length: 4 }, () => structuredClone(firstRow)) } }] });
    render(<Browser />);

    const first = screen.getByLabelText("选择第 1 行");
    expect(first).toHaveTextContent("1");
    fireEvent.pointerDown(first);
    expect(useDbStore.getState().queryTabs[0].selectedRows).toEqual([0]);
    expect(first).toHaveTextContent("•");
    expect(first).toHaveClass("bg-muted");
    expect(first.closest("tr")).not.toHaveClass("bg-info/20");

    fireEvent.pointerDown(screen.getByLabelText("选择第 2 行"), { ctrlKey: true });
    expect(useDbStore.getState().queryTabs[0].selectedRows).toEqual([0, 1]);
    fireEvent.pointerDown(screen.getByLabelText("选择第 4 行"), { shiftKey: true });
    expect(useDbStore.getState().queryTabs[0].selectedRows).toEqual([1, 2, 3]);
  });

  it("selects a row range when shift-clicking regular data cells", () => {
    const tab = dbTab();
    const firstRow = tab.result!.rows[0];
    useDbStore.setState({ queryTabs: [{ ...tab, result: { ...tab.result!, rows: Array.from({ length: 4 }, () => structuredClone(firstRow)) } }] });
    render(<Browser />);

    const cells = screen.getAllByText("Ada");
    fireEvent.pointerDown(cells[0]);
    fireEvent.pointerDown(cells[3], { shiftKey: true });
    expect(useDbStore.getState().queryTabs[0].selectedRows).toEqual([0, 1, 2, 3]);
    for (const selected of cells) expect(selected.closest("td")).toHaveClass("bg-info/25");
    const table = cells[0].closest("table")!;
    for (const unselected of table.querySelectorAll('td[data-col-index="0"]')) expect(unselected).not.toHaveClass("bg-info/25");
  });

  it("preserves a selected range on right click and applies row actions in batch", () => {
    const tab = dbTab();
    const firstRow = tab.result!.rows[0];
    const rows = Array.from({ length: 4 }, (_, index) => {
      const row = structuredClone(firstRow);
      row[0] = { type: "integer", value: index + 1 };
      return row;
    });
    useDbStore.setState({ queryTabs: [{ ...tab, result: { ...tab.result!, rows } }] });
    render(<Browser />);

    const cells = screen.getAllByText("Ada");
    fireEvent.pointerDown(cells[0]);
    fireEvent.pointerDown(cells[3], { shiftKey: true });
    fireEvent.pointerDown(cells[1], { button: 2 });
    fireEvent.contextMenu(cells[1]);

    expect(useDbStore.getState().queryTabs[0].selectedRows).toEqual([0, 1, 2, 3]);
    for (const selected of cells) expect(selected.closest("td")).toHaveClass("bg-info/25");
    expect(screen.getByRole("menuitem", { name: "进入列式对比视图（4 行）" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "克隆数据" }));
    expect(useDbStore.getState().queryTabs[0].insertedRows).toEqual([4, 5, 6, 7]);
  });

  it("colors only the active cell and clears that color while editing", () => {
    render(<Browser />);
    const cell = screen.getByText("Ada").closest("td")!;

    fireEvent.pointerDown(cell);
    expect(cell).toHaveClass("bg-info/25");
    expect(cell.closest("tr")).not.toHaveClass("bg-info/20");
    fireEvent.doubleClick(cell);
    expect(cell).not.toHaveClass("bg-info/25");
    expect(cell).toHaveClass("bg-background");
  });

  it("writes row selection only once when activating a cell", () => {
    const originalPatchTab = useDbStore.getState().patchTab;
    const patchTab = vi.fn(originalPatchTab);
    useDbStore.setState({ patchTab });
    const { unmount } = render(<Browser />);

    fireEvent.pointerDown(screen.getByText("Ada"));
    expect(patchTab).toHaveBeenCalledTimes(1);
    unmount();
    useDbStore.setState({ patchTab: originalPatchTab });
  });

  it("matches the supported HexHub interaction groups without shortcut labels", () => {
    render(<Browser />);
    openCellMenu();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "进入列式视图", "添加", "克隆数据", "撤销", "删除记录", "刷新",
      "填充到筛选条件", "填充", "行高亮", "复制为", "粘贴到",
      "跳转行", "全选", "列锁定", "排序",
    ]);
    expect(screen.queryByText(/Ctrl\+|F5|Backspace/)).not.toBeInTheDocument();
  });

  it("opens a vertical record view and clones data without the auto-increment key", () => {
    render(<Browser />);
    openCellMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "进入列式视图" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("id")).toBeInTheDocument();
    expect(within(dialog).getByText("Ada")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    openCellMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "克隆数据" }));
    const tab = useDbStore.getState().queryTabs[0];
    expect(tab.insertedRows).toEqual([1]);
    expect(tab.result?.rows[1][0]).toEqual({ type: "null" });
    expect(tab.result?.rows[1][1]).toEqual({ type: "text", value: "Ada" });
  });

  it("turns the current value into a real table filter", async () => {
    const execute = vi.spyOn(ipc, "dbExecuteQuery").mockResolvedValue(dbTab().result!);
    render(<Browser />);
    openCellMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "填充到筛选条件" }));
    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(useDbStore.getState().queryTabs[0].browse?.filters).toEqual([
      { column: "name", operator: "eq", value: "Ada" },
    ]);
  });

  it("aligns copy and paste options and applies text to the current cell", async () => {
    render(<Browser />);
    openCellMenu();
    await openSubmenu("复制为");
    const copyMenu = screen.getAllByRole("menu").at(-1)!;
    expect(within(copyMenu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Where 条件", "InsertSQL（批量）", "InsertSQL", "InsertOnUpdateSQL",
      "InsertSQL（选中区域）", "InsertSQL（选中区域＋批量）", "UpdateSQL", "DeleteSQL",
      "表格文本－字段和数据", "表格文本－数据", "表格文本－字段",
    ]);
    fireEvent.click(within(copyMenu).getByRole("menuitem", { name: "表格文本－字段和数据" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("name\nAda"));
    openCellMenu();
    await openSubmenu("粘贴到");
    const pasteMenu = screen.getAllByRole("menu").at(-1)!;
    expect(within(pasteMenu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "粘贴", "仅粘贴文本", "粘贴至选中区", "新建并粘贴",
    ]);
    fireEvent.click(within(pasteMenu).getByRole("menuitem", { name: "仅粘贴文本" }));
    await waitFor(() => expect(useDbStore.getState().queryTabs[0].edits[0].newValue).toBe("Pasted"));
  });

  it("aligns all-selection options and selects the current column", async () => {
    render(<Browser />);
    openCellMenu();
    await openSubmenu("全选");
    const menu = screen.getAllByRole("menu").at(-1)!;
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "全选", "行全选", "列全选", "取消选择",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "列全选" }));
    expect(screen.getByRole("columnheader", { name: /name/ })).toHaveClass("bg-accent");
    expect(useDbStore.getState().queryTabs[0].selectedRows).toEqual([]);
  });

  it("highlights a row", async () => {
    const tab = dbTab();
    tab.result!.rows.push([{ type: "integer", value: 43 }, { type: "text", value: "Grace" }]);
    tab.rowHighlights = { [recordHighlightKey(tab.result!, 0, 0)]: "warning" };
    useDbStore.setState({ activeConnections: [dbConnection], queryTabs: [tab], activeTabId: tab.id });
    const view = render(<Browser />);
    expect(screen.getByText("Ada").closest("tr")).toHaveClass("bg-warning/10");
    fireEvent.pointerDown(screen.getByText("Grace"));
    expect(screen.getByText("Ada").closest("tr")).toHaveClass("bg-warning/10");
    expect(Object.values(useDbStore.getState().queryTabs[0].rowHighlights ?? {})).toEqual(["warning"]);
    view.unmount();
    render(<Browser />);
    expect(screen.getByText("Ada").closest("tr")).toHaveClass("bg-warning/10");
  });

  it("exposes column locking without a shortcut label", () => {
    render(<Browser />);
    openCellMenu();
    expect(screen.getByRole("menuitem", { name: "列锁定" })).toBeInTheDocument();
    expect(screen.queryByText(/Ctrl\+|F5|Backspace/)).not.toBeInTheDocument();
  });
});
