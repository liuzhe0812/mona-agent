import { Children, isValidElement, useMemo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { ChatChart } from "@/components/ChatChart";
import { CodeBlock } from "@/components/CodeBlock";
import { FileReferenceChip, isLikelyFilePath } from "@/components/FileReferenceChip";
import { MermaidDiagram, unwrapMermaidPre } from "@/components/common/mermaid-diagram";
import { isTauri, openPathWithSystemApp, openExternalUrl, revealItemInDir } from "@/lib/tauri";
import { useMaterialsOpenStore } from "@/lib/materials-open-store";
import { useWorkspaceStore, resolveToAbsolutePath } from "@/lib/workspace-store";
import { cn } from "@/lib/utils";

import "katex/dist/katex.min.css";

interface MarkdownTextRendererProps {
  children: string;
  className?: string;
  highlightCode?: boolean;
}

const remarkPlugins = [remarkBreaks, remarkGfm, remarkMath];

/**
 * Allow a small set of safe HTML tags that LLMs commonly emit inside tables
 * (e.g. `<br>` for intra-cell line breaks).  Everything else is stripped.
 */
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "br", "sub", "sup", "mark", "abbr"],
  attributes: {
    ...defaultSchema.attributes,
    abbr: [...(defaultSchema.attributes?.abbr ?? []), "title"],
    mark: [],
    sub: [],
    sup: [],
    a: [...(defaultSchema.attributes?.a ?? []), "href"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "mona"],
  },
} as typeof defaultSchema;

const rehypePlugins: import("unified").PluggableList = [
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema],
  rehypeKatex,
];

function markdownUrlTransform(url: string): string {
  if (url.startsWith("mona:material?") || url.startsWith("mona:email?")) {
    return url;
  }
  return defaultUrlTransform(url);
}

/**
 * Heavy markdown stack (GFM, math, KaTeX, syntax highlighting) kept in a
 * separate chunk so the app shell can paint sooner on refresh.
 */
