import { create } from "zustand";
import type {
  DbConnectionConfig,
  ConnectionInfo,
  DatabaseObject,
  QueryTab,
  CellEdit,
  CellValue,
  TableInfo,
  ServerStats,
  ProcessInfo,
  UserInfo,
  DbViewType,
} from "../types";
import { displayCellValue, NULL_MARKER, DEFAULT_MARKER } from "../types";
import * as ipc from "../ipc";

interface DbState {
  savedConnections: DbConnectionConfig[];
  activeConnections: ConnectionInfo[];
  connectionTree: Record<string, DatabaseObject[]>;
  queryTabs: QueryTab[];
  activeTabId: string | null;
  currentView: DbViewType;
  selectedTable: TableInfo | null;
  selectedConnectionId: string | null;
  selectedDatabase: string | null;
  serverStats: ServerStats | null;
  processes: ProcessInfo[];
  users: UserInfo[];
  newConnectionDialogOpen: boolean;
  editConnectionConfig: DbConnectionConfig | null;
  isLoadingTree: boolean;
  isLoadingTable: boolean;
  connectingId: string | null;
  connectError: string | null;
  agentStreaming: boolean;

  setAgentStreaming: (streaming: boolean) => void;

  loadSavedConnections: () => Promise<void>;
  saveConnection: (config: DbConnectionConfig) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  connect: (config: DbConnectionConfig) => Promise<void>;
  disconnect: (connectionId: string) => Promise<void>;
  testConnection: (config: DbConnectionConfig) => Promise<string>;
  refreshTree: (connectionId: string) => Promise<void>;
  selectTable: (connectionId: string, database: string, tableName: string) => Promise<void>;
  addQueryTab: () => string;
  removeQueryTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabSql: (tabId: string, sql: string) => void;
  executeQuery: (tabId: string) => Promise<void>;
  setCurrentView: (view: DbViewType) => void;
  setSelectedConnectionId: (id: string | null) => void;
  setSelectedDatabase: (db: string | null) => void;
  setNewConnectionDialogOpen: (open: boolean) => void;
  setEditConnectionConfig: (config: DbConnectionConfig | null) => void;
  setConnectError: (error: string | null) => void;
  refreshServerStats: (connectionId: string) => Promise<void>;
  refreshProcesses: (connectionId: string) => Promise<void>;
  refreshUsers: (connectionId: string) => Promise<void>;
  killProcess: (connectionId: string, processId: number) => Promise<void>;
  updateCell: (tabId: string, rowIdx: number, colIdx: number, newValue: string) => void;
  revertCell: (tabId: string, rowIdx: number, colIdx: number) => void;
  revertAllEdits: (tabId: string) => void;
  saveEdits: (tabId: string) => Promise<void>;
  insertRow: (tabId: string) => void;
  deleteRow: (tabId: string, rowIdx: number) => Promise<void>;
}

