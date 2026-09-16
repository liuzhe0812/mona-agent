import { createRequire } from "node:module";
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "@/components/db/ipc";
import { useDbStore } from "@/components/db/store/dbStore";
import { buildBrowseSql, buildRowMutation, textLiteral } from "@/components/db/table-sql";
import { singleQueryStatement } from "@/components/db/query-sql";
import type { CellValue, QueryResult } from "@/components/db/types";
import { dbConnection, dbTab, dbTableInfo } from "./db-fixtures";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
let database: SqliteDatabase;
function execute(sql: string): QueryResult {
  const statement = database.prepare(sql);
  const columns = statement.columns();
  if (!columns.length) {
    const result = statement.run();
    return { rows: [], columns: [], affected_rows: Number(result.changes), execution_time_ms: 1, message: null };
  }
  const data = statement.all();
  return { columns: columns.map((c) => ({ name: c.name, data_type: c.type ?? "TEXT", nullable: true, is_primary_key: c.name === "id", is_auto_increment: c.name === "id" })),
    rows: data.map((row) => columns.map((c): CellValue => row[c.name] === null ? { type: "null" } : typeof row[c.name] === "number" ? { type: "integer", value: Number(row[c.name]) } : { type: "text", value: String(row[c.name]) })),
    affected_rows: 0, execution_time_ms: 1, message: null };
}
beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec(dbTableInfo.ddl!);
  const insert = database.prepare("INSERT INTO users(name) VALUES (?)");
  for (let i = 0; i < 205; i++) insert.run(`User${i}`);
  vi.spyOn(ipc, "dbExecuteQuery").mockImplementation(async (_id, sql) => execute(sql));
  vi.spyOn(ipc, "dbGetTableInfo").mockResolvedValue(dbTableInfo);
  vi.spyOn(ipc, "dbGetDatabases").mockResolvedValue(["main"]);
  vi.spyOn(ipc, "dbGetTables").mockResolvedValue([]);
  vi.spyOn(ipc, "dbGetViews").mockResolvedValue([]);
  vi.spyOn(ipc, "dbGetRoutines").mockResolvedValue([]);
  useDbStore.setState({ activeConnections: [dbConnection], queryTabs: [], activeTabId: null, objectScope: null, selectedConnectionId: dbConnection.id, selectedDatabase: "main" });
});
afterEach(() => { database.close(); vi.restoreAllMocks(); });
const store = () => useDbStore.getState();
const active = () => store().queryTabs.find((t) => t.id === store().activeTabId)!;

