import { isTauri } from "@/lib/tauri";
import type {
  DbConnectionConfig,
  ConnectionInfo,
  QueryResult,
  DatabaseObject,
  TableInfo,
  ServerStats,
  ProcessInfo,
  UserInfo,
  TableSummary,
} from "./types";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error("Not running in Tauri environment");
  }
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

export async function dbConnect(config: DbConnectionConfig): Promise<ConnectionInfo> {
  return invoke<ConnectionInfo>("db_connect", { config });
}

export async function dbDisconnect(connectionId: string): Promise<void> {
  return invoke("db_disconnect", { connectionId });
}

export async function dbTestConnection(config: DbConnectionConfig): Promise<string> {
  return invoke<string>("db_test_connection", { config });
}

export async function dbExecuteQuery(
  connectionId: string,
  sql: string,
  limit?: number,
  database?: string,
): Promise<QueryResult> {
  return invoke<QueryResult>("db_execute_query", {
    connectionId,
    sql,
    limit: limit ?? null,
    database: database ?? null,
  });
}

export async function dbGetDatabases(connectionId: string): Promise<string[]> {
  return invoke<string[]>("db_get_databases", { connectionId });
}

export async function dbGetTables(
  connectionId: string,
  database: string,
): Promise<DatabaseObject[]> {
  return invoke<DatabaseObject[]>("db_get_tables", { connectionId, database });
}

export async function dbGetTableSummaries(connectionId: string, database: string): Promise<TableSummary[]> {
  return invoke<TableSummary[]>("db_get_table_summaries", { connectionId, database });
}

export async function dbGetViews(
  connectionId: string,
  database: string,
): Promise<DatabaseObject[]> {
  return invoke<DatabaseObject[]>("db_get_views", { connectionId, database });
}

export async function dbGetTableInfo(
  connectionId: string,
  database: string,
  table: string,
): Promise<TableInfo> {
  return invoke<TableInfo>("db_get_table_info", { connectionId, database, table });
}

export async function dbGetServerStats(connectionId: string): Promise<ServerStats> {
  return invoke<ServerStats>("db_get_server_stats", { connectionId });
}

export async function dbGetProcesses(connectionId: string): Promise<ProcessInfo[]> {
  return invoke<ProcessInfo[]>("db_get_processes", { connectionId });
}

export async function dbGetUsers(connectionId: string): Promise<UserInfo[]> {
  return invoke<UserInfo[]>("db_get_users", { connectionId });
}

export async function dbKillProcess(
  connectionId: string,
  processId: number,
): Promise<void> {
  return invoke("db_kill_process", { connectionId, processId });
}

export async function dbSaveConnections(
  connections: DbConnectionConfig[],
): Promise<void> {
  return invoke("db_save_connections", { connections });
}

export async function dbLoadConnections(): Promise<DbConnectionConfig[]> {
  return invoke<DbConnectionConfig[]>("db_load_connections");
}

export async function dbBackupDatabase(
  connectionId: string,
  database: string,
  outputPath: string,
  includeDdl?: boolean,
  includeData?: boolean,
): Promise<void> {
  return invoke("db_backup_database", {
    connectionId,
    database,
    outputPath,
    includeDdl: includeDdl ?? null,
    includeData: includeData ?? null,
  });
}

export async function dbRestoreDatabase(
  connectionId: string,
  database: string,
  inputPath: string,
): Promise<void> {
  return invoke("db_restore_database", {
    connectionId,
    database,
    inputPath,
  });
}
