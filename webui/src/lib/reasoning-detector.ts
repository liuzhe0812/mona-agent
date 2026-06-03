const REASONING_FIELD_RE =
  /"reasoning(?:_content)?"\s*:\s*"((?:[^"\\]|\\.)*)"/g

export function countReasoningCharsInLine(rawLine: string): number {
  let total = 0
  for (const match of rawLine.matchAll(REASONING_FIELD_RE)) {
    total += match[1].length
  }
  return total
}

export function extractReasoningTextFromLine(rawLine: string): string[] {
  const line = rawLine.trim()
  if (!line.startsWith("data: ")) return []
  const data = line.slice(6).trim()
  if (!data || data === "[DONE]") return []
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { reasoning_content?: string; reasoning?: string } }>
      delta?: { type?: string; text?: string; thinking?: string }
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean }> }
      }>
    }
    const out: string[] = []
    for (const choice of parsed.choices ?? []) {
      const delta = choice.delta
      if (typeof delta?.reasoning_content === "string") out.push(delta.reasoning_content)
      if (typeof delta?.reasoning === "string") out.push(delta.reasoning)
    }
    if (parsed.delta?.type === "thinking_delta") {
      if (typeof parsed.delta.thinking === "string") out.push(parsed.delta.thinking)
      if (typeof parsed.delta.text === "string") out.push(parsed.delta.text)
    }
    for (const candidate of parsed.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.thought && typeof part.text === "string") out.push(part.text)
      }
    }
    return out
  } catch {
    return []
  }
}
