/** Week/day timeline view with drag-to-schedule support.
 *
 * - Event blocks are positioned by local minutes-of-day; duration drives height.
 * - Move/resize use Pointer Events (15-minute snap, Escape cancels).
 * - Unscheduled todos (TODO_DRAG_MIME) can be dropped onto a time slot.
 */

import { Bot, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  formatTime,
  isSameDay,
  startOfDay,
  weekdayName,
  weekGridDates,
} from "./dateUtils";
import { useScheduleStore } from "./scheduleStore";
import { arrangeTodoOnCalendar } from "./todoApi";
import { useTodoStore } from "./todoStore";
import { TODO_DRAG_MIME, type ScheduleItem } from "./types";

const HOUR_PX = 48;
const SNAP_MIN = 15;
const DEFAULT_DURATION_MIN = 30;
const DAY_MIN = 1440;

interface TimedEvent {
  item: ScheduleItem;
  startMin: number;
  endMin: number;
}

interface PlacedEvent extends TimedEvent {
  colIdx: number;
  colCount: number;
}

interface DragTarget {
  dayIdx: number;
  allDay: boolean;
  startMin: number;
  endMin: number;
}

interface DragSession {
  pointerId: number;
  mode: "move" | "resize";
  item: ScheduleItem;
  originDayIdx: number;
  originAllDay: boolean;
  startMin0: number;
  endMin0: number;
  grabMin: number;
  downX: number;
  downY: number;
  moved: boolean;
}

/** Greedy column assignment so overlapping events render side by side. */
function layoutTimedEvents(events: TimedEvent[]): PlacedEvent[] {
  const sorted = [...events].sort(
    (a, b) => a.startMin - b.startMin || a.endMin - b.endMin,
  );
  const placed: PlacedEvent[] = [];
  let cluster: PlacedEvent[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(...cluster.map((e) => e.colIdx)) + 1;
    for (const e of cluster) e.colCount = cols;
    placed.push(...cluster);
    cluster = [];
    clusterEnd = -1;
  };
  for (const ev of sorted) {
    if (cluster.length > 0 && ev.startMin >= clusterEnd) flush();
    const used = new Set(
      cluster.filter((e) => e.endMin > ev.startMin).map((e) => e.colIdx),
    );
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ ...ev, colIdx: col, colCount: 1 });
    clusterEnd = Math.max(clusterEnd, ev.endMin);
  }
  if (cluster.length > 0) flush();
  return placed;
}

