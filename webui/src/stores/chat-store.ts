/**
 * Minimal chat store stub for the knowledge base module.
 * The full chat integration is handled by Mona's existing chat system.
 * This stub provides the interface that ingest.ts expects for interactive ingest.
 */
import { create } from "zustand"

interface ChatMessage {
  role: string
  content: string
}

interface ChatState {
  messages: ChatMessage[]
  ingestSource: string | null
  appendStreamToken: (token: string) => void
  finalizeStream: (content: string) => void
  addMessage: (role: string, content: string) => void
  setMode: (mode: string) => void
  setIngestSource: (source: string | null) => void
  clearMessages: () => void
  setStreaming: (streaming: boolean) => void
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  ingestSource: null,
  appendStreamToken: (_token: string) => {},
  finalizeStream: (_content: string) => {},
  addMessage: (role: string, content: string) =>
    set((state) => ({ messages: [...state.messages, { role, content }] })),
  setMode: (_mode: string) => {},
  setIngestSource: (source: string | null) => set({ ingestSource: source }),
  clearMessages: () => set({ messages: [] }),
  setStreaming: (_streaming: boolean) => {},
}))
