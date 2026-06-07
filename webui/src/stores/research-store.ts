import { create } from "zustand"

/** Stub: research store — to be implemented */

interface ResearchState {
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
}

export const useResearchStore = create<ResearchState>((set) => ({
  panelOpen: false,
  setPanelOpen: (open: boolean) => set({ panelOpen: open }),
}))
