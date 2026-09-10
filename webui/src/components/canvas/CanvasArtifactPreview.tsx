import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import { FlowchartDocumentEditor } from "@/components/notes/flowchart/FlowchartDocumentEditor";
import { MindMapDocumentEditor } from "@/components/notes/mindmap/MindMapDocumentEditor";
import type { OperationNote } from "@/components/notes/notes-data";
import type { DeliveredFile } from "@/lib/types";
import type { PreviewScope } from "@/components/deliver/filePreviewStore";
import { fetchFilePreviewBlob } from "@/lib/api";
import type { WorkspaceCanvasDocument } from "@/lib/tauri";
import { isTauri } from "@/lib/tauri";
import { useClient } from "@/providers/ClientProvider";
import { CanvasFileView } from "./CanvasFileView";

interface CanvasArtifactPreviewProps {
  file: DeliveredFile;
  scope: PreviewScope;
  sessionKey?: string | null;
  roomId?: string | null;
}

function parseCanvasDocument(source: string): WorkspaceCanvasDocument {
  const canvas = JSON.parse(source) as WorkspaceCanvasDocument;
  if (
    canvas.version !== 1
    || (canvas.kind !== "flowchart" && canvas.kind !== "mindmap")
    || !canvas.id
    || !canvas.title
    || !canvas.contentMarkdown
  ) {
    throw new Error("不是有效的 Mona 画布文件");
  }
  return canvas;
}

function canvasToPreviewNote(canvas: WorkspaceCanvasDocument): OperationNote {
  return {
    id: canvas.id,
    notebookId: "",
    title: canvas.title,
    preview: canvas.kind === "flowchart" ? "流程图" : "思维导图",
    createdAt: canvas.createdAt,
    updatedAt: canvas.updatedAt,
    source: { kind: "agent", label: "Mona 画布预览" },
    contentMarkdown: canvas.contentMarkdown,
    appliedAgentMessageIds: [],
    contextLevel: "none",
    type: canvas.kind,
    originChatId: canvas.originChatId,
  };
}

/** Uses the same authenticated artifact-preview endpoint as Markdown files. */
export function CanvasArtifactPreview({ file, scope, sessionKey, roomId }: CanvasArtifactPreviewProps) {
  const { token } = useClient();
  const [canvas, setCanvas] = useState<WorkspaceCanvasDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const localFilePath = useMemo(() => {
    if (!isTauri()) return null;
    return [file.absolute_path, file.path].find((value) =>
      typeof value === "string"
      && (/^[a-z]:[\\/]/i.test(value) || value.startsWith("/"))
      && value.toLowerCase().endsWith(".mona-canvas"),
    ) ?? null;
  }, [file.absolute_path, file.path]);

  useEffect(() => {
    let cancelled = false;
    setCanvas(null);
    setError(null);
    if (localFilePath) return () => {
      cancelled = true;
    };
    if (!token) {
      setError("连接尚未就绪");
      return () => {
        cancelled = true;
      };
    }

    const previewParams = {
      scope,
      path: file.artifact_ref?.relative_path || file.path,
      sessionKey: scope === "project" || scope === "shared" ? sessionKey ?? null : null,
      room: scope === "room" ? roomId ?? null : null,
      artifactId: file.artifact_ref?.id ?? null,
    } as const;

    void fetchFilePreviewBlob(token, previewParams)
      .catch((cause) => {
        if (!previewParams.artifactId) throw cause;
        return fetchFilePreviewBlob(token, { ...previewParams, artifactId: null });
      })
      .then(async ({ blob }) => parseCanvasDocument(await blob.text()))
      .then((next) => {
        if (!cancelled) setCanvas(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [file.artifact_ref?.id, file.artifact_ref?.relative_path, file.path, localFilePath, roomId, scope, sessionKey, token]);

  const note = useMemo(() => canvas ? canvasToPreviewNote(canvas) : null, [canvas]);
  if (localFilePath) return <CanvasFileView filePath={localFilePath} />;
  if (!note) {
    return (
      <div className="grid h-full place-items-center bg-background p-6 text-sm text-muted-foreground">
        {error ? (
          <div className="flex max-w-sm items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>加载画布预览失败：{error}</span>
          </div>
        ) : (
          <span className="inline-flex items-center gap-2">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            正在加载预览
          </span>
        )}
      </div>
    );
  }

  if (note.type === "flowchart") {
    return (
      <FlowchartDocumentEditor
        note={note}
        readOnly
        readOnlyLabel="只读预览"
        onContentChange={() => undefined}
      />
    );
  }

  return (
    <div className="h-full pointer-events-none">
      <MindMapDocumentEditor note={note} onContentChange={() => undefined} />
    </div>
  );
}
