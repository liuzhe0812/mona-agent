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
  StructureColumn,
  StructureDraft,
  StructureListItem,
  StructureListSection,
  SavedQuery,
} from "../types";
import { DEFAULT_MARKER, NULL_MARKER, displayCellValue } from "../types";
import * as ipc from "../ipc";
import { DEFAULT_BROWSE, buildBrowseSql, buildRowMutation, canEditTable, hasPendingEdits } from "../table-sql";
import { singleQueryStatement } from "../query-sql";
import { structureColumn, structureForeignKey, structureIndex, structureTrigger, tableAdvanced, isStructureColumnReadOnly } from "../structure-edit";

const treeRequests = new Map<string, number>();

function savedQueryObjects(queries: SavedQuery[], connectionId: string, database: string): DatabaseObject[] {
  return queries
    .filter((query) => query.connection_id === connectionId && query.database === database)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((query) => ({
      id: query.id,
      name: query.name,
      schema: database,
      object_type: "query" as const,
      children: [],
    }));
}

function syncSavedQueryFolders(
  tree: DatabaseObject[],
  queries: SavedQuery[],
  connectionId: string,
): DatabaseObject[] {
  return tree.map((database) => ({
    ...database,
    children: database.children.map((folder) => folder.name === "查询" ? {
      ...folder,
      children: savedQueryObjects(queries, connectionId, database.name),
    } : folder),
  }));
}

function schemaSaving(tabs: QueryTab[], tab: QueryTab): boolean {
  return tabs.some((item) => item.kind === "structure" && item.isSaving && item.connectionId === tab.connectionId && item.database === tab.database && item.tableName === tab.tableName);
}

interface DbState {
  savedConnections: DbConnectionConfig[];
  activeConnections: ConnectionInfo[];
  connectionTree: Record<string, DatabaseObject[]>;
  connectionDatabases: Record<string, string[]>;
  savedQueries: SavedQuery[];
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
  saveQuery: (tabId: string, name: string, sql: string) => Promise<void>;
  openSavedQuery: (queryId: string) => void;
  saveConnection: (config: DbConnectionConfig) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  connect: (config: DbConnectionConfig) => Promise<void>;
  disconnect: (connectionId: string) => Promise<void>;
  testConnection: (config: DbConnectionConfig) => Promise<string>;
  refreshTree: (connectionId: string) => Promise<void>;
  openDatabase: (connectionId: string, database: string, objectType?: "table" | "view") => void;
  openTableStructure: (connectionId: string, database: string, table: string, section?: StructureDraft["section"]) => Promise<void>;
  updateStructureColumn: (tabId: string, index: number, patch: Partial<StructureColumn>) => void;
  addStructureColumn: (tabId: string) => void;
  removeStructureColumn: (tabId: string, index: number) => void;
  insertStructureItem: (tabId: string, section: StructureListSection, index?: number, source?: StructureListItem) => void;
  updateStructureItem: (tabId: string, section: StructureListSection, index: number, patch: Partial<StructureListItem>) => void;
  removeStructureItem: (tabId: string, section: StructureListSection, index: number) => void;
  moveStructureItem: (tabId: string, section: StructureListSection, from: number, to: number) => void;
  resetStructureEdits: (tabId: string) => void;
  refreshStructure: (tabId: string) => Promise<void>;
  previewStructure: (tabId: string) => Promise<string[]>;
  applyStructure: (tabId: string) => Promise<void>;
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
  cloneRow: (tabId: string, rowIdx: number) => boolean;
  deleteRow: (tabId: string, rowIdx: number) => Promise<void>;
}

