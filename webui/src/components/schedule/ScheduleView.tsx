/** Schedule module main view: calendar + day list + edit dialog.
 *
 * Receives `onOpenInbox` to trigger the inbox drawer and `inboxCount` to
 * show the badge on the inbox button. Pending email-extracted schedules
 * are no longer shown inline — they are surfaced in the inbox drawer.
 */

import { useEffect, useState } from "react";
import { Inbox as InboxIcon, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import { CalendarMonth } from "./CalendarMonth";
import { DayPlanPanel } from "./DayPlanPanel";
import { startOfDay } from "./dateUtils";
import { ScheduleDialog } from "./ScheduleDialog";
import { useScheduleStore } from "./scheduleStore";
import type { ScheduleItem, ScheduleItemInput } from "./types";

interface ScheduleViewProps {
  onOpenInbox: () => void;
  inboxCount: number;
}

export function ScheduleView({ onOpenInbox, inboxCount }: ScheduleViewProps) {
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

  return (
    <div className="flex h-full w-full bg-background">
      {/* Calendar area */}
      <div className="flex-1 flex flex-col min-w-0">
        {error && (
          <div className="px-4 py-2 text-sm text-destructive bg-destructive/10 border-b">
            {error}
          </div>
        )}

        {/* Top toolbar: month nav is inside CalendarMonth; inbox + new here */}
        <div className="flex items-center justify-end gap-2 border-b border-border/40 px-3 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[12px]"
            onClick={onOpenInbox}
          >
            <InboxIcon className="h-3.5 w-3.5" />
            收集箱
            {inboxBadgeText && (
              <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground">
                {inboxBadgeText}
              </span>
            )}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1 rounded-full px-2.5 text-[12px]"
            onClick={() => openCreate(selectedDate)}
          >
            <Plus className="h-3.5 w-3.5" />
            新建日程
          </Button>
        </div>

        <div className="flex-1 overflow-hidden">
          <CalendarMonth
            items={items}
            onSelectDate={setSelectedDate}
            onSelectItem={openEdit}
            onCreateAt={openCreate}
          />
        </div>
      </div>

      {/* Right panel: day plan */}
      <div className="w-[320px] flex-shrink-0 border-l border-border/40 flex flex-col hidden md:flex">
        <DayPlanPanel
          date={selectedDate}
          scheduleItems={items}
          onSelectScheduleItem={openEdit}
          onCompleteSchedule={handleComplete}
          onToggleSchedule={handleToggle}
          onCreateScheduleAt={openCreate}
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
