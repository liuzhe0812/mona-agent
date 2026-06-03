export function sanitizeIngestedFileContent(content: string): string {
  let cleaned = content
  cleaned = stripOuterCodeFence(cleaned)
  cleaned = stripFrontmatterKeyPrefix(cleaned)
  cleaned = addMissingOpeningFrontmatterFence(cleaned)
  cleaned = repairWikilinkListsInFrontmatter(cleaned)
  return cleaned
}

function stripOuterCodeFence(content: string): string {
  const open = content.match(/^[ \t]*```(?:yaml|md|markdown)?[ \t]*\r?\n/)
  if (!open) return content
  const afterOpen = content.slice(open[0].length)
  const close = afterOpen.match(/\r?\n[ \t]*```[ \t]*\r?\n?\s*$/)
  if (!close) return content
  return afterOpen.slice(0, close.index)
}

function stripFrontmatterKeyPrefix(content: string): string {
  const m = content.match(/^[ \t]*frontmatter\s*:\s*\r?\n(?=[ \t]*---\s*\r?\n)/)
  if (!m) return content
  return content.slice(m[0].length)
}

function addMissingOpeningFrontmatterFence(content: string): string {
  if (/^[ \t]*---\s*(\r?\n|$)/.test(content)) return content
  const lines = content.split(/\r?\n/)
  const firstContentIdx = lines.findIndex((line) => line.trim().length > 0)
  if (firstContentIdx < 0) return content
  const first = lines[firstContentIdx].trim()
  if (!/^(type|title|created|updated|tags|related|sources)\s*:/i.test(first)) {
    return content
  }
  const searchEnd = Math.min(lines.length, firstContentIdx + 30)
  for (let i = firstContentIdx + 1; i < searchEnd; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed === "---") {
      return `---\n${lines.slice(firstContentIdx).join("\n")}`
    }
    if (/^#{1,6}\s+/.test(trimmed)) break
  }
  return content
}

function repairWikilinkListsInFrontmatter(content: string): string {
  const fmRe = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/
  const m = content.match(fmRe)
  if (!m) return content
  const repairedPayload = m[1]
    .split("\n")
    .map((line) => {
      const lm = line.match(
        /^(\s*[A-Za-z_][\w-]*\s*:\s*)(\[\[[^\]]+\]\](?:\s*,\s*\[\[[^\]]+\]\])+)\s*$/,
      )
      if (!lm) return line
      const items = lm[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => `"${s}"`)
        .join(", ")
      return `${lm[1]}[${items}]`
    })
    .join("\n")
  return (
    content.slice(0, m.index! + 4) +
    repairedPayload +
    content.slice(m.index! + 4 + m[1].length)
  )
}
