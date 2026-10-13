import { useMemo, type ReactNode } from "react";
import { List, Link2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AgentLogo } from "@/components/AgentLogo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { BacklinksPanel } from "./BacklinksPanel";
import { parseMindMap, type MindMapNode } from "./mindmap/mindmap-outline";
import { useMindMapBridge } from "./mindmap/MindMapBridge";
import type { OperationNote } from "./notes-data";

export type RightTab = "ai" | "outline" | "links";

interface RightSidebarProps {
  open?: boolean;
  note: OperationNote | null;
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
  aiPanel?: ReactNode;
  aiStreaming?: boolean;
  onSelectNote?: (noteId: string) => void;
  onOpenNoteByTitle?: (title: string) => void;
  allNotes?: OperationNote[];
  width: number;
}

interface OutlineHeading {
  level: number;
  text: string;
  lineIndex: number;
}

const TABS: { id: RightTab; label: string }[] = [
  { id: "ai", label: "AI助手" },
  { id: "outline", label: "大纲" },
  { id: "links", label: "链接" },
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
  open = true,
  note,
  activeTab,
  onTabChange,
  aiPanel,
  aiStreaming = false,
  onSelectNote,
  onOpenNoteByTitle,
  allNotes,
  width,
}: RightSidebarProps) {
  const isMindMap = note?.type === "mindmap";
  const mindMapBridge = useMindMapBridge();

  const outline = useMemo(
    () => (note && !isMindMap ? parseOutline(note.contentMarkdown) : []),
    [note?.contentMarkdown, isMindMap],
  );

  // 思维导图大纲：从 markdown 解析节点树
  const mindMapTree = useMemo(() => {
    if (!note || !isMindMap) return null;
    const result = parseMindMap(note.contentMarkdown);
    return result.ok ? result.root : null;
  }, [note?.contentMarkdown, isMindMap]);

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

  return (
    <div
      className={cn("h-full shrink-0 flex-col bg-background", open ? "flex" : "hidden")}
      style={{ width }}
      hidden={!open}
    >
      <TooltipProvider delayDuration={300}>
        <Tabs
          value={activeTab}
          onValueChange={(value) => onTabChange(value as RightTab)}
          className="flex h-full min-h-0 flex-col"
        >
          <TabsList className="h-8 w-full shrink-0 justify-start rounded-none bg-transparent p-0">
            {TABS.map((tab) => (
              <Tooltip key={tab.id}>
                <TooltipTrigger asChild>
                  <TabsTrigger
                    value={tab.id}
                    data-state={activeTab === tab.id ? "active" : "inactive"}
                    aria-label={tab.label}
                    className="h-full min-w-0 flex-1 gap-1 rounded-none px-2 text-caption data-[state=active]:bg-accent data-[state=active]:shadow-none"
                  >
                    {tab.id === "ai" ? (
                      <AgentLogo
                        state={aiStreaming ? "working" : "idle"}
                        variant="avatar"
                        className="h-3.5 w-3.5"
                      />
                    ) : tab.id === "outline" ? (
                      <List className="h-3.5 w-3.5" />
                    ) : (
                      <Link2 className="h-3.5 w-3.5" />
                    )}
                    <span className="truncate">{tab.label}</span>
                  </TabsTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">{tab.label}</TooltipContent>
              </Tooltip>
            ))}
          </TabsList>

          <TabsContent
            value="ai"
            forceMount
            hidden={activeTab !== "ai"}
            className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden [&>aside]:border-l-0"
          >
            {aiPanel}
          </TabsContent>

          <TabsContent
            value="outline"
            className="mt-0 min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin"
          >
            {!isMindMap && (
              <div className="flex flex-col gap-0.5">
                {outline.length === 0 ? (
                  <div className="px-1 py-2 text-micro text-muted-foreground/70">
                    暂无标题大纲
                  </div>
                ) : (
                  outline.map((h, idx) => (
                    <Button
                      key={idx}
                      type="button"
                      variant="ghost"
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
                      className="block h-auto w-full truncate rounded px-1 py-0.5 text-left text-caption font-normal text-muted-foreground hover:bg-accent hover:text-foreground"
                      style={{ paddingLeft: `${4 + (h.level - 1) * 10}px` }}
                      title={h.text}
                    >
                      {h.text}
                    </Button>
                  ))
                )}
              </div>
            )}

            {isMindMap && (
              <div className="flex flex-col gap-0.5">
                {!mindMapTree ? (
                  <div className="px-1 py-2 text-micro text-muted-foreground/70">
                    暂无节点
                  </div>
                ) : (
                  <MindMapOutlineTree
                    node={mindMapTree}
                    level={0}
                    onSelectNode={(nodeId) => mindMapBridge?.current?.(nodeId)}
                  />
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent
            value="links"
            className="mt-0 min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin"
          >
            {note && (
              <div className="flex flex-col gap-3">
                {/* Outgoing links */}
                <div className="flex flex-col gap-1 text-ui">
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
                          <Button
                            key={title}
                            type="button"
                            variant="ghost"
                            onClick={() => {
                              if (target) {
                                onSelectNote?.(target.id);
                              } else {
                                onOpenNoteByTitle?.(title);
                              }
                            }}
                            className="group h-auto justify-start gap-1.5 rounded px-1.5 py-1 text-left font-normal hover:bg-accent"
                          >
                            <Link2
                              className={cn(
                                "h-3 w-3 shrink-0",
                                unresolved ? "text-muted-foreground/40" : "text-muted-foreground/60",
                              )}
                            />
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate text-caption",
                                unresolved
                                  ? "text-muted-foreground/50"
                                  : "text-foreground/90",
                              )}
                              title={title}
                            >
                              {title}
                            </span>
                          </Button>
                        );
                      })}
                    </div>
                  )}
                  {outgoingLinks.length === 0 && (
                    <div className="px-2 py-1 text-micro text-muted-foreground/60">
                      暂无正向链接
                    </div>
                  )}
                </div>

                <BacklinksPanel noteId={note.id} onSelectNote={onSelectNote} />
              </div>
            )}
          </TabsContent>
        </Tabs>
      </TooltipProvider>
    </div>
  );
}

/** 思维导图大纲：递归渲染节点树，点击定位到导图节点 */
function MindMapOutlineTree({
  node,
  level,
  onSelectNode,
}: {
  node: MindMapNode;
  level: number;
  onSelectNode?: (nodeId: string) => void;
}) {
  const hasChildren = node.children && node.children.length > 0;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={() => onSelectNode?.(node.id)}
        className={cn(
          "block h-auto w-full truncate rounded px-1 py-0.5 text-left text-caption font-normal hover:bg-accent hover:text-foreground",
          level === 0
            ? "font-medium text-foreground"
            : "text-muted-foreground",
        )}
        style={{ paddingLeft: `${4 + level * 12}px` }}
        title={node.topic}
      >
        {node.topic || "（空节点）"}
      </Button>
      {hasChildren &&
        node.children.map((child) => (
          <MindMapOutlineTree
            key={child.id}
            node={child}
            level={level + 1}
            onSelectNode={onSelectNode}
          />
        ))}
    </>
  );
}
