import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dbConnection, dbTab, dbTableInfo } from "@/tests/db-fixtures";

import { useDbStore } from "./store/dbStore";
import { TableStructureEditor } from "./TableStructureEditor";
import type {
  ColumnDefinition,
  ForeignKeyDefinition,
  IndexDefinition,
  QueryTab,
  StructureColumn,
  StructureDraft,
  StructureForeignKey,
  StructureIndex,
  StructureTrigger,
  TriggerDefinition,
} from "./types";

const actions = {
  updateStructureColumn: vi.fn(),
  insertStructureItem: vi.fn(),
  updateStructureItem: vi.fn(),
  removeStructureItem: vi.fn(),
  moveStructureItem: vi.fn(),
  resetStructureEdits: vi.fn(),
  refreshStructure: vi.fn(),
  previewStructure: vi.fn(),
  applyStructure: vi.fn(),
  patchTab: vi.fn(),
};

const originalIndexes: IndexDefinition[] = [
  { name: "PRIMARY", columns: ["id"], is_unique: true, is_primary: true, index_type: "BTREE", editable: false },
  { name: "idx_name", columns: ["name"], is_unique: false, is_primary: false, index_type: "BTREE", editable: true },
  { name: "idx_id", columns: ["id"], is_unique: true, is_primary: false, index_type: "BTREE", editable: true },
];
const originalForeignKeys: ForeignKeyDefinition[] = [{ name: "fk_owner", columns: ["owner_id"], ref_table: "owners", ref_columns: ["id"], on_delete: "CASCADE", on_update: "RESTRICT", editable: true }];
const originalTriggers: TriggerDefinition[] = [{ name: "users_audit", timing: "AFTER", event: "INSERT", statement: "INSERT INTO audit_log VALUES (NEW.id)", editable: true }];

function structureColumns(originalColumns: ColumnDefinition[], draftColumns = originalColumns): StructureColumn[] {
  return draftColumns.map((column, index): StructureColumn => ({
    original_name: originalColumns[index]?.name ?? null,
    name: column.name,
    data_type: column.data_type,
    charset: column.charset ?? null,
    collation: column.collation ?? null,
    nullable: column.nullable,
    is_primary_key: column.is_primary_key,
    is_auto_increment: column.is_auto_increment,
    default_mode: "keep",
    default_value: column.default_value,
    comment: column.comment ?? "",
  }));
}

function draftFor(originalColumns: ColumnDefinition[] = dbTableInfo.columns, draftColumns = originalColumns, section: StructureDraft["section"] = "columns"): StructureDraft {
  const indexes = originalIndexes.filter((index) => !index.is_primary).map((index): StructureIndex => ({ original_name: index.name, name: index.name, columns: index.columns, is_unique: index.is_unique, index_type: "BTREE", editable: index.editable !== false }));
  const foreignKeys = originalForeignKeys.map((key): StructureForeignKey => ({ original_name: key.name, name: key.name, columns: key.columns, ref_table: key.ref_table, ref_columns: key.ref_columns, on_delete: "CASCADE", on_update: "RESTRICT", editable: key.editable !== false }));
  const triggers = originalTriggers.map((trigger): StructureTrigger => ({ original_name: trigger.name, name: trigger.name, timing: "AFTER", event: "INSERT", statement: trigger.statement, editable: trigger.editable }));
  return {
    originalColumns,
    columns: structureColumns(originalColumns, draftColumns),
    originalIndexes,
    indexes,
    originalForeignKeys,
    foreignKeys,
    originalTriggers,
    triggers,
    originalAdvanced: { engine: "InnoDB", charset: "utf8mb4", collation: "utf8mb4_bin", comment: null, row_format: "Dynamic", auto_increment: 4 },
    advanced: [],
    section,
  };
}

function structureTab(overrides: Partial<QueryTab> = {}, originalColumns = dbTableInfo.columns, draftColumns = originalColumns, section: StructureDraft["section"] = "columns"): QueryTab {
  return dbTab({ kind: "structure", structure: draftFor(originalColumns, draftColumns, section), ...overrides });
}

function installMockStore(connection = dbConnection) {
  useDbStore.setState({
    activeConnections: [connection],
    updateStructureColumn: actions.updateStructureColumn,
    insertStructureItem: actions.insertStructureItem,
    updateStructureItem: actions.updateStructureItem,
    removeStructureItem: actions.removeStructureItem,
    moveStructureItem: actions.moveStructureItem,
    resetStructureEdits: actions.resetStructureEdits,
    refreshStructure: actions.refreshStructure,
    previewStructure: actions.previewStructure,
    applyStructure: actions.applyStructure,
    patchTab: actions.patchTab,
  });
}

