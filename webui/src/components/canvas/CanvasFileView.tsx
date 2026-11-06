import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import { ConversationCanvasPanel } from "./ConversationCanvasPanel";
import type { ConversationCanvasTab } from "./useConversationCanvases";
import type { OperationNote } from "@/components/notes/notes-data";
import { getHostedPlatform } from "@/lib/hosted-platform";
import {
  openWorkspaceCanvasFile,
  writeWorkspaceCanvasFile,
  type SavedWorkspaceCanvas,
  type WorkspaceCanvasDocument,
} from "@/lib/tauri";

const AUTOSAVE_DELAY_MS = 450;

interface CanvasFileViewProps {
  filePath: string;
}

function canvasToEditorNote(canvas: WorkspaceCanvasDocument): OperationNote {
  return {
    id: canvas.id,
    notebookId: "",
    title: canvas.title,
    preview: canvas.kind === "flowchart" ? "流程图" : "思维导图",
    createdAt: canvas.createdAt,
    updatedAt: canvas.updatedAt,
    source: { kind: "agent", label: "Mona 画布文件" },
    contentMarkdown: canvas.contentMarkdown,
    appliedAgentMessageIds: [],
    contextLevel: "none",
    type: canvas.kind,
    originChatId: canvas.originChatId,
  };
}

export function CanvasFileView({ filePath }: CanvasFileViewProps) {
  const [savedCanvas, setSavedCanvas] = useState<SavedWorkspaceCanvas | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<ConversationCanvasTab["saveStatus"]>("idle");
  const [saveError, setSaveError] = useState<string | undefined>();
  const canvasRef = useRef<SavedWorkspaceCanvas | null>(null);
  const platform = getHostedPlatform();
  const view = useMemo(() => ({ filePath, platform }), [filePath, platform]);
  const viewRef = useRef(view);
  const mountedRef = useRef(true);
  const pendingSavesRef = useRef(new Map<string, { timer: number; view: typeof view; save: () => Promise<void> }>());
  viewRef.current = view;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const flushPendingSave = useCallback((path: string) => {
    const pending = pendingSavesRef.current.get(path);
    if (!pending) return;
    pendingSavesRef.current.delete(path);
    window.clearTimeout(pending.timer);
    if (getHostedPlatform() === pending.view.platform) void pending.save();
  }, []);

  const persist = useCallback(async (canvas: WorkspaceCanvasDocument) => {
    const currentView = () => mountedRef.current && viewRef.current === view && getHostedPlatform() === view.platform;
    if (getHostedPlatform() !== view.platform) return;
    try {
      const saved = await writeWorkspaceCanvasFile(filePath, canvas);
      if (!currentView() || canvasRef.current?.canvas.contentMarkdown !== canvas.contentMarkdown) return;
      canvasRef.current = saved;
      setSavedCanvas(saved);
      setSaveStatus("saved");
      setSaveError(undefined);
    } catch (error) {
      if (!currentView()) {
        if (getHostedPlatform() === view.platform) window.alert(`画布“${canvas.title}”保存未能确认，请重新打开原文件核对。`);
        return;
      }
      if (canvasRef.current?.canvas.contentMarkdown !== canvas.contentMarkdown) return;
      setSaveStatus("error");
      setSaveError(`自动保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [filePath, view]);

  useEffect(() => {
    canvasRef.current = null;
    setSavedCanvas(null);
    setLoading(true);
    setLoadError(null);
    setSaveStatus("idle");
    setSaveError(undefined);

    let cancelled = false;
    void openWorkspaceCanvasFile(filePath)
      .then((saved) => {
        if (cancelled || getHostedPlatform() !== platform) return;
        canvasRef.current = saved;
        setSavedCanvas(saved);
        setSaveStatus("saved");
      })
      .catch((error) => {
        if (cancelled || getHostedPlatform() !== platform) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled && getHostedPlatform() === platform) setLoading(false);
      });

    return () => {
      cancelled = true;
      flushPendingSave(filePath);
    };
  }, [filePath, flushPendingSave, platform]);

  const handleContentChange = useCallback((noteId: string, next: {
    contentMarkdown: string;
    plainText?: string;
  }) => {
    if (!mountedRef.current || viewRef.current !== view || getHostedPlatform() !== view.platform) return;
    const current = canvasRef.current;
    if (!current || current.canvas.id !== noteId || current.canvas.contentMarkdown === next.contentMarkdown) return;

    const updated: SavedWorkspaceCanvas = {
      ...current,
      canvas: {
        ...current.canvas,
        contentMarkdown: next.contentMarkdown,
        updatedAt: new Date().toISOString(),
      },
    };
    canvasRef.current = updated;
    setSavedCanvas(updated);
    setSaveStatus("saving");
    setSaveError(undefined);
    const previous = pendingSavesRef.current.get(filePath);
    if (previous) window.clearTimeout(previous.timer);
    const pending = { timer: 0, view, save: () => persist(updated.canvas) };
    pending.timer = window.setTimeout(() => {
      if (pendingSavesRef.current.get(filePath) === pending) flushPendingSave(filePath);
    }, AUTOSAVE_DELAY_MS);
    pendingSavesRef.current.set(filePath, pending);
  }, [filePath, flushPendingSave, persist, view]);

  const canvas = useMemo<ConversationCanvasTab | null>(() => {
    if (!savedCanvas) return null;
    const note = canvasToEditorNote(savedCanvas.canvas);
    return {
      id: `canvas-file:${savedCanvas.path}`,
      note,
      workspacePath: savedCanvas.path,
      generationStatus: "idle",
      saveStatus,
      error: saveError,
    };
  }, [saveError, saveStatus, savedCanvas]);

  if (loading) {
    return (
      <div className="grid h-full place-items-center bg-background text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          正在打开画布
        </span>
      </div>
    );
  }

  if (loadError || !canvas) {
    return (
      <div className="grid h-full place-items-center bg-background p-6">
        <div className="flex max-w-lg items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">无法打开画布文件</p>
            <p className="mt-1 text-destructive/80">{loadError || "文件内容不完整"}</p>
          </div>
        </div>
      </div>
    );
  }

  return <ConversationCanvasPanel canvas={canvas} onContentChange={handleContentChange} />;
}
