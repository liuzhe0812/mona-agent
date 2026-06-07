/**
 * Knowledge-base ingest pipeline — ported from llm_wiki's ingest.ts.
 *
 * Architecture: two-stage LLM calls (analysis → generation) with:
 *   - Long source chunking with checkpoint support
 *   - Robust FILE block parsing with code fence awareness
 *   - Ingest cache (skip unchanged sources)
 *   - Output sanitization
 *   - Page merging (union sources/tags/related)
 *   - Context budget computation
 *
 * File I/O goes through the KB HTTP API (no Tauri invoke).
 */

import { streamChat, type LlmConfig } from "@/lib/llm-client"
import { getGatewayBaseUrl } from "@/lib/bootstrap"
import { getKbToken } from "@/lib/kb-api"
import { httpFetch } from "@/lib/tauri"
import {
  sourceIdentityForPath,
  sourceSummarySlugFromIdentity,
} from "@/lib/source-identity"
import {
  parseSources,
  writeSources,
} from "@/lib/sources-merge"
import { checkIngestCache, saveIngestCache } from "@/lib/ingest-cache"
import { sanitizeIngestedFileContent } from "@/lib/ingest-sanitize"
import { mergePageContent, type MergeFn } from "@/lib/page-merge"
import { GENERATION_WIKI_TYPES } from "@/lib/wiki-page-types"
import { computeContextBudget } from "@/lib/context-budget"
import { parseReviewBlocks, type ParsedReviewItem } from "@/lib/review-parser"
import { enrichWithWikilinks } from "@/lib/enrich-wikilinks"

// ─── Constants ────────────────────────────────────────────────────────

const LONG_SOURCE_MIN_BUDGET = 8_000
const LONG_SOURCE_MAX_SINGLE_PASS_BUDGET = 300_000
const LONG_SOURCE_CHUNK_MIN = 12_000
const LONG_SOURCE_CHUNK_MAX = 60_000
const LONG_SOURCE_DIGEST_MAX = 15_000
const LONG_SOURCE_CHUNK_ANALYSIS_MAX = 40_000
const INGEST_GENERATION_TOKENS_DEFAULT = 8_192
const INGEST_GENERATION_TOKENS_128K = 16_384
const INGEST_GENERATION_TOKENS_256K = 24_576
const INGEST_GENERATION_TOKENS_512K = 32_768
const REVIEW_STAGE_MIN_SIGNAL_CHARS = 10_000
const REVIEW_STAGE_MIN_FILE_BLOCKS = 4

// ─── API helpers ──────────────────────────────────────────────────────

async function readFileApi(projectId: string, relPath: string): Promise<string> {
  const baseUrl = await getGatewayBaseUrl()
  const token = getKbToken()
  if (!token) {
    console.warn("[ingest] readFileApi called with empty token — request will likely fail with 401")
  }
  const url = `${baseUrl}/api/kb/${encodeURIComponent(projectId)}/files/read?path=${encodeURIComponent(relPath)}`
  console.log(`[ingest] readFileApi: ${url}`)
  const resp = await httpFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    console.error(`[ingest] readFileApi error ${resp.status} for ${relPath}: ${body}`)
    throw new Error(`Failed to read ${relPath}: ${resp.status}`)
  }
  const data = await resp.json()
  return data.content ?? ""
}

