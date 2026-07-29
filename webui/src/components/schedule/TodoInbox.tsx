/** TodoInbox — slide-in drawer collecting all pending plan inputs.
 *
 * Sections:
 * 1. Quick capture input
 * 2. AI-suggested todos (state=suggestion) — confirm / discard
 * 3. Email-extracted pending schedules — confirm / discard
 * 4. Unclassified open inbox todos — move to today / next / waiting / someday
 */

import { useEffect, useState } from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronUp,
  Inbox as InboxIcon,
  Loader2,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { type PendingScheduleItem } from "./scheduleApi";
import { useTodoStore } from "./todoStore";
import type { TodoItem } from "./todoTypes";

function formatDue(ms: number | null): string {
  if (ms == null) return "";
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

function formatScheduleTime(item: PendingScheduleItem["item"]): string {
  const start = new Date(item.startAtMs);
  const dateStr = `${start.getMonth() + 1}/${start.getDate()}`;
  if (item.allDay) return `${dateStr} 全天`;
  const timeStr = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
  return `${dateStr} ${timeStr}`;
}

function sourceLabel(item: TodoItem): string {
  switch (item.sourceType) {
    case "email": return "邮件";
    case "chat": return "对话";
    case "note": return "笔记";
    default: return "手动";
  }
}

function isReplied(item: TodoItem): boolean {
  return item.notes.includes("[已回复");
}

interface TodoInboxProps {
  onCountChange?: (count: number) => void;
}

export function TodoInbox({ onCountChange }: TodoInboxProps) {
  const {
    items,
    pendingSchedules,
    addItem,
    confirmSuggestion,
    discardSuggestion,
    completeItem,
    moveItem,
    loadAll,
    loadPendingSchedules,
    confirmPendingSchedule,
    discardPendingSchedule,
    inboxCount,
  } = useTodoStore();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [suggestionsExpanded, setSuggestionsExpanded] = useState(true);
  const [pendingExpanded, setPendingExpanded] = useState(true);
  const [pendingBusy, setPendingBusy] = useState<string | null>(null);

  // Load pending schedules on mount + poll every 30s
  useEffect(() => {
    void loadPendingSchedules();
    const timer = setInterval(() => void loadPendingSchedules(), 30000);
    return () => clearInterval(timer);
  }, [loadPendingSchedules]);

  // Refresh todos on mount
  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Notify parent of total pending count for the badge
  useEffect(() => {
    onCountChange?.(inboxCount);
  }, [inboxCount, onCountChange]);

  const handleCreate = async () => {
    const title = draft.trim();
    if (!title) return;
    await addItem({ title });
    setDraft("");
  };

  const handleConfirm = async (id: string) => {
    setBusy(id);
    try {
      await confirmSuggestion(id);
    } finally {
      setBusy(null);
    }
  };

  const handleDiscard = async (id: string) => {
    setBusy(id);
    try {
      await discardSuggestion(id);
    } finally {
      setBusy(null);
    }
  };

  const handleComplete = async (id: string) => {
    setBusy(id);
    try {
      await completeItem(id);
    } finally {
      setBusy(null);
    }
  };

  const handleMove = async (id: string, bucket: TodoItem["bucket"]) => {
    await moveItem(id, bucket);
  };

  const handleConfirmPending = async (pending: PendingScheduleItem) => {
    setPendingBusy(pending.id);
    try {
      await confirmPendingSchedule(pending.id);
    } catch {
      // ignore
    } finally {
      setPendingBusy(null);
    }
  };

  const handleDiscardPending = async (pending: PendingScheduleItem) => {
    setPendingBusy(pending.id);
    try {
      await discardPendingSchedule(pending.id);
    } catch {
      // ignore
    } finally {
      setPendingBusy(null);
    }
  };

  const suggestions = items.filter((it) => it.state === "suggestion");
  const inboxItems = items.filter(
    (it) => it.state === "open" && it.bucket === "inbox",
  );
  const visibleSuggestions = suggestionsExpanded
    ? suggestions
    : suggestions.slice(0, 3);
  const hiddenSuggestionCount = suggestions.length - visibleSuggestions.length;

  return (
    <div className="flex h-full flex-col">
      {/* Quick capture */}
      <div className="border-b border-border/40 p-3">
        <div className="flex items-center gap-2">
          <InboxIcon className="h-4 w-4 text-muted-foreground" />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreate();
              }
            }}
            placeholder="快速记录一件待办…"
            className="h-8 flex-1"
          />
          <Button size="sm" onClick={handleCreate} disabled={!draft.trim()}>
            记录
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-3">
        {/* AI suggestions */}
        {suggestions.length > 0 && (
          <section className="mb-4">
            <button
              type="button"
              onClick={() => setSuggestionsExpanded((v) => !v)}
              className="mb-2 flex w-full items-center gap-1.5 text-[12px] font-medium text-amber-700 dark:text-amber-400"
            >
              {suggestionsExpanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              对话建议 ({suggestions.length})
            </button>
            <div className="space-y-1.5">
              {visibleSuggestions.map((it) => (
                <TodoRow
                  key={it.id}
                  item={it}
                  onConfirm={handleConfirm}
                  onDiscard={handleDiscard}
                  busy={busy}
                />
              ))}
              {hiddenSuggestionCount > 0 && (
                <button
                  type="button"
                  onClick={() => setSuggestionsExpanded(true)}
                  className="w-full rounded-md py-1 text-[11px] text-muted-foreground hover:bg-accent"
                >
                  还有 {hiddenSuggestionCount} 条待确认…
                </button>
              )}
            </div>
          </section>
        )}

        {/* Email-extracted pending schedules */}
        {pendingSchedules.length > 0 && (
          <section className="mb-4">
            <button
              type="button"
              onClick={() => setPendingExpanded((v) => !v)}
              className="mb-2 flex w-full items-center gap-1.5 text-[12px] font-medium text-amber-700 dark:text-amber-400"
            >
              {pendingExpanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              <CalendarClock className="h-3.5 w-3.5" />
              邮件日程 ({pendingSchedules.length})
            </button>
            {pendingExpanded && (
              <div className="space-y-1.5">
                {pendingSchedules.map((pending) => (
                  <PendingScheduleRow
                    key={pending.id}
                    pending={pending}
                    onConfirm={handleConfirmPending}
                    onDiscard={handleDiscardPending}
                    busy={pendingBusy}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* Open inbox items */}
        <section>
          <div className="mb-2 text-[12px] font-medium text-muted-foreground">
            收集箱 ({inboxItems.length})
          </div>
          {inboxItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/40 p-6 text-center text-[12px] text-muted-foreground">
              收集箱已清空
            </div>
          ) : (
            <div className="space-y-1.5">
              {inboxItems.map((it) => (
                <TodoRow
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
      </div>
    </div>
  );
}

function TodoRow({
  item,
  onConfirm,
  onDiscard,
  onComplete,
  onMove,
  busy,
}: {
  item: TodoItem;
  onConfirm?: (id: string) => void;
  onDiscard?: (id: string) => void;
  onComplete?: (id: string) => void;
  onMove?: (id: string, bucket: TodoItem["bucket"]) => void;
  busy: string | null;
}) {
  const isSuggestion = item.state === "suggestion";
  const isDone = item.state === "done";
  return (
    <div
      className={cn(
        "group flex items-start gap-2 rounded-lg border border-border/40 p-2.5",
        isSuggestion && "bg-amber-50/60 dark:bg-amber-950/20",
        isDone && "opacity-50",
      )}
    >
      <button
        type="button"
        onClick={() => onComplete?.(item.id)}
        disabled={isDone || isSuggestion}
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          isDone
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/40 hover:border-primary",
        )}
        aria-label="完成"
      >
        {isDone && <Check className="h-3 w-3" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
              isSuggestion
                ? "bg-amber-200/60 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                : "bg-muted text-muted-foreground",
            )}
          >
            {sourceLabel(item)}
          </span>
          {isReplied(item) && (
            <span className="shrink-0 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
              已回复
            </span>
          )}
          <span
            className={cn(
              "truncate text-[13px]",
              isDone && "line-through",
            )}
          >
            {item.title}
          </span>
        </div>
        {(item.dueAtMs != null || item.sourceSnapshot.evidence) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            {item.dueAtMs != null && (
              <span
                className={cn(
                  item.dueAtMs < Date.now() && !isDone && "text-destructive",
                )}
              >
                {formatDue(item.dueAtMs)}
              </span>
            )}
            {item.sourceSnapshot.from && (
              <span className="truncate">来自: {item.sourceSnapshot.from}</span>
            )}
          </div>
        )}
        {isSuggestion && item.sourceSnapshot.evidence && (
          <div className="mt-1.5 rounded-md bg-background/60 p-1.5 text-[11px] text-muted-foreground">
            {item.sourceSnapshot.evidence.slice(0, 120)}
            {item.sourceSnapshot.evidence.length > 120 && "…"}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {isSuggestion ? (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={() => onConfirm?.(item.id)}
              disabled={busy === item.id}
              title="确认加入"
            >
              {busy === item.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={() => onDiscard?.(item.id)}
              disabled={busy === item.id}
              title="丢弃"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : !isDone && onMove ? (
          <select
            className="h-6 rounded-md border border-border/40 bg-background px-1 text-[11px]"
            value={item.bucket}
            onChange={(e) => onMove(item.id, e.target.value as TodoItem["bucket"])}
          >
            <option value="inbox">收件</option>
            <option value="today">今日</option>
            <option value="next">下一步</option>
            <option value="waiting">等待</option>
            <option value="someday">将来</option>
          </select>
        ) : null}
      </div>
    </div>
  );
}

function PendingScheduleRow({
  pending,
  onConfirm,
  onDiscard,
  busy,
}: {
  pending: PendingScheduleItem;
  onConfirm: (pending: PendingScheduleItem) => void;
  onDiscard: (pending: PendingScheduleItem) => void;
  busy: string | null;
}) {
  return (
    <div className="rounded-lg border border-amber-200/60 bg-amber-50/40 p-2.5 dark:border-amber-900/40 dark:bg-amber-950/20">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="truncate text-[13px] font-medium">
            {pending.item.title || "(未命名日程)"}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {formatScheduleTime(pending.item)}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            邮件：{pending.emailSubject || "(无主题)"}
          </div>
          {pending.emailFrom && (
            <div className="truncate text-[11px] text-muted-foreground/70">
              发件人：{pending.emailFrom}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-emerald-600 hover:text-emerald-700"
            disabled={busy === pending.id}
            onClick={() => onConfirm(pending)}
            title="确认创建"
          >
            {busy === pending.id ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            确认
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-destructive"
            disabled={busy === pending.id}
            onClick={() => onDiscard(pending)}
            title="丢弃"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
