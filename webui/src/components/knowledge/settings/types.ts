/**
 * Local type definitions previously imported from @/stores/wiki-store.
 * The wiki-store module has been removed; these types are kept here
 * so the settings components can still compile.
 */

export type AzureModelFamily = "auto" | "gpt-4" | "gpt-4o" | "o1" | "o3" | "gpt-5"

export type CloseBehavior = "close" | "minimize" | "ask"

export interface ReasoningConfig {
  mode: "auto" | "on" | "off"
  effort?: "low" | "medium" | "high"
  maxTokens?: number
}

export interface SourceWatchConfig {
  enabled: boolean
  path: string
  interval: number
}

export interface LlmConfig {
  provider: string
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  maxContextSize: number
  apiMode?: string
  reasoning: ReasoningConfig
}

export interface ProviderOverride {
  apiKey?: string
  model?: string
  baseUrl?: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  maxContextSize?: number
  apiMode?: string
  reasoning?: ReasoningConfig
}