async function writeFileApi(projectId: string, relPath: string, content: string): Promise<void> {
  const baseUrl = await getGatewayBaseUrl()
  const token = getKbToken()
  const resp = await httpFetch(
    `${baseUrl}/api/kb/${encodeURIComponent(projectId)}/wiki/write?path=${encodeURIComponent(relPath)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: content,
    },
  )
  if (!resp.ok) throw new Error(`Failed to write ${relPath}: ${resp.status}`)
}

async function fileExistsApi(projectId: string, relPath: string): Promise<boolean> {
  try {
    await readFileApi(projectId, relPath)
    return true
  } catch {
    return false
  }
}

async function tryReadFileApi(projectId: string, relPath: string): Promise<string> {
  try {
    return await readFileApi(projectId, relPath)
  } catch (err) {
    console.error(`[ingest] readFileApi failed for ${relPath}:`, err)
    return ""
  }
}

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

// ─── Inline normalizePath ─────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

function getFileName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p
}

// ─── FILE block parsing ───────────────────────────────────────────────

// Legacy export kept for backward compatibility.
export const FILE_BLOCK_REGEX = /---FILE:\s*([^\n]+?)\s*---\n([\s\S]*?)---END FILE---/g

/** One FILE block extracted from an LLM's stage-2 output. */
export interface ParsedFileBlock {
  path: string
  content: string
}

/** What the parser produced, with any non-fatal issues surfaced. */
export interface ParseFileBlocksResult {
  blocks: ParsedFileBlock[]
  warnings: string[]
}

const OPENER_LINE = /^---\s*FILE:\s*(.+?)\s*---\s*$/i
const CLOSER_LINE = /^---\s*END\s+FILE\s*---\s*$/i
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/

/**
 * Reject FILE block paths that try to escape the project's `wiki/`
 * directory. Exported for tests.
 */
export function isSafeIngestPath(p: string): boolean {
  if (typeof p !== "string" || p.trim().length === 0) return false
  if (/[\x00-\x1f]/.test(p)) return false
  if (p.startsWith("/") || p.startsWith("\\")) return false
  if (/^[a-zA-Z]:/.test(p)) return false
  const normalized = p.replace(/\\/g, "/")
  const segments = normalized.split("/")
  if (segments.some((seg) => seg === "..")) return false
  if (segments.some((seg) => !isWindowsSafePathSegment(seg))) return false
  if (!normalized.startsWith("wiki/")) return false
  return true
}

function isWindowsSafePathSegment(segment: string): boolean {
  if (segment.length === 0) return false
  if (/[<>:"|?*]/.test(segment)) return false
  if (/[ .]$/.test(segment)) return false
  const stem = segment.split(".")[0]?.toUpperCase()
  if (!stem) return false
  if (
    stem === "CON" ||
    stem === "PRN" ||
    stem === "AUX" ||
    stem === "NUL" ||
    /^COM[1-9]$/.test(stem) ||
    /^LPT[1-9]$/.test(stem)
  ) {
    return false
  }
  return true
}

/**
 * Parse an LLM stage-2 generation into FILE blocks.
 *
 * Handles: CRLF normalization, stream truncation warnings, marker
 * whitespace/case variants, code fence awareness, empty-path warnings,
 * and path-traversal rejection.
 */
export function parseFileBlocks(text: string): ParseFileBlocksResult {
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")

  const blocks: ParsedFileBlock[] = []
  const warnings: string[] = []

  let i = 0
  while (i < lines.length) {
    const openerMatch = OPENER_LINE.exec(lines[i])
    if (!openerMatch) {
      i++
      continue
    }
    const path = openerMatch[1].trim()
    i++

    const contentLines: string[] = []
    let fenceMarker: string | null = null
    let fenceLen = 0
    let closed = false

    while (i < lines.length) {
      const line = lines[i]

      const fenceMatch = FENCE_LINE.exec(line)
      if (fenceMatch) {
        const run = fenceMatch[1]
        const char = run[0]
        const len = run.length
        if (fenceMarker === null) {
          fenceMarker = char
          fenceLen = len
        } else if (char === fenceMarker && len >= fenceLen) {
          fenceMarker = null
          fenceLen = 0
        }
        contentLines.push(line)
        i++
        continue
      }

      if (fenceMarker === null && CLOSER_LINE.test(line)) {
        closed = true
        i++
        break
      }

      contentLines.push(line)
      i++
    }

    if (!closed) {
      const pathLabel = path || "(unnamed)"
      const msg = `FILE block "${pathLabel}" was not closed before end of stream — likely truncation (model hit max_tokens, timeout, or connection dropped). Block dropped.`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    if (!path) {
      const msg = `FILE block with empty path skipped (LLM omitted the path after \`---FILE:\`).`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    if (!isSafeIngestPath(path)) {
      const msg = `FILE block with unsafe path "${path}" rejected (must be under wiki/, no .., no absolute paths, and Windows-safe file names).`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    blocks.push({ path, content: contentLines.join("\n") })
  }

  return { blocks, warnings }
}

// ─── Language rule (simplified) ────────────────────────────────────────

export function languageRule(_sourceContent: string = ""): string {
  return "Write all content in the same language as the source document."
}

// ─── Context budget helpers ───────────────────────────────────────────

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function computeIngestSourceBudget(
  maxContextSize: number | undefined,
  stableContextLength: number,
): number {
  const { maxCtx, responseReserve } = computeContextBudget(maxContextSize)
  const stableReserve = Math.min(Math.floor(maxCtx * 0.25), Math.max(12_000, stableContextLength))
  const instructionReserve = Math.max(12_000, Math.floor(maxCtx * 0.08))
  const available = maxCtx - responseReserve - stableReserve - instructionReserve
  const upper = Math.min(LONG_SOURCE_MAX_SINGLE_PASS_BUDGET, Math.max(LONG_SOURCE_MIN_BUDGET, Math.floor(maxCtx * 0.6)))
  return clampNumber(Math.floor(available), LONG_SOURCE_MIN_BUDGET, upper)
}

export function computeIngestGenerationMaxTokens(maxContextSize: number | undefined): number {
  const { maxCtx } = computeContextBudget(maxContextSize)
  if (maxCtx >= 512_000) return INGEST_GENERATION_TOKENS_512K
  if (maxCtx >= 256_000) return INGEST_GENERATION_TOKENS_256K
  if (maxCtx >= 128_000) return INGEST_GENERATION_TOKENS_128K
  return INGEST_GENERATION_TOKENS_DEFAULT
}

export function computeIngestReviewMaxTokens(maxContextSize: number | undefined): number {
  return Math.min(8_192, Math.max(4_096, Math.floor(computeIngestGenerationMaxTokens(maxContextSize) / 2)))
}

// ─── Long source chunking ─────────────────────────────────────────────

interface SourceChunk {
  id: string
  index: number
  total: number
  headingPath: string
  overlapBefore: string
  main: string
}

interface LongSourcePlan {
  chunked: boolean
  analysis: string
  sourceContext: string
  checkpointPath?: string
}

interface LongSourceCheckpoint {
  version: 1
  sourceIdentity: string
  sourceHash: string
  sourceLength: number
  sourceBudget: number
  targetChars: number
  overlapChars: number
  chunkTotal: number
  completedThrough: number
  globalDigest: string
  analyses: string[]
  updatedAt: number
}

function splitOversizedBlock(block: string, targetChars: number): string[] {
  if (block.length <= targetChars * 1.25) return [block]

  const pieces = block.match(/[^.!?。！？\n]+[.!?。！？]?|\n+/g) ?? [block]
  const out: string[] = []
  let current = ""
  for (const piece of pieces) {
    if (current && current.length + piece.length > targetChars) {
      out.push(current.trim())
      current = ""
    }
    if (piece.length > targetChars) {
      for (let i = 0; i < piece.length; i += targetChars) {
        const slice = piece.slice(i, i + targetChars).trim()
        if (slice) out.push(slice)
      }
    } else {
      current += piece
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

function semanticBlocks(content: string, targetChars: number): Array<{ text: string; headingPath: string }> {
  const blocks: Array<{ text: string; headingPath: string }> = []
  const headingStack: string[] = []
  let paragraph: string[] = []
  let paragraphHeading = ""

  const currentHeadingPath = () => headingStack.filter(Boolean).join(" > ")
  const flushParagraph = () => {
    const text = paragraph.join("\n").trim()
    if (text) {
      for (const piece of splitOversizedBlock(text, targetChars)) {
        blocks.push({ text: piece, headingPath: paragraphHeading })
      }
    }
    paragraph = []
  }

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flushParagraph()
      const depth = heading[1].length
      headingStack.length = depth - 1
      headingStack[depth - 1] = heading[2].trim()
      blocks.push({ text: line.trim(), headingPath: currentHeadingPath() })
      paragraphHeading = currentHeadingPath()
      continue
    }

    if (line.trim() === "") {
      flushParagraph()
      paragraphHeading = currentHeadingPath()
      continue
    }

    if (paragraph.length === 0) paragraphHeading = currentHeadingPath()
    paragraph.push(line)
  }
  flushParagraph()

  return blocks
}

function overlapSuffix(text: string, maxChars: number): string {
  if (!text || maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  const raw = text.slice(-maxChars)
  const paragraphBreak = raw.search(/\n\s*\n/)
  if (paragraphBreak > 0 && raw.length - paragraphBreak > maxChars * 0.4) {
    return raw.slice(paragraphBreak).trim()
  }
  const sentenceBreak = raw.search(/[.!?。！？]\s+/)
  if (sentenceBreak > 0 && raw.length - sentenceBreak > maxChars * 0.4) {
    return raw.slice(sentenceBreak + 1).trim()
  }
  return raw.trim()
}

export function splitSourceIntoSemanticChunks(
  content: string,
  targetChars: number,
  overlapChars: number,
): SourceChunk[] {
  const target = Math.max(1_000, targetChars)
  const blocks = semanticBlocks(content, target)
  if (blocks.length === 0) return []

  const rawChunks: Array<{ main: string; headingPath: string }> = []
  let current: string[] = []
  let currentLength = 0
  let currentHeading = blocks[0]?.headingPath ?? ""

  const flush = () => {
    const main = current.join("\n\n").trim()
    if (main) rawChunks.push({ main, headingPath: currentHeading })
    current = []
    currentLength = 0
  }

  for (const block of blocks) {
    const nextLength = currentLength + block.text.length + (current.length > 0 ? 2 : 0)
    if (current.length > 0 && nextLength > target) {
      flush()
    }
    if (current.length === 0) currentHeading = block.headingPath
    current.push(block.text)
    currentLength += block.text.length + (current.length > 1 ? 2 : 0)
  }
  flush()

  return rawChunks.map((chunk, idx) => ({
    id: `chunk-${idx + 1}`,
    index: idx + 1,
    total: rawChunks.length,
    headingPath: chunk.headingPath,
    overlapBefore: idx > 0 ? overlapSuffix(rawChunks[idx - 1].main, overlapChars) : "",
    main: chunk.main,
  }))
}

function trimLongText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n\n[...trimmed for prompt budget...]`
}

function hashTextHex(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = BigInt.asUintN(64, hash * prime)
  }
  return hash.toString(16).padStart(16, "0")
}

function longSourceCheckpointRelPath(
  sourceSummarySlug: string,
  sourceHash: string,
): string {
  return `.llm-wiki/ingest-progress/${sourceSummarySlug}-${sourceHash}.json`
}

function isCompatibleLongSourceCheckpoint(
  checkpoint: LongSourceCheckpoint,
  params: {
    sourceIdentity: string
    sourceHash: string
    sourceLength: number
    sourceBudget: number
    targetChars: number
    overlapChars: number
    chunkTotal: number
  },
): boolean {
  return checkpoint.version === 1
    && checkpoint.sourceIdentity === params.sourceIdentity
    && checkpoint.sourceHash === params.sourceHash
    && checkpoint.sourceLength === params.sourceLength
    && checkpoint.sourceBudget === params.sourceBudget
    && checkpoint.targetChars === params.targetChars
    && checkpoint.overlapChars === params.overlapChars
    && checkpoint.chunkTotal === params.chunkTotal
    && checkpoint.completedThrough >= 0
    && checkpoint.completedThrough <= params.chunkTotal
    && Array.isArray(checkpoint.analyses)
    && checkpoint.analyses.length === checkpoint.completedThrough
}

async function loadLongSourceCheckpoint(
  projectId: string,
  checkpointRelPath: string,
  params: Parameters<typeof isCompatibleLongSourceCheckpoint>[1],
): Promise<LongSourceCheckpoint | null> {
  try {
    const raw = await readFileApi(projectId, checkpointRelPath)
    const parsed = JSON.parse(raw) as LongSourceCheckpoint
    if (!isCompatibleLongSourceCheckpoint(parsed, params)) return null
    return parsed
  } catch {
    return null
  }
}

async function saveLongSourceCheckpoint(
  projectId: string,
  checkpointRelPath: string,
  checkpoint: LongSourceCheckpoint,
): Promise<void> {
  await writeFileApi(projectId, checkpointRelPath, JSON.stringify(checkpoint, null, 2))
}

async function clearLongSourceCheckpoint(
  projectId: string,
  checkpointRelPath: string,
): Promise<void> {
  try {
    if (await fileExistsApi(projectId, checkpointRelPath)) {
      // Write empty content to "delete" via the API
      await writeFileApi(projectId, checkpointRelPath, "")
    }
  } catch {
    // Best-effort cleanup.
  }
}

function extractMarkedSection(raw: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i")
  return re.exec(raw)?.[1]?.trim() ?? ""
}

function buildChunkAnalysisSystemPrompt(
  purpose: string,
  schema: string,
  index: string,
  sourceContent: string,
): string {
  return [
    "You are analyzing a long source document for a personal wiki.",
    "Do not output chain-of-thought, hidden reasoning, or a thinking transcript.",
    "Analyze only the current MAIN CHUNK. Use overlap and digest for context only.",
    "Keep stable names consistent with the existing wiki and prior digest.",
    "",
    languageRule(sourceContent),
    "",
    "Output exactly two markdown sections:",
    "",
    "## Chunk Analysis",
    "- Concise summary of the main chunk",
    "- New or updated entities",
    "- New or updated concepts",
    "- Claims, findings, evidence, contradictions",
    "- Open questions or research gaps",
    "",
    "## Updated Global Digest",
    "A compact document-level digest that incorporates this chunk and preserves prior cross-chunk context.",
    "Keep this digest structured under: Summary, Entities, Concepts, Claims, Evidence, Contradictions, Open Questions, Cross-Chunk Relations.",
    "",
    "Stable project context follows. It changes rarely and should be treated as background:",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${trimLongText(index, 40_000)}` : "",
  ].filter(Boolean).join("\n")
}

function buildChunkAnalysisUserPrompt(
  sourceIdentity: string,
  folderContext: string | undefined,
  chunk: SourceChunk,
  globalDigest: string,
): string {
  return [
    `Source file: ${sourceIdentity}`,
    folderContext ? `Folder context: ${folderContext}` : "",
    `Chunk: ${chunk.index}/${chunk.total}`,
    chunk.headingPath ? `Heading path: ${chunk.headingPath}` : "",
    "",
    "## Current Global Digest",
    globalDigest || "(No prior digest yet.)",
    "",
    chunk.overlapBefore ? "## Previous Overlap Context\n" + chunk.overlapBefore : "",
    "",
    "## MAIN CHUNK TO ANALYZE",
    chunk.main,
    "",
    "Return only the two requested sections. Do not repeat overlap-only facts unless the main chunk supports them.",
  ].filter(Boolean).join("\n")
}

async function analyzeLongSourceInChunks(
  projectId: string,
  llmConfig: LlmConfig,
  purpose: string,
  schema: string,
  index: string,
  sourceIdentity: string,
  sourceSummarySlug: string,
  folderContext: string | undefined,
  sourceContent: string,
  sourceBudget: number,
  onProgress?: (detail: string) => void,
  signal?: AbortSignal,
): Promise<LongSourcePlan> {
  const targetChars = clampNumber(Math.floor(sourceBudget * 0.55), LONG_SOURCE_CHUNK_MIN, LONG_SOURCE_CHUNK_MAX)
  const overlapChars = clampNumber(Math.floor(targetChars * 0.08), 800, 3_000)
  const chunks = splitSourceIntoSemanticChunks(sourceContent, targetChars, overlapChars)
  if (chunks.length <= 1) {
    return { chunked: false, analysis: "", sourceContext: sourceContent }
  }

  const systemPrompt = buildChunkAnalysisSystemPrompt(purpose, schema, index, sourceContent)
  const sourceHash = hashTextHex(sourceContent)
  const checkpointRelPath = longSourceCheckpointRelPath(sourceSummarySlug, sourceHash)
  const checkpointParams = {
    sourceIdentity,
    sourceHash,
    sourceLength: sourceContent.length,
    sourceBudget,
    targetChars,
    overlapChars,
    chunkTotal: chunks.length,
  }
  const checkpoint = await loadLongSourceCheckpoint(projectId, checkpointRelPath, checkpointParams)
  let globalDigest = checkpoint?.globalDigest ?? ""
  const analyses: string[] = checkpoint?.analyses ? [...checkpoint.analyses] : []
  let completedThrough = checkpoint?.completedThrough ?? 0

  if (completedThrough > 0) {
    onProgress?.(`Resuming long source analysis from chunk ${completedThrough + 1}/${chunks.length}...`)
  }

  for (const chunk of chunks) {
    if (chunk.index <= completedThrough) continue
    if (signal?.aborted) throw new Error("Ingest cancelled")
    onProgress?.(`Analyzing long source chunk ${chunk.index}/${chunk.total}...`)

    let raw = ""
    let hadError = false
    await streamChat(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: buildChunkAnalysisUserPrompt(
            sourceIdentity,
            folderContext,
            chunk,
            trimLongText(globalDigest, LONG_SOURCE_DIGEST_MAX),
          ),
        },
      ],
      {
        onToken: (token) => { raw += token },
        onDone: () => {},
        onError: () => {
          hadError = true
        },
      },
      { temperature: 0.1, max_tokens: 4096, signal },
    )

    if (signal?.aborted) throw new Error("Ingest cancelled")
    if (hadError) throw new Error("Chunk analysis stream failed")

    const chunkAnalysis = extractMarkedSection(raw, "Chunk Analysis") || raw.trim()
    const nextDigest = extractMarkedSection(raw, "Updated Global Digest")
    analyses.push([
      `## Chunk ${chunk.index}/${chunk.total}${chunk.headingPath ? ` — ${chunk.headingPath}` : ""}`,
      trimLongText(chunkAnalysis, LONG_SOURCE_CHUNK_ANALYSIS_MAX),
    ].join("\n"))

    globalDigest = trimLongText(
      nextDigest || [globalDigest, chunkAnalysis].filter(Boolean).join("\n\n"),
      LONG_SOURCE_DIGEST_MAX,
    )
    completedThrough = chunk.index
    await saveLongSourceCheckpoint(projectId, checkpointRelPath, {
      version: 1,
      ...checkpointParams,
      completedThrough,
      globalDigest,
      analyses,
      updatedAt: Date.now(),
    })
  }

  const analysis = [
    "# Consolidated Long-Document Analysis",
    "",
    "## Final Global Digest",
    globalDigest || "(No digest produced.)",
    "",
    "## Per-Chunk Analyses",
    analyses.join("\n\n"),
  ].join("\n")

  const sourceContext = [
    `# Long Source Context: ${sourceIdentity}`,
    "",
    `The original source was analyzed in ${chunks.length} semantic chunks with paragraph/section boundaries and overlap. Use this consolidated context instead of assuming the raw document ended early.`,
    "",
    "## Final Global Digest",
    globalDigest || "(No digest produced.)",
    "",
    "## Chunk Analysis Notes",
    trimLongText(analyses.join("\n\n"), Math.max(sourceBudget, LONG_SOURCE_CHUNK_ANALYSIS_MAX)),
  ].join("\n")

  return { chunked: true, analysis, sourceContext, checkpointPath: checkpointRelPath }
}

