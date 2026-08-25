import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  FileText,
  Image as ImageIcon,
  FileCode,
  File,
  Maximize2,
  Minimize2,
  PlaySquare,
} from "lucide-react";
import { useFilePreviewStore } from "./filePreviewStore";
import { isTauri, openPathWithSystemApp, revealItemInDir } from "@/lib/tauri";
import { useClient } from "@/providers/ClientProvider";
import { fetchFilePreviewBlob } from "@/lib/api";
import { OfficePreview, isOfficePreviewable } from "@/components/common/OfficePreview";
import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { DeliveredFile } from "@/lib/types";

const PREVIEWABLE_TEXT_EXTS = new Set([
  ".txt", ".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml",
  ".toml", ".cfg", ".ini", ".sh", ".bash", ".zsh", ".css", ".scss", ".html",
  ".htm", ".xml", ".sql", ".csv", ".log", ".env", ".gitignore", ".rs", ".go",
  ".java", ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt",
]);

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".3gp"]);
const HTML_EXTS = new Set([".html", ".htm"]);
const MARKDOWN_EXTS = new Set([".md", ".markdown"]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/** Stable identity of a delivered file across scan results and live
 *  deliver events (absolute path preferred). */
function fileKey(f: DeliveredFile): string {
  return f.absolute_path || f.path || f.name;
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

function isPreviewableVideo(file: DeliveredFile): boolean {
  return VIDEO_EXTS.has(extOf(file.name)) || file.mime.startsWith("video/");
}

function isHtml(file: DeliveredFile): boolean {
  return HTML_EXTS.has(extOf(file.name));
}

const HTML_RESOURCE_ATTRS: Record<string, string> = {
  img: "src",
  object: "data",
  script: "src",
  link: "href",
  source: "src",
  video: "poster",
};

function resolveRelativeResource(htmlPath: string, rawUrl: string): string | null {
  const value = rawUrl.trim();
  if (
    !value ||
    value.startsWith("#") ||
    value.startsWith("/") ||
    /^(?:[a-z][a-z\d+.-]*:|\\\\)/i.test(value)
  ) {
    return null;
  }
  const clean = value.split(/[?#]/, 1)[0];
  const parts: string[] = [];
  const base = htmlPath.replaceAll("\\", "/").split("/");
  base.pop();
  for (const part of [...base, ...clean.split("/")]) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/") || null;
}

async function blobAsDataUrl(blob: Blob, mime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mime || blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

async function inlineCssResources(
  css: string,
  cssPath: string,
  token: string,
  params: Parameters<typeof fetchFilePreviewBlob>[1],
): Promise<string> {
  const urls = new Set<string>();
  for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    urls.add(match[1]);
  }
  const replacements = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (url) => {
      const path = resolveRelativeResource(cssPath, url);
      if (!path) return;
      try {
        const { blob, mime } = await fetchFilePreviewBlob(token, {
          ...params,
          path,
          artifactId: null,
        });
        replacements.set(url, await blobAsDataUrl(blob, mime));
      } catch {
        // Keep the original URL when an optional font/image is unavailable.
      }
    }),
  );
  return css.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (full, _quote: string, url: string) => {
      const replacement = replacements.get(url);
      return replacement ? `url(${replacement})` : full;
    },
  );
}

async function inlineHtmlResources(
  html: string,
  token: string,
  params: Parameters<typeof fetchFilePreviewBlob>[1],
): Promise<string> {
  if (typeof DOMParser === "undefined") return html;
  const document = new DOMParser().parseFromString(html, "text/html");
  const resources = Object.entries(HTML_RESOURCE_ATTRS).flatMap(([tag, attr]) =>
    Array.from(document.querySelectorAll(`${tag}[${attr}]`)).map((element) => ({
      element,
      attr,
      url: element.getAttribute(attr) ?? "",
    })),
  );
  await Promise.all(
    Array.from(document.querySelectorAll("style")).map(async (style) => {
      style.textContent = await inlineCssResources(style.textContent ?? "", params.path, token, params);
    }),
  );
  await Promise.all(
    resources.map(async ({ element, attr, url }) => {
      const path = resolveRelativeResource(params.path, url);
      if (!path) return;
      try {
        const { blob, mime } = await fetchFilePreviewBlob(token, {
          ...params,
          path,
          artifactId: null,
        });
        const resource = mime.includes("text/css")
          ? await inlineCssResources(await blob.text(), path, token, params)
          : await blobAsDataUrl(blob, mime);
        element.setAttribute(attr, await blobAsDataUrl(new Blob([resource]), mime));
      } catch {
        // Keep the original URL when an optional asset is unavailable.
      }
    }),
  );
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

function FileIcon({ file }: { file: DeliveredFile }) {
  const ext = extOf(file.name);
  if (IMAGE_EXTS.has(ext)) return <ImageIcon className="h-4 w-4" />;
  if (VIDEO_EXTS.has(ext)) return <PlaySquare className="h-4 w-4" />;
  if ([".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go"].includes(ext))
    return <FileCode className="h-4 w-4" />;
  return <FileText className="h-4 w-4" />;
}

export function FilePreviewPanel({ files = [] }: { files?: DeliveredFile[] }) {
  const file = useFilePreviewStore((s) => s.file);
  const scope = useFilePreviewStore((s) => s.scope);
  const sessionKey = useFilePreviewStore((s) => s.sessionKey);
  const roomId = useFilePreviewStore((s) => s.roomId);
  const close = useFilePreviewStore((s) => s.close);
  const open = useFilePreviewStore((s) => s.open);
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
        const previewParams = {
          scope,
          path: file.path,
          sessionKey: scope === "project" || scope === "shared" ? sessionKey : null,
          room: scope === "room" ? roomId : null,
          artifactId: file.artifact_ref?.id ?? null,
        } as const;
        const { blob, mime } = await fetchFilePreviewBlob(token, previewParams);
        if (cancelled) return;
        // HTML / Markdown / 文本走 textSource；其他二进制走 Blob URL
        if (isHtml(file)) {
          const text = await blob.text();
          if (cancelled) return;
          const prepared = await inlineHtmlResources(text, token, previewParams);
          if (cancelled) return;
          setTextSource(prepared);
          setBlobUrl(null);
        } else if (isMarkdown(file)) {
          const text = await blob.text();
          if (cancelled) return;
          setTextSource(text);
          setBlobUrl(null);
        } else if (
          !isPreviewableImage(file)
          && !isPreviewableVideo(file)
          && (mime.startsWith("text/") || mime === "application/json")
        ) {
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
  }, [file, scope, sessionKey, roomId, token]);

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

  // Prev/next cycles within the current scope's file list, in the same
  // visual order the workspace panel displays (session section + tree).
  const navIndex = files.findIndex((f) => fileKey(f) === fileKey(file));
  const canNav = files.length > 1 && navIndex !== -1;
  const navTo = (delta: number) => {
    if (!canNav) return;
    const next = files[(navIndex + delta + files.length) % files.length];
    open(next, scope, sessionKey, roomId);
  };

  const header = (
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
      <Button
        type="button"
        variant="ghost"
        onClick={close}
        title="返回列表"
        aria-label="返回列表"
        className="h-6 w-6 rounded-sm p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <FileIcon file={file} />
      <span className="flex-1 truncate text-body font-medium">{file.name}</span>
      <span className="shrink-0 text-micro text-muted-foreground">{file.size_human}</span>
      {canNav ? (
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={() => navTo(-1)}
            title="上一个文件"
            aria-label="上一个文件"
            className="h-6 w-6 rounded-sm p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => navTo(1)}
            title="下一个文件"
            aria-label="下一个文件"
            className="h-6 w-6 rounded-sm p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        onClick={toggleFullscreen}
        title={fullscreen ? "退出全屏 (Esc)" : "全屏显示"}
        aria-label={fullscreen ? "退出全屏" : "全屏显示"}
        className="ml-1 h-6 w-6 rounded-sm p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </Button>
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
            sessionKey: scope === "project" || scope === "shared" ? sessionKey : null,
            room: scope === "room" ? roomId : null,
            artifactId: file.artifact_ref?.id ?? null,
          });
          return blob.arrayBuffer();
        }}
      />
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col">
      {blobError ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-caption text-destructive">
          <File className="h-10 w-10 opacity-40" />
          <span>加载预览失败：{blobError}</span>
        </div>
      ) : isHtml(file) && textSource !== null ? (
        <iframe
          srcDoc={textSource}
          className="h-full w-full border-0"
          title="File preview"
          // allow-scripts + allow-same-origin would let the AI-generated
          // page remove its own sandbox — keep the origin opaque.
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        />
      ) : isMarkdown(file) && textSource !== null ? (
        <div className="markdown-content scrollbar-hover h-full w-full overflow-auto px-4 py-2 text-body">
          <MarkdownTextRenderer>{textSource}</MarkdownTextRenderer>
        </div>
      ) : isPreviewableText(file) && textSource !== null ? (
        <pre className="scrollbar-thin h-full w-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-caption text-foreground">
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
      ) : isPreviewableVideo(file) && blobUrl ? (
        <div className="flex h-full items-center justify-center bg-black p-4">
          <video
            src={blobUrl}
            controls
            preload="metadata"
            aria-label={`视频预览：${file.name}`}
            className="max-h-full max-w-full"
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
    return createPortal(
      <div className="fixed inset-0 z-50 flex flex-col bg-editor-surface animate-in fade-in-0 duration-150">
        {header}
        {body}
      </div>,
      document.body,
    );
  }

  return (
    <div className="flex h-full flex-col bg-editor-surface">
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
    <EmptyState
      className="h-full"
      icon={<File className="h-6 w-6 opacity-40" />}
      title="此文件类型不支持预览"
      action={
        isTauri() ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleOpen}
            >
              系统程序打开
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleReveal}
            >
              打开所在目录
            </Button>
          </div>
        ) : undefined
      }
    />
  );
}
