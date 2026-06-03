import type { LlmConfig, ReasoningConfig } from "@/stores/wiki-store"
import {
  AZURE_OPENAI_API_VERSION,
  buildAzureOpenAiUrl,
  isAzureOpenAiEndpoint,
} from "@/lib/azure-openai"

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string }

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string | ContentBlock[]
}

export interface RequestOverrides {
  temperature?: number
  top_p?: number
  top_k?: number
  max_tokens?: number
  stop?: string | string[]
  reasoning?: ReasoningConfig
}

interface ProviderConfig {
  url: string
  headers: Record<string, string>
  buildBody: (messages: ChatMessage[], overrides?: RequestOverrides) => unknown
  parseStream: (line: string) => string | null
}

const JSON_CONTENT_TYPE = "application/json"

function localLlmOriginHeader(): Record<string, string> {
  return { Origin: "http://localhost" }
}

function parseOpenAiLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  if (data === "[DONE]") return null
  try {
    const parsed = JSON.parse(data) as {
      choices: Array<{ delta: { content?: string } }>
    }
    return parsed.choices?.[0]?.delta?.content ?? null
  } catch {
    return null
  }
}

function parseAnthropicLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      type: string
      delta?: { type: string; text?: string }
    }
    if (
      parsed.type === "content_block_delta" &&
      parsed.delta?.type === "text_delta"
    ) {
      return parsed.delta.text ?? null
    }
    return null
  } catch {
    return null
  }
}

export function parseGoogleLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      candidates: Array<{
        content: { parts: Array<{ text?: string; thought?: boolean }> }
      }>
    }
    const parts = parsed.candidates?.[0]?.content?.parts
    if (!parts || parts.length === 0) return null
    let out = ""
    for (const p of parts) {
      if (p.thought) continue
      if (p.text) out += p.text
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

function toOpenAiContent(content: string | ContentBlock[]): unknown {
  if (typeof content === "string") return content
  if (content.every((b) => b.type === "text")) {
    return content.map((b) => (b.type === "text" ? b.text : "")).join("")
  }
  return content.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text }
    return {
      type: "image_url",
      image_url: { url: `data:${b.mediaType};base64,${b.dataBase64}` },
    }
  })
}

function buildOpenAiBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const translated = messages.map((m) => ({
    role: m.role,
    content: toOpenAiContent(m.content),
  }))
  return { messages: translated, stream: true, ...stripWireAgnosticOverrides(overrides) }
}

function stripWireAgnosticOverrides(overrides?: RequestOverrides): Omit<RequestOverrides, "reasoning"> {
  const { reasoning: _reasoning, ...rest } = overrides ?? {}
  return rest
}

function effectiveReasoning(config: LlmConfig, overrides?: RequestOverrides): ReasoningConfig {
  return overrides?.reasoning ?? config.reasoning ?? { mode: "auto" }
}

function isDeepSeekEndpoint(config: LlmConfig): boolean {
  return /deepseek/i.test(config.model) || /deepseek/i.test(config.customEndpoint)
}

function isQwenThinkingModel(model: string): boolean {
  return /qwen[-_]?3/i.test(model)
}

function isKimiEndpoint(config: LlmConfig): boolean {
  return /(^|[/:.-])kimi([/:.-]|$)/i.test(config.model)
    || /moonshot/i.test(config.model)
    || /api\.moonshot\.(ai|cn)/i.test(config.customEndpoint)
}

function isXiaomiMimoEndpoint(config: LlmConfig): boolean {
  return /(^|[/:.-])mimo([/:.-]|$)/i.test(config.model)
    || /\.?xiaomimimo\.com(?::|\/|$)/i.test(config.customEndpoint)
}

