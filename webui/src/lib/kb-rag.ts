/**
 * KB RAG — retrieve relevant wiki pages and build system prompt for chat.
 */

import { searchKb, getWikiPage } from "@/lib/kb-api"

export interface KBRagContext {
  projectId: string
  projectName: string
  pages: Array<{ path: string; title: string; snippet: string; content: string }>
}

export async function retrieveKbContext(
  projectId: string,
  query: string,
  maxPages: number = 5,
): Promise<KBRagContext | null> {
  const results = await searchKb(projectId, query, maxPages)
  if (results.results.length === 0) return null

  const pages = await Promise.all(
    results.results.map(async (r) => {
      let content = ""
      try {
        const page = await getWikiPage(projectId, r.path)
        content = page.body.slice(0, 3000)
      } catch {
        content = r.snippet
      }
      return { path: r.path, title: r.title, snippet: r.snippet, content }
    }),
  )

  return { projectId, projectName: projectId, pages }
}

export function buildKbSystemPrompt(context: KBRagContext): string {
  const pageSections = context.pages
    .map((p) => `### ${p.title} (${p.path})\n${p.content}`)
    .join("\n\n---\n\n")

  return [
    "以下是从用户知识库中检索到的相关内容，请基于这些内容回答用户的问题。",
    "如果知识库内容不足以回答，请如实说明。",
    "引用知识库内容时，请标注来源页面。",
    "",
    `知识库: ${context.projectName}`,
    "",
    pageSections,
  ].join("\n")
}
