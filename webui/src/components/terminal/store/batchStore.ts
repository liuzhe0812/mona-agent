import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { BatchTransferProgress, FileInfo } from "../types/terminal";

export interface BatchSession {
  id: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
  connectedAt?: number;
  selected: boolean;
}

export interface TransferFileNode {
  id: string;
  filename: string;
  status: "waiting" | "transferring" | "completed" | "error" | "cancelled" | "paused";
  speed: string;
  eta: string;
}

export interface TransferSessionNode {
  id: string;
  host: string;
  status: "waiting" | "transferring" | "completed" | "error" | "paused";
  expanded: boolean;
  files: TransferFileNode[];
  progress: number;
  completedCount: number;
  totalCount: number;
  totalBytes: number;
  transferredBytes: number;
  speed: string;
  eta: string;
  error?: string;
}

const formatSpeed = (bytesPerSec: number | null): string => {
  if (!bytesPerSec) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let val = bytesPerSec;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(1)} ${units[idx]}`;
};

const formatEta = (seconds: number | null): string => {
  if (!seconds) return "计算中...";
  if (seconds < 60) return `${Math.ceil(seconds)}秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}分钟`;
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return `${h}小时${m}分钟`;
};

interface BatchState {
  startIp: string;
  count: number;
  username: string;
  password: string;
  port: number;
  sessions: BatchSession[];
  activeSessionId: string | null;
  commandInput: string;
  isConnecting: boolean;
  configCollapsed: boolean;
  activeTab: "terminal" | "sftp";
  remotePath: string;
  remoteFiles: FileInfo[];
  loadingFiles: boolean;
  transferSessions: TransferSessionNode[];
  activeBatchId: string | null;
  maxConcurrent: number;

  setStartIp: (v: string) => void;
  setCount: (v: number) => void;
  setUsername: (v: string) => void;
  setPassword: (v: string) => void;
  setPort: (v: number) => void;
  setSessions: (sessions: BatchSession[]) => void;
  updateSession: (id: string, updates: Partial<BatchSession>) => void;
  toggleSessionSelection: (id: string) => void;
  selectAllSessions: () => void;
  deselectAllSessions: () => void;
  setActiveSessionId: (id: string | null) => void;
  setCommandInput: (v: string) => void;
  setIsConnecting: (v: boolean) => void;
  setConfigCollapsed: (v: boolean) => void;
  setActiveTab: (tab: "terminal" | "sftp") => void;
  setRemotePath: (v: string) => void;
  setRemoteFiles: (files: FileInfo[]) => void;
  setLoadingFiles: (v: boolean) => void;
  setTransferSessions: (sessions: TransferSessionNode[]) => void;
  updateTransferSession: (id: string, updates: Partial<TransferSessionNode>) => void;
  setActiveBatchId: (id: string | null) => void;
  setMaxConcurrent: (n: number) => void;
  handleBatchProgress: (progress: BatchTransferProgress) => void;
}

export const useBatchStore = create<BatchState>()(
  persist(
    (set) => ({
      startIp: "192.168.1.100",
      count: 5,
      username: "root",
      password: "",
      port: 22,
      sessions: [],
      activeSessionId: null,
      commandInput: "",
      isConnecting: false,
      configCollapsed: false,
      activeTab: "terminal",
      remotePath: "/root",
      remoteFiles: [],
      loadingFiles: false,
      transferSessions: [],
      activeBatchId: null,
      maxConcurrent: 3,

      setStartIp: (v) => set({ startIp: v }),
      setCount: (v) => set({ count: v }),
      setUsername: (v) => set({ username: v }),
      setPassword: (v) => set({ password: v }),
      setPort: (v) => set({ port: v }),

      setSessions: (sessions) => set({ sessions }),

      updateSession: (id, updates) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, ...updates } : s,
          ),
        })),

      toggleSessionSelection: (id) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, selected: !s.selected } : s,
          ),
        })),

      selectAllSessions: () =>
        set((state) => ({
          sessions: state.sessions.map((s) => ({
            ...s,
            selected: s.status === "connected",
          })),
        })),

      deselectAllSessions: () =>
        set((state) => ({
          sessions: state.sessions.map((s) => ({ ...s, selected: false })),
        })),

      setActiveSessionId: (id) => set({ activeSessionId: id }),
      setCommandInput: (v) => set({ commandInput: v }),
      setIsConnecting: (v) => set({ isConnecting: v }),
      setConfigCollapsed: (v) => set({ configCollapsed: v }),
      setActiveTab: (tab) => set({ activeTab: tab }),
      setRemotePath: (v) => set({ remotePath: v }),
      setRemoteFiles: (files) => set({ remoteFiles: files }),
      setLoadingFiles: (v) => set({ loadingFiles: v }),

      setTransferSessions: (sessions) => set({ transferSessions: sessions }),

      updateTransferSession: (id, updates) =>
        set((state) => ({
          transferSessions: state.transferSessions.map((s) =>
            s.id === id ? { ...s, ...updates } : s,
          ),
        })),

      setActiveBatchId: (id) => set({ activeBatchId: id }),
      setMaxConcurrent: (n) => set({ maxConcurrent: n }),

      handleBatchProgress: (progress) => {
        const { sessionId, status, currentFile, filesCompleted, filesTotal, bytesTransferred, bytesTotal, speed, etaSeconds, error } = progress;

        const statusMap: Record<string, TransferSessionNode["status"]> = {
          pending: "waiting",
          connecting: "waiting",
          transferring: "transferring",
          completed: "completed",
          error: "error",
          cancelled: "completed",
        };

        let sessionProgress = 0;
        if (bytesTotal > 0) {
          sessionProgress = Math.round((bytesTransferred / bytesTotal) * 100);
        } else if (filesTotal > 0) {
          sessionProgress = Math.round((filesCompleted / filesTotal) * 100);
        }

        const fileStatus = status === "completed" ? "completed" : status === "error" ? "error" : "transferring";

        set((state) => ({
          transferSessions: state.transferSessions.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  status: statusMap[status] || "waiting",
                  progress: sessionProgress,
                  completedCount: filesCompleted,
                  totalCount: filesTotal,
                  transferredBytes: bytesTransferred,
                  totalBytes: bytesTotal,
                  speed: formatSpeed(speed),
                  eta: formatEta(etaSeconds),
                  error: error || undefined,
                  files: currentFile
                    ? s.files.map((f) =>
                        f.filename === currentFile
                          ? { ...f, status: fileStatus, speed: formatSpeed(speed), eta: formatEta(etaSeconds) }
                          : f,
                      )
                    : s.files.map((f) => ({ ...f, status: fileStatus })),
                }
              : s,
          ),
        }));
      },
    }),
    {
      name: "mona-batch-config",
      partialize: (state) => ({
        startIp: state.startIp,
        count: state.count,
        username: state.username,
        password: state.password,
        port: state.port,
        maxConcurrent: state.maxConcurrent,
      }),
    },
  ),
);
