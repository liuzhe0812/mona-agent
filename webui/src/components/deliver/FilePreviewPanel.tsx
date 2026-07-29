import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  FileText,
  Image as ImageIcon,
  FileCode,
  File,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useFilePreviewStore } from "./filePreviewStore";
import { isTauri, openPathWithSystemApp, revealItemInDir } from "@/lib/tauri";
import { useClient } from "@/providers/ClientProvider";
import { fetchFilePreviewBlob } from "@/lib/api";
import { OfficePreview, isOfficePreviewable } from "@/components/common/OfficePreview";
import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";
import type { DeliveredFile } from "@/lib/types";

const PREVIEWABLE_TEXT_EXTS = new Set([
  ".txt", ".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml",
  ".toml", ".cfg", ".ini", ".sh", ".bash", ".zsh", ".css", ".scss", ".html",
  ".htm", ".xml", ".sql", ".csv", ".log", ".env", ".gitignore", ".rs", ".go",
  ".java", ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt",
]);

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const HTML_EXTS = new Set([".html", ".htm"]);
const MARKDOWN_EXTS = new Set([".md", ".markdown"]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function isPreviewableText(file: DeliveredFile): boolean {
  return PREVIEWABLE_TEXT_EXTS.has(extOf(file.name))
    || file.mime.startsWith("text/")
    || file.mime === "application/json";
}

function isMarkdown(file: DeliveredFile): boolean {
  return MARKDOWN_EXTS.has(extOf(file.name))
    || file.mime === "text/markdown";
}

function isPreviewableImage(file: DeliveredFile): boolean {
  return IMAGE_EXTS.has(extOf(file.name)) || file.mime.startsWith("image/");
}

function isHtml(file: DeliveredFile): boolean {
  return HTML_EXTS.has(extOf(file.name));
}

function FileIcon({ file }: { file: DeliveredFile }) {
  const ext = extOf(file.name);
  if (IMAGE_EXTS.has(ext)) return <ImageIcon className="h-4 w-4" />;
  if ([".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go"].includes(ext))
    return <FileCode className="h-4 w-4" />;
  return <FileText className="h-4 w-4" />;
}

export function FilePreviewPanel() {
  const file = useFilePreviewStore((s) => s.file);
  const scope = useFilePreviewStore((s) => s.scope);
  const sessionKey = useFilePreviewStore((s) => s.sessionKey);
  const close = useFilePreviewStore((s) => s.close);
  const fullscreen = useFilePreviewStore((s) => s.fullscreen);
  const toggleFullscreen = useFilePreviewStore((s) => s.toggleFullscreen);
  const { token } = useClient();

  // Build/revoke Blob URLs whenever the preview target or scope changes.
  // Holds at most one URL at a time; previous URL is revoked before the
  // new one is assigned so we never leak.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobError, setBlobError] = useState<string | null>(null);
  const [textSource, setTextSource] = useState<string | null>(null);
  const currentUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!file || !token) {
      setBlobUrl(null);
      setTextSource(null);
      setBlobError(null);
      return;
    }
    // Office 文档由 OfficePreview 组件自行加载，跳过 blob 获取
    if (isOfficePreviewable(file.name)) {
      setBlobUrl(null);
      setTextSource(null);
      setBlobError(null);
      return;
    }
    let cancelled = false;
    setBlobError(null);
    setTextSource(null);

    (async () => {
      try {
        const { blob, mime } = await fetchFilePreviewBlob(token, {
          scope,
          path: file.path,
          sessionKey: scope === "project" ? sessionKey : null,
        });
        if (cancelled) return;
        // HTML / Markdown / 文本走 textSource；其他二进制走 Blob URL
        if (isHtml(file)) {
          const text = await blob.text();
          if (cancelled) return;
          setTextSource(text);
          setBlobUrl(null);
        } else if (isMarkdown(file)) {
          const text = await blob.text();
          if (cancelled) return;
          setTextSource(text);
          setBlobUrl(null);
        } else if (mime.startsWith("text/") || mime === "application/json") {
          const text = await blob.text();
          if (cancelled) return;
          setTextSource(text);
          setBlobUrl(null);
        } else {
          const url = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          if (currentUrlRef.current) {
            URL.revokeObjectURL(currentUrlRef.current);
          }
          currentUrlRef.current = url;
          setBlobUrl(url);
          setTextSource(null);
        }
      } catch (err) {
        if (cancelled) return;
        setBlobError(err instanceof Error ? err.message : String(err));
        setBlobUrl(null);
        setTextSource(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, scope, sessionKey, token]);

  // Revoke the lingering Blob URL on unmount.
  useEffect(() => {
    return () => {
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = null;
      }
    };
  }, []);

  // Esc exits fullscreen.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, toggleFullscreen]);

  if (!file) return null;

  const header = (
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
      <FileIcon file={file} />
      <span className="flex-1 truncate text-sm font-medium">{file.name}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{file.size_human}</span>
      <button
        type="button"
        onClick={toggleFullscreen}
        title={fullscreen ? "退出全屏 (Esc)" : "全屏显示"}
        className="ml-1 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={close}
        title="返回列表"
        className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  const isOffice = isOfficePreviewable(file.name);

  const body = isOffice ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <OfficePreview
        filename={file.name}
        fetchBuffer={async () => {
          if (!token) throw new Error("No token");
          const { blob } = await fetchFilePreviewBlob(token, {
            scope,
            path: file.path,
            sessionKey: scope === "project" ? sessionKey : null,
          });
          return blob.arrayBuffer();
        }}
      />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col">
      {blobError ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-xs text-destructive">
          <File className="h-10 w-10 opacity-40" />
          <span>加载预览失败：{blobError}</span>
        </div>
      ) : isHtml(file) && textSource !== null ? (
        <iframe
          srcDoc={textSource}
          className="h-full w-full border-0"
          title="File preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        />
      ) : isMarkdown(file) && textSource !== null ? (
        <div className="markdown-content scrollbar-hover h-full w-full overflow-auto px-4 py-2 text-sm">
          <MarkdownTextRenderer>{textSource}</MarkdownTextRenderer>
        </div>
      ) : isPreviewableText(file) && textSource !== null ? (
        <pre className="scrollbar-thin h-full w-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs text-foreground">
          {textSource}
        </pre>
      ) : isPreviewableImage(file) && blobUrl ? (
        <div className="flex h-full items-center justify-center p-4">
          <img
            src={blobUrl}
            alt={file.name}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      ) : blobUrl ? (
        <iframe
          src={blobUrl}
          className="h-full w-full border-0"
          title="File preview"
          sandbox="allow-same-origin"
        />
      ) : (
        <NoPreview file={file} />
      )}
    </div>
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background animate-in fade-in-0 duration-150">
        {header}
        {body}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {header}
      {body}
    </div>
  );
}

function NoPreview({ file }: { file: DeliveredFile }) {
  const handleOpen = useCallback(() => {
    if (isTauri()) void openPathWithSystemApp(file.absolute_path);
  }, [file.absolute_path]);

  const handleReveal = useCallback(() => {
    if (isTauri()) void revealItemInDir(file.absolute_path);
  }, [file.absolute_path]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <File className="h-12 w-12 opacity-40" />
      <p className="text-sm">此文件类型不支持预览</p>
      <div className="flex gap-2">
        {isTauri() && (
          <>
            <button
              type="button"
              onClick={handleOpen}
              className="rounded-md border border-border/70 px-3 py-1.5 text-xs hover:bg-muted"
            >
              系统程序打开
            </button>
            <button
              type="button"
              onClick={handleReveal}
              className="rounded-md border border-border/70 px-3 py-1.5 text-xs hover:bg-muted"
            >
              打开所在目录
            </button>
          </>
        )}
      </div>
    </div>
  );
}
