import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "@/components/db/ipc";
import { useDbStore } from "@/components/db/store/dbStore";
import { hasPendingEdits } from "@/components/db/table-sql";
import type { StructureApplyResult } from "@/components/db/types";
import { dbConnection, dbTab, dbTableInfo } from "./db-fixtures";

const store = () => useDbStore.getState();
const editor = () => store().queryTabs.find((tab) => tab.kind === "structure")!;

beforeEach(() => {
  useDbStore.setState({ activeConnections: [dbConnection], queryTabs: [dbTab()], activeTabId: "tab-1", currentView: "table", selectedConnectionId: dbConnection.id, selectedDatabase: "main" });
  vi.spyOn(ipc, "dbGetTableInfo").mockResolvedValue(dbTableInfo);
  vi.spyOn(ipc, "dbPreviewTableStructure").mockResolvedValue(['ALTER TABLE "main"."users" RENAME COLUMN "name" TO "label"']);
  vi.spyOn(ipc, "dbExecuteQuery").mockResolvedValue(dbTab().result!);
  vi.spyOn(ipc, "dbGetDatabases").mockResolvedValue(["main"]);
  vi.spyOn(ipc, "dbGetTables").mockResolvedValue([]);
  vi.spyOn(ipc, "dbGetViews").mockResolvedValue([]);
  vi.spyOn(ipc, "dbGetRoutines").mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("structure tab lifecycle", () => {
  it("opens independently of data and reuses the same editor without losing changes", async () => {
    await store().openTableStructure(dbConnection.id, "main", "users");
    expect(store().queryTabs).toHaveLength(2);
    expect(store().queryTabs[0].kind).toBe("table");
    const id = editor().id;
    store().updateStructureColumn(id, 1, { name: "label" });
    expect(editor().structure?.originalColumns[1].name).toBe("name");
    store().setActiveTab("tab-1");
    await store().openTableStructure(dbConnection.id, "main", "users");
    expect(store().activeTabId).toBe(id);
    expect(editor().structure?.columns[1].name).toBe("label");
    expect(ipc.dbGetTableInfo).toHaveBeenCalledTimes(1);
    store().removeQueryTab(id);
    expect(editor()).toBeDefined();
    store().revertAllEdits(id); store().removeQueryTab(id);
    expect(store().queryTabs).toHaveLength(1);
  });

  it("requires data edits to be settled before previewing a structural change", async () => {
    await store().openTableStructure(dbConnection.id, "main", "users");
    store().updateCell("tab-1", 0, 1, "Pending data");
    await expect(store().previewStructure(editor().id)).rejects.toThrow("数据标签");
    expect(ipc.dbPreviewTableStructure).not.toHaveBeenCalled();
  });

  it("keeps drafts after a failed apply and resets them after a successful one", async () => {
    const apply = vi.spyOn(ipc, "dbApplyTableStructure").mockRejectedValueOnce(new Error("Constraint violation"));
    await store().openTableStructure(dbConnection.id, "main", "users");
    store().updateStructureColumn(editor().id, 1, { name: "label" });
    await store().applyStructure(editor().id);
    expect(editor().error).toContain("Constraint violation");
    expect(hasPendingEdits(editor())).toBe(true);
    const updated = { ...dbTableInfo, columns: dbTableInfo.columns.map((col, i) => i === 1 ? { ...col, name: "label" } : col) };
    apply.mockResolvedValue({ table_info: updated, refresh_error: null, execution_error: null, applied_statements: 1 });
    await store().applyStructure(editor().id);
    expect(hasPendingEdits(editor())).toBe(false);
    expect(editor().structure?.originalColumns[1].name).toBe("label");
    expect(store().queryTabs[0].tableInfo?.columns[1].name).toBe("label");
  });

  it("freezes same-table data editing while a schema change is applying", async () => {
    let finish!: (result: StructureApplyResult) => void;
    vi.spyOn(ipc, "dbApplyTableStructure").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await store().openTableStructure(dbConnection.id, "main", "users");
    store().updateStructureColumn(editor().id, 1, { name: "label" });
    const applying = store().applyStructure(editor().id);
    store().updateCell("tab-1", 0, 1, "Must not be lost");
    store().insertRow("tab-1");
    expect(hasPendingEdits(store().queryTabs[0])).toBe(false);
    finish({ table_info: dbTableInfo, refresh_error: null, execution_error: null, applied_statements: 1 });
    await applying;
  });

  it("does not replay applied DDL when the metadata refresh fails", async () => {
    const apply = vi.spyOn(ipc, "dbApplyTableStructure").mockResolvedValue({ table_info: null, refresh_error: "结构已应用，重新读取失败", execution_error: null, applied_statements: 1 });
    await store().openTableStructure(dbConnection.id, "main", "users");
    store().updateStructureColumn(editor().id, 1, { name: "label" });
    await store().applyStructure(editor().id);
    expect(editor().structure).toBeUndefined();
    expect(editor().error).toContain("已应用");
    await store().applyStructure(editor().id);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("adds, updates, moves, and deletes items in every structure list", async () => {
    await store().openTableStructure(dbConnection.id, "main", "users");
    const id = editor().id;
    store().moveStructureItem(id, "columns", 0, 1);
    expect(editor().structure?.columns.map((column) => column.name)).toEqual(["name", "id"]);
    store().insertStructureItem(id, "indexes");
    store().updateStructureItem(id, "indexes", 0, { name: "idx_name", columns: ["name"] });
    expect(editor().structure?.indexes[0].name).toBe("idx_name");
    store().insertStructureItem(id, "foreign_keys");
    store().updateStructureItem(id, "foreign_keys", 0, { name: "fk_owner", ref_table: "owners", ref_columns: ["id"] });
    expect(editor().structure?.foreignKeys[0].ref_table).toBe("owners");
    store().insertStructureItem(id, "triggers");
    store().updateStructureItem(id, "triggers", 0, { name: "audit_insert", statement: "SELECT 1" });
    expect(editor().structure?.triggers[0].name).toBe("audit_insert");
    store().insertStructureItem(id, "advanced");
    store().updateStructureItem(id, "advanced", 0, { value: "InnoDB" });
    expect(editor().structure?.advanced[0].key).toBe("engine");
    for (const section of ["indexes", "foreign_keys", "triggers", "advanced"] as const) store().removeStructureItem(id, section, 0);
    expect(editor().structure?.indexes).toHaveLength(0);
    expect(editor().structure?.foreignKeys).toHaveLength(0);
    expect(editor().structure?.triggers).toHaveLength(0);
    expect(editor().structure?.advanced).toHaveLength(0);
  });
});