// ─── Prompt builders ──────────────────────────────────────────────────

/**
 * Step 1 prompt: AI reads the source and produces a structured analysis.
 */
export function buildAnalysisPrompt(purpose: string, index: string, sourceContent: string = ""): string {
  return [
    "You are an expert research analyst. Read the source document and produce a structured analysis.",
    "Do not output chain-of-thought, hidden reasoning, or a thinking transcript. Reason internally and write only the concise final analysis.",
    "",
    languageRule(sourceContent),
    "",
    "Your analysis should cover:",
    "",
    "## Key Entities",
    "List people, organizations, products, datasets, tools mentioned. For each:",
    "- Name and type",
    "- Role in the source (central vs. peripheral)",
    "- Whether it likely already exists in the wiki (check the index)",
    "",
    "## Key Concepts",
    "List theories, methods, techniques, phenomena. For each:",
    "- Name and brief definition",
    "- Why it matters in this source",
    "- Whether it likely already exists in the wiki",
    "",
    "## Main Arguments & Findings",
    "- What are the core claims or results?",
    "- What evidence supports them?",
    "- How strong is the evidence?",
    "",
    "## Connections to Existing Wiki",
    "- What existing pages does this source relate to?",
    "- Does it strengthen, challenge, or extend existing knowledge?",
    "",
    "## Contradictions & Tensions",
    "- Does anything in this source conflict with existing wiki content?",
    "- Are there internal tensions or caveats?",
    "",
    "## Recommendations",
    "- What wiki pages should be created or updated?",
    "- What should be emphasized vs. de-emphasized?",
    "- Any open questions worth flagging for the user?",
    "",
    "Be thorough but concise. Focus on what's genuinely important.",
    "",
    "If a folder context is provided, use it as a hint for categorization — the folder structure often reflects the user's organizational intent (e.g., 'papers/energy' suggests the file is an energy-related paper).",
    "",
    purpose ? `## Wiki Purpose (for context)\n${purpose}` : "",
    index ? `## Current Wiki Index (for checking existing content)\n${index}` : "",
  ].filter(Boolean).join("\n")
}

