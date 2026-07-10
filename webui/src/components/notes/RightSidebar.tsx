import { useEffect, useMemo, useState } from "react";
import { List, Link2, Tag } from "lucide-react";

import { cn } from "@/lib/utils";

import { BacklinksPanel } from "./BacklinksPanel";
import { RelatedNotesPanel } from "./RelatedNotesPanel";
import type { OperationNote } from "./notes-data";

export type RightTab = "outline" | "links" | "tags";

interface RightSidebarProps {
  note: OperationNote | null;
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
  onSelectNote?: (noteId: string) => void;
  onSearchTag?: (tag: string) => void;
  onOpenNoteByTitle?: (title: string) => void;
  allNotes?: OperationNote[];
  width: number;
}

interface OutlineHeading {
  level: number;
  text: string;
  lineIndex: number;
}

const TABS: { id: RightTab; label: string; icon: typeof List }[] = [
  { id: "outline", label: "大纲", icon: List },
  { id: "links", label: "链接", icon: Link2 },
  { id: "tags", label: "标签", icon: Tag },
];

/** Strip common inline markdown markers from a heading text. */
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
  lines.forEach((line, idx) => {
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

/** Extract `[[title]]` outgoing links from markdown content. */
function parseOutgoingLinks(contentMarkdown: string): string[] {
  const links: string[] = [];
  const re = /\[\[([^\]\n|#]+)(?:#[^\]\n]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(contentMarkdown)) !== null) {
    const title = m[1].trim();
    if (title && !links.includes(title)) links.push(title);
  }
  return links;
}

export function RightSidebar({
  note,
  activeTab,
  onTabChange,
  onSelectNote,
  onSearchTag,
  onOpenNoteByTitle,
  allNotes,
  width,
}: RightSidebarProps) {
  const [searchTag, setSearchTag] = useState<string | null>(null);

  const outline = useMemo(
    () => (note ? parseOutline(note.contentMarkdown) : []),
    [note?.contentMarkdown],
  );

  const outgoingLinks = useMemo(
    () => (note ? parseOutgoingLinks(note.contentMarkdown) : []),
    [note?.contentMarkdown],
  );

  // Map link titles to note ids for navigation.
  const outgoingLinkNotes = useMemo(() => {
    if (!allNotes) return new Map<string, OperationNote>();
    const map = new Map<string, OperationNote>();
    for (const n of allNotes) {
      if (n.title) map.set(n.title.toLowerCase(), n);
    }
    return map;
  }, [allNotes]);

  useEffect(() => {
    if (searchTag && onSearchTag) {
      onSearchTag(searchTag);
      setSearchTag(null);
    }
  }, [searchTag, onSearchTag]);

  return (
    <div
      className="flex h-full shrink-0 flex-col border-l border-border/60 bg-background"
      style={{ width }}
    >
      <div className="flex h-8 shrink-0 items-stretch border-b border-border/60">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              title={tab.label}
              aria-label={tab.label}
              onClick={() => onTabChange(tab.id)}
              className={cn(
                "flex flex-1 items-center justify-center text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                active && "bg-accent text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
        {activeTab === "outline" && (
          <div className="flex flex-col gap-0.5">
            {outline.length === 0 ? (
              <div className="px-1 py-2 text-[11.5px] text-muted-foreground/70">
                暂无标题大纲
              </div>
            ) : (
              outline.map((h, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    const root = document.querySelector("[data-note-editor='true']");
                    if (!root) return;
                    const prosemirror = root.querySelector(".ProseMirror");
                    if (prosemirror) {
                      // Visual mode: match heading DOM nodes by order.
                      const heads = prosemirror.querySelectorAll("h1,h2,h3,h4,h5,h6");
                      const target = heads[idx];
                      if (target) {
                        target.scrollIntoView({ block: "start", behavior: "smooth" });
                      }
                    } else {
                      // Markdown mode: scroll textarea to the heading line.
                      const ta = root.querySelector("textarea");
                      if (ta) {
                        const lineHeight = 24;
                        (ta as HTMLTextAreaElement).scrollTop = h.lineIndex * lineHeight;
                      }
                    }
                  }}
                  className="truncate rounded px-1 py-0.5 text-left text-[12px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  style={{ paddingLeft: `${4 + (h.level - 1) * 10}px` }}
                  title={h.text}
                >
                  {h.text}
                </button>
              ))
            )}
          </div>
        )}

        {activeTab === "links" && note && (
          <div className="flex flex-col gap-3">
            {/* Outgoing links */}
            <div className="flex flex-col gap-1 text-[12.5px]">
              <div className="flex items-center gap-1.5 px-1 py-0.5 text-muted-foreground">
                <span className="font-medium">正向链接</span>
                <span className="tabular-nums text-muted-foreground/70">
                  {outgoingLinks.length}
                </span>
              </div>
              {outgoingLinks.length > 0 && (
                <div className="ml-2 flex flex-col border-l border-border/60 pl-1">
                  {outgoingLinks.map((title) => {
                    const target = outgoingLinkNotes.get(title.toLowerCase());
                    const unresolved = !target;
                    return (
                      <button
                        key={title}
                        type="button"
                        onClick={() => {
                          if (target) {
                            onSelectNote?.(target.id);
                          } else {
                            onOpenNoteByTitle?.(title);
                          }
                        }}
                        className="group flex items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-accent/60"
                      >
                        <Link2
                          className={cn(
                            "h-3 w-3 shrink-0",
                            unresolved ? "text-muted-foreground/40" : "text-muted-foreground/60",
                          )}
                        />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[12px]",
                            unresolved
                              ? "text-muted-foreground/50"
                              : "text-foreground/90",
                          )}
                          title={title}
                        >
                          {title}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {outgoingLinks.length === 0 && (
                <div className="px-2 py-1 text-[11px] text-muted-foreground/60">
                  暂无正向链接
                </div>
              )}
            </div>

            <BacklinksPanel noteId={note.id} onSelectNote={onSelectNote} />
            <RelatedNotesPanel noteId={note.id} onSelectNote={onSelectNote} />
          </div>
        )}

        {activeTab === "tags" && (
          <div className="flex flex-wrap gap-1.5">
            {note && note.tags.length > 0 ? (
              note.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setSearchTag(tag)}
                  className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-foreground/90 hover:bg-accent/80"
                >
                  #{tag}
                </button>
              ))
            ) : (
              <div className="px-1 py-2 text-[11.5px] text-muted-foreground/70">
                当前笔记没有标签
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
