import type { AzureModelFamily } from "./types"

/**
 * Curated LLM provider presets.
 *
 * Selecting a preset pre-fills the underlying LlmConfig fields so users
 * don't have to remember endpoint URLs / API mode per vendor.
 */
export type CustomApiMode = "chat_completions" | "anthropic_messages"

export type Provider =
  | "openai"
  | "anthropic"
  | "google"
  | "azure"
  | "ollama"
  | "custom"
  | "minimax"
  | "claude-code"
  | "codex-cli"

export interface LlmPreset {
  /** Stable id used as the dropdown value. */
  id: string
  /** Display label in the dropdown. */
  label: string
  /** Short subtitle shown under the label. */
  hint?: string
  /** Underlying provider dispatch key (see llm-providers.ts). */
  provider: Provider
  /** Suggested base URL. */
  baseUrl?: string
  /**
   * For vendors that serve the same model catalog over both an OpenAI-
   * compatible and an Anthropic-compatible endpoint at different URLs,
   * list the URL per wire mode.
   */
  baseUrlByMode?: Partial<Record<CustomApiMode, string>>
  /** Suggested default model; user can override. */
  defaultModel?: string
  /** Azure OpenAI api-version query parameter. */
  azureApiVersion?: string
  /** Azure deployment names are arbitrary, so users can declare GPT-5/o-series behavior explicitly. */
  azureModelFamily?: AzureModelFamily
  /**
   * Curated list of model ids the UI shows as clickable chips above the
   * Model input.
   */
  suggestedModels?: string[]
  /** Custom providers only: which wire protocol to speak. */
  apiMode?: CustomApiMode
  /** Suggested context window; user can override. */
  suggestedContextSize?: number
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    hint: "Official Claude API",
    provider: "anthropic",
    defaultModel: "claude-sonnet-4-5-20250929",
    suggestedModels: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-20250514",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
    suggestedContextSize: 200000,
  },
  {
    id: "claude-code-cli",
    label: "Claude Code CLI (local)",
    hint: "Uses the local `claude` binary — no API key needed",
    provider: "claude-code",
    defaultModel: "claude-sonnet-4-6",
    suggestedModels: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
    ],
    suggestedContextSize: 200000,
  },
  {
    id: "codex-cli",
    label: "Codex CLI (local)",
    hint: "Uses the local `codex` binary — no API key needed",
    provider: "codex-cli",
    defaultModel: "gpt-5.4-mini",
    suggestedModels: [
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2",
    ],
    suggestedContextSize: 200000,
  },
  {
    id: "openai",
    label: "OpenAI (GPT)",
    hint: "Official OpenAI API",
    provider: "openai",
    defaultModel: "gpt-4o",
    suggestedModels: [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "o3",
      "o3-mini",
      "o1",
      "o1-mini",
      "gpt-4-turbo",
    ],
    suggestedContextSize: 128000,
  },
  {
    id: "google",
    label: "Google (Gemini)",
    hint: "Generative Language API",
    provider: "google",
    defaultModel: "gemini-2.5-flash",
    suggestedModels: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ],
    suggestedContextSize: 1000000,
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    hint: "Azure OpenAI resource endpoint; Model field is the deployment name",
    provider: "azure",
    baseUrl: "https://your-resource.openai.azure.com",
    defaultModel: "your-deployment-name",
    azureApiVersion: "2024-10-21",
    suggestedContextSize: 128000,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    hint: "api.deepseek.com",
    provider: "custom",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4-flash",
    apiMode: "chat_completions",
    suggestedModels: [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
    ],
    suggestedContextSize: 64000,
  },
  {
    id: "groq",
    label: "Groq",
    hint: "api.groq.com",
    provider: "custom",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    apiMode: "chat_completions",
    suggestedModels: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "llama-3.1-70b-versatile",
      "mixtral-8x7b-32768",
      "gemma2-9b-it",
      "moonshotai/kimi-k2-instruct",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3-32b",
    ],
    suggestedContextSize: 128000,
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    hint: "api.x.ai",
    provider: "custom",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-3",
    apiMode: "chat_completions",
    suggestedModels: [
      "grok-4-latest",
      "grok-4",
      "grok-3",
      "grok-3-mini",
      "grok-3-fast",
      "grok-3-mini-fast",
      "grok-code-fast-1",
      "grok-2-vision-1212",
    ],
    suggestedContextSize: 131072,
  },
  {
    id: "ollama-local",
    label: "Ollama (Local)",
    hint: "Self-hosted llama.cpp / Ollama",
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    suggestedContextSize: 32768,
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    hint: "ollama.com",
    provider: "custom",
    baseUrl: "https://ollama.com/v1",
    apiMode: "chat_completions",
    suggestedModels: [
      "gpt-oss:120b",
      "gpt-oss:20b",
      "qwen3-coder:480b",
      "kimi-k2:1t",
      "deepseek-v3.1:671b",
    ],
    suggestedContextSize: 128000,
  },
  {
    id: "custom",
    label: "Custom",
    hint: "Any OpenAI- or Anthropic-compatible endpoint",
    provider: "custom",
    apiMode: "chat_completions",
    suggestedContextSize: 128000,
  },
]
