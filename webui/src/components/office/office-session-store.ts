import { create } from "zustand";

import type { OfficeSessionState } from "./types";

interface OfficeSessionStore {
  sessions: Record<string, OfficeSessionState>;
  upsert: (session: OfficeSessionState) => void;
  remove: (sessionId: string) => void;
  clear: () => void;
}

export const useOfficeSessionStore = create<OfficeSessionStore>((set) => ({
  sessions: {},
  upsert: (session) => set((state) => ({
    sessions: { ...state.sessions, [session.sessionId]: session },
  })),
  remove: (sessionId) => set((state) => {
    const sessions = { ...state.sessions };
    delete sessions[sessionId];
    return { sessions };
  }),
  clear: () => set({ sessions: {} }),
}));
