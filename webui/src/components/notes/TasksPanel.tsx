import { useMemo, useState } from "react";
import { CheckCircle2, Circle, ListChecks, X } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import type { OperationNote } from "./notes-data";
import { extractAllTasks, type ExtractedTask } from "./tasks-extract";

interface TasksPanelProps {
  notes: OperationNote[];
  notebookNameById: Map<string, string>;
  onToggleTask: (noteId: string, line: number) => void;
  onNavigateToNote: (noteId: string) => void;
  onClose: () => void;
}

type Filter = "all" | "pending" | "completed";

export function TasksPanel({
  notes,
  notebookNameById,
  onToggleTask,
  onNavigateToNote,
  onClose,
}: TasksPanelProps) {
  const [filter, setFilter] = useState<Filter>("pending");
  const [groupByNote, setGroupByNote] = useState(true);

  const allTasks = useMemo(
    () => extractAllTasks(notes, notebookNameById),
    [notes, notebookNameById],
  );

  const pendingCount = allTasks.filter((t) => !t.completed).length;
  const completedCount = allTasks.length - pendingCount;

  const filteredTasks = useMemo(() => {
    if (filter === "pending") return allTasks.filter((t) => !t.completed);
    if (filter === "completed") return allTasks.filter((t) => t.completed);
    return allTasks;
  }, [allTasks, filter]);

  const groups = useMemo(() => {
    if (!groupByNote) return null;
    const map = new Map<string, { note: OperationNote; tasks: ExtractedTask[] }>();
    for (const task of filteredTasks) {
      const note = notes.find((n) => n.id === task.noteId);
      if (!note) continue;
      let group = map.get(task.noteId);
      if (!group) {
        group = { note, tasks: [] };
        map.set(task.noteId, group);
      }
      group.tasks.push(task);
    }
    return Array.from(map.values());
  }, [filteredTasks, groupByNote, notes]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/55 px-2">
        <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[12.5px] font-medium text-foreground">任务</span>
        <span className="rounded-full bg-muted/50 px-1.5 py-px text-[10.5px] text-muted-foreground">
          {pendingCount} 待办
        </span>
        <span className="rounded-full bg-muted/30 px-1.5 py-px text-[10.5px] text-muted-foreground">
          {completedCount} 完成
        </span>
        <div className="flex-1" />
        <button
          type="button"
          aria-label="关闭"
          title="关闭"
          onClick={onClose}
          className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/40 px-2">
        {(["pending", "all", "completed"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] transition-colors",
              filter === f
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {f === "pending" ? "待办" : f === "completed" ? "已完成" : "全部"}
          </button>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setGroupByNote((v) => !v)}
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] transition-colors",
            groupByNote
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          按笔记分组
        </button>
      </div>

      {/* Task list */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {filteredTasks.length === 0 ? (
          <div className="flex h-[120px] items-center justify-center text-[12px] text-muted-foreground">
            {filter === "pending" ? "没有待办任务" : filter === "completed" ? "没有已完成的任务" : "没有任务"}
          </div>
        ) : groups ? (
          <div className="py-1">
            {groups.map(({ note, tasks }) => (
              <div key={note.id} className="mb-1">
                <button
                  type="button"
                  onClick={() => onNavigateToNote(note.id)}
                  className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <span className="min-w-0 flex-1 truncate">{note.title || "未命名笔记"}</span>
                  <span className="shrink-0 rounded-full bg-muted/40 px-1 py-px text-[10px]">
                    {tasks.filter((t) => !t.completed).length}/{tasks.length}
                  </span>
                </button>
                <div className="space-y-px">
                  {tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onToggle={() => onToggleTask(task.noteId, task.line)}
                      onNavigate={() => onNavigateToNote(task.noteId)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-px py-1">
            {filteredTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onToggle={() => onToggleTask(task.noteId, task.line)}
                onNavigate={() => onNavigateToNote(task.noteId)}
                showNote
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  onToggle,
  onNavigate,
  showNote,
}: {
  task: ExtractedTask;
  onToggle: () => void;
  onNavigate: () => void;
  showNote?: boolean;
}) {
  return (
    <div
      className="group flex items-start gap-2 px-3 py-1.5 hover:bg-accent"
      onDoubleClick={onNavigate}
    >
      <Checkbox
        checked={task.completed}
        onCheckedChange={onToggle}
        className="mt-0.5 h-3.5 w-3.5"
      />
      <button
        type="button"
        onClick={onNavigate}
        className="min-w-0 flex-1 text-left"
      >
        <span
          className={cn(
            "block text-[12.5px] leading-5",
            task.completed
              ? "text-muted-foreground line-through"
              : "text-foreground",
          )}
        >
          {task.text}
        </span>
        {showNote ? (
          <span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">
            {task.noteTitle}
            {task.notebookName ? ` · ${task.notebookName}` : ""}
          </span>
        ) : null}
      </button>
      {task.completed ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500/60" />
      ) : (
        <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
      )}
    </div>
  );
}
