import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { IdeLayout } from "../ide/IdeLayout";
import { FileManager } from "./FileManager/FileManager";
import { useTerminalStore } from "./store/terminalStore";

export function SshWorkspace({ sessionId, active }: { sessionId: string; active: boolean }) {
  const session = useTerminalStore((state) => state.sessions.find((item) => item.id === sessionId));
  const showFiles = session?.sftpVisible !== false;
  const connected = session?.status === "connected";
  const filesPanel = useRef<PanelImperativeHandle | null>(null);
  const groupElement = useRef<HTMLDivElement | null>(null);
  const [filesMounted, setFilesMounted] = useState(false);

  useEffect(() => {
    if (active && showFiles && connected) setFilesMounted(true);
  }, [active, showFiles, connected]);

  useLayoutEffect(() => {
    if (showFiles) filesPanel.current?.expand();
    else filesPanel.current?.collapse();
  }, [showFiles, active]);

  return (
    <ResizablePanelGroup direction="vertical" elementRef={groupElement} className="min-h-0"
      aria-label="SSH 终端与文件" id={`ssh-workspace-${sessionId}`}>
      <ResizablePanel id={`ssh-shell-${sessionId}`} defaultSize="60%" minSize="20%" className="min-h-0 overflow-hidden">
        <div className="relative h-full min-h-0">
          <IdeLayout sessionId={sessionId} active={active} showFileTree={false} />
          <Button type="button" variant="secondary" size="icon"
            className="absolute bottom-0 left-1/2 z-20 h-4 w-9 -translate-x-1/2 rounded-b-none text-muted-foreground shadow-none hover:text-foreground"
            aria-label={showFiles ? "收起文件区" : "展开文件区"}
            title={showFiles ? "收起文件区" : "展开文件区"}
            aria-expanded={showFiles} aria-controls={`ssh-files-${sessionId}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => useTerminalStore.getState().updateSession(sessionId, { sftpVisible: !showFiles })}>
            {showFiles ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </ResizablePanel>
      <ResizableHandle aria-label="调整终端与文件区域高度" disabled={!showFiles}
        className={cn(!showFiles && "invisible pointer-events-none")} />
      <ResizablePanel id={`ssh-files-${sessionId}`} panelRef={filesPanel} collapsible collapsedSize="0%"
        defaultSize="40%" minSize="20%" maxSize="80%" className="min-h-0 overflow-hidden"
        onResize={(size, _id, previous) => {
          if (!previous || !active || !groupElement.current?.clientHeight) return;
          const current = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
          const expanded = size.asPercentage > 0;
          if (current && (current.sftpVisible !== false) !== expanded) {
            useTerminalStore.getState().updateSession(sessionId, { sftpVisible: expanded });
          }
        }}>
        <div className="relative h-full min-h-0" aria-label="SSH 文件区" aria-hidden={!active || !showFiles}
          inert={!active || !showFiles}>
          {filesMounted && <FileManager sessionId={sessionId} active={active && showFiles} connected={connected} />}
          {!connected && <div role="status" className="absolute inset-0 flex items-center justify-center bg-background text-caption text-muted-foreground">
            {session?.status === "connecting" ? "连接中…" : "连接主机后即可浏览文件"}
          </div>}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
