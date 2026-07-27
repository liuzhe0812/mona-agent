/**
 * Materials ingest pipeline — simplified port of ingest.ts.
 *
 * 流程：分析 → 生成 → 写入。无 review / dedup / lint / cache 阶段
 * （按资料库设计文档要求）。
 *
 * - LLM 配置来自 `/api/materials/llm-config`
 * - 源文本来自 materials text/ 目录
 * - 生成的 wiki 页面写入 materials wiki/ 目录
 * - 复用 ingest.ts 的纯函数：parseFileBlocks、buildAnalysisPrompt、
 *   buildGenerationPrompt、computeIngestSourceBudget、
 *   computeIngestGenerationMaxTokens、languageRule、isSafeIngestPath
 */

import { streamChat, type LlmConfig } from "@/lib/llm-client"
import { httpFetch } from "@/lib/tauri"
import { getGatewayHttpBase } from "@/lib/api"
import {
  getMaterialsText,
  writeWikiPage,
} from "@/lib/materials-api"
import {
  buildAnalysisPrompt,
  buildGenerationPrompt,
  computeIngestGenerationMaxTokens,
  isSafeIngestPath,
  parseFileBlocks,
} from "@/lib/ingest"

// ─── Constants ────────────────────────────────────────────────────────

/** 单文件源文本上限：超出则截断（避免上下文爆炸）。 */
const MAX_SOURCE_CHARS = 200_000

// ─── Types ────────────────────────────────────────────────────────────

export interface MaterialsIngestProgress {
  status: "running" | "done" | "error"
  currentFile: string
  completedFiles: string[]
  errors: string[]
  pagesWritten: number
}

export interface MaterialsIngestResult extends MaterialsIngestProgress {
  /** 已经生成 wiki 页面的相对路径列表（不含 wiki/ 前缀）。 */
  writtenPaths: string[]
}

// ─── LLM config ────────────────────────────────────────────────────────

