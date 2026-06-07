/**
 * Wikilink auto-enrichment: calls LLM to identify terms in a wiki page
 * that should become [[wikilinks]] pointing to existing wiki pages.
 */

import { streamChat, type LlmConfig } from "@/lib/llm-client"

interface WikilinkSubstitution {
  term: string
  target: string
}

const SYSTEM_PROMPT = [
  "You are a wiki link editor. Your job is to identify terms in a wiki page",
  "that should be turned into [[wikilinks]] pointing to existing wiki pages.",
  "",
  "Rules:",
  "- Only link terms that have a corresponding page in the wiki index below.",
  "- Do NOT link terms that are already inside [[...]] brackets.",
  "- Do NOT link terms inside YAML frontmatter (between --- lines).",
  "- Prefer specific, unambiguous matches. Skip generic or ambiguous terms.",
  "- Each term should appear at most once in your output.",
  "- The target is the wiki page slug (without wiki/ prefix or .md suffix).",
  "",
  "Output a JSON array of objects with \"term\" and \"target\" fields.",
  "Example: [{\"term\": \"Transformer architecture\", \"target\": \"transformer-architecture\"}]",
  "If no terms should be linked, output an empty array: []",
  "Output ONLY the JSON array, no other text.",
].join("\n")

/**
 * Check whether a position in `content` is inside a [[wikilink]] bracket pair.
 */
function isInsideWikilink(content: string, index: number): boolean {
  let depth = 0
  for (let i = index; i >= 0; i--) {
    if (content[i] === "]" && i > 0 && content[i - 1] === "]") {
      depth++
      i--
      continue
    }
    if (content[i] === "[" && i > 0 && content[i - 1] === "[") {
      depth--
      i--
      if (depth < 0) return true
      continue
    }
  }
  return false
}

/**
 * Check whether a position in `content` is inside YAML frontmatter.
 */
function isInsideFrontmatter(content: string, index: number): boolean {
  if (!content.startsWith("---")) return false
  const secondDelimiter = content.indexOf("---", 3)
  if (secondDelimiter === -1) return false
  return index < secondDelimiter + 3
}

/**
 * Apply wikilink substitutions to content.
 * Only replaces the first occurrence of each term,
 * skipping terms already inside [[...]] or YAML frontmatter.
 */
export function applyWikilinkSubstitutions(
  content: string,
  substitutions: WikilinkSubstitution[],
): { content: string; count: number } {
  let result = content
  let count = 0

  for (const { term, target } of substitutions) {
    const idx = result.indexOf(term)
    if (idx === -1) continue

    if (isInsideFrontmatter(result, idx) || isInsideWikilink(result, idx)) {
      continue
    }

    const replacement = `[[${target}|${term}]]`
    result = result.slice(0, idx) + replacement + result.slice(idx + term.length)
    count++
  }

  return { content: result, count }
}

/**
 * Parse the LLM response into an array of wikilink substitutions.
 * Handles various formats: bare JSON array, markdown-fenced JSON, etc.
 */
function parseSubstitutions(raw: string): WikilinkSubstitution[] {
  let jsonStr = raw.trim()

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim()
  }

  // Find the JSON array — look for the outermost [ ]
  const start = jsonStr.indexOf("[")
  const end = jsonStr.lastIndexOf("]")
  if (start === -1 || end === -1 || end <= start) return []

  jsonStr = jsonStr.slice(start, end + 1)

  try {
    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) return []

    return parsed.filter(
      (item): item is WikilinkSubstitution =>
        typeof item === "object"
        && item !== null
        && typeof item.term === "string"
        && typeof item.target === "string"
        && item.term.length > 0
        && item.target.length > 0,
    )
  } catch {
    return []
  }
}

export async function enrichWithWikilinks(
  projectId: string,
  filePath: string,
  content: string,
  indexContent: string,
  llmConfig: LlmConfig,
  writeFileApi: (projectId: string, path: string, content: string) => Promise<void>,
  _readFileApi: (projectId: string, path: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<number> {
  if (!indexContent.trim()) return 0

  const userMessage = [
    "## Wiki Page to Enrich",
    `File: ${filePath}`,
    "",
    content,
    "",
    "## Current Wiki Index (available link targets)",
    indexContent,
    "",
    "Identify terms in the page above that should link to existing wiki pages listed in the index.",
    "Output ONLY a JSON array of {\"term\", \"target\"} objects.",
  ].join("\n")

  let raw = ""
  let hadError = false

  await streamChat(
    llmConfig,
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    {
      onToken: (token) => { raw += token },
      onDone: () => {},
      onError: () => {
        hadError = true
      },
    },
    { temperature: 0.1, max_tokens: 2048, signal },
  )

  if (hadError || !raw.trim()) return 0

  const substitutions = parseSubstitutions(raw)
  if (substitutions.length === 0) return 0

  const { content: enrichedContent, count } = applyWikilinkSubstitutions(
    content,
    substitutions,
  )

  if (count > 0) {
    await writeFileApi(projectId, filePath, enrichedContent)
  }

  return count
}
