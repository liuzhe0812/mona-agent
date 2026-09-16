import type { SQLNamespace } from "@codemirror/lang-sql";
import type { DatabaseObject, QueryTab } from "./types";

function databaseObjects(tree: DatabaseObject[], database: string): DatabaseObject[] {
  const root = tree.find((item) => item.object_type === "database" && item.name === database);
  if (!root) return [];
  const result: DatabaseObject[] = [];
  const visit = (item: DatabaseObject) => {
    if (item.object_type === "table" || item.object_type === "view") result.push(item);
    item.children.forEach(visit);
  };
  root.children.forEach(visit);
  return result;
}

export function buildSqlCompletionSchema(tree: DatabaseObject[], tabs: QueryTab[], connectionId: string | null, database: string | null): SQLNamespace | undefined {
  if (!connectionId || !database) return undefined;
  const objects = databaseObjects(tree, database);
  const byName = new Map(objects.map((item) => [item.name, item]));
  for (const tab of tabs) {
    if (tab.connectionId === connectionId && tab.database === database && tab.tableName && tab.tableInfo) {
      if (!byName.has(tab.tableName)) byName.set(tab.tableName, { name: tab.tableName, schema: database, object_type: tab.objectType === "view" ? "view" : "table", children: [] });
    }
  }
  const tables: Record<string, SQLNamespace> = {};
  for (const object of byName.values()) {
    const info = tabs.find((tab) => tab.connectionId === connectionId && tab.database === database && tab.tableName === object.name && tab.tableInfo)?.tableInfo;
    tables[object.name] = {
      self: { label: object.name, type: "type", detail: object.object_type === "view" ? "VIEW" : "BASE TABLE", boost: 80 },
      children: (info?.columns ?? []).map((column) => ({ label: column.name, type: "property", detail: column.data_type, boost: 60 })),
    };
  }
  return { [database]: tables };
}