async function fetchLlmConfig(): Promise<LlmConfig> {
  const base = await getGatewayHttpBase()
  const resp = await httpFetch(`${base}/api/materials/llm-config`)
  if (!resp.ok) throw new Error(`Failed to fetch LLM config: ${resp.status}`)
  const data = await resp.json()
  return {
    model: data.model,
    apiKey: data.apiKey,
    apiBase: data.apiBase,
    providerName: data.providerName,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * 将 raw 文件相对路径转换为 text 文件相对路径。
 * raw/docs/foo.pdf → text/docs/foo.pdf.md
 */
function rawPathToTextPath(rawRel: string): string {
  return `${rawRel}.md`
}

/**
 * 去掉 frontmatter，只保留正文。
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content
  const end = content.indexOf("---", 3)
  if (end === -1) return content
  // 跳过结束 `---` 和后续换行
  const after = content.slice(end + 3)
  return after.startsWith("\n") ? after.slice(1) : after
}

/**
 * 将 LLM 输出的 FILE 块路径（形如 `wiki/entities/foo.md`）转换为
 * 相对于 wiki/ 目录的路径（`entities/foo.md`），用于 writeWikiPage。
 */
function wikiBlockPathToRelPath(blockPath: string): string | null {
  if (!isSafeIngestPath(blockPath)) return null
  const normalized = blockPath.replace(/\\/g, "/")
  if (!normalized.startsWith("wiki/")) return null
  return normalized.slice("wiki/".length)
}

/**
 * 从 raw 相对路径推导源标识（用于 sources 字段）。
 * raw/docs/foo.pdf → foo.pdf
 */
function sourceFileNameFromRawPath(rawRel: string): string {
  const normalized = rawRel.replace(/\\/g, "/")
  return normalized.split("/").pop() ?? normalized
}

/**
 * 从 raw 相对路径推导源摘要 slug。
 * raw/docs/foo.pdf → foo
 */
function sourceSummarySlugFromRawPath(rawRel: string): string {
  const fileName = sourceFileNameFromRawPath(rawRel)
  return fileName.replace(/\.[^.]+$/, "")
}

function trimLongText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n\n[...trimmed for prompt budget...]`
}

// ─── 写入 FILE blocks ──────────────────────────────────────────────────

async function writeFileBlocks(
  text: string,
  signal?: AbortSignal,
): Promise<{ writtenPaths: string[]; warnings: string[] }> {
  const { blocks, warnings: parseWarnings } = parseFileBlocks(text)
  const warnings = [...parseWarnings]
  const writtenPaths: string[] = []

  for (const { path: blockPath, content } of blocks) {
    if (signal?.aborted) break

    const relPath = wikiBlockPathToRelPath(blockPath)
    if (!relPath) {
      warnings.push(`Skipped unsafe or non-wiki path: ${blockPath}`)
      continue
    }

    try {
      await writeWikiPage({ path: relPath, content })
      writtenPaths.push(relPath)
    } catch (err) {
      const msg = `Failed to write "${relPath}": ${err instanceof Error ? err.message : String(err)}`
      console.error(`[materials-ingest] ${msg}`)
      warnings.push(msg)
    }
  }

  return { writtenPaths, warnings }
}

// ─── 单文件处理 ─────────────────────────────────────────────────────────

async function ingestOneFile(
  llmConfig: LlmConfig,
  rawRel: string,
  onProgress?: (detail: string) => void,
  signal?: AbortSignal,
): Promise<{ writtenPaths: string[]; error?: string }> {
  const sourceFileName = sourceFileNameFromRawPath(rawRel)
  const sourceSummarySlug = sourceSummarySlugFromRawPath(rawRel)
  const sourceSummaryPath = `wiki/sources/${sourceSummarySlug}.md`

  // 1. 读取提取文本
  onProgress?.(`Reading extracted text...`)
  const textResp = await getMaterialsText(rawPathToTextPath(rawRel))
  const rawTextContent = stripFrontmatter(textResp.content || "")
  if (!rawTextContent.trim()) {
    return { writtenPaths: [], error: `Empty extracted text for ${rawRel}` }
  }

  // 2. 截断过长的源文本（避免上下文爆炸）
  const sourceContent = trimLongText(rawTextContent, MAX_SOURCE_CHARS)
  if (sourceContent !== rawTextContent) {
    console.warn(
      `[materials-ingest] ${rawRel} truncated from ${rawTextContent.length} to ${MAX_SOURCE_CHARS} chars`,
    )
  }

  // 3. Stage 1: 分析
  onProgress?.(`Analyzing source...`)
  let analysis = ""
  let analysisErrorMsg: string | null = null
  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildAnalysisPrompt("", "", sourceContent) },
      {
        role: "user",
        content: `Analyze this source document:\n\n**File:** ${sourceFileName}\n\n---\n\n${sourceContent}`,
      },
    ],
    {
      onToken: (token) => { analysis += token },
      onDone: () => {},
      onError: (err) => {
        analysisErrorMsg = err instanceof Error ? err.message : String(err)
      },
    },
    { temperature: 0.1, max_tokens: 4096, signal },
  )

  if (signal?.aborted) throw new Error("Ingest cancelled")
  if (analysisErrorMsg || !analysis) {
    return {
      writtenPaths: [],
      error: `Analysis failed for ${sourceFileName}: ${analysisErrorMsg ?? "empty response"}`,
    }
  }

  // 4. Stage 2: 生成
  onProgress?.(`Generating wiki pages...`)
  let generation = ""
  let generationErrorMsg: string | null = null
  await streamChat(
    llmConfig,
    [
      {
        role: "system",
        content: buildGenerationPrompt(
          "", // schema
          "", // purpose
          "", // index
          sourceFileName,
          undefined, // overview
          sourceContent,
          sourceSummaryPath,
        ),
      },
      {
        role: "user",
        content: [
          `Source document to process: **${sourceFileName}**`,
          "",
          "The Stage 1 analysis below is CONTEXT to inform your output. Do NOT echo",
          "its tables, bullet points, or prose. Your output must be FILE blocks as",
          "specified in the system prompt — nothing else.",
          "",
          "## Stage 1 Analysis (context only — do not repeat)",
          "",
          analysis,
          "",
          "---",
          "",
          `Now emit the FILE blocks for the wiki files derived from **${sourceFileName}**.`,
          "Your response MUST begin with `---FILE:` as the very first characters.",
          "No preamble. No analysis prose. Start immediately.",
        ].join("\n"),
      },
    ],
    {
      onToken: (token) => { generation += token },
      onDone: () => {},
      onError: (err) => {
        generationErrorMsg = err instanceof Error ? err.message : String(err)
      },
    },
    {
      temperature: 0.1,
      max_tokens: computeIngestGenerationMaxTokens(undefined),
      signal,
    },
  )

  if (signal?.aborted) throw new Error("Ingest cancelled")
  if (generationErrorMsg || !generation) {
    return {
      writtenPaths: [],
      error: `Generation failed for ${sourceFileName}: ${generationErrorMsg ?? "empty response"}`,
    }
  }

  // 5. 写入 FILE blocks
  onProgress?.(`Writing wiki pages...`)
  const { writtenPaths, warnings } = await writeFileBlocks(generation, signal)
  if (warnings.length > 0) {
    console.warn(
      `[materials-ingest] ${warnings.length} warning(s) for ${sourceFileName}:`,
      warnings,
    )
  }

  // 6. 若 LLM 未生成 sources/<slug>.md，写一个最小的兜底页面
  const expectedSummaryRel = sourceSummaryPath.replace(/^wiki\//, "")
  const hasSummary = writtenPaths.some((p) => p === expectedSummaryRel)
  if (!hasSummary && !signal?.aborted) {
    const date = new Date().toISOString().slice(0, 10)
    const fallbackContent = [
      "---",
      `type: source`,
      `title: "Source: ${sourceFileName}"`,
      `created: ${date}`,
      `updated: ${date}`,
      `sources: ["${sourceFileName}"]`,
      `tags: []`,
      `related: []`,
      "---",
      "",
      `# Source: ${sourceFileName}`,
      "",
      analysis.slice(0, 3000),
      "",
    ].join("\n")
    try {
      await writeWikiPage({ path: expectedSummaryRel, content: fallbackContent })
      writtenPaths.push(expectedSummaryRel)
    } catch (err) {
      console.warn(
        `[materials-ingest] failed to write fallback source summary for ${sourceFileName}:`,
        err,
      )
    }
  }

  return { writtenPaths }
}

