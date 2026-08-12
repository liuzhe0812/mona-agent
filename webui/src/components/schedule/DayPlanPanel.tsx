/** DayPlanPanel — right-side panel showing the full plan for the selected day.
 *
 * Sections (top to bottom):
 * 1. Date header + plan count
 * 2. Today's top3 (compact, only when the selected date is today)
 * 3. Overdue banner (when any overdue items exist)
 * 4. Time-anchored schedule items for the day
 * 5. Todos for the day (bucket=today OR due_at matches)
 * 6. Unscheduled todos (next / waiting / someday, draggable onto the calendar)
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bot, Check, GripVertical, Pause, Play, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { formatTime, isSameDay, startOfDay, weekdayName } from "./dateUtils";
import { useTodoStore } from "./todoStore";
import { TODO_DRAG_MIME, type ScheduleItem } from "./types";
import type { TodoItem } from "./todoTypes";

interface DayPlanPanelProps {
  date: Date;
  scheduleItems: ScheduleItem[];
  onSelectScheduleItem: (item: ScheduleItem) => void;
  onCompleteSchedule: (id: string) => void;
  onToggleSchedule: (id: string, enabled: boolean) => void;
}

function formatDueLabel(ms: number): string {
  const d = new Date(ms);
  const today = startOfDay(new Date());
  const target = startOfDay(d);
  const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === -1) return "昨天";
  if (diff < 0) return `逾期 ${-diff} 天`;
  if (diff < 7) return `${diff} 天后`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function recurrenceLabel(rec: string): string {
  switch (rec) {
    case "daily": return "每天";
    case "weekly": return "每周";
    case "monthly": return "每月";
    case "cron_expr": return "Cron";
    default: return "不重复";
  }
}

export function DayPlanPanel({
  date,
  scheduleItems,
  onSelectScheduleItem,
  onCompleteSchedule,
  onToggleSchedule,
}: DayPlanPanelProps) {
  const { items: todos, loadAll: loadTodos, loadBriefing, briefing, completeItem } = useTodoStore();
  const [busyTodo, setBusyTodo] = useState<string | null>(null);

  useEffect(() => {
    void loadTodos();
    void loadBriefing();
  }, [loadTodos, loadBriefing]);

  const isToday = isSameDay(date, new Date());
  const dayStart = startOfDay(date).getTime();
  const dayEnd = dayStart + 86_400_000;

  const daySchedules = useMemo(
    () =>
      scheduleItems
        .filter((it) => {
          const s = new Date(it.startAtMs).getTime();
          return s >= dayStart && s < dayEnd;
        })
        .sort((a, b) => a.startAtMs - b.startAtMs),
    [scheduleItems, dayStart, dayEnd],
  );

  const openTodos = todos.filter((it) => it.state === "open");

  // Todos for the selected day: bucket=today OR due_at matches
  const dayTodos = useMemo(() => {
    const seen = new Set<string>();
    const result: TodoItem[] = [];
    for (const it of openTodos) {
      if (it.bucket === "today" && isToday) {
        if (!seen.has(it.id)) {
          seen.add(it.id);
          result.push(it);
        }
      }
      if (it.dueAtMs != null) {
        const due = new Date(it.dueAtMs).getTime();
        if (due >= dayStart && due < dayEnd) {
          if (!seen.has(it.id)) {
            seen.add(it.id);
            result.push(it);
          }
        }
      }
    }
    return result.sort((a, b) => {
      const ra = a.focusRank ?? 99;
      const rb = b.focusRank ?? 99;
      if (ra !== rb) return ra - rb;
      return (a.dueAtMs ?? Infinity) - (b.dueAtMs ?? Infinity);
    });
  }, [openTodos, isToday, dayStart, dayEnd]);

  const overdueTodos = useMemo(
    () =>
      openTodos.filter(
        (it) =>
          it.dueAtMs != null &&
          it.dueAtMs < startOfDay(new Date()).getTime() &&
          it.bucket !== "today",
      ),
    [openTodos],
  );

  const BUCKET_ORDER: Record<string, number> = { next: 0, waiting: 1, someday: 2 };
  const unscheduledTodos = openTodos
    .filter(
      (it) => it.bucket === "next" || it.bucket === "waiting" || it.bucket === "someday",
    )
    .sort((a, b) => (BUCKET_ORDER[a.bucket] ?? 9) - (BUCKET_ORDER[b.bucket] ?? 9));

  const top3 = briefing?.top3 ?? [];
  const planCount = daySchedules.length + dayTodos.length;

  const handleCompleteTodo = async (id: string) => {
    setBusyTodo(id);
    try {
      await completeItem(id);
      void loadBriefing();
    } finally {
      setBusyTodo(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Date header */}
      <div className="px-4 py-3 border-b border-border/40">
        <div className="text-[14px] font-semibold">
          {date.getMonth() + 1}月{date.getDate()}日 {weekdayName(date)}
          {isToday && (
            <span className="ml-2 text-[11px] text-primary font-normal">今天</span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5">
          {planCount} 项计划
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-hover">
        {/* Overdue banner (not counted in planCount) */}
        {overdueTodos.length > 0 && (
          <section className="mx-3 mt-3">
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                逾期 {overdueTodos.length} 项
              </div>
              <div className="space-y-1">
                {overdueTodos.slice(0, 5).map((it) => (
                  <div key={it.id} className="flex items-center gap-2 text-[12px]">
                    <span className="text-destructive">●</span>
                    <span className="flex-1 truncate">{it.title}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatDueLabel(it.dueAtMs!)}
                    </span>
                  </div>
                ))}
                {overdueTodos.length > 5 && (
                  <div className="text-[10px] text-muted-foreground">
                    +{overdueTodos.length - 5} 项
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Today's top3 (compact, only when today) */}
        {isToday && (
          <section className="mx-3 mt-3">
            <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">
              今日三件事
            </div>
            {top3.length === 0 ? (
              <div className="text-[11px] text-muted-foreground/70">
                还没有重点事项，从下方待办中标记
              </div>
            ) : (
              <div className="space-y-1">
                {top3.map((it, idx) => (
                  <div
                    key={it.id}
                    className="flex items-center gap-2 rounded-md bg-primary/5 px-2 py-1.5"
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                      {it.focusRank ?? idx + 1}
                    </span>
                    <span className="flex-1 truncate text-[12px]">{it.title}</span>
                    {it.dueAtMs != null && (
                      <span className="text-[10px] text-muted-foreground">
                        {formatDueLabel(it.dueAtMs)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Schedule items + todos (merged empty state) */}
        {daySchedules.length === 0 && dayTodos.length === 0 ? (
          <div className="mx-3 mt-3 py-6 text-center text-[11px] text-muted-foreground">
            这一天还没有日程或待办
          </div>
        ) : (
          <>
            <section className="mx-3 mt-3">
              <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">
                日程 ({daySchedules.length})
              </div>
              {daySchedules.length === 0 ? (
                <div className="px-1 text-[11px] text-muted-foreground">
                  当天没有日程
                </div>
              ) : (
                <div className="space-y-1">
                  {daySchedules.map((item) => (
                    <ScheduleRow
                      key={item.id}
                      item={item}
                      onSelect={() => onSelectScheduleItem(item)}
                      onComplete={() => onCompleteSchedule(item.id)}
                      onToggle={(enabled) => onToggleSchedule(item.id, enabled)}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="mx-3 mt-3">
              <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">
                待办 ({dayTodos.length})
              </div>
              {dayTodos.length === 0 ? (
                <div className="px-1 text-[11px] text-muted-foreground">
                  当天没有待办
                </div>
              ) : (
                <div className="space-y-1">
                  {dayTodos.map((it) => (
                    <TodoRow
                      key={it.id}
                      item={it}
                      busy={busyTodo}
                      onComplete={() => void handleCompleteTodo(it.id)}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {/* Unscheduled todos (drag onto the calendar to schedule) */}
        {unscheduledTodos.length > 0 && (
          <section className="mx-3 mt-3 mb-3">
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[12px] font-medium text-muted-foreground">
                未排期 ({unscheduledTodos.length})
              </span>
              <span className="text-[10px] text-muted-foreground/70">
                拖到日历上排期
              </span>
            </div>
            <div className="space-y-0.5">
              {unscheduledTodos.slice(0, 6).map((it) => (
                <div
                  key={it.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(TODO_DRAG_MIME, it.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  className="flex cursor-grab items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] hover:bg-accent transition-colors"
                  title="拖到日历上排期"
                >
                  <GripVertical className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                  <span className="flex-1 truncate">{it.title}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {it.bucket === "next" ? "下一步" : it.bucket === "waiting" ? "等待" : "将来"}
                  </span>
                </div>
              ))}
              {unscheduledTodos.length > 6 && (
                <div className="px-2 text-[10px] text-muted-foreground">
                  +{unscheduledTodos.length - 6} 项
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function ScheduleRow({
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
        "flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent cursor-pointer transition-colors",
        item.done && "opacity-60",
        !item.enabled && "opacity-60",
      )}
      onClick={onSelect}
    >
      <div
        className={cn(
          "w-0.5 self-stretch rounded-full flex-shrink-0",
          "bg-primary",
          item.done && "bg-muted",
        )}
      />
      <div className="flex-shrink-0 w-12 pt-0.5">
        {item.allDay ? (
          <span className="text-[10px] text-muted-foreground">全天</span>
        ) : (
          <span className="text-[11px] font-mono text-foreground">
            {formatTime(item.startAtMs)}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          {isAi && <Bot className="h-3 w-3 flex-shrink-0 text-primary" />}
          <span
            className={cn(
              "truncate text-[12px] font-medium",
              item.done && "line-through",
            )}
          >
            {item.title}
          </span>
        </div>
        {item.description && (
          <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">
            {item.description}
          </p>
        )}
        {item.recurrence !== "none" && (
          <span className="text-[10px] text-muted-foreground">
            {recurrenceLabel(item.recurrence)}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
        {!isAi && !item.done && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onComplete}
            title="标记完成"
          >
            <Check className="h-3 w-3" />
          </Button>
        )}
        {isAi && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onToggle(!item.enabled)}
            title={item.enabled ? "暂停" : "恢复"}
          >
            {item.enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          </Button>
        )}
      </div>
    </div>
  );
}

function TodoRow({
  item,
  busy,
  onComplete,
}: {
  item: TodoItem;
  busy: string | null;
  onComplete: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent cursor-pointer transition-colors">
      <button
        type="button"
        onClick={onComplete}
        disabled={item.state === "done" || busy === item.id}
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          item.state === "done"
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/40 hover:border-primary",
        )}
        aria-label="完成"
      >
        {item.state === "done" && <Check className="h-2.5 w-2.5" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          {item.focusRank != null && (
            <Star className="h-3 w-3 shrink-0 fill-primary text-primary" />
          )}
          <span
            className={cn(
              "truncate text-[12px]",
              item.state === "done" && "line-through opacity-50",
            )}
          >
            {item.title}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
          {item.dueAtMs != null && (
            <span
              className={cn(
                item.dueAtMs < Date.now() && item.state !== "done" && "text-destructive",
              )}
            >
              {formatDueLabel(item.dueAtMs)}
            </span>
          )}
          <span>{item.bucket === "today" ? "今日" : item.bucket === "next" ? "下一步" : item.bucket === "waiting" ? "等待" : "将来"}</span>
        </div>
      </div>
    </div>
  );
}