describe("database table navigation and persistence", () => {
  it("pages and filters all database rows rather than the visible page", async () => {
    await store().selectTable(dbConnection.id, "main", "users");
    expect(active().result?.rows).toHaveLength(100);
    expect(active().hasMore).toBe(true);
    await store().browseTable(active().id, { page: 2 });
    expect(active().result?.rows).toHaveLength(5);
    expect(active().hasMore).toBe(false);
    await store().browseTable(active().id, { page: 0, filters: [{ column: "name", operator: "eq", value: "User204" }] });
    expect(active().result?.rows[0][0]).toEqual({ type: "integer", value: 205 });
  });
  it("retains edits and does not refetch when selecting an existing table", async () => {
    await store().selectTable(dbConnection.id, "main", "users");
    const id = active().id;
    store().updateCell(id, 0, 1, "Edited");
    const calls = vi.mocked(ipc.dbExecuteQuery).mock.calls.length;
    await store().selectTable(dbConnection.id, "main", "users", true);
    await store().browseTable(id, { page: 1 });
    expect(active().edits[0].newValue).toBe("Edited");
    expect(active().preview).toBe(false);
    expect(active().browse?.page).toBe(0);
    expect(vi.mocked(ipc.dbExecuteQuery).mock.calls).toHaveLength(calls);
  });
  it("binds selection to the tab target, not the tree's current database", () => {
    const a = dbTab({ id: "a", database: "first" });
    const b = dbTab({ id: "b", database: "second" });
    useDbStore.setState({ queryTabs: [a, b], selectedDatabase: "other" });
    store().setActiveTab(a.id);
    expect(store().selectedDatabase).toBe("first");
    store().setActiveTab(b.id);
    expect(store().selectedDatabase).toBe("second");
    expect(store().objectScope?.database).toBe("second");
    useDbStore.setState({ selectedConnectionId: "wrong", selectedDatabase: "wrong" });
    store().addQueryTab();
    expect(active().database).toBe("second");
    expect(active().connectionId).toBe(dbConnection.id);
  });
  it("restores the displayed page after a failed page request", async () => {
    await store().selectTable(dbConnection.id, "main", "users");
    vi.mocked(ipc.dbExecuteQuery).mockRejectedValueOnce(new Error("Connection lost"));
    await store().browseTable(active().id, { page: 1 });
    expect(active().browse?.page).toBe(0);
    expect(active().error).toContain("Connection lost");
    expect(active().result?.rows[0][0]).toEqual({ type: "integer", value: 1 });
  });
  it("does not hide a metadata error when the data query succeeds", async () => {
    vi.mocked(ipc.dbGetTableInfo).mockRejectedValueOnce(new Error("Permission denied"));
    await store().selectTable(dbConnection.id, "main", "users");
    expect(active().metadataError).toContain("Permission denied");
    expect(active().result?.rows).toHaveLength(100);
    expect(active().isLoadingMetadata).toBe(false);
  });
  it("stages row deletion and allows undo before any SQL runs", async () => {
    await store().selectTable(dbConnection.id, "main", "users");
    await store().deleteRow(active().id, 0);
    expect(database.prepare("SELECT COUNT(*) AS n FROM users").get()?.n).toBe(205);
    expect(active().deletedRows).toEqual([0]);
    store().revertAllEdits(active().id);
    expect(active().deletedRows).toEqual([]);
  });
  it("clones an editable row while leaving its auto-increment key empty", () => {
    const tab = dbTab();
    useDbStore.setState({ queryTabs: [tab], activeTabId: tab.id, activeConnections: [dbConnection] });
    expect(store().cloneRow(tab.id, 0)).toBe(true);
    expect(active().insertedRows).toEqual([1]);
    expect(active().result?.rows[1]).toEqual([{ type: "null" }, { type: "text", value: "Ada" }]);
    expect(active().edits.map((edit) => [edit.rowIdx, edit.colIdx, edit.newValue])).toEqual([[1, 1, "Ada"]]);
  });
  it("retains failed inserts without retrying successfully submitted ones", async () => {
    await store().selectTable(dbConnection.id, "main", "users");
    const id = active().id;
    store().insertRow(id); store().updateCell(id, 100, 1, "New person");
    store().insertRow(id); store().updateCell(id, 101, 1, "User1");
    await store().saveEdits(id);
    expect(active().error).toContain("保存失败");
    expect(active().insertedRows).toEqual([100]);
    expect(database.prepare("SELECT COUNT(*) AS n FROM users WHERE name = 'New person'").get()?.n).toBe(1);
    store().updateCell(id, 100, 1, "Another person");
    await store().saveEdits(id);
    expect(active().error).toBeNull();
    expect(active().insertedRows).toEqual([]);
    expect(database.prepare("SELECT COUNT(*) AS n FROM users").get()?.n).toBe(207);
  });
  it("keeps AI SQL drafts separate from the table browser", () => {
    const tab = dbTab(); useDbStore.setState({ queryTabs: [tab], activeTabId: tab.id });
    store().updateTabSql(tab.id, "SELECT 42");
    expect(store().queryTabs.find((t) => t.id === tab.id)?.kind).toBe("table");
    expect(active().kind).toBe("query"); expect(active().sql).toBe("SELECT 42");
  });
});

describe("table SQL encoding against a real SQLite engine", () => {
  it("roundtrips quotes, backslashes, unicode, empty text and NUL without SQL injection", () => {
    for (const value of ["", "O'Reilly", "\\'; DROP TABLE users; --", "中文\u0000value"]) {
      expect(database.prepare(`SELECT ${textLiteral(value, true)} AS value`).get()?.value).toBe(value);
      expect(textLiteral(value, false)).toMatch(/^CONVERT\(X'[a-f0-9]*' USING utf8mb4\)$/);
    }
    expect(database.prepare("SELECT COUNT(*) AS n FROM users").get()?.n).toBe(205);
  });
  it("escapes unusual table names and applies filter literals", () => {
    database.exec('CREATE TABLE "a""b" (id INTEGER PRIMARY KEY, name TEXT)');
    database.prepare('INSERT INTO "a""b" VALUES (1, ?)').run("a'\\%_");
    const tab = dbTab({ tableName: 'a"b', browse: { page: 0, pageSize: 100, sort: null, filters: [{ column: "name", operator: "eq", value: "a'\\%_" }] } });
    expect(execute(buildBrowseSql(tab, true)).rows).toHaveLength(1);
  });
  it("refuses mutations without a primary key", () => {
    const tab = dbTab({ tableInfo: { ...dbTableInfo, columns: dbTableInfo.columns.map((c) => ({ ...c, is_primary_key: false })) } });
    expect(() => buildRowMutation(tab, 0, true)).toThrow("主键");
  });
  it("runs one SQL statement with comments or quoted semicolons, and refuses ambiguous batches", () => {
    const sql = singleQueryStatement("-- a comment\n SELECT ';' as result; -- trailing comment", true);
    expect(execute(sql).rows[0][0]).toEqual({ type: "text", value: ";" });
    expect(() => singleQueryStatement("SELECT 1; DELETE FROM users", true)).toThrow("单条");
    expect(() => singleQueryStatement("BEGIN", false)).toThrow("手动事务");
    expect(() => singleQueryStatement("USE other_db", false)).toThrow("工具栏");
  });
});
