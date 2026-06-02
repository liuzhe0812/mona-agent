import { Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { PendingMessage } from "@/hooks/usePendingQueue";
import { cn } from "@/lib/utils";

interface PendingQueueStripProps {
  messages: PendingMessage[];
  onAppend: (id: string) => void;
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
  const { t } = useTranslation();

  if (messages.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-1 border-b border-black/[0.04] px-3 py-2 dark:border-white/[0.06]"
      role="list"
      aria-label={t("thread.composer.pendingQueue.empty")}
    >
      {messages.map((msg) => (
        <div
          key={msg.id}
          role="listitem"
          className={cn(
            "flex min-h-[32px] items-center gap-2 rounded-lg px-2.5 py-1.5",
            "bg-muted/40 transition-colors hover:bg-muted/60",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-foreground/75">
            {msg.content}
          </span>
          <button
            type="button"
            onClick={() => onAppend(msg.id)}
            className={cn(
              "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium",
              "text-primary/80 hover:bg-primary/10 hover:text-primary",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "transition-colors",
            )}
            aria-label={t("thread.composer.pendingQueue.appendAria")}
          >
            {t("thread.composer.pendingQueue.append")}
          </button>
          <button
            type="button"
            onClick={() => onEdit(msg.id)}
            className={cn(
              "grid h-6 w-6 shrink-0 place-items-center rounded-full",
              "text-muted-foreground/70 hover:bg-foreground/8 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "transition-colors",
            )}
            aria-label={t("thread.composer.pendingQueue.editAria")}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onRemove(msg.id)}
            className={cn(
              "grid h-6 w-6 shrink-0 place-items-center rounded-full",
              "text-muted-foreground/70 hover:bg-foreground/8 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "transition-colors",
            )}
            aria-label={t("thread.composer.pendingQueue.deleteAria")}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ))}
      {isFull && (
        <span className="px-2.5 text-[10.5px] text-muted-foreground/60">
          {t("thread.composer.pendingQueue.full")}
        </span>
      )}
    </div>
  );
}
