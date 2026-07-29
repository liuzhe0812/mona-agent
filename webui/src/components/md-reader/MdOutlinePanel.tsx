import { useMemo, type RefObject } from "react";
import { List } from "lucide-react";

interface MdOutlinePanelProps {
  content: string;
  editorContainerRef: RefObject<HTMLDivElement | null>;
  width: number;
}

interface OutlineHeading {
  level: number;
  text: string;
  lineIndex: number;
}

function stripInlineMarkdown(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]\n|#]+)(?:#[^\]\n]*)?\]\]/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

function parseOutline(contentMarkdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const lines = contentMarkdown.split("\n");
  let inCodeFence = false;
  lines.forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeFence = !inCodeFence;
      return;
    }
    if (inCodeFence) return;
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: stripInlineMarkdown(match[2]),
        lineIndex: idx,
      });
    }
  });
  return headings;
}

export function MdOutlinePanel({ content, editorContainerRef, width }: MdOutlinePanelProps) {
  const outline = useMemo(() => parseOutline(content), [content]);

  const scrollToHeading = (idx: number, lineIndex: number) => {
    const container = editorContainerRef.current;
    if (!container) return;
    const prosemirror = container.querySelector(".ProseMirror");
    if (prosemirror) {
      const heads = prosemirror.querySelectorAll("h1,h2,h3,h4,h5,h6");
      const target = heads[idx];
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    } else {
      const ta = container.querySelector("textarea");
      if (ta) {
        const lineHeight = 24;
        (ta as HTMLTextAreaElement).scrollTop = lineIndex * lineHeight;
      }
    }
  };

  return (
    <div
      className="flex h-full shrink-0 flex-col border-l border-border/60 bg-background"
      style={{ width }}
    >
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/60 px-3 text-[12px] font-medium text-muted-foreground">
        <List className="h-3.5 w-3.5" />
        <span>目录</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
        {outline.length === 0 ? (
          <div className="px-1 py-2 text-[11.5px] text-muted-foreground/70">
            暂无标题
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {outline.map((h, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => scrollToHeading(idx, h.lineIndex)}
                className="truncate rounded px-1.5 py-1 text-left text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
                style={{ paddingLeft: `${4 + (h.level - 1) * 10}px` }}
                title={h.text}
              >
                {h.text}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