export const useDbStore = create<DbState>((set, get) => ({
  savedConnections: [],
  activeConnections: [],
  connectionTree: {},
  connectionDatabases: {},
  savedQueries: [],
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
    const [savedConnections, savedQueries] = await Promise.all([
      ipc.dbLoadConnections().catch(() => []),
      ipc.dbLoadSavedQueries().catch(() => []),
    ]);
    set({ savedConnections, savedQueries });
  },

  saveQuery: async (tabId, name, sql) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    const trimmedName = name.trim();
    if (!tab || tab.kind === "table" || tab.kind === "structure" || !tab.connectionId || !tab.database) {
      throw new Error("请先选择查询使用的连接和数据库。");
    }
    if (!trimmedName || !sql.trim()) throw new Error("查询名称和 SQL 不能为空。");
    const duplicate = get().savedQueries.find((query) =>
      query.id !== tab.savedQueryId && query.connection_id === tab.connectionId
      && query.database === tab.database && query.name === trimmedName);
    if (duplicate) throw new Error(`数据库“${tab.database}”中已有同名查询。`);
    const query: SavedQuery = {
      id: tab.savedQueryId ?? crypto.randomUUID(),
      name: trimmedName,
      connection_id: tab.connectionId,
      database: tab.database,
      sql,
    };
    get().patchTab(tabId, { isSaving: true, error: null });
    try {
      await ipc.dbSaveQuery(query);
      set((state) => {
        const savedQueries = state.savedQueries.some((item) => item.id === query.id)
          ? state.savedQueries.map((item) => item.id === query.id ? query : item)
          : [...state.savedQueries, query];
        return {
          savedQueries,
          queryTabs: state.queryTabs.map((item) => item.id === tabId ? {
            ...item,
            title: query.name,
            sql,
            savedQueryId: query.id,
            savedSql: sql,
            savedDatabase: query.database,
            isSaving: false,
            error: null,
          } : item),
          connectionTree: {
            ...state.connectionTree,
            [query.connection_id]: syncSavedQueryFolders(
              state.connectionTree[query.connection_id] ?? [],
              savedQueries,
              query.connection_id,
            ),
          },
        };
      });
    } catch (error) {
      get().patchTab(tabId, { isSaving: false, error: `保存查询失败：${String(error)}` });
      throw error;
    }
  },

  openSavedQuery: (queryId) => {
    const query = get().savedQueries.find((item) => item.id === queryId);
    if (!query) return;
    const existing = get().queryTabs.find((tab) => tab.savedQueryId === queryId);
    if (existing) {
      get().setActiveTab(existing.id);
      return;
    }
    const tabId = get().addQueryTab(query.connection_id, query.database);
    get().patchTab(tabId, {
      title: query.name,
      sql: query.sql,
      savedQueryId: query.id,
      savedSql: query.sql,
      savedDatabase: query.database,
    });
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
        const { [connectionId]: _databases, ...restDatabases } = state.connectionDatabases;
        return {
          activeConnections: state.activeConnections.filter(
            (c) => c.id !== connectionId,
          ),
          connectionTree: restTree,
          connectionDatabases: restDatabases,
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
              const connection = get().activeConnections.find((item) => item.id === connectionId);
              const routines = connection?.config.db_type === "mysql"
                ? await ipc.dbGetRoutines(connectionId, dbName).catch(() => [])
                : [];
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
                    name: "查询",
                    schema: dbName,
                    object_type: "folder" as const,
                    children: savedQueryObjects(get().savedQueries, connectionId, dbName),
                  },
                  ...(connection?.config.db_type === "mysql" ? [{
                    name: "存储过程/函数",
                    schema: dbName,
                    object_type: "folder" as const,
                    children: routines,
                  }] : []),
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
        set((state) => ({
          connectionTree: { ...state.connectionTree, [connectionId]: tree },
          connectionDatabases: { ...state.connectionDatabases, [connectionId]: databases },
        }));
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

  openTableStructure: async (connectionId, database, table, section = "columns") => {
    const existing = get().queryTabs.find((tab) => tab.kind === "structure" && tab.connectionId === connectionId && tab.database === database && tab.tableName === table);
    if (existing) {
      get().setActiveTab(existing.id);
      if (existing.structure) get().patchTab(existing.id, { structure: { ...existing.structure, section } });
      return;
    }
    const tab: QueryTab = { id: crypto.randomUUID(), kind: "structure", tableName: table, title: `${table} · 结构`,
      objectType: "table", connectionId, database, preview: false, sql: "", result: null, edits: [], insertedRows: [],
      tableInfo: null, agentChatId: null, isExecuting: false, isLoadingMetadata: true };
    set((state) => ({ queryTabs: [...state.queryTabs, tab] }));
    get().setActiveTab(tab.id);
    await get().refreshStructure(tab.id);
    const loaded = get().queryTabs.find((item) => item.id === tab.id);
    if (loaded?.structure) get().patchTab(tab.id, { structure: { ...loaded.structure, section } });
  },

  refreshStructure: async (tabId) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    if (!tab?.connectionId || !tab.database || !tab.tableName || tab.isSaving || hasPendingEdits(tab)) return;
    get().patchTab(tabId, { isLoadingMetadata: true, error: null });
    try {
      const info = await ipc.dbGetTableInfo(tab.connectionId, tab.database, tab.tableName);
      get().patchTab(tabId, { tableInfo: info, isLoadingMetadata: false, structure: {
        originalColumns: info.columns, columns: info.columns.map(structureColumn),
        originalIndexes: info.indexes, indexes: info.indexes.filter((index) => !index.is_primary).map(structureIndex),
        originalForeignKeys: info.foreign_keys, foreignKeys: info.foreign_keys.map(structureForeignKey),
        originalTriggers: info.triggers ?? [], triggers: (info.triggers ?? []).map(structureTrigger),
        originalAdvanced: tableAdvanced(info), advanced: [], section: tab.structure?.section ?? "columns",
      } });
    } catch (error) { get().patchTab(tabId, { isLoadingMetadata: false, error: String(error) }); }
  },

  updateStructureColumn: (tabId, index, patch) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    if (!tab?.structure || tab.isSaving || tab.isLoadingMetadata) return;
    const column = tab.structure.columns[index];
    const original = tab.structure.originalColumns.find((item) => item.name === column?.original_name);
    if (!column || (original && isStructureColumnReadOnly(original))) return;
    get().patchTab(tabId, { structure: { ...tab.structure, columns: tab.structure.columns.map((item, i) =>
      i === index ? { ...item, ...patch, ...(patch.is_primary_key ? { nullable: false } : {}) } : item) } });
  },

  addStructureColumn: (tabId) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    if (!tab?.structure || tab.isSaving || tab.isLoadingMetadata) return;
    get().patchTab(tabId, { structure: { ...tab.structure, section: "columns", columns: [...tab.structure.columns, {
      original_name: null, name: "", data_type: "varchar(255)", charset: null, collation: null, nullable: true, is_primary_key: false,
      is_auto_increment: false, default_mode: "none", default_value: null, comment: "",
    }] } });
  },

  removeStructureColumn: (tabId, index) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    if (!tab?.structure || tab.isSaving || tab.isLoadingMetadata) return;
    const original = tab.structure.originalColumns.find((item) => item.name === tab.structure!.columns[index]?.original_name);
    if (original && isStructureColumnReadOnly(original)) return;
    get().patchTab(tabId, { structure: { ...tab.structure, columns: tab.structure.columns.filter((_, i) => i !== index) } });
  },

  insertStructureItem: (tabId, section, index, source) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    if (!tab?.structure || tab.isSaving || tab.isLoadingMetadata) return;
    const structure = tab.structure;
    const place = <T,>(items: T[], value: T) => {
      const next = [...items]; next.splice(index ?? items.length, 0, value); return next;
    };
    const copied = source ? structuredClone(source) : null;
    switch (section) {
      case "columns": {
        const value = copied as typeof structure.columns[number] | null;
        get().patchTab(tabId, { structure: { ...structure, section, columns: place(structure.columns, value ? { ...value, original_name: null } : { original_name: null, name: "", data_type: "varchar(255)", charset: null, collation: null, nullable: true, is_primary_key: false, is_auto_increment: false, default_mode: "none", default_value: null, comment: "" }) } });
        break;
      }
      case "indexes": {
        const value = copied as typeof structure.indexes[number] | null;
        get().patchTab(tabId, { structure: { ...structure, section, indexes: place(structure.indexes, value ? { ...value, original_name: null, editable: true } : { original_name: null, name: "", columns: structure.columns[0]?.name ? [structure.columns[0].name] : [], is_unique: false, index_type: "BTREE", editable: true }) } });
        break;
      }
      case "foreign_keys": {
        const value = copied as typeof structure.foreignKeys[number] | null;
        get().patchTab(tabId, { structure: { ...structure, section, foreignKeys: place(structure.foreignKeys, value ? { ...value, original_name: null, editable: true } : { original_name: null, name: "", columns: structure.columns[0]?.name ? [structure.columns[0].name] : [], ref_table: "", ref_columns: [], on_delete: "RESTRICT", on_update: "RESTRICT", editable: true }) } });
        break;
      }
      case "triggers": {
        const value = copied as typeof structure.triggers[number] | null;
        get().patchTab(tabId, { structure: { ...structure, section, triggers: place(structure.triggers, value ? { ...value, original_name: null, editable: true } : { original_name: null, name: "", timing: "AFTER", event: "INSERT", statement: "", editable: true }) } });
        break;
      }
      case "advanced": {
        const value = copied as typeof structure.advanced[number] | null;
        const keys = ["engine", "charset", "collation", "comment", "row_format", "auto_increment"] as const;
        const key = keys.find((candidate) => !structure.advanced.some((option) => option.key === candidate));
        if (!value && !key) return;
        get().patchTab(tabId, { structure: { ...structure, section, advanced: place(structure.advanced, value ?? { key: key!, value: String(structure.originalAdvanced[key!] ?? "") }) } });
      }
    }
  },

  updateStructureItem: (tabId, section, index, patch) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    if (!tab?.structure || tab.isSaving || tab.isLoadingMetadata) return;
    const structure = tab.structure;
    const update = <T,>(items: T[]) => items.map((item, i) => i === index ? { ...item, ...patch } as T : item);
    if (section === "columns") { get().updateStructureColumn(tabId, index, patch as Partial<StructureColumn>); return; }
    if (section === "indexes" && structure.indexes[index]?.editable) get().patchTab(tabId, { structure: { ...structure, indexes: update(structure.indexes) } });
    if (section === "foreign_keys" && structure.foreignKeys[index]?.editable) get().patchTab(tabId, { structure: { ...structure, foreignKeys: update(structure.foreignKeys) } });
    if (section === "triggers" && structure.triggers[index]?.editable) get().patchTab(tabId, { structure: { ...structure, triggers: update(structure.triggers) } });
    if (section === "advanced") {
      const candidate = { ...structure.advanced[index], ...patch } as typeof structure.advanced[number];
      if (structure.advanced.some((option, i) => i !== index && option.key === candidate.key)) return;
      get().patchTab(tabId, { structure: { ...structure, advanced: update(structure.advanced) } });
    }
  },

  removeStructureItem: (tabId, section, index) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    if (!tab?.structure || tab.isSaving || tab.isLoadingMetadata) return;
    const structure = tab.structure;
    if (section === "columns") { get().removeStructureColumn(tabId, index); return; }
    if (section === "indexes" && structure.indexes[index]?.editable) get().patchTab(tabId, { structure: { ...structure, indexes: structure.indexes.filter((_, i) => i !== index) } });
    if (section === "foreign_keys" && structure.foreignKeys[index]?.editable) get().patchTab(tabId, { structure: { ...structure, foreignKeys: structure.foreignKeys.filter((_, i) => i !== index) } });
    if (section === "triggers") get().patchTab(tabId, { structure: { ...structure, triggers: structure.triggers.filter((_, i) => i !== index) } });
    if (section === "advanced") get().patchTab(tabId, { structure: { ...structure, advanced: structure.advanced.filter((_, i) => i !== index) } });
  },

  moveStructureItem: (tabId, section, from, to) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    if (!tab?.structure || tab.isSaving || tab.isLoadingMetadata || from === to || from < 0 || to < 0) return;
    const move = <T,>(items: T[]) => {
      if (from >= items.length || to >= items.length) return items;
      const next = [...items]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
    };
    const structure = tab.structure;
    if (section === "columns") get().patchTab(tabId, { structure: { ...structure, columns: move(structure.columns) } });
    if (section === "indexes") get().patchTab(tabId, { structure: { ...structure, indexes: move(structure.indexes) } });
    if (section === "foreign_keys") get().patchTab(tabId, { structure: { ...structure, foreignKeys: move(structure.foreignKeys) } });
    if (section === "triggers") get().patchTab(tabId, { structure: { ...structure, triggers: move(structure.triggers) } });
    if (section === "advanced") get().patchTab(tabId, { structure: { ...structure, advanced: move(structure.advanced) } });
  },

  resetStructureEdits: (tabId) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    if (!tab?.structure || tab.isSaving) return;
    get().patchTab(tabId, { error: null, structure: { ...tab.structure,
      columns: tab.structure.originalColumns.map(structureColumn),
      indexes: tab.structure.originalIndexes.filter((index) => !index.is_primary).map(structureIndex),
      foreignKeys: tab.structure.originalForeignKeys.map(structureForeignKey),
      triggers: tab.structure.originalTriggers.map(structureTrigger), advanced: [] } });
  },

  previewStructure: async (tabId) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    if (!tab?.structure || !tab.connectionId || !tab.database || !tab.tableName) throw new Error("请先读取表结构");
    try {
      if (get().queryTabs.some((item) => item.kind === "table" && item.connectionId === tab.connectionId && item.database === tab.database && item.tableName === tab.tableName && (hasPendingEdits(item) || item.isExecuting || item.isSaving || item.isLoadingMetadata))) {
        throw new Error("请等待数据读取完成，并保存或撤销数据标签中的修改，再更改表结构。");
      }
      return await ipc.dbPreviewTableStructure(tab.connectionId, tab.database, tab.tableName, tab.structure);
    } catch (error) { get().patchTab(tabId, { error: String(error) }); throw error; }
  },

  applyStructure: async (tabId) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    if (!tab?.structure || !tab.connectionId || !tab.database || !tab.tableName || tab.isSaving) return;
    get().patchTab(tabId, { isSaving: true, error: null });
    try {
      if (get().queryTabs.some((item) => item.kind === "table" && item.connectionId === tab.connectionId && item.database === tab.database && item.tableName === tab.tableName && (hasPendingEdits(item) || item.isExecuting || item.isSaving || item.isLoadingMetadata))) {
        throw new Error("请等待数据读取完成，并保存或撤销数据标签中的修改，再更改表结构。");
      }
      const outcome = await ipc.dbApplyTableStructure(tab.connectionId, tab.database, tab.tableName, tab.structure);
      const info = outcome.table_info;
      const resultError = [outcome.execution_error, outcome.refresh_error].filter(Boolean).join("\n") || null;
      get().patchTab(tabId, { isSaving: false, tableInfo: info, error: resultError,
        structure: info ? { originalColumns: info.columns, columns: info.columns.map(structureColumn),
          originalIndexes: info.indexes, indexes: info.indexes.filter((index) => !index.is_primary).map(structureIndex),
          originalForeignKeys: info.foreign_keys, foreignKeys: info.foreign_keys.map(structureForeignKey),
          originalTriggers: info.triggers ?? [], triggers: (info.triggers ?? []).map(structureTrigger),
          originalAdvanced: tableAdvanced(info), advanced: [], section: tab.structure.section } : undefined });
      for (const dataTab of get().queryTabs.filter((item) => item.kind === "table" && item.connectionId === tab.connectionId && item.database === tab.database && item.tableName === tab.tableName)) {
        get().patchTab(dataTab.id, { tableInfo: info, result: null, selectedRows: [], metadataError: outcome.refresh_error,
          browse: { ...DEFAULT_BROWSE, filters: [] }, hiddenColumns: [] });
        await get().executeQuery(dataTab.id);
      }
      if (get().activeTabId === tabId) set({ selectedTable: info });
      await get().refreshTree(tab.connectionId);
    } catch (error) { get().patchTab(tabId, { isSaving: false, error: String(error) }); }
  },

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
    if (tab?.kind === "table" || tab?.kind === "structure") {
      // AI drafts and generated SQL open a query; they never change a table browser's identity.
      const id = get().addQueryTab();
      get().patchTab(id, { sql, connectionId: tab.connectionId, database: tab.database });
      return;
    }
    get().patchTab(tabId, { sql, preview: false });
  },

  browseTable: async (tabId, patch) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab || tab.kind !== "table" || tab.isExecuting || tab.isSaving || hasPendingEdits(tab) || schemaSaving(get().queryTabs, tab)) return;
    get().patchTab(tabId, { browse: { ...(tab.browse ?? DEFAULT_BROWSE), ...patch }, selectedRows: [] });
    await get().executeQuery(tabId);
    if (get().queryTabs.find((t) => t.id === tabId)?.error) {
      get().patchTab(tabId, { browse: tab.browse, sql: tab.sql, hasMore: tab.hasMore });
    }
  },

  executeQuery: async (tabId, sqlOverride) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab || !tab.connectionId || tab.isExecuting || tab.isSaving || hasPendingEdits(tab) || schemaSaving(get().queryTabs, tab)) return;
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
    if (!tab?.result || !canEditTable(tab) || tab.isSaving || tab.isExecuting || tab.deletedRows?.includes(rowIdx) || schemaSaving(get().queryTabs, tab)) return;
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
    if (tab?.kind === "structure") { get().resetStructureEdits(tabId); return; }
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
    if (!tab?.result || !canEditTable(tab) || tab.isSaving || tab.isExecuting || schemaSaving(get().queryTabs, tab)) return;
    const idx = tab.result.rows.length;
    get().patchTab(tabId, { preview: false,
      result: { ...tab.result, rows: [...tab.result.rows, tab.result.columns.map((): CellValue => ({ type: "null" }))] },
      insertedRows: [...tab.insertedRows, idx], selectedRows: [idx],
    });
  },

  cloneRow: (tabId, rowIdx) => {
    const tab = get().queryTabs.find((item) => item.id === tabId);
    if (!tab?.result || !canEditTable(tab) || tab.isSaving || tab.isExecuting || schemaSaving(get().queryTabs, tab)) return false;
    const source = tab.result.rows[rowIdx];
    if (!source || source.some((cell) => cell.type === "blob")) return false;
    const nextRow = source.map((cell, colIdx): CellValue => {
      const column = tab.result!.columns[colIdx];
      if (column.is_auto_increment) return { type: "null" };
      const edit = tab.edits.find((item) => item.rowIdx === rowIdx && item.colIdx === colIdx);
      if (!edit) return cell;
      if (edit.newValue === NULL_MARKER || edit.newValue === DEFAULT_MARKER) return { type: "null" };
      return { type: "text", value: edit.newValue };
    });
    const nextIndex = tab.result.rows.length;
    const edits = nextRow.flatMap((cell, colIdx) => {
      if (tab.result!.columns[colIdx].is_auto_increment) return [];
      const newValue = cell.type === "null" ? NULL_MARKER : displayCellValue(cell);
      return [{ rowIdx: nextIndex, colIdx, oldValue: { type: "null" } as CellValue, newValue }];
    });
    get().patchTab(tabId, {
      preview: false,
      result: { ...tab.result, rows: [...tab.result.rows, nextRow] },
      edits: [...tab.edits, ...edits],
      insertedRows: [...tab.insertedRows, nextIndex],
      selectedRows: [nextIndex],
    });
    return true;
  },

  deleteRow: async (tabId, rowIdx) => {
    const tab = get().queryTabs.find((t) => t.id === tabId);
    if (!tab?.result || !canEditTable(tab) || tab.isSaving || tab.isExecuting || schemaSaving(get().queryTabs, tab)) return;
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
