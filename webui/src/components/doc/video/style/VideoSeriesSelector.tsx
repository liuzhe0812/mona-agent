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
  labelMode?: "series" | "style";
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
  labelMode = "series",
}: VideoSeriesSelectorProps) {
  const isStyle = labelMode === "style";
  return (
    <div className={cn("space-y-2", className)}>
      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border/70 px-3 py-5 text-caption text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {isStyle ? "加载我的风格…" : "加载系列…"}
        </div>
      ) : series.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-caption text-muted-foreground">
          <Palette className="mx-auto mb-1.5 h-4 w-4 opacity-60" />
          {isStyle ? "还没有保存的风格" : "还没有视频系列"}
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
                        {archived ? (isStyle ? "（已停用）" : "（已归档）") : ""}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-micro text-muted-foreground">
                        <span>
                          {isStyle
                            ? item.episodeCount
                              ? `已用于 ${item.episodeCount} 个视频`
                              : "尚未用于视频"
                            : `${item.episodeCount ?? 0} 期`}
                        </span>
                        <span>·</span>
                        <span>
                          {item.latestStyleVersion
                            ? isStyle
                              ? "可用于新视频"
                              : `风格 v${item.latestStyleVersion}`
                            : isStyle
                              ? "尚未保存"
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
                      aria-label={`${isStyle ? "重命名风格" : "重命名系列"} ${item.name}`}
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
                      aria-label={`${archived ? (isStyle ? "启用" : "恢复") : (isStyle ? "停用" : "归档")}${isStyle ? "风格" : "系列"} ${item.name}`}
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
                      aria-label={`删除${isStyle ? "风格" : "系列"} ${item.name}`}
                      title={`删除${isStyle ? "风格" : "系列"} ${item.name}`}
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
          {isStyle ? "新建风格" : "创建新系列"}
        </Button>
      ) : null}
    </div>
  );
}
