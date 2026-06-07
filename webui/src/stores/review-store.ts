import { create } from "zustand"
import type { ReviewOption } from "@/lib/review-parser"

export interface ReviewItem {
  id: string
  type: "contradiction" | "duplicate" | "missing-page" | "suggestion" | "confirm"
  title: string
  description: string
  sourcePath?: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: ReviewOption[]
  resolved: boolean
  resolvedAction?: string
  createdAt: number
}

interface ReviewState {
  items: ReviewItem[]
  addItems: (items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]) => void
  setItems: (items: ReviewItem[]) => void
  resolveItem: (id: string, action: string) => void
  dismissItem: (id: string) => void
  clearResolved: () => void
  clearAll: () => void
}

let counter = 0

export const useReviewStore = create<ReviewState>()((set) => ({
  items: [],

  addItems: (newItems) =>
    set((state) => ({
      items: [
        ...state.items,
        ...newItems.map((item) => ({
          ...item,
          id: `review-${++counter}`,
          resolved: false,
          createdAt: Date.now(),
        })),
      ],
    })),

  setItems: (items) => set({ items }),

  resolveItem: (id, action) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, resolved: true, resolvedAction: action } : item,
      ),
    })),

  dismissItem: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    })),

  clearResolved: () =>
    set((state) => ({
      items: state.items.filter((item) => !item.resolved),
    })),

  clearAll: () => set({ items: [] }),
}))