export default function MarkdownTextRenderer({
  children,
  className,
  highlightCode = true,
}: MarkdownTextRendererProps) {
  const components = useMemo<Components>(
    () => ({
      code({ className: cls, children: kids, ...props }) {
        const match = /language-(\w+)/.exec(cls || "");
        if (match) {
          const code = String(kids).replace(/\n$/, "");
          if (match[1].toLowerCase() === "chart" && highlightCode) {
            return <ChatChart source={code} />;
          }
          if (match[1].toLowerCase() === "mermaid" && highlightCode) {
            return <MermaidDiagram code={code} />;
          }
          return (
            <CodeBlock
              language={match[1]}
              code={code}
              className="my-3"
              highlight={highlightCode}
            />
          );
        }
        const raw = String(kids).replace(/\n$/, "");
        if (isLikelyFilePath(raw)) {
          return <FileReferenceChip path={raw} />;
        }
        /** Plain fenced ``` blocks (no language) & wide one-liners: block monospace, not inline pill. */
        const widePlainBlock = raw.includes("\n") || raw.length > 120;
        if (widePlainBlock) {
          return (
            <code
              className={cn(
                "block min-w-0 whitespace-pre bg-transparent p-0 font-mono text-[0.8125rem]",
                "leading-snug text-inherit",
                cls,
              )}
              {...props}
            >
              {kids}
            </code>
          );
        }
        return (
          <code
            className={cn(
              "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]",
              cls,
            )}
            {...props}
          >
            {kids}
          </code>
        );
      },
      pre({ children: markdownChildren }) {
        const mermaid = unwrapMermaidPre(markdownChildren);
        if (mermaid) return <>{mermaid}</>;
        const kids = Children.toArray(markdownChildren);
        const lone = kids.length === 1 ? kids[0] : null;
        /** Highlighted fences render ``CodeBlock`` (block shell); skip invalid ``<pre><div>``. */
        if (
          lone != null
          && isValidElement(lone)
          && (lone.type === CodeBlock || lone.type === ChatChart)
        ) {
          return <>{markdownChildren}</>;
        }
        return (
          <pre
            className={cn(
              "my-3 overflow-x-auto rounded-lg bg-muted/35",
              "p-3 font-mono text-[0.8125rem] leading-snug text-foreground/90",
              "whitespace-pre [overflow-wrap:normal]",
            )}
          >
            {markdownChildren}
          </pre>
        );
      },
      a({ href, children: markdownChildren, ...props }) {
        if (href && isLikelyFilePath(href)) {
          return (
            <FileLink href={href}>{markdownChildren}</FileLink>
          );
        }
        if (href && href.startsWith("mona:material?")) {
          return (
            <MonaMaterialLink href={href}>{markdownChildren}</MonaMaterialLink>
          );
        }
        if (href && (href.startsWith("mona:email?") || href.startsWith("#mona-email:"))) {
          return (
            <MonaEmailLink href={href}>{markdownChildren}</MonaEmailLink>
          );
        }
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline underline-offset-2 hover:opacity-80"
            onClick={(e) => {
              // In Tauri desktop, <a target="_blank"> opens an empty app
              // window instead of the system browser. Intercept and route
              // through the opener plugin so http(s) links launch the
              // user's default browser.
              if (!isTauri()) return;
              const url = typeof href === "string" ? href : "";
              if (!url || !/^https?:\/\//i.test(url)) return;
              e.preventDefault();
              void openExternalUrl(url);
            }}
            {...props}
          >
            {markdownChildren}
          </a>
        );
      },
    }),
    [highlightCode],
  );

  return (
    <div
      className={cn(
        "markdown-content prose min-w-0 max-w-none dark:prose-invert break-words",
        "prose-headings:mt-4 prose-headings:mb-2 prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-h4:text-[13px]",
        "prose-p:my-2",
        "prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5",
        "prose-blockquote:my-3 prose-blockquote:border-l-2 prose-blockquote:font-normal",
        "prose-blockquote:not-italic prose-blockquote:text-foreground/80",
        "prose-a:text-primary prose-a:underline-offset-2 hover:prose-a:opacity-80",
        "prose-hr:my-6",
        "prose-pre:my-0 prose-pre:bg-transparent prose-pre:p-0",
        "prose-code:before:content-none prose-code:after:content-none prose-code:font-normal",
        "prose-table:my-3 prose-th:text-left prose-th:font-medium",
        className,
      )}
      style={{ lineHeight: "var(--cjk-line-height)" }}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function FileLink({ href, children }: { href: string; children: React.ReactNode }) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const absPath = resolveToAbsolutePath(href, workspacePath);
  const handleClick = (e: React.MouseEvent) => {
    if (!isTauri()) return;
    e.preventDefault();
    void openPathWithSystemApp(absPath);
  };
  const handleContextMenu = (e: React.MouseEvent) => {
    if (!isTauri()) return;
    e.preventDefault();
    void revealItemInDir(absPath);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      className="cursor-pointer text-primary underline underline-offset-2 hover:opacity-80"
      title={isTauri() ? `${absPath} · 点击打开，右键在文件夹中显示` : absPath}
    >
      {children}
    </span>
  );
}

function MonaMaterialLink({ href, children }: { href: string; children: React.ReactNode }) {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 格式：mona:material?path=<urlencoded raw/...|wiki/...>&location=<label>
    const params = new URLSearchParams(href.slice("mona:material?".length));
    const linkPath = params.get("path");
    if (!linkPath) return;
    const location = params.get("location") ?? undefined;
    const knowledgeBaseId = params.get("knowledgeBaseId") ?? undefined;
    const agentId = params.get("agentId") ?? undefined;
    const { request } = useMaterialsOpenStore.getState();
    if (linkPath.startsWith("wiki/")) {
      request({ kind: "wiki", path: linkPath.slice("wiki/".length), location, knowledgeBaseId, agentId });
    } else {
      request({ kind: "raw", path: linkPath, location, knowledgeBaseId, agentId });
    }
  };
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleClick}
      className="cursor-pointer text-primary underline underline-offset-2 hover:opacity-80"
      title="点击打开资料对应位置"
    >
      {children}
    </span>
  );
}

function MonaEmailLink({ href, children }: { href: string; children: React.ReactNode }) {
  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isTauri()) return;
    // 支持两种格式：mona:email?... 和 #mona-email:...
    let queryStr: string;
    if (href.startsWith("#mona-email:")) {
      queryStr = href.slice("#mona-email:".length);
    } else if (href.startsWith("mona:email?")) {
      queryStr = href.slice("mona:email?".length);
    } else {
      return;
    }
    const params = new URLSearchParams(queryStr);
    const accountId = params.get("accountId");
    const uid = params.get("uid");
    const folder = params.get("folder");
    if (!accountId || !uid || !folder) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("email_open_view_window", {
        payload: { accountId, uid, folder },
      });
    } catch (err) {
      console.error("[MonaEmailLink] 打开邮件预览窗口失败:", err);
    }
  };
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleClick}
      className="cursor-pointer text-primary underline underline-offset-2 hover:opacity-80"
      title="点击在新窗口预览邮件"
    >
      {children}
    </span>
  );
}
