import { useState } from "react";
import { Plus, FolderOpen, Server, Settings, ArrowLeftRight, HardDrive, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentLogo } from "@/components/AgentLogo";
import { useTerminalStore } from "./store/terminalStore";
import { useLicense } from "@/hooks/useLicense";
import { sshOpenSftp, desktopConnect } from "./ipc";
import { PortForwardDialog } from "./Dialogs/PortForwardDialog";
import { SessionManagerDialog } from "./Dialogs/SessionManagerDialog";

export function Toolbar() {
  const { licenseActive } = useLicense();
  const toggleAIPanel = useTerminalStore((s) => s.toggleAIPanel);
  const aiPanelVisible = useTerminalStore((s) => s.aiPanelVisible);
  const aiStreaming = useTerminalStore((s) => s.aiStreaming);
  const setNewConnectionDialogOpen = useTerminalStore(
    (s) => s.setNewConnectionDialogOpen,
  );
  const setSettingsDialogOpen = useTerminalStore((s) => s.setSettingsDialogOpen);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const sessions = useTerminalStore((s) => s.sessions);
  const addSession = useTerminalStore((s) => s.addSession);
  const connections = useTerminalStore((s) => s.connections);
  const [portForwardOpen, setPortForwardOpen] = useState(false);
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false);

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
    if (activeSession && activeSession.type === "ssh") {
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
    } else {
      setNewConnectionDialogOpen(true, "sftp");
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
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={() => setSessionManagerOpen(true)}
      >
        <FolderOpen className="h-3.5 w-3.5" />
        打开
      </Button>
      <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={handleBatch}>
        <Server className="h-3.5 w-3.5" />
        批量
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={handleOpenSftp}
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
      <div className="flex-1" />
      {licenseActive && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={toggleAIPanel}
          title={aiPanelVisible ? "隐藏 AI 面板" : "显示 AI 面板"}
        >
          <AgentLogo
            state={aiStreaming ? "working" : "idle"}
            className={`h-5 w-5 ${aiPanelVisible ? "" : "opacity-60"}`}
          />
        </Button>
      )}
      {activeSessionId && (
        <PortForwardDialog
          open={portForwardOpen}
          onOpenChange={setPortForwardOpen}
          sessionId={activeSessionId}
        />
      )}
      <SessionManagerDialog
        open={sessionManagerOpen}
        onOpenChange={setSessionManagerOpen}
      />
    </div>
  );
}
