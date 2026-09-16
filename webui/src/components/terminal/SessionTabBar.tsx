import { useCallback, useRef, useState } from "react";
import {
  Pencil,
  Copy,
  FolderOpen,
  Plus,
  X,
  XCircle,
  ArrowRightFromLine,
  Download,
  Notebook,
  ExternalLink,
  Container,
} from "lucide-react";
import { useTerminalStore } from "./store/terminalStore";
import { sshConnect, sshDisconnect, shellKill, shellSpawn, sshOpenSftp, vncDisconnect } from "./ipc";
import { isTauri } from "@/lib/tauri";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SessionTabBar() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const removeSession = useTerminalStore((s) => s.removeSession);
  const updateSessionStatus = useTerminalStore((s) => s.updateSessionStatus);
  const updateSessionTitle = useTerminalStore((s) => s.updateSessionTitle);
  const addSession = useTerminalStore((s) => s.addSession);
  const openDockerSession = useTerminalStore((s) => s.openDockerSession);
  const connections = useTerminalStore((s) => s.connections);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const handleClose = useCallback(
    async (sessionId: string, sessionType: string) => {
      if (!isTauri()) {
        removeSession(sessionId);
        return;
      }
      try {
        if (sessionType === "ssh" || sessionType === "sftp") {
          await sshDisconnect(sessionId);
        } else if (sessionType === "local") {
          await shellKill(sessionId);
        } else if (sessionType === "vnc") {
          await vncDisconnect(sessionId);
        }
      } catch {
        updateSessionStatus(sessionId, "disconnected");
      }
      removeSession(sessionId);
    },
    [removeSession, updateSessionStatus],
  );

  const handleNewShell = async () => {
    if (!isTauri()) return;
    try {
      const sessionId = await shellSpawn(80, 24);
      addSession({
        id: sessionId,
        configId: "",
        type: "local",
        status: "connected",
        title: "本地终端",
      });
    } catch {}
  };

  const handleRename = useCallback(
    (session: { id: string; title: string }) => {
      setRenameTarget(session);
      setRenameValue(session.title);
      setRenameOpen(true);
    },
    [],
  );

  const handleRenameConfirm = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && renameTarget) {
      updateSessionTitle(renameTarget.id, trimmed);
    }
    setRenameOpen(false);
    setRenameTarget(null);
  }, [renameValue, renameTarget, updateSessionTitle]);

  const handleDuplicate = useCallback(
    async (session: { id: string; type: string; configId: string }) => {
      if (session.type === "ssh" || session.type === "sftp") {
        const config = connections.find((c) => c.id === session.configId);
        if (!config) return;
        try {
          const newSessionId = await sshConnect(config);
          addSession({
            id: newSessionId,
            configId: config.id,
            type: session.type,
            status: "connected",
            title: config.host,
          });
        } catch {}
      } else if (session.type === "local") {
        try {
          const newSessionId = await shellSpawn(80, 24);
          addSession({
            id: newSessionId,
            configId: "",
            type: "local",
            status: "connected",
            title: "本地终端",
          });
        } catch {}
      }
    },
    [connections, addSession],
  );

  const handleOpenSftp = useCallback(
    async (session: { id: string; configId: string }) => {
      try {
        const sftpSessionId = await sshOpenSftp(session.id);
        const config = connections.find((c) => c.id === session.configId);
        addSession({
          id: sftpSessionId,
          configId: session.configId,
          type: "sftp",
          status: "connected",
          title: config ? `SFTP ${config.host}` : "SFTP",
        });
      } catch {}
    },
    [connections, addSession],
  );

  const handleOpenDocker = useCallback(
    (session: { id: string }) => openDockerSession(session.id),
    [openDockerSession],
  );

  const handleCloseOthers = useCallback(
    (keepSessionId: string) => {
      const keepSession = sessions.find((session) => session.id === keepSessionId);
      const keepIds = new Set([keepSessionId]);
      if (keepSession?.type === "docker" && keepSession.parentSessionId) {
        keepIds.add(keepSession.parentSessionId);
      }
      const toClose = sessions.filter((session) => !keepIds.has(session.id));
      for (const s of toClose) {
        void handleClose(s.id, s.type);
      }
    },
    [sessions, handleClose],
  );

  const handleCloseToRight = useCallback(
    (sessionId: string) => {
      const idx = sessions.findIndex((s) => s.id === sessionId);
      if (idx < 0) return;
      const toClose = sessions.slice(idx + 1);
      for (const s of toClose) {
        void handleClose(s.id, s.type);
      }
    },
    [sessions, handleClose],
  );

  const getTerminalContent = useCallback((sessionId: string): string => {
    const terminal = useTerminalStore.getState().terminalRegistry.get(sessionId);
    if (!terminal) return "";
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    return lines.join("\n");
  }, []);

  const handleExportLog = useCallback(
    async (sessionId: string) => {
      const content = getTerminalContent(sessionId);
      if (!content) return;
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const savePath = await save({
          defaultPath: "terminal-log.txt",
          title: "导出终端记录",
          filters: [{ name: "文本文件", extensions: ["txt", "log"] }],
        });
        if (!savePath) return;
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(savePath as `${string}/${string}`, content);
      } catch {}
    },
    [getTerminalContent],
  );

  const handleExportToNote = useCallback(
    async (sessionId: string) => {
      const content = getTerminalContent(sessionId);
      if (!content) return;
      try {
        const { loadNotesState, saveNotesState, createBlankNote } = await import(
          "@/components/notes/notes-storage"
        );
        const state = await loadNotesState();
        // 终端导出统一落到 vault 根目录。
        const notebookId = "";
        const note = createBlankNote(notebookId, "ssh");
        const preview = content.split("\n").filter((l) => l.trim()).slice(-1)[0]?.slice(0, 60) ?? "终端记录";
        note.title = `终端记录 ${new Date().toLocaleString("zh-CN")}`;
        note.preview = preview;
        note.contentMarkdown = `## 终端记录\n\n\`\`\`bash\n${content}\n\`\`\`\n`;
        state.notes.unshift(note);
        state.activeNoteId = note.id;
        state.activeNotebookId = notebookId;
        await saveNotesState(state);
      } catch {}
    },
    [getTerminalContent],
  );

  const handleOpenInNewWindow = useCallback(
    async (session: { id: string; type: string; configId: string; title: string }) => {
      if (!isTauri()) return;
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const label = `terminal-window-${session.id}`;
        const existing = await WebviewWindow.getByLabel(label);
        if (existing) {
          await existing.setFocus();
          return;
        }
        const url = new URL(window.location.href);
        url.searchParams.set("terminalWindow", "1");
        url.searchParams.set("configId", session.configId);
        url.searchParams.set("sessionType", session.type);
        url.searchParams.set("sessionTitle", session.title);
        const webview = new WebviewWindow(label, {
          url: url.toString(),
          title: session.title || "终端",
          width: 1200,
          height: 720,
          minWidth: 640,
          minHeight: 400,
        });
        webview.once("tauri://error", (event) => {
          console.error("[terminal-window] failed to create:", event);
        });
      } catch (err) {
        console.error("[terminal-window] error:", err);
      }
    },
    [],
  );

  return (
    <>
      <div className="flex h-8 shrink-0 items-end border-b border-border bg-card px-1">
        {sessions.map((session, index) => {
          const isActive = session.id === activeSessionId;
          const isSsh = session.type === "ssh";
          const canDuplicate = session.type === "ssh" || session.type === "sftp" || session.type === "local";
          const canExport = session.type === "ssh" || session.type === "local";
          const canOpenInNewWindow = session.type !== "docker" && session.type !== "batch";

          return (
            <ContextMenu key={session.id}>
              <ContextMenuTrigger asChild>
                <div
                  className={`group relative flex h-7 cursor-pointer select-none items-center gap-1 px-2 text-caption transition-colors ${
                    index > 0 ? "border-l border-border" : ""
                  } ${
                    isActive
                      ? "bg-background text-foreground"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                  onClick={() => setActiveSession(session.id)}
                >
                  {isActive && (
                    <span
                      className="absolute bottom-0 left-0 right-0 h-px bg-foreground/60"
                    />
                  )}
                  <span
                    className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                      session.type === "local"
                        ? "bg-warning"
                        : session.status === "connected"
                          ? "bg-success-indicator"
                          : session.status === "connecting"
                            ? "bg-warning"
                            : session.status === "error"
                              ? "bg-destructive"
                              : "bg-muted-foreground/40"
                    }`}
                  />
                  <span className="max-w-[120px] truncate">{session.title}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`关闭 ${session.title}`}
                    className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClose(session.id, session.type);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48 z-[100001]">
                <ContextMenuItem onClick={() => handleRename(session)}>
                  <Pencil className="mr-2 h-3.5 w-3.5" /> 重命名
                </ContextMenuItem>
                {canDuplicate && (
                  <ContextMenuItem onClick={() => handleDuplicate(session)}>
                    <Copy className="mr-2 h-3.5 w-3.5" /> 复制会话
                  </ContextMenuItem>
                )}
                {isSsh && (
                  <>
                    <ContextMenuItem onClick={() => handleOpenSftp(session)}>
                      <FolderOpen className="mr-2 h-3.5 w-3.5" /> 打开 SFTP
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={session.status !== "connected"}
                      onClick={() => handleOpenDocker(session)}
                    >
                      <Container className="mr-2 h-3.5 w-3.5" /> Docker 管理
                    </ContextMenuItem>
                  </>
                )}
                {canExport && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => handleExportLog(session.id)}>
                      <Download className="mr-2 h-3.5 w-3.5" /> 导出记录
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => handleExportToNote(session.id)}>
                      <Notebook className="mr-2 h-3.5 w-3.5" /> 导出到笔记
                    </ContextMenuItem>
                  </>
                )}
                <ContextMenuSeparator />
                {canOpenInNewWindow && (
                  <ContextMenuItem onClick={() => handleOpenInNewWindow(session)}>
                    <ExternalLink className="mr-2 h-3.5 w-3.5" /> 在新窗口打开
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => handleClose(session.id, session.type)}>
                  <X className="mr-2 h-3.5 w-3.5" /> 关闭
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleCloseOthers(session.id)}>
                  <XCircle className="mr-2 h-3.5 w-3.5" /> 关闭其他
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleCloseToRight(session.id)}>
                  <ArrowRightFromLine className="mr-2 h-3.5 w-3.5" /> 关闭右侧
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        <Button
          variant="ghost"
          size="icon"
          onClick={handleNewShell}
          className="h-6 w-6 shrink-0 text-muted-foreground"
          aria-label="新建 Shell"
          title="新建 Shell"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <Dialog open={renameOpen} onOpenChange={(open) => { if (!open) { setRenameOpen(false); setRenameTarget(null); } }}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>重命名标签页</DialogTitle>
          </DialogHeader>
          <Input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleRenameConfirm(); }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setRenameOpen(false); setRenameTarget(null); }}>
              取消
            </Button>
            <Button size="sm" onClick={handleRenameConfirm}>
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
