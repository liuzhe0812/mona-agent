import { DEFAULT_MARKER, NULL_MARKER, type CellValue, type QueryTab, type TableBrowse } from "./types";
import { hasStructureChanges } from "./structure-edit";

export const DEFAULT_BROWSE: TableBrowse = { page: 0, pageSize: 100, filters: [], sort: null };

export function quoteIdentifier(value: string, sqlite: boolean): string {
  const quote = sqlite ? '"' : '`';
  return quote + value.replaceAll(quote, quote + quote) + quote;
}

// Hex text literals are independent of MySQL's NO_BACKSLASH_ESCAPES mode.
export function textLiteral(value: string, sqlite: boolean): string {
  const hex = Array.from(new TextEncoder().encode(value), (b) => b.toString(16).padStart(2, "0")).join("");
  return sqlite ? `CAST(X'${hex}' AS TEXT)` : `CONVERT(X'${hex}' USING utf8mb4)`;
}

export function cellLiteral(cell: CellValue, sqlite: boolean): string {
  if (cell.type === "null") return "NULL";
  if (cell.type === "bool") return cell.value ? "1" : "0";
  if (cell.type === "integer" || cell.type === "float") {
    if (!Number.isFinite(cell.value)) throw new Error("数值无效");
    if (cell.type === "integer" && !Number.isSafeInteger(cell.value)) throw new Error("主键数值超出安全精度范围，此记录不能编辑");
    return String(cell.value);
  }
  if (cell.type === "blob") {
    if (!/^(?:[a-f\d]{2})*$/i.test(cell.value)) throw new Error("二进制值无效");
    return `X'${cell.value}'`;
  }
  return textLiteral(cell.value, sqlite);
}

export function tableTarget(tab: QueryTab, sqlite: boolean): string {
  if (tab.kind !== "table" || !tab.tableName || !tab.database) throw new Error("未选择数据表");
  return `${quoteIdentifier(tab.database, sqlite)}.${quoteIdentifier(tab.tableName, sqlite)}`;
}

export function buildBrowseSql(tab: QueryTab, sqlite: boolean): string {
  const browse = tab.browse ?? DEFAULT_BROWSE;
  const columns = new Set(tab.tableInfo?.columns.map((c) => c.name) ?? []);
  const column = (name: string) => {
    if (!columns.has(name)) throw new Error(`字段不存在：${name}`);
    return quoteIdentifier(name, sqlite);
  };
  const conditions = browse.filters.map((filter) => {
    const name = column(filter.column);
    switch (filter.operator) {
      case "is_null": return `${name} IS NULL`;
      case "not_null": return `${name} IS NOT NULL`;
      case "contains": return sqlite
        ? `instr(CAST(${name} AS TEXT), ${textLiteral(filter.value, sqlite)}) > 0`
        : `LOCATE(${textLiteral(filter.value, sqlite)}, ${name}) > 0`;
      case "eq": return `${name} = ${textLiteral(filter.value, sqlite)}`;
      case "gt": return `${name} > ${textLiteral(filter.value, sqlite)}`;
      case "lt": return `${name} < ${textLiteral(filter.value, sqlite)}`;
      default: throw new Error("不支持的筛选条件");
    }
  });
  const order = browse.sort
    ? `${column(browse.sort.column)} ${browse.sort.direction === "desc" ? "DESC" : "ASC"}`
    : (tab.tableInfo?.columns.filter((c) => c.is_primary_key).map((c) => quoteIdentifier(c.name, sqlite)).join(", ") ?? "");
  const pageSize = browse.pageSize === 500 ? 500 : 100;
  const page = Math.max(0, Math.floor(browse.page));
  return `SELECT * FROM ${tableTarget(tab, sqlite)}${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}${order ? ` ORDER BY ${order}` : ""} LIMIT ${pageSize + 1} OFFSET ${page * pageSize}`;
}

export function hasPendingEdits(tab: QueryTab): boolean {
  return hasStructureChanges(tab) || !!(tab.edits.length || tab.insertedRows.length || tab.deletedRows?.length);
}

export function canEditTable(tab: QueryTab): boolean {
  return tab.kind === "table" && tab.objectType !== "view" && !!tab.tableInfo?.columns.some((c) => c.is_primary_key);
}

export function buildRowMutation(tab: QueryTab, rowIdx: number, sqlite: boolean): string {
  if (!canEditTable(tab) || !tab.result) throw new Error("此结果缺少可靠主键，仅支持只读浏览");
  const target = tableTarget(tab, sqlite);
  const row = tab.result.rows[rowIdx];
  if (!row) throw new Error("记录不存在");
  const edits = tab.edits.filter((edit) => edit.rowIdx === rowIdx);
  const fieldValue = (colIdx: number, value: string): string => {
    if (value === NULL_MARKER) return "NULL";
    if (value === DEFAULT_MARKER) {
      if (!sqlite) return "DEFAULT";
      return tab.tableInfo?.columns.find((c) => c.name === tab.result!.columns[colIdx].name)?.default_value ?? "NULL";
    }
    return textLiteral(value, sqlite);
  };
  if (tab.insertedRows.includes(rowIdx)) {
    if (!edits.length) return sqlite ? `INSERT INTO ${target} DEFAULT VALUES` : `INSERT INTO ${target} () VALUES ()`;
    return `INSERT INTO ${target} (${edits.map((e) => quoteIdentifier(tab.result!.columns[e.colIdx].name, sqlite)).join(", ")}) VALUES (${edits.map((e) => fieldValue(e.colIdx, e.newValue)).join(", ")})`;
  }
  const keys = tab.tableInfo!.columns.filter((c) => c.is_primary_key);
  const where = keys.map((key) => {
    const idx = tab.result!.columns.findIndex((c) => c.name === key.name);
    if (idx < 0 || row[idx]?.type === "null") throw new Error("记录缺少主键值，无法安全保存");
    return `${quoteIdentifier(key.name, sqlite)} = ${cellLiteral(row[idx], sqlite)}`;
  }).join(" AND ");
  if (tab.deletedRows?.includes(rowIdx)) return `DELETE FROM ${target} WHERE ${where}`;
  if (!edits.length) throw new Error("记录没有修改");
  return `UPDATE ${target} SET ${edits.map((e) => `${quoteIdentifier(tab.result!.columns[e.colIdx].name, sqlite)} = ${fieldValue(e.colIdx, e.newValue)}`).join(", ")} WHERE ${where}`;
}
