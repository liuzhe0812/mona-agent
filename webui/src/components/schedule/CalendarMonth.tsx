/** Month calendar grid view. */

import { Bot, ChevronDown, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  /** Seed for the displayed month (e.g. the currently selected date). */
  initialCursor?: Date;
  onSelectDate: (date: Date) => void;
  onSelectItem: (item: ScheduleItem) => void;
  onCreateAt: (date: Date) => void;
  /** Extra actions rendered on the right side of the toolbar row. */
  toolbarActions?: ReactNode;
}

const WEEKDAY_HEADERS = ["一", "二", "三", "四", "五", "六", "日"];

export function CalendarMonth({
  items,
  initialCursor,
  onSelectDate,
  onSelectItem,
  onCreateAt,
  toolbarActions,
}: CalendarMonthProps) {
  const [cursor, setCursor] = useState(() => startOfDay(initialCursor ?? new Date()));
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(() => new Date().getFullYear());
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

  const jumpToMonth = (year: number, month: number) => {
    const d = new Date(cursor);
    d.setFullYear(year, month, 1);
    setCursor(startOfDay(d));
    setMonthPickerOpen(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={goPrev} className="h-6 w-6">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <DropdownMenu
            open={monthPickerOpen}
            onOpenChange={(open) => {
              setMonthPickerOpen(open);
              if (open) setPickerYear(cursor.getFullYear());
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 min-w-[104px] gap-0.5 px-1.5 text-sm font-semibold"
              >
                {monthLabel}
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[224px] p-2">
              <div className="flex items-center justify-between px-1 pb-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setPickerYear((y) => y - 1)}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="text-sm font-medium">{pickerYear}年</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setPickerYear((y) => y + 1)}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {Array.from({ length: 12 }, (_, m) => {
                  const isCursorMonth =
                    pickerYear === cursor.getFullYear() && m === cursor.getMonth();
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => jumpToMonth(pickerYear, m)}
                      className={cn(
                        "rounded-md py-1 text-[12px] hover:bg-accent",
                        isCursorMonth && "bg-primary/10 font-medium text-primary",
                      )}
                    >
                      {m + 1}月
                    </button>
                  );
                })}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" onClick={goNext} className="h-6 w-6">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={goToday} className="h-6 ml-1 text-xs px-2">
            今天
          </Button>
        </div>
        {toolbarActions && (
          <div className="flex items-center gap-2">{toolbarActions}</div>
        )}
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
        {gridDates.map((date) => {
          const dayItems = itemsByDay.get(startOfDay(date).toISOString()) ?? [];
          const inMonth = isSameMonth(date, cursor);
          const isToday = isSameDay(date, today);
          return (
            <div
              key={date.toISOString()}
              onClick={() => {
                onSelectDate(date);
              }}
              className={cn(
                "group border-b border-border/50 min-h-[80px] p-1 cursor-pointer hover:bg-accent transition-colors overflow-hidden",
                !inMonth && "text-muted-foreground",
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
                  className="text-muted-foreground/60 opacity-0 hover:opacity-100 group-hover:opacity-100 hover:text-foreground transition-opacity"
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
                      "flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-accent",
                      (item.done || !item.enabled) && "opacity-50",
                    )}
                    title={item.title}
                  >
                    <span className="h-3 w-0.5 flex-shrink-0 rounded-full bg-primary" />
                    {!item.allDay && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {formatTime(item.startAtMs)}
                      </span>
                    )}
                    {item.kind === "ai_task" && (
                      <Bot className="h-3 w-3 flex-shrink-0 text-primary" />
                    )}
                    <span className={cn("truncate", item.done && "line-through")}>
                      {item.title}
                    </span>
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
