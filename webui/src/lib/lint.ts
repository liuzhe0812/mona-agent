export interface LintResult {
  type: "orphan" | "broken-link" | "no-outlinks"
  severity: "warning" | "info"
  page: string
  detail: string
}

interface WikiPageData {
  path: string
  related: string[]
}

export function lintWiki(
  pages: WikiPageData[],
  slugToPath: Map<string, string>,
): LintResult[] {
  const results: LintResult[] = []
  const pagePaths = new Set(pages.map((p) => p.path))
  const incomingLinks = new Map<string, Set<string>>()

  for (const page of pages) {
    for (const target of page.related) {
      const resolved = slugToPath.get(target.toLowerCase()) ?? target
      if (!incomingLinks.has(resolved)) incomingLinks.set(resolved, new Set())
      incomingLinks.get(resolved)!.add(page.path)
    }
  }

  for (const page of pages) {
    for (const target of page.related) {
      const resolved = slugToPath.get(target.toLowerCase()) ?? target
      if (!pagePaths.has(resolved)) {
        results.push({
          type: "broken-link",
          severity: "warning",
          page: page.path,
          detail: `链接到不存在的页面: ${target}`,
        })
      }
    }
    const isIncoming =
      incomingLinks.has(page.path) && incomingLinks.get(page.path)!.size > 0
    const isStructural = ["index.md", "overview.md", "log.md"].some((s) =>
      page.path.endsWith(s),
    )
    if (!isIncoming && !isStructural) {
      results.push({
        type: "orphan",
        severity: "info",
        page: page.path,
        detail: "没有任何页面链接到此页面",
      })
    }
    if (page.related.length === 0 && !isStructural) {
      results.push({
        type: "no-outlinks",
        severity: "info",
        page: page.path,
        detail: "此页面没有链接到其他页面",
      })
    }
  }
  return results
}
