import { useCallback, useEffect, useRef, useState } from "react";
import { Toolbar } from "./Toolbar";
import { SessionTabBar } from "./SessionTabBar";
import { XtermTerminal } from "./XtermTerminal";
import { VncViewer } from "./VncViewer";
import { StatusBar } from "./StatusBar";
import { AIPanel } from "./AIPanel/AIPanel";
import { NewConnectionDialog } from "./Dialogs/NewConnectionDialog";
import { TerminalSettingsDialog } from "./Dialogs/TerminalSettingsDialog";
import { HostKeyConfirmDialog } from "./Dialogs/HostKeyConfirmDialog";
import { SshPasswordDialog } from "./Dialogs/SshPasswordDialog";
import { ExecApprovalDialog } from "./Dialogs/ExecApprovalDialog";
import { FileManager } from "./FileManager/FileManager";
import { BatchModeView } from "./BatchMode/BatchModeView";
import { DesktopMode } from "./Desktop/DesktopMode";
import { DockerPanel } from "./Docker/DockerPanel";
import { SshWorkspace } from "./SshWorkspace";
import { EmptyState } from "@/components/ui/empty-state";
import { useTerminalStore } from "./store/terminalStore";
import { shellSpawn, vncReconnect } from "./ipc";

const AI_PANEL_DEFAULT_WIDTH = 320;
const AI_PANEL_MIN_WIDTH = 240;
const AI_PANEL_MAX_WIDTH = 600;

export function TerminalView({ onOpenSubscribe, embedded = false, visible = true }: {
  onOpenSubscribe?: () => void; embedded?: boolean; visible?: boolean;
}) {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const aiPanelVisible = useTerminalStore((s) => s.aiPanelVisible);
  const addSession = useTerminalStore((s) => s.addSession);
  const updateSessionStatus = useTerminalStore((s) => s.updateSessionStatus);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeParentSession = activeSession?.type === "docker"
    ? sessions.find((session) => session.id === activeSession.parentSessionId) ?? null
    : activeSession;
  const initializedRef = useRef(false);

  const [aiPanelWidth, setAiPanelWidth] = useState(AI_PANEL_DEFAULT_WIDTH);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = aiPanelWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [aiPanelWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = startXRef.current - e.clientX;
      const next = Math.min(
        AI_PANEL_MAX_WIDTH,
        Math.max(AI_PANEL_MIN_WIDTH, startWidthRef.current + delta),
      );
      setAiPanelWidth(next);
    };

    const handleMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  useEffect(() => {
    if (embedded || initializedRef.current) return;
    if (sessions.length > 0) return;
    initializedRef.current = true;

    shellSpawn(80, 24)
      .then((sessionId) => {
        addSession({
          id: sessionId,
          configId: "",
          type: "local",
          status: "connected",
          title: "本地终端",
        });
      })
      .catch(() => {
        const fallbackId = crypto.randomUUID();
        addSession({
          id: fallbackId,
          configId: "",
          type: "local",
          status: "error",
          title: "本地终端",
        });
      });
  }, [embedded, sessions.length, addSession, updateSessionStatus]);

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar onOpenSubscribe={onOpenSubscribe} embedded={embedded} />
        {!embedded && <SessionTabBar />}
        <div className="min-h-0 flex-1">
          <div
            className="h-full"
            style={{ display: activeSession?.type === "batch" ? "block" : "none" }}
          >
            <BatchModeView />
          </div>
          {sessions
              .filter((s) => s.type !== "batch")
              .map((session) => {
                const isActive = session.id === activeSessionId;
                if (session.type === "sftp") {
                  return (
                    <div
                      key={session.id}
                      className="h-full"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <FileManager sessionId={session.id} active={isActive && visible} connected={session.status === "connected"} />
                    </div>
                  );
                }
                if (session.type === "desktop") {
                  return (
                    <div
                      key={session.id}
                      className="h-full"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <DesktopMode
                        sessionId={session.id}
                        aiEnabled
                      />
                    </div>
                  );
                }
                if (session.type === "docker") {
                  const parent = sessions.find(
                    (candidate) => candidate.id === session.parentSessionId,
                  );
                  return (
                    <div
                      key={session.id}
                      className="h-full"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <DockerPanel
                        parentSessionId={session.parentSessionId ?? ""}
                        parentStatus={parent?.status ?? "disconnected"}
                        hostTitle={parent?.title ?? session.title}
                        visible={isActive && visible}
                      />
                    </div>
                  );
                }
                if (session.type === "ssh") {
                  return (
                    <div
                      key={session.id}
                      className="h-full"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <SshWorkspace sessionId={session.id} active={isActive && visible} />
                    </div>
                  );
                }
                if (session.type === "vnc") {
                  return (
                    <div
                      key={session.id}
                      className="h-full"
                      style={{ display: isActive ? "block" : "none" }}
                    >
                      <VncViewer
                        wsUrl={session.vncWsUrl ?? ""}
                        wsToken={session.vncWsToken ?? ""}
                        password={session.vncPassword}
                        onDisconnect={() => {
                          vncReconnect(session.id).then((info) => {
                            useTerminalStore.getState().updateSession(session.id, {
                              vncWsUrl: info.wsUrl,
                              vncWsToken: info.wsToken,
                            });
                          }).catch(() => {
                            useTerminalStore.getState().updateSessionStatus(session.id, "error");
                          });
                        }}
                      />
                    </div>
                  );
                }
                return (
                  <div
                    key={session.id}
                    className="h-full"
                    style={{ display: isActive ? "block" : "none" }}
                  >
                    <XtermTerminal sessionId={session.id} />
                  </div>
                );
              })}
          {!activeSession && <TerminalEmptyState />}
        </div>
        {activeSession?.type !== "ssh" && <StatusBar sessionId={activeParentSession?.id ?? null} />}
      </div>
      {aiPanelVisible &&
        activeSession?.type !== "batch" &&
        activeSession?.type !== "desktop" &&
        activeSession?.type !== "docker" && (
        <>
          <div
            onMouseDown={handleDragStart}
            className="mona-resize-handle relative w-px shrink-0 cursor-col-resize"
          />
          <div
            className="shrink-0 flex flex-col"
            style={{ width: aiPanelWidth }}
          >
            {sessions
              .filter((s) => s.type !== "batch")
              .map((session) => (
                <div
                  key={session.id}
                  className="h-full w-full"
                  style={{ display: session.id === activeSessionId ? "flex" : "none" }}
                >
                  <AIPanel sessionId={session.id} />
                </div>
              ))}
          </div>
        </>
      )}
      <NewConnectionDialog fixedType={embedded ? "ssh" : undefined} />
      <HostKeyConfirmDialog />
      <SshPasswordDialog />
      <ExecApprovalDialog />
      <TerminalSettingsDialog />
    </div>
  );
}

function TerminalEmptyState() {
  return (
    <EmptyState
      className="h-full"
      title="点击「新建」创建一个终端会话"
    />
  );
}
