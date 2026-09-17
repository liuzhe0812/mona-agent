import { create } from "zustand";
import type { Session, SessionStatus, ConnectionConfig } from "../types/terminal";
import {
  terminalSaveConnections,
  terminalLoadConnections,
  onTerminalOutput,
  onTerminalSessionStatus,
  onTerminalMaintenanceUpdated,
  type MaintenanceTaskDetail,
} from "../ipc";
import { TerminalRegistry } from "../terminalRegistry";

export interface SshPasswordDialogState {
  open: boolean;
  host: string;
  port: number;
  username: string;
  onConfirm: (password: string) => void;
  onCancel: () => void;
}

export interface HostKeyDialogState {
  open: boolean;
  host: string;
  port: number;
  type: "unknown" | "changed";
  fingerprint: string;
  expectedFingerprint: string;
  pendingConfig: ConnectionConfig | null;
  pendingSessionId: string | null;
  saveSession: boolean;
}

export interface ExecApprovalState {
  open: boolean;
  requestId: string;
  sessionId: string;
  command: string;
  source: string;
}

export interface TerminalSettings {
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  cursorStyle: "block" | "underline" | "bar";
}

interface TerminalState {
  sessions: Session[];
  activeSessionId: string | null;
  connections: ConnectionConfig[];
  savedConnections: ConnectionConfig[];
  aiPanelVisible: boolean;
  newConnectionDialogOpen: boolean;
  newConnectionDialogDefaultType: "ssh" | "sftp";
  settingsDialogOpen: boolean;
  settings: TerminalSettings;
  batchSelectedIds: Set<string>;
  batchOutputs: Record<string, string>;
  batchActiveTabId: string | null;
  hostKeyDialog: HostKeyDialogState;
  sshPasswordDialog: SshPasswordDialogState;
  execApproval: ExecApprovalState;
  terminalRegistry: TerminalRegistry;
  terminalExecMode: "auto" | "approval";
  aiStreaming: boolean;
  /** AI 会话 id bound to each终端会话，面板重新挂载（重连、切换面板、客户端重连）后仍复用同一会话。 */
  aiChatIds: Record<string, string>;
  /** Latest maintenance task snapshot per session (drives the task card). */
  activeMaintenanceTasks: Record<string, MaintenanceTaskDetail>;

  addSession: (session: Session) => void;
  openDockerSession: (parentSessionId: string) => void;
  removeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string) => void;
  updateSessionStatus: (sessionId: string, status: SessionStatus) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateSession: (sessionId: string, updates: Partial<Session>) => void;
  toggleAIPanel: () => void;
  addConnection: (config: ConnectionConfig) => void;
  removeConnection: (id: string) => void;
  setNewConnectionDialogOpen: (open: boolean, defaultType?: "ssh" | "sftp") => void;
  setSettingsDialogOpen: (open: boolean) => void;
  updateSettings: (settings: Partial<TerminalSettings>) => void;
  toggleBatchSelection: (id: string) => void;
  selectAllBatch: () => void;
  clearBatchSelection: () => void;
  appendBatchOutput: (sessionId: string, data: string) => void;
  clearBatchOutputs: () => void;
  setBatchActiveTabId: (id: string | null) => void;
  loadSavedConnections: () => Promise<void>;
  saveConnection: (config: ConnectionConfig) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  showHostKeyDialog: (dialog: Omit<HostKeyDialogState, "open">) => void;
  closeHostKeyDialog: () => void;
  showSshPasswordDialog: (dialog: Omit<SshPasswordDialogState, "open">) => void;
  closeSshPasswordDialog: () => void;
  showExecApproval: (approval: Omit<ExecApprovalState, "open">) => void;
  closeExecApproval: () => void;
  setTerminalExecMode: (mode: "auto" | "approval") => void;
  setAiStreaming: (streaming: boolean) => void;
  setAiChatId: (sessionId: string | null, chatId: string | null) => void;
  setActiveMaintenanceTask: (
    sessionId: string,
    detail: MaintenanceTaskDetail | null,
  ) => void;
}

const registry = new TerminalRegistry();

/** Binding map for terminal AI chats, persisted by connection identity so a
 *  reconnected or restarted terminal session reopens the same conversation. */
const AI_CHAT_STORAGE_KEY = "mona.terminal.ai-chat.v1";
/** Bucket used when the AI panel is rendered without a terminal session. */
const UNBOUND_AI_CHAT_KEY = "__unbound__";

export function terminalAiChatKey(sessionId: string | null): string {
  return sessionId ?? UNBOUND_AI_CHAT_KEY;
}

/** Stable identity of a terminal session across reconnects and app restarts:
 *  the session id is a fresh UUID on every connect, but the saved connection is
 *  not. Sessions without a saved connection (local shells, ad-hoc `ssh host`
 *  typed in the shell) have no identity to restore against, so only the
 *  in-memory binding applies to them. */
