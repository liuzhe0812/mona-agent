import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import { ConversationCanvasPanel } from "./ConversationCanvasPanel";
import type { ConversationCanvasTab } from "./useConversationCanvases";
import type { OperationNote } from "@/components/notes/notes-data";
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
  const saveTimerRef = useRef<number | null>(null);

  const persist = useCallback(async (canvas: WorkspaceCanvasDocument) => {
    try {
      const saved = await writeWorkspaceCanvasFile(filePath, canvas);
      if (canvasRef.current?.canvas.contentMarkdown !== canvas.contentMarkdown) return;
      canvasRef.current = saved;
      setSavedCanvas(saved);
      setSaveStatus("saved");
      setSaveError(undefined);
    } catch (error) {
      if (canvasRef.current?.canvas.contentMarkdown !== canvas.contentMarkdown) return;
      setSaveStatus("error");
      setSaveError(`自动保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [filePath]);

  useEffect(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    canvasRef.current = null;
    setSavedCanvas(null);
    setLoading(true);
    setLoadError(null);
    setSaveStatus("idle");
    setSaveError(undefined);

    let cancelled = false;
    void openWorkspaceCanvasFile(filePath)
      .then((saved) => {
        if (cancelled) return;
        canvasRef.current = saved;
        setSavedCanvas(saved);
        setSaveStatus("saved");
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [filePath]);

  const handleContentChange = useCallback((noteId: string, next: {
    contentMarkdown: string;
    plainText?: string;
  }) => {
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
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persist(updated.canvas);
    }, AUTOSAVE_DELAY_MS);
  }, [persist]);

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
