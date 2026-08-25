import { useCallback } from "react";
import { FileText, Image, FileCode } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { isTauri, openPathWithSystemApp, revealItemInDir } from "@/lib/tauri";
import { useFilePreviewStore, type PreviewScope } from "./filePreviewStore";
import { cn } from "@/lib/utils";
import type { DeliveredFile } from "@/lib/types";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const CODE_EXTS = new Set([
  ".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go", ".java", ".c", ".cpp",
  ".html", ".css", ".scss", ".json", ".yaml", ".yml", ".toml", ".sql",
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function KindIcon({ name }: { name: string }) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext))
    return <Image className="h-4 w-4 shrink-0 text-emerald-500" />;
  if (CODE_EXTS.has(ext))
    return <FileCode className="h-4 w-4 shrink-0 text-blue-500" />;
  return <FileText className="h-4 w-4 shrink-0 text-sky-500" />;
}

interface DeliveredFileCardProps {
  file: DeliveredFile;
  /** Preview scope: ``shared`` resolves under the active Agent output;
   *  ``project`` resolves under the session's bound workspace. */
  scope?: PreviewScope;
  /** Required when ``scope === "project"``. */
  sessionKey?: string | null;
  className?: string;
}

export function DeliveredFileCard({
  file,
  scope = "shared",
  sessionKey = null,
  className,
}: DeliveredFileCardProps) {
  const openPreview = useFilePreviewStore((s) => s.open);

  const handleClick = useCallback(() => {
    openPreview(file, scope, sessionKey);
  }, [file, scope, sessionKey, openPreview]);

  const handleOpenWithSystem = useCallback(() => {
    if (isTauri()) void openPathWithSystemApp(file.absolute_path);
  }, [file.absolute_path]);

  const handleRevealInDir = useCallback(() => {
    if (isTauri()) void revealItemInDir(file.absolute_path);
  }, [file.absolute_path]);

  const card = (
    <Button
      type="button"
      variant="ghost"
      onClick={handleClick}
      className={cn(
        "h-auto justify-start gap-2 rounded-lg bg-muted/30",
        "px-3 py-2 text-left font-normal",
        "hover:bg-muted/60 hover:text-foreground",
        className,
      )}
    >
      <KindIcon name={file.name} />
      <span className="min-w-0 truncate text-ui font-medium text-foreground">
        {file.name}
      </span>
      <span className="shrink-0 text-micro text-muted-foreground">
        {file.size_human}
      </span>
    </Button>
  );

  if (!isTauri()) {
    return card;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={handleClick}>
          预览
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenWithSystem}>
          系统程序打开
        </ContextMenuItem>
        <ContextMenuItem onClick={handleRevealInDir}>
          打开所在目录
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function DeliveredFileCardList({
  files,
  scope = "shared",
  sessionKey = null,
  className,
}: {
  files: DeliveredFile[];
  scope?: PreviewScope;
  sessionKey?: string | null;
  className?: string;
}) {
  if (files.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {files.map((f, i) => (
        <DeliveredFileCard
          key={`${f.absolute_path}-${i}`}
          file={f}
          scope={scope}
          sessionKey={sessionKey}
        />
      ))}
    </div>
  );
}
