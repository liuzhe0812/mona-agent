import { streamChat, type LlmConfig } from "@/lib/llm-client"
import { getGatewayBaseUrl } from "@/lib/bootstrap"
import { getKbToken } from "@/lib/kb-api"
import { httpFetch } from "@/lib/tauri"
import type { WikiPage, WikiPageContent } from "@/lib/kb-api"

// ─── Types ──────────────────────────────────────────────────────────

export interface EntitySummary {
  path: string
  title: string
  type: string
  preview: string
}

export interface DuplicateGroup {
  slugs: string[]
  reason: string
}

export interface DedupResult {
  groups: DuplicateGroup[]
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function fetchLlmConfig(): Promise<LlmConfig> {
  const baseUrl = await getGatewayBaseUrl()
  const token = getKbToken()
  const resp = await httpFetch(`${baseUrl}/api/kb/llm-config`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!resp.ok) throw new Error(`Failed to fetch LLM config: ${resp.status}`)
  const data = await resp.json()
  return {
    model: data.model,
    apiKey: data.apiKey,
    apiBase: data.apiBase,
    providerName: data.providerName,
  }
}

async function writeFileApi(
  projectId: string,
  relPath: string,
  content: string,
): Promise<void> {
  const baseUrl = await getGatewayBaseUrl()
  const token = getKbToken()
  const resp = await httpFetch(
    `${baseUrl}/api/kb/${encodeURIComponent(projectId)}/wiki/write?path=${encodeURIComponent(relPath)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: content,
    },
  )
  if (!resp.ok) throw new Error(`Failed to write ${relPath}: ${resp.status}`)
}

async function deleteWikiPageApi(
  projectId: string,
  relPath: string,
): Promise<void> {
  const baseUrl = await getGatewayBaseUrl()
  const token = getKbToken()
  const resp = await httpFetch(
    `${baseUrl}/api/kb/${encodeURIComponent(projectId)}/wiki/delete?path=${encodeURIComponent(relPath)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  if (!resp.ok)
    throw new Error(`Failed to delete wiki page ${relPath}: ${resp.status}`)
}

// ─── Extract summaries ───────────────────────────────────────────────

export function extractEntitySummaries(
  pages: WikiPage[],
  pageContents: Map<string, WikiPageContent>,
): EntitySummary[] {
  const entityTypes = new Set(["entity", "concept"])
  return pages
    .filter((p) => entityTypes.has(p.type))
    .map((p) => {
      const content = pageContents.get(p.path)
      const body = content?.body ?? ""
      const preview = body.slice(0, 200).replace(/\n/g, " ").trim()
      return {
        path: p.path,
        title: p.title,
        type: p.type,
        preview,
      }
    })
}

// ─── Detect duplicate groups via LLM ────────────────────────────────

export async function detectDuplicateGroups(
  summaries: EntitySummary[],
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<DuplicateGroup[]> {
  if (summaries.length < 2) return []

  const summaryText = summaries
    .map((s, i) => `[${i}] ${s.title} (${s.type}) — ${s.preview}`)
    .join("\n")

  const systemPrompt = [
    "You are analyzing a list of wiki entities/concepts to find potential duplicates.",
    "Two items are duplicates if they refer to the same real-world entity or concept,",
    "even if they have different names or are categorized differently.",
    "",
    "Return a JSON array of groups. Each group is an object with:",
    '  - "slugs": array of the bracket indices (as strings) that are duplicates of each other',
    '  - "reason": brief explanation of why they are duplicates',
    "",
    "If there are no duplicates, return an empty array [].",
    "Only group items that are genuinely the same entity/concept, not merely related.",
    "",
    "Example output:",
    '[{"slugs": ["0", "3"], "reason": "same person with different name spellings"}]',
  ].join("\n")

  let raw = ""
  let hadError = false
  await streamChat(
    llmConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: summaryText },
    ],
    {
      onToken: (token) => {
        raw += token
      },
      onDone: () => {},
      onError: () => {
        hadError = true
      },
    },
    { temperature: 0.1, max_tokens: 4096, signal },
  )

  if (hadError || !raw.trim()) return []

  // Extract JSON from response (may be wrapped in markdown fences)
  const jsonMatch = raw.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      slugs: string[]
      reason: string
    }>
    // Convert slug indices back to page paths
    return parsed
      .filter(
        (g) =>
          Array.isArray(g.slugs) &&
          g.slugs.length >= 2 &&
          typeof g.reason === "string",
      )
      .map((g) => ({
        slugs: g.slugs
          .map((idx) => {
            const i = parseInt(idx, 10)
            return isNaN(i) ? null : summaries[i]?.path
          })
          .filter((s): s is string => s !== null),
        reason: g.reason,
      }))
      .filter((g) => g.slugs.length >= 2)
  } catch {
    return []
  }
}

// ─── Merge a duplicate group ────────────────────────────────────────

export async function mergeDuplicateGroup(
  projectId: string,
  group: DuplicateGroup,
  pageContents: Map<string, WikiPageContent>,
  signal?: AbortSignal,
): Promise<{ mergedPath: string; deletedPaths: string[] }> {
  const llmConfig = await fetchLlmConfig()

  // Collect all page contents in the group
  const pagesToMerge = group.slugs
    .map((path) => ({ path, content: pageContents.get(path) }))
    .filter((p): p is { path: string; content: WikiPageContent } => !!p.content)

  if (pagesToMerge.length < 2) {
    throw new Error("Need at least 2 pages to merge")
  }

  // Build merge prompt
  const pagesText = pagesToMerge
    .map((p) => `## ${p.path}\n\n${p.content.body}`)
    .join("\n\n---\n\n")

  const systemPrompt = [
    "You are merging duplicate wiki pages into a single coherent page.",
    "Combine all factual content from both pages, eliminating redundancy.",
    "Preserve the YAML frontmatter format with all required fields.",
    "The merged page should have:",
    '- sources: union of all source arrays from the originals',
    "- tags: union of all tags",
    "- related: union of all related slugs (minus the pages being deleted)",
    "",
    "Output the COMPLETE merged page starting with --- frontmatter.",
    "No preamble, no explanation.",
  ].join("\n")

  let mergedContent = ""
  let hadError = false
  await streamChat(
    llmConfig,
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Merge these duplicate pages (reason: ${group.reason}):\n\n${pagesText}`,
      },
    ],
    {
      onToken: (token) => {
        mergedContent += token
      },
      onDone: () => {},
      onError: () => {
        hadError = true
      },
    },
    { temperature: 0.1, max_tokens: 8192, signal },
  )

  if (hadError || !mergedContent.trim()) {
    throw new Error("LLM merge generation failed")
  }

  // Write merged content to the first page (keep it)
  const mergedPath = pagesToMerge[0].path
  await writeFileApi(projectId, mergedPath, mergedContent)

  // Delete the rest
  const deletedPaths: string[] = []
  for (let i = 1; i < pagesToMerge.length; i++) {
    try {
      await deleteWikiPageApi(projectId, pagesToMerge[i].path)
      deletedPaths.push(pagesToMerge[i].path)
    } catch (err) {
      console.error(
        `[dedup] Failed to delete ${pagesToMerge[i].path}:`,
        err,
      )
    }
  }

  return { mergedPath, deletedPaths }
}
