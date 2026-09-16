import { describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { dbGetRoutineDefinition, dbGetRoutines, dbGetTableSummaries, dbPreviewTableStructure, dbApplyTableStructure, dbLoadSavedQueries, dbSaveQuery } from "@/components/db/ipc";

describe("database catalog IPC", () => {
  it("sends the selected connection and database using the Rust command's camel-case arguments", async () => {
    await dbGetTableSummaries("connection-2", "业务库");
    expect(invoke).toHaveBeenCalledWith("db_get_table_summaries", { connectionId: "connection-2", database: "业务库" });
  });
  it("sends the schema baseline to both the preview and apply commands", async () => {
    const draft = { originalColumns: [], columns: [], originalIndexes: [], indexes: [], originalForeignKeys: [], foreignKeys: [],
      originalTriggers: [], triggers: [], originalAdvanced: { engine: null, charset: null, collation: null, comment: null, row_format: null, auto_increment: null }, advanced: [], section: "columns" as const };
    await dbPreviewTableStructure("db-1", "main", "users", draft);
    expect(invoke).toHaveBeenLastCalledWith("db_preview_table_structure", { connectionId: "db-1", database: "main", table: "users", draft });
    await dbApplyTableStructure("db-1", "main", "users", draft);
    expect(invoke).toHaveBeenLastCalledWith("db_apply_table_structure", { connectionId: "db-1", database: "main", table: "users", draft });
  });
  it("uses the routine command contracts", async () => {
    await dbGetRoutines("db-1", "analytics");
    expect(invoke).toHaveBeenLastCalledWith("db_get_routines", { connectionId: "db-1", database: "analytics" });
    await dbGetRoutineDefinition("db-1", "analytics", "sync_data", "procedure");
    expect(invoke).toHaveBeenLastCalledWith("db_get_routine_definition", {
      connectionId: "db-1", database: "analytics", name: "sync_data", routineType: "procedure",
    });
  });
  it("uses the saved-query command contracts", async () => {
    const query = { id: "q-1", name: "日报", connection_id: "db-1", database: "analytics", sql: "SELECT 1" };
    await dbLoadSavedQueries();
    expect(invoke).toHaveBeenLastCalledWith("db_load_saved_queries", undefined);
    await dbSaveQuery(query);
    expect(invoke).toHaveBeenLastCalledWith("db_save_query", { query });
  });
});
