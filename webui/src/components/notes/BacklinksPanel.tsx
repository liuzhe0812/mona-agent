import { useEffect, useState } from "react";
import { ChevronRight, Link2, FileSearch } from "lucide-react";

import { getNoteBacklinks, getNoteMentions } from "@/lib/tauri";
import { cn } from "@/lib/utils";

import type { BacklinkItem, MentionItem } from "./notes-data";

interface BacklinksPanelProps {
  noteId: string;
  onSelectNote?: (noteId: string) => void;
  className?: string;
}

interface PanelState {
  backlinks: BacklinkItem[];
  mentions: MentionItem[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: PanelState = {
  backlinks: [],
  mentions: [],
  loading: false,
  error: null,
};

export function BacklinksPanel({ noteId, onSelectNote, className }: BacklinksPanelProps) {
  const [state, setState] = useState<PanelState>(EMPTY_STATE);
  const [collapsed, setCollapsed] = useState<{ backlinks: boolean; mentions: boolean }>({
    backlinks: false,
    mentions: false,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ ...EMPTY_STATE, loading: true });
    Promise.all([getNoteBacklinks(noteId), getNoteMentions(noteId)])
      .then(([backlinks, mentions]) => {
        if (cancelled) return;
        setState({
          backlinks: (backlinks as BacklinkItem[]) ?? [],
          mentions: (mentions as MentionItem[]) ?? [],
          loading: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ ...EMPTY_STATE, loading: false, error: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const totalCount = state.backlinks.length + state.mentions.length;

  return (
    <div className={cn("flex flex-col gap-1 text-[12.5px]", className)}>
      <div className="flex items-center gap-1.5 px-1 py-0.5 text-muted-foreground">
        <Link2 className="h-3.5 w-3.5" />
        <span className="font-medium">链接与提及</span>
        <span className="tabular-nums text-muted-foreground/70">{totalCount}</span>
      </div>

      {state.loading && (
        <div className="px-2 py-1 text-[11px] text-muted-foreground/70">扫描中...</div>
      )}
      {state.error && (
        <div className="px-2 py-1 text-[11px] text-destructive/80">{state.error}</div>
      )}

      {!state.loading && state.backlinks.length > 0 && (
        <Section
          title={`反向链接 ${state.backlinks.length}`}
          collapsed={collapsed.backlinks}
          onToggle={() => setCollapsed((c) => ({ ...c, backlinks: !c.backlinks }))}
        >
          {state.backlinks.map((item, idx) => (
            <BacklinkRow
              key={`${item.noteId}-${item.line}-${idx}`}
              item={item}
              onClick={() => onSelectNote?.(item.noteId)}
            />
          ))}
        </Section>
      )}

      {!state.loading && state.mentions.length > 0 && (
        <Section
          title={`未链接提及 ${state.mentions.length}`}
          collapsed={collapsed.mentions}
          onToggle={() => setCollapsed((c) => ({ ...c, mentions: !c.mentions }))}
        >
          {state.mentions.map((item, idx) => (
            <BacklinkRow
              key={`mention-${item.noteId}-${item.line}-${idx}`}
              item={item}
              icon="mention"
              onClick={() => onSelectNote?.(item.noteId)}
            />
          ))}
        </Section>
      )}

      {!state.loading && totalCount === 0 && !state.error && (
        <div className="px-2 py-1 text-[11px] text-muted-foreground/60">
          暂无反向链接或提及
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-[11.5px] font-medium text-muted-foreground hover:bg-accent/60"
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", !collapsed && "rotate-90")}
        />
        <span>{title}</span>
      </button>
      {!collapsed && <div className="ml-2 flex flex-col border-l border-border/60 pl-1">{children}</div>}
    </div>
  );
}

function BacklinkRow({
  item,
  icon = "link",
  onClick,
}: {
  item: BacklinkItem | MentionItem;
  icon?: "link" | "mention";
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-0.5 rounded px-1.5 py-1 text-left hover:bg-accent/60"
    >
      <div className="flex items-center gap-1.5">
        {icon === "mention" ? (
          <FileSearch className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <Link2 className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
          {item.title}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
          L{item.line}
        </span>
      </div>
      {item.snippet && (
        <span className="line-clamp-2 pl-4 text-[10.5px] leading-snug text-muted-foreground/70">
          {item.snippet}
        </span>
      )}
    </button>
  );
}
