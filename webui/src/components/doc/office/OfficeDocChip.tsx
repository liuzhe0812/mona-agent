import { FileText, X } from "lucide-react";

import { Button } from "@/components/ui/button";

interface OfficeDocChipProps {
  name: string;
  size?: number;
  onRemove?: () => void;
  onClick?: () => void;
}

function formatSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact chip showing an uploaded document in the composer area.
 *  Follows ui-spec.md: rounded-md (small control tier), text-caption. */
export function OfficeDocChip({ name, size, onRemove, onClick }: OfficeDocChipProps) {
  const sizeLabel = formatSize(size);
  return (
    <div
      className={
        "group flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 text-caption " +
        (onClick ? "cursor-pointer hover:bg-accent" : "")
      }
      onClick={onClick}
      title={name}
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-[160px] truncate text-foreground/85">{name}</span>
      {sizeLabel ? (
        <span className="text-muted-foreground">{sizeLabel}</span>
      ) : null}
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="移除"
          className="h-4 w-4 rounded-md p-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X className="h-3 w-3" />
        </Button>
      ) : null}
    </div>
  );
}
