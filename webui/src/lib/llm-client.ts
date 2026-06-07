/** Streaming LLM client for the frontend. */

import { httpFetch } from "@/lib/tauri"

export interface LlmConfig {
  model: string
  apiKey: string | null
  apiBase: string
  providerName: string | null
}

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: () => void
  onError: (err: Error) => void
}

export interface StreamOptions {
  temperature?: number
  max_tokens?: number
  signal?: AbortSignal
}

const DEFAULT_TEMPERATURE = 0.1
const DEFAULT_MAX_TOKENS = 8192

function isAnthropic(providerName: string | null): boolean {
  return providerName === "anthropic"
}

function buildAnthropicHeaders(apiKey: string | null): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey ?? "",
    "anthropic-version": "2023-06-01",
  }
}

function buildOpenAIHeaders(apiKey: string | null): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey ?? ""}`,
  }
}

function buildAnthropicBody(
  model: string,
  messages: ChatMessage[],
  options?: StreamOptions,
): string {
  // Anthropic Messages API: system is a top-level field, not in messages
  const system = messages.find((m) => m.role === "system")?.content
  const nonSystem = messages.filter((m) => m.role !== "system")

  return JSON.stringify({
    model,
    messages: nonSystem,
    ...(system ? { system } : {}),
    stream: true,
    temperature: options?.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: options?.max_tokens ?? DEFAULT_MAX_TOKENS,
  })
}

function buildOpenAIBody(
  model: string,
  messages: ChatMessage[],
  options?: StreamOptions,
): string {
  return JSON.stringify({
    model,
    messages,
    stream: true,
    temperature: options?.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: options?.max_tokens ?? DEFAULT_MAX_TOKENS,
  })
}

async function parseAnthropicSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: StreamCallbacks,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("event:")) continue
      if (!trimmed.startsWith("data:")) continue

      const data = trimmed.slice(5).trim()
      if (data === "[DONE]") {
        callbacks.onDone()
        return
      }

      try {
        const chunk = JSON.parse(data)
        if (chunk.type === "message_stop") {
          callbacks.onDone()
          return
        }
        if (chunk.type === "content_block_delta" && chunk.delta?.text) {
          callbacks.onToken(chunk.delta.text)
        }
        if (chunk.type === "error") {
          callbacks.onError(new Error(chunk.error?.message ?? "Anthropic API error"))
          return
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }

  callbacks.onDone()
}

async function parseOpenAISSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: StreamCallbacks,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith("data:")) continue

      const data = trimmed.slice(5).trim()
      if (data === "[DONE]") {
        callbacks.onDone()
        return
      }

      try {
        const chunk = JSON.parse(data)
        const content = chunk.choices?.[0]?.delta?.content
        if (content) {
          callbacks.onToken(content)
        }
        if (chunk.choices?.[0]?.finish_reason === "stop") {
          callbacks.onDone()
          return
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }

  callbacks.onDone()
}

export async function streamChat(
  config: LlmConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  options?: StreamOptions,
): Promise<void> {
  const anthropic = isAnthropic(config.providerName)

  if (!config.apiBase) {
    callbacks.onError(new Error("LLM apiBase is empty — check your provider configuration"))
    return
  }

  const url = anthropic
    ? `${config.apiBase}/messages`
    : `${config.apiBase}/chat/completions`

  console.log(`[llm-client] streamChat: model=${config.model}, provider=${config.providerName}, url=${url}`)

  const headers = anthropic
    ? buildAnthropicHeaders(config.apiKey)
    : buildOpenAIHeaders(config.apiKey)

  const body = anthropic
    ? buildAnthropicBody(config.model, messages, options)
    : buildOpenAIBody(config.model, messages, options)

  let response: Response
  try {
    response = await httpFetch(url, {
      method: "POST",
      headers,
      body,
      signal: options?.signal,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[llm-client] fetch failed: ${msg}`)
    callbacks.onError(err instanceof Error ? err : new Error(msg))
    return
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const text = await response.text()
      if (text) detail += `: ${text}`
    } catch {
      // Ignore read errors on error responses
    }
    console.error(`[llm-client] streamChat error: ${detail}`)
    callbacks.onError(new Error(detail))
    return
  }

  const reader = response.body?.getReader()
  if (!reader) {
    callbacks.onError(new Error("Response body is not readable"))
    return
  }

  if (anthropic) {
    await parseAnthropicSSE(reader, callbacks)
  } else {
    await parseOpenAISSE(reader, callbacks)
  }
}
