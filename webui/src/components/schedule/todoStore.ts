/** Todo store — manages todo items state and CRUD operations. */

import { create } from "zustand";
import {
  createTodo,
  createTodoFromEmail,
  getBriefing,
  listTodos,
  removeTodo,
  updateTodo,
} from "./todoApi";
import {
  listPendingSchedules,
  type PendingScheduleItem,
} from "./scheduleApi";
import type {
  TodoBriefing,
  TodoFromEmailInput,
  TodoItem,
  TodoItemInput,
} from "./todoTypes";

interface TodoStoreState {
  items: TodoItem[];
  pendingSchedules: PendingScheduleItem[];
  loading: boolean;
  error: string | null;
  briefing: TodoBriefing | null;
  /** 收集箱数量 = 待确认建议 + 未分类待办 + 待确认邮件日程 */
  inboxCount: number;

  loadAll: () => Promise<void>;
  loadPendingSchedules: () => Promise<void>;
  loadBriefing: () => Promise<void>;
  addItem: (input: TodoItemInput) => Promise<TodoItem>;
  addFromEmail: (input: TodoFromEmailInput) => Promise<TodoItem>;
  editItem: (id: string, patch: Record<string, unknown>) => Promise<TodoItem>;
  deleteItem: (id: string) => Promise<void>;
  completeItem: (id: string) => Promise<void>;
  confirmSuggestion: (id: string) => Promise<TodoItem>;
  discardSuggestion: (id: string) => Promise<void>;
  moveItem: (id: string, bucket: TodoItem["bucket"]) => Promise<TodoItem>;
  setFocusRank: (id: string, rank: number | null) => Promise<TodoItem>;
  confirmPendingSchedule: (id: string) => Promise<void>;
  discardPendingSchedule: (id: string) => Promise<void>;
}

function _computeInboxCount(
  items: TodoItem[],
  pendingSchedules: PendingScheduleItem[],
): number {
  const suggestions = items.filter((it) => it.state === "suggestion").length;
  const inboxItems = items.filter(
    (it) => it.state === "open" && it.bucket === "inbox",
  ).length;
  return suggestions + inboxItems + pendingSchedules.length;
}

export const useTodoStore = create<TodoStoreState>((set, get) => ({
  items: [],
  pendingSchedules: [],
  loading: false,
  error: null,
  briefing: null,
  inboxCount: 0,

  loadAll: async () => {
    set({ loading: true, error: null });
    try {
      const items = await listTodos();
      items.sort((a, b) => a.createdAtMs - b.createdAtMs);
      const inboxCount = _computeInboxCount(items, get().pendingSchedules);
      set({ items, loading: false, inboxCount });
    } catch (err) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const items = await listTodos();
        items.sort((a, b) => a.createdAtMs - b.createdAtMs);
        const inboxCount = _computeInboxCount(items, get().pendingSchedules);
        set({ items, loading: false, inboxCount });
      } catch (retryErr) {
        set({
          loading: false,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
      }
    }
  },

  loadPendingSchedules: async () => {
    try {
      const pendingSchedules = await listPendingSchedules();
      const inboxCount = _computeInboxCount(get().items, pendingSchedules);
      set({ pendingSchedules, inboxCount });
    } catch {
      // silent
    }
  },

  loadBriefing: async () => {
    try {
      const briefing = await getBriefing();
      set({ briefing });
    } catch {
      // silent — briefing is non-critical
    }
  },

  addItem: async (input) => {
    const saved = await createTodo(input);
    const items = [saved, ...get().items];
    const inboxCount = _computeInboxCount(items, get().pendingSchedules);
    set({ items, inboxCount });
    return saved;
  },

  addFromEmail: async (input) => {
    const saved = await createTodoFromEmail(input);
    const items = [saved, ...get().items];
    const inboxCount = _computeInboxCount(items, get().pendingSchedules);
    set({ items, inboxCount });
    return saved;
  },

  editItem: async (id, patch) => {
    const saved = await updateTodo(id, patch);
    const items = get().items.map((it) => (it.id === id ? saved : it));
    const inboxCount = _computeInboxCount(items, get().pendingSchedules);
    set({ items, inboxCount });
    return saved;
  },

  deleteItem: async (id) => {
    await removeTodo(id);
    const items = get().items.filter((it) => it.id !== id);
    const inboxCount = _computeInboxCount(items, get().pendingSchedules);
    set({ items, inboxCount });
  },

  completeItem: async (id) => {
    const saved = await updateTodo(id, { state: "done" });
    const items = get().items.map((it) => (it.id === id ? saved : it));
    const inboxCount = _computeInboxCount(items, get().pendingSchedules);
    set({ items, inboxCount });
  },

  confirmSuggestion: async (id) => {
    const saved = await updateTodo(id, { state: "open", bucket: "inbox" });
    const items = get().items.map((it) => (it.id === id ? saved : it));
    const inboxCount = _computeInboxCount(items, get().pendingSchedules);
    set({ items, inboxCount });
    return saved;
  },

  discardSuggestion: async (id) => {
    await removeTodo(id);
    const items = get().items.filter((it) => it.id !== id);
    const inboxCount = _computeInboxCount(items, get().pendingSchedules);
    set({ items, inboxCount });
  },

  moveItem: async (id, bucket) => {
    const saved = await updateTodo(id, { bucket });
    const items = get().items.map((it) => (it.id === id ? saved : it));
    const inboxCount = _computeInboxCount(items, get().pendingSchedules);
    set({ items, inboxCount });
    return saved;
  },

  setFocusRank: async (id, rank) => {
    const saved = await updateTodo(id, { focusRank: rank });
    const items = get().items.map((it) => (it.id === id ? saved : it));
    const inboxCount = _computeInboxCount(items, get().pendingSchedules);
    set({ items, inboxCount });
    return saved;
  },

  confirmPendingSchedule: async (id) => {
    const { confirmPendingSchedule: confirmApi } = await import("./scheduleApi");
    const result = await confirmApi(id);
    if (result.ok) {
      const pendingSchedules = get().pendingSchedules.filter((p) => p.id !== id);
      const inboxCount = _computeInboxCount(get().items, pendingSchedules);
      set({ pendingSchedules, inboxCount });
      // 触发 scheduleStore 刷新，让新日程立即出现在日历视图
      try {
        const { useScheduleStore } = await import("./scheduleStore");
        await useScheduleStore.getState().loadItems();
      } catch {
        // silent — 刷新失败不影响收集箱一致性
      }
    }
  },

  discardPendingSchedule: async (id) => {
    const { discardPendingSchedule: discardApi } = await import("./scheduleApi");
    const result = await discardApi(id);
    if (result.ok) {
      const pendingSchedules = get().pendingSchedules.filter((p) => p.id !== id);
      const inboxCount = _computeInboxCount(get().items, pendingSchedules);
      set({ pendingSchedules, inboxCount });
    }
  },
}));
