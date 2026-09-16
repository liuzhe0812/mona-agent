import { createRequire } from "node:module";
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTableOperationSql, type TableOperationContext } from "./table-operation";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

let database: SqliteDatabase;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
});

afterEach(() => {
  database.close();
});

describe("table operation SQL", () => {
  it("renames, clears, and drops a SQLite table with quoted identifiers", () => {
    const context: TableOperationContext = {
      database: "main",
      table: 'old"table',
      objectType: "table",
      operation: "rename",
    };
    database.exec('CREATE TABLE "old""table" (id INTEGER PRIMARY KEY, value TEXT)');
    database.prepare('INSERT INTO "old""table" (value) VALUES (?)').run("before");

    const renamed = 'new"table';
    database.exec(buildTableOperationSql(context, renamed, true));
    expect(database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?').get(renamed)).toBeTruthy();

    const truncateContext = { ...context, table: renamed, operation: "truncate" as const };
    database.exec(buildTableOperationSql(truncateContext, undefined, true));
    expect(database.prepare('SELECT COUNT(*) AS count FROM "new""table"').get()?.count).toBe(0);

    const dropContext = { ...truncateContext, operation: "drop" as const };
    database.exec(buildTableOperationSql(dropContext, undefined, true));
    expect(database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?').get(renamed)).toBeUndefined();
  });

  it("drops a SQLite view and emits escaped MySQL statements", () => {
    const viewContext: TableOperationContext = {
      database: "main",
      table: 'view"name',
      objectType: "view",
      operation: "drop",
    };
    database.exec('CREATE TABLE source (value TEXT); CREATE VIEW "view""name" AS SELECT * FROM source');
    database.exec(buildTableOperationSql(viewContext, undefined, true));
    expect(database.prepare('SELECT name FROM sqlite_master WHERE type = \'view\' AND name = ?').get(viewContext.table)).toBeUndefined();

    const mysqlContext: TableOperationContext = {
      database: "db`name",
      table: "old`table",
      objectType: "table",
      operation: "rename",
    };
    expect(buildTableOperationSql(mysqlContext, "new`table", false)).toBe(
      "RENAME TABLE `db``name`.`old``table` TO `db``name`.`new``table`",
    );
    expect(buildTableOperationSql({ ...mysqlContext, operation: "truncate" }, undefined, false)).toBe(
      "TRUNCATE TABLE `db``name`.`old``table`",
    );
    expect(buildTableOperationSql({ ...mysqlContext, objectType: "view", operation: "drop" }, undefined, false)).toBe(
      "DROP VIEW `db``name`.`old``table`",
    );
  });

  it("rejects rename and truncate operations for views", () => {
    const context: TableOperationContext = {
      database: "main",
      table: "view_name",
      objectType: "view",
      operation: "rename",
    };
    expect(() => buildTableOperationSql(context, "renamed", true)).toThrow("视图不支持重命名");
    expect(() => buildTableOperationSql({ ...context, operation: "truncate" }, undefined, true)).toThrow("视图不支持清空");
  });
});
