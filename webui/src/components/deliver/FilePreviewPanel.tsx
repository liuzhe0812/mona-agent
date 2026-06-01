import { useCallback } from "react";
import { X, FileText, Image, FileCode, File } from "lucide-react";
import { useFilePreviewStore } from "./filePreviewStore";
import { isTauri, openPathWithSystemApp, revealItemInDir } from "@/lib/tauri";
import type { DeliveredFile } from "@/lib/types";

const PREVIEWABLE_TEXT_EXTS = new Set([
  ".txt", ".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml",
  ".toml", ".cfg", ".ini", ".sh", ".bash", ".zsh", ".css", ".scss", ".html",
  ".htm", ".xml", ".sql", ".csv", ".log", ".env", ".gitignore", ".rs", ".go",
  ".java", ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt",
]);

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function isPreviewableText(file: DeliveredFile): boolean {
  return PREVIEWABLE_TEXT_EXTS.has(extOf(file.name))
    || file.mime.startsWith("text/")
    || file.mime === "application/json";
}

function isPreviewableImage(file: DeliveredFile): boolean {
  return IMAGE_EXTS.has(extOf(file.name)) || file.mime.startsWith("image/");
}

function FileIcon({ file }: { file: DeliveredFile }) {
  const ext = extOf(file.name);
  if (IMAGE_EXTS.has(ext)) return <Image className="h-4 w-4" />;
  if ([".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go"].includes(ext))
    return <FileCode className="h-4 w-4" />;
  return <FileText className="h-4 w-4" />;
}

export function FilePreviewPanel() {
  const file = useFilePreviewStore((s) => s.file);
  const close = useFilePreviewStore((s) => s.close);

  if (!file) return null;

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <FileIcon file={file} />
        <span className="flex-1 truncate text-sm font-medium">{file.name}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{file.size_human}</span>
        <button
          type="button"
          onClick={close}
          className="ml-1 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {isPreviewableImage(file) ? (
          <ImagePreview file={file} />
        ) : isPreviewableText(file) ? (
          <TextPreview file={file} />
        ) : (
          <NoPreview file={file} />
        )}
      </div>
    </div>
  );
}

function TextPreview({ file }: { file: DeliveredFile }) {
  return (
    <iframe
      src={`/api/file-preview?path=${encodeURIComponent(file.absolute_path)}`}
      className="h-full w-full border-0"
      title="File preview"
      sandbox="allow-same-origin"
    />
  );
}

function ImagePreview({ file }: { file: DeliveredFile }) {
  const src = `/api/file-preview?path=${encodeURIComponent(file.absolute_path)}`;
  return (
    <div className="flex h-full items-center justify-center">
      <img
        src={src}
        alt={file.name}
        className="max-h-full max-w-full object-contain"
      />
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
