/** TodayView — today's top3 + time-anchored schedule items + due/open todos. */

import { useEffect, useMemo, useState } from "react";
import { Check, Star } from "lucide-react";

import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { useScheduleStore } from "./scheduleStore";
import { useTodoStore } from "./todoStore";
import type { TodoItem } from "./todoTypes";

const BUCKET_OPTIONS = [
  { value: "inbox", label: "收件" },
  { value: "today", label: "今日" },
  { value: "next", label: "下一步" },
  { value: "waiting", label: "等待" },
  { value: "someday", label: "将来" },
];

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDue(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "明天";
  if (diffDays === -1) return "昨天";
  if (diffDays < 0) return `逾期 ${-diffDays} 天`;
  if (diffDays < 7) return `${diffDays} 天后`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function startOfDayMs(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function TodoCard({
  item,
  onComplete,
  onMove,
  busy,
}: {
  item: TodoItem;
  onComplete?: (id: string) => void;
  onMove?: (id: string, bucket: TodoItem["bucket"]) => void;
  busy: string | null;
}) {
  return (
    <div className="group flex items-start gap-2 rounded-lg border border-border/40 p-2.5">
      <button
        type="button"
        onClick={() => onComplete?.(item.id)}
        disabled={item.state === "done" || busy === item.id}
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          item.state === "done"
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/40 hover:border-primary",
        )}
        aria-label="完成"
      >
        {item.state === "done" && <Check className="h-3 w-3" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {item.focusRank != null && item.bucket === "today" && (
            <Star className="h-3 w-3 shrink-0 fill-primary text-primary" />
          )}
          <span
            className={cn(
              "truncate text-ui",
              item.state === "done" && "line-through opacity-50",
            )}
          >
            {item.title}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-micro text-muted-foreground">
          {item.dueAtMs != null && (
            <span
              className={cn(
                item.dueAtMs < Date.now() &&
                  item.state !== "done" &&
                  "text-destructive",
              )}
            >
              {formatDue(item.dueAtMs)}
            </span>
          )}
          <span>
            {item.bucket === "today"
              ? "今日"
              : item.bucket === "next"
                ? "下一步"
                : item.bucket === "waiting"
                  ? "等待中"
                  : "将来"}
          </span>
        </div>
      </div>
      {item.state !== "done" && onMove && (
        <Select
          value={item.bucket}
          onValueChange={(v) => onMove(item.id, v as TodoItem["bucket"])}
          options={BUCKET_OPTIONS}
          className="h-6 w-auto shrink-0 gap-1 rounded-md border-border/40 px-1 text-micro opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
    </div>
  );
}

export function TodayView() {
  const { items: scheduleItems, loadItems: loadSchedule } = useScheduleStore();
  const {
    items: todos,
    briefing,
    loadAll: loadTodos,
    loadBriefing,
    completeItem,
    moveItem,
    setFocusRank,
  } = useTodoStore();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void loadSchedule();
    void loadTodos();
    void loadBriefing();
  }, [loadSchedule, loadTodos, loadBriefing]);

  const todayStart = startOfDayMs(new Date());
  const todayEnd = todayStart + 86_400_000;

  const todaySchedule = useMemo(
    () =>
      scheduleItems
        .filter(
          (it) =>
            it.startAtMs >= todayStart &&
            it.startAtMs < todayEnd &&
            !it.done,
        )
        .sort((a, b) => a.startAtMs - b.startAtMs),
    [scheduleItems, todayStart, todayEnd],
  );

  const openTodos = todos.filter((it) => it.state === "open");
  const todayTodos = openTodos.filter((it) => it.bucket === "today");
  const overdueTodos = openTodos.filter(
    (it) => it.dueAtMs != null && it.dueAtMs < todayStart && it.bucket !== "today",
  );
  const dueTodayTodos = openTodos.filter(
    (it) =>
      it.dueAtMs != null &&
      it.dueAtMs >= todayStart &&
      it.dueAtMs < todayEnd &&
      it.bucket !== "today",
  );

  const top3 = briefing?.top3 ?? [];
  const hasConfirmed = top3.some(
    (it) => it.focusRank != null && it.bucket === "today",
  );

  const handleComplete = async (id: string) => {
    setBusy(id);
    try {
      await completeItem(id);
      void loadBriefing();
    } finally {
      setBusy(null);
    }
  };

  const handleMove = async (id: string, bucket: TodoItem["bucket"]) => {
    await moveItem(id, bucket);
    void loadBriefing();
  };

  const handleToggleFocus = async (id: string, currentRank: number | null) => {
    const newRank = currentRank != null ? null : 1;
    await setFocusRank(id, newRank);
    void loadBriefing();
  };

  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

  return (
    <div className="h-full overflow-y-auto scrollbar-hover">
      {/* Top3 card */}
      <section className="m-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-body font-semibold">
            {hasConfirmed ? "今日三件事" : "推荐三件事"}
          </h3>
          <span className="text-micro text-muted-foreground">{dateStr}</span>
        </div>
        {top3.length === 0 ? (
          <div className="py-4 text-center text-ui text-muted-foreground">
            今天还没有重点事项，从下方待办中挑选加入今日三件事
          </div>
        ) : (
          <div className="space-y-1.5">
            {top3.map((it, idx) => (
              <div
                key={it.id}
                className="flex items-center gap-2 rounded-lg bg-background/60 p-2"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-micro font-semibold text-primary-foreground">
                  {it.focusRank ?? idx + 1}
                </span>
                <span className="flex-1 truncate text-ui">{it.title}</span>
                {it.dueAtMs != null && (
                  <span className="text-micro text-muted-foreground">
                    {formatDue(it.dueAtMs)}
                  </span>
                )}
                {it.bucket === "today" && it.state === "open" && (
                  <button
                    type="button"
                    onClick={() => handleToggleFocus(it.id, it.focusRank)}
                    className="text-caption text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {it.focusRank != null ? "取消重点" : "设为重点"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Today schedule (time-anchored) */}
      <section className="mx-3 mb-3">
        <h4 className="mb-1.5 text-caption font-medium text-muted-foreground">
          今日时间安排
        </h4>
        {todaySchedule.length === 0 ? (
          <div className="p-3 text-center text-ui text-muted-foreground">
            今天没有日程安排
          </div>
        ) : (
          <div className="space-y-1">
            {todaySchedule.map((it) => (
              <div
                key={it.id}
                className="flex items-center gap-3 rounded-lg border border-border/40 p-2"
              >
                <span className="text-caption font-medium tabular-nums text-muted-foreground">
                  {formatTime(it.startAtMs)}
                </span>
                <span className="flex-1 truncate text-ui">{it.title}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Today todos */}
      <section className="mx-3 mb-3">
        <h4 className="mb-1.5 text-caption font-medium text-muted-foreground">
          今日待办 ({todayTodos.length})
        </h4>
        {todayTodos.length === 0 ? (
          <div className="p-3 text-center text-ui text-muted-foreground">
            把收集箱里的待办移到今日开始推进
          </div>
        ) : (
          <div className="space-y-1.5">
            {todayTodos.map((it) => (
              <TodoCard
                key={it.id}
                item={it}
                onComplete={handleComplete}
                onMove={handleMove}
                busy={busy}
              />
            ))}
          </div>
        )}
      </section>

      {/* Overdue */}
      {overdueTodos.length > 0 && (
        <section className="mx-3 mb-3">
          <h4 className="mb-1.5 text-caption font-medium text-destructive">
            逾期 ({overdueTodos.length})
          </h4>
          <div className="space-y-1.5">
            {overdueTodos.map((it) => (
              <TodoCard
                key={it.id}
                item={it}
                onComplete={handleComplete}
                onMove={handleMove}
                busy={busy}
              />
            ))}
          </div>
        </section>
      )}

      {/* Due today */}
      {dueTodayTodos.length > 0 && (
        <section className="mx-3 mb-3">
          <h4 className="mb-1.5 text-caption font-medium text-muted-foreground">
            今天到期 ({dueTodayTodos.length})
          </h4>
          <div className="space-y-1.5">
            {dueTodayTodos.map((it) => (
              <TodoCard
                key={it.id}
                item={it}
                onComplete={handleComplete}
                onMove={handleMove}
                busy={busy}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
