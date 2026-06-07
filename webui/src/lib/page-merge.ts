/**
 * Merge a wiki page that the LLM just generated with whatever's already on disk.
 * Ported from llm_wiki src/lib/page-merge.ts
 *
 * Three layers of protection:
 *   1. Frontmatter array fields (sources / tags / related) — always union-merged
 *   2. Body — if old and new bodies differ, ask the LLM to produce a coherent merge
 *   3. Locked frontmatter fields (type / title / created) — existing values forced back
 */

import { mergeArrayFieldsIntoContent } from "@/lib/sources-merge"

const UNION_FIELDS = ["sources", "tags", "related"] as const
const LOCKED_FIELDS = ["type", "title", "created"] as const
const BODY_SHRINK_THRESHOLD = 0.7

export interface MergeFn {
  (
    existingContent: string,
    incomingContent: string,
    sourceFileName: string,
    signal?: AbortSignal,
  ): Promise<string>
}

export interface MergePageOptions {
  sourceFileName: string
  pagePath: string
  signal?: AbortSignal
  backup?: (existingContent: string) => Promise<void>
  today?: () => string
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string | null> | null; body: string } {
  if (!content.startsWith("---")) return { frontmatter: null, body: content }
  const end = content.indexOf("---", 3)
  if (end === -1) return { frontmatter: null, body: content }
  const yamlText = content.slice(3, end).trim()
  const body = content.slice(end + 3).trim()
  const frontmatter: Record<string, string> = {}
  for (const line of yamlText.split("\n")) {
    const stripped = line.trim()
    if (!stripped || stripped.startsWith("-")) continue
    if (stripped.includes(":")) {
      const [key, ...rest] = stripped.split(":")
      const value = rest.join(":").trim()
      if (value) frontmatter[key.trim()] = value
    }
  }
  return { frontmatter, body }
}

export async function mergePageContent(
  newContent: string,
  existingContent: string | null,
  merger: MergeFn,
  opts: MergePageOptions,
): Promise<string> {
  if (!existingContent) return newContent
  if (newContent === existingContent) return existingContent

  const arrayMerged = mergeArrayFieldsIntoContent(
    newContent,
    existingContent,
    [...UNION_FIELDS],
  )

  const oldParsed = parseFrontmatter(existingContent)
  const arrayMergedParsed = parseFrontmatter(arrayMerged)
  if (oldParsed.body.trim() === arrayMergedParsed.body.trim()) {
    return arrayMerged
  }

  let llmOutput: string
  try {
    llmOutput = await merger(
      existingContent,
      arrayMerged,
      opts.sourceFileName,
      opts.signal,
    )
  } catch (err) {
    console.warn(
      `[page-merge] LLM merge failed for ${opts.pagePath}, falling back: ${err instanceof Error ? err.message : err}`,
    )
    await tryBackup(opts, existingContent)
    return arrayMerged
  }

  const llmParsed = parseFrontmatter(llmOutput)
  if (llmParsed.frontmatter === null) {
    console.warn(`[page-merge] LLM output for ${opts.pagePath} has no frontmatter — rejecting`)
    await tryBackup(opts, existingContent)
    return arrayMerged
  }

  const oldBodyLen = oldParsed.body.length
  const newBodyLen = arrayMergedParsed.body.length
  const llmBodyLen = llmParsed.body.length
  const minThreshold = Math.max(oldBodyLen, newBodyLen) * BODY_SHRINK_THRESHOLD
  if (llmBodyLen < minThreshold) {
    console.warn(
      `[page-merge] LLM merge for ${opts.pagePath} produced body ${llmBodyLen} chars, below threshold ${minThreshold.toFixed(0)} — rejecting`,
    )
    await tryBackup(opts, existingContent)
    return arrayMerged
  }

  let final = llmOutput
  for (const field of LOCKED_FIELDS) {
    const existingValue = oldParsed.frontmatter?.[field]
    if (typeof existingValue === "string" && existingValue !== "") {
      final = setFrontmatterScalar(final, field, existingValue)
    }
  }

  final = mergeArrayFieldsIntoContent(final, arrayMerged, [...UNION_FIELDS])

  const todayFn = opts.today ?? defaultToday
  final = setFrontmatterScalar(final, "updated", todayFn())
  return final
}

async function tryBackup(opts: MergePageOptions, existingContent: string): Promise<void> {
  if (!opts.backup) return
  try {
    await opts.backup(existingContent)
  } catch (err) {
    console.warn(`[page-merge] backup failed for ${opts.pagePath}: ${err instanceof Error ? err.message : err}`)
  }
}

function defaultToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function setFrontmatterScalar(
  content: string,
  fieldName: string,
  value: string,
): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/)
  if (!fmMatch) return content
  const [, openDelim, fmBody, closeDelim] = fmMatch
  const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const newLine = `${fieldName}: ${value}`
  const lineRe = new RegExp(`^${escapedName}:\\s*(?!\\[)([^\\n]*)`, "m")
  if (lineRe.test(fmBody)) {
    const rewritten = fmBody.replace(lineRe, newLine)
    return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
  }
  const rewritten = `${fmBody}\n${newLine}`
  return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
}
