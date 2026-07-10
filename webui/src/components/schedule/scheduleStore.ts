/** Schedule store — manages schedule items state and CRUD operations. */

import { create } from "zustand";
import {
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
      // Gateway may still be starting up — retry once after a short delay.
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const items = await listScheduleItems();
        items.sort((a, b) => a.startAtMs - b.startAtMs);
        set({ items, loading: false });
      } catch (retryErr) {
        set({
          loading: false,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
      }
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
    const existing = get().items.find((it) => it.id === id);
    if (!existing) return;
    const saved = await updateScheduleItem(id, { ...existing, done: true });
    set({
      items: get()
        .items.map((it) => (it.id === id ? saved : it))
        .sort((a, b) => a.startAtMs - b.startAtMs),
    });
  },

  toggleItem: async (id, enabled) => {
    await toggleScheduleItem(id, enabled);
    set({
      items: get().items.map((it) => (it.id === id ? { ...it, enabled } : it)),
    });
  },
}));
