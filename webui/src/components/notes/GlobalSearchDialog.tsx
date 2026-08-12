import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2, Search, X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { searchAllNotes, type NoteSearchResult } from "@/lib/tauri";

interface GlobalSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectNote: (noteId: string, notebookId?: string) => void;
  initialQuery?: string;
}

export function GlobalSearchDialog({
  open,
  onOpenChange,
  onSelectNote,
  initialQuery = "",
}: GlobalSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setResults([]);
      setActiveIndex(0);
      setLoading(false);
      // Focus input after dialog animation
      window.setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, initialQuery]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    const currentRequestId = ++requestIdRef.current;

    debounceRef.current = window.setTimeout(async () => {
      try {
        const data = await searchAllNotes(trimmed, 30);
        // Only apply if this is still the latest request
        if (currentRequestId === requestIdRef.current) {
          setResults(data);
          setActiveIndex(0);
        }
      } catch (err) {
        if (currentRequestId === requestIdRef.current) {
          setResults([]);
        }
        console.warn("[global-search] failed:", err);
      } finally {
        if (currentRequestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    }, 250);

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  const handleSelect = useCallback(
    (result: NoteSearchResult) => {
      onSelectNote(result.noteId, result.notebookId);
      onOpenChange(false);
    },
    [onOpenChange, onSelectNote],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const selected = results[activeIndex];
        if (selected) handleSelect(selected);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      }
    },
    [activeIndex, handleSelect, onOpenChange, results.length],
  );

  const hasQuery = query.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[640px] gap-0 overflow-hidden rounded-xl border-border/70 p-0">
        <DialogTitle className="sr-only">全局搜索笔记</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border/65 px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="跨所有笔记本搜索笔记..."
            className="h-7 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-ui shadow-none focus-visible:ring-0"
          />
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
          {hasQuery ? (
            <Button
              type="button"
              variant="ghost"
              aria-label="清空"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="h-5 w-5 shrink-0 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>

        <div className="max-h-[420px] min-h-[120px] overflow-y-auto scrollbar-thin">
          {!hasQuery ? (
            <div className="flex h-[120px] items-center justify-center text-caption text-muted-foreground">
              输入关键词搜索所有笔记本中的笔记
            </div>
          ) : loading && results.length === 0 ? (
            <div className="flex h-[120px] items-center justify-center text-caption text-muted-foreground">
              正在搜索...
            </div>
          ) : results.length === 0 ? (
            <div className="flex h-[120px] items-center justify-center text-caption text-muted-foreground">
              没有匹配的笔记
            </div>
          ) : (
            <ul className="py-1">
              {results.map((result, index) => (
                <li key={result.noteId}>
                  <Button
                    type="button"
                    variant="ghost"
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => handleSelect(result)}
                    className={cn(
                      "h-auto w-full flex-col items-start justify-start gap-1 rounded-none px-3 py-2 text-left font-normal",
                      index === activeIndex
                        ? "bg-accent hover:bg-accent hover:text-foreground"
                        : "hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <div className="flex w-full items-center gap-2">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
                        {result.title || "未命名笔记"}
                      </span>
                      {result.notebookName ? (
                        <span className="shrink-0 rounded-full border border-border/60 bg-muted/30 px-1.5 py-0.5 text-micro text-muted-foreground">
                          {result.notebookName}
                        </span>
                      ) : null}
                    </div>
                    {result.snippet ? (
                      <p
                        className="line-clamp-2 pl-6 text-micro text-muted-foreground"
                        dangerouslySetInnerHTML={{ __html: renderSnippet(result.snippet) }}
                      />
                    ) : null}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border/65 px-3 py-1.5 text-micro text-muted-foreground">
          <span className="flex items-center gap-2">
            <kbd className="rounded border border-border/60 bg-muted/30 px-1 py-0.5">↑↓</kbd>
            <span>选择</span>
            <kbd className="rounded border border-border/60 bg-muted/30 px-1 py-0.5">Enter</kbd>
            <span>打开</span>
          </span>
          <span className="flex items-center gap-2">
            <kbd className="rounded border border-border/60 bg-muted/30 px-1 py-0.5">Esc</kbd>
            <span>关闭</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function renderSnippet(snippet: string): string {
  // Escape HTML first, then restore highlight markers
  const escaped = snippet
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/⟨/g, '<mark class="rounded-sm bg-yellow-200/70 px-0.5 text-foreground">')
    .replace(/⟩/g, "</mark>");
}
