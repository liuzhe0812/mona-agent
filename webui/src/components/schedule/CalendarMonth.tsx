/** Month calendar grid view. */

import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  formatTime,
  isSameDay,
  isSameMonth,
  monthGridDates,
  startOfDay,
} from "./dateUtils";
import type { ScheduleItem } from "./types";

interface CalendarMonthProps {
  items: ScheduleItem[];
  onSelectDate: (date: Date) => void;
  onSelectItem: (item: ScheduleItem) => void;
  onCreateAt: (date: Date) => void;
}

const WEEKDAY_HEADERS = ["一", "二", "三", "四", "五", "六", "日"];

export function CalendarMonth({
  items,
  onSelectDate,
  onSelectItem,
  onCreateAt,
}: CalendarMonthProps) {
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const today = startOfDay(new Date());

  const gridDates = useMemo(() => monthGridDates(cursor), [cursor]);

  const itemsByDay = useMemo(() => {
    const map = new Map<string, ScheduleItem[]>();
    for (const item of items) {
      const d = startOfDay(new Date(item.startAtMs));
      const key = d.toISOString();
      const arr = map.get(key) ?? [];
      arr.push(item);
      map.set(key, arr);
    }
    return map;
  }, [items]);

  const monthLabel = `${cursor.getFullYear()}年${cursor.getMonth() + 1}月`;

  const goPrev = () => {
    const d = new Date(cursor);
    d.setMonth(d.getMonth() - 1);
    setCursor(d);
  };
  const goNext = () => {
    const d = new Date(cursor);
    d.setMonth(d.getMonth() + 1);
    setCursor(d);
  };
  const goToday = () => setCursor(startOfDay(new Date()));

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={goPrev} className="h-6 w-6">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-sm font-semibold min-w-[100px] text-center">
            {monthLabel}
          </span>
          <Button variant="ghost" size="icon" onClick={goNext} className="h-6 w-6">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={goToday} className="h-6 ml-1 text-xs px-2">
            今天
          </Button>
        </div>
        <Button
          size="sm"
          className="h-6 rounded-full text-xs px-2"
          onClick={() => onCreateAt(new Date())}
        >
          <Plus className="h-3 w-3 mr-0.5" />
          新建
        </Button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b text-xs text-muted-foreground">
        {WEEKDAY_HEADERS.map((d) => (
          <div key={d} className="py-1.5 text-center font-medium">
            {d}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7 flex-1 overflow-hidden">
        {gridDates.map((date, idx) => {
          const dayItems = itemsByDay.get(startOfDay(date).toISOString()) ?? [];
          const inMonth = isSameMonth(date, cursor);
          const isToday = isSameDay(date, today);
          const col = idx % 7;
          const isWeekend = col >= 5;
          return (
            <div
              key={date.toISOString()}
              onClick={() => onSelectDate(date)}
              className={cn(
                "border-r border-b border-border/50 min-h-[80px] p-1 cursor-pointer hover:bg-accent/40 transition-colors overflow-hidden",
                !inMonth && "bg-muted/30 text-muted-foreground",
                isWeekend && "bg-muted/20",
              )}
            >
              <div className="flex items-center justify-between mb-0.5">
                <span
                  className={cn(
                    "text-xs w-5 h-5 flex items-center justify-center rounded-full",
                    isToday
                      ? "bg-primary text-primary-foreground font-semibold"
                      : inMonth
                        ? "text-foreground"
                        : "text-muted-foreground",
                  )}
                >
                  {date.getDate()}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCreateAt(date);
                  }}
                  className="opacity-0 hover:opacity-100 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                  title="新建日程"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
              <div className="space-y-0.5">
                {dayItems.slice(0, 3).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectItem(item);
                    }}
                    className={cn(
                      "w-full text-left text-[11px] px-1 py-0.5 rounded truncate flex items-center gap-1",
                      item.kind === "ai_task"
                        ? "bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300"
                        : "bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300",
                      item.done && "opacity-50 line-through",
                      !item.enabled && "opacity-50",
                    )}
                    title={item.title}
                  >
                    {!item.allDay && (
                      <span className="font-mono text-[10px] opacity-70">
                        {formatTime(item.startAtMs)}
                      </span>
                    )}
                    <span className="truncate">{item.title}</span>
                  </button>
                ))}
                {dayItems.length > 3 && (
                  <div className="text-[10px] text-muted-foreground px-1">
                    +{dayItems.length - 3} 项
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
