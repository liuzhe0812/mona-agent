import type { LlmConfig, ProviderOverride } from "./types"
import { AZURE_OPENAI_API_VERSION } from "@/lib/azure-openai"
import type { LlmPreset } from "./llm-presets"

/**
 * Build a full LlmConfig from a preset template + the user's saved
 * override fields for that preset. Falls back to the preset defaults
 * (or the existing LlmConfig) when an override is missing.
 */
export function resolveConfig(
  preset: LlmPreset,
  override: ProviderOverride | undefined,
  fallback: LlmConfig,
): LlmConfig {
  const ov = override ?? {}
  const apiKey = ov.apiKey ?? ""
  const model = ov.model ?? preset.defaultModel ?? ""
  const maxContextSize =
    ov.maxContextSize ?? preset.suggestedContextSize ?? fallback.maxContextSize
  const reasoning = ov.reasoning ?? { mode: "auto" as const }

  if (preset.provider === "custom") {
    return {
      provider: "custom",
      apiKey,
      model,
      ollamaUrl: fallback.ollamaUrl,
      customEndpoint: ov.baseUrl ?? preset.baseUrl ?? "",
      maxContextSize,
      apiMode: ov.apiMode ?? preset.apiMode ?? "chat_completions",
      reasoning,
    }
  }

  if (preset.provider === "ollama") {
    return {
      provider: "ollama",
      apiKey: "",
      model,
      ollamaUrl: ov.baseUrl ?? preset.baseUrl ?? "http://localhost:11434",
      customEndpoint: fallback.customEndpoint,
      maxContextSize,
      reasoning,
    }
  }

  if (preset.provider === "azure") {
    return {
      provider: "azure",
      apiKey,
      model,
      ollamaUrl: fallback.ollamaUrl,
      customEndpoint: ov.baseUrl ?? preset.baseUrl ?? "",
      azureApiVersion: ov.azureApiVersion ?? preset.azureApiVersion ?? AZURE_OPENAI_API_VERSION,
      azureModelFamily: ov.azureModelFamily ?? preset.azureModelFamily ?? "auto",
      maxContextSize,
      reasoning,
    }
  }

  if (preset.provider === "claude-code" || preset.provider === "codex-cli") {
    return {
      provider: preset.provider,
      apiKey: "",
      model,
      ollamaUrl: fallback.ollamaUrl,
      customEndpoint: fallback.customEndpoint,
      maxContextSize,
      reasoning,
    }
  }

  // openai / anthropic / google / minimax
  return {
    provider: preset.provider,
    apiKey,
    model,
    ollamaUrl: fallback.ollamaUrl,
    customEndpoint: fallback.customEndpoint,
    maxContextSize,
    reasoning,
  }
}
