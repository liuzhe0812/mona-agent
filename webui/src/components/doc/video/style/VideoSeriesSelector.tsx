import {
  Archive,
  ArchiveRestore,
  Check,
  FolderPlus,
  Loader2,
  Palette,
  Pencil,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { VideoSeries } from "@/lib/api";

export interface VideoSeriesSelectorProps {
  series: VideoSeries[];
  selectedSeriesId?: string | null;
  onSelect: (series: VideoSeries) => void;
  onDelete?: (series: VideoSeries) => void;
  onRename?: (series: VideoSeries) => void;
  onArchive?: (series: VideoSeries, archived: boolean) => void;
  onCreate?: () => void;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
}

/** Compact series picker for the existing video configuration surface. */
export function VideoSeriesSelector({
  series,
  selectedSeriesId,
  onSelect,
  onDelete,
  onRename,
  onArchive,
  onCreate,
  loading = false,
  disabled = false,
  className,
}: VideoSeriesSelectorProps) {
  return (
    <div className={cn("space-y-2", className)}>
      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border/70 px-3 py-5 text-caption text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          加载系列…
        </div>
      ) : series.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-caption text-muted-foreground">
          <Palette className="mx-auto mb-1.5 h-4 w-4 opacity-60" />
          还没有视频系列
        </div>
      ) : (
        <div className="max-h-52 space-y-1.5 overflow-y-auto pr-0.5">
          {[...series]
            .sort(
              (left, right) =>
                Number(Boolean(left.archivedAt)) -
                Number(Boolean(right.archivedAt)),
            )
            .map((item) => {
              const selected = item.id === selectedSeriesId;
              const archived = Boolean(item.archivedAt);
              const primary =
                item.styleSummary?.primaryColor ?? "hsl(var(--primary))";
              return (
                <div key={item.id} className="group flex items-stretch gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled || archived}
                    aria-pressed={selected}
                    onClick={() => onSelect(item)}
                    className={cn(
                      "!flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-2 text-left !text-caption transition-colors",
                      selected
                        ? "border-primary bg-accent"
                        : "border-border/70 hover:bg-accent",
                      disabled && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <span
                      className="h-7 w-7 shrink-0 rounded-md border border-black/10 shadow-inner"
                      style={{ backgroundColor: primary }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-caption font-medium">
                        {item.name}
                        {archived ? "（已归档）" : ""}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-micro text-muted-foreground">
                        <span>{item.episodeCount ?? 0} 期</span>
                        <span>·</span>
                        <span>
                          {item.latestStyleVersion
                            ? `风格 v${item.latestStyleVersion}`
                            : "待设置风格"}
                        </span>
                      </span>
                    </span>
                    {selected ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                    ) : null}
                  </Button>
                  {onRename && !archived ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={disabled}
                      aria-label={`重命名系列 ${item.name}`}
                      onClick={() => onRename(item)}
                      className="h-auto w-8 shrink-0 text-muted-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                  {onArchive ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={disabled}
                      aria-label={`${archived ? "恢复" : "归档"}系列 ${item.name}`}
                      onClick={() => onArchive(item, !archived)}
                      className="h-auto w-8 shrink-0 text-muted-foreground"
                    >
                      {archived ? (
                        <ArchiveRestore className="h-3.5 w-3.5" />
                      ) : (
                        <Archive className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  ) : null}
                  {onDelete ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={disabled}
                      aria-label={`删除系列 ${item.name}`}
                      title={`删除系列 ${item.name}`}
                      onClick={() => onDelete(item)}
                      className="h-auto w-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              );
            })}
        </div>
      )}

      {onCreate ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 w-full justify-start !text-caption"
          disabled={disabled}
          onClick={onCreate}
        >
          <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
          创建新系列
        </Button>
      ) : null}
    </div>
  );
}