export const useDbStore = create<DbState>((set, get) => ({
  savedConnections: [],
  activeConnections: [],
  connectionTree: {},
  queryTabs: [],
  activeTabId: null,
  currentView: "table",
  selectedTable: null,
  selectedConnectionId: null,
  selectedDatabase: null,
  serverStats: null,
  processes: [],
  users: [],
  newConnectionDialogOpen: false,
  editConnectionConfig: null,
  isLoadingTree: false,
  isLoadingTable: false,
  connectingId: null,
  connectError: null,
  agentStreaming: false,

  loadSavedConnections: async () => {
    try {
      const connections = await ipc.dbLoadConnections();
      set({ savedConnections: connections });
    } catch {
      set({ savedConnections: [] });
    }
  },

  saveConnection: async (config) => {
    const { savedConnections } = get();
    const existing = savedConnections.findIndex((c) => c.id === config.id);
    const updated =
      existing >= 0
        ? savedConnections.map((c) => (c.id === config.id ? config : c))
        : [...savedConnections, config];
    set({ savedConnections: updated });
    try {
      await ipc.dbSaveConnections(updated);
    } catch {
      set({ savedConnections: savedConnections });
    }
  },

  deleteConnection: async (id) => {
    const { savedConnections } = get();
    const updated = savedConnections.filter((c) => c.id !== id);
    set({ savedConnections: updated });
    try {
      await ipc.dbSaveConnections(updated);
    } catch {
      set({ savedConnections: savedConnections });
    }
  },

  connect: async (config) => {
    set({ connectingId: config.id, connectError: null });
    try {
      const info = await ipc.dbConnect(config);
      set((state) => ({
        activeConnections: [...state.activeConnections, info],
        selectedConnectionId: info.id,
        connectingId: null,
      }));
      await get().refreshTree(info.id);
    } catch (e) {
      set({ connectingId: null, connectError: String(e) });
      throw e;
    }
  },

  disconnect: async (connectionId) => {
    try {
      await ipc.dbDisconnect(connectionId);
      set((state) => {
        const { [connectionId]: _, ...restTree } = state.connectionTree;
        return {
          activeConnections: state.activeConnections.filter(
            (c) => c.id !== connectionId,
          ),
          connectionTree: restTree,
          selectedConnectionId:
            state.selectedConnectionId === connectionId
              ? state.activeConnections.find((c) => c.id !== connectionId)?.id ?? null
              : state.selectedConnectionId,
        };
      });
    } catch {
      // ignore disconnect errors
    }
  },

  testConnection: async (config) => {
    return ipc.dbTestConnection(config);
  },

  refreshTree: async (connectionId) => {
    set({ isLoadingTree: true });
    try {
      const databases = await ipc.dbGetDatabases(connectionId);
      const tree: DatabaseObject[] = await Promise.all(
        databases
          .filter((db) => !["information_schema", "mysql", "performance_schema", "sys"].includes(db))
          .map(async (dbName) => {
            try {
              const tables = await ipc.dbGetTables(connectionId, dbName);
              const views = await ipc.dbGetViews(connectionId, dbName);
              return {
                name: dbName,
                schema: null,
                object_type: "database" as const,
                children: [
                  {
                    name: "表",
                    schema: dbName,
                    object_type: "folder" as const,
                    children: tables,
                  },
                  {
                    name: "视图",
                    schema: dbName,
                    object_type: "folder" as const,
                    children: views,
                  },
                  {
                    name: "存储过程",
                    schema: dbName,
                    object_type: "folder" as const,
                    children: [],
                  },
                  {
                    name: "索引",
                    schema: dbName,
                    object_type: "folder" as const,
                    children: [],
                  },
                  {
                    name: "触发器",
                    schema: dbName,
                    object_type: "folder" as const,
                    children: [],
                  },
                  {
                    name: "事件",
                    schema: dbName,
                    object_type: "folder" as const,
                    children: [],
                  },
                ],
              };
            } catch {
              return {
                name: dbName,
                schema: null,
                object_type: "database" as const,
                children: [],
              };
            }
          }),
      );
      set((state) => ({
        connectionTree: { ...state.connectionTree, [connectionId]: tree },
      }));
    } catch {
      // ignore tree refresh errors
    } finally {
      set({ isLoadingTree: false });
    }
  },

  selectTable: async (connectionId, database, tableName) => {
    set({ isLoadingTable: true, selectedConnectionId: connectionId, selectedDatabase: database, currentView: "table" });

    const conn = get().activeConnections.find((c) => c.id === connectionId);
    const isSqlite = conn?.config.db_type === "sqlite";
    const sql = isSqlite
      ? `SELECT * FROM "${tableName}" LIMIT 100`
      : `SELECT * FROM \`${database}\`.\`${tableName}\` LIMIT 100`;
    const { queryTabs, activeTabId } = get();
    let tab = queryTabs.find(
      (t) => t.connectionId === connectionId && t.database === database && t.sql === sql,
    );
    if (!tab) {
      const id = crypto.randomUUID();
      tab = {
        id,
        title: tableName,
        sql,
        result: null,
        isExecuting: false,
        connectionId,
        database,
        edits: [],
        insertedRows: [],
        tableInfo: null,
        agentChatId: null,
      };
      set((state) => ({
        queryTabs: [...state.queryTabs, tab!],
        activeTabId: id,
      }));
    } else if (activeTabId !== tab.id) {
      set({ activeTabId: tab.id });
    }

    try {
      const info = await ipc.dbGetTableInfo(connectionId, database, tableName);
      set({ selectedTable: info });
      set((state) => ({
        queryTabs: state.queryTabs.map((t) =>
          t.id === tab!.id ? { ...t, tableInfo: info } : t,
        ),
      }));
    } catch {
      set({ selectedTable: null });
    }

    get().executeQuery(tab.id);
    set({ isLoadingTable: false });
  },

  addQueryTab: () => {
    const id = crypto.randomUUID();
    const tab: QueryTab = {
      id,
      title: "新查询",
      sql: "",
      result: null,
      isExecuting: false,
      connectionId: get().selectedConnectionId,
      database: get().selectedDatabase,
      edits: [],
      insertedRows: [],
      tableInfo: null,
      agentChatId: null,
    };
    set((state) => ({
      queryTabs: [...state.queryTabs, tab],
      activeTabId: id,
      currentView: "table",
    }));
    return id;
  },

  removeQueryTab: (tabId) => {
    set((state) => {
      const tabs = state.queryTabs.filter((t) => t.id !== tabId);
      return {
        queryTabs: tabs,
        activeTabId:
          state.activeTabId === tabId
            ? tabs[tabs.length - 1]?.id ?? null
            : state.activeTabId,
      };
    });
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId });
  },

  updateTabSql: (tabId, sql) => {
    set((state) => ({
      queryTabs: state.queryTabs.map((t) =>
        t.id === tabId ? { ...t, sql } : t,
      ),
    }));
  },

  executeQuery: async (tabId) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab || !tab.sql.trim() || !tab.connectionId) return;

    set((state) => ({
      queryTabs: state.queryTabs.map((t) =>
        t.id === tabId ? { ...t, isExecuting: true } : t,
      ),
    }));

    try {
      const result = await ipc.dbExecuteQuery(tab.connectionId, tab.sql, undefined, tab.database ?? undefined);
      if (tab.tableInfo && result.columns.length > 0) {
        const pkNames = new Set(
          tab.tableInfo.columns
            .filter((c) => c.is_primary_key)
            .map((c) => c.name),
        );
        const colTypes = new Map(
          tab.tableInfo.columns.map((c) => [c.name, c.data_type.toUpperCase()]),
        );
        result.columns = result.columns.map((col) => ({
          ...col,
          is_primary_key: pkNames.has(col.name),
          data_type: colTypes.get(col.name) ?? col.data_type,
        }));
      }

      // For non-SELECT statements on a table-bound tab, auto-refresh table data
      const isTableTab = tab.title !== "新查询" && tab.database;
      if (result.columns.length === 0 && isTableTab) {
        const conn = get().activeConnections.find((c) => c.id === tab.connectionId);
        const isSqlite = conn?.config.db_type === "sqlite";
        const refreshSql = isSqlite
          ? `SELECT * FROM "${tab.title}" LIMIT 100`
          : `SELECT * FROM \`${tab.database}\`.\`${tab.title}\` LIMIT 100`;
        try {
          const refreshResult = await ipc.dbExecuteQuery(tab.connectionId, refreshSql, undefined, tab.database ?? undefined);
          if (tab.tableInfo) {
            const pkNames = new Set(
              tab.tableInfo.columns
                .filter((c) => c.is_primary_key)
                .map((c) => c.name),
            );
            const colTypes = new Map(
              tab.tableInfo.columns.map((c) => [c.name, c.data_type.toUpperCase()]),
            );
            refreshResult.columns = refreshResult.columns.map((col) => ({
              ...col,
              is_primary_key: pkNames.has(col.name),
              data_type: colTypes.get(col.name) ?? col.data_type,
            }));
          }
          // Carry over the original DDL/DML execution result
          refreshResult.message = result.message;
          refreshResult.affected_rows = result.affected_rows;
          set((state) => ({
            queryTabs: state.queryTabs.map((t) =>
              t.id === tabId ? { ...t, result: refreshResult, isExecuting: false } : t,
            ),
          }));
        } catch {
          // Refresh failed — keep showing previous table data if any
          set((state) => ({
            queryTabs: state.queryTabs.map((t) =>
              t.id === tabId ? { ...t, isExecuting: false } : t,
            ),
          }));
        }
      } else {
        set((state) => ({
          queryTabs: state.queryTabs.map((t) =>
            t.id === tabId ? { ...t, result, isExecuting: false } : t,
          ),
        }));
      }
    } catch (e) {
      // Don't overwrite table data with error result — keep previous table visible
      // Error info is available in the message tab
      set((state) => ({
        queryTabs: state.queryTabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                isExecuting: false,
                result: t.result
                  ? { ...t.result, message: String(e) }
                  : {
                      columns: [],
                      rows: [],
                      affected_rows: 0,
                      execution_time_ms: 0,
                      message: String(e),
                    },
              }
            : t,
        ),
      }));
    }
  },

  setCurrentView: (view) => {
    set({ currentView: view });
  },

  setSelectedConnectionId: (id) => {
    set({ selectedConnectionId: id });
  },

  setSelectedDatabase: (db) => {
    set({ selectedDatabase: db });
  },

  setNewConnectionDialogOpen: (open) => {
    set({ newConnectionDialogOpen: open });
  },

  setEditConnectionConfig: (config) => {
    set({ editConnectionConfig: config });
  },

  setConnectError: (error) => {
    set({ connectError: error });
  },

  setAgentStreaming: (streaming) => {
    set({ agentStreaming: streaming });
  },

  refreshServerStats: async (connectionId) => {
    try {
      const stats = await ipc.dbGetServerStats(connectionId);
      set({ serverStats: stats });
    } catch {
      set({ serverStats: null });
    }
  },

  refreshProcesses: async (connectionId) => {
    try {
      const processes = await ipc.dbGetProcesses(connectionId);
      set({ processes });
    } catch {
      set({ processes: [] });
    }
  },

  refreshUsers: async (connectionId) => {
    try {
      const users = await ipc.dbGetUsers(connectionId);
      set({ users });
    } catch {
      set({ users: [] });
    }
  },

  killProcess: async (connectionId, processId) => {
    try {
      await ipc.dbKillProcess(connectionId, processId);
      await get().refreshProcesses(connectionId);
    } catch {
      // ignore
    }
  },

  updateCell: (tabId, rowIdx, colIdx, newValue) => {
    set((state) => ({
      queryTabs: state.queryTabs.map((t) => {
        if (t.id !== tabId || !t.result) return t;
        const oldValue = t.result.rows[rowIdx][colIdx];
        const existing = t.edits.find(
          (e) => e.rowIdx === rowIdx && e.colIdx === colIdx,
        );
        const edits = existing
          ? t.edits.map((e) =>
              e.rowIdx === rowIdx && e.colIdx === colIdx
                ? { ...e, newValue }
                : e,
            )
          : [...t.edits, { rowIdx, colIdx, oldValue, newValue }];
        return { ...t, edits };
      }),
    }));
  },

  revertCell: (tabId, rowIdx, colIdx) => {
    set((state) => ({
      queryTabs: state.queryTabs.map((t) => {
        if (t.id !== tabId) return t;
        return {
          ...t,
          edits: t.edits.filter(
            (e) => !(e.rowIdx === rowIdx && e.colIdx === colIdx),
          ),
        };
      }),
    }));
  },

  revertAllEdits: (tabId) => {
    set((state) => ({
      queryTabs: state.queryTabs.map((t) => {
        if (t.id !== tabId || !t.result) return t;
        // 移除所有前端插入的行
        const insertedSet = new Set(t.insertedRows);
        const newRows = t.result.rows.filter((_, i) => !insertedSet.has(i));
        return { ...t, edits: [], insertedRows: [], result: { ...t.result, rows: newRows } };
      }),
    }));
  },

  saveEdits: async (tabId) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab || !tab.connectionId || !tab.result || tab.edits.length === 0) return;

    const conn = get().activeConnections.find((c) => c.id === tab.connectionId);
    const isSqlite = conn?.config.db_type === "sqlite";

    let pkCols: { name: string; idx: number }[] = [];
    const colTypeMap = new Map<string, string>();

    if (tab.result.columns.some((c) => c.is_primary_key)) {
      pkCols = tab.result.columns
        .map((c, i) => ({ name: c.name, idx: i }))
        .filter((c) => tab.result!.columns[c.idx].is_primary_key);
    }

    if (pkCols.length === 0 && tab.connectionId && tab.database) {
      try {
        const pkSql = isSqlite
          ? `PRAGMA table_info("${tab.title}")`
          : `SHOW COLUMNS FROM \`${tab.database}\`.\`${tab.title}\` WHERE \`Key\` = 'PRI'`;
        const pkResult = await ipc.dbExecuteQuery(tab.connectionId, pkSql, undefined, tab.database ?? undefined);
        const pkNames = new Set<string>();
        for (const row of pkResult.rows) {
          const nameCell = isSqlite ? row[1] : row[0];
          if (nameCell.type !== "null") pkNames.add(displayCellValue(nameCell));
        }
        for (let i = 0; i < tab.result.columns.length; i++) {
          if (pkNames.has(tab.result.columns[i].name)) {
            pkCols.push({ name: tab.result.columns[i].name, idx: i });
          }
        }
      } catch (e) {
        console.error("[saveEdits] Failed to get primary key columns:", e);
      }
    }

    if (tab.connectionId && tab.database) {
      try {
        const colSql = isSqlite
          ? `PRAGMA table_info("${tab.title}")`
          : `SHOW COLUMNS FROM \`${tab.database}\`.\`${tab.title}\``;
        const colResult = await ipc.dbExecuteQuery(tab.connectionId, colSql, undefined, tab.database ?? undefined);
        for (const row of colResult.rows) {
          const nameCell = isSqlite ? row[1] : row[0];
          const typeCell = isSqlite ? row[2] : row[1];
          if (nameCell.type === "null" || typeCell.type === "null") continue;
          const name = displayCellValue(nameCell);
          const typeStr = displayCellValue(typeCell).toUpperCase();
          colTypeMap.set(name, typeStr);
        }
      } catch (e) {
        console.error("[saveEdits] Failed to get column types:", e);
      }
    }
    for (const c of tab.result.columns) {
      if (!colTypeMap.has(c.name)) {
        colTypeMap.set(c.name, c.data_type.toUpperCase());
      }
    }

    const numericTypes = new Set([
      "INT", "INTEGER", "TINYINT", "SMALLINT", "MEDIUMINT", "BIGINT",
      "FLOAT", "DOUBLE", "DECIMAL", "NUMERIC", "REAL",
    ]);
    const isNumericCol = (colIdx: number) => {
      const col = tab.result!.columns[colIdx];
      if (!col) return false;
      const dt = colTypeMap.get(col.name) ?? col.data_type.toUpperCase();
      return numericTypes.has(dt) || dt.startsWith("INT") || dt.startsWith("DECIMAL") || dt.startsWith("FLOAT") || dt.startsWith("DOUBLE");
    };

    const formatValue = (val: string, colIdx: number) => {
      if (val === NULL_MARKER) return "NULL";
      if (val === DEFAULT_MARKER) return "DEFAULT";
      if (val === "") return "''";
      if (isNumericCol(colIdx) && /^-?\d+(\.\d+)?$/.test(val)) return val;
      return `'${val.replace(/'/g, "''")}'`;
    };

    const formatCellValue = (cell: CellValue) => {
      if (cell.type === "null") return "NULL";
      if (cell.type === "bool") return cell.value ? "1" : "0";
      if (cell.type === "integer" || cell.type === "float") {
        return String(cell.value);
      }
      if (cell.type === "blob") {
        const hex = cell.value;
        return isSqlite ? `X'${hex}'` : `UNHEX('${hex}')`;
      }
      return `'${String(cell.value).replace(/'/g, "''")}'`;
    };

    const rowEdits = new Map<number, CellEdit[]>();
    for (const edit of tab.edits) {
      const list = rowEdits.get(edit.rowIdx) ?? [];
      list.push(edit);
      rowEdits.set(edit.rowIdx, list);
    }

    try {
      const insertedRowSet = new Set(tab.insertedRows);

      for (const [rowIdx, edits] of rowEdits) {
        const row = tab.result.rows[rowIdx];

        if (insertedRowSet.has(rowIdx)) {
          // 新插入行：执行 INSERT
          const colParts: string[] = [];
          const valParts: string[] = [];
          for (const e of edits) {
            const colName = tab.result!.columns[e.colIdx].name;
            const val = formatValue(e.newValue, e.colIdx);
            colParts.push(isSqlite ? `"${colName}"` : `\`${colName}\``);
            valParts.push(val);
          }
          const tableName = tab.title;
          const sql = isSqlite
            ? `INSERT INTO "${tableName}" (${colParts.join(", ")}) VALUES (${valParts.join(", ")})`
            : `INSERT INTO \`${tab.database}\`.\`${tableName}\` (${colParts.join(", ")}) VALUES (${valParts.join(", ")})`;
          await ipc.dbExecuteQuery(tab.connectionId, sql, undefined, tab.database ?? undefined);
          continue;
        }

        // 已存在行：执行 UPDATE
        const setClauses = edits.map((e) => {
          const colName = tab.result!.columns[e.colIdx].name;
          const val = formatValue(e.newValue, e.colIdx);
          return isSqlite
            ? `"${colName}" = ${val}`
            : `\`${colName}\` = ${val}`;
        });

        let whereClause: string;
        if (pkCols.length > 0) {
          whereClause = pkCols
            .map((pk) => {
              const cell = row[pk.idx];
              const val = formatCellValue(cell);
              const q = isSqlite ? `"${pk.name}"` : `\`${pk.name}\``;
              return cell.type === "null" ? `${q} IS NULL` : `${q} = ${val}`;
            })
            .join(" AND ");
        } else {
          whereClause = tab.result.columns
            .map((col, i) => {
              const cell = row[i];
              const val = formatCellValue(cell);
              const q = isSqlite ? `"${col.name}"` : `\`${col.name}\``;
              return cell.type === "null" ? `${q} IS NULL` : `${q} = ${val}`;
            })
            .join(" AND ");
        }

        const tableName = tab.title;
        const setStr = setClauses.join(", ");
        const sql = isSqlite
          ? `UPDATE "${tableName}" SET ${setStr} WHERE ${whereClause}`
          : `UPDATE \`${tab.database}\`.\`${tableName}\` SET ${setStr} WHERE ${whereClause}`;

        const updateResult = await ipc.dbExecuteQuery(tab.connectionId, sql, undefined, tab.database ?? undefined);
        if (updateResult.affected_rows === 0) {
          throw new Error(`UPDATE 未影响任何行，可能 WHERE 条件未匹配到数据。SQL: ${sql}`);
        }
      }

      set((state) => ({
        queryTabs: state.queryTabs.map((t) =>
          t.id === tabId ? { ...t, edits: [], insertedRows: [] } : t,
        ),
      }));

      await get().executeQuery(tabId);
    } catch (e) {
      set((state) => ({
        queryTabs: state.queryTabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                result: t.result
                  ? { ...t.result, message: `保存失败: ${String(e)}` }
                  : {
                      columns: [],
                      rows: [],
                      affected_rows: 0,
                      execution_time_ms: 0,
                      message: `保存失败: ${String(e)}`,
                    },
              }
            : t,
        ),
      }));
    }
  },

  insertRow: (tabId) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab || !tab.result || !tab.database || tab.title === "新查询") return;

    const newRowIdx = tab.result.rows.length;
    const nullCells: CellValue[] = tab.result.columns.map(() => ({ type: "null" as const }));

    set((state) => ({
      queryTabs: state.queryTabs.map((t) =>
        t.id === tabId && t.result
          ? {
              ...t,
              result: {
                ...t.result,
                rows: [...t.result.rows, nullCells],
              },
              insertedRows: [...t.insertedRows, newRowIdx],
            }
          : t,
      ),
    }));
  },

  deleteRow: async (tabId, rowIdx) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab || !tab.connectionId || !tab.database || !tab.result) return;

    // 前端插入的未保存行：直接从前端移除
    if (tab.insertedRows.includes(rowIdx)) {
      set((state) => ({
        queryTabs: state.queryTabs.map((t) => {
          if (t.id !== tabId || !t.result) return t;
          const newRows = t.result.rows.filter((_, i) => i !== rowIdx);
          const newInsertedRows = t.insertedRows
            .filter((i) => i !== rowIdx)
            .map((i) => (i > rowIdx ? i - 1 : i));
          const newEdits = t.edits
            .filter((e) => e.rowIdx !== rowIdx)
            .map((e) => (e.rowIdx > rowIdx ? { ...e, rowIdx: e.rowIdx - 1 } : e));
          return {
            ...t,
            result: { ...t.result, rows: newRows },
            insertedRows: newInsertedRows,
            edits: newEdits,
          };
        }),
      }));
      return;
    }

    const conn = get().activeConnections.find((c) => c.id === tab.connectionId);
    const isSqlite = conn?.config.db_type === "sqlite";
    const tableName = tab.title;
    const row = tab.result.rows[rowIdx];
    if (!row) return;

    const formatCellValue = (cell: CellValue) => {
      if (cell.type === "null") return "NULL";
      if (cell.type === "bool") return cell.value ? "1" : "0";
      if (cell.type === "integer" || cell.type === "float") {
        return String(cell.value);
      }
      if (cell.type === "blob") {
        const hex = cell.value;
        return isSqlite ? `X'${hex}'` : `UNHEX('${hex}')`;
      }
      return `'${String(cell.value).replace(/'/g, "''")}'`;
    };

    let pkCols: { name: string; idx: number }[] = [];
    if (tab.result.columns.some((c) => c.is_primary_key)) {
      pkCols = tab.result.columns
        .map((c, i) => ({ name: c.name, idx: i }))
        .filter((c) => tab.result!.columns[c.idx].is_primary_key);
    }

    if (pkCols.length === 0 && tab.connectionId && tab.database) {
      try {
        const pkSql = isSqlite
          ? `PRAGMA table_info("${tab.title}")`
          : `SHOW COLUMNS FROM \`${tab.database}\`.\`${tab.title}\` WHERE \`Key\` = 'PRI'`;
        const pkResult = await ipc.dbExecuteQuery(tab.connectionId, pkSql, undefined, tab.database ?? undefined);
        const pkNames = new Set<string>();
        for (const r of pkResult.rows) {
          const nameCell = isSqlite ? r[1] : r[0];
          if (nameCell.type !== "null") pkNames.add(displayCellValue(nameCell));
        }
        for (let i = 0; i < tab.result.columns.length; i++) {
          if (pkNames.has(tab.result.columns[i].name)) {
            pkCols.push({ name: tab.result.columns[i].name, idx: i });
          }
        }
      } catch (e) {
        console.error("[deleteRow] Failed to get primary key columns:", e);
      }
    }

    let whereClause: string;
    if (pkCols.length > 0) {
      whereClause = pkCols
        .map((pk) => {
          const cell = row[pk.idx];
          const val = formatCellValue(cell);
          const q = isSqlite ? `"${pk.name}"` : `\`${pk.name}\``;
          return cell.type === "null" ? `${q} IS NULL` : `${q} = ${val}`;
        })
        .join(" AND ");
    } else {
      whereClause = tab.result.columns
        .map((col, i) => {
          const cell = row[i];
          const val = formatCellValue(cell);
          const q = isSqlite ? `"${col.name}"` : `\`${col.name}\``;
          return cell.type === "null" ? `${q} IS NULL` : `${q} = ${val}`;
        })
        .join(" AND ");
    }

    const sql = isSqlite
      ? `DELETE FROM "${tableName}" WHERE ${whereClause}`
      : `DELETE FROM \`${tab.database}\`.\`${tableName}\` WHERE ${whereClause}`;

    try {
      const result = await ipc.dbExecuteQuery(tab.connectionId, sql, undefined, tab.database ?? undefined);
      if (result.affected_rows === 0) {
        throw new Error(`DELETE 未影响任何行，可能 WHERE 条件未匹配到数据。SQL: ${sql}`);
      }
      await get().executeQuery(tabId);
    } catch (e) {
      set((state) => ({
        queryTabs: state.queryTabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                result: t.result
                  ? { ...t.result, message: `删除失败: ${String(e)}` }
                  : {
                      columns: [],
                      rows: [],
                      affected_rows: 0,
                      execution_time_ms: 0,
                      message: `删除失败: ${String(e)}`,
                    },
              }
            : t,
        ),
      }));
    }
  },
}));
