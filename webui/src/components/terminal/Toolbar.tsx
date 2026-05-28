import { useState, useEffect, useRef } from "react";
import { Plus, FolderOpen, Server, Settings, Unplug, Bot, ArrowLeftRight, Trash2, HardDrive, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTerminalStore } from "./store/terminalStore";
import { sshDisconnect, shellKill, sshConnect, sshOpenSftp, desktopConnect, desktopDisconnect } from "./ipc";
import { PortForwardDialog } from "./Dialogs/PortForwardDialog";
import type { ConnectionConfig } from "./types/terminal";
import type { HostKeyDialogState } from "./store/terminalStore";

export function Toolbar() {
  const toggleAIPanel = useTerminalStore((s) => s.toggleAIPanel);
  const aiPanelVisible = useTerminalStore((s) => s.aiPanelVisible);
  const setNewConnectionDialogOpen = useTerminalStore(
    (s) => s.setNewConnectionDialogOpen,
  );
  const setSettingsDialogOpen = useTerminalStore((s) => s.setSettingsDialogOpen);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const sessions = useTerminalStore((s) => s.sessions);
  const addSession = useTerminalStore((s) => s.addSession);
  const removeSession = useTerminalStore((s) => s.removeSession);
  const updateSessionStatus = useTerminalStore((s) => s.updateSessionStatus);
  const savedConnections = useTerminalStore((s) => s.savedConnections);
  const loadSavedConnections = useTerminalStore((s) => s.loadSavedConnections);
  const deleteConnection = useTerminalStore((s) => s.deleteConnection);
  const connections = useTerminalStore((s) => s.connections);
  const addConnection = useTerminalStore((s) => s.addConnection);
  const showHostKeyDialog = useTerminalStore((s) => s.showHostKeyDialog);
  const showSshPasswordDialog = useTerminalStore((s) => s.showSshPasswordDialog);
  const saveConnection = useTerminalStore((s) => s.saveConnection);
  const [portForwardOpen, setPortForwardOpen] = useState(false);
  const [openMenuVisible, setOpenMenuVisible] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSavedConnections();
  }, [loadSavedConnections]);

  useEffect(() => {
    if (!openMenuVisible) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuVisible(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [openMenuVisible]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const handleNew = () => {
    setNewConnectionDialogOpen(true);
  };

  const handleBatch = () => {
    const existing = sessions.find((s) => s.type === "batch");
    if (existing) {
      useTerminalStore.getState().setActiveSession(existing.id);
      return;
    }
    addSession({
      id: crypto.randomUUID(),
      configId: "",
      type: "batch",
      status: "connected",
      title: "批量模式",
    });
  };

  const handleOpenSftp = async () => {
    if (!activeSession || activeSession.type !== "ssh") return;
    try {
      const sftpSessionId = await sshOpenSftp(activeSession.id);
      addSession({
        id: sftpSessionId,
        configId: activeSession.configId,
        type: "sftp",
        status: "connected",
        title: `${activeSession.title} (SFTP)`,
      });
    } catch (err) {
      console.error("Failed to open SFTP:", String(err));
    }
  };

  const handleOpenDesktop = async () => {
    if (activeSession && activeSession.type === "ssh") {
      const conn = connections.find((c) => c.id === activeSession.configId);
      if (conn) {
        try {
          const desktopSessionId = await desktopConnect(conn);
          addSession({
            id: desktopSessionId,
            configId: activeSession.configId,
            type: "desktop",
            status: "connected",
            title: `${activeSession.title} (桌面)`,
          });
          return;
        } catch (err) {
          console.error("Failed to open desktop:", String(err));
        }
      }
    }
    addSession({
      id: crypto.randomUUID(),
      configId: "",
      type: "desktop",
      status: "disconnected",
      title: "桌面",
    });
  };

  const handleDisconnect = async () => {
    if (!activeSession) return;
    try {
      if (activeSession.type === "ssh" || activeSession.type === "sftp") {
        await sshDisconnect(activeSession.id);
      } else if (activeSession.type === "local") {
        await shellKill(activeSession.id);
      } else if (activeSession.type === "desktop") {
        await desktopDisconnect(activeSession.id);
      }
    } catch {
      updateSessionStatus(activeSession.id, "disconnected");
    }
    removeSession(activeSession.id);
  };

  const handleOpenSaved = async (config: typeof savedConnections[number]) => {
    setOpenMenuVisible(false);

    const tryConnect = async (connConfig: ConnectionConfig) => {
      addConnection(connConfig);
      const sessionId = await sshConnect(connConfig);
      addSession({
        id: sessionId,
        configId: connConfig.id,
        type: connConfig.protocol === "sftp" ? "sftp" : "ssh",
        status: "connected",
        title: connConfig.host,
      });
    };

    try {
      await tryConnect(config);
    } catch (err) {
      const errMsg = String(err);
      const unknownMatch = errMsg.match(/Host key unknown:\s*(SHA256:\S+)/);
      const changedMatch = errMsg.match(
        /Host key changed: expected\s*(SHA256:\S+),\s*got\s*(SHA256:\S+)/,
      );
      const keyringMatch = errMsg.match(/keyring/i);
      const authFailedMatch = errMsg.match(/authentication failed/i);
      const storageUpgradeMatch = errMsg.match(/storage format|re-enter the password/i);

      if (unknownMatch) {
        const dialogData: Omit<HostKeyDialogState, "open"> = {
          host: config.host,
          port: config.port,
          type: "unknown",
          fingerprint: unknownMatch[1],
          expectedFingerprint: "",
          pendingConfig: config,
          saveSession: true,
        };
        showHostKeyDialog(dialogData);
        return;
      }

      if (changedMatch) {
        const dialogData: Omit<HostKeyDialogState, "open"> = {
          host: config.host,
          port: config.port,
          type: "changed",
          fingerprint: changedMatch[2],
          expectedFingerprint: changedMatch[1],
          pendingConfig: config,
          saveSession: true,
        };
        showHostKeyDialog(dialogData);
        return;
      }

      if (keyringMatch || authFailedMatch || storageUpgradeMatch) {
        showSshPasswordDialog({
          host: config.host,
          port: config.port,
          username: config.username,
          onConfirm: async (password: string) => {
            const newConfig: ConnectionConfig = {
              ...config,
              auth: { type: "password", password },
            };
            await tryConnect(newConfig);
            await saveConnection(newConfig);
          },
          onCancel: () => {},
        });
        return;
      }

      console.error("Failed to open saved connection:", errMsg);
    }
  };

  const handleDeleteSaved = (e: React.MouseEvent, connId: string) => {
    e.stopPropagation();
    deleteConnection(connId);
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={handleNew}
      >
        <Plus className="h-3.5 w-3.5" />
        新建
      </Button>
      <div className="relative" ref={menuRef}>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setOpenMenuVisible(!openMenuVisible)}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          打开
        </Button>
        {openMenuVisible && (
          <div className="absolute left-0 top-full z-50 mt-1 min-w-[240px] rounded-md border bg-popover p-1 shadow-md">
            {savedConnections.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                暂无已保存的连接
              </div>
            ) : (
              savedConnections.map((conn) => (
                <div
                  key={conn.id}
                  onClick={() => handleOpenSaved(conn)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent cursor-pointer"
                >
                  <Server className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate flex-1">{conn.name}</span>
                  <span className="text-muted-foreground">
                    {conn.protocol.toUpperCase()}
                  </span>
                  <button
                    onClick={(e) => handleDeleteSaved(e, conn.id)}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    title="删除此连接"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={handleBatch}>
        <Server className="h-3.5 w-3.5" />
        批量
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={handleOpenSftp}
        disabled={!activeSession || activeSession.type !== "ssh"}
      >
        <HardDrive className="h-3.5 w-3.5" />
        SFTP
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={handleOpenDesktop}
      >
        <Monitor className="h-3.5 w-3.5" />
        桌面
      </Button>
      <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setSettingsDialogOpen(true)}>
        <Settings className="h-3.5 w-3.5" />
        设置
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={() => setPortForwardOpen(true)}
        disabled={!activeSession || activeSession.type !== "ssh"}
      >
        <ArrowLeftRight className="h-3.5 w-3.5" />
        转发
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={handleDisconnect}
        disabled={!activeSession || activeSession.status === "disconnected"}
      >
        <Unplug className="h-3.5 w-3.5" />
        断开
      </Button>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={toggleAIPanel}
        title={aiPanelVisible ? "隐藏 AI 面板" : "显示 AI 面板"}
      >
        <Bot
          className={`h-3.5 w-3.5 ${aiPanelVisible ? "text-foreground" : "text-muted-foreground"}`}
        />
      </Button>
      {activeSessionId && (
        <PortForwardDialog
          open={portForwardOpen}
          onOpenChange={setPortForwardOpen}
          sessionId={activeSessionId}
        />
      )}
    </div>
  );
}