/**
 * Step 2 prompt: AI takes its own analysis and generates wiki files.
 */
export function buildGenerationPrompt(
  schema: string,
  purpose: string,
  index: string,
  sourceFileName: string,
  overview?: string,
  sourceContent: string = "",
  sourceSummaryPath?: string,
): string {
  const sourceBaseName = sourceFileName.replace(/\.[^.]+$/, "")
  const summaryPath = sourceSummaryPath ?? `wiki/sources/${sourceBaseName}.md`

  return [
    "You are a wiki maintainer. Based on the analysis provided, generate wiki files.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble. Reason internally and output only the requested FILE/REVIEW blocks.",
    "",
    languageRule(sourceContent),
    "",
    `## IMPORTANT: Source File`,
    `The original source file is: **${sourceFileName}**`,
    `All wiki pages generated from this source MUST include this filename in their frontmatter \`sources\` field.`,
    "",
    schema
      ? [
          "## Project Schema and Routing (AUTHORITATIVE)",
          schema,
          "",
          "Use this schema as the primary routing rule for page types and directories.",
          "If it defines custom folders or distinctions (for example people, technologies, organizations, methods, or cases), write pages into those schema-defined folders instead of forcing them into wiki/entities/ or wiki/concepts/.",
          "Use wiki/entities/ and wiki/concepts/ only when the schema does not provide a more specific destination.",
        ].join("\n")
      : "",
    "",
    "## What to generate",
    "",
    `1. A source summary page at **${summaryPath}** (MUST use this exact path)`,
    "2. Entity or schema-defined typed pages for key named things identified in the analysis. Prefer schema-defined directories when present; otherwise use wiki/entities/.",
    "3. Concept or schema-defined typed pages for key ideas, methods, techniques, and abstractions. Prefer schema-defined directories when present; otherwise use wiki/concepts/.",
    "4. An updated wiki/index.md — add new entries to existing categories, preserve all existing entries",
    "5. A log entry for wiki/log.md (just the new entry to append, format: ## [YYYY-MM-DD] ingest | Title)",
    "6. An updated wiki/overview.md — a high-level summary of what the entire wiki covers, updated to reflect the newly ingested source. This should be a comprehensive 2-5 paragraph overview of ALL topics in the wiki, not just the new source.",
    "",
    "## Frontmatter Rules (CRITICAL — parser is strict)",
    "",
    "Every page begins with a YAML frontmatter block. Format rules, in order of importance:",
    "",
    "1. The VERY FIRST line of the file MUST be exactly `---` (three hyphens, nothing else).",
    "   Do NOT wrap the file in a ```yaml ... ``` code fence.",
    "   Do NOT prefix it with a `frontmatter:` key or any other line.",
    "2. Each frontmatter line is a `key: value` pair on its own line.",
    "3. The frontmatter ends with another `---` line on its own.",
    "4. The next line after the closing `---` is the start of the page body.",
    "5. Arrays use the standard YAML inline form `[a, b, c]` (no outer brackets around each item).",
    "   Wikilinks belong in the BODY only — never write `related: [[a]], [[b]]` (invalid YAML);",
    "   write `related: [a, b]` with bare slugs.",
    "",
    "Required fields and types:",
    `  • type     — one of the known types (${GENERATION_WIKI_TYPES.join(" | ")}), or a custom type explicitly defined by the project schema`,
    "  • title    — string (quote it if it contains a colon, e.g. `title: \"Foo: Bar\"`)",
    "  • created  — date in YYYY-MM-DD form (no quotes)",
    "  • updated  — same as created",
    "  • tags     — array of bare strings: `tags: [microbiology, ai]`",
    "  • related  — array of bare wiki page slugs: `related: [foo, bar-baz]`. Do NOT include",
    "               `wiki/`, `.md`, or `[[…]]` here — slugs only.",
    `  • sources  — array of source filenames; MUST include "${sourceFileName}".`,
    "",
    "Concrete example of a complete, parseable page (everything between the two `---` lines",
    "is the frontmatter; the heading and prose below are the body):",
    "",
    "    ---",
    "    type: entity",
    "    title: Example Entity",
    "    created: 2026-04-29",
    "    updated: 2026-04-29",
    "    tags: [example, demo]",
    "    related: [related-slug-1, related-slug-2]",
    `    sources: ["${sourceFileName}"]`,
    "    ---",
    "",
    "    # Example Entity",
    "",
    "    Body content goes here. Use [[wikilink]] syntax in the body for cross-references.",
    "",
    "Other rules:",
    "- Use [[wikilink]] syntax in the BODY for cross-references between pages",
    "- If you include images, use wiki-root-relative paths such as `media/source-slug/image.png`; never output absolute filesystem paths.",
    "- Use kebab-case filenames",
    "- Follow the analysis recommendations on what to emphasize",
    "- If the analysis found connections to existing pages, add cross-references",
    "",
    "## Review block types",
    "",
    "After all FILE blocks, optionally emit REVIEW blocks for anything that needs human judgment:",
    "",
    "- contradiction: the analysis found conflicts with existing wiki content",
    "- duplicate: an entity/concept might already exist under a different name in the index",
    "- missing-page: an important concept is referenced but has no dedicated page",
    "- suggestion: ideas for further research, related sources to look for, or connections worth exploring",
    "",
    "Only create reviews for things that genuinely need human input. Don't create trivial reviews.",
    "",
    "## OPTIONS allowed values (only these predefined labels):",
    "",
    "- contradiction: OPTIONS: Create Page | Skip",
    "- duplicate: OPTIONS: Create Page | Skip",
    "- missing-page: OPTIONS: Create Page | Skip",
    "- suggestion: OPTIONS: Create Page | Skip",
    "",
    "Do NOT invent custom option labels. Only use 'Create Page' and 'Skip'.",
    "",
    "For suggestion and missing-page reviews, the SEARCH field must contain 2-3 web search queries",
    "(keyword-rich, specific, suitable for a search engine — NOT titles or sentences). Example:",
    "  SEARCH: automated technical debt detection AI generated code | software quality metrics LLM code generation | static analysis tools agentic software development",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    index ? `## Current Wiki Index (preserve all existing entries, add new ones)\n${index}` : "",
    overview ? `## Current Overview (update this to reflect the new source)\n${overview}` : "",
    "",
    "## Output Format (MUST FOLLOW EXACTLY — this is how the parser reads your response)",
    "",
    "Your ENTIRE response consists of FILE blocks followed by optional REVIEW blocks. Nothing else.",
    "",
    "FILE block template:",
    "```",
    "---FILE: wiki/path/to/page.md---",
    "(complete file content with YAML frontmatter)",
    "---END FILE---",
    "```",
    "",
    "REVIEW block template (optional, after all FILE blocks):",
    "```",
    "---REVIEW: type | Title---",
    "Description of what needs the user's attention.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "SEARCH: query 1 | query 2 | query 3",
    "---END REVIEW---",
    "```",
    "",
    "## Output Requirements (STRICT — deviations will cause parse failure)",
    "",
    "1. The FIRST character of your response MUST be `-` (the opening of `---FILE:`).",
    "2. DO NOT output any preamble such as \"Here are the files:\", \"Based on the analysis...\", or any introductory prose.",
    "3. DO NOT echo or restate the analysis — that was stage 1's job. Your job is to emit FILE blocks.",
    "4. DO NOT output markdown tables, bullet lists, or headings outside of FILE/REVIEW blocks.",
    "5. DO NOT output any trailing commentary after the last `---END FILE---` or `---END REVIEW---`.",
    "6. Between blocks, use only blank lines — no prose.",
    "7. EVERY FILE block's content (titles, body, descriptions) MUST be in the mandatory output language specified below. No exceptions — not even for page names or section headings.",
    "",
    "If you start with anything other than `---FILE:`, the entire response will be discarded.",
    "",
    "---",
    "",
    languageRule(sourceContent),
  ].filter(Boolean).join("\n")
}

