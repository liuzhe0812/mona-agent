/**
 * Chat store for the knowledge base module.
 * Supports conversations, streaming, and message history.
 */
import { create } from "zustand"
import type { ChatMessage as LLMMessage } from "@/lib/llm-client"

export interface MessageReference {
  title: string
  path: string
  kind?: "wiki" | "external"
  source?: string
  url?: string
  snippet?: string
}

export interface DisplayMessage {
  id: string
  conversationId: string
  role: "user" | "assistant" | "system"
  content: string
  references?: MessageReference[]
  createdAt: number
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingContent: string
  mode: "chat" | "ingest"
  maxHistoryMessages: number
  ingestSource: string | null

  createConversation: () => string
  deleteConversation: (id: string) => void
  setActiveConversation: (id: string) => void
  addMessage: (role: string, content: string) => void
  setStreaming: (streaming: boolean) => void
  appendStreamToken: (token: string) => void
  finalizeStream: (content: string, references?: MessageReference[]) => void
  removeLastAssistantMessage: () => void
  getActiveMessages: () => DisplayMessage[]
  setMode: (mode: string) => void
  setIngestSource: (source: string | null) => void
  clearMessages: () => void
}

let counter = 0

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  isStreaming: false,
  streamingContent: "",
  mode: "chat",
  maxHistoryMessages: 40,
  ingestSource: null,

  createConversation: () => {
    const id = `conv-${++counter}`
    const now = Date.now()
    set((state) => ({
      conversations: [
        ...state.conversations,
        { id, title: `Chat ${state.conversations.length + 1}`, createdAt: now, updatedAt: now },
      ],
      activeConversationId: id,
    }))
    return id
  },

  deleteConversation: (id) =>
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      messages: state.messages.filter((m) => m.conversationId !== id),
      activeConversationId:
        state.activeConversationId === id ? null : state.activeConversationId,
    })),

  setActiveConversation: (id) => set({ activeConversationId: id }),

  addMessage: (role, content) => {
    const convId = get().activeConversationId
    if (!convId) return
    const id = `msg-${++counter}`
    set((state) => ({
      messages: [
        ...state.messages,
        { id, conversationId: convId, role: role as DisplayMessage["role"], content, createdAt: Date.now() },
      ],
      conversations: state.conversations.map((c) =>
        c.id === convId ? { ...c, updatedAt: Date.now() } : c,
      ),
    }))
  },

  setStreaming: (streaming) => set({ isStreaming: streaming, streamingContent: "" }),

  appendStreamToken: (token) =>
    set((state) => ({ streamingContent: state.streamingContent + token })),

  finalizeStream: (content, references) => {
    const convId = get().activeConversationId
    if (!convId) return
    const id = `msg-${++counter}`
    set((state) => ({
      isStreaming: false,
      streamingContent: "",
      messages: [
        ...state.messages,
        {
          id,
          conversationId: convId,
          role: "assistant",
          content,
          references,
          createdAt: Date.now(),
        },
      ],
      conversations: state.conversations.map((c) =>
        c.id === convId ? { ...c, updatedAt: Date.now() } : c,
      ),
    }))
  },

  removeLastAssistantMessage: () =>
    set((state) => {
      const activeId = state.activeConversationId
      if (!activeId) return state
      const activeMsgs = state.messages.filter((m) => m.conversationId === activeId)
      const lastIdx = [...activeMsgs].reverse().findIndex((m: DisplayMessage) => m.role === "assistant")
      const realIdx = lastIdx === -1 ? -1 : activeMsgs.length - 1 - lastIdx
      if (realIdx === -1) return state
      const targetId = activeMsgs[realIdx].id
      return { messages: state.messages.filter((m) => m.id !== targetId) }
    }),

  getActiveMessages: () => {
    const state = get()
    if (!state.activeConversationId) return []
    return state.messages.filter((m) => m.conversationId === state.activeConversationId)
  },

  setMode: (mode) => set({ mode: mode as ChatState["mode"] }),
  setIngestSource: (source) => set({ ingestSource: source }),
  clearMessages: () => set({ messages: [] }),
}))

export function chatMessagesToLLM(messages: DisplayMessage[]): LLMMessage[] {
  return messages.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }))
}
