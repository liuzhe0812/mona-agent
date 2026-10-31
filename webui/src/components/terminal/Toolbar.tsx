import {
  Plus,
  Settings,
  Monitor,
  Activity,
  Container,
  ListChecks,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentLogo } from "@/components/AgentLogo";
import { useTerminalStore } from "./store/terminalStore";
import { useIdeStore } from "../ide/useIdeStore";
import { cn } from "@/lib/utils";

export function Toolbar({ embedded = false }: { onOpenSubscribe?: () => void; embedded?: boolean }) {
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
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const openDockerSession = useTerminalStore((s) => s.openDockerSession);

  const systemMonitorVisible = useIdeStore((s) => s.leftSystemMonitorVisible);
  const toggleSystemMonitor = useIdeStore((s) => s.toggleLeftSystemMonitor);

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const handleNew = () => {
    setNewConnectionDialogOpen(true);
  };

  const handleOpenDesktop = () => {
    if (activeSession?.type === "ssh" && activeSession.status === "connected") {
      const existing = sessions.find(
        (session) => session.type === "desktop" && session.parentSessionId === activeSession.id,
      );
      if (existing) {
        setActiveSession(existing.id);
        return;
      }
      addSession({
        id: `desktop:${activeSession.id}`,
        configId: activeSession.configId,
        type: "desktop",
        status: "connected",
        title: `${activeSession.title} (桌面)`,
        parentSessionId: activeSession.id,
      });
      return;
    }
    addSession({
      id: crypto.randomUUID(),
      configId: "",
      type: "desktop",
      status: "disconnected",
      title: "桌面",
    });
  };

  const handleOpenDocker = () => {
    if (activeSession) openDockerSession(activeSession.id);
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-2">
      {!embedded && <Button
        variant="ghost"
        size="sm"
        className="gap-1.5"
        onClick={handleNew}
      >
        <Plus className="h-3.5 w-3.5" />
        新建
      </Button>}
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5"
        onClick={handleOpenDesktop}
      >
        <Monitor className="h-3.5 w-3.5" />
        桌面
      </Button>
      {activeSession?.type === "ssh" && (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={handleOpenDocker}
          disabled={activeSession.status !== "connected"}
          title="管理当前 SSH 主机的 Docker"
        >
          <Container className="h-3.5 w-3.5" />
          Docker
        </Button>
      )}
      {activeSession?.type === "ssh" && (
        <Button
          variant="ghost"
          size="sm"
          className={cn("gap-1.5", systemMonitorVisible && "bg-accent text-foreground")}
          onClick={toggleSystemMonitor}
          aria-label={systemMonitorVisible ? "隐藏系统监控" : "显示系统监控"}
          aria-pressed={systemMonitorVisible}
          title={systemMonitorVisible ? "隐藏系统监控" : "显示系统监控"}
        >
          <Activity className="h-3.5 w-3.5" />
          系统监控
        </Button>
      )}
      {(activeSession?.type === "ssh" || activeSession?.type === "sftp") && (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          disabled={activeSession.status !== "connected"}
          onClick={() => useTerminalStore.getState().updateSession(activeSession.id, { sftpVisible: true, transferPanelVisible: true })}
        >
          <ListChecks className="h-3.5 w-3.5" />
          传输记录
        </Button>
      )}
      <div className="flex-1" />
      {!embedded && activeSession?.type !== "desktop" && activeSession?.type !== "docker" && (
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
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setSettingsDialogOpen(true)}
        aria-label="设置"
        title="设置"
      >
        <Settings className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
