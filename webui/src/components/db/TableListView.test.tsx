import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TableInfo, TableSummary } from "./types";
import { useDbStore } from "./store/dbStore";
import { dbConnection } from "@/tests/db-fixtures";

const mocks = vi.hoisted(() => ({
  getTableSummaries: vi.fn(),
  getTableInfo: vi.fn(),
  executeQuery: vi.fn(),
  copy: vi.fn(),
}));

vi.mock("./ipc", () => ({
  dbGetTableSummaries: mocks.getTableSummaries,
  dbGetTableInfo: mocks.getTableInfo,
  dbExecuteQuery: mocks.executeQuery,
  dbGetDatabases: vi.fn().mockResolvedValue([]),
}));

import { TableListView } from "./TableListView";

function summary(overrides: Partial<TableSummary>): TableSummary {
  return {
    name: "users",
    object_type: "table",
    comment: null,
    row_count: null,
    data_size: null,
    index_size: null,
    auto_increment: null,
    engine: null,
    charset: null,
    create_time: null,
    update_time: null,
    ...overrides,
  };
}

const rows = [
  summary({
    name: "users",
    comment: "accounts",
    row_count: 12,
    data_size: 2048,
    update_time: "2026-09-12 10:00:00",
  }),
  summary({
    name: "user_names",
    object_type: "view",
    row_count: 3,
  }),
];

const tableInfo: TableInfo = {
  name: "users",
  schema: "main",
  engine: "InnoDB",
  charset: "utf8mb4",
  collation: null,
  row_count: 12,
  data_size: "2.0 KB",
  index_size: null,
  auto_increment: null,
  create_time: null,
  update_time: null,
  columns: [],
  indexes: [],
  foreign_keys: [],
  ddl: "CREATE TABLE users (id INTEGER PRIMARY KEY);",
};

