/**
 * REVIEW block parser — extracts structured review items from LLM output.
 *
 * REVIEW blocks follow the format:
 *   ---REVIEW: type | Title---
 *   Description text.
 *   OPTIONS: Create Page | Skip
 *   PAGES: wiki/page1.md, wiki/page2.md
 *   SEARCH: query 1 | query 2 | query 3
 *   ---END REVIEW---
 */

export interface ReviewOption {
  label: string
  action: string
}

export interface ParsedReviewItem {
  type: "contradiction" | "duplicate" | "missing-page" | "suggestion" | "confirm"
  title: string
  description: string
  sourcePath: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: ReviewOption[]
}

const REVIEW_BLOCK_REGEX =
  /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g

export function parseReviewBlocks(
  text: string,
  sourcePath: string,
): ParsedReviewItem[] {
  const items: ParsedReviewItem[] = []
  const matches = text.matchAll(REVIEW_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const title = match[2].trim()
    const body = match[3].trim()

    const type = (
      ["contradiction", "duplicate", "missing-page", "suggestion"].includes(rawType)
        ? rawType
        : "confirm"
    ) as ParsedReviewItem["type"]

    const optionsMatch = body.match(/^OPTIONS:\s*(.+)$/m)
    const options = optionsMatch
      ? optionsMatch[1].split("|").map((o) => {
          const label = o.trim()
          return { label, action: label }
        })
      : [
          { label: "创建页面", action: "create" },
          { label: "跳过", action: "skip" },
        ]

    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    const searchMatch = body.match(/^SEARCH:\s*(.+)$/m)
    const searchQueries = searchMatch
      ? searchMatch[1]
          .split("|")
          .map((q) => q.trim())
          .filter((q) => q.length > 0)
      : undefined

    const description = body
      .replace(/^OPTIONS:.*$/m, "")
      .replace(/^PAGES:.*$/m, "")
      .replace(/^SEARCH:.*$/m, "")
      .trim()

    items.push({
      type,
      title,
      description,
      sourcePath,
      affectedPages,
      searchQueries,
      options,
    })
  }

  return items
}
