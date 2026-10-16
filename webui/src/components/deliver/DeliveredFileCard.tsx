import { useCallback } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { FileSystemIcon } from "@/components/ui/file-system-icon";
import { isTauri, openPathWithSystemApp, revealItemInDir } from "@/lib/tauri";
import { useFilePreviewStore, type PreviewScope } from "./filePreviewStore";
import { cn } from "@/lib/utils";
import type { DeliveredFile } from "@/lib/types";

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
      <FileSystemIcon name={file.name} />
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
