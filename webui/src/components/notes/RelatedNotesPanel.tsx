import { useEffect, useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";

import { findRelatedNotes, setNotesKbToken, type NotesSearchResultItem } from "@/lib/notes-kb-api";
import { getNotesVaultPath } from "@/lib/tauri";
import { useClientOptional } from "@/providers/ClientProvider";
import { cn } from "@/lib/utils";

interface RelatedNotesPanelProps {
  noteId: string;
  onSelectNote?: (noteId: string) => void;
  className?: string;
}

interface PanelState {
  items: NotesSearchResultItem[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: PanelState = { items: [], loading: false, error: null };

export function RelatedNotesPanel({ noteId, onSelectNote, className }: RelatedNotesPanelProps) {
  const [state, setState] = useState<PanelState>(EMPTY_STATE);
  const [collapsed, setCollapsed] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const { token } = useClientOptional();

  // Sync the auth token for notes-kb API calls.
  useEffect(() => {
    if (token) setNotesKbToken(token);
  }, [token]);

  // Detect whether the vault has embeddings configured by probing embed status.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const vaultPath = await getNotesVaultPath();
        if (!vaultPath) {
          if (!cancelled) setEnabled(false);
          return;
        }
        const { getVaultEmbedStatus } = await import("@/lib/notes-kb-api");
        const status = await getVaultEmbedStatus(vaultPath);
        if (!cancelled) setEnabled(status.chunkCount > 0);
      } catch {
        if (!cancelled) setEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !noteId) {
      setState(EMPTY_STATE);
      return;
    }
    let cancelled = false;
    setState({ ...EMPTY_STATE, loading: true });
    void (async () => {
      try {
        const vaultPath = await getNotesVaultPath();
        if (!vaultPath) {
          if (!cancelled) setState({ ...EMPTY_STATE, loading: false });
          return;
        }
        const data = await findRelatedNotes(vaultPath, noteId, 5);
        if (!cancelled) {
          setState({
            items: data.results ?? [],
            loading: false,
            error: null,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState({ ...EMPTY_STATE, loading: false, error: String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, enabled]);

  if (!enabled) return null;

  return (
    <div className={cn("flex flex-col gap-1 text-[12.5px]", className)}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1.5 px-1 py-0.5 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", !collapsed && "rotate-90")}
        />
        <Sparkles className="h-3.5 w-3.5" />
        <span className="font-medium">相关笔记</span>
        <span className="tabular-nums text-muted-foreground/70">{state.items.length}</span>
      </button>

      {!collapsed && (
        <>
          {state.loading && (
            <div className="px-2 py-1 text-[11px] text-muted-foreground/70">
              正在查找语义相关笔记...
            </div>
          )}
          {state.error && (
            <div className="px-2 py-1 text-[11px] text-destructive/80">{state.error}</div>
          )}
          {!state.loading && state.items.length === 0 && !state.error && (
            <div className="px-2 py-1 text-[11px] text-muted-foreground/60">
              暂无相关笔记
            </div>
          )}
          {!state.loading && state.items.length > 0 && (
            <div className="ml-2 flex flex-col border-l border-border/60 pl-1">
              {state.items.map((item, idx) => {
                const noteId = item.path.replace(/\.md$/, "").split("/").pop() ?? "";
                return (
                  <button
                    key={`${noteId}-${idx}`}
                    type="button"
                    onClick={() => onSelectNote?.(noteId)}
                    className="group flex flex-col gap-0.5 rounded px-1.5 py-1 text-left hover:bg-accent/60"
                  >
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
                        {item.title}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                        {(item.score ?? 0).toFixed(2)}
                      </span>
                    </div>
                    {item.snippet && (
                      <span className="line-clamp-2 pl-4 text-[10.5px] leading-snug text-muted-foreground/70">
                        {item.snippet}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
