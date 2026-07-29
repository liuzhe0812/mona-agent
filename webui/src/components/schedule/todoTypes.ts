/** Todo types for the unified planning center. */

export type TodoState = "suggestion" | "open" | "done";
export type TodoBucket = "inbox" | "today" | "next" | "waiting" | "someday";
export type TodoPriority = "low" | "normal" | "high";
export type TodoSourceType = "manual" | "email" | "chat" | "note";

export interface TodoSourceLocator {
  accountId?: string;
  folder?: string;
  uid?: string;
  messageId?: string;
  sessionKey?: string;
  noteId?: string;
  line?: number;
  [key: string]: string | number | undefined;
}

export interface TodoSourceSnapshot {
  title?: string;
  evidence?: string;
  from?: string;
  [key: string]: string | undefined;
}

export interface TodoItem {
  id: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  state: TodoState;
  bucket: TodoBucket;
  notes: string;
  dueAtMs: number | null;
  priority: TodoPriority;
  focusRank: number | null;
  sourceType: TodoSourceType;
  sourceLocator: TodoSourceLocator;
  sourceSnapshot: TodoSourceSnapshot;
  confidence: number | null;
  scheduleId: string | null;
  completedAtMs: number | null;
}

export interface TodoItemInput {
  title: string;
  state?: TodoState;
  bucket?: TodoBucket;
  notes?: string;
  dueAtMs?: number | null;
  priority?: TodoPriority;
  focusRank?: number | null;
  sourceType?: TodoSourceType;
  sourceLocator?: TodoSourceLocator;
  sourceSnapshot?: TodoSourceSnapshot;
  confidence?: number | null;
}

export interface TodoItemListResponse {
  items: TodoItem[];
}

export interface TodoBriefing {
  confirmed: TodoItem[];
  recommendations: TodoItem[];
  top3: TodoItem[];
  overdueCount: number;
  dueTodayCount: number;
  suggestionCount: number;
}

export interface TodoFromEmailInput {
  accountId: string;
  folder: string;
  uid: string;
  title?: string;
}
