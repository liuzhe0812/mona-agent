import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search } from "lucide-react";

import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { OperationNote } from "./notes-data";
import { formatRelativeTime } from "./notes-data";

interface QuickSwitchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notes: OperationNote[];
  onSelectNote: (noteId: string) => void;
}

export function QuickSwitchDialog({
  open,
  onOpenChange,
  notes,
  onSelectNote,
}: QuickSwitchDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      // Focus input after dialog opens.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Default: recent notes by updatedAt desc.
      return [...notes]
        .sort((a, b) => {
          const ta = new Date(a.updatedAt).getTime() || 0;
          const tb = new Date(b.updatedAt).getTime() || 0;
          return tb - ta;
        })
        .slice(0, 30);
    }
    return notes
      .filter((n) => {
        const haystack = [n.title, n.preview, n.source.label, n.tags.join(" ")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      })
      .slice(0, 30);
  }, [notes, query]);

  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(0);
    }
  }, [filtered.length, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % Math.max(filtered.length, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const selected = filtered[selectedIndex];
        if (selected) {
          onSelectNote(selected.id);
          onOpenChange(false);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, filtered, selectedIndex, onSelectNote, onOpenChange]);

  // Scroll selected item into view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 p-0" showCloseButton={false}>
        <div className="border-b border-border/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="按名称打开笔记..."
              className="h-7 border-0 bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-0"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
            />
          </div>
        </div>
        <div ref={listRef} className="max-h-[360px] min-h-0 overflow-y-auto py-1 scrollbar-thin">
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-center text-[12px] text-muted-foreground/70">
              {query ? "无匹配笔记" : "暂无笔记"}
            </div>
          )}
          {filtered.map((note, idx) => (
            <button
              key={note.id}
              type="button"
              onMouseEnter={() => setSelectedIndex(idx)}
              onClick={() => {
                onSelectNote(note.id);
                onOpenChange(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-accent/60",
                idx === selectedIndex && "bg-accent",
              )}
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 flex-1 truncate text-foreground/90">
                {note.title || "(未命名笔记)"}
              </span>
              {note.tags.length > 0 && (
                <span className="shrink-0 truncate text-[10.5px] text-muted-foreground/70">
                  {note.tags.slice(0, 2).map((t) => `#${t}`).join(" ")}
                </span>
              )}
              <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/60">
                {formatRelativeTime(note.updatedAt)}
              </span>
            </button>
          ))}
        </div>
        <div className="border-t border-border/60 px-3 py-1.5 text-[10.5px] text-muted-foreground/70">
          <span className="mr-3">↑↓ 选择</span>
          <span className="mr-3">↵ 打开</span>
          <span className="mr-3">esc 取消</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
