import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import "@/components/markdown/conversation-markdown.css";

export function StockVibeReport({ children }: { children: string }) {
  return (
    <div className="conversation-markdown min-w-0 max-w-full break-words text-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: ({ alt }) => <span>{alt}</span>,
          a: ({ href, children: label }) => /^https?:\/\//i.test(href ?? "")
            ? <a href={href} target="_blank" rel="noreferrer" className="rounded-sm no-underline hover:bg-accent hover:no-underline">{label}</a>
            : <span>{label}</span>,
          pre: ({ children: code }) => <pre className="max-w-full overflow-x-auto rounded bg-muted/40 p-3 text-caption" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{code}</pre>,
          table: ({ children: rows }) => <div className="max-w-full overflow-x-auto"><table className="w-full border-collapse [&_th]:border-b [&_td]:border-b [&_th]:p-2 [&_td]:p-2 [&_th]:text-left">{rows}</table></div>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
