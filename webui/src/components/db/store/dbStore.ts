import { create } from "zustand";
import type {
  DbConnectionConfig,
  ConnectionInfo,
  DatabaseObject,
  QueryTab,
  CellValue,
  TableInfo,
  ServerStats,
  ProcessInfo,
  UserInfo,
  DbViewType,
  TableBrowse,
} from "../types";
import { DEFAULT_MARKER, NULL_MARKER } from "../types";
import * as ipc from "../ipc";
import { DEFAULT_BROWSE, buildBrowseSql, buildRowMutation, canEditTable, hasPendingEdits } from "../table-sql";
import { singleQueryStatement } from "../query-sql";

const treeRequests = new Map<string, number>();

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
  objectScope: { connectionId: string; database: string; objectType: "table" | "view" } | null;

  setAgentStreaming: (streaming: boolean) => void;

  loadSavedConnections: () => Promise<void>;
  saveConnection: (config: DbConnectionConfig) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  connect: (config: DbConnectionConfig) => Promise<void>;
  disconnect: (connectionId: string) => Promise<void>;
  testConnection: (config: DbConnectionConfig) => Promise<string>;
  refreshTree: (connectionId: string) => Promise<void>;
  openDatabase: (connectionId: string, database: string, objectType?: "table" | "view") => void;
  selectTable: (connectionId: string, database: string, tableName: string, pinned?: boolean, objectType?: "table" | "view") => Promise<void>;
  pinTab: (tabId: string) => void;
  patchTab: (tabId: string, patch: Partial<QueryTab>) => void;
  browseTable: (tabId: string, patch: Partial<TableBrowse>) => Promise<void>;
  setQueryTarget: (tabId: string, connectionId: string, database: string | null) => void;
  addQueryTab: (connectionId?: string, database?: string | null) => string;
  removeQueryTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabSql: (tabId: string, sql: string) => void;
  executeQuery: (tabId: string, sql?: string) => Promise<void>;
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
  currentView: "objects",
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
  objectScope: null,

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
    treeRequests.set(connectionId, (treeRequests.get(connectionId) ?? 0) + 1);
    try {
      await ipc.dbDisconnect(connectionId);
      set((state) => {
        const { [connectionId]: _, ...restTree } = state.connectionTree;
        return {
          activeConnections: state.activeConnections.filter(
            (c) => c.id !== connectionId,
          ),
          connectionTree: restTree,
          objectScope: state.objectScope?.connectionId === connectionId ? null : state.objectScope,
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
    const request = (treeRequests.get(connectionId) ?? 0) + 1;
    treeRequests.set(connectionId, request);
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
      if (treeRequests.get(connectionId) === request && get().activeConnections.some((c) => c.id === connectionId)) {
        set((state) => ({ connectionTree: { ...state.connectionTree, [connectionId]: tree } }));
      }
    } catch (error) {
      if (treeRequests.get(connectionId) === request) set({ connectError: `刷新连接失败：${String(error)}` });
    } finally {
      set({ isLoadingTree: false });
    }
  },

  openDatabase: (connectionId, database, objectType = "table") => {
    set({ objectScope: { connectionId, database, objectType }, selectedConnectionId: connectionId,
      selectedDatabase: database, selectedTable: null, currentView: "objects" });
  },

  patchTab: (tabId, patch) => {
    set((state) => ({ queryTabs: state.queryTabs.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab) }));
  },

  pinTab: (tabId) => get().patchTab(tabId, { preview: false }),

  selectTable: async (connectionId, database, tableName, pinned = false, objectType = "table") => {
    const existing = get().queryTabs.find((tab) =>
      tab.kind === "table" && tab.connectionId === connectionId && tab.database === database && tab.tableName === tableName);
    if (existing) {
      if (pinned) get().pinTab(existing.id);
      get().setActiveTab(existing.id);
      return;
    }
    const tab: QueryTab = {
      id: crypto.randomUUID(), kind: "table", tableName, objectType, preview: !pinned,
      title: tableName, sql: "", result: null, connectionId, database, edits: [], insertedRows: [],
      deletedRows: [], selectedRows: [], tableInfo: null, agentChatId: null, isExecuting: false,
      browse: { ...DEFAULT_BROWSE, filters: [] }, error: null, isLoadingMetadata: true,
    };
    set((state) => ({
      queryTabs: [...state.queryTabs.filter((t) => !t.preview || hasPendingEdits(t) || t.isExecuting || t.isSaving), tab],
      activeTabId: tab.id, currentView: "table", selectedConnectionId: connectionId,
      selectedDatabase: database, selectedTable: null, isLoadingTable: true,
      objectScope: { connectionId, database, objectType },
    }));
    try {
      const info = await ipc.dbGetTableInfo(connectionId, database, tableName);
      get().patchTab(tab.id, { tableInfo: info, isLoadingMetadata: false });
      if (get().activeTabId === tab.id) set({ selectedTable: info });
    } catch (error) {
      // Data remains browsable if metadata access is denied, but editing stays disabled.
      get().patchTab(tab.id, { metadataError: `无法读取表结构：${String(error)}`, isLoadingMetadata: false });
    }
    await get().executeQuery(tab.id);
    set({ isLoadingTable: false });
  },

  addQueryTab: (connectionId, database) => {
    const id = crypto.randomUUID();
    const active = get().currentView === "table" ? get().queryTabs.find((t) => t.id === get().activeTabId) : undefined;
    const targetId = connectionId ?? active?.connectionId ?? get().selectedConnectionId;
    const targetDatabase = connectionId !== undefined ? database ?? null : active?.database ?? get().selectedDatabase;
    const tab: QueryTab = {
      id, kind: "query", title: "新查询", sql: "", result: null, isExecuting: false,
      connectionId: targetId, database: targetDatabase,
      edits: [], insertedRows: [], tableInfo: null, agentChatId: null, error: null,
    };
    set((state) => ({ queryTabs: [...state.queryTabs, tab], activeTabId: id, currentView: "table", selectedTable: null, selectedConnectionId: targetId, selectedDatabase: targetDatabase }));
    return id;
  },

  removeQueryTab: (tabId) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab || hasPendingEdits(tab) || tab.isSaving || tab.isExecuting) return;
    const tabs = get().queryTabs.filter((t) => t.id !== tabId);
    set({ queryTabs: tabs });
    if (get().activeTabId === tabId) {
      if (tabs.length) get().setActiveTab(tabs[tabs.length - 1].id);
      else set({ activeTabId: null, currentView: "objects", selectedTable: null });
    }
  },

  setActiveTab: (tabId) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab) return;
    set({ activeTabId: tabId, currentView: "table", selectedConnectionId: tab.connectionId,
      selectedDatabase: tab.database, selectedTable: tab.tableInfo,
      ...(tab.connectionId && tab.database ? { objectScope: { connectionId: tab.connectionId, database: tab.database, objectType: tab.objectType ?? "table" } } : {}) });
  },

  setQueryTarget: (tabId, connectionId, database) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab || tab.kind === "table" || tab.isExecuting) return;
    get().patchTab(tabId, { connectionId, database, result: null, error: null });
    if (get().activeTabId === tabId) set({ selectedConnectionId: connectionId, selectedDatabase: database });
  },

  updateTabSql: (tabId, sql) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (tab?.kind === "table") {
      // AI drafts and generated SQL open a query; they never change a table browser's identity.
      const id = get().addQueryTab();
      get().patchTab(id, { sql, connectionId: tab.connectionId, database: tab.database });
      return;
    }
    get().patchTab(tabId, { sql, preview: false });
  },

  browseTable: async (tabId, patch) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab || tab.kind !== "table" || tab.isExecuting || tab.isSaving || hasPendingEdits(tab)) return;
    get().patchTab(tabId, { browse: { ...(tab.browse ?? DEFAULT_BROWSE), ...patch }, selectedRows: [] });
    await get().executeQuery(tabId);
    if (get().queryTabs.find((t) => t.id === tabId)?.error) {
      get().patchTab(tabId, { browse: tab.browse, sql: tab.sql, hasMore: tab.hasMore });
    }
  },

  executeQuery: async (tabId, sqlOverride) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab || !tab.connectionId || tab.isExecuting || tab.isSaving || hasPendingEdits(tab)) return;
    const conn = get().activeConnections.find((c) => c.id === tab.connectionId);
    if (!conn) { get().patchTab(tabId, { error: "连接已断开，请重新连接后执行。" }); return; }
    const sqlite = conn.config.db_type === "sqlite";
    let sql: string;
    try {
      if (tab.kind !== "table" && !(sqlOverride ?? tab.sql).trim()) return;
      sql = tab.kind === "table" ? buildBrowseSql(tab, sqlite) : singleQueryStatement(sqlOverride ?? tab.sql, sqlite);
    } catch (error) {
      get().patchTab(tabId, { error: String(error) });
      return;
    }
    if (!sql.trim()) return;
    get().patchTab(tabId, { isExecuting: true, error: null, lastExecutedSql: sql,
      ...(tab.kind === "table" ? { sql } : {}) });
    try {
      const result = await ipc.dbExecuteQuery(tab.connectionId, sql, tab.kind === "table" ? (tab.browse?.pageSize ?? 100) + 1 : undefined, tab.database ?? undefined);
      const pageSize = tab.browse?.pageSize ?? 100;
      const hasMore = tab.kind === "table" && result.rows.length > pageSize;
      if (tab.kind === "table") {
        result.rows = result.rows.slice(0, pageSize);
        if (!result.columns.length && tab.tableInfo) result.columns = tab.tableInfo.columns.map((col) => ({
          name: col.name, data_type: col.data_type, nullable: col.nullable, is_primary_key: col.is_primary_key, is_auto_increment: col.is_auto_increment,
        }));
        result.columns = result.columns.map((col) => {
          const info = tab.tableInfo?.columns.find((c) => c.name === col.name);
          return info ? { ...col, is_primary_key: info.is_primary_key, is_auto_increment: info.is_auto_increment, data_type: info.data_type } : col;
        });
      }
      get().patchTab(tabId, { result, hasMore, isExecuting: false, selectedRows: [] });
    } catch (error) {
      get().patchTab(tabId, { isExecuting: false, error: String(error) });
    }
  },

  setCurrentView: (view) => set({ currentView: view }),
  setSelectedConnectionId: (id) => set({ selectedConnectionId: id }),
  setSelectedDatabase: (db) => set({ selectedDatabase: db }),
  setNewConnectionDialogOpen: (open) => set({ newConnectionDialogOpen: open }),
  setEditConnectionConfig: (config) => set({ editConnectionConfig: config }),
  setConnectError: (error) => set({ connectError: error }),
  setAgentStreaming: (streaming) => set({ agentStreaming: streaming }),

  refreshServerStats: async (connectionId) => {
    try { set({ serverStats: await ipc.dbGetServerStats(connectionId) }); }
    catch { set({ serverStats: null }); }
  },
  refreshProcesses: async (connectionId) => {
    try { set({ processes: await ipc.dbGetProcesses(connectionId) }); }
    catch { set({ processes: [] }); }
  },
  refreshUsers: async (connectionId) => {
    try { set({ users: await ipc.dbGetUsers(connectionId) }); }
    catch { set({ users: [] }); }
  },
  killProcess: async (connectionId, processId) => {
    try { await ipc.dbKillProcess(connectionId, processId); await get().refreshProcesses(connectionId); }
    catch (error) { set({ connectError: String(error) }); }
  },

  updateCell: (tabId, rowIdx, colIdx, newValue) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab?.result || !canEditTable(tab) || tab.isSaving || tab.isExecuting || tab.deletedRows?.includes(rowIdx)) return;
    const oldValue = tab.result.rows[rowIdx]?.[colIdx];
    if (!oldValue || oldValue.type === "blob") return;
    const edits = tab.edits.filter((e) => e.rowIdx !== rowIdx || e.colIdx !== colIdx);
    edits.push({ rowIdx, colIdx, oldValue, newValue });
    get().patchTab(tabId, { edits, preview: false });
  },

  revertCell: (tabId, rowIdx, colIdx) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab || tab.isSaving) return;
    get().patchTab(tabId, { edits: tab.edits.filter((e) => e.rowIdx !== rowIdx || e.colIdx !== colIdx) });
  },

  revertAllEdits: (tabId) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab?.result || tab.isSaving) return;
    get().patchTab(tabId, {
      result: { ...tab.result, rows: tab.result.rows.filter((_, i) => !tab.insertedRows.includes(i)) },
      edits: [], insertedRows: [], deletedRows: [], selectedRows: [], error: null,
    });
  },

  saveEdits: async (tabId) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab?.connectionId || !tab.result || !canEditTable(tab) || !hasPendingEdits(tab) || tab.isSaving || tab.isExecuting) return;
    const conn = get().activeConnections.find((c) => c.id === tab.connectionId);
    if (!conn) { get().patchTab(tabId, { error: "连接已断开，修改尚未保存。" }); return; }
    const sqlite = conn.config.db_type === "sqlite";
    const rows = [...new Set([...tab.edits.map((e) => e.rowIdx), ...tab.insertedRows, ...(tab.deletedRows ?? [])])].sort((a, b) => a - b);
    get().patchTab(tabId, { isSaving: true, error: null });
    const completed = new Set<number>();
    let error: string | null = null;
    for (const rowIdx of rows) {
      try {
        const sql = buildRowMutation(tab, rowIdx, sqlite);
        const result = await ipc.dbExecuteQuery(tab.connectionId, sql, undefined, tab.database ?? undefined);
        if (!tab.insertedRows.includes(rowIdx) && result.affected_rows === 0) {
          throw new Error("记录已变化或不存在，请核对后重试。");
        }
        completed.add(rowIdx);
      } catch (e) {
        error = `保存失败（第 ${rowIdx + 1} 行）：${String(e)}。已完成 ${completed.size} 行，未完成的修改已保留。`;
        break;
      }
    }
    // Remove successful inserts/deletes from the displayed snapshot so retries cannot duplicate them.
    const removed = new Set([...completed].filter((i) => tab.insertedRows.includes(i) || tab.deletedRows?.includes(i)));
    const remap = (i: number) => i - [...removed].filter((r) => r < i).length;
    const updatedRows = tab.result.rows.map((row, i) => {
      if (!completed.has(i)) return row;
      return row.map((cell, j): CellValue => {
        const edit = tab.edits.find((e) => e.rowIdx === i && e.colIdx === j);
        if (!edit) return cell;
        if (edit.newValue === NULL_MARKER || edit.newValue === DEFAULT_MARKER) return { type: "null" };
        return { type: "text", value: edit.newValue };
      });
    }).filter((_, i) => !removed.has(i));
    get().patchTab(tabId, {
      isSaving: false, error, result: { ...tab.result, rows: updatedRows },
      edits: tab.edits.filter((e) => !completed.has(e.rowIdx)).map((e) => ({ ...e, rowIdx: remap(e.rowIdx) })),
      insertedRows: tab.insertedRows.filter((i) => !completed.has(i)).map(remap),
      deletedRows: (tab.deletedRows ?? []).filter((i) => !completed.has(i)).map(remap),
      selectedRows: [],
    });
    if (!error) {
      await get().executeQuery(tabId);
      await get().refreshTree(tab.connectionId);
    }
  },

  insertRow: (tabId) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab?.result || !canEditTable(tab) || tab.isSaving || tab.isExecuting) return;
    const idx = tab.result.rows.length;
    get().patchTab(tabId, { preview: false,
      result: { ...tab.result, rows: [...tab.result.rows, tab.result.columns.map((): CellValue => ({ type: "null" }))] },
      insertedRows: [...tab.insertedRows, idx], selectedRows: [idx],
    });
  },

  deleteRow: async (tabId, rowIdx) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab?.result || !canEditTable(tab) || tab.isSaving || tab.isExecuting) return;
    if (tab.insertedRows.includes(rowIdx)) {
      const remap = (i: number) => i > rowIdx ? i - 1 : i;
      get().patchTab(tabId, {
        result: { ...tab.result, rows: tab.result.rows.filter((_, i) => i !== rowIdx) },
        insertedRows: tab.insertedRows.filter((i) => i !== rowIdx).map(remap),
        edits: tab.edits.filter((e) => e.rowIdx !== rowIdx).map((e) => ({ ...e, rowIdx: remap(e.rowIdx) })),
        deletedRows: tab.deletedRows?.map(remap), selectedRows: [],
      });
      return;
    }
    get().patchTab(tabId, { preview: false, deletedRows: [...new Set([...(tab.deletedRows ?? []), rowIdx])] });
  },
}));
