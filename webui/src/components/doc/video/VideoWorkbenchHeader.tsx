import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type VideoWorkbenchView = "director" | "preview";

export interface VideoFocus {
  projectName: string;
  sceneIndex: number;
  sceneTitle: string;
  seconds: number | null;
}

export function videoFocusQuote(focus: VideoFocus | null | undefined) {
  return focus ? {author: "当前视频", content: `视频：${focus.projectName}\n第 ${focus.sceneIndex} 段：${focus.sceneTitle}${focus.seconds === null ? "" : `\n当前画面位置：${focus.seconds.toFixed(2)} 秒`}`} : undefined;
}

export interface VideoWorkbenchHeaderProps {
  projectName: string;
  activeView: VideoWorkbenchView;
  onViewChange?: (view: VideoWorkbenchView) => void;
  previewAvailable?: boolean;
  children?: ReactNode;
}

export function VideoWorkbenchHeader({
  projectName,
  activeView,
  onViewChange,
  previewAvailable = true,
  children,
}: VideoWorkbenchHeaderProps) {
  return (
    <header className="flex min-h-10 min-w-0 items-center gap-3 border-b border-border/60 px-3">
      <h1
        className="min-w-0 flex-1 truncate text-ui font-medium text-foreground"
        title={projectName}
      >
        {projectName}
      </h1>
      <nav
        aria-label="视频工作台视图"
        className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/50 p-0.5"
      >
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={activeView === "director"}
          className={cn(
            "text-caption",
            activeView === "director"
              ? "bg-background font-semibold text-foreground"
              : "text-muted-foreground",
          )}
          onClick={() => onViewChange?.("director")}
        >
          导演台
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={activeView === "preview"}
          disabled={!previewAvailable}
          className={cn(
            "text-caption",
            activeView === "preview"
              ? "bg-background font-semibold text-foreground"
              : "text-muted-foreground",
          )}
          onClick={() => onViewChange?.("preview")}
        >
          视频
        </Button>
      </nav>
      {children ? (
        <div className="flex min-w-0 items-center gap-1">{children}</div>
      ) : null}
    </header>
  );
}
