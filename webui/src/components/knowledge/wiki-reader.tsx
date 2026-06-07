import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { MermaidDiagram } from "./mermaid-diagram"

interface WikiReaderProps {
  body: string
}

/** Convert [[wikilink]] syntax to markdown links before ReactMarkdown processes them. */
function preprocessWikilinks(text: string): string {
  return text.replace(/\[\[([^\]]+)\]\]/g, (_match, slug: string) => {
    // Handle [[slug|display text]] format
    const pipeIdx = slug.indexOf("|")
    const displayText = pipeIdx >= 0 ? slug.slice(pipeIdx + 1).trim() : slug.trim()
    const linkSlug = pipeIdx >= 0 ? slug.slice(0, pipeIdx).trim() : slug.trim()
    return `[${displayText}](wiki://${linkSlug})`
  })
}

export function WikiReader({ body }: WikiReaderProps) {
  const processed = preprocessWikilinks(body)

  return (
    <article className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? "")
            const lang = match?.[1]
            const code = String(children).replace(/\n$/, "")

            if (lang === "mermaid") {
              return <MermaidDiagram code={code} />
            }

            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
          a({ href, children }) {
            if (href?.startsWith("wiki://")) {
              const pagePath = href.slice("wiki://".length)
              return (
                <a
                  href="#"
                  className="cursor-pointer text-primary underline decoration-primary/30 hover:decoration-primary"
                  onClick={(e) => {
                    e.preventDefault()
                    // Navigate via the global KB navigation helper
                    const switchToWiki = (window as unknown as Record<string, unknown>).__kbSwitchToWiki as
                      | ((path?: string) => void)
                      | undefined
                    switchToWiki?.(pagePath)
                  }}
                >
                  {children}
                </a>
              )
            }
            return <a href={href}>{children}</a>
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </article>
  )
}
