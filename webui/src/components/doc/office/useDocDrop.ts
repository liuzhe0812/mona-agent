import { useCallback, useRef, useState } from "react";

/** Document extensions accepted by the "文档加工" workbench.
 *  Mirrors the server-side `_DOC_MIME_ALLOWED` whitelist. */
export const DOC_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".pptx",
  ".ppt",
  ".csv",
  ".tsv",
  ".txt",
  ".md",
  ".markdown",
  ".json",
] as const;

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Extract dropped document files (PDF/Word/Excel/PPT/CSV/Markdown/JSON/text). */
export function extractDocFilesFromDrop(
  event: DragEvent | React.DragEvent,
): File[] {
  const dt = (event as DragEvent).dataTransfer
    ?? (event as React.DragEvent).dataTransfer;
  if (!dt) return [];
  const files: File[] = [];
  for (const item of Array.from(dt.files)) {
    if (hasAcceptedExtension(item.name)) files.push(item);
  }
  return files;
}

/** Extract pasted document files. Most browsers only expose pasted images
 *  via clipboardData.items, but file pastes (e.g. from a file manager) do
 *  surface non-image files on some platforms, so we accept them when present. */
export function extractDocFilesFromPaste(
  event: ClipboardEvent | React.ClipboardEvent,
): File[] {
  const clipboard = (event as ClipboardEvent).clipboardData
    ?? (event as React.ClipboardEvent).clipboardData;
  if (!clipboard) return [];
  const files: File[] = [];
  for (const item of Array.from(clipboard.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && hasAcceptedExtension(file.name)) files.push(file);
  }
  return files;
}

export interface UseDocDropApi {
  isDragging: boolean;
  onPaste: (event: React.ClipboardEvent) => void;
  onDragEnter: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}

/** Wire paste + drag-and-drop of *documents* (not images) to a callback.
 *
 *  Independent from `useClipboardAndDrop` (which is image-only and shared
 *  across many components). This hook only handles document types, so the two
 *  can coexist on the same surface without stealing each other's events. */
export function useDocDrop(onDocFiles: (files: File[]) => void): UseDocDropApi {
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);

  const onPaste = useCallback(
    (event: React.ClipboardEvent) => {
      const files = extractDocFilesFromPaste(event);
      if (files.length === 0) return;
      event.preventDefault();
      onDocFiles(files);
    },
    [onDocFiles],
  );

  const onDragEnter = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      dragDepth.current = 0;
      setIsDragging(false);
      const files = extractDocFilesFromDrop(event);
      if (files.length === 0) return;
      event.preventDefault();
      onDocFiles(files);
    },
    [onDocFiles],
  );

  return { isDragging, onPaste, onDragEnter, onDragOver, onDragLeave, onDrop };
}

/** Read a File as a base64 data URL. Resolves to the data URL string. */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
