import { useCallback, useEffect, useRef, useState } from "react";
import { PanelRight } from "lucide-react";

import { AgentLogo } from "@/components/AgentLogo";
import { MarkdownEditor } from "@/components/common/MarkdownEditor";
import { cn } from "@/lib/utils";
import { MdOutlinePanel } from "./MdOutlinePanel";
import { MdAiPanel } from "./MdAiPanel";
import { useMdReaderStore } from "./mdReaderStore";

const OUTLINE_DEFAULT_WIDTH = 260;
const AI_PANEL_DEFAULT_WIDTH = 320;
const AI_PANEL_MIN_WIDTH = 240;
const AI_PANEL_MAX_WIDTH = 480;

interface MdFileViewProps {
  filePath: string;
}

export function MdFileView({ filePath }: MdFileViewProps) {
  const tabs = useMdReaderStore((s) => s.tabs);
  const openFile = useMdReaderStore((s) => s.openFile);
  const updateTabContent = useMdReaderStore((s) => s.updateTabContent);
  const updateTabMode = useMdReaderStore((s) => s.updateTabMode);
  const updateTabAgentChatId = useMdReaderStore((s) => s.updateTabAgentChatId);
  const saveTab = useMdReaderStore((s) => s.saveTab);
  const reloadTab = useMdReaderStore((s) => s.reloadTab);

  const [outlineOpen, setOutlineOpen] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiPanelWidth, setAiPanelWidth] = useState(AI_PANEL_DEFAULT_WIDTH);
  const [aiStreaming, setAiStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const normalized = filePath.replace(/\\/g, "/");
  const tab = tabs.find((t) => t.filePath.replace(/\\/g, "/") === normalized);

  useEffect(() => {
    if (!tab) {
      openFile(filePath);
    }
  }, [filePath, tab, openFile]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (tab) {
          saveTab(tab.id).catch((err) => {
            console.error("Save failed:", err);
          });
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tab, saveTab]);

  const handleDragStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: aiPanelWidth };
    const handleMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - e.clientX;
      const next = Math.min(
        AI_PANEL_MAX_WIDTH,
        Math.max(AI_PANEL_MIN_WIDTH, dragRef.current.startWidth + delta),
      );
      setAiPanelWidth(next);
    };
    const handleUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, [aiPanelWidth]);

  if (!tab) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        正在加载...
      </div>
    );
  }

  if (tab.loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        正在加载 {tab.fileName}...
      </div>
    );
  }

  if (tab.error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <p className="text-sm font-medium text-destructive">加载失败</p>
        <p className="text-[12px] text-muted-foreground">{tab.error}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div ref={editorContainerRef} className="flex min-h-0 min-w-0 flex-1">
        <MarkdownEditor
          content={tab.content}
          mode={tab.mode}
          editorClassName="note-editor-cursor"
          onModeChange={(mode) => updateTabMode(tab.id, mode)}
          onContentChange={(next) => updateTabContent(tab.id, next.contentMarkdown)}
          placeholder="Markdown 文档内容..."
          showStats
          statsExtra={
            tab.dirty ? (
              <span className="text-[#eba45d]">未保存</span>
            ) : (
              <span>已保存</span>
            )
          }
          toolbarTrailingExtra={
            <>
              <button
                type="button"
                title={aiPanelOpen ? "收起 AI" : "展开 AI"}
                aria-label={aiPanelOpen ? "收起 AI" : "展开 AI"}
                onClick={() => setAiPanelOpen((v) => !v)}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-md transition-colors",
                  aiPanelOpen
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <AgentLogo state={aiStreaming ? "working" : "idle"} className="h-4 w-4" />
              </button>
              <button
                type="button"
                title={outlineOpen ? "收起目录" : "展开目录"}
                aria-label={outlineOpen ? "收起目录" : "展开目录"}
                onClick={() => setOutlineOpen((v) => !v)}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-md transition-colors",
                  outlineOpen
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <PanelRight className="h-4 w-4" />
              </button>
            </>
          }
          className="min-h-0 flex-1"
        />
      </div>
      {outlineOpen && (
        <MdOutlinePanel
          content={tab.content}
          editorContainerRef={editorContainerRef}
          width={OUTLINE_DEFAULT_WIDTH}
        />
      )}
      {aiPanelOpen && (
        <div
          onMouseDown={handleDragStart}
          className="w-[1px] shrink-0 cursor-col-resize bg-border"
        />
      )}
      {aiPanelOpen && (
        <MdAiPanel
          filePath={tab.filePath}
          fileName={tab.fileName}
          content={tab.content}
          chatId={tab.agentChatId}
          onChatIdChange={(chatId) => updateTabAgentChatId(tab.id, chatId)}
          width={aiPanelWidth}
          onClose={() => setAiPanelOpen(false)}
          onStreamingChange={setAiStreaming}
          onFileEdited={() => {
            if (tab) {
              reloadTab(tab.id);
              setNotice("文件已被 AI 修改");
            }
          }}
          onPrepareEdit={async () => {
            if (tab && tab.dirty) {
              await saveTab(tab.id);
            }
          }}
        />
      )}
    </div>
  );
}