function persistentAiChatKey(sessionId: string): string | null {
  const session = useTerminalStore
    .getState()
    .sessions.find((item) => item.id === sessionId);
  return session ? sessionIdentity(session) : null;
}

function sessionIdentity(session: Session): string | null {
  if (!session.configId) return null;
  return `${session.type}:${session.configId}`;
}

function readPersistedAiChatIds(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(AI_CHAT_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function writePersistedAiChatIds(map: Record<string, string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage errors (private mode, quota)
  }
}

/** Recover the AI chat bound to a terminal session in an earlier run.
 *
 *  A duplicated tab (second live session on the same connection) must not
 *  hijack the conversation its sibling is already showing, so the binding is
 *  only returned while no other live session on that connection claims it. */
export function loadPersistedAiChatId(sessionId: string): string | null {
  const key = persistentAiChatKey(sessionId);
  if (!key) return null;
  const stored = readPersistedAiChatIds()[key];
  if (!stored) return null;
  const state = useTerminalStore.getState();
  for (const other of state.sessions) {
    if (other.id === sessionId) continue;
    if (sessionIdentity(other) !== key) continue;
    if (state.aiChatIds[terminalAiChatKey(other.id)]) return null;
  }
  return stored;
}

function persistAiChatId(sessionId: string, chatId: string | null): void {
  const key = persistentAiChatKey(sessionId);
  if (!key) return;
  const map = readPersistedAiChatIds();
  if (chatId) {
    map[key] = chatId;
  } else {
    delete map[key];
  }
  writePersistedAiChatIds(map);
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  connections: [],
  savedConnections: [],
  aiPanelVisible: false,
  newConnectionDialogOpen: false,
  newConnectionDialogDefaultType: "ssh" as const,
  settingsDialogOpen: false,
  settings: {
    fontSize: 14,
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
    scrollback: 5000,
    cursorStyle: "block" as const,
  },
  batchSelectedIds: new Set<string>(),
  batchOutputs: {},
  batchActiveTabId: null,
  hostKeyDialog: {
    open: false,
    host: "",
    port: 22,
    type: "unknown",
    fingerprint: "",
    expectedFingerprint: "",
    pendingConfig: null,
    pendingSessionId: null,
    saveSession: false,
  },
  sshPasswordDialog: {
    open: false,
    host: "",
    port: 22,
    username: "",
    onConfirm: () => {},
    onCancel: () => {},
  },
  execApproval: {
    open: false,
    requestId: "",
    sessionId: "",
    command: "",
    source: "",
  },
  terminalRegistry: registry,
  terminalExecMode: "auto" as const,
  aiStreaming: false,
  aiChatIds: {},
  activeMaintenanceTasks: {},

  addSession: (session) => {
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id,
    }));
  },

  openDockerSession: (parentSessionId) => {
    const state = get();
    const parent = state.sessions.find((session) => session.id === parentSessionId);
    if (!parent || parent.type !== "ssh" || parent.status !== "connected") return;
    const existing = state.sessions.find(
      (session) => session.type === "docker" && session.parentSessionId === parentSessionId,
    );
    if (existing) {
      set({ activeSessionId: existing.id });
      return;
    }
    const dockerSession: Session = {
      id: `docker:${parent.id}`,
      configId: parent.configId,
      type: "docker",
      status: parent.status,
      title: `Docker · ${parent.title}`,
      parentSessionId: parent.id,
    };
    set((current) => ({
      sessions: [...current.sessions, dockerSession],
      activeSessionId: dockerSession.id,
    }));
  },

  removeSession: (sessionId) => {
    const removedIds = get()
      .sessions.filter(
        (session) => session.id === sessionId || session.parentSessionId === sessionId,
      )
      .map((session) => session.id);
    for (const id of removedIds) {
      registry.unregister(id);
      registry.clearBuffer(id);
    }
    // The persisted binding is kept: reopening the same saved connection
    // continues the previous conversation instead of starting an empty one.
    // Only 重置会话 rebinds it.
    set((state) => {
      const removed = new Set(removedIds);
      const sessions = state.sessions.filter((session) => !removed.has(session.id));
      const aiChatIds = { ...state.aiChatIds };
      for (const id of removed) delete aiChatIds[terminalAiChatKey(id)];
      const activeSessionId =
        state.activeSessionId !== null && removed.has(state.activeSessionId)
          ? sessions[sessions.length - 1]?.id ?? null
          : state.activeSessionId;
      return { sessions, aiChatIds, activeSessionId };
    });
  },

  setActiveSession: (sessionId) => {
    set({ activeSessionId: sessionId });
  },

  updateSessionStatus: (sessionId, status) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId || s.parentSessionId === sessionId ? { ...s, status } : s,
      ),
    }));
  },

  updateSessionTitle: (sessionId, title) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, title } : s,
      ),
    }));
  },

  updateSession: (sessionId, updates) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, ...updates } : s,
      ),
    }));
  },

  toggleAIPanel: () => {
    set((state) => ({ aiPanelVisible: !state.aiPanelVisible }));
  },

  addConnection: (config) => {
    set((state) => ({
      connections: [...state.connections, config],
    }));
  },

  removeConnection: (id) => {
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
    }));
  },

  setNewConnectionDialogOpen: (open, defaultType) => {
    set({
      newConnectionDialogOpen: open,
      ...(defaultType ? { newConnectionDialogDefaultType: defaultType } : {}),
    });
  },

  setSettingsDialogOpen: (open) => {
    set({ settingsDialogOpen: open });
  },

  updateSettings: (partial) => {
    set((state) => ({
      settings: { ...state.settings, ...partial },
    }));
  },

  toggleBatchSelection: (id) => {
    set((state) => {
      const next = new Set(state.batchSelectedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { batchSelectedIds: next };
    });
  },

  selectAllBatch: () => {
    set((state) => {
      const sshIds = state.sessions
        .filter((s) => s.type === "ssh" && s.status === "connected")
        .map((s) => s.id);
      return { batchSelectedIds: new Set(sshIds) };
    });
  },

  clearBatchSelection: () => {
    set({ batchSelectedIds: new Set<string>(), batchActiveTabId: null });
  },

  appendBatchOutput: (sessionId, data) => {
    set((state) => {
      const current = state.batchOutputs[sessionId] ?? "";
      const next = current + data;
      return {
        batchOutputs: {
          ...state.batchOutputs,
          [sessionId]:
            next.length > 8192 ? next.slice(-8192) : next,
        },
      };
    });
  },

  clearBatchOutputs: () => {
    set({ batchOutputs: {} });
  },

  setBatchActiveTabId: (id) => {
    set({ batchActiveTabId: id });
  },

  loadSavedConnections: async () => {
    try {
      const connections = await terminalLoadConnections();
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
      await terminalSaveConnections(updated);
    } catch {
      set({ savedConnections: savedConnections });
    }
  },

  deleteConnection: async (id) => {
    const { savedConnections } = get();
    const updated = savedConnections.filter((c) => c.id !== id);
    set({ savedConnections: updated });
    try {
      await terminalSaveConnections(updated);
    } catch {
      set({ savedConnections: savedConnections });
    }
  },

  showHostKeyDialog: (dialog) => {
    set({ hostKeyDialog: { ...dialog, open: true } });
  },

  closeHostKeyDialog: () => {
    set({
      hostKeyDialog: {
        open: false,
        host: "",
        port: 22,
        type: "unknown",
        fingerprint: "",
        expectedFingerprint: "",
        pendingConfig: null,
        pendingSessionId: null,
        saveSession: false,
      },
    });
  },

  showSshPasswordDialog: (dialog) => {
    set({ sshPasswordDialog: { ...dialog, open: true } });
  },

  closeSshPasswordDialog: () => {
    set({
      sshPasswordDialog: {
        open: false,
        host: "",
        port: 22,
        username: "",
        onConfirm: () => {},
        onCancel: () => {},
      },
    });
  },

  showExecApproval: (approval) => {
    set({ execApproval: { ...approval, open: true } });
  },

  closeExecApproval: () => {
    set({
      execApproval: {
        open: false,
        requestId: "",
        sessionId: "",
        command: "",
        source: "",
      },
    });
  },

  setTerminalExecMode: (mode) => {
    set({ terminalExecMode: mode });
  },

  setAiStreaming: (streaming) => {
    set({ aiStreaming: streaming });
  },

  setAiChatId: (sessionId, chatId) => {
    const key = terminalAiChatKey(sessionId);
    set((state) => {
      const next = { ...state.aiChatIds };
      if (chatId) {
        next[key] = chatId;
      } else {
        delete next[key];
      }
      return { aiChatIds: next };
    });
    if (sessionId) persistAiChatId(sessionId, chatId);
  },

  setActiveMaintenanceTask: (sessionId, detail) => {
    set((state) => {
      const next = { ...state.activeMaintenanceTasks };
      if (detail) {
        next[sessionId] = detail;
      } else {
        delete next[sessionId];
      }
      return { activeMaintenanceTasks: next };
    });
  },
}));

onTerminalOutput((event) => {
  registry.write(event.sessionId, event.data);
}).catch(() => {});

onTerminalSessionStatus((event) => {
  useTerminalStore.getState().updateSessionStatus(event.sessionId, event.status);
}).catch(() => {});

onTerminalMaintenanceUpdated((event) => {
  useTerminalStore
    .getState()
    .setActiveMaintenanceTask(event.sessionId, event.task);
}).catch(() => {});
