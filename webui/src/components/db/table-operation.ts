import { quoteIdentifier } from "./table-sql";

export type TableOperation = "rename" | "truncate" | "drop";
export type TableObjectType = "table" | "view";

export interface TableOperationContext {
  database: string;
  table: string;
  objectType: TableObjectType;
  operation: TableOperation;
}

export function buildTableOperationSql(
  context: TableOperationContext,
  newName: string | undefined,
  sqlite: boolean,
): string;
export function buildTableOperationSql(
  context: TableOperationContext,
  sqlite: boolean,
): string;
export function buildTableOperationSql(
  context: TableOperationContext,
  newNameOrSqlite: string | boolean | undefined,
  sqlite = false,
): string {
  const newName = typeof newNameOrSqlite === "string" ? newNameOrSqlite.trim() : undefined;
  if (typeof newNameOrSqlite === "boolean") sqlite = newNameOrSqlite;

  const target = `${quoteIdentifier(context.database, sqlite)}.${quoteIdentifier(context.table, sqlite)}`;
  switch (context.operation) {
    case "rename":
      if (context.objectType !== "table") throw new Error("视图不支持重命名操作。");
      if (!newName) throw new Error("请输入新表名。");
      if (sqlite) return `ALTER TABLE ${target} RENAME TO ${quoteIdentifier(newName, true)}`;
      return `RENAME TABLE ${target} TO ${quoteIdentifier(context.database, false)}.${quoteIdentifier(newName, false)}`;
    case "truncate":
      if (context.objectType !== "table") throw new Error("视图不支持清空操作。");
      return sqlite ? `DELETE FROM ${target}` : `TRUNCATE TABLE ${target}`;
    case "drop":
      return `DROP ${context.objectType === "view" ? "VIEW" : "TABLE"} ${target}`;
  }
}