function buildReviewSuggestionPrompt(
  purpose: string,
  index: string,
  sourceIdentity: string,
  analysis: string,
  sourceContext: string,
  generation: string,
  maxContextSize: number | undefined,
): string {
  const { maxCtx } = computeContextBudget(maxContextSize)
  const sectionCap = Math.max(4_000, Math.floor(maxCtx * 0.15))
  const indexCap = Math.max(3_000, Math.floor(sectionCap * 0.8))
  return [
    "You are identifying high-value follow-up research items for a personal wiki.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble.",
    "",
    languageRule(sourceContext),
    "",
    "Your job is NOT to generate wiki pages. The wiki page generation already happened.",
    "Output only REVIEW blocks for unresolved knowledge gaps that deserve human attention or Deep Research.",
    "",
    "Create REVIEW blocks only for genuinely useful follow-up work:",
    "- missing-page: an important entity/concept is referenced but still lacks a dedicated page",
    "- suggestion: a research question, source type, or comparison that would materially improve the wiki",
    "- contradiction: a conflict or tension that requires user judgment",
    "- duplicate: likely duplicate pages/names that need user review",
    "",
    "Prefer 1-5 high-signal reviews. If there is nothing worth reviewing, output nothing.",
    "For suggestion and missing-page reviews, include a SEARCH line with 2-3 keyword-rich web search queries separated by ` | `.",
    "Use only these options: OPTIONS: Create Page | Skip",
    "",
    "REVIEW block template:",
    "```",
    "---REVIEW: suggestion | Precise title---",
    "Concise description of the gap and why it matters.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "SEARCH: query 1 | query 2 | query 3",
    "---END REVIEW---",
    "```",
    "",
    "Return REVIEW blocks only. Do not output FILE blocks. Do not wrap the response in markdown fences.",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    index ? `## Current Wiki Index\n${trimLongText(index, indexCap)}` : "",
    "",
    `## Source\n${sourceIdentity}`,
    "",
    "## Stage 1 Analysis",
    trimLongText(analysis, sectionCap),
    "",
    "## Source Context",
    trimLongText(sourceContext, sectionCap),
    "",
    "## Generated Wiki Output",
    trimLongText(generation, sectionCap),
  ].filter(Boolean).join("\n")
}