function isOpenAiStrictCompletionModel(config: LlmConfig): boolean {
  if ((config.provider === "azure" || (config.provider === "custom" && isAzureOpenAiEndpoint(config.customEndpoint)))
    && config.azureModelFamily === "gpt5") {
    return true
  }
  const model = config.model.trim().toLowerCase()
  const strictModel =
    /^gpt-5(?:[.\-_]|$)/.test(model) || /^o\d+(?:[.\-_]|$)/.test(model)
  if (!strictModel) return false
  if (config.provider === "openai" || config.provider === "azure") return true
  return config.provider === "custom" && isAzureOpenAiEndpoint(config.customEndpoint)
}

function adaptOpenAiStrictCompletionBody(config: LlmConfig, body: Record<string, unknown>): void {
  if (!isOpenAiStrictCompletionModel(config)) return
  if (typeof body.max_tokens === "number") {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
  }
  delete body.temperature
  delete body.top_p
  delete body.top_k
}

function adaptKimiBody(config: LlmConfig, body: Record<string, unknown>): void {
  if (!isKimiEndpoint(config)) return
  delete body.temperature
}

function adaptXiaomiMimoBody(
  config: LlmConfig,
  body: Record<string, unknown>,
  reasoning: ReasoningConfig,
): void {
  if (!isXiaomiMimoEndpoint(config)) return
  if (typeof body.max_tokens === "number") {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
  }
  if (reasoning.mode === "off") {
    body.thinking = { type: "disabled" }
  } else {
    delete body.temperature
  }
}

function buildOpenAiCompatibleBody(
  config: LlmConfig,
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const reasoning = effectiveReasoning(config, overrides)
  const body: Record<string, unknown> = buildOpenAiBody(messages, stripWireAgnosticOverrides(overrides))
  adaptOpenAiStrictCompletionBody(config, body)
  adaptKimiBody(config, body)
  adaptXiaomiMimoBody(config, body, reasoning)

  if (isDeepSeekEndpoint(config)) {
    if (reasoning.mode === "off") {
      body.thinking = { type: "disabled" }
    } else if (reasoning.mode !== "auto") {
      body.thinking = { type: "enabled" }
      if (reasoning.mode === "high" || reasoning.mode === "max") {
        body.reasoning_effort = reasoning.mode
      }
    }
    return body
  }

  if (reasoning.mode === "off" && isQwenThinkingModel(config.model)) {
    body.chat_template_kwargs = { enable_thinking: false }
  }

  if (config.provider === "openai" && reasoning.mode !== "auto" && reasoning.mode !== "off") {
    if (reasoning.mode === "low" || reasoning.mode === "medium" || reasoning.mode === "high") {
      body.reasoning_effort = reasoning.mode
    }
  }

  return body
}

function toAnthropicContent(content: string | ContentBlock[]): unknown {
  if (typeof content === "string") return content
  if (content.every((b) => b.type === "text")) {
    return content.map((b) => (b.type === "text" ? b.text : "")).join("")
  }
  return content.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: b.mediaType,
        data: b.dataBase64,
      },
    }
  })
}

function flattenAnthropicSystem(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
}

function buildAnthropicBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system")
  const conversationMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }))
  const system =
    systemMessages.map((m) => flattenAnthropicSystem(m.content)).join("\n") ||
    undefined

  return {
    messages: conversationMessages,
    ...(system !== undefined ? { system } : {}),
    stream: true,
    max_tokens: overrides?.max_tokens ?? 4096,
    ...(overrides?.temperature !== undefined ? { temperature: overrides.temperature } : {}),
    ...(overrides?.top_p !== undefined ? { top_p: overrides.top_p } : {}),
    ...(overrides?.top_k !== undefined ? { top_k: overrides.top_k } : {}),
    ...(overrides?.stop !== undefined
      ? { stop_sequences: Array.isArray(overrides.stop) ? overrides.stop : [overrides.stop] }
      : {}),
  }
}

