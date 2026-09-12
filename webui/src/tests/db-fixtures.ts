import type { ConnectionInfo, QueryTab, TableInfo } from "@/components/db/types";

export const dbConnection: ConnectionInfo = {
  id: "db-test", status: "connected", server_version: "SQLite", error_message: null,
  config: { id: "db-test", name: "Local", db_type: "sqlite", host: ":memory:", port: 0, username: "", password: "",
    database: "main", use_ssl: false, use_ssh_tunnel: false, ssh_host: null, ssh_port: null, ssh_username: null, ssh_auth: null },
};
export const dbTableInfo: TableInfo = {
  name: "users", schema: "main", engine: null, charset: null, collation: null, row_count: null,
  data_size: null, index_size: null, auto_increment: null, create_time: null, update_time: null,
  columns: [
    { name: "id", data_type: "INTEGER", nullable: false, default_value: null, is_primary_key: true, is_unique: true, is_auto_increment: true, extra: null, comment: null },
    { name: "name", data_type: "TEXT", nullable: true, default_value: null, is_primary_key: false, is_unique: true, is_auto_increment: false, extra: null, comment: null },
  ], indexes: [], foreign_keys: [], ddl: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT UNIQUE)",
};
export function dbTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1", kind: "table", tableName: "users", objectType: "table", title: "users", sql: "SELECT * FROM main.users",
    connectionId: dbConnection.id, database: "main", isExecuting: false, edits: [], insertedRows: [], deletedRows: [],
    selectedRows: [], tableInfo: dbTableInfo, agentChatId: null, preview: false,
    browse: { page: 0, pageSize: 100, filters: [], sort: null },
    result: { columns: dbTableInfo.columns.map((col) => ({ name: col.name, data_type: col.data_type, nullable: col.nullable, is_primary_key: col.is_primary_key, is_auto_increment: col.is_auto_increment })),
      rows: [[{ type: "integer", value: 1 }, { type: "text", value: "Ada" }]], affected_rows: 0, execution_time_ms: 1, message: null },
    ...overrides,
  };
}
