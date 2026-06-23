/** Schedule edit/create dialog. */

import { useEffect, useState } from "react";
import { Bot } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  fromDatetimeLocalValue,
  toDatetimeLocalValue,
} from "./dateUtils";
import type { ScheduleItem, ScheduleItemInput, ScheduleKind, ScheduleRecurrence } from "./types";

interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When editing, the existing item; when creating, null. */
  item: ScheduleItem | null;
  /** Default start time for new items. */
  defaultStart?: Date;
  onSave: (input: ScheduleItemInput) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

const RECURRENCE_OPTIONS: { value: ScheduleRecurrence; label: string }[] = [
  { value: "none", label: "不重复" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "cron_expr", label: "自定义 Cron" },
];

const COLOR_OPTIONS = [
  { value: "", label: "默认", className: "bg-blue-500" },
  { value: "green", label: "绿", className: "bg-green-500" },
  { value: "orange", label: "橙", className: "bg-orange-500" },
  { value: "purple", label: "紫", className: "bg-purple-500" },
  { value: "gray", label: "灰", className: "bg-gray-500" },
];

export function ScheduleDialog({
  open,
  onOpenChange,
  item,
  defaultStart,
  onSave,
  onDelete,
}: ScheduleDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [recurrence, setRecurrence] = useState<ScheduleRecurrence>("none");
  const [cronExpr, setCronExpr] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("personal");
  const [aiMessage, setAiMessage] = useState("");
  const [aiDeliver, setAiDeliver] = useState(true);
  const [color, setColor] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (item) {
      setTitle(item.title);
      setDescription(item.description);
      setStartAt(toDatetimeLocalValue(new Date(item.startAtMs)));
      setEndAt(item.endAtMs ? toDatetimeLocalValue(new Date(item.endAtMs)) : "");
      setAllDay(item.allDay);
      setRecurrence(item.recurrence);
      setCronExpr(item.cronExpr ?? "");
      setKind(item.kind);
      setAiMessage(item.aiMessage ?? "");
      setAiDeliver(item.aiDeliver);
      setColor(item.color ?? "");
    } else {
      const base = defaultStart ?? new Date();
      setTitle("");
      setDescription("");
      setStartAt(toDatetimeLocalValue(base));
      setEndAt("");
      setAllDay(false);
      setRecurrence("none");
      setCronExpr("");
      setKind("personal");
      setAiMessage("");
      setAiDeliver(true);
      setColor("");
    }
    setError(null);
  }, [open, item, defaultStart]);

  const handleSave = async () => {
    setError(null);
    if (!title.trim()) {
      setError("请输入标题");
      return;
    }
    if (!startAt) {
      setError("请选择开始时间");
      return;
    }
    if (kind === "ai_task" && !aiMessage.trim()) {
      setError("AI 任务需要填写 AI 指令");
      return;
    }
    if (recurrence === "cron_expr" && !cronExpr.trim()) {
      setError("自定义重复需要填写 cron 表达式");
      return;
    }
    const startMs = fromDatetimeLocalValue(startAt);
    const endMs = endAt ? fromDatetimeLocalValue(endAt) : null;
    if (endMs != null && endMs < startMs) {
      setError("结束时间不能早于开始时间");
      return;
    }

    const input: ScheduleItemInput = {
      title: title.trim(),
      description: description.trim(),
      startAtMs: startMs,
      endAtMs: endMs,
      allDay,
      recurrence,
      cronExpr: recurrence === "cron_expr" ? cronExpr.trim() : null,
      tz: null,
      kind,
      aiMessage: kind === "ai_task" ? aiMessage.trim() : null,
      aiDeliver,
      color: color || null,
    };
    setSaving(true);
    try {
      await onSave(input);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!item || !onDelete) return;
    setSaving(true);
    try {
      await onDelete(item.id);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{item ? "编辑日程" : "新建日程"}</DialogTitle>
          <DialogDescription>
            管理个人提醒或 AI 自动化任务
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {/* Type selector */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setKind("personal")}
              className={cn(
                "flex-1 rounded-lg border px-3 py-2 text-sm transition-colors",
                kind === "personal"
                  ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                  : "border-input hover:bg-accent",
              )}
            >
              个人日程
            </button>
            <button
              type="button"
              onClick={() => setKind("ai_task")}
              className={cn(
                "flex-1 rounded-lg border px-3 py-2 text-sm transition-colors flex items-center justify-center gap-1.5",
                kind === "ai_task"
                  ? "border-purple-500 bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300"
                  : "border-input hover:bg-accent",
              )}
            >
              <Bot className="h-3.5 w-3.5" />
              AI 自动化任务
            </button>
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="sched-title">标题</Label>
            <Input
              id="sched-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="日程标题"
              className="rounded-lg"
            />
          </div>

          {/* Time */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>时间</Label>
              <button
                type="button"
                onClick={() => setAllDay(!allDay)}
                className={cn(
                  "text-xs px-2 py-0.5 rounded-full transition-colors",
                  allDay
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                全天
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type={allDay ? "date" : "datetime-local"}
                value={allDay ? startAt.slice(0, 10) : startAt}
                onChange={(e) => {
                  if (allDay) {
                    setStartAt(`${e.target.value}T00:00`);
                  } else {
                    setStartAt(e.target.value);
                  }
                }}
                className="rounded-lg flex-1"
              />
              {!allDay && (
                <>
                  <span className="text-muted-foreground text-sm">—</span>
                  <Input
                    type="datetime-local"
                    value={endAt}
                    onChange={(e) => setEndAt(e.target.value)}
                    className="rounded-lg flex-1"
                  />
                </>
              )}
            </div>
          </div>

          {/* Recurrence */}
          <div className="space-y-1.5">
            <Label>重复</Label>
            <div className="flex flex-wrap gap-1.5">
              {RECURRENCE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setRecurrence(opt.value)}
                  className={cn(
                    "px-2.5 py-1 rounded-full text-xs transition-colors",
                    recurrence === opt.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-accent text-accent-foreground hover:bg-accent/80",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {recurrence === "cron_expr" && (
              <Input
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="0 9 * * 1-5"
                className="rounded-lg mt-1.5 font-mono text-xs"
              />
            )}
          </div>

          {/* AI task fields */}
          {kind === "ai_task" && (
            <div className="space-y-1.5 rounded-lg border border-purple-200 dark:border-purple-900/50 bg-purple-50/50 dark:bg-purple-950/20 p-3">
              <Label htmlFor="sched-ai">AI 指令</Label>
              <Textarea
                id="sched-ai"
                value={aiMessage}
                onChange={(e) => setAiMessage(e.target.value)}
                placeholder="到时间让 AI 执行的指令，例如：检查邮箱并汇总未读邮件"
                className="rounded-lg min-h-[60px] text-[13px]"
              />
              <button
                type="button"
                onClick={() => setAiDeliver(!aiDeliver)}
                className={cn(
                  "text-xs px-2 py-1 rounded-full transition-colors",
                  aiDeliver
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {aiDeliver ? "✓ 执行后把结果发给我" : "执行后不通知"}
              </button>
            </div>
          )}

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="sched-desc">描述</Label>
            <Textarea
              id="sched-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="备注（可选）"
              className="rounded-lg min-h-[40px] text-[13px]"
            />
          </div>

          {/* Color */}
          <div className="space-y-1.5">
            <Label>颜色标签</Label>
            <div className="flex gap-1.5">
              {COLOR_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setColor(opt.value)}
                  className={cn(
                    "h-6 w-6 rounded-full transition-transform",
                    opt.className,
                    color === opt.value
                      ? "ring-2 ring-offset-2 ring-offset-background ring-foreground scale-110"
                      : "hover:scale-110",
                  )}
                  title={opt.label}
                />
              ))}
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter className="gap-2">
          {item && onDelete && (
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={saving}
              className="mr-auto"
            >
              删除
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
