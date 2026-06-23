/** Right-side panel: list of items for the selected day. */

import { Bot, Check, Clock, Pause, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { formatTime, isSameDay, weekdayName } from "./dateUtils";
import type { ScheduleItem } from "./types";

interface ScheduleListProps {
  date: Date;
  items: ScheduleItem[];
  onSelectItem: (item: ScheduleItem) => void;
  onComplete: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onCreateAt: (date: Date) => void;
}

export function ScheduleList({
  date,
  items,
  onSelectItem,
  onComplete,
  onToggle,
  onCreateAt,
}: ScheduleListProps) {
  const dayItems = items
    .filter((it) => isSameDay(new Date(it.startAtMs), date))
    .sort((a, b) => a.startAtMs - b.startAtMs);

  const isToday = isSameDay(date, new Date());

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-base font-semibold">
              {date.getMonth() + 1}月{date.getDate()}日 {weekdayName(date)}
              {isToday && (
                <span className="ml-2 text-xs text-primary font-normal">今天</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {dayItems.length} 项日程
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-full"
            onClick={() => onCreateAt(date)}
          >
            添加
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {dayItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm py-12">
            <Clock className="h-8 w-8 mb-2 opacity-40" />
            今日暂无日程
          </div>
        ) : (
          <div className="divide-y">
            {dayItems.map((item) => (
              <ScheduleListRow
                key={item.id}
                item={item}
                onSelect={() => onSelectItem(item)}
                onComplete={() => onComplete(item.id)}
                onToggle={(enabled) => onToggle(item.id, enabled)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ScheduleListRow({
  item,
  onSelect,
  onComplete,
  onToggle,
}: {
  item: ScheduleItem;
  onSelect: () => void;
  onComplete: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const isAi = item.kind === "ai_task";
  return (
    <div
      className={cn(
        "px-4 py-3 flex items-start gap-3 hover:bg-accent/40 transition-colors cursor-pointer",
        item.done && "opacity-60",
        !item.enabled && "opacity-60",
      )}
      onClick={onSelect}
    >
      {/* Color bar */}
      <div
        className={cn(
          "w-1 self-stretch rounded-full flex-shrink-0",
          isAi ? "bg-purple-500" : "bg-blue-500",
          item.done && "bg-muted",
        )}
      />

      {/* Time */}
      <div className="flex-shrink-0 w-16 pt-0.5">
        {item.allDay ? (
          <span className="text-xs text-muted-foreground">全天</span>
        ) : (
          <span className="text-xs font-mono text-foreground">
            {formatTime(item.startAtMs)}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {isAi && <Bot className="h-3.5 w-3.5 text-purple-500 flex-shrink-0" />}
          <span
            className={cn(
              "text-sm font-medium truncate",
              item.done && "line-through",
            )}
          >
            {item.title}
          </span>
        </div>
        {item.description && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            {item.description}
          </p>
        )}
        {isAi && item.aiMessage && (
          <p className="text-xs text-purple-600 dark:text-purple-400 mt-0.5 line-clamp-1 font-mono">
            → {item.aiMessage}
          </p>
        )}
        <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
          {item.recurrence !== "none" && (
            <span>重复: {recurrenceLabel(item.recurrence)}</span>
          )}
          {item.nextRunAtMs && (
            <span>下次: {formatTime(item.nextRunAtMs)}</span>
          )}
          {item.lastStatus === "error" && (
            <span className="text-destructive">上次失败</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
        {!isAi && !item.done && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onComplete}
            title="标记完成"
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
        )}
        {isAi && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onToggle(!item.enabled)}
            title={item.enabled ? "暂停" : "恢复"}
          >
            {item.enabled ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

function recurrenceLabel(rec: string): string {
  switch (rec) {
    case "daily":
      return "每天";
    case "weekly":
      return "每周";
    case "monthly":
      return "每月";
    case "cron_expr":
      return "Cron";
    default:
      return "不重复";
  }
}
