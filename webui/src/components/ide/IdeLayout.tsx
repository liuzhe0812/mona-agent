import { useCallback, useEffect, useRef, useState } from "react";
import { XtermTerminal } from "../terminal/XtermTerminal";
import { IdeFileTree } from "./IdeFileTree";
import { IdeEditorPanel } from "./IdeEditorPanel";
import { IdeConflictDialog } from "./IdeConflictDialog";
import { IdeSystemMonitor } from "./IdeSystemMonitor";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useIdeStore } from "./useIdeStore";
import { useTerminalStore } from "../terminal/store/terminalStore";
import { Loader2 } from "lucide-react";

const FILE_TREE_DEFAULT_WIDTH = 240;
const FILE_TREE_MIN_WIDTH = 200;
const FILE_TREE_MAX_WIDTH = 600;

const SYSTEM_MONITOR_DEFAULT_WIDTH = 320;
const SYSTEM_MONITOR_MIN_WIDTH = 260;
const SYSTEM_MONITOR_MAX_WIDTH = 480;

interface IdeLayoutProps {
  sessionId: string;
}

export function IdeLayout({ sessionId }: IdeLayoutProps) {
  const ideVisible = useIdeStore((s) => s.ideVisible);
  const openProject = useIdeStore((s) => s.openProject);
  const currentSessionId = useIdeStore((s) => s.sessionId);
  const fileTreeVisible = useIdeStore((s) => s.leftFileTreeVisible);
  const systemMonitorVisible = useIdeStore((s) => s.leftSystemMonitorVisible);
  const sessionStatus = useTerminalStore(
    (s) => s.sessions.find((sess) => sess.id === sessionId)?.status,
  );
  const [resizing, setResizing] = useState(false);

  const [fileTreeWidth, setFileTreeWidth] = useState(FILE_TREE_DEFAULT_WIDTH);
  const [systemMonitorWidth, setSystemMonitorWidth] = useState(
    SYSTEM_MONITOR_DEFAULT_WIDTH,
  );
  const draggingRef = useRef<"fileTree" | "systemMonitor" | null>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleDragStart = useCallback(
    (panel: "fileTree" | "systemMonitor", e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = panel;
      startXRef.current = e.clientX;
      startWidthRef.current =
        panel === "fileTree" ? fileTreeWidth : systemMonitorWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [fileTreeWidth, systemMonitorWidth],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      if (draggingRef.current === "fileTree") {
        const next = Math.min(
          FILE_TREE_MAX_WIDTH,
          Math.max(FILE_TREE_MIN_WIDTH, startWidthRef.current + delta),
        );
        setFileTreeWidth(next);
      } else {
        const next = Math.min(
          SYSTEM_MONITOR_MAX_WIDTH,
          Math.max(SYSTEM_MONITOR_MIN_WIDTH, startWidthRef.current + delta),
        );
        setSystemMonitorWidth(next);
      }
    };

    const handleMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = null;
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
    if (sessionStatus !== "connected") return;
    if (currentSessionId === sessionId) return;
    openProject(sessionId, "~").catch(console.error);
  }, [sessionId, openProject, sessionStatus, currentSessionId]);

  if (sessionStatus === "connecting") {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">连接中…</span>
        </div>
      </div>
    );
  }

  if (sessionStatus === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <span className="text-sm text-red-500">连接失败</span>
      </div>
    );
  }

  const renderDragHandle = (panel: "fileTree" | "systemMonitor") => (
    <div
      onMouseDown={(e) => handleDragStart(panel, e)}
      className="relative w-0 shrink-0 cursor-col-resize"
    >
      <div className="absolute -left-1.5 top-0 bottom-0 w-3 bg-border/0 hover:bg-primary/40 active:bg-primary/40" />
      <div className="absolute left-0 top-0 bottom-0 w-px bg-border" />
    </div>
  );

  return (
    <div className="flex h-full">
      {fileTreeVisible && (
        <>
          <div
            className="shrink-0 overflow-hidden"
            style={{ width: fileTreeWidth }}
          >
            <IdeFileTree />
          </div>
          {renderDragHandle("fileTree")}
        </>
      )}

      {systemMonitorVisible && (
        <>
          <div
            className="shrink-0 overflow-hidden"
            style={{ width: systemMonitorWidth }}
          >
            <IdeSystemMonitor sessionId={sessionId} />
          </div>
          {renderDragHandle("systemMonitor")}
        </>
      )}

      {/* Right column: shell + optional IDE */}
      <div className="min-w-0 flex-1">
        {ideVisible ? (
          <ResizablePanelGroup
            direction="vertical"
            className="h-full"
            onLayoutChange={() => setResizing(true)}
            onLayoutChanged={() => setResizing(false)}
          >
            <ResizablePanel defaultSize={50} minSize={20}>
              <div
                className={resizing ? "pointer-events-none h-full" : "h-full"}
              >
                <XtermTerminal sessionId={sessionId} />
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={50} minSize={15}>
              <IdeEditorPanel />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <XtermTerminal sessionId={sessionId} />
        )}
      </div>

      <IdeConflictDialog />
    </div>
  );
}
