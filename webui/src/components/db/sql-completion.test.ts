import { describe, expect, it } from "vitest";
import { dbTab, dbTableInfo } from "@/tests/db-fixtures";
import type { DatabaseObject } from "./types";
import { buildSqlCompletionSchema } from "./sql-completion";

describe("SQL completion schema", () => {
  it("combines catalog tables and open-table columns for the active database", () => {
    const tree: DatabaseObject[] = [{ name: "app", schema: null, object_type: "database", children: [
      { name: "表", schema: "app", object_type: "folder", children: [{ name: "users", schema: "app", object_type: "table", children: [] }] },
      { name: "视图", schema: "app", object_type: "folder", children: [{ name: "active_users", schema: "app", object_type: "view", children: [] }] },
    ] }];
    const tabs = [dbTab({ connectionId: "db-test", database: "app", tableName: "users", tableInfo: dbTableInfo })];
    const schema = buildSqlCompletionSchema(tree, tabs, "db-test", "app") as Record<string, Record<string, { self: { detail: string }; children: Array<{ label: string; detail: string }> }>>;

    expect(schema.app.users.self.detail).toBe("BASE TABLE");
    expect(schema.app.users.children).toEqual(expect.arrayContaining([expect.objectContaining({ label: "id", detail: "INTEGER" })]));
    expect(schema.app.active_users.self.detail).toBe("VIEW");
  });

  it("does not expose another database or disconnected catalog", () => {
    expect(buildSqlCompletionSchema([], [], null, "app")).toBeUndefined();
    expect(buildSqlCompletionSchema([], [], "db-test", null)).toBeUndefined();
  });
});
