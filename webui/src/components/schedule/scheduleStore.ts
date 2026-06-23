/** Schedule store — manages schedule items state and CRUD operations. */

import { create } from "zustand";
import {
  completeScheduleItem,
  createScheduleItem,
  listScheduleItems,
  removeScheduleItem,
  toggleScheduleItem,
  updateScheduleItem,
} from "./scheduleApi";
import type { ScheduleItem, ScheduleItemInput } from "./types";

interface ScheduleState {
  items: ScheduleItem[];
  loading: boolean;
  error: string | null;
  selectedDate: Date | null;

  loadItems: () => Promise<void>;
  setSelectedDate: (date: Date | null) => void;
  addItem: (input: ScheduleItemInput) => Promise<ScheduleItem>;
  editItem: (id: string, input: ScheduleItemInput) => Promise<ScheduleItem>;
  deleteItem: (id: string) => Promise<void>;
  completeItem: (id: string) => Promise<void>;
  toggleItem: (id: string, enabled: boolean) => Promise<void>;
}

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  items: [],
  loading: false,
  error: null,
  selectedDate: null,

  loadItems: async () => {
    set({ loading: true, error: null });
    try {
      const items = await listScheduleItems();
      items.sort((a, b) => a.startAtMs - b.startAtMs);
      set({ items, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setSelectedDate: (date) => set({ selectedDate: date }),

  addItem: async (input) => {
    const saved = await createScheduleItem(input);
    set({ items: [...get().items, saved].sort((a, b) => a.startAtMs - b.startAtMs) });
    return saved;
  },

  editItem: async (id, input) => {
    const saved = await updateScheduleItem(id, input);
    set({
      items: get()
        .items.map((it) => (it.id === id ? saved : it))
        .sort((a, b) => a.startAtMs - b.startAtMs),
    });
    return saved;
  },

  deleteItem: async (id) => {
    await removeScheduleItem(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },

  completeItem: async (id) => {
    await completeScheduleItem(id);
    set({
      items: get().items.map((it) =>
        it.id === id ? { ...it, done: true } : it,
      ),
    });
  },

  toggleItem: async (id, enabled) => {
    await toggleScheduleItem(id, enabled);
    set({
      items: get().items.map((it) => (it.id === id ? { ...it, enabled } : it)),
    });
  },
}));
