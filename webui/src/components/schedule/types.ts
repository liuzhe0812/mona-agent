/** Schedule item types — mirror mona/schedule/types.py (camelCase over the wire). */

export type ScheduleKind = "personal" | "ai_task";
export type ScheduleRecurrence = "none" | "daily" | "weekly" | "monthly" | "cron_expr";
export type ScheduleLastStatus = "ok" | "error" | "skipped";

/** dataTransfer MIME used when dragging an unscheduled todo onto the calendar. */
export const TODO_DRAG_MIME = "application/x-mona-todo-id";

export interface ScheduleItem {
  id: string;
  title: string;
  description: string;
  startAtMs: number;
  endAtMs: number | null;
  allDay: boolean;
  recurrence: ScheduleRecurrence;
  cronExpr: string | null;
  tz: string | null;
  kind: ScheduleKind;
  aiMessage: string | null;
  aiDeliver: boolean;
  done: boolean;
  enabled: boolean;
  color: string | null;
  sourceModule: string | null;
  sourceChatId: string | null;
  lastRunAtMs: number | null;
  nextRunAtMs: number | null;
  lastStatus: ScheduleLastStatus | null;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ScheduleItemListResponse {
  items: ScheduleItem[];
}

/** Payload for create/update — omit server-managed fields. */
export interface ScheduleItemInput {
  id?: string;
  title: string;
  description?: string;
  startAtMs: number;
  endAtMs?: number | null;
  allDay?: boolean;
  recurrence?: ScheduleRecurrence;
  cronExpr?: string | null;
  tz?: string | null;
  kind?: ScheduleKind;
  aiMessage?: string | null;
  aiDeliver?: boolean;
  done?: boolean;
  enabled?: boolean;
  color?: string | null;
  sourceModule?: string | null;
  sourceChatId?: string | null;
}

export function emptyScheduleItemInput(): ScheduleItemInput {
  return {
    title: "",
    description: "",
    startAtMs: Date.now(),
    endAtMs: null,
    allDay: false,
    recurrence: "none",
    cronExpr: null,
    tz: null,
    kind: "personal",
    aiMessage: null,
    aiDeliver: true,
    done: false,
    enabled: true,
    color: null,
  };
}
