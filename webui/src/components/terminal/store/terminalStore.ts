import { create } from "zustand";
import type { Session, SessionStatus, ConnectionConfig } from "../types/terminal";
import {
  terminalSaveConnections,
  terminalLoadConnections,
  onTerminalOutput,
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

  addSession: (session: Session) => void;
  removeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string) => void;
  updateSessionStatus: (sessionId: string, status: SessionStatus) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
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
}

const registry = new TerminalRegistry();

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  connections: [],
  savedConnections: [],
  aiPanelVisible: true,
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

  addSession: (session) => {
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id,
    }));
  },

  removeSession: (sessionId) => {
    registry.unregister(sessionId);
    registry.clearBuffer(sessionId);
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== sessionId);
      const activeSessionId =
        state.activeSessionId === sessionId
          ? sessions[sessions.length - 1]?.id ?? null
          : state.activeSessionId;
      return { sessions, activeSessionId };
    });
  },

  setActiveSession: (sessionId) => {
    set({ activeSessionId: sessionId });
  },

  updateSessionStatus: (sessionId, status) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, status } : s,
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
}));

onTerminalOutput((event) => {
  registry.write(event.sessionId, event.data);
}).catch(() => {});
