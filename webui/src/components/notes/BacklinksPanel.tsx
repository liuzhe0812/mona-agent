import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";

import { getNoteBacklinks, getNoteMentions } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

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
  const titles = new Set<string>();
  const items: { noteId: string; title: string }[] = [];
  for (const it of state.backlinks) {
    if (!titles.has(it.title)) {
      titles.add(it.title);
      items.push({ noteId: it.noteId, title: it.title });
    }
  }
  for (const it of state.mentions) {
    if (!titles.has(it.title)) {
      titles.add(it.title);
      items.push({ noteId: it.noteId, title: it.title });
    }
  }

  return (
    <div className={cn("flex flex-col gap-1 text-ui", className)}>
      <div className="flex items-center gap-1.5 px-1 py-0.5 text-muted-foreground">
        <span className="font-medium">反向链接</span>
        <span className="tabular-nums text-muted-foreground/70">{totalCount}</span>
      </div>

      {state.loading && (
        <div className="px-2 py-1 text-micro text-muted-foreground/70">扫描中...</div>
      )}
      {state.error && (
        <div className="px-2 py-1 text-micro text-destructive/80">{state.error}</div>
      )}

      {!state.loading && totalCount > 0 && (
        <div className="ml-2 flex flex-col border-l border-border/60 pl-1">
          {items.map((item) => (
            <Button
              key={item.noteId}
              type="button"
              variant="ghost"
              onClick={() => onSelectNote?.(item.noteId)}
              className="group h-auto justify-start gap-1.5 rounded px-1.5 py-1 text-left font-normal hover:bg-accent"
            >
              <Link2 className="h-3 w-3 shrink-0 text-muted-foreground/60" />
              <span
                className="min-w-0 flex-1 truncate text-caption text-foreground/90"
                title={item.title}
              >
                {item.title}
              </span>
            </Button>
          ))}
        </div>
      )}

      {!state.loading && totalCount === 0 && !state.error && (
        <div className="px-2 py-1 text-micro text-muted-foreground/60">
          暂无反向链接
        </div>
      )}
    </div>
  );
}
