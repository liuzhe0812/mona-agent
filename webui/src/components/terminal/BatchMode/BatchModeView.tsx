import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "@/lib/tauri";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { open } from "@tauri-apps/plugin-dialog";
import {
  sshConnectWithId,
  sshTrustHostKey,
  onTerminalSessionStatus,
  sshDisconnect,
  sshSendInput,
  sftpList,
  sftpBatchUpload,
  sftpBatchCancel,
  sftpBatchPause,
  sftpBatchResume,
  sftpRemove,
  sftpRename,
  sftpMkdir,
  sftpDownload,
  sftpPaste,
  expandUploadPaths,
  onBatchTransferProgress,
} from "../ipc";
import type { BatchTransferProgress, FileInfo } from "../types/terminal";
import { useBatchStore } from "../store/batchStore";
import type { BatchSession, TransferSessionNode } from "../store/batchStore";
import { useTerminalStore } from "../store/terminalStore";
import {
  Play,
  Send,
  Terminal as TerminalIcon,
  FolderOpen,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Unplug,
  Trash2,
  Upload,
  Pause,
  X,
  CheckCircle,
  XCircle,
  Loader2,
  Clock,
  Folder,
  File,
  ChevronLeft,
  ArrowUp,
  Home,
  Download,
  Pencil,
  FolderPlus,
  Copy,
  Scissors,
  ClipboardPaste,
  ShieldAlert,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { memo } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const TransferFileItem = memo(function TransferFileItem({
  status,
  filename,
  speed,
}: {
  status: string;
  filename: string;
  speed: string;
}) {
  return (
    <div className="flex items-center gap-2 text-caption text-muted-foreground w-full min-w-0">
      {getStatusIcon(status)}
      <span className="truncate flex-1 min-w-0">{filename}</span>
      <span className="shrink-0">{speed}</span>
    </div>
  );
});

function generateIps(start: string, count: number): string[] {
  const parts = start.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return [];
  if (!Number.isInteger(count) || count < 1 || count > 100 || Number(parts[3]) + count > 256) return [];
  const base = parts.slice(0, 3).map(Number).join(".");
  return Array.from({ length: count }, (_, i) => `${base}.${Number(parts[3]) + i}`);
}

function connectionFailure(error: unknown): Partial<BatchSession> {
  const details = error instanceof Error ? error.message : String(error);
  const unknown = details.match(/Host key unknown:\s*(SHA256:\S+)/);
  const changed = details.match(/Host key changed: expected\s*(SHA256:\S+),\s*got\s*(SHA256:\S+)/);
  if (unknown || changed) return {
    status: "untrusted",
    error: changed ? "服务器的主机密钥与之前记录的不同，请核实后再连接。" : "首次连接，请核实服务器身份后继续。",
    hostKey: { type: changed ? "changed" : "unknown", fingerprint: changed?.[2] ?? unknown![1], expectedFingerprint: changed?.[1] },
  };
  return {
    status: "error", errorDetails: details,
    error: /authentication|auth failed|身份验证/i.test(details) ? "登录验证失败，请检查用户名和密码后重试。"
      : /timeout|timed out|超时/i.test(details) ? "连接超时，请检查主机地址、端口和网络后重试。"
      : /Config save failed/i.test(details) ? "无法保存主机信任记录，请检查本地存储权限后重试。"
      : "无法连接到这台主机，请检查地址、端口和网络后重试。",
  };
}

function formatSize(bytes: number | null): string {
  if (!bytes) return "-";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}

function getStatusIcon(status: string) {
  switch (status) {
    case "completed": return <CheckCircle className="h-3.5 w-3.5 text-success" />;
    case "error": return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    case "cancelled": return <XCircle className="h-3.5 w-3.5 text-muted-foreground" />;
    case "transferring": return <Loader2 className="h-3.5 w-3.5 text-info animate-spin" />;
    case "paused": return <Pause className="h-3.5 w-3.5 text-warning" />;
    default: return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

export function BatchModeView() {
  const store = useBatchStore();
  const {
    startIp, setStartIp,
    count, setCount,
    username, setUsername,
    password, setPassword,
    port, setPort,
    sessions, setSessions, updateSession,
    toggleSessionSelection, selectAllSessions, deselectAllSessions,
    activeSessionId, setActiveSessionId,
    commandInput, setCommandInput,
    isConnecting, setIsConnecting,
    configCollapsed, setConfigCollapsed,
    activeTab, setActiveTab,
    remotePath, setRemotePath,
    remoteFiles, setRemoteFiles,
    loadingFiles, setLoadingFiles,
    transferSessions, setTransferSessions,
    activeBatchId, setActiveBatchId,
    maxConcurrent, setMaxConcurrent,
    handleBatchProgress,
    selectedFilePaths,
    selectFile,
    clearFileSelection,
    clipboard,
    setClipboard,
    clearClipboard,
  } = store;

  const [collapsedTransfer, setCollapsedTransfer] = useState<Set<string>>(new Set());
  const [renameTarget, setRenameTarget] = useState<{ filePath: string; fileName: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [mkdirEditing, setMkdirEditing] = useState(false);
  const [mkdirValue, setMkdirValue] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const sftpAreaRef = useRef<HTMLDivElement>(null);
  const uploadLockRef = useRef(false);
  const progressQueueRef = useRef<BatchTransferProgress[]>([]);
  const rafRef = useRef<number | null>(null);
  const [connectionActionError, setConnectionActionError] = useState<string | null>(null);
  const [acceptNewHostKey, setAcceptNewHostKey] = useState(true);
  const [trustSessionId, setTrustSessionId] = useState<string | null>(null);
  const [trusting, setTrusting] = useState(false);
  const [trustError, setTrustError] = useState("");

  const terminalStoreActiveId = useTerminalStore((s) => s.activeSessionId);
  const terminalStoreSessions = useTerminalStore((s) => s.sessions);
  const isBatchVisible = terminalStoreSessions.find(
    (s) => s.id === terminalStoreActiveId,
  )?.type === "batch";
  const prevVisibleRef = useRef(isBatchVisible);

  useEffect(() => {
    if (isBatchVisible && !prevVisibleRef.current) {
      setTimeout(() => {
        fitAddonsRef.current.forEach((fitAddon, id) => {
          try {
            fitAddon.fit();
            const terminal = terminalsRef.current.get(id);
            if (terminal && id === activeSessionId) {
              terminal.scrollToBottom();
              terminal.focus();
            }
          } catch {}
        });
      }, 100);
    }
    prevVisibleRef.current = isBatchVisible;
  }, [isBatchVisible, activeSessionId]);

  const terminalRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const terminalsRef = useRef<Map<string, Terminal>>(new Map());
  const fitAddonsRef = useRef<Map<string, FitAddon>>(new Map());
  const unlistenersRef = useRef<Map<string, (() => void)[]>>(new Map());
  const resizeObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
  const terminalInputSetupRef = useRef<Set<string>>(new Set());
  const settingUpListenersRef = useRef<Set<string>>(new Set());

  const connectedCount = sessions.filter((s) => s.status === "connected").length;
  const selectedCount = sessions.filter((s) => s.selected && s.status === "connected").length;
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const trustSession = sessions.find((s) => s.id === trustSessionId);
  const ips = generateIps(startIp, count);
  const ipError = generateIps(startIp, 1).length ? "" : "请输入有效的 IPv4 地址。";
  const countError = !Number.isInteger(count) || count < 1 || count > 100 ? "数量须为 1–100 的整数。"
    : !ipError && !ips.length ? "地址末段不能超过 255，请减少数量。" : "";
  const portError = !Number.isInteger(port) || port < 1 || port > 65535 ? "端口须为 1–65535 的整数。" : "";
  const usernameError = username.trim() ? "" : "请输入用户名。";

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onTerminalSessionStatus(({ sessionId, status }) => {
      const session = useBatchStore.getState().sessions.find((item) => item.id === sessionId);
      if (session?.status !== "connected" || (status !== "disconnected" && status !== "error")) return;
      updateSession(sessionId, { status, error: status === "error" ? "连接已中断，请检查网络后重新连接。" : undefined });
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => setConnectionActionError("无法更新连接状态，请重新打开批量管理页面。"));
    return () => { disposed = true; unlisten?.(); };
  }, [updateSession]);

  const cleanupTerminal = useCallback((sessionId: string) => {
    const ro = resizeObserversRef.current.get(sessionId);
    if (ro) {
      const container = terminalRefs.current.get(sessionId);
      if (container) ro.unobserve(container);
      ro.disconnect();
      resizeObserversRef.current.delete(sessionId);
    }
    const fns = unlistenersRef.current.get(sessionId);
    if (fns) {
      fns.forEach((fn) => fn());
      unlistenersRef.current.delete(sessionId);
    }
    const terminal = terminalsRef.current.get(sessionId);
    if (terminal) {
      terminal.dispose();
      terminalsRef.current.delete(sessionId);
    }
    fitAddonsRef.current.delete(sessionId);
    terminalRefs.current.delete(sessionId);
    terminalInputSetupRef.current.delete(sessionId);
  }, []);

  useEffect(() => {
    sessions.forEach((session) => {
      if (
        !terminalsRef.current.has(session.id) &&
        terminalRefs.current.has(session.id)
      ) {
        const container = terminalRefs.current.get(session.id);
        if (!container) return;
        if (container.querySelector(".xterm")) return;
        container.innerHTML = "";

        const terminal = new Terminal({
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 13,
          scrollback: 50000,
          cursorBlink: true,
          cursorStyle: "block",
          theme: {
            background: "#0d0d0d",
            foreground: "#e0e0e0",
            cursor: "#ff6b35",
            selectionBackground: "#264f78",
          },
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(container);

        const performFit = () => {
          try { fitAddon.fit(); } catch {}
        };
        requestAnimationFrame(performFit);
        [50, 150, 350, 700, 1200].forEach((delay) =>
          setTimeout(performFit, delay),
        );

        terminalsRef.current.set(session.id, terminal);
        fitAddonsRef.current.set(session.id, fitAddon);

        terminal.writeln(
          `\x1b[38;5;208m╔══════════════════════════════════════╗\x1b[0m`,
        );
        terminal.writeln(
          `\x1b[38;5;208m║     Mona SSH Terminal               ║\x1b[0m`,
        );
        terminal.writeln(
          `\x1b[38;5;208m╚══════════════════════════════════════╝\x1b[0m`,
        );
        terminal.writeln("");
        terminal.writeln(
          `\x1b[38;5;75mConnecting to \x1b[1m${session.host}\x1b[0m\x1b[38;5;75m:${session.port}...\x1b[0m`,
        );
        terminal.writeln("");

        let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
        const resizeObserver = new ResizeObserver((entries) => {
          if (resizeTimeout) clearTimeout(resizeTimeout);
          resizeTimeout = setTimeout(() => {
            for (const entry of entries) {
              const { width, height } = entry.contentRect;
              if (width > 0 && height > 0) {
                try { fitAddon.fit(); } catch {}
              }
            }
          }, 150);
        });
        resizeObserver.observe(container);
        resizeObserversRef.current.set(session.id, resizeObserver);

        if (session.id === activeSessionId) {
          setTimeout(() => terminal.focus(), 100);
        }
      }
    });

    const currentSessionIds = new Set(sessions.map((s) => s.id));
    terminalsRef.current.forEach((_, sessionId) => {
      if (!currentSessionIds.has(sessionId)) {
        cleanupTerminal(sessionId);
      }
    });
  }, [sessions, activeSessionId, cleanupTerminal]);

  const setupDataListener = useCallback(
    async (sessionId: string) => {
      if (
        settingUpListenersRef.current.has(sessionId) ||
        unlistenersRef.current.has(sessionId)
      ) {
        return;
      }
      settingUpListenersRef.current.add(sessionId);

      try {
        const unlisten = await listen<string>(
          `terminal-output`,
          (event) => {
            const payload = event.payload as unknown as {
              sessionId: string;
              data: string;
            };
            if (payload.sessionId === sessionId) {
              const terminal = terminalsRef.current.get(sessionId);
              if (terminal) {
                terminal.write(payload.data);
              }
            }
          },
        );

        unlistenersRef.current.set(sessionId, [unlisten]);
      } finally {
        settingUpListenersRef.current.delete(sessionId);
      }
    },
    [],
  );

  const setupTerminalInput = useCallback((sessionId: string) => {
    if (terminalInputSetupRef.current.has(sessionId)) return;
    const terminal = terminalsRef.current.get(sessionId);
    if (!terminal) return;

    terminal.onData(async (data) => {
      try {
        await sshSendInput(sessionId, data);
      } catch {}
    });

    terminalInputSetupRef.current.add(sessionId);
  }, []);

  useEffect(() => {
    const setupListeners = async () => {
      for (const session of sessions) {
        if (session.status === "connected") {
          if (!unlistenersRef.current.has(session.id)) {
            await setupDataListener(session.id);
          }
          if (!terminalInputSetupRef.current.has(session.id)) {
            setupTerminalInput(session.id);
          }
        }
      }
    };
    setupListeners();
  }, [sessions, setupDataListener, setupTerminalInput]);

  useEffect(() => {
    if (activeSessionId) {
      const fitAddon = fitAddonsRef.current.get(activeSessionId);
      const terminal = terminalsRef.current.get(activeSessionId);
      if (fitAddon && terminal) {
        const adjust = () => {
          try {
            fitAddon.fit();
            terminal.scrollToBottom();
            terminal.focus();
          } catch {}
        };
        adjust();
        [50, 150, 350, 700].forEach((d) => setTimeout(adjust, d));
      }
    }
  }, [activeSessionId]);

  const connectSession = async (session: BatchSession) => {
    updateSession(session.id, { status: "connecting", error: undefined, errorDetails: undefined, hostKey: undefined });
    try {
      await sshConnectWithId(session.id, {
        id: "", name: session.host, protocol: "ssh", host: session.host,
        port: session.port, username: session.username,
        auth: { type: "password", password: session.password || "" },
      }, undefined, undefined, acceptNewHostKey);
      updateSession(session.id, { status: "connected", selected: true, connectedAt: Date.now() });
    } catch (error) {
      updateSession(session.id, connectionFailure(error));
    }
  };

  const handleBatchConnect = async () => {
    if (isConnecting || connectedCount > 0 || !ips.length || portError || usernameError) return;
    setIsConnecting(true);

    const newSessions: BatchSession[] = ips.map((ip, index) => ({
      id: `batch-${Date.now()}-${index}`,
      host: ip,
      port,
      username: username.trim(),
      password: password || undefined,
      status: "connecting",
      selected: false,
    }));

    setSessions(newSessions);
    setActiveSessionId(newSessions[0].id);
    setActiveTab("terminal");

    const maxConc = 3;
    for (let i = 0; i < newSessions.length; i += maxConc) {
      const batch = newSessions.slice(i, i + maxConc);
      await Promise.all(batch.map(connectSession));
    }

    setIsConnecting(false);

    const currentSessions = useBatchStore.getState().sessions;
    const firstConnected = currentSessions.find((s) => s.status === "connected");
    if (firstConnected) {
      setActiveSessionId(firstConnected.id);
      setConfigCollapsed(true);
    }
  };

  const handleReconnectSession = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session || session.status === "connecting") return;
    await connectSession(session);
  };

  const handleTrustSession = async () => {
    if (!trustSession?.hostKey || trusting) return;
    setTrusting(true);
    setTrustError("");
    try {
      await sshTrustHostKey(trustSession.host, trustSession.port, trustSession.hostKey.fingerprint);
      setTrustSessionId(null);
      await connectSession(trustSession);
    } catch {
      setTrustError("无法保存该主机的信任记录，请重新连接以获取最新指纹后重试。");
    } finally {
      setTrusting(false);
    }
  };

  const handleDisconnectSession = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session || session.status !== "connected") return;
    try {
      await sshDisconnect(sessionId);
      cleanupTerminal(sessionId);
      updateSession(sessionId, { status: "disconnected" });
      if (activeSessionId === sessionId) setActiveSessionId(null);
    } catch {
      setConnectionActionError("未能确认断开连接，请查看该主机的终端状态后重试。");
    }
  };

  const handleDeleteSession = (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    if (session.status === "connected" || session.status === "connecting") return;
    cleanupTerminal(sessionId);
    setSessions(sessions.filter((s) => s.id !== sessionId));
    if (activeSessionId === sessionId) setActiveSessionId(null);
  };

  const handleDisconnectAllSessions = async () => {
    if (isConnecting) return;
    const connected = sessions.filter((s) => s.status === "connected");
    let failed = 0;
    for (const session of connected) {
      try {
        await sshDisconnect(session.id);
        cleanupTerminal(session.id);
        updateSession(session.id, { status: "disconnected" });
      } catch { failed++; }
    }
    if (!useBatchStore.getState().sessions.some((s) => s.id === activeSessionId && s.status === "connected")) {
      setActiveSessionId(null);
    }
    if (failed) setConnectionActionError(`${failed} 台主机未能确认断开，请查看对应终端状态后重试。`);
  };

  const handleDeleteDisconnectedSessions = () => {
    const toRemove = sessions.filter(
      (s) => s.status === "disconnected" || s.status === "error",
    );
    for (const session of toRemove) {
      cleanupTerminal(session.id);
    }
    setSessions(sessions.filter((s) => s.status !== "disconnected" && s.status !== "error"));
    if (toRemove.some((s) => s.id === activeSessionId)) {
      setActiveSessionId(null);
    }
  };

  const handleSendCommand = async () => {
    if (!commandInput.trim()) return;
    const targets = sessions.filter((s) => s.selected && s.status === "connected");
    if (targets.length === 0) return;
    for (const session of targets) {
      try {
        await sshSendInput(session.id, commandInput + "\n");
      } catch {}
    }
    setCommandInput("");
  };

  const getStatusColor = (status: BatchSession["status"]) => {
    switch (status) {
      case "connected": return "bg-success-indicator";
      case "connecting": return "bg-warning animate-pulse";
      case "untrusted": return "bg-warning";
      case "error": return "bg-destructive";
      default: return "bg-muted-foreground/40";
    }
  };

  const getActiveSession = () =>
    activeSessionId
      ? sessions.find((s) => s.id === activeSessionId)
      : sessions.find((s) => s.status === "connected");

  const loadRemoteFiles = async (path: string) => {
    const session = getActiveSession();
    if (!session) return;
    setLoadingFiles(true);
    clearFileSelection();
    try {
      const files = await sftpList(session.id, path);
      setRemoteFiles(files);
      setRemotePath(path);
    } catch (err) {
      console.error("加载远程文件失败:", err);
    } finally {
      setLoadingFiles(false);
    }
  };

  const handleFileClick = (file: FileInfo, _index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      selectFile(file.path, true);
    } else if (e.shiftKey) {
      e.preventDefault();
      selectFile(file.path, false, true, remoteFiles);
    } else {
      selectFile(file.path);
      if (file.isDir) {
        loadRemoteFiles(file.path);
      }
    }
  };

  const handleDeleteFile = async (file: FileInfo) => {
    const session = getActiveSession();
    if (!session) return;
    const targets = getSelectedFiles(file);
    try {
      for (const f of targets) {
        await sftpRemove(session.id, f.path, f.isDir);
      }
      clearFileSelection();
      await loadRemoteFiles(remotePath);
    } catch (err) {
      console.error("删除失败:", err);
      await loadRemoteFiles(remotePath);
    }
  };

  const handleBatchDownload = async (file: FileInfo) => {
    const session = getActiveSession();
    const targets = getSelectedFiles(file).filter((f) => !f.isDir);
    if (targets.length === 0 || !session) return;
    for (const f of targets) {
      try {
        const data = await sftpDownload(session.id, f.path);
        const blob = new Blob([new Uint8Array(data)]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = f.name;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error(`下载 ${f.name} 失败:`, err);
      }
    }
  };

  const handleRenameFile = async () => {
    const session = getActiveSession();
    if (!session || !renameTarget || !renameValue.trim()) {
      setRenameTarget(null);
      return;
    }
    const parent = renameTarget.filePath.substring(0, renameTarget.filePath.lastIndexOf("/")) || "/";
    const newPath = parent + "/" + renameValue.trim();
    try {
      await sftpRename(session.id, renameTarget.filePath, newPath);
      await loadRemoteFiles(remotePath);
    } catch (err) {
      console.error("重命名失败:", err);
    } finally {
      setRenameTarget(null);
      setRenameValue("");
    }
  };

  const startRename = (filePath: string, fileName: string) => {
    setRenameTarget({ filePath, fileName });
    setRenameValue(fileName);
  };

  const handleDownloadFile = async (file: FileInfo) => {
    const session = getActiveSession();
    if (!session || file.isDir) return;
    try {
      const data = await sftpDownload(session.id, file.path);
      const blob = new Blob([new Uint8Array(data)]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("下载失败:", err);
    }
  };

  const handleMkdir = async () => {
    const session = getActiveSession();
    if (!session || !mkdirValue.trim()) {
      setMkdirEditing(false);
      setMkdirValue("");
      return;
    }
    const path = remotePath.endsWith("/") ? remotePath + mkdirValue.trim() : remotePath + "/" + mkdirValue.trim();
    try {
      await sftpMkdir(session.id, path);
      await loadRemoteFiles(remotePath);
    } catch (err) {
      console.error("创建文件夹失败:", err);
    } finally {
      setMkdirEditing(false);
      setMkdirValue("");
    }
  };

  const handleCopyFiles = (files: FileInfo[]) => {
    setClipboard(files.map((f) => ({ path: f.path, isDir: f.isDir, action: "copy" as const })));
  };

  const handleCutFiles = (files: FileInfo[]) => {
    setClipboard(files.map((f) => ({ path: f.path, isDir: f.isDir, action: "cut" as const })));
  };

  const handlePasteFiles = async () => {
    const session = getActiveSession();
    if (!session || clipboard.length === 0) return;
    const srcPaths = clipboard.map((c) => c.path);
    const action = clipboard[0].action;
    try {
      await sftpPaste(session.id, srcPaths, remotePath, action);
      clearClipboard();
      clearFileSelection();
      await loadRemoteFiles(remotePath);
    } catch (err) {
      console.error("粘贴失败:", err);
    }
  };

  const getSelectedFiles = (clickedFile: FileInfo): FileInfo[] => {
    if (selectedFilePaths.has(clickedFile.path)) {
      return remoteFiles.filter((f) => selectedFilePaths.has(f.path));
    }
    return [clickedFile];
  };

  const startUpload = async (files: string[]) => {
    const selectedSessions = sessions.filter(
      (s) => s.selected && s.status === "connected",
    );
    if (selectedSessions.length === 0 || files.length === 0) return;

    // 调用后端展开文件夹，获取完整文件列表用于展示
    let expandedEntries: { localPath: string; relPrefix: string; displayName: string }[] = [];
    try {
      expandedEntries = await expandUploadPaths(files);
    } catch (err) {
      console.error("展开文件列表失败:", err);
      expandedEntries = files.map((p) => {
        const name = p.split(/[\\/]/).pop() || "";
        return { localPath: p, relPrefix: "", displayName: name };
      });
    }

    const newTransferSessions: TransferSessionNode[] = selectedSessions.map(
      (session) => ({
        id: session.id,
        host: session.host,
        status: "transferring",
        expanded: true,
        files: expandedEntries.map((entry) => ({
          id: `upload-${session.id}-${entry.displayName}`,
          filename: entry.displayName,
          status: "waiting",
          speed: "0 B/s",
          eta: "等待中...",
        })),
        progress: 0,
        completedCount: 0,
        totalCount: expandedEntries.length,
        totalBytes: 0,
        transferredBytes: 0,
        speed: "0 B/s",
        eta: "计算中...",
      }),
    );
    setTransferSessions(newTransferSessions);

    const batchSessionInfos = selectedSessions.map((s) => ({
      sessionId: s.id,
      host: s.host,
      port: s.port,
      username: s.username,
    }));

    try {
      const batchId = await sftpBatchUpload({
        sessions: batchSessionInfos,
        files,
        targetDirectory: remotePath,
        maxConcurrent,
      });
      setActiveBatchId(batchId);
    } catch (err) {
      console.error("批量上传失败:", err);
    }
  };

  const handleUpload = async () => {
    if (uploadLockRef.current) return;
    uploadLockRef.current = true;
    try {
      const selected = await open({ multiple: true, directory: false });
      if (!selected || (Array.isArray(selected) && selected.length === 0)) return;
      const files = Array.isArray(selected) ? selected : [selected];
      await startUpload(files);
    } finally {
      uploadLockRef.current = false;
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;

    const isInsideSftpArea = (pos: { x: number; y: number }) => {
      const el = sftpAreaRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return (
        pos.x / dpr >= rect.left &&
        pos.x / dpr <= rect.right &&
        pos.y / dpr >= rect.top &&
        pos.y / dpr <= rect.bottom
      );
    };

    getCurrentWebview().onDragDropEvent((event) => {
      if (activeTab !== "sftp") return;

      switch (event.payload.type) {
        case "enter":
        case "over":
          if ("position" in event.payload) {
            setIsDragOver(isInsideSftpArea(event.payload.position));
          }
          break;
        case "drop":
          setIsDragOver(false);
          if (!("paths" in event.payload) || !("position" in event.payload)) return;
          if (!isInsideSftpArea(event.payload.position)) return;
          if (!event.payload.paths || event.payload.paths.length === 0) return;
          {
            const selectedSessions = sessions.filter(
              (s) => s.selected && s.status === "connected",
            );
            if (selectedSessions.length === 0) return;
            startUpload(event.payload.paths);
          }
          break;
        case "leave":
          setIsDragOver(false);
          break;
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [activeTab, sessions, startUpload]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const flushProgress = () => {
      const queue = progressQueueRef.current;
      if (queue.length === 0) {
        rafRef.current = null;
        return;
      }
      const latestBySession = new Map<string, BatchTransferProgress>();
      for (const p of queue) {
        latestBySession.set(p.sessionId, p);
      }
      progressQueueRef.current = [];
      for (const p of latestBySession.values()) {
        handleBatchProgress(p);
      }
      rafRef.current = null;
    };

    const enqueueProgress = (progress: BatchTransferProgress) => {
      progressQueueRef.current.push(progress);
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushProgress);
      }
    };

    onBatchTransferProgress((progress: BatchTransferProgress) => {
      enqueueProgress(progress);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [handleBatchProgress]);

  useEffect(() => {
    if (activeSessionId) {
      const session = sessions.find((s) => s.id === activeSessionId);
      const defaultPath =
        session?.username === "root"
          ? "/root"
          : `/home/${session?.username}`;
      loadRemoteFiles(defaultPath || "/root");
    }
  }, [activeSessionId]);

  return (
    <div className="flex h-full">
      <div className="flex w-64 shrink-0 flex-col border-r bg-secondary/30">
        <div
          className={cn(
            "border-b transition-all",
            configCollapsed ? "p-2" : "p-3",
          )}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-caption font-medium">批量连接配置</h3>
            <Button
              variant="ghost"
              size="icon"
              aria-label={configCollapsed ? "展开配置" : "收起配置"}
              title={configCollapsed ? "展开配置" : "收起配置"}
              onClick={() => setConfigCollapsed(!configCollapsed)}
              className="h-6 w-6"
            >
              {configCollapsed ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronUp className="h-3 w-3" />
              )}
            </Button>
          </div>
          <div
            aria-hidden={configCollapsed}
            inert={configCollapsed}
            className={cn(
              "space-y-2 overflow-hidden transition-all",
              configCollapsed ? "h-0 opacity-0 mt-0" : "h-auto opacity-100 mt-2",
            )}
          >
            <div className="grid grid-cols-[1fr_70px] gap-2">
              <div>
                <Label htmlFor="batch-start-ip" className="text-caption">起始 IP</Label>
                <Input id="batch-start-ip" value={startIp} onChange={(e) => setStartIp(e.target.value)} disabled={isConnecting} aria-invalid={!!ipError} aria-describedby={ipError ? "batch-ip-error" : undefined} className="h-7 text-caption" />
                {ipError && <p id="batch-ip-error" className="mt-1 text-caption text-destructive">{ipError}</p>}
              </div>
              <div>
                <Label htmlFor="batch-count" className="text-caption">数量</Label>
                <Input id="batch-count" type="number" min={1} max={100} step={1} value={count || ""} onChange={(e) => setCount(Number(e.target.value))} disabled={isConnecting} aria-invalid={!!countError} aria-describedby={countError ? "batch-count-error" : undefined} className="h-7 text-caption px-2" />
                {countError && <p id="batch-count-error" className="mt-1 text-caption text-destructive">{countError}</p>}
              </div>
            </div>
            <div className="grid grid-cols-[1fr_70px] gap-2">
              <div>
                <Label htmlFor="batch-username" className="text-caption">用户名</Label>
                <Input id="batch-username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={isConnecting} aria-invalid={!!usernameError} aria-describedby={usernameError ? "batch-username-error" : undefined} className="h-7 text-caption" />
                {usernameError && <p id="batch-username-error" className="mt-1 text-caption text-destructive">{usernameError}</p>}
              </div>
              <div>
                <Label htmlFor="batch-port" className="text-caption">端口</Label>
                <Input id="batch-port" type="number" min={1} max={65535} step={1} value={port || ""} onChange={(e) => setPort(Number(e.target.value))} disabled={isConnecting} aria-invalid={!!portError} aria-describedby={portError ? "batch-port-error" : undefined} className="h-7 text-caption px-2" />
                {portError && <p id="batch-port-error" className="mt-1 text-caption text-destructive">{portError}</p>}
              </div>
            </div>
            <div>
              <Label htmlFor="batch-password" className="text-caption">密码</Label>
              <Input id="batch-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={isConnecting} className="h-7 text-caption" />
            </div>
            <div className="flex items-start gap-2">
              <Checkbox id="batch-accept-new" checked={acceptNewHostKey} onCheckedChange={(checked) => setAcceptNewHostKey(checked === true)} disabled={isConnecting} />
              <Label htmlFor="batch-accept-new" className="text-caption leading-normal">自动信任首次连接的主机</Label>
            </div>
            <div className="flex gap-2">
              <Button size="sm" className="flex-1 h-7 text-caption" onClick={handleBatchConnect} disabled={isConnecting || connectedCount > 0 || !!ipError || !!countError || !!portError || !!usernameError}>
                <Play className="mr-1 h-3 w-3" />
                {isConnecting ? "连接中..." : "开始连接"}
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-caption" onClick={handleDisconnectAllSessions} disabled={isConnecting || connectedCount === 0}>
                <Unplug className="mr-1 h-3 w-3" />断开全部
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          <div className="flex items-center justify-between border-b px-2 py-1.5">
            <span className="text-caption font-medium text-muted-foreground">
              已连接 {connectedCount}/{sessions.length}
            </span>
            <div className="flex gap-1">
              <Button variant="link" size="xs" onClick={selectAllSessions} className="h-auto px-1 py-0">全选</Button>
              <span className="text-caption text-muted-foreground">|</span>
              <Button variant="link" size="xs" onClick={deselectAllSessions} className="h-auto px-1 py-0">取消选择</Button>
            </div>
          </div>
          <ScrollArea className="h-[calc(100%-32px)]">
            <div className="space-y-0.5 p-1">
              {sessions.map((session) => (
                <ContextMenu key={session.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={cn(
                        "flex items-center gap-2 rounded px-2 py-1 text-caption cursor-pointer transition-colors",
                        activeSessionId === session.id ? "bg-primary/10" : "hover:bg-accent",
                      )}
                      onClick={() => setActiveSessionId(session.id)}
                    >
                      <Checkbox
                        checked={session.selected && session.status === "connected"}
                        aria-label={`将 ${session.host} 加入批量发送`}
                        onCheckedChange={() => toggleSessionSelection(session.id)}
                        disabled={session.status !== "connected"}
                        className="h-3 w-3"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className={cn("h-1.5 w-1.5 rounded-full shrink-0", getStatusColor(session.status))} />
                      <span className="truncate flex-1" title={session.host}>{session.host}</span>
                      {session.status === "untrusted" && <span className="shrink-0 text-warning text-caption">{session.hostKey?.type === "changed" ? "密钥变更" : "待确认"}</span>}
                      {session.status === "error" && <span className="shrink-0 text-destructive text-caption">连接失败</span>}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-36">
                    {session.status === "untrusted" && (
                      <ContextMenuItem onClick={() => { setTrustError(""); setTrustSessionId(session.id); }}>
                        <ShieldAlert className="mr-2 h-3 w-3" /> 确认主机身份
                      </ContextMenuItem>
                    )}
                    {(session.status === "error" || session.status === "disconnected" || session.status === "untrusted") && (
                      <ContextMenuItem onClick={() => handleReconnectSession(session.id)}>
                        <RefreshCw className="mr-2 h-3 w-3" /> {session.hostKey ? "重新获取指纹" : "重连"}
                      </ContextMenuItem>
                    )}
                    {session.status === "connected" && (
                      <ContextMenuItem onClick={() => handleDisconnectSession(session.id)}>
                        <Unplug className="mr-2 h-3 w-3" /> 断开
                      </ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onClick={() => handleDeleteSession(session.id)}
                      disabled={session.status === "connected" || session.status === "connecting"}
                      className={session.status !== "connected" ? "text-destructive" : "text-muted-foreground"}
                    >
                      <Trash2 className="mr-2 h-3 w-3" /> 删除
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem disabled={isConnecting || connectedCount === 0} onClick={() => handleDisconnectAllSessions()}>
                      <Unplug className="mr-2 h-3 w-3" /> 断开全部会话
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handleDeleteDisconnectedSessions()}>
                      <Trash2 className="mr-2 h-3 w-3" /> 删除断开会话
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
              {sessions.length === 0 && (
                <div className="py-6 text-center text-caption text-muted-foreground">
                  配置IP范围后点击"开始连接"
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      <div className="flex flex-1 flex-col min-w-0">
        <div className="border-b bg-card px-3 py-1">
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setActiveTab("terminal")}
              className={cn(
                "h-7 gap-1 px-2.5 text-caption font-medium",
                activeTab === "terminal" ? "bg-accent text-foreground" : "text-muted-foreground",
              )}
            >
              <TerminalIcon className="w-3 h-3" /> 终端
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setActiveTab("sftp")}
              className={cn(
                "h-7 gap-1 px-2.5 text-caption font-medium",
                activeTab === "sftp" ? "bg-accent text-foreground" : "text-muted-foreground",
              )}
            >
              <FolderOpen className="w-3 h-3" /> 文件传输
            </Button>
          </div>
        </div>

        <div className="flex-1 flex flex-col min-h-0 relative">
          <div
            className={cn(
              "absolute inset-0 flex flex-col",
              activeTab === "terminal" ? "opacity-100 pointer-events-auto z-10" : "opacity-0 pointer-events-none z-0",
            )}
          >
            <div className="flex-1 flex flex-col bg-[#0d0d0d]">
              {activeSession && (
                <div className="flex items-center justify-between border-b border-border/20 bg-[#1a1a1a] px-4 py-1.5">
                  <div className="flex items-center gap-2">
                    <TerminalIcon className="h-4 w-4 text-slate-400" />
                    <span className="text-body text-slate-200">
                      {activeSession.username}@{activeSession.host}
                    </span>
                  </div>
                </div>
              )}
              <div className="flex-1 relative overflow-hidden">
                {sessions.length > 0 ? (
                  sessions.map((session) => (
                    <div
                      key={session.id}
                      className={cn(
                        "absolute inset-x-0 top-0 bottom-0 px-2 pt-2",
                        activeSessionId === session.id ? "opacity-100 pointer-events-auto z-10" : "opacity-0 pointer-events-none z-0",
                      )}
                    >
                      {activeSessionId === session.id && (session.status === "error" || session.status === "untrusted") && (
                        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/95 text-foreground">
                          <div className="text-center max-w-sm p-4">
                            {session.hostKey ? <ShieldAlert className="h-10 w-10 text-warning mx-auto mb-3" /> : <XCircle className="h-10 w-10 text-destructive mx-auto mb-3" />}
                            <p className="text-body font-medium mb-1">{session.hostKey?.type === "changed" ? "主机密钥已变更" : session.hostKey ? "等待信任主机" : "连接失败"}</p>
                            <p className="text-caption text-muted-foreground mb-3">{session.host}</p>
                            <p className="text-caption text-muted-foreground">
                              {session.error || "请检查主机地址和网络后重试。"}
                            </p>
                            {session.errorDetails && <details className="mt-2 text-left text-caption text-muted-foreground"><summary className="cursor-pointer">诊断详情</summary><p className="mt-1 break-all font-mono">{session.errorDetails}</p></details>}
                            <Button
                              size="sm"
                              variant="outline"
                              className="mt-3 h-7 text-caption"
                              onClick={() => {
                                if (session.hostKey) { setTrustError(""); setTrustSessionId(session.id); }
                                else void handleReconnectSession(session.id);
                              }}
                            >
                              <RefreshCw className="mr-1 h-3 w-3" /> {session.hostKey?.type === "changed" ? "核实主机身份" : session.hostKey ? "信任并连接" : "重新连接"}
                            </Button>
                          </div>
                        </div>
                      )}
                      <div
                        ref={(el) => {
                          if (el) {
                            const currentEl = terminalRefs.current.get(session.id);
                            if (currentEl !== el) {
                              terminalRefs.current.set(session.id, el);
                            }
                          }
                        }}
                        className="w-full h-full"
                      />
                    </div>
                  ))
                ) : (
                  <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
                    <TerminalIcon className="mb-4 h-16 w-16 opacity-20" />
                    <p className="text-body">选择一个会话查看终端</p>
                  </div>
                )}
              </div>
            </div>
            {connectedCount > 0 && (
              <div className="border-t bg-card p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-caption font-medium">批量发送</span>
                  <span className="text-caption text-muted-foreground">发送至 {selectedCount} 台主机</span>
                </div>
                <div className="flex gap-2">
                  <Textarea
                    value={commandInput}
                    onChange={(e) => setCommandInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.ctrlKey && e.key === "Enter") {
                        e.preventDefault();
                        handleSendCommand();
                      }
                    }}
                    placeholder="输入命令... (Ctrl+Enter 发送)"
                    className="h-16 min-h-0 w-full resize-none px-3 py-2 font-mono text-caption"
                  />
                  <div className="flex flex-col gap-1.5">
                    <Button size="sm" className="h-7 text-caption" onClick={handleSendCommand} disabled={selectedCount === 0 || !commandInput.trim()}>
                      <Send className="mr-1 h-3 w-3" /> 发送
                    </Button>
                    <Button size="sm" variant="secondary" className="h-7 text-caption" onClick={() => setCommandInput("")} disabled={!commandInput.trim()}>
                      清空
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div
            className={cn(
              "absolute inset-0 flex flex-col",
              activeTab === "sftp" ? "opacity-100 pointer-events-auto z-10" : "opacity-0 pointer-events-none z-0",
            )}
          >
            {connectedCount > 0 ? (
              <div className="flex flex-1 min-h-0">
                <div
                  ref={sftpAreaRef}
                  className="relative flex flex-col flex-1 min-w-0 min-h-0"
                  onDragEnter={handleDragEnter}
                  onDragOver={handleDragOver}
                >
                  {isDragOver && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary/60 rounded pointer-events-none">
                      <div className="flex flex-col items-center gap-2 text-primary">
                        <Upload className="h-8 w-8" />
                        <span className="text-body font-medium">松开以上传到 {remotePath}</span>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b">
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { const parent = remotePath.substring(0, remotePath.lastIndexOf("/")) || "/"; loadRemoteFiles(parent); }} disabled={remotePath === "/"}>
                      <ChevronLeft className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { const parent = remotePath.substring(0, remotePath.lastIndexOf("/")) || "/"; loadRemoteFiles(parent); }} disabled={remotePath === "/"}>
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Input value={remotePath} onChange={(e) => setRemotePath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") loadRemoteFiles(remotePath); }} className="h-6 text-caption flex-1" />
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => loadRemoteFiles("/")}>
                      <Home className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => loadRemoteFiles(remotePath)} disabled={loadingFiles}>
                      <RefreshCw className={cn("h-3 w-3", loadingFiles && "animate-spin")} />
                    </Button>
                    <div className="border-l pl-2 flex gap-1">
                      <Button variant="outline" size="sm" className="h-6 text-caption gap-1" onClick={handleUpload} disabled={sessions.filter((s) => s.selected).length === 0}>
                        <Upload className="h-3 w-3" /> 上传
                      </Button>
                    </div>
                  </div>
                  <ScrollArea className="flex-1">
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div className="min-w-[400px]" onClick={() => clearFileSelection()}>
                          <div className="flex text-caption font-medium text-muted-foreground bg-secondary border-b sticky top-0">
                            <div className="px-2 py-1 w-[200px] shrink-0">名称</div>
                            <div className="px-2 py-1 w-20 shrink-0 text-right">大小</div>
                            <div className="px-2 py-1 w-16 shrink-0 text-right">类型</div>
                          </div>
                          {mkdirEditing && (
                            <div className="flex items-center text-caption" style={{ height: 26 }}>
                              <div className="px-2 w-[200px] shrink-0 flex items-center gap-1.5">
                                <Folder className="h-3.5 w-3.5 text-primary shrink-0" />
                                <Input
                                  autoFocus
                                  value={mkdirValue}
                                  onChange={(e) => setMkdirValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.stopPropagation();
                                      handleMkdir();
                                    } else if (e.key === "Escape") {
                                      e.stopPropagation();
                                      setMkdirEditing(false);
                                      setMkdirValue("");
                                    }
                                  }}
                                  onBlur={() => {
                                    handleMkdir();
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  placeholder="新文件夹"
                                  className="h-5 min-w-0 flex-1 px-1 text-caption"
                                />
                              </div>
                              <div className="px-2 w-20 shrink-0 text-right text-muted-foreground">-</div>
                              <div className="px-2 w-16 shrink-0 text-right text-muted-foreground">文件夹</div>
                            </div>
                          )}
                          {remoteFiles.map((file, index) => (
                            <ContextMenu key={file.path}>
                              <ContextMenuTrigger asChild>
                                <div
                                  className={cn(
                                    "flex items-center text-caption cursor-pointer hover:bg-blue-500/10",
                                    selectedFilePaths.has(file.path) && "bg-blue-500/20 hover:bg-blue-500/20",
                                  )}
                                  style={{ height: 26 }}
                                  onClick={(e) => handleFileClick(file, index, e)}
                                >
                                  <div className="px-2 w-[200px] shrink-0 flex items-center gap-1.5">
                                    {file.isDir ? <Folder className="h-3.5 w-3.5 text-yellow-500 shrink-0" /> : <File className="h-3.5 w-3.5 text-gray-400 shrink-0" />}
                                    {renameTarget?.filePath === file.path ? (
                                      <Input
                                        autoFocus
                                        value={renameValue}
                                        onChange={(e) => setRenameValue(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            e.stopPropagation();
                                            handleRenameFile();
                                          } else if (e.key === "Escape") {
                                            e.stopPropagation();
                                            setRenameTarget(null);
                                            setRenameValue("");
                                          }
                                        }}
                                        onBlur={() => {
                                          handleRenameFile();
                                        }}
                                        onClick={(e) => e.stopPropagation()}
                                        className="h-5 flex-1 min-w-0 rounded px-1 py-0 text-caption"
                                      />
                                    ) : (
                                      <span className="truncate">{file.name}</span>
                                    )}
                                  </div>
                                  <div className="px-2 w-20 shrink-0 text-right text-muted-foreground">{file.isDir ? "-" : formatSize(file.size)}</div>
                                  <div className="px-2 w-16 shrink-0 text-right text-muted-foreground">{file.isDir ? "文件夹" : "文件"}</div>
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent className="w-48">
                                {(() => {
                                  const selectedCount = getSelectedFiles(file).length;
                                  const isMulti = selectedCount > 1;
                                  return (
                                    <>
                                      {isMulti ? (
                                        <>
                                          <ContextMenuItem onClick={() => handleBatchDownload(file)}>
                                            <Download className="mr-2 h-3.5 w-3.5" /> 下载 ({selectedCount}项)
                                          </ContextMenuItem>
                                          <ContextMenuSeparator />
                                          <ContextMenuItem onClick={() => handleCopyFiles(getSelectedFiles(file))}>
                                            <Copy className="mr-2 h-3.5 w-3.5" /> 复制 ({selectedCount}项)
                                          </ContextMenuItem>
                                          <ContextMenuItem onClick={() => handleCutFiles(getSelectedFiles(file))}>
                                            <Scissors className="mr-2 h-3.5 w-3.5" /> 剪切 ({selectedCount}项)
                                          </ContextMenuItem>
                                          {clipboard.length > 0 && (
                                            <ContextMenuItem onClick={() => handlePasteFiles()}>
                                              <ClipboardPaste className="mr-2 h-3.5 w-3.5" /> 粘贴
                                            </ContextMenuItem>
                                          )}
                                          <ContextMenuSeparator />
                                          <ContextMenuItem onClick={() => handleDeleteFile(file)} className="text-destructive">
                                            <Trash2 className="mr-2 h-3.5 w-3.5" /> 删除 ({selectedCount}项)
                                          </ContextMenuItem>
                                        </>
                                      ) : (
                                        <>
                                          {file.isDir && (
                                            <ContextMenuItem onClick={() => loadRemoteFiles(file.path)}>
                                              <FolderOpen className="mr-2 h-3.5 w-3.5" /> 打开
                                            </ContextMenuItem>
                                          )}
                                          {!file.isDir && (
                                            <ContextMenuItem onClick={() => handleDownloadFile(file)}>
                                              <Download className="mr-2 h-3.5 w-3.5" /> 下载
                                            </ContextMenuItem>
                                          )}
                                          <ContextMenuSeparator />
                                          <ContextMenuItem onClick={() => handleCopyFiles(getSelectedFiles(file))}>
                                            <Copy className="mr-2 h-3.5 w-3.5" /> 复制
                                          </ContextMenuItem>
                                          <ContextMenuItem onClick={() => handleCutFiles(getSelectedFiles(file))}>
                                            <Scissors className="mr-2 h-3.5 w-3.5" /> 剪切
                                          </ContextMenuItem>
                                          {clipboard.length > 0 && (
                                            <ContextMenuItem onClick={() => handlePasteFiles()}>
                                              <ClipboardPaste className="mr-2 h-3.5 w-3.5" /> 粘贴
                                            </ContextMenuItem>
                                          )}
                                          <ContextMenuSeparator />
                                          <ContextMenuItem onClick={() => startRename(file.path, file.name)}>
                                            <Pencil className="mr-2 h-3.5 w-3.5" /> 重命名
                                          </ContextMenuItem>
                                          <ContextMenuItem onClick={() => handleDeleteFile(file)} className="text-destructive">
                                            <Trash2 className="mr-2 h-3.5 w-3.5" /> 删除
                                          </ContextMenuItem>
                                        </>
                                      )}
                                    </>
                                  );
                                })()}
                              </ContextMenuContent>
                            </ContextMenu>
                          ))}
                          {remoteFiles.length === 0 && !loadingFiles && (
                            <div className="py-8 text-center text-caption text-muted-foreground">空文件夹</div>
                          )}
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-48">
                        <ContextMenuItem onClick={() => { setMkdirEditing(true); setMkdirValue(""); }}>
                          <FolderPlus className="mr-2 h-3.5 w-3.5" /> 新建文件夹
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => handleUpload()}>
                          <Upload className="mr-2 h-3.5 w-3.5" /> 上传
                        </ContextMenuItem>
                        {clipboard.length > 0 && (
                          <ContextMenuItem onClick={() => handlePasteFiles()}>
                            <ClipboardPaste className="mr-2 h-3.5 w-3.5" /> 粘贴
                          </ContextMenuItem>
                        )}
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => loadRemoteFiles(remotePath)}>
                          <RefreshCw className="mr-2 h-3.5 w-3.5" /> 刷新
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  </ScrollArea>
                  <div className="flex items-center justify-between px-3 py-1 border-t text-caption text-muted-foreground">
                    <span>{remoteFiles.filter((f) => f.isDir).length} 个文件夹, {remoteFiles.filter((f) => !f.isDir).length} 个文件</span>
                  </div>
                </div>

                <div className="w-px bg-border" />

                <div className="flex flex-col w-72 min-h-0">
                  <div className="flex items-center justify-between px-2 py-1.5 border-b">
                    <span className="text-caption font-medium">传输任务</span>
                    <div className="flex items-center gap-1">
                      <Label className="text-caption text-muted-foreground">并发</Label>
                      <Input type="number" min={1} max={10} value={maxConcurrent} onChange={(e) => setMaxConcurrent(parseInt(e.target.value) || 3)} className="h-5 w-12 text-caption px-1 text-center" />
                    </div>
                  </div>
                  {transferSessions.length > 0 ? (
                    <ScrollArea className="flex-1 min-h-0 w-full">
                      <div className="p-1 space-y-1 w-full min-w-0">
                        {transferSessions.map((session) => (
                          <div key={session.id} className="rounded border bg-card w-full min-w-0">
                            <button
                              onClick={() => setCollapsedTransfer((prev) => { const next = new Set(prev); next.has(session.id) ? next.delete(session.id) : next.add(session.id); return next; })}
                              className="flex w-full items-center gap-2 px-2 py-1 text-caption hover:bg-accent min-w-0"
                            >
                              {collapsedTransfer.has(session.id) ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                              {getStatusIcon(session.status)}
                              <span className="truncate flex-1 text-left min-w-0">{session.host}</span>
                              <span className="text-muted-foreground shrink-0">{session.completedCount}/{session.totalCount}</span>
                            </button>
                            {!collapsedTransfer.has(session.id) && (
                              <div className="border-t px-2 py-1 w-full min-w-0">
                                <Progress value={session.progress} className={cn("h-1 mb-1 max-w-full", session.status === "completed" && "[&>div]:bg-success")} />
                                <div className="space-y-0.5 w-full min-w-0">
                                  {session.files.map((file) => (
                                    <TransferFileItem
                                      key={file.id}
                                      status={file.status}
                                      filename={file.filename}
                                      speed={file.speed}
                                    />
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-caption text-muted-foreground">上传文件后查看进度</div>
                  )}
                  {transferSessions.length > 0 && (
                    <div className="border-t px-2 py-1.5">
                      {(() => {
                        const totalFiles = transferSessions.reduce((a, s) => a + s.totalCount, 0);
                        const completedFiles = transferSessions.reduce((a, s) => a + s.completedCount, 0);
                        const totalBytes = transferSessions.reduce((a, s) => a + s.totalBytes, 0);
                        const transferredBytes = transferSessions.reduce((a, s) => a + s.transferredBytes, 0);
                        const completedSessions = transferSessions.filter((s) => s.status === "completed").length;
                        const errorSessions = transferSessions.filter((s) => s.status === "error").length;
                        const totalProgress = totalBytes > 0 ? Math.round((transferredBytes / totalBytes) * 100) : 0;
                        return (
                          <>
                            <Progress value={totalProgress} className={cn("h-1.5 mb-1", completedSessions === transferSessions.length && errorSessions === 0 && "[&>div]:bg-success")} />
                            <div className="flex items-center justify-between text-caption text-muted-foreground">
                              <span>总进度 {totalProgress}%</span>
                              <span>{completedFiles}/{totalFiles} 文件</span>
                            </div>
                            <div className="flex items-center justify-between text-caption text-muted-foreground mt-0.5">
                              <span>{completedSessions} 成功{errorSessions > 0 ? ` ${errorSessions} 失败` : ""}</span>
                              <span>{formatSize(transferredBytes)}/{formatSize(totalBytes)}</span>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}
                  {activeBatchId && transferSessions.some((s) => s.status === "transferring" || s.status === "paused") && (
                    <div className="flex items-center gap-1 px-2 py-1.5 border-t">
                      <Button variant="ghost" size="sm" className="h-6 text-caption gap-1" onClick={() => sftpBatchPause(activeBatchId)}>
                        <Pause className="h-3 w-3" /> 暂停
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 text-caption gap-1" onClick={() => sftpBatchResume(activeBatchId)}>
                        <Play className="h-3 w-3" /> 恢复
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 text-caption gap-1 text-destructive" onClick={() => sftpBatchCancel(activeBatchId)}>
                        <X className="h-3 w-3" /> 取消
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-caption text-muted-foreground">请先连接至少一个会话</div>
            )}
          </div>
        </div>
      </div>

      <Dialog open={!!trustSession?.hostKey} onOpenChange={(value) => { if (!value && !trusting) setTrustSessionId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{trustSession?.hostKey?.type === "changed" ? "确认主机密钥变更" : "确认主机身份"}</DialogTitle>
            <DialogDescription>{trustSession?.hostKey?.type === "changed"
              ? "服务器身份与之前记录的不同。请确认服务器确实已更换或重装，再信任新密钥。"
              : "请通过可信渠道核对服务器指纹。信任后会记住该主机，后续密钥变更仍需确认。"}</DialogDescription>
          </DialogHeader>
          <dl className="space-y-2 text-body">
            <div><dt className="text-muted-foreground">主机</dt><dd>{trustSession?.host}:{trustSession?.port}</dd></div>
            {trustSession?.hostKey?.expectedFingerprint && <div><dt className="text-muted-foreground">原指纹</dt><dd className="break-all font-mono text-caption">{trustSession.hostKey.expectedFingerprint}</dd></div>}
            <div><dt className="text-muted-foreground">{trustSession?.hostKey?.type === "changed" ? "新指纹" : "密钥指纹"}</dt><dd className="break-all font-mono text-caption">{trustSession?.hostKey?.fingerprint}</dd></div>
          </dl>
          {trustError && <p role="alert" className="text-caption text-destructive">{trustError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={trusting} onClick={() => setTrustSessionId(null)}>取消</Button>
            <Button variant={trustSession?.hostKey?.type === "changed" ? "destructive" : "default"} disabled={trusting} onClick={handleTrustSession}>
              {trusting ? "连接中…" : trustSession?.hostKey?.type === "changed" ? "确认更换并连接" : "信任并连接"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!connectionActionError} onOpenChange={(value) => { if (!value) setConnectionActionError(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>操作未完成</DialogTitle><DialogDescription>{connectionActionError}</DialogDescription></DialogHeader>
          <DialogFooter><Button onClick={() => setConnectionActionError(null)}>知道了</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
