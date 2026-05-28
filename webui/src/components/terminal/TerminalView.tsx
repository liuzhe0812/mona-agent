import { useCallback, useEffect, useRef, useState } from "react";
import { Toolbar } from "./Toolbar";
import { SessionTabBar } from "./SessionTabBar";
import { XtermTerminal } from "./XtermTerminal";
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
import { useTerminalStore } from "./store/terminalStore";
import { shellSpawn } from "./ipc";

const AI_PANEL_DEFAULT_WIDTH = 320;
const AI_PANEL_MIN_WIDTH = 240;
const AI_PANEL_MAX_WIDTH = 600;

export function TerminalView() {
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const aiPanelVisible = useTerminalStore((s) => s.aiPanelVisible);
  const addSession = useTerminalStore((s) => s.addSession);
  const updateSessionStatus = useTerminalStore((s) => s.updateSessionStatus);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
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
    if (initializedRef.current) return;
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
  }, [sessions.length, addSession, updateSessionStatus]);

  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      <SessionTabBar />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {activeSession?.type === "batch" ? (
            <BatchModeView />
          ) : (
            sessions
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
                      <FileManager sessionId={session.id} />
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
                      <DesktopMode sessionId={session.id} />
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
              })
          )}
          {!activeSession && <TerminalEmptyState />}
        </div>
        {aiPanelVisible && activeSession?.type !== "batch" && (
          <>
            <div
              onMouseDown={handleDragStart}
              className="w-px shrink-0 cursor-col-resize bg-border active:bg-primary/40"
            />
            <div
              className="shrink-0 flex-col"
              style={{ width: aiPanelWidth }}
            >
              <AIPanel sessionId={activeSessionId} />
            </div>
          </>
        )}
      </div>
      <StatusBar sessionId={activeSessionId} />
      <NewConnectionDialog />
      <HostKeyConfirmDialog />
      <SshPasswordDialog />
      <ExecApprovalDialog />
      <TerminalSettingsDialog />
    </div>
  );
}

function TerminalEmptyState() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <div className="text-center">
        <p className="text-sm">点击「新建」创建一个终端会话</p>
      </div>
    </div>
  );
}