// ─── Helpers for writeFileBlocks ──────────────────────────────────────

function isLogPath(relativePath: string): boolean {
  return relativePath === "wiki/log.md" || relativePath.endsWith("/log.md")
}

function isListingPath(relativePath: string): boolean {
  return (
    relativePath === "wiki/index.md" ||
    relativePath.endsWith("/index.md") ||
    relativePath === "wiki/overview.md" ||
    relativePath.endsWith("/overview.md")
  )
}

function canonicalizeSourcesField(content: string, sourceIdentity: string): string {
  if (!/^---\n/.test(content)) return content

  const identityKey = normalizePath(sourceIdentity).toLowerCase()
  const identityBaseName = getFileName(sourceIdentity).toLowerCase()
  const sourceValues = parseSources(content)
  const canonicalValues = sourceValues.map((source) => {
    const normalized = normalizePath(source)
    const key = normalized.toLowerCase()
    if (key === identityKey) return sourceIdentity
    if (!normalized.includes("/") && key === identityBaseName) return sourceIdentity
    return source
  })
  if (!canonicalValues.some((source) => normalizePath(source).toLowerCase() === identityKey)) {
    canonicalValues.push(sourceIdentity)
  }

  const seen = new Set<string>()
  const deduped = canonicalValues.filter((source) => {
    const key = normalizePath(source).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return writeSources(content, deduped)
}

function countFileBlocks(text: string): number {
  return (text.match(/---FILE:\s*[^-]+---/g) ?? []).length
}

function shouldRunDedicatedReviewStage(generation: string): boolean {
  return generation.length >= REVIEW_STAGE_MIN_SIGNAL_CHARS
    || countFileBlocks(generation) >= REVIEW_STAGE_MIN_FILE_BLOCKS
    || /---REVIEW:\s*[\w-]+\s*\|[\s\S]*$/i.test(generation)
}

/**
 * Build a MergeFn for a given LLM config.
 */
function buildPageMerger(llmConfig: LlmConfig): MergeFn {
  return async (existingContent, incomingContent, sourceFileName, signal) => {
    const systemPrompt = [
      "You are merging two versions of the same wiki page into one coherent document.",
      "Both versions describe the same entity / concept; one is already on disk,",
      "the other was just generated from a different source document.",
      "",
      "Output ONE merged version that:",
      "- Preserves every factual claim from both versions (do not drop content)",
      "- Eliminates redundancy when both versions state the same fact",
      "- Reorganizes sections so the structure is logical for the merged topic,",
      "  not just a concatenation of the two inputs",
      "- Uses consistent markdown structure (headings, tables, lists, callouts)",
      "- Keeps `[[wikilink]]` references intact",
      "",
      "Output requirements:",
      "- The FIRST character of your response MUST be `-` (the opening of `---`)",
      "- Output the COMPLETE file: YAML frontmatter + body",
      "- No preamble (no \"Here is the merged version:\"), no analysis prose",
      "- The caller will overwrite `sources`/`tags`/`related`/`updated` with",
      "  deterministic values — your job is the body and any other fields",
    ].join("\n")

    const userMessage = [
      `## Existing version on disk`,
      "",
      existingContent,
      "",
      "---",
      "",
      `## Newly generated version (from ${sourceFileName})`,
      "",
      incomingContent,
      "",
      "---",
      "",
      "Now output the merged file. Start with `---` on the first line.",
    ].join("\n")

    let result = ""
    let streamError: Error | null = null
    await new Promise<void>((resolve) => {
      streamChat(
        llmConfig,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          onToken: (token) => {
            result += token
          },
          onDone: () => resolve(),
          onError: (err) => {
            streamError = err
            resolve()
          },
        },
        { temperature: 0.1, signal },
      ).catch((err) => {
        streamError = err instanceof Error ? err : new Error(String(err))
        resolve()
      })
    })
    if (streamError) throw streamError
    return result
  }
}

/**
 * Best-effort snapshot of a page before a fallback merge overwrites it.
 */
async function backupExistingPage(
  projectId: string,
  relativePath: string,
  existingContent: string,
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const sanitized = relativePath.replace(/[/\\]/g, "_")
  const backupRelPath = `.llm-wiki/page-history/${sanitized}-${stamp}`
  try {
    await writeFileApi(projectId, backupRelPath, existingContent)
  } catch {
    // non-critical
  }
}

// ─── Write FILE blocks ────────────────────────────────────────────────

async function writeFileBlocks(
  projectId: string,
  text: string,
  llmConfig: LlmConfig,
  sourceFileName: string,
  sourceSummaryPath?: string,
  signal?: AbortSignal,
): Promise<{ writtenPaths: string[]; warnings: string[]; hardFailures: string[] }> {
  const { blocks, warnings: parseWarnings } = parseFileBlocks(text)
  const warnings = [...parseWarnings]
  const writtenPaths: string[] = []
  const hardFailures: string[] = []

  for (const { path: rawRelativePath, content: rawContent } of blocks) {
    let relativePath = rawRelativePath
    if (sourceSummaryPath && relativePath.startsWith("wiki/sources/")) {
      relativePath = sourceSummaryPath
    }

    let content = sanitizeIngestedFileContent(rawContent)
    if (!isLogPath(relativePath) && !isListingPath(relativePath)) {
      content = canonicalizeSourcesField(content, sourceFileName)
    }

    try {
      if (isLogPath(relativePath)) {
        const existing = await tryReadFileApi(projectId, relativePath)
        const appended = existing ? `${existing}\n\n${content.trim()}` : content.trim()
        await writeFileApi(projectId, relativePath, appended)
      } else if (isListingPath(relativePath)) {
        await writeFileApi(projectId, relativePath, content)
      } else {
        const existing = await tryReadFileApi(projectId, relativePath)
        const toWrite = await mergePageContent(
          content,
          existing || null,
          buildPageMerger(llmConfig),
          {
            sourceFileName,
            pagePath: relativePath,
            signal,
            backup: (oldContent) => backupExistingPage(projectId, relativePath, oldContent),
          },
        )
        await writeFileApi(projectId, relativePath, toWrite)
      }
      writtenPaths.push(relativePath)
    } catch (err) {
      const msg = `Failed to write "${relativePath}": ${err instanceof Error ? err.message : String(err)}`
      console.error(`[ingest] ${msg}`)
      warnings.push(msg)
      hardFailures.push(relativePath)
    }
  }

  return { writtenPaths, warnings, hardFailures }
}

// ─── Main export ──────────────────────────────────────────────────────

export interface IngestProgress {
  status: "running" | "done" | "error"
  currentFile: string
  completedFiles: string[]
  errors: string[]
  pagesWritten: number
  reviews: ParsedReviewItem[]
}

export async function ingestFiles(
  projectId: string,
  files: string[],
  onProgress?: (progress: IngestProgress) => void,
  signal?: AbortSignal,
): Promise<IngestProgress> {
  const progress: IngestProgress = {
    status: "running",
    currentFile: "",
    completedFiles: [],
    errors: [],
    pagesWritten: 0,
    reviews: [],
  }

  // Fetch LLM config
  let llmConfig: LlmConfig
  try {
    llmConfig = await fetchLlmConfig()
  } catch (err) {
    progress.status = "error"
    progress.errors.push(`Failed to get LLM config: ${err instanceof Error ? err.message : err}`)
    return progress
  }

  // Read project context files
  const [purpose, index, overview] = await Promise.all([
    tryReadFileApi(projectId, "purpose.md"),
    tryReadFileApi(projectId, "wiki/index.md"),
    tryReadFileApi(projectId, "wiki/overview.md"),
  ])
  const schema = ""

  // Process each file
  for (const fileName of files) {
    if (signal?.aborted) break

    progress.currentFile = fileName
    onProgress?.(progress)

    try {
      const sp = normalizePath(fileName)
      const sourceIdentity = sourceIdentityForPath(sp)
      const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)
      const sourceSummaryPath = `wiki/sources/${sourceSummarySlug}.md`

      // Read source content
      const sourceContent = await tryReadFileApi(projectId, `raw/${fileName}`)
      if (!sourceContent) {
        progress.errors.push(`Empty or missing source file: ${fileName}`)
        progress.completedFiles.push(fileName)
        continue
      }

      // ── Cache check: skip re-ingest if source content hasn't changed ──
      const cachedFiles = await checkIngestCache(projectId, sourceIdentity, sourceContent)
      if (cachedFiles !== null) {
        console.log(`[ingest] cache HIT for "${sourceIdentity}" — ${cachedFiles.length} cached files, skipping`)
        progress.pagesWritten += cachedFiles.length
        progress.completedFiles.push(fileName)
        onProgress?.(progress)
        continue
      }

      // ── Compute source budget & handle long sources ──
      const stableContextLength = schema.length + purpose.length + index.length + overview.length
      const sourceBudget = computeIngestSourceBudget(undefined, stableContextLength)
      let sourceContext = sourceContent
      let precomputedAnalysis = ""
      let longSourceCheckpointRel: string | undefined

      if (sourceContent.length > sourceBudget) {
        const longSourcePlan = await analyzeLongSourceInChunks(
          projectId,
          llmConfig,
          purpose,
          schema,
          index,
          sourceIdentity,
          sourceSummarySlug,
          undefined,
          sourceContent,
          sourceBudget,
          (detail) => {
            progress.currentFile = `${fileName} — ${detail}`
            onProgress?.(progress)
          },
          signal,
        )
        if (longSourcePlan.chunked) {
          sourceContext = longSourcePlan.sourceContext
          precomputedAnalysis = longSourcePlan.analysis
          longSourceCheckpointRel = longSourcePlan.checkpointPath
        }
      }

      // ── Step 1: Analysis ──
      progress.currentFile = `${fileName} — ${precomputedAnalysis ? "Consolidating long-source analysis..." : "Analyzing source..."}`
      onProgress?.(progress)

      let analysis = precomputedAnalysis

      if (!analysis) {
        await streamChat(
          llmConfig,
          [
            { role: "system", content: buildAnalysisPrompt(purpose, index, sourceContext) },
            {
              role: "user",
              content: `Analyze this source document:\n\n**File:** ${sourceIdentity}\n\n---\n\n${sourceContext}`,
            },
          ],
          {
            onToken: (token) => { analysis += token },
            onDone: () => {},
            onError: (err) => {
              console.error(`[ingest] Analysis failed for "${sourceIdentity}": ${err.message}`)
            },
          },
          { temperature: 0.1, max_tokens: 4096, signal },
        )
      }

      if (!analysis) {
        progress.errors.push(`Analysis stream failed for "${sourceIdentity}"`)
        progress.completedFiles.push(fileName)
        onProgress?.(progress)
        continue
      }

      // ── Step 2: Generation ──
      progress.currentFile = `${fileName} — Generating wiki pages...`
      onProgress?.(progress)

      let generation = ""

      await streamChat(
        llmConfig,
        [
          { role: "system", content: buildGenerationPrompt(schema, purpose, index, sourceIdentity, overview, sourceContext, sourceSummaryPath) },
          {
            role: "user",
            content: [
              `Source document to process: **${sourceIdentity}**`,
              "",
              "The Stage 1 analysis below is CONTEXT to inform your output. Do NOT echo",
              "its tables, bullet points, or prose. Your output must be FILE/REVIEW",
              "blocks as specified in the system prompt — nothing else.",
              "",
              "## Stage 1 Analysis (context only — do not repeat)",
              "",
              analysis,
              "",
              "## Source Context",
              "",
              sourceContext,
              "",
              "---",
              "",
              `Now emit the FILE blocks for the wiki files derived from **${sourceIdentity}**.`,
              "Your response MUST begin with `---FILE:` as the very first characters.",
              "No preamble. No analysis prose. Start immediately.",
            ].join("\n"),
          },
        ],
        {
          onToken: (token) => { generation += token },
          onDone: () => {},
          onError: (err) => {
            console.error(`[ingest] Generation failed for "${sourceIdentity}": ${err.message}`)
          },
        },
        {
          temperature: 0.1,
          max_tokens: computeIngestGenerationMaxTokens(undefined),
          signal,
        },
      )

      if (!generation) {
        progress.errors.push(`Generation stream failed for "${sourceIdentity}"`)
        progress.completedFiles.push(fileName)
        onProgress?.(progress)
        continue
      }

      // ── Optional: dedicated review suggestion stage ──
      let reviewSuggestionOutput = ""
      if (!signal?.aborted && shouldRunDedicatedReviewStage(generation)) {
        try {
          await streamChat(
            llmConfig,
            [
              {
                role: "system",
                content: buildReviewSuggestionPrompt(
                  purpose,
                  index,
                  sourceIdentity,
                  analysis,
                  sourceContext,
                  generation,
                  undefined,
                ),
              },
              {
                role: "user",
                content: "Emit only high-value REVIEW blocks for follow-up research or unresolved knowledge gaps. Output nothing if there are none.",
              },
            ],
            {
              onToken: (token) => { reviewSuggestionOutput += token },
              onDone: () => {},
              onError: (err) => {
                console.warn(`[ingest] Review suggestion generation failed for "${sourceIdentity}": ${err.message}`)
              },
            },
            {
              temperature: 0.1,
              max_tokens: computeIngestReviewMaxTokens(undefined),
              signal,
            },
          )
        } catch (err) {
          if (signal?.aborted) throw err
          console.warn(`[ingest] Review suggestion generation failed for "${sourceIdentity}":`, err)
        }
      }

      // ── Step 3: Write files ──
      progress.currentFile = `${fileName} — Writing files...`
      onProgress?.(progress)

      const { writtenPaths, warnings: writeWarnings, hardFailures } = await writeFileBlocks(
        projectId,
        generation,
        llmConfig,
        sourceIdentity,
        sourceSummaryPath,
        signal,
      )

      if (writeWarnings.length > 0) {
        const summary = writeWarnings.length === 1
          ? writeWarnings[0]
          : `${writeWarnings.length} ingest warnings: ${writeWarnings.slice(0, 2).join(" · ")}${writeWarnings.length > 2 ? ` … (+${writeWarnings.length - 2} more in console)` : ""}`
        console.warn(`[ingest] ${summary}`)
      }

      // Ensure source summary page exists
      const hasSourceSummary = writtenPaths.some((p) => normalizePath(p) === sourceSummaryPath)

      if (!hasSourceSummary && !signal?.aborted) {
        const date = new Date().toISOString().slice(0, 10)
        const fallbackContent = [
          "---",
          `type: source`,
          `title: "Source: ${sourceIdentity}"`,
          `created: ${date}`,
          `updated: ${date}`,
          `sources: ["${sourceIdentity}"]`,
          `tags: []`,
          `related: []`,
          "---",
          "",
          `# Source: ${sourceIdentity}`,
          "",
          analysis ? analysis.slice(0, 3000) : "(Analysis not available)",
          "",
        ].join("\n")
        try {
          await writeFileApi(projectId, sourceSummaryPath, fallbackContent)
          writtenPaths.push(sourceSummaryPath)
        } catch {
          // non-critical
        }
      }

      progress.pagesWritten += writtenPaths.length

      // ── Wikilink auto-enrichment ──
      if (!signal?.aborted && index) {
        for (const pagePath of writtenPaths) {
          if (isLogPath(pagePath) || isListingPath(pagePath)) continue
          try {
            const pageContent = await readFileApi(projectId, pagePath)
            if (!pageContent) continue
            const linkCount = await enrichWithWikilinks(
              projectId,
              pagePath,
              pageContent,
              index,
              llmConfig,
              writeFileApi,
              readFileApi,
              signal,
            )
            if (linkCount > 0) {
              console.log(`[ingest] enriched "${pagePath}" with ${linkCount} wikilink(s)`)
            }
          } catch (err) {
            console.warn(
              `[ingest] wikilink enrichment failed for "${pagePath}": ${err instanceof Error ? err.message : err}`,
            )
          }
        }
      }

      // ── Parse REVIEW blocks from generation and review output ──
      const reviews = [
        ...parseReviewBlocks(generation, sourceIdentity),
        ...parseReviewBlocks(reviewSuggestionOutput, sourceIdentity),
      ]
      if (reviews.length > 0) {
        progress.reviews.push(...reviews)
      }

      // ── Save to cache ──
      if (writtenPaths.length > 0 && hardFailures.length === 0) {
        await saveIngestCache(projectId, sourceIdentity, sourceContent, writtenPaths)
        if (longSourceCheckpointRel) {
          await clearLongSourceCheckpoint(projectId, longSourceCheckpointRel)
        }
      } else if (hardFailures.length > 0) {
        console.warn(
          `[ingest] Skipping cache save for "${sourceIdentity}" — ${hardFailures.length} block(s) failed to write: ${hardFailures.join(", ")}`,
        )
      }

      progress.completedFiles.push(fileName)
      onProgress?.(progress)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (signal?.aborted && msg.includes("cancel")) break
      progress.errors.push(`Ingestion failed for '${fileName}': ${msg}`)
      progress.completedFiles.push(fileName)
      onProgress?.(progress)
    }
  }

  progress.status = progress.errors.length > 0 && progress.completedFiles.length === 0 ? "error" : "done"
  progress.currentFile = ""
  onProgress?.(progress)
  return progress
}
