import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { importOfficeSession } from "@/lib/office-client";
import { OfficeEditorHost } from "./OfficeEditorHost";
import type { OfficeDocumentType, OfficeSessionState } from "./types";

export function officeDocumentType(filename: string): OfficeDocumentType | null {
  const extension = filename.split(".").pop()?.toLowerCase();
  return extension === "docx" ? "docs" : extension === "xlsx" ? "sheets" : extension === "pptx" ? "slides" : null;
}

export function OfficeFileEditor({
  filename,
  sourceIdentity,
  ownerSessionKey,
  fetchBuffer,
  onOpened,
  onClosed,
  onExported,
  exportDirectory,
  toolbarContainer,
}: {
  filename: string;
  sourceIdentity: string;
  ownerSessionKey: string;
  fetchBuffer: () => Promise<ArrayBuffer>;
  onOpened?: (session: OfficeSessionState) => void;
  onClosed?: () => void;
  onExported?: () => void;
  exportDirectory?: string | null;
  toolbarContainer?: HTMLElement | null;
}) {
  const [session, setSession] = useState<OfficeSessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const callbacks = useRef({ fetchBuffer, onOpened });
  callbacks.current = { fetchBuffer, onOpened };

  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setError(null);
    void (async () => {
      try {
        const file = await callbacks.current.fetchBuffer();
        if (cancelled) return;
        const next = await importOfficeSession({ filename, sourceIdentity, ownerSessionKey }, file);
        if (cancelled) return;
        setSession(next);
        callbacks.current.onOpened?.(next);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "文档打开失败。");
      }
    })();
    return () => { cancelled = true; };
  }, [filename, sourceIdentity, ownerSessionKey, attempt]);

  if (error) return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-caption" role="alert">
      <span className="text-destructive">文档打开失败：{error}</span>
      <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
    </div>
  );
  if (!session || onOpened) return (
    <div className="flex h-full items-center justify-center text-caption text-muted-foreground" role="status">
      正在打开文档编辑器…
    </div>
  );
  return (
    <div className="h-full min-h-0 flex-1">
      <OfficeEditorHost
        initialSession={session}
        ownerSessionKey={ownerSessionKey}
        onClosed={() => {
          setSession(null);
          if (onClosed) onClosed();
          else setError("文档编辑器已关闭。");
        }}
        onExported={onExported}
        exportDirectory={exportDirectory}
        toolbarContainer={toolbarContainer}
      />
    </div>
  );
}