function minutesOf(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

function snap(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

interface CalendarWeekProps {
  mode: "week" | "day";
  items: ScheduleItem[];
  /** Seed for the displayed week/day (e.g. the currently selected date). */
  initialCursor?: Date;
  onSelectItem: (item: ScheduleItem) => void;
  onCreateAt: (date: Date) => void;
  toolbarActions?: ReactNode;
}

export function CalendarWeek({
  mode,
  items,
  initialCursor,
  onSelectItem,
  onCreateAt,
  toolbarActions,
}: CalendarWeekProps) {
  const editItem = useScheduleStore((s) => s.editItem);
  const loadItems = useScheduleStore((s) => s.loadItems);
  const loadTodos = useTodoStore((s) => s.loadAll);

  const [cursor, setCursor] = useState(() =>
    startOfDay(initialCursor ?? new Date()),
  );
  const today = startOfDay(new Date());

  const days = useMemo(
    () => (mode === "day" ? [cursor] : weekGridDates(cursor)),
    [mode, cursor],
  );
  const colCount = days.length;

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const allDayRowRef = useRef<HTMLDivElement>(null);

  // Initial scroll: bring 8:00 into view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 8 * HOUR_PX - 24 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const dragRef = useRef<DragSession | null>(null);
  const [drag, setDrag] = useState<(DragTarget & { item: ScheduleItem; mode: "move" | "resize" }) | null>(null);
  const [dropHint, setDropHint] = useState<{ dayIdx: number; startMin: number } | null>(null);

  const timedByDay = useMemo(() => {
    const map = new Map<number, PlacedEvent[]>();
    days.forEach((day, idx) => {
      const events: TimedEvent[] = [];
      for (const item of items) {
        if (item.allDay) continue;
        if (!isSameDay(new Date(item.startAtMs), day)) continue;
        const startMin = minutesOf(item.startAtMs);
        let endMin = item.endAtMs != null ? minutesOf(item.endAtMs) : startMin + DEFAULT_DURATION_MIN;
        if (endMin <= startMin) endMin = startMin + DEFAULT_DURATION_MIN;
        events.push({ item, startMin, endMin: Math.min(endMin, DAY_MIN) });
      }
      map.set(idx, layoutTimedEvents(events));
    });
    return map;
  }, [days, items]);

  const allDayByDay = useMemo(() => {
    const map = new Map<number, ScheduleItem[]>();
    days.forEach((day, idx) => {
      map.set(
        idx,
        items.filter((it) => it.allDay && isSameDay(new Date(it.startAtMs), day)),
      );
    });
    return map;
  }, [days, items]);

  const goPrev = () => {
    const d = new Date(cursor);
    d.setDate(d.getDate() - (mode === "day" ? 1 : 7));
    setCursor(d);
  };
  const goNext = () => {
    const d = new Date(cursor);
    d.setDate(d.getDate() + (mode === "day" ? 1 : 7));
    setCursor(d);
  };
  const goToday = () => setCursor(startOfDay(new Date()));

  const rangeLabel = () => {
    const s = days[0];
    const yearPrefix = s.getFullYear() !== today.getFullYear() ? `${s.getFullYear()}年` : "";
    if (mode === "day") {
      return `${yearPrefix}${s.getMonth() + 1}月${s.getDate()}日 ${weekdayName(s)}`;
    }
    const e = days[days.length - 1];
    return s.getMonth() === e.getMonth()
      ? `${yearPrefix}${s.getMonth() + 1}月${s.getDate()}日 – ${e.getDate()}日`
      : `${yearPrefix}${s.getMonth() + 1}月${s.getDate()}日 – ${e.getMonth() + 1}月${e.getDate()}日`;
  };

  /** Pointer position → day index + minutes-of-day (unsnapped). */
  const locate = (clientX: number, clientY: number) => {
    const content = contentRef.current;
    if (!content) return null;
    const rect = content.getBoundingClientRect();
    const dayIdx = clamp(
      Math.floor(((clientX - rect.left) / rect.width) * colCount),
      0,
      colCount - 1,
    );
    const min = ((clientY - rect.top) / HOUR_PX) * 60;
    return { dayIdx, min };
  };

  const overAllDayRow = (clientY: number) => {
    const row = allDayRowRef.current;
    if (!row) return false;
    const rect = row.getBoundingClientRect();
    return clientY >= rect.top && clientY <= rect.bottom;
  };

  const startDrag = (
    e: React.PointerEvent,
    dayIdx: number,
    ev: TimedEvent | { item: ScheduleItem; allDay: true },
    dragMode: "move" | "resize",
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const isAllDay = "allDay" in ev;
    const loc = locate(e.clientX, e.clientY);
    dragRef.current = {
      pointerId: e.pointerId,
      mode: dragMode,
      item: ev.item,
      originDayIdx: dayIdx,
      originAllDay: isAllDay,
      startMin0: isAllDay ? 0 : ev.startMin,
      endMin0: isAllDay ? DAY_MIN : ev.endMin,
      grabMin: isAllDay || dragMode === "resize" || !loc ? 0 : Math.max(0, loc.min - ev.startMin),
      downX: e.clientX,
      downY: e.clientY,
      moved: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const loc = locate(e.clientX, e.clientY);
    if (!loc) return;
    if (!d.moved) {
      // 4px threshold distinguishes click from drag.
      if (Math.hypot(e.clientX - d.downX, e.clientY - d.downY) < 4) return;
      d.moved = true;
    }
    if (d.mode === "resize") {
      const endMin = clamp(snap(loc.min), d.startMin0 + SNAP_MIN, DAY_MIN);
      setDrag({
        item: d.item,
        mode: "resize",
        dayIdx: d.originDayIdx,
        allDay: false,
        startMin: d.startMin0,
        endMin,
      });
      return;
    }
    if (overAllDayRow(e.clientY)) {
      setDrag({
        item: d.item,
        mode: "move",
        dayIdx: loc.dayIdx,
        allDay: true,
        startMin: 0,
        endMin: DAY_MIN,
      });
      return;
    }
    const duration = d.originAllDay ? 60 : d.endMin0 - d.startMin0;
    const startMin = clamp(snap(loc.min - d.grabMin), 0, DAY_MIN - duration);
    setDrag({
      item: d.item,
      mode: "move",
      dayIdx: loc.dayIdx,
      allDay: false,
      startMin,
      endMin: startMin + duration,
    });
  };

  const cancelDrag = () => {
    dragRef.current = null;
    setDrag(null);
  };

  const handleDragEnd = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    // Click (no movement) → open edit dialog.
    if (!d.moved) {
      cancelDrag();
      onSelectItem(d.item);
      return;
    }
    const target = drag;
    cancelDrag();
    if (!target) return;
    const day = days[target.dayIdx];
    const base = startOfDay(day).getTime();
    const input = {
      ...target.item,
      allDay: target.allDay,
      startAtMs: target.allDay ? base : base + target.startMin * 60_000,
      endAtMs: target.allDay ? null : base + target.endMin * 60_000,
    };
    editItem(d.item.id, input).catch((err) => {
      useScheduleStore.setState({
        error: err instanceof Error ? err.message : String(err),
      });
      void loadItems();
    });
  };

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelDrag();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag]);

  const handleColumnDragOver = (e: React.DragEvent, dayIdx: number) => {
    if (!e.dataTransfer.types.includes(TODO_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const loc = locate(e.clientX, e.clientY);
    if (!loc) return;
    setDropHint({ dayIdx, startMin: clamp(snap(loc.min), 0, DAY_MIN - DEFAULT_DURATION_MIN) });
  };

  const handleColumnDrop = (e: React.DragEvent, dayIdx: number) => {
    const todoId = e.dataTransfer.getData(TODO_DRAG_MIME);
    setDropHint(null);
    if (!todoId) return;
    e.preventDefault();
    const loc = locate(e.clientX, e.clientY);
    if (!loc) return;
    const startMin = clamp(snap(loc.min), 0, DAY_MIN - DEFAULT_DURATION_MIN);
    const base = startOfDay(days[dayIdx]).getTime();
    arrangeTodoOnCalendar(todoId, base + startMin * 60_000, base + (startMin + DEFAULT_DURATION_MIN) * 60_000)
      .then(() => {
        void loadItems();
        void loadTodos();
      })
      .catch((err) => {
        useScheduleStore.setState({
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  const handleColumnClick = (e: React.MouseEvent, dayIdx: number) => {
    const loc = locate(e.clientX, e.clientY);
    if (!loc) return;
    const startMin = clamp(snap(loc.min), 0, DAY_MIN - DEFAULT_DURATION_MIN);
    onCreateAt(new Date(startOfDay(days[dayIdx]).getTime() + startMin * 60_000));
  };

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todayIdx = days.findIndex((d) => isSameDay(d, today));

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={goPrev} className="h-6 w-6">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="min-w-[104px] px-1.5 text-center text-body font-semibold">
            {rangeLabel()}
          </span>
          <Button variant="ghost" size="icon" onClick={goNext} className="h-6 w-6">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={goToday} className="ml-1 h-6 px-2 text-caption">
            今天
          </Button>
        </div>
        {toolbarActions && <div className="flex items-center gap-2">{toolbarActions}</div>}
      </div>

      {/* Day header row */}
      <div className="flex border-b border-border/40">
        <div className="w-12 flex-shrink-0" />
        {days.map((day) => {
          const isToday = isSameDay(day, today);
          return (
            <div
              key={day.toISOString()}
              className="flex-1 py-1 text-center text-micro"
            >
              <span className={cn(isToday ? "font-semibold text-info" : "text-muted-foreground")}>
                {weekdayName(day).replace("周", "")} {day.getDate()}
              </span>
              {isToday && <span className="ml-1 rounded-full bg-info/[0.07] px-1.5 py-0.5 text-micro font-medium text-info">今天</span>}
            </div>
          );
        })}
      </div>

      {/* All-day row (also the drop target for making events all-day) */}
      <div ref={allDayRowRef} className="flex border-b border-border/40">
        <div className="w-12 flex-shrink-0 py-1 pr-1.5 text-right text-micro text-muted-foreground">
          全天
        </div>
        {days.map((day, dayIdx) => (
          <div
            key={day.toISOString()}
            className={cn(
              "min-h-[28px] flex-1 space-y-0.5 border-l border-border/30 p-0.5 first:border-l-0",
              drag?.allDay && drag.dayIdx === dayIdx && "bg-info/[0.05]",
            )}
          >
            {(allDayByDay.get(dayIdx) ?? []).map((item) => (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelectItem(item);
                }}
                onPointerDown={(e) => startDrag(e, dayIdx, { item, allDay: true }, "move")}
                onPointerMove={handleDragMove}
                onPointerUp={handleDragEnd}
                onPointerCancel={cancelDrag}
                className={cn(
                  "flex cursor-grab touch-none items-center gap-1 truncate rounded-md border border-info/15 border-l-2 border-l-info bg-info/[0.08] px-1.5 py-0.5 text-micro",
                  (item.done || !item.enabled) && "opacity-50",
                  drag?.item.id === item.id && drag.mode === "move" && "opacity-40",
                )}
                title={item.title}
              >
                {item.kind === "ai_task" && <Bot className="h-3 w-3 flex-shrink-0 text-info" />}
                <span className={cn("truncate", item.done && "line-through")}>{item.title}</span>
              </div>
            ))}
            {drag?.allDay && drag.dayIdx === dayIdx && (
              <div className="truncate rounded-md border border-dashed border-info bg-info/[0.08] px-1.5 py-0.5 text-micro text-info">
                {drag.item.title}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Time grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-hover">
        <div className="flex" style={{ height: 24 * HOUR_PX }}>
          {/* Hour gutter */}
          <div className="relative w-12 flex-shrink-0">
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <span
                key={h}
                className="absolute right-1.5 -translate-y-1/2 text-micro text-muted-foreground"
                style={{ top: h * HOUR_PX }}
              >
                {h}:00
              </span>
            ))}
          </div>

          {/* Day columns */}
          <div ref={contentRef} className="relative flex flex-1">
            {days.map((day, dayIdx) => (
              <div
                key={day.toISOString()}
                onClick={(e) => handleColumnClick(e, dayIdx)}
                onDragOver={(e) => handleColumnDragOver(e, dayIdx)}
                onDragLeave={() => setDropHint(null)}
                onDrop={(e) => handleColumnDrop(e, dayIdx)}
                className={cn(
                  "relative flex-1 border-l border-border/30 first:border-l-0",
                  isSameDay(day, today) && "bg-info/[0.025]",
                )}
              >
                {/* Hour lines */}
                {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
                  <div
                    key={h}
                    className="absolute left-0 right-0 border-t border-border/30"
                    style={{ top: h * HOUR_PX }}
                  />
                ))}

                {/* Event blocks */}
                {(timedByDay.get(dayIdx) ?? []).map((ev) => {
                  const isDragSource = drag?.item.id === ev.item.id;
                  const startMin = isDragSource && drag.mode === "resize" ? drag.startMin : ev.startMin;
                  const endMin = isDragSource && drag.mode === "resize" ? drag.endMin : ev.endMin;
                  const width = 100 / ev.colCount;
                  return (
                    <div
                      key={ev.item.id}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") onSelectItem(ev.item);
                      }}
                      onPointerDown={(e) => startDrag(e, dayIdx, ev, "move")}
                      onPointerMove={handleDragMove}
                      onPointerUp={handleDragEnd}
                      onPointerCancel={cancelDrag}
                      className={cn(
                        "absolute cursor-grab touch-none overflow-hidden rounded-lg border border-info/15 border-l-2 border-l-info bg-info/[0.08] px-2 py-1 shadow-surface",
                        (ev.item.done || !ev.item.enabled) && "opacity-50",
                        isDragSource && drag.mode === "move" && "opacity-40",
                      )}
                      style={{
                        top: (startMin / 60) * HOUR_PX,
                        height: Math.max(((endMin - startMin) / 60) * HOUR_PX, 18),
                        left: `calc(${ev.colIdx * width}% + 1px)`,
                        width: `calc(${width}% - 2px)`,
                      }}
                      title={`${formatTime(new Date(day).setHours(0, startMin, 0, 0))} ${ev.item.title}`}
                    >
                      <div className="flex items-center gap-1 text-micro text-muted-foreground">
                        {formatTime(new Date(day).setHours(0, startMin, 0, 0))}
                        {ev.item.kind === "ai_task" && (
                          <Bot className="h-3 w-3 flex-shrink-0 text-info" />
                        )}
                      </div>
                      <div
                        className={cn(
                          "truncate text-micro leading-tight",
                          ev.item.done && "line-through",
                        )}
                      >
                        {ev.item.title}
                      </div>
                      {/* Resize handle */}
                      <div
                        className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize"
                        onPointerDown={(e) => startDrag(e, dayIdx, ev, "resize")}
                        onPointerMove={handleDragMove}
                        onPointerUp={handleDragEnd}
                        onPointerCancel={cancelDrag}
                      />
                    </div>
                  );
                })}

                {/* Move ghost */}
                {drag && drag.mode === "move" && !drag.allDay && drag.dayIdx === dayIdx && (
                  <div
                    className="pointer-events-none absolute z-30 rounded-md border border-dashed border-info bg-info/[0.08] px-1.5 py-0.5 text-micro text-info"
                    style={{
                      top: (drag.startMin / 60) * HOUR_PX,
                      height: Math.max(((drag.endMin - drag.startMin) / 60) * HOUR_PX, 18),
                      left: 1,
                      right: 1,
                    }}
                  >
                    {formatTime(new Date(day).setHours(0, drag.startMin, 0, 0))} –{" "}
                    {formatTime(new Date(day).setHours(0, drag.endMin, 0, 0))}
                  </div>
                )}

                {/* Todo drop hint */}
                {dropHint && dropHint.dayIdx === dayIdx && (
                  <div
                    className="pointer-events-none absolute z-30 rounded-md border border-dashed border-info bg-info/[0.08] px-1.5 py-0.5 text-micro text-info"
                    style={{
                      top: (dropHint.startMin / 60) * HOUR_PX,
                      height: (DEFAULT_DURATION_MIN / 60) * HOUR_PX,
                      left: 1,
                      right: 1,
                    }}
                  >
                    {formatTime(new Date(day).setHours(0, dropHint.startMin, 0, 0))}
                  </div>
                )}
              </div>
            ))}

            {/* Now line */}
            {todayIdx >= 0 && (
              <div
                className="pointer-events-none absolute z-20 h-px bg-info"
                style={{ top: (nowMin / 60) * HOUR_PX, left: 0, right: 0 }}
              >
                <div
                  className="absolute -top-[3px] h-2 w-2 rounded-full bg-info ring-[3px] ring-info-strong/10"
                  style={{ left: `calc(${(todayIdx / colCount) * 100}% - 4px)` }}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