const mysqlConnection = { ...dbConnection, config: { ...dbConnection.config, db_type: "mysql" as const } };

describe("TableStructureEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actions.refreshStructure.mockResolvedValue(undefined);
    actions.previewStructure.mockResolvedValue(["ALTER TABLE users ALTER COLUMN name TYPE VARCHAR(191);"]);
    actions.applyStructure.mockResolvedValue(undefined);
    installMockStore();
  });

  it("renders the five structure sections in one segmented toolbar", () => {
    const tab = structureTab();
    render(<TableStructureEditor tab={tab} />);

    expect(screen.getAllByRole("tab").map((button) => button.textContent)).toEqual(["字段", "索引", "外键", "触发器", "高级"]);
    expect(screen.getByRole("toolbar", { name: "表结构操作" })).toHaveClass("h-8", "relative");
    expect(screen.getByRole("tablist", { name: "表结构分段" })).toHaveClass("pointer-events-auto", "p-px");
    expect(screen.getByTestId("structure-tab-columns")).toHaveClass("h-6", "text-caption");
    expect(screen.getAllByRole("toolbar")).toHaveLength(1);
    expect(screen.getByRole("columnheader", { name: "排序" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "排序" })).toHaveClass("h-8");
    expect(screen.getByRole("columnheader", { name: "字段" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "长度" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "小数位" })).toBeInTheDocument();
  });

  it("selects the first field and aligns the editable field detail panel", () => {
    const columns = dbTableInfo.columns.map((column, index) => index === 0 ? { ...column, data_type: "VARCHAR(191)", comment: "标识", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" } : column);
    const tab = structureTab({}, dbTableInfo.columns, columns);
    installMockStore(mysqlConnection);
    render(<TableStructureEditor tab={tab} />);

    const firstRow = screen.getByTestId("structure-row-columns-0");
    expect(firstRow).toHaveAttribute("aria-selected", "true");
    expect(firstRow).toHaveClass("h-8");
    expect(screen.getByRole("heading", { name: "字段" })).toBeInTheDocument();
    expect(screen.getByLabelText("详情字段名")).toHaveValue("id");
    expect(screen.getByLabelText("字段字符集")).toHaveTextContent("utf8mb4");
    expect(screen.getByLabelText("字段排序规则")).toHaveTextContent("utf8mb4_unicode_ci");
    expect(screen.getByLabelText("默认值自定义")).toBeChecked();
    expect(screen.getByLabelText("自动生成")).toBeInTheDocument();
    expect(within(firstRow).queryByRole("textbox", { name: "字段名，第 1 行" })).not.toBeInTheDocument();
    fireEvent.doubleClick(within(firstRow).getByText("id"));
    const nameEditor = within(firstRow).getByRole("textbox", { name: "字段名，第 1 行" });
    expect(nameEditor).toHaveClass("h-6");
    fireEvent.change(nameEditor, { target: { value: "account_id" } });
    expect(actions.updateStructureColumn).toHaveBeenCalledWith(tab.id, 0, { name: "account_id" });
    fireEvent.keyDown(nameEditor, { key: "Enter" });

    const typeText = within(firstRow).getByText("VARCHAR");
    fireEvent.doubleClick(typeText);
    fireEvent.change(within(firstRow).getByRole("textbox", { name: "类型，第 1 行" }), { target: { value: "VARCHAR(255)" } });
    expect(actions.updateStructureColumn).toHaveBeenCalledWith(tab.id, 0, { data_type: "VARCHAR(255)" });

    const commentRow = screen.getByTestId("structure-row-columns-1");
    const commentCell = within(commentRow).getAllByText("—").at(-1)!;
    fireEvent.doubleClick(commentCell);
    const commentEditor = within(commentRow).getByRole("textbox", { name: "注释，第 2 行" });
    expect(fireEvent.keyDown(commentEditor, { key: " ", cancelable: true })).toBe(true);
    fireEvent.change(commentEditor, { target: { value: "用户名称" } });
    expect(actions.updateStructureColumn).toHaveBeenCalledWith(tab.id, 1, { comment: "用户名称" });
  });

  it("uses compact adaptive widths and lets columns be resized", () => {
    const tab = structureTab();
    render(<TableStructureEditor tab={tab} />);

    const table = screen.getByTestId("structure-section-columns");
    expect(table).toHaveClass("min-w-[52rem]", "w-full");
    expect(screen.getByTestId("structure-scroll-area")).toBeInTheDocument();
    expect(screen.getByTestId("structure-detail-scroll-area")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId("structure-resize-字段"), { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 140 });
    fireEvent.mouseUp(document);
    expect(table.querySelectorAll("col")[1]).toHaveStyle({ width: "184px" });
  });

  it("uses the same subtle grid lines in every structure table tab", () => {
    const tab = structureTab({}, dbTableInfo.columns, dbTableInfo.columns, "indexes");
    const { rerender } = render(<TableStructureEditor tab={tab} />);

    expect(screen.getByTestId("structure-section-indexes")).toHaveClass("[&_td]:border-r", "[&_td]:border-border/35");
    rerender(<TableStructureEditor tab={structureTab({}, dbTableInfo.columns, dbTableInfo.columns, "foreign_keys")} />);
    expect(screen.getByTestId("structure-section-foreign_keys")).toHaveClass("[&_td]:border-r", "[&_td]:border-border/35");
    rerender(<TableStructureEditor tab={structureTab({}, dbTableInfo.columns, dbTableInfo.columns, "triggers")} />);
    expect(screen.getByTestId("structure-section-triggers")).toHaveClass("[&_td]:border-r", "[&_td]:border-border/35");
  });

  it("moves a field with HTML drag and drop and disables ordering for SQLite", () => {
    const tab = structureTab();
    installMockStore(mysqlConnection);
    const { rerender } = render(<TableStructureEditor tab={tab} />);
    const handle = screen.getAllByLabelText("拖动排序")[0];
    const row = screen.getByTestId("structure-row-columns-1");
    const dataTransfer = { setData: vi.fn(), effectAllowed: "" as string, dropEffect: "" as string };
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.dragOver(row, { dataTransfer });
    fireEvent.drop(row, { dataTransfer });
    expect(actions.moveStructureItem).toHaveBeenCalledWith(tab.id, "columns", 0, 1);

    const sqliteTab = structureTab();
    installMockStore();
    rerender(<TableStructureEditor tab={sqliteTab} />);
    expect(screen.getAllByLabelText("拖动排序")[0]).toHaveAttribute("draggable", "false");
  });

  it("uses the current section for toolbar insertion and deletion", () => {
    const tab = structureTab();
    const { rerender } = render(<TableStructureEditor tab={tab} />);
    fireEvent.click(screen.getByRole("button", { name: "新增字段" }));
    expect(actions.insertStructureItem).toHaveBeenCalledWith(tab.id, "columns");

    installMockStore(mysqlConnection);
    for (const section of ["indexes", "foreign_keys", "triggers"] as const) {
      vi.clearAllMocks();
      const nextTab = structureTab({}, dbTableInfo.columns, dbTableInfo.columns, section);
      rerender(<TableStructureEditor tab={nextTab} />);
      fireEvent.click(screen.getByRole("button", { name: `新增${section === "foreign_keys" ? "外键" : section === "indexes" ? "索引" : "触发器"}` }));
      expect(actions.insertStructureItem).toHaveBeenCalledWith(nextTab.id, section);
    }

    const advancedTab = structureTab({}, dbTableInfo.columns, dbTableInfo.columns, "advanced");
    rerender(<TableStructureEditor tab={advancedTab} />);
    expect(screen.getByRole("button", { name: "新增高级" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除选中高级" })).toBeDisabled();

    const indexTab = structureTab({}, dbTableInfo.columns, dbTableInfo.columns, "indexes");
    rerender(<TableStructureEditor tab={indexTab} />);
    fireEvent.click(screen.getByTestId("structure-row-indexes-0"));
    fireEvent.click(screen.getByRole("button", { name: "删除选中索引" }));
    expect(actions.removeStructureItem).toHaveBeenCalledWith(indexTab.id, "indexes", 0);
  });

  it("renders advanced settings as SQL overview plus a complete edit form", () => {
    const draft = draftFor(dbTableInfo.columns, dbTableInfo.columns, "advanced");
    draft.advanced = [{ key: "comment", value: "用户表" }];
    const tab = structureTab({ structure: draft });
    installMockStore(mysqlConnection);
    render(<TableStructureEditor tab={tab} />);

    expect(screen.getByText("SQL总览")).toBeInTheDocument();
    expect(screen.getByText("编辑项")).toBeInTheDocument();
    expect(screen.getByLabelText("表名")).toHaveValue("users");
    expect(screen.getByLabelText("表名")).toBeDisabled();
    expect(screen.getByLabelText("表字符集")).toHaveTextContent("utf8mb4");
    expect(screen.getByLabelText("表排序规则")).toHaveTextContent("utf8mb4_bin");
    expect(screen.getByLabelText("表引擎")).toHaveTextContent("InnoDB");
    expect(screen.getByLabelText("表行格式")).toHaveTextContent("Dynamic");
    expect(screen.getByLabelText("自动递增")).toHaveValue(4);
    expect(screen.getByTestId("advanced-sql-overview")).toHaveTextContent("ALTER TABLE");
    expect(screen.getByTestId("advanced-sql-overview")).toHaveTextContent("COMMENT='用户表'");

    fireEvent.change(screen.getByLabelText("表注释"), { target: { value: "新注释" } });
    expect(actions.updateStructureItem).toHaveBeenCalledWith(tab.id, "advanced", 0, { value: "新注释" });
  });

  it("supports row copy, clone, paste, paste-and-insert, and delete from the shared context menu", async () => {
    const tab = structureTab({}, dbTableInfo.columns, dbTableInfo.columns, "indexes");
    render(<TableStructureEditor tab={tab} />);
    const firstRow = screen.getByTestId("structure-row-indexes-0");
    const secondRow = screen.getByTestId("structure-row-indexes-1");

    fireEvent.contextMenu(firstRow);
    fireEvent.click(await screen.findByRole("menuitem", { name: /复制.*Ctrl\+C/ }));
    fireEvent.contextMenu(secondRow);
    fireEvent.click(await screen.findByRole("menuitem", { name: /粘贴.*Ctrl\+V/ }));
    expect(actions.updateStructureItem).toHaveBeenCalledWith(tab.id, "indexes", 1, expect.objectContaining({ original_name: "idx_id", name: "idx_name" }));

    fireEvent.contextMenu(secondRow);
    fireEvent.click(await screen.findByRole("menuitem", { name: "克隆 Ctrl+Shift+C" }));
    expect(actions.insertStructureItem).toHaveBeenCalledWith(tab.id, "indexes", 2, expect.objectContaining({ name: "idx_id" }));

    fireEvent.contextMenu(secondRow);
    fireEvent.click(await screen.findByRole("menuitem", { name: "粘贴并插入" }));
    expect(actions.insertStructureItem).toHaveBeenCalledWith(tab.id, "indexes", 2, expect.objectContaining({ name: "idx_name" }));

    fireEvent.contextMenu(firstRow);
    fireEvent.click(await screen.findByRole("menuitem", { name: /删除.*Backspace/ }));
    expect(actions.removeStructureItem).toHaveBeenCalledWith(tab.id, "indexes", 0);
  });

  it("previews the whole draft and reports structural risks across sections", async () => {
    const draft = draftFor(dbTableInfo.columns, dbTableInfo.columns, "advanced");
    draft.indexes = draft.indexes.filter((index) => index.name !== "idx_id");
    draft.foreignKeys = [];
    draft.triggers = [];
    draft.advanced = [{ key: "engine", value: "MyISAM" }];
    const tab = structureTab({ structure: draft });
    render(<TableStructureEditor tab={tab} />);

    fireEvent.click(screen.getByRole("button", { name: "应用结构" }));
    expect(actions.previewStructure).toHaveBeenCalledWith(tab.id);
    expect(await screen.findByTestId("structure-preview-sql")).toBeInTheDocument();
    expect(screen.getByText(/删除索引：idx_id/)).toBeInTheDocument();
    expect(screen.getByText(/删除外键：fk_owner/)).toBeInTheDocument();
    expect(screen.getByText(/删除触发器：users_audit/)).toBeInTheDocument();
    expect(screen.getByText(/修改高级选项：引擎/)).toBeInTheDocument();
  });

  it("confirms before refreshing a dirty draft and keeps all five tabs available", async () => {
    const changedColumns = dbTableInfo.columns.map((column, index) => index === 0 ? { ...column, name: "account_id" } : column);
    const tab = structureTab({}, dbTableInfo.columns, changedColumns);
    render(<TableStructureEditor tab={tab} />);

    fireEvent.click(screen.getByRole("button", { name: "刷新表结构" }));
    expect(actions.refreshStructure).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("放弃未保存的结构修改");
    fireEvent.click(screen.getByRole("button", { name: "放弃修改并刷新" }));
    await waitFor(() => expect(actions.resetStructureEdits).toHaveBeenCalledWith(tab.id));
    expect(actions.refreshStructure).toHaveBeenCalledWith(tab.id);
  });
});