// ─── Main export ──────────────────────────────────────────────────────

export async function ingestMaterialsFiles(
  files: string[],
  onProgress?: (progress: MaterialsIngestProgress) => void,
  signal?: AbortSignal,
): Promise<MaterialsIngestResult> {
  const progress: MaterialsIngestProgress = {
    status: "running",
    currentFile: "",
    completedFiles: [],
    errors: [],
    pagesWritten: 0,
  }

  // Fetch LLM config
  let llmConfig: LlmConfig
  try {
    llmConfig = await fetchLlmConfig()
  } catch (err) {
    progress.status = "error"
    progress.errors.push(`Failed to get LLM config: ${err instanceof Error ? err.message : err}`)
    return { ...progress, writtenPaths: [] }
  }

  const allWrittenPaths: string[] = []

  for (const rawRel of files) {
    if (signal?.aborted) break

    progress.currentFile = rawRel
    onProgress?.(progress)

    try {
      const { writtenPaths, error } = await ingestOneFile(
        llmConfig,
        rawRel,
        (detail) => {
          progress.currentFile = `${rawRel} — ${detail}`
          onProgress?.(progress)
        },
        signal,
      )
      allWrittenPaths.push(...writtenPaths)
      progress.pagesWritten += writtenPaths.length
      if (error) {
        progress.errors.push(error)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (signal?.aborted && msg.includes("cancel")) break
      progress.errors.push(`${rawRel}: ${msg}`)
    }

    progress.currentFile = ""
    progress.completedFiles.push(rawRel)
    onProgress?.(progress)
  }

  progress.status = progress.errors.length > 0 && progress.completedFiles.length === 0
    ? "error"
    : "done"
  onProgress?.(progress)

  return { ...progress, writtenPaths: allWrittenPaths }
}