function buildAnthropicBodyWithReasoning(
  config: LlmConfig,
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const body = buildAnthropicBody(messages, overrides)
  const reasoning = effectiveReasoning(config, overrides)
  if (reasoning.mode === "auto" || reasoning.mode === "off") return body

  const budget =
    reasoning.mode === "custom" && reasoning.budgetTokens !== undefined
      ? reasoning.budgetTokens
      : reasoning.mode === "low"
        ? 1024
        : reasoning.mode === "medium"
          ? 4096
        : 8192
  const budgetTokens = Math.max(1024, budget)
  if ((body.max_tokens as number) <= budgetTokens) {
    body.max_tokens = budgetTokens + 1
  }
  body.thinking = { type: "enabled", budget_tokens: budgetTokens }
  delete body.temperature
  delete body.top_p
  delete body.top_k
  return body
}

function requiresBearerAuth(url: string): boolean {
  const normalized = url.toLowerCase().replace(/\/+$/, "")
  return (
    normalized.startsWith("https://api.minimax.io/anthropic") ||
    normalized.startsWith("https://api.minimaxi.com/anthropic") ||
    normalized.startsWith("https://coding.dashscope.aliyuncs.com/apps/anthropic") ||
    /(^https:\/\/|^)token-plan-cn\.xiaomimimo\.com\/anthropic(?:\/|$)/i.test(normalized)
  )
}

