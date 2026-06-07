import { create } from "zustand"
import type { LintResult } from "@/lib/lint"

interface LintState {
  results: LintResult[]
  running: boolean
  setResults: (results: LintResult[]) => void
  setRunning: (running: boolean) => void
  clear: () => void
}

export const useLintStore = create<LintState>()((set) => ({
  results: [],
  running: false,
  setResults: (results) => set({ results }),
  setRunning: (running) => set({ running }),
  clear: () => set({ results: [], running: false }),
}))
