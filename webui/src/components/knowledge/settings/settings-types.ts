import type { CustomApiMode } from "./llm-presets"
import type { AzureModelFamily, CloseBehavior, ReasoningConfig, SourceWatchConfig } from "./types"

/**
 * Shape of the draft state each section reads from and writes into.
 * The parent (SettingsView) owns one instance and hands it to every
 * section; the Save button at the bottom flushes the whole draft to
 * stores + disk in one commit.
 */
export interface SettingsDraft {
  // LLM provider
  provider: "openai" | "anthropic" | "google" | "azure" | "ollama" | "custom" | "minimax" | "claude-code" | "codex-cli"
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion: string
  azureModelFamily: AzureModelFamily
  maxContextSize: number
  apiMode: CustomApiMode | undefined
  reasoning: ReasoningConfig | undefined

  // Multimodal (image captioning at ingest time)
  multimodalEnabled: boolean
  multimodalUseMainLlm: boolean
  multimodalProvider: "openai" | "anthropic" | "google" | "azure" | "ollama" | "custom" | "minimax" | "claude-code" | "codex-cli"
  multimodalApiKey: string
  multimodalModel: string
  multimodalOllamaUrl: string
  multimodalCustomEndpoint: string
  multimodalAzureApiVersion: string
  multimodalAzureModelFamily: AzureModelFamily
  multimodalApiMode: CustomApiMode | undefined
  multimodalConcurrency: number

  // Output preferences
  outputLanguage: string
  maxHistoryMessages: number

  // Network — global outbound HTTP proxy.
  proxyEnabled: boolean
  proxyUrl: string
  proxyBypassLocal: boolean

  // Scheduled Import
  scheduledImportEnabled: boolean
  scheduledImportPath: string
  scheduledImportInterval: number // minutes

  // UI
  uiLanguage: string
  theme: "light" | "dark" | "system"

  // General app behavior
  autostart: boolean
  closeBehavior: CloseBehavior

  // Source folder auto watch
  sourceWatchConfig: SourceWatchConfig

  // Local HTTP API server
  apiEnabled: boolean
  apiAllowUnauthenticated: boolean
  apiMcpEnabled: boolean
  apiToken: string
}

export type DraftSetter = <K extends keyof SettingsDraft>(
  key: K,
  value: SettingsDraft[K],
) => void
