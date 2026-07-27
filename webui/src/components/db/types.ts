export type DatabaseType = "mysql" | "postgresql" | "sqlite" | "sqlserver" | "oracle" | "mongodb";

export interface SshAuthConfig {
  type: "password" | "key";
  password?: string;
  key_path?: string;
  passphrase?: string;
}

export interface DbConnectionConfig {
  id: string;
  name: string;
  db_type: DatabaseType;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string | null;
  use_ssl: boolean;
  use_ssh_tunnel: boolean;
  ssh_host: string | null;
  ssh_port: number | null;
  ssh_username: string | null;
  ssh_auth: SshAuthConfig | null;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectionInfo {
  id: string;
  config: DbConnectionConfig;
  status: ConnectionStatus;
  server_version: string | null;
  error_message: string | null;
}

export type DatabaseObjectType =
  | "server"
  | "database"
  | "table"
  | "view"
  | "procedure"
  | "function"
  | "index"
  | "trigger"
  | "event"
  | "column"
  | "folder";

export interface DatabaseObject {
  name: string;
  schema: string | null;
  object_type: DatabaseObjectType;
  children: DatabaseObject[];
}

export type CellValue =
  | { type: "null" }
  | { type: "integer"; value: number }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; value: string }
  | { type: "bool"; value: boolean };

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  is_primary_key: boolean;
  is_auto_increment: boolean;
}

export interface QueryResult {
  columns: ColumnInfo[];
  rows: CellValue[][];
  affected_rows: number;
  execution_time_ms: number;
  message: string | null;
}

export interface ColumnDefinition {
  name: string;
  data_type: string;
  nullable: boolean;
  default_value: string | null;
  is_primary_key: boolean;
  is_unique: boolean;
  is_auto_increment: boolean;
  extra: string | null;
  comment: string | null;
}

export interface IndexDefinition {
  name: string;
  columns: string[];
  is_unique: boolean;
  is_primary: boolean;
  index_type: string | null;
}

export interface ForeignKeyDefinition {
  name: string;
  columns: string[];
  ref_table: string;
  ref_columns: string[];
  on_delete: string | null;
  on_update: string | null;
}

export interface TableInfo {
  name: string;
  schema: string | null;
  engine: string | null;
  charset: string | null;
  collation: string | null;
  row_count: number | null;
  data_size: string | null;
  index_size: string | null;
  auto_increment: number | null;
  create_time: string | null;
  update_time: string | null;
  columns: ColumnDefinition[];
  indexes: IndexDefinition[];
  foreign_keys: ForeignKeyDefinition[];
  ddl: string | null;
}

export interface ServerStats {
  connections: number;
  max_connections: number;
  qps: number;
  slow_queries: number;
  buffer_pool_hit_rate: number | null;
  replication_lag_seconds: number | null;
  disk_usage_gb: number | null;
  disk_total_gb: number | null;
  uptime_seconds: number | null;
  server_version: string | null;
}

export interface ProcessInfo {
  id: number;
  user: string;
  host: string;
  database: string | null;
  command: string;
  time: number;
  state: string | null;
  info: string | null;
}

export interface UserInfo {
  username: string;
  host: string;
  privileges: string;
  password_expired: boolean;
  account_locked: boolean;
}

export type DbViewType = "table" | "dashboard" | "users" | "variables" | "processes" | "slow-queries" | "replication" | "backup";

export interface CellEdit {
  rowIdx: number;
  colIdx: number;
  oldValue: CellValue;
  newValue: string;
}

export const NULL_MARKER = "\u0000NULL";
export const DEFAULT_MARKER = "\u0000DEFAULT";

export interface QueryTab {
  id: string;
  title: string;
  sql: string;
  result: QueryResult | null;
  isExecuting: boolean;
  connectionId: string | null;
  database: string | null;
  edits: CellEdit[];
  insertedRows: number[];
  tableInfo: TableInfo | null;
  agentChatId: string | null;
}

export function displayCellValue(cell: CellValue): string {
  switch (cell.type) {
    case "null":
      return "NULL";
    case "integer":
    case "float":
    case "bool":
      return String(cell.value);
    case "text":
      return cell.value;
    case "blob":
      return `0x${cell.value}`;
  }
}
