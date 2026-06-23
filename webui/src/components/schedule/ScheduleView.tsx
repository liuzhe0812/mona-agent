/** Schedule module main view: calendar + day list + edit dialog. */

import { useEffect, useState } from "react";

import { AgentLogo } from "@/components/AgentLogo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { CalendarMonth } from "./CalendarMonth";
import { startOfDay } from "./dateUtils";
import { ScheduleDialog } from "./ScheduleDialog";
import { ScheduleList } from "./ScheduleList";
import { useScheduleStore } from "./scheduleStore";
import type { ScheduleItem, ScheduleItemInput } from "./types";

export function ScheduleView() {
  const {
    items,
    loading,
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

  return (
    <div className="flex h-full w-full bg-background">
      {/* Calendar area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <AgentLogo state="idle" className="h-6 w-6" />
          <h1 className="text-base font-semibold">日程</h1>
          <span className="text-xs text-muted-foreground ml-2">
            {items.length} 项 · 个人日程与 AI 自动化任务
          </span>
          {loading && (
            <span className="text-xs text-muted-foreground ml-auto">加载中…</span>
          )}
          {!loading && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-8 text-xs"
              onClick={() => void loadItems()}
            >
              刷新
            </Button>
          )}
        </div>

        {error && (
          <div className="px-4 py-2 text-sm text-destructive bg-destructive/10 border-b">
            {error}
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
