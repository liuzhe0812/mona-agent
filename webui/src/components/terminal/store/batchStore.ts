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
  status: "waiting" | "transferring" | "completed" | "error" | "paused" | "cancelled";
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

export interface ClipboardItem {
  path: string;
  isDir: boolean;
  action: "copy" | "cut";
}

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
  selectedFilePaths: Set<string>;
  clipboard: ClipboardItem[];

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
  selectFile: (path: string, multi?: boolean, range?: boolean, allFiles?: FileInfo[]) => void;
  clearFileSelection: () => void;
  setClipboard: (items: ClipboardItem[]) => void;
  clearClipboard: () => void;
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
      selectedFilePaths: new Set(),
      clipboard: [],

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

      selectFile: (path, multi, range, allFiles) =>
        set((state) => {
          const next = new Set(state.selectedFilePaths);
          if (multi) {
            if (next.has(path)) next.delete(path);
            else next.add(path);
          } else if (range && allFiles) {
            const paths = allFiles.map((f) => f.path);
            const lastIdx = paths.findIndex((p) => next.has(p));
            const curIdx = paths.indexOf(path);
            if (lastIdx >= 0 && curIdx >= 0) {
              const start = Math.min(lastIdx, curIdx);
              const end = Math.max(lastIdx, curIdx);
              for (let i = start; i <= end; i++) next.add(paths[i]);
            } else {
              next.add(path);
            }
          } else {
            next.clear();
            next.add(path);
          }
          return { selectedFilePaths: next };
        }),
      clearFileSelection: () => set({ selectedFilePaths: new Set() }),
      setClipboard: (items) => set({ clipboard: items }),
      clearClipboard: () => set({ clipboard: [] }),

      handleBatchProgress: (progress) => {
        const { sessionId, status, currentFile, filesCompleted, filesTotal, bytesTransferred, bytesTotal, speed, etaSeconds, error } = progress;

        const statusMap: Record<string, TransferSessionNode["status"]> = {
          pending: "waiting",
          connecting: "waiting",
          transferring: "transferring",
          completed: "completed",
          error: "error",
          cancelled: "cancelled",
        };

        let sessionProgress = 0;
        if (bytesTotal > 0) {
          sessionProgress = Math.round((bytesTransferred / bytesTotal) * 100);
        } else if (filesTotal > 0) {
          sessionProgress = Math.round((filesCompleted / filesTotal) * 100);
        }

        const fileStatus =
          status === "completed" ? "completed"
          : status === "error" ? "error"
          : status === "cancelled" ? "cancelled"
          : "transferring";

        const formattedSpeed = formatSpeed(speed);
        const formattedEta = formatEta(etaSeconds);

        set((state) => {
          const sessionIdx = state.transferSessions.findIndex((s) => s.id === sessionId);
          if (sessionIdx === -1) return state;

          const session = state.transferSessions[sessionIdx];
          const isFinalEvent = currentFile === null || currentFile === undefined;

          let nextFiles = session.files;
          if (isFinalEvent) {
            nextFiles = session.files.map((f) => ({ ...f, status: fileStatus as TransferFileNode["status"] }));
          } else {
            const fileIdx = session.files.findIndex((f) => f.filename === currentFile);
            if (fileIdx !== -1) {
              const file = session.files[fileIdx];
              if (
                file.status === fileStatus &&
                file.speed === formattedSpeed &&
                file.eta === formattedEta
              ) {
                nextFiles = session.files;
              } else {
                nextFiles = session.files.slice();
                nextFiles[fileIdx] = {
                  ...file,
                  status: fileStatus as TransferFileNode["status"],
                  speed: formattedSpeed,
                  eta: formattedEta,
                };
              }
            }
          }

          const allFilesDone = nextFiles.every(
            (f) => f.status === "completed" || f.status === "error" || f.status === "cancelled",
          );
          const sessionStatus: TransferSessionNode["status"] = isFinalEvent
            ? (statusMap[status] || "waiting")
            : allFilesDone && status === "completed" ? "completed" : session.status;

          if (
            session.status === sessionStatus &&
            session.progress === sessionProgress &&
            session.completedCount === filesCompleted &&
            session.totalCount === filesTotal &&
            session.transferredBytes === bytesTransferred &&
            session.totalBytes === bytesTotal &&
            session.speed === formattedSpeed &&
            session.eta === formattedEta &&
            session.error === (error || undefined) &&
            nextFiles === session.files
          ) {
            return state;
          }

          const nextSessions = state.transferSessions.slice();
          nextSessions[sessionIdx] = {
            ...session,
            status: sessionStatus,
            progress: sessionProgress,
            completedCount: filesCompleted,
            totalCount: filesTotal,
            transferredBytes: bytesTransferred,
            totalBytes: bytesTotal,
            speed: formattedSpeed,
            eta: formattedEta,
            error: error || undefined,
            files: nextFiles,
          };

          return { transferSessions: nextSessions };
        });
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
