import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TableInfo, TableSummary } from "./types";

const mocks = vi.hoisted(() => ({
  getTableSummaries: vi.fn(),
  getTableInfo: vi.fn(),
}));

vi.mock("./ipc", () => ({
  dbGetTableSummaries: mocks.getTableSummaries,
  dbGetTableInfo: mocks.getTableInfo,
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
    expect(screen.getByTestId("table-list-footer")).toHaveTextContent("共 2 个对象");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "account" } });
    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.queryByText("user_names")).not.toBeInTheDocument();
    expect(screen.getByTestId("table-list-footer")).toHaveTextContent("显示 1 / 2 个对象");
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

  it("sorts by a clicked column and only requests DDL after the context action", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: /按估算行数排序/ }));
    const dataRows = screen.getAllByRole("row").slice(1);
    expect(dataRows[0]).toHaveTextContent("user_names");

    const usersRow = screen.getByRole("row", { name: /users/ });
    fireEvent.contextMenu(usersRow);
    expect(mocks.getTableInfo).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("menuitem", { name: "查看DDL" }));
    expect(mocks.getTableInfo).toHaveBeenCalledWith("connection-1", "app", "users");
    expect(await screen.findByText(tableInfo.ddl!)).toBeInTheDocument();
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
});
