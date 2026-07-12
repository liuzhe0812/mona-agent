/** Schedule module main view: calendar + day list + edit dialog. */

import { useEffect, useState } from "react";
import { CalendarClock, ChevronDown, ChevronUp, Check, Trash2, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

import { CalendarMonth } from "./CalendarMonth";
import { startOfDay } from "./dateUtils";
import { ScheduleDialog } from "./ScheduleDialog";
import { ScheduleList } from "./ScheduleList";
import { useScheduleStore } from "./scheduleStore";
import {
  listPendingSchedules,
  confirmPendingSchedule,
  discardPendingSchedule,
  type PendingScheduleItem,
} from "./scheduleApi";
import type { ScheduleItem, ScheduleItemInput } from "./types";

function formatScheduleTime(item: ScheduleItem): string {
  const start = new Date(item.startAtMs);
  const dateStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  if (item.allDay) return `${dateStr} 全天`;
  const timeStr = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
  if (item.endAtMs != null) {
    const end = new Date(item.endAtMs);
    const endTimeStr = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
    return `${dateStr} ${timeStr} - ${endTimeStr}`;
  }
  return `${dateStr} ${timeStr}`;
}

export function ScheduleView() {
  const {
    items,
    error,
    loadItems,
    addItem,
    editItem,
    deleteItem,
    completeItem,
    toggleItem,
  } = useScheduleStore();

  const [selectedDate, setSelectedDate] = useState<Date>(() => startOfDay(new Date()));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ScheduleItem | null>(null);
  const [dialogDefaultStart, setDialogDefaultStart] = useState<Date | undefined>(undefined);

  // 待确认的邮件提取日程
  const [pendingItems, setPendingItems] = useState<PendingScheduleItem[]>([]);
  const [pendingExpanded, setPendingExpanded] = useState(false);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  // 轮询待确认列表（每 30 秒），并在首次加载后立即拉取一次
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await listPendingSchedules();
        if (!cancelled) setPendingItems(result);
      } catch {
        // gateway 未就绪或路由不可用时静默忽略
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const openCreate = (date: Date) => {
    setEditingItem(null);
    setDialogDefaultStart(date);
    setDialogOpen(true);
  };

  const openEdit = (item: ScheduleItem) => {
    setEditingItem(item);
    setDialogDefaultStart(undefined);
    setDialogOpen(true);
  };

  const handleSave = async (input: ScheduleItemInput) => {
    if (editingItem) {
      await editItem(editingItem.id, input);
    } else {
      await addItem(input);
    }
  };

  const handleDelete = async (id: string) => {
    await deleteItem(id);
  };

  const handleComplete = async (id: string) => {
    await completeItem(id);
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    await toggleItem(id, enabled);
  };

  // 确认创建待确认日程：后端已写入 schedule store，前端刷新列表
  const handleConfirmPending = async (pending: PendingScheduleItem) => {
    setPendingActionId(pending.id);
    try {
      const result = await confirmPendingSchedule(pending.id);
      if (result.ok) {
        // 后端已创建日程，刷新列表以显示新日程
        await loadItems();
        setPendingItems((prev) => prev.filter((p) => p.id !== pending.id));
      }
    } catch {
      // ignore
    } finally {
      setPendingActionId(null);
    }
  };

  // 丢弃待确认日程
  const handleDiscardPending = async (pending: PendingScheduleItem) => {
    setPendingActionId(pending.id);
    try {
      const result = await discardPendingSchedule(pending.id);
      if (result.ok) {
        setPendingItems((prev) => prev.filter((p) => p.id !== pending.id));
      }
    } catch {
      // ignore
    } finally {
      setPendingActionId(null);
    }
  };

  const pendingCount = pendingItems.length;

  return (
    <div className="flex h-full w-full bg-background">
      {/* Calendar area */}
      <div className="flex-1 flex flex-col min-w-0">
        {error && (
          <div className="px-4 py-2 text-sm text-destructive bg-destructive/10 border-b">
            {error}
          </div>
        )}

        {/* 待确认日程角标 */}
        {pendingCount > 0 && (
          <div className="border-b border-border bg-amber-50/50 dark:bg-amber-950/20">
            <button
              type="button"
              onClick={() => setPendingExpanded((v) => !v)}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] hover:bg-amber-50/80 dark:hover:bg-amber-950/30"
            >
              <CalendarClock className="h-4 w-4 text-amber-600" />
              <span className="font-medium text-amber-700 dark:text-amber-400">
                {pendingCount} 个待确认的邮件日程
              </span>
              <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
                {pendingExpanded ? "收起" : "展开"}
                {pendingExpanded ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </span>
            </button>
            {pendingExpanded && (
              <div className="max-h-[300px] space-y-1.5 overflow-y-auto px-3 pb-3">
                {pendingItems.map((pending) => (
                  <div
                    key={pending.id}
                    className="rounded-lg border border-border/60 bg-background p-2.5 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
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
                          disabled={pendingActionId === pending.id}
                          onClick={() => void handleConfirmPending(pending)}
                          title="确认创建"
                        >
                          {pendingActionId === pending.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Check className="h-3 w-3" />
                          )}
                          确认创建
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                          disabled={pendingActionId === pending.id}
                          onClick={() => void handleDiscardPending(pending)}
                          title="丢弃"
                        >
                          <Trash2 className="h-3 w-3" />
                          丢弃
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          <CalendarMonth
            items={items}
            onSelectDate={setSelectedDate}
            onSelectItem={openEdit}
            onCreateAt={openCreate}
          />
        </div>
      </div>

      {/* Right panel: day list */}
      <div
        className={cn(
          "w-[320px] flex-shrink-0 border-l flex flex-col",
          "hidden md:flex",
        )}
      >
        <ScheduleList
          date={selectedDate}
          items={items}
          onSelectItem={openEdit}
          onComplete={handleComplete}
          onToggle={handleToggle}
          onCreateAt={openCreate}
        />
      </div>

      {/* Edit/Create dialog */}
      <ScheduleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        item={editingItem}
        defaultStart={dialogDefaultStart}
        onSave={handleSave}
        onDelete={handleDelete}
      />
    </div>
  );
}
