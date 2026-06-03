import { create } from "zustand"
import type { WikiProject, FileNode } from "@/types/wiki"

export type CustomApiMode = "chat_completions" | "anthropic_messages"
export type AzureModelFamily = "auto" | "gpt5"
export type ReasoningMode = "auto" | "off" | "low" | "medium" | "high" | "max" | "custom"

export interface ReasoningConfig {
  mode: ReasoningMode
  budgetTokens?: number
}

export interface LlmConfig {
  provider: "openai" | "anthropic" | "google" | "azure" | "ollama" | "custom" | "minimax"
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  maxContextSize: number
  apiMode?: CustomApiMode
  reasoning?: ReasoningConfig
}

export type OutputLanguage =
  | "auto"
  | "English"
  | "Chinese"
  | "Traditional Chinese"
  | "Japanese"
  | "Korean"
  | "Vietnamese"
  | "French"
  | "German"
  | "Spanish"
  | "Portuguese"
  | "Italian"
  | "Russian"
  | "Arabic"
  | "Persian"
  | "Hindi"
  | "Turkish"
  | "Dutch"
  | "Polish"
  | "Swedish"
  | "Indonesian"
  | "Thai"
  | "Ukrainian"

export interface ExternalPreview {
  title: string
  path: string
  source: string
  url: string
  snippet: string
}

export interface MultimodalConfig {
  enabled: boolean
  useMainLlm: boolean
  provider: LlmConfig["provider"]
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  apiMode?: CustomApiMode
  concurrency: number
}

interface WikiState {
  project: WikiProject | null
  fileTree: FileNode[]
  selectedFile: string | null
  fileContent: string
  externalPreview: ExternalPreview | null
  pendingScrollImageSrc: string | null
  chatExpanded: boolean
  activeView: "wiki" | "sources" | "search" | "graph" | "lint" | "review" | "settings"
  llmConfig: LlmConfig
  multimodalConfig: MultimodalConfig
  embeddingConfig: { enabled: boolean; endpoint: string; apiKey: string; model: string }
  outputLanguage: OutputLanguage
  dataVersion: number

  setProject: (project: WikiProject | null) => void
  setFileTree: (tree: FileNode[]) => void
  setSelectedFile: (path: string | null) => void
  setFileContent: (content: string) => void
  setExternalPreview: (preview: ExternalPreview | null) => void
  setPendingScrollImageSrc: (src: string | null) => void
  setChatExpanded: (expanded: boolean) => void
  setActiveView: (view: WikiState["activeView"]) => void
  setLlmConfig: (config: LlmConfig) => void
  setOutputLanguage: (lang: OutputLanguage) => void
  bumpDataVersion: () => void
}

export const useWikiStore = create<WikiState>((set) => ({
  project: null,
  fileTree: [],
  selectedFile: null,
  fileContent: "",
  externalPreview: null,
  pendingScrollImageSrc: null,
  chatExpanded: false,
  activeView: "wiki",
  llmConfig: {
    provider: "openai",
    apiKey: "",
    maxContextSize: 204800,
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    azureApiVersion: "2024-10-21",
    reasoning: { mode: "auto" },
  },
  multimodalConfig: {
    enabled: false,
    useMainLlm: true,
    provider: "custom",
    apiKey: "",
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    azureApiVersion: "2024-10-21",
    apiMode: "chat_completions",
    concurrency: 4,
  },
  embeddingConfig: {
    enabled: false,
    endpoint: "",
    apiKey: "",
    model: "",
  },
  outputLanguage: "auto",
  dataVersion: 0,
  setProject: (project) => set({ project }),
  setFileTree: (fileTree) => set({ fileTree }),
  setSelectedFile: (selectedFile) => set({ selectedFile, externalPreview: null }),
  setFileContent: (fileContent) => set({ fileContent }),
  setExternalPreview: (externalPreview) => set({ externalPreview }),
  setPendingScrollImageSrc: (pendingScrollImageSrc) => set({ pendingScrollImageSrc }),
  setChatExpanded: (chatExpanded) => set({ chatExpanded }),
  setActiveView: (activeView) => set({ activeView }),
  setLlmConfig: (llmConfig) => set({ llmConfig }),
  setOutputLanguage: (outputLanguage) => set({ outputLanguage }),
  bumpDataVersion: () => set((state) => ({ dataVersion: state.dataVersion + 1 })),
}))

export type { WikiState }
