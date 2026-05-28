import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { open } from "@tauri-apps/plugin-dialog";
import {
  sshConnectWithId,
  sshDisconnect,
  sshSendInput,
  sftpList,
  sftpBatchUpload,
  sftpBatchCancel,
  sftpBatchPause,
  sftpBatchResume,
  onBatchTransferProgress,
} from "../ipc";
import type { BatchTransferProgress } from "../types/terminal";
import { useBatchStore } from "../store/batchStore";
import type { BatchSession, TransferSessionNode } from "../store/batchStore";
import {
  Play,
  Square,
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
} from "lucide-react";
import { Progress } from "@/components/ui/progress";

function generateIps(start: string, count: number): string[] {
  const ips: string[] = [];
  const parts = start.split(".");
  if (parts.length !== 4) return ips;
  const base = parts.slice(0, 3).join(".");
  const startNum = parseInt(parts[3]);
  for (let i = 0; i < count; i++) {
    ips.push(`${base}.${startNum + i}`);
  }
  return ips;
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
    case "completed": return <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />;
    case "error": return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    case "transferring": return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;
    case "paused": return <Pause className="h-3.5 w-3.5 text-amber-500" />;
    default: return <Clock className="h-3.5 w-3.5 text-gray-400" />;
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
  } = store;

  const [collapsedTransfer, setCollapsedTransfer] = useState<Set<string>>(new Set());

  const terminalRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const terminalsRef = useRef<Map<string, Terminal>>(new Map());
  const fitAddonsRef = useRef<Map<string, FitAddon>>(new Map());
  const unlistenersRef = useRef<Map<string, (() => void)[]>>(new Map());
  const resizeObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
  const terminalInputSetupRef = useRef<Set<string>>(new Set());
  const settingUpListenersRef = useRef<Set<string>>(new Set());

  const connectedCount = sessions.filter((s) => s.status === "connected").length;
  const selectedCount = sessions.filter((s) => s.selected).length;
  const activeSession = sessions.find((s) => s.id === activeSessionId);

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

  const handleBatchConnect = async () => {
    setIsConnecting(true);
    const ips = generateIps(startIp, count);

    const newSessions: BatchSession[] = ips.map((ip, index) => ({
      id: `batch-${Date.now()}-${index}`,
      host: ip,
      port,
      username,
      password: password || undefined,
      status: "connecting",
      selected: true,
    }));

    console.log("[batch] Starting batch connect, sessions:", newSessions.map((s) => `${s.id} -> ${s.host}`));
    setSessions(newSessions);

    const maxConc = 3;
    for (let i = 0; i < newSessions.length; i += maxConc) {
      const batch = newSessions.slice(i, i + maxConc);
      console.log(`[batch] Connecting batch ${Math.floor(i / maxConc) + 1}, hosts:`, batch.map((s) => s.host));
      const results = await Promise.allSettled(
        batch.map(async (session) => {
          console.log(`[batch] Connecting ${session.host} (id=${session.id}, pwdLen=${(session.password || "").length})...`);
          try {
            const result = await sshConnectWithId(session.id, {
              id: "",
              name: session.host,
              protocol: "ssh",
              host: session.host,
              port: session.port,
              username: session.username,
              auth: { type: "password", password: session.password || "" },
            });
            console.log(`[batch] Connected ${session.host} (id=${session.id}), result:`, result);
            useBatchStore.getState().updateSession(session.id, {
              status: "connected",
              connectedAt: Date.now(),
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : (typeof err === "string" ? err : JSON.stringify(err));
            console.error(`[batch] Failed to connect ${session.host} (id=${session.id}):`, errMsg);
            useBatchStore.getState().updateSession(session.id, {
              status: "error",
              error: errMsg,
            });
          }
        }),
      );
      results.forEach((r, idx) => {
        if (r.status === "rejected") {
          console.error(`[batch] Unexpected rejection for ${batch[idx].host}:`, r.reason);
        }
      });
    }

    setIsConnecting(false);

    const currentSessions = useBatchStore.getState().sessions;
    const connectedSessions = currentSessions.filter((s) => s.status === "connected");
    const errorSessions = currentSessions.filter((s) => s.status === "error");
    console.log(`[batch] Batch connect complete: ${connectedSessions.length} connected, ${errorSessions.length} errors`);
    errorSessions.forEach((s) => console.error(`[batch]   Error: ${s.host} - ${s.error}`));

    const firstConnected = currentSessions.find((s) => s.status === "connected");
    if (firstConnected) {
      setActiveSessionId(firstConnected.id);
      setConfigCollapsed(true);
    }
  };

  const handleDisconnectAll = async () => {
    for (const session of sessions) {
      if (session.status === "connected") {
        try {
          await sshDisconnect(session.id);
        } catch {}
        cleanupTerminal(session.id);
      }
    }
    setSessions(sessions.map((s) => ({ ...s, status: "disconnected" as const })));
    setActiveSessionId(null);
  };

  const handleReconnectSession = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;

    updateSession(sessionId, { status: "connecting", error: undefined });

    try {
      await sshConnectWithId(sessionId, {
        id: "",
        name: session.host,
        protocol: "ssh",
        host: session.host,
        port: session.port,
        username: session.username,
        auth: { type: "password", password: session.password || "" },
      });
      updateSession(sessionId, { status: "connected", connectedAt: Date.now() });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : (typeof err === "string" ? err : JSON.stringify(err));
      updateSession(sessionId, { status: "error", error: errMsg });
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
    } catch {}
  };

  const handleDeleteSession = (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    if (session.status === "connected") return;
    cleanupTerminal(sessionId);
    setSessions(sessions.filter((s) => s.id !== sessionId));
    if (activeSessionId === sessionId) setActiveSessionId(null);
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
      case "connected": return "bg-emerald-500";
      case "connecting": return "bg-amber-500 animate-pulse";
      case "error": return "bg-red-500";
      default: return "bg-gray-400";
    }
  };

  const loadRemoteFiles = async (path: string) => {
    const connectedSession = sessions.find((s) => s.status === "connected");
    if (!connectedSession) return;
    setLoadingFiles(true);
    try {
      const files = await sftpList(connectedSession.id, path);
      setRemoteFiles(files);
      setRemotePath(path);
    } catch (err) {
      console.error("加载远程文件失败:", err);
    } finally {
      setLoadingFiles(false);
    }
  };

  const handleUpload = async () => {
    const selectedSessions = sessions.filter(
      (s) => s.selected && s.status === "connected",
    );
    if (selectedSessions.length === 0) return;

    const selected = await open({ multiple: true, directory: false });
    if (!selected || (Array.isArray(selected) && selected.length === 0)) return;
    const files = Array.isArray(selected) ? selected : [selected];

    const newTransferSessions: TransferSessionNode[] = selectedSessions.map(
      (session) => ({
        id: session.id,
        host: session.host,
        status: "transferring",
        expanded: true,
        files: files.map((filePath) => {
          const fileName = filePath.split(/[\\/]/).pop() || "";
          return {
            id: `upload-${session.id}-${fileName}`,
            filename: fileName,
            status: "waiting",
            speed: "0 B/s",
            eta: "等待中...",
          };
        }),
        progress: 0,
        completedCount: 0,
        totalCount: files.length,
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
        files: files,
        targetDirectory: remotePath,
        maxConcurrent,
      });
      setActiveBatchId(batchId);
    } catch (err) {
      console.error("批量上传失败:", err);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onBatchTransferProgress((progress: BatchTransferProgress) => {
      handleBatchProgress(progress);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
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
      <div className="flex flex-col border-r bg-secondary/30" style={{ width: 240 }}>
        <div
          className={cn(
            "border-b transition-all",
            configCollapsed ? "p-2" : "p-3",
          )}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium">批量连接配置</h3>
            <button
              onClick={() => setConfigCollapsed(!configCollapsed)}
              className="p-1 hover:bg-accent rounded"
            >
              {configCollapsed ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronUp className="h-3 w-3" />
              )}
            </button>
          </div>
          <div
            className={cn(
              "space-y-2 overflow-hidden transition-all",
              configCollapsed ? "h-0 opacity-0 mt-0" : "h-auto opacity-100 mt-2",
            )}
          >
            <div className="grid grid-cols-[1fr_70px] gap-2">
              <div>
                <Label className="text-xs">起始IP</Label>
                <Input value={startIp} onChange={(e) => setStartIp(e.target.value)} className="h-7 text-xs" />
              </div>
              <div>
                <Label className="text-xs">数量</Label>
                <Input type="number" min={1} max={100} value={count} onChange={(e) => setCount(parseInt(e.target.value) || 1)} className="h-7 text-xs px-2" />
              </div>
            </div>
            <div className="grid grid-cols-[1fr_70px] gap-2">
              <div>
                <Label className="text-xs">用户名</Label>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} className="h-7 text-xs" />
              </div>
              <div>
                <Label className="text-xs">端口</Label>
                <Input type="number" value={port} onChange={(e) => setPort(parseInt(e.target.value) || 22)} className="h-7 text-xs px-2" />
              </div>
            </div>
            <div>
              <Label className="text-xs">密码</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-7 text-xs" />
            </div>
            <div className="flex gap-2">
              <Button size="sm" className="flex-1 h-7 text-xs" onClick={handleBatchConnect} disabled={isConnecting || connectedCount > 0}>
                <Play className="mr-1 h-3 w-3" />
                {isConnecting ? "连接中..." : "开始连接"}
              </Button>
              <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={handleDisconnectAll} disabled={connectedCount === 0}>
                <Square className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          <div className="flex items-center justify-between border-b px-2 py-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              会话 ({connectedCount}/{sessions.length})
            </span>
            <div className="flex gap-1">
              <button onClick={selectAllSessions} className="text-xs text-primary hover:underline">全选</button>
              <span className="text-xs text-muted-foreground">|</span>
              <button onClick={deselectAllSessions} className="text-xs text-primary hover:underline">取消</button>
            </div>
          </div>
          <ScrollArea className="h-[calc(100%-32px)]">
            <div className="space-y-0.5 p-1">
              {sessions.map((session) => (
                <ContextMenu key={session.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={cn(
                        "flex items-center gap-2 rounded px-2 py-1 text-xs cursor-pointer transition-colors",
                        activeSessionId === session.id ? "bg-primary/10" : "hover:bg-secondary",
                      )}
                      onClick={() => setActiveSessionId(session.id)}
                    >
                      <Checkbox
                        checked={session.selected}
                        onCheckedChange={() => toggleSessionSelection(session.id)}
                        disabled={session.status !== "connected"}
                        className="h-3 w-3"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className={cn("h-1.5 w-1.5 rounded-full shrink-0", getStatusColor(session.status))} />
                      <span className="truncate flex-1" title={session.error || session.host}>{session.host}</span>
                      {session.status === "error" && session.error && (
                        <span className="truncate max-w-[80px] text-red-400 text-[10px]" title={session.error}>
                          {session.error.length > 20 ? session.error.slice(0, 20) + "..." : session.error}
                        </span>
                      )}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-36">
                    {(session.status === "error" || session.status === "disconnected") && (
                      <ContextMenuItem onClick={() => handleReconnectSession(session.id)}>
                        <RefreshCw className="mr-2 h-3 w-3" /> 重连
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
                      disabled={session.status === "connected"}
                      className={session.status !== "connected" ? "text-red-600" : "text-muted-foreground"}
                    >
                      <Trash2 className="mr-2 h-3 w-3" /> 删除
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
              {sessions.length === 0 && (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  配置IP范围后点击"开始连接"
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      <div className="flex flex-1 flex-col min-w-0">
        <div className="border-b bg-card px-3 py-1">
          <div className="flex items-center rounded-lg border border-border/70 bg-muted/30 p-0.5">
            <button
              type="button"
              onClick={() => setActiveTab("terminal")}
              className={cn(
                "h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors flex items-center gap-1",
                activeTab === "terminal" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              <TerminalIcon className="w-3 h-3" /> 终端
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("sftp")}
              className={cn(
                "h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors flex items-center gap-1",
                activeTab === "sftp" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              <FolderOpen className="w-3 h-3" /> 文件传输
            </button>
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
                    <span className="text-sm text-slate-200">
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
                    <p className="text-sm">选择一个会话查看终端</p>
                  </div>
                )}
              </div>
            </div>
            {connectedCount > 0 && (
              <div className="border-t bg-card p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs font-medium">批量发送</span>
                  <span className="text-xs text-muted-foreground">(已选择 {selectedCount} 个会话)</span>
                </div>
                <div className="flex gap-2">
                  <textarea
                    value={commandInput}
                    onChange={(e) => setCommandInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.ctrlKey && e.key === "Enter") {
                        e.preventDefault();
                        handleSendCommand();
                      }
                    }}
                    placeholder="输入命令... (Ctrl+Enter 发送)"
                    className="w-full h-16 px-3 py-2 text-xs font-mono bg-background border border-input rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <div className="flex flex-col gap-1.5">
                    <Button size="sm" className="h-7 text-xs" onClick={handleSendCommand} disabled={selectedCount === 0 || !commandInput.trim()}>
                      <Send className="mr-1 h-3 w-3" /> 发送
                    </Button>
                    <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => setCommandInput("")} disabled={!commandInput.trim()}>
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
              <div className="flex flex-1">
                <div className="flex flex-col flex-1 min-w-0">
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b">
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { const parent = remotePath.substring(0, remotePath.lastIndexOf("/")) || "/"; loadRemoteFiles(parent); }} disabled={remotePath === "/"}>
                      <ChevronLeft className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { const parent = remotePath.substring(0, remotePath.lastIndexOf("/")) || "/"; loadRemoteFiles(parent); }} disabled={remotePath === "/"}>
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Input value={remotePath} onChange={(e) => setRemotePath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") loadRemoteFiles(remotePath); }} className="h-6 text-xs flex-1" />
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => loadRemoteFiles("/")}>
                      <Home className="h-3 w-3" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => loadRemoteFiles(remotePath)} disabled={loadingFiles}>
                      <RefreshCw className={cn("h-3 w-3", loadingFiles && "animate-spin")} />
                    </Button>
                    <div className="border-l pl-2">
                      <Button variant="outline" size="sm" className="h-6 text-xs gap-1" onClick={handleUpload} disabled={sessions.filter((s) => s.selected).length === 0}>
                        <Upload className="h-3 w-3" /> 批量上传
                      </Button>
                    </div>
                  </div>
                  <ScrollArea className="flex-1">
                    <div className="min-w-[400px]">
                      <div className="flex text-xs font-medium text-muted-foreground bg-secondary border-b sticky top-0">
                        <div className="px-2 py-1 w-[200px] shrink-0">名称</div>
                        <div className="px-2 py-1 w-20 shrink-0 text-right">大小</div>
                        <div className="px-2 py-1 w-16 shrink-0 text-right">类型</div>
                      </div>
                      {remoteFiles.map((file) => (
                        <div key={file.path} className="flex items-center text-xs cursor-pointer hover:bg-accent/20" style={{ height: 26 }} onClick={() => { if (file.isDir) loadRemoteFiles(file.path); }}>
                          <div className="px-2 w-[200px] shrink-0 flex items-center gap-1.5">
                            {file.isDir ? <Folder className="h-3.5 w-3.5 text-yellow-500 shrink-0" /> : <File className="h-3.5 w-3.5 text-gray-400 shrink-0" />}
                            <span className="truncate">{file.name}</span>
                          </div>
                          <div className="px-2 w-20 shrink-0 text-right text-muted-foreground">{file.isDir ? "-" : formatSize(file.size)}</div>
                          <div className="px-2 w-16 shrink-0 text-right text-muted-foreground">{file.isDir ? "文件夹" : "文件"}</div>
                        </div>
                      ))}
                      {remoteFiles.length === 0 && !loadingFiles && (
                        <div className="py-8 text-center text-xs text-muted-foreground">空文件夹</div>
                      )}
                    </div>
                  </ScrollArea>
                  <div className="flex items-center justify-between px-3 py-1 border-t text-xs text-muted-foreground">
                    <span>{remoteFiles.filter((f) => f.isDir).length} 个文件夹, {remoteFiles.filter((f) => !f.isDir).length} 个文件</span>
                  </div>
                </div>

                <div className="w-px bg-border" />

                <div className="flex flex-col w-72">
                  <div className="flex items-center justify-between px-2 py-1.5 border-b">
                    <span className="text-xs font-medium">传输任务</span>
                    <div className="flex items-center gap-1">
                      <Label className="text-xs text-muted-foreground">并发</Label>
                      <Input type="number" min={1} max={10} value={maxConcurrent} onChange={(e) => setMaxConcurrent(parseInt(e.target.value) || 3)} className="h-5 w-12 text-xs px-1 text-center" />
                    </div>
                  </div>
                  {transferSessions.length > 0 ? (
                    <ScrollArea className="flex-1">
                      <div className="p-1 space-y-1">
                        {transferSessions.map((session) => (
                          <div key={session.id} className="rounded border bg-card">
                            <button
                              onClick={() => setCollapsedTransfer((prev) => { const next = new Set(prev); next.has(session.id) ? next.delete(session.id) : next.add(session.id); return next; })}
                              className="flex w-full items-center gap-2 px-2 py-1 text-xs hover:bg-accent/20"
                            >
                              {collapsedTransfer.has(session.id) ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                              {getStatusIcon(session.status)}
                              <span className="truncate flex-1 text-left">{session.host}</span>
                              <span className="text-muted-foreground">{session.completedCount}/{session.totalCount}</span>
                            </button>
                            {!collapsedTransfer.has(session.id) && (
                              <div className="border-t px-2 py-1">
                                <Progress value={session.progress} className="h-1 mb-1" />
                                <div className="space-y-0.5">
                                  {session.files.map((file) => (
                                    <div key={file.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                                      {getStatusIcon(file.status)}
                                      <span className="truncate flex-1">{file.filename}</span>
                                      <span>{file.speed}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">上传文件后查看进度</div>
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
                            <Progress value={totalProgress} className="h-1.5 mb-1" />
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>总进度 {totalProgress}%</span>
                              <span>{completedFiles}/{totalFiles} 文件</span>
                            </div>
                            <div className="flex items-center justify-between text-xs text-muted-foreground mt-0.5">
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
                      <Button variant="ghost" size="sm" className="h-6 text-xs gap-1" onClick={() => sftpBatchPause(activeBatchId)}>
                        <Pause className="h-3 w-3" /> 暂停
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 text-xs gap-1" onClick={() => sftpBatchResume(activeBatchId)}>
                        <Play className="h-3 w-3" /> 恢复
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 text-red-500" onClick={() => sftpBatchCancel(activeBatchId)}>
                        <X className="h-3 w-3" /> 取消
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">请先连接至少一个会话</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