export function buildAnthropicUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "")
  if (/\/v\d+\/messages$/i.test(trimmed)) return trimmed
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/messages`
  return `${trimmed}/v1/messages`
}

function buildAnthropicHeaders(apiKey: string, url: string): Record<string, string> {
  const base: Record<string, string> = {
    "Content-Type": JSON_CONTENT_TYPE,
  }
  if (requiresBearerAuth(url)) {
    base.Authorization = `Bearer ${apiKey}`
  } else {
    base["x-api-key"] = apiKey
    base["anthropic-version"] = "2023-06-01"
    base["anthropic-dangerous-direct-browser-access"] = "true"
  }
  return base
}

function toGoogleParts(content: string | ContentBlock[]): unknown[] {
  if (typeof content === "string") return [{ text: content }]
  return content.map((b) => {
    if (b.type === "text") return { text: b.text }
    return {
      inline_data: {
        mime_type: b.mediaType,
        data: b.dataBase64,
      },
    }
  })
}

function flattenGoogleSystemParts(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content.map((b) => (b.type === "text" ? b.text : "")).join("")
}

function buildGoogleBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system")
  const conversationMessages = messages.filter((m) => m.role !== "system")

  const contents = conversationMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: toGoogleParts(m.content),
  }))

  const systemInstruction =
    systemMessages.length > 0
      ? {
          parts: systemMessages.map((m) => ({ text: flattenGoogleSystemParts(m.content) })),
        }
      : undefined

  const generationConfig: Record<string, unknown> = {}
  if (overrides?.temperature !== undefined) generationConfig.temperature = overrides.temperature
  if (overrides?.top_p !== undefined) generationConfig.topP = overrides.top_p
  if (overrides?.top_k !== undefined) generationConfig.topK = overrides.top_k
  if (overrides?.max_tokens !== undefined) generationConfig.maxOutputTokens = overrides.max_tokens
  if (overrides?.stop !== undefined) {
    generationConfig.stopSequences = Array.isArray(overrides.stop) ? overrides.stop : [overrides.stop]
  }
  if (overrides?.reasoning?.mode === "off") {
    generationConfig.thinkingConfig = { thinkingBudget: 0 }
  } else if (overrides?.reasoning && overrides.reasoning.mode !== "auto") {
    const budget =
      overrides.reasoning.mode === "custom" && overrides.reasoning.budgetTokens !== undefined
        ? overrides.reasoning.budgetTokens
        : overrides.reasoning.mode === "low"
          ? 1024
          : overrides.reasoning.mode === "medium"
            ? 4096
            : 8192
    generationConfig.thinkingConfig = { thinkingBudget: budget }
  }

  return {
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  }
}

export function getProviderConfig(config: LlmConfig): ProviderConfig {
  const { provider, apiKey, model, ollamaUrl, customEndpoint } = config

  switch (provider) {
    case "openai":
      return {
        url: "https://api.openai.com/v1/chat/completions",
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          Authorization: `Bearer ${apiKey}`,
        },
        buildBody: (messages, overrides) => ({
          ...buildOpenAiCompatibleBody(config, messages, overrides),
          model,
        }),
        parseStream: parseOpenAiLine,
      }

    case "anthropic": {
      const url = buildAnthropicUrl("https://api.anthropic.com")
      return {
        url,
        headers: buildAnthropicHeaders(apiKey, url),
        buildBody: (messages, overrides) => ({
          ...buildAnthropicBodyWithReasoning(config, messages, overrides),
          model,
        }),
        parseStream: parseAnthropicLine,
      }
    }

    case "google": {
      const encodedModel = encodeURIComponent(model)
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:streamGenerateContent?alt=sse`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          "x-goog-api-key": apiKey,
        },
        buildBody: (messages, overrides) => buildGoogleBody(messages, {
          ...(overrides ?? {}),
          reasoning: effectiveReasoning(config, overrides),
        }),
        parseStream: parseGoogleLine,
      }
    }

    case "azure": {
      return {
        url: buildAzureOpenAiUrl(
          customEndpoint,
          model,
          config.azureApiVersion ?? AZURE_OPENAI_API_VERSION,
        ),
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          "api-key": apiKey,
        },
        buildBody: (messages, overrides) =>
          buildOpenAiCompatibleBody(config, messages, overrides),
        parseStream: parseOpenAiLine,
      }
    }

    case "ollama": {
      let ollamaBase = ollamaUrl.replace(/\/+$/, "")
      if (/\/v1\/chat\/completions$/i.test(ollamaBase)) {
        ollamaBase = ollamaBase.replace(/\/v1\/chat\/completions$/i, "")
      } else if (/\/v1$/i.test(ollamaBase)) {
        ollamaBase = ollamaBase.replace(/\/v1$/i, "")
      }
      return {
        url: `${ollamaBase}/v1/chat/completions`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          ...localLlmOriginHeader(),
        },
        buildBody: (messages, overrides) => ({
          ...buildOpenAiCompatibleBody(config, messages, overrides),
          model,
        }),
        parseStream: parseOpenAiLine,
      }
    }

    case "minimax": {
      const url = buildAnthropicUrl(customEndpoint || "https://api.minimax.io/anthropic")
      return {
        url,
        headers: buildAnthropicHeaders(apiKey, url),
        buildBody: (messages, overrides) => ({
          ...buildAnthropicBodyWithReasoning(config, messages, overrides),
          model,
        }),
        parseStream: parseAnthropicLine,
      }
    }

    case "custom": {
      const mode = config.apiMode ?? "chat_completions"
      if (mode === "anthropic_messages") {
        const url = buildAnthropicUrl(customEndpoint)
        return {
          url,
          headers: buildAnthropicHeaders(apiKey, url),
          buildBody: (messages, overrides) => ({
            ...buildAnthropicBodyWithReasoning(config, messages, overrides),
            model,
          }),
          parseStream: parseAnthropicLine,
        }
      }
      const base = customEndpoint.replace(/\/+$/, "")
      const url = isAzureOpenAiEndpoint(base)
        ? buildAzureOpenAiUrl(
            base,
            model,
            config.azureApiVersion ?? AZURE_OPENAI_API_VERSION,
          )
        : /\/chat\/completions$/i.test(base)
          ? base
          : `${base}/chat/completions`
      const azure = isAzureOpenAiEndpoint(url)
      return {
        url,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          ...(apiKey
            ? azure
              ? { "api-key": apiKey }
              : { Authorization: `Bearer ${apiKey}` }
            : {}),
          ...(azure ? {} : localLlmOriginHeader()),
        },
        buildBody: (messages, overrides) => {
          const body = buildOpenAiCompatibleBody(config, messages, overrides)
          if (!azure) body.model = model
          return body
        },
        parseStream: parseOpenAiLine,
      }
    }

    default: {
      const exhaustive: never = provider
      throw new Error(`Unknown provider: ${String(exhaustive)}`)
    }
  }
}
