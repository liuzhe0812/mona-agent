import { memo } from "react";
import { AlertTriangle, Check, LoaderCircle } from "lucide-react";

import { FlowchartDocumentEditor } from "@/components/notes/flowchart/FlowchartDocumentEditor";
import { MindMapDocumentEditor } from "@/components/notes/mindmap/MindMapDocumentEditor";
import { cn } from "@/lib/utils";
import type { ConversationCanvasTab } from "./useConversationCanvases";

interface ConversationCanvasPanelProps {
  canvas: ConversationCanvasTab;
  onContentChange: (
    noteId: string,
    next: { contentMarkdown: string; plainText?: string },
  ) => void;
}

export const ConversationCanvasPanel = memo(function ConversationCanvasPanel({
  canvas,
  onContentChange,
}: ConversationCanvasPanelProps) {
  const { note } = canvas;
  const saveIndicator = (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] text-muted-foreground",
        canvas.saveStatus === "error" && "text-destructive",
      )}
    >
      {canvas.saveStatus === "saving" ? (
        <LoaderCircle className="h-3 w-3 animate-spin" />
      ) : canvas.saveStatus === "saved" ? (
        <Check className="h-3 w-3" />
      ) : null}
      {canvas.saveStatus === "saving"
        ? "正在保存"
        : canvas.saveStatus === "saved"
          ? "已自动保存"
          : canvas.saveStatus === "error"
            ? "保存失败"
            : ""}
    </span>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-editor-surface">
      {note.type === "flowchart" ? (
        <FlowchartDocumentEditor
          note={note}
          onContentChange={(next) => onContentChange(note.id, next)}
          toolbarExtra={saveIndicator}
        />
      ) : (
        <MindMapDocumentEditor
          note={note}
          onContentChange={(next) => onContentChange(note.id, next)}
          toolbarExtra={saveIndicator}
        />
      )}

      {canvas.generationStatus === "creating" ? (
        <div className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-card/95 px-3 py-2 shadow-surface backdrop-blur-sm">
            <LoaderCircle className="h-4 w-4 animate-spin text-theme" />
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-foreground">正在创建{note.title}</p>
              <p className="text-[11px] text-muted-foreground">正在规划结构、样式和连线路径</p>
            </div>
          </div>
        </div>
      ) : null}

      {canvas.generationStatus === "updating" ? (
        <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full border border-border/70 bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
          <span className="inline-flex items-center gap-1.5">
            <LoaderCircle className="h-3 w-3 animate-spin text-theme" />
            Mona 正在修改当前画布
          </span>
        </div>
      ) : null}

      {(canvas.qualityWarnings?.length ?? 0) > 0 ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-amber-500/35 bg-card/95 px-3 py-2 text-[11px] text-amber-700 shadow-surface backdrop-blur-sm dark:text-amber-300">
          {canvas.qualityWarnings![0]}
          {canvas.qualityWarnings!.length > 1 ? `，另有 ${canvas.qualityWarnings!.length - 1} 项布局提醒` : ""}
        </div>
      ) : null}

      {canvas.error ? (
        <div className="absolute inset-x-3 bottom-3 z-40 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs text-destructive shadow-sm">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{canvas.error}</span>
        </div>
      ) : null}
    </div>
  );
});