describe("TableListView", () => {
  beforeEach(() => {
    mocks.getTableSummaries.mockReset();
    mocks.getTableInfo.mockReset();
    mocks.executeQuery.mockReset();
    mocks.executeQuery.mockResolvedValue({ affected_rows: 0 });
    mocks.copy.mockReset();
    mocks.copy.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.copy } });
    useDbStore.setState({ activeConnections: [ { ...dbConnection, id: "connection-1" } ] });
    mocks.getTableSummaries.mockResolvedValue(rows);
    mocks.getTableInfo.mockResolvedValue(tableInfo);
  });

  it("loads summaries once, renders unknown values, filters by name/comment, and keeps a count", async () => {
    render(
      <TableListView
        connectionId="connection-1"
        database="app"
        onOpenTable={vi.fn()}
        onNewQuery={vi.fn()}
      />,
    );

    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(mocks.getTableSummaries).toHaveBeenCalledWith("connection-1", "app");
    expect(screen.getByText("accounts")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByTestId("table-list-selection")).toHaveTextContent("已选择 0 项，共 2 项");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "account" } });
    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.queryByText("user_names")).not.toBeInTheDocument();
    expect(screen.getByTestId("table-list-selection")).toHaveTextContent("已选择 0 项，共 1 项");
  });

  it("selects rows and opens the selected object from double click or Enter", async () => {
    const onOpenTable = vi.fn();
    render(
      <TableListView
        connectionId="connection-1"
        database="app"
        onOpenTable={onOpenTable}
        onNewQuery={vi.fn()}
      />,
    );

    const row = await screen.findByRole("row", { name: /users/ });
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-selected", "true");

    fireEvent.doubleClick(row);
    expect(onOpenTable).toHaveBeenLastCalledWith("users", true, "table");

    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpenTable).toHaveBeenLastCalledWith("users", true, "table");
  });

  it("owns the only vertical scrolling container in the object view", async () => {
    render(<TableListView connectionId="connection-1" database="app" onOpenTable={vi.fn()} onNewQuery={vi.fn()} />);
    await screen.findByText("users");
    const view = screen.getByTestId("table-list-view");
    expect(view).toHaveClass("overflow-hidden");
    expect(screen.getByRole("toolbar", { name: "对象工具栏" })).toHaveClass("overflow-hidden");
    expect(screen.getByTestId("table-list-body")).toHaveClass("overflow-auto", "overscroll-contain", "scrollbar-thin", "scrollbar-track-transparent");
    expect(view.querySelectorAll(".overflow-auto")).toHaveLength(1);
  });

  it("sorts by a clicked column and copies the actual DDL from the context action", async () => {
    const onOpenTable = vi.fn();
    render(
      <TableListView
        connectionId="connection-1"
        database="app"
        onOpenTable={onOpenTable}
        onNewQuery={vi.fn()}
      />,
    );

    await screen.findByText("users");
    fireEvent.click(screen.getByRole("button", { name: /按估算行排序/ }));
    const dataRows = screen.getAllByRole("row").slice(1);
    expect(dataRows[0]).toHaveTextContent("user_names");

    const usersRow = screen.getByRole("row", { name: /users/ });
    fireEvent.contextMenu(usersRow);
    expect(mocks.getTableInfo).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制表结构 SQL" }));
    expect(mocks.getTableInfo).toHaveBeenCalledWith("connection-1", "app", "users");
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith(tableInfo.ddl));
    expect(onOpenTable).not.toHaveBeenCalled();
  });

  it("keeps a newer connection result when an older request resolves later", async () => {
    let resolveFirst: (value: TableSummary[]) => void = () => undefined;
    mocks.getTableSummaries
      .mockImplementationOnce(() => new Promise<TableSummary[]>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce([summary({ name: "new_table" })]);

    const props = {
      onOpenTable: vi.fn(),
      onNewQuery: vi.fn(),
    };
    const { rerender } = render(
      <TableListView connectionId="connection-1" database="app" {...props} />,
    );
    rerender(<TableListView connectionId="connection-2" database="next" {...props} />);

    expect(await screen.findByText("new_table")).toBeInTheDocument();
    resolveFirst([summary({ name: "stale_table" })]);
    await waitFor(() => expect(screen.queryByText("stale_table")).not.toBeInTheDocument());
    expect(screen.queryByText("users")).not.toBeInTheDocument();
  });

  it("shows all ten HexHub fields with working sort headers", async () => {
    mocks.getTableSummaries.mockResolvedValue([summary({ name: "users", auto_increment: 37, index_size: 4096, engine: "InnoDB", charset: "utf8mb4", create_time: "2026-09-12 12:30:00" })]);
    render(<TableListView connectionId="connection-1" database="main" onOpenTable={vi.fn()} onNewQuery={vi.fn()} />);
    await screen.findByText("users");
    expect(screen.getAllByRole("columnheader").map((element) => element.getAttribute("aria-label"))).toEqual(["名称", "注释", "估算行", "数据长度", "索引长度", "自增", "引擎", "编码", "更新时间", "创建时间"]);
    expect(screen.getByText("37")).toBeInTheDocument();
    expect(screen.getByText("4 KB")).toBeInTheDocument();
    expect(screen.getByText("InnoDB")).toBeInTheDocument();
    expect(screen.getByText("2026-09-12 12:30:00")).toBeInTheDocument();
  });

  it("preserves selection when switching between the list and grid", async () => {
    const onOpen = vi.fn();
    render(<TableListView connectionId="connection-1" database="main" onOpenTable={onOpen} onNewQuery={vi.fn()} />);
    fireEvent.click(await screen.findByRole("row", { name: /users/ }));
    fireEvent.click(screen.getByRole("row", { name: /user_names/ }), { ctrlKey: true });
    expect(screen.getByTestId("table-list-selection")).toHaveTextContent("已选择 2 项");
    fireEvent.click(screen.getByRole("button", { name: "网格视图" }));
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(2);
    fireEvent.doubleClick(screen.getByRole("option", { name: "users" }));
    expect(onOpen).toHaveBeenCalledWith("users", true, "table");
    fireEvent.click(screen.getByRole("button", { name: "列表视图" }));
    expect(screen.getAllByRole("row", { selected: true })).toHaveLength(2);
  });

  it("toggles DDL preview and follows the selected object", async () => {
    render(<TableListView connectionId="connection-1" database="main" onOpenTable={vi.fn()} onNewQuery={vi.fn()} />);
    fireEvent.click(await screen.findByRole("row", { name: /users/ }));
    expect(mocks.getTableInfo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^DDL$/ }));
    expect(await screen.findByText(tableInfo.ddl!)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("row", { name: /user_names/ }));
    await waitFor(() => expect(mocks.getTableInfo).toHaveBeenLastCalledWith("connection-1", "main", "user_names"));
    fireEvent.click(screen.getByRole("button", { name: /^DDL$/ }));
    expect(screen.queryByRole("dialog", { name: "DDL 预览" })).not.toBeInTheDocument();
  });

  it("focuses search with Ctrl+F only while this view is active", async () => {
    const props = { connectionId: "connection-1", database: "main", onOpenTable: vi.fn(), onNewQuery: vi.fn() };
    const { rerender } = render(<TableListView {...props} />);
    await screen.findByText("users");
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.getByRole("searchbox")).toHaveFocus();
    screen.getByRole("searchbox").blur();
    rerender(<TableListView {...props} active={false} />);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.getByRole("searchbox")).not.toHaveFocus();
  });

  it("creates a table in the selected database and reloads the catalog", async () => {
    render(<TableListView connectionId="connection-1" database="main" onOpenTable={vi.fn()} onNewQuery={vi.fn()} />);
    await screen.findByText("users");
    fireEvent.click(screen.getByRole("button", { name: /^新建$/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "表名" }), { target: { value: 'new"table' } });
    fireEvent.click(screen.getByRole("button", { name: /^创建$/ }));
    await waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith("connection-1", 'CREATE TABLE "main"."new""table" (id INTEGER PRIMARY KEY AUTOINCREMENT)', undefined, "main"));
    await waitFor(() => expect(mocks.getTableSummaries).toHaveBeenCalledTimes(2));
  });

  it("replaces the three old entries with the scoped HexHub menu", async () => {
    const open = vi.fn();
    render(<TableListView connectionId="connection-1" database="main" onOpenTable={open} onNewQuery={vi.fn()} />);
    fireEvent.contextMenu(await screen.findByRole("row", { name: /users/ }));
    for (const name of ["打开表", "编辑表结构", "新建表", "新建查询", "重命名", "刷新", "复制表结构 SQL", "删除"]) {
      expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
    }
    for (const name of ["打开数据", "查看DDL", "复制名称", "优化表空间", "数据传输", "同步"]) {
      expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "打开表" }));
    expect(open).toHaveBeenCalledWith("users", true, "table");
  });

  it("opens structure editing on the right-clicked table's database", async () => {
    const openStructure = vi.spyOn(useDbStore.getState(), "openTableStructure").mockResolvedValue();
    render(<TableListView connectionId="connection-1" database="main" onOpenTable={vi.fn()} onNewQuery={vi.fn()} />);
    fireEvent.contextMenu(await screen.findByRole("row", { name: /users/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑表结构" }));
    expect(openStructure).toHaveBeenCalledWith("connection-1", "main", "users");
    openStructure.mockRestore();
  });

  it("binds F2 and F5 and new-query/new-table shortcuts to the active catalog", async () => {
    const onNewQuery = vi.fn(); const onCreateTable = vi.fn();
    render(<TableListView connectionId="connection-1" database="main" onOpenTable={vi.fn()} onNewQuery={onNewQuery} onCreateTable={onCreateTable} />);
    fireEvent.click(await screen.findByRole("row", { name: /users/ }));
    fireEvent.keyDown(window, { key: "Q", ctrlKey: true, shiftKey: true });
    expect(onNewQuery).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
    expect(onCreateTable).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "F5" });
    await waitFor(() => expect(mocks.getTableSummaries).toHaveBeenCalledTimes(2));
    await screen.findByText("users");
    fireEvent.keyDown(window, { key: "F2" });
    expect(await screen.findByRole("dialog")).toHaveTextContent("重命名");
    expect(mocks.executeQuery).not.toHaveBeenCalled();
  });
});
