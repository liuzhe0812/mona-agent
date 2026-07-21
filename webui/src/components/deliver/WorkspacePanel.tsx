import { useMemo } from "react";
import { Package, PanelRightClose } from "lucide-react";
import { DeliveredFileCard } from "./DeliveredFileCard";
import { useFilePreviewStore } from "./filePreviewStore";
import { cn } from "@/lib/utils";
import type { DeliveredFile } from "@/lib/types";

interface WorkspacePanelProps {
  files: DeliveredFile[];
  className?: string;
}

/**
 * Right-column workspace panel: lists all delivered files produced during the
 * current session. Clicking a card opens the file in the middle preview pane.
 */
export function WorkspacePanel({ files, className }: WorkspacePanelProps) {
  const toggleCollapsed = useFilePreviewStore((s) => s.toggleWorkspaceCollapsed);
  const previewFile = useFilePreviewStore((s) => s.file);

  // Deduplicate by absolute_path; preserve latest occurrence order.
  const uniqueFiles = useMemo(() => {
    const seen = new Set<string>();
    const out: DeliveredFile[] = [];
    for (let i = files.length - 1; i >= 0; i--) {
      const f = files[i];
      if (seen.has(f.absolute_path)) continue;
      seen.add(f.absolute_path);
      out.unshift(f);
    }
    return out;
  }, [files]);

  if (uniqueFiles.length === 0) return null;

  return (
    <div className={cn("flex h-full flex-col bg-background", className)}>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Package className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">交付物</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {uniqueFiles.length}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={toggleCollapsed}
          title="折叠工作区"
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-hover p-2">
        <ul className="flex flex-col gap-2">
          {uniqueFiles.map((file, idx) => {
            const active = previewFile?.absolute_path === file.absolute_path;
            return (
              <li key={`${file.absolute_path}-${idx}`}>
                <DeliveredFileCard
                  file={file}
                  className={cn(
                    "flex w-full",
                    active
                      ? "border-primary/60 bg-primary/5 ring-1 ring-primary/30"
                      : "",
                  )}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
