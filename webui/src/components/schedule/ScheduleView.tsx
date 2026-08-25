/** Schedule module main view: calendar + day list + edit dialog.
 *
 * Receives `onOpenInbox` to trigger the inbox drawer.
 * Inbox badge count is subscribed directly from todoStore so it stays
 * in sync even when the inbox drawer is closed.
 * Pending email-extracted schedules are no longer shown inline —
 * they are surfaced in the inbox drawer.
 */

import { useEffect, useState } from "react";
import { Inbox as InboxIcon, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusNotice } from "@/components/ui/status-notice";

import { CalendarMonth } from "./CalendarMonth";
import { CalendarWeek } from "./CalendarWeek";
import { DayPlanPanel } from "./DayPlanPanel";
import { startOfDay } from "./dateUtils";
import { ScheduleDialog } from "./ScheduleDialog";
import { useScheduleStore } from "./scheduleStore";
import { useTodoStore } from "./todoStore";
import type { ScheduleItem, ScheduleItemInput } from "./types";
import { isCalendarViewMode, ViewSwitcher, type CalendarViewMode } from "./ViewSwitcher";

interface ScheduleViewProps {
  onOpenInbox: () => void;
}

export function ScheduleView({ onOpenInbox }: ScheduleViewProps) {
  const inboxCount = useTodoStore((s) => s.inboxCount);
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
  const [viewMode, setViewMode] = useState<CalendarViewMode>(() => {
    const saved = localStorage.getItem("schedule.viewMode");
    return isCalendarViewMode(saved) ? saved : "week";
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ScheduleItem | null>(null);
  const [dialogDefaultStart, setDialogDefaultStart] = useState<Date | undefined>(undefined);

  const handleViewModeChange = (mode: CalendarViewMode) => {
    setViewMode(mode);
    localStorage.setItem("schedule.viewMode", mode);
  };

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

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

  const inboxBadgeText =
    inboxCount > 0 ? (inboxCount > 99 ? "99+" : String(inboxCount)) : null;

  const toolbarActions = (
    <>
      <ViewSwitcher mode={viewMode} onChange={handleViewModeChange} />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="relative h-7 gap-1.5 px-2 text-caption"
        onClick={onOpenInbox}
      >
        <InboxIcon className="h-3.5 w-3.5" />
        收集箱
        {inboxBadgeText && (
          <span className="pointer-events-none absolute -right-1 -top-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-micro font-medium leading-none text-destructive-foreground">
            {inboxBadgeText}
          </span>
        )}
      </Button>
      <Button
        type="button"
        size="sm"
        className="h-7 gap-1 px-2.5 text-caption"
        onClick={() => openCreate(selectedDate)}
      >
        <Plus className="h-3.5 w-3.5" />
        新建日程
      </Button>
    </>
  );

  return (
    <div className="flex h-full w-full bg-editor-surface">
      {/* Calendar area */}
      <div className="flex min-w-0 flex-1 flex-col bg-editor-surface">
        {error && (
          <StatusNotice
            tone="danger"
            className="rounded-none border-x-0 border-t-0 px-4 py-2"
          >
            <span className="text-destructive">{error}</span>
          </StatusNotice>
        )}

        <div className="flex-1 overflow-hidden">
          {viewMode === "month" ? (
            <CalendarMonth
              items={items}
              initialCursor={selectedDate}
              onSelectDate={setSelectedDate}
              onSelectItem={openEdit}
              onCreateAt={openCreate}
              toolbarActions={toolbarActions}
            />
          ) : (
            <CalendarWeek
              mode={viewMode}
              items={items}
              initialCursor={selectedDate}
              onSelectItem={openEdit}
              onCreateAt={openCreate}
              toolbarActions={toolbarActions}
            />
          )}
        </div>
      </div>

      {/* Right panel: day plan */}
      <div className="hidden w-[320px] flex-shrink-0 flex-col border-l border-border/40 bg-card md:flex">
        <DayPlanPanel
          date={selectedDate}
          scheduleItems={items}
          onSelectScheduleItem={openEdit}
          onCompleteSchedule={handleComplete}
          onToggleSchedule={handleToggle}
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
