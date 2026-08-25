import { useState } from "react";
import {
  Plus,
  FolderOpen,
  Server,
  Settings,
  HardDrive,
  Monitor,
  FolderTree,
  Activity,
  LockKeyhole,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentLogo } from "@/components/AgentLogo";
import { useTerminalStore } from "./store/terminalStore";
import { useIdeStore } from "../ide/useIdeStore";
import { useLicense } from "@/hooks/useLicense";
import { sshOpenSftp, desktopConnect } from "./ipc";
import { SessionManagerDialog } from "./Dialogs/SessionManagerDialog";
import { cn } from "@/lib/utils";

export function Toolbar({ onOpenSubscribe }: { onOpenSubscribe?: () => void }) {
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
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false);

  const fileTreeVisible = useIdeStore((s) => s.leftFileTreeVisible);
  const systemMonitorVisible = useIdeStore((s) => s.leftSystemMonitorVisible);
  const toggleFileTree = useIdeStore((s) => s.toggleLeftFileTree);
  const toggleSystemMonitor = useIdeStore((s) => s.toggleLeftSystemMonitor);

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
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-2">
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5"
        onClick={handleNew}
      >
        <Plus className="h-3.5 w-3.5" />
        新建
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5"
        onClick={() => setSessionManagerOpen(true)}
      >
        <FolderOpen className="h-3.5 w-3.5" />
        打开
      </Button>
      <Button variant="ghost" size="sm" className="gap-1.5" onClick={handleBatch}>
        <Server className="h-3.5 w-3.5" />
        批量
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5"
        onClick={handleOpenSftp}
      >
        <HardDrive className="h-3.5 w-3.5" />
        SFTP
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5"
        onClick={handleOpenDesktop}
      >
        <Monitor className="h-3.5 w-3.5" />
        桌面
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5"
        onClick={() => setSettingsDialogOpen(true)}
      >
        <Settings className="h-3.5 w-3.5" />
        设置
      </Button>
      <div className="flex-1" />
      {activeSession?.type === "ssh" && (
        <>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              fileTreeVisible && "text-foreground",
            )}
            onClick={toggleFileTree}
            aria-label={fileTreeVisible ? "隐藏文件树" : "显示文件树"}
            title={fileTreeVisible ? "隐藏文件树" : "显示文件树"}
          >
            <FolderTree className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              systemMonitorVisible && "text-foreground",
            )}
            onClick={toggleSystemMonitor}
            aria-label={systemMonitorVisible ? "隐藏系统监控" : "显示系统监控"}
            title={systemMonitorVisible ? "隐藏系统监控" : "显示系统监控"}
          >
            <Activity className="h-4 w-4" />
          </Button>
        </>
      )}
      {activeSession?.type !== "desktop" && (licenseActive ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={toggleAIPanel}
          aria-label={aiPanelVisible ? "隐藏 AI 面板" : "显示 AI 面板"}
          title={aiPanelVisible ? "隐藏 AI 面板" : "显示 AI 面板"}
        >
          <AgentLogo
            state={aiStreaming ? "working" : "idle"}
            className="h-5 w-5"
          />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          onClick={onOpenSubscribe}
          aria-label="升级 Pro 解锁终端 AI"
          title="升级 Pro 解锁终端 AI"
        >
          <LockKeyhole className="h-4 w-4" />
        </Button>
      ))}
      <SessionManagerDialog
        open={sessionManagerOpen}
        onOpenChange={setSessionManagerOpen}
      />
    </div>
  );
}
