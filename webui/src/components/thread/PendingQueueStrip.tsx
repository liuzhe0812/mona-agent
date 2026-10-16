import { CornerDownRight, ListStart, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { PendingMessage } from "@/hooks/usePendingQueue";
import { cn } from "@/lib/utils";

interface PendingQueueStripProps {
  messages: PendingMessage[];
  onAppend?: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  isFull: boolean;
}

export function PendingQueueStrip({
  messages,
  onAppend,
  onRemove,
  onEdit,
  isFull,
}: PendingQueueStripProps) {
  const { t, i18n } = useTranslation();
  const isChinese = (i18n.resolvedLanguage ?? i18n.language).startsWith("zh");

  if (messages.length === 0) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="flex flex-col gap-1 border-b border-border/60 px-3 py-1.5"
        role="list"
        aria-label={t("thread.composer.pendingQueue.empty")}
      >
        {messages.map((msg) => {
          const canEdit = !msg.images?.length && !msg.options?.docPaths?.length;
          const closeQueueLabel = isChinese ? "关闭排队" : "Remove from queue";
          const moreLabel = isChinese ? "更多操作" : "More actions";

          return (
            <div
              key={msg.id}
              role="listitem"
              className="group flex min-h-8 items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted/50"
            >
              <ListStart className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-caption text-foreground/75">
                {msg.content || msg.options?.documentNames?.join("、") || t("thread.composer.pendingQueue.images", { count: msg.images?.length ?? 0 })}
              </span>
              <div
                className={cn(
                  "ml-1 flex shrink-0 items-center gap-0.5 transition-opacity",
                  msg.locked
                    ? "opacity-60"
                    : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                )}
              >
                {onAppend ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-7 shrink-0 gap-1 px-2 text-muted-foreground"
                    disabled={msg.locked}
                    onClick={() => onAppend(msg.id)}
                    aria-label={isChinese ? "引导到当前任务" : t("thread.composer.pendingQueue.appendAria")}
                  >
                    <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
                    {isChinese ? "引导" : t("thread.composer.pendingQueue.append")}
                  </Button>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={msg.locked}
                      onClick={() => onRemove(msg.id)}
                      aria-label={t("thread.composer.pendingQueue.deleteAria")}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("thread.composer.pendingQueue.deleteAria")}</TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild disabled={msg.locked}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={moreLabel}
                        >
                          <MoreHorizontal className="h-4 w-4" aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>{moreLabel}</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end">
                    {canEdit ? (
                      <DropdownMenuItem disabled={msg.locked} onSelect={() => onEdit(msg.id)}>
                        <Pencil className="h-4 w-4" aria-hidden />
                        {t("thread.composer.pendingQueue.editAria")}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      disabled={msg.locked}
                      onSelect={() => onRemove(msg.id)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                      {closeQueueLabel}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          );
        })}
        {isFull && (
          <span className="px-2 text-caption text-muted-foreground/70">
            {t("thread.composer.pendingQueue.full")}
          </span>
        )}
      </div>
    </TooltipProvider>
  );
}
