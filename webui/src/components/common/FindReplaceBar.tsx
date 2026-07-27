import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Match {
  from: number;
  to: number;
}

interface FindReplaceBarProps {
  editor: Editor;
  mode: "find" | "replace";
  onClose: () => void;
}

interface FindApi {
  openFind: () => void;
  openReplace: () => void;
}

let activeFindApi: FindApi | null = null;

export function setActiveFindApi(api: FindApi): () => void {
  activeFindApi = api;
  return () => {
    if (activeFindApi === api) {
      activeFindApi = null;
    }
  };
}

export function openActiveEditorFind() {
  activeFindApi?.openFind();
}

export function openActiveEditorReplace() {
  activeFindApi?.openReplace();
}

function scanMatches(editor: Editor, query: string, caseSensitive: boolean): Match[] {
  const matches: Match[] = [];
  if (!query) return matches;
  const needle = caseSensitive ? query : query.toLowerCase();
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      const text = node.text;
      const hay = caseSensitive ? text : text.toLowerCase();
      let idx = 0;
      while (true) {
        const found = hay.indexOf(needle, idx);
        if (found === -1) break;
        matches.push({ from: pos + found, to: pos + found + query.length });
        idx = found + 1;
      }
    }
    return true;
  });
  return matches;
}

function selectMatch(editor: Editor, m: Match) {
  const { view, state } = editor;
  const tr = state.tr.setSelection(TextSelection.create(state.doc, m.from, m.to));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export function FindReplaceBar({ editor, mode, onClose }: FindReplaceBarProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [currentIndex, setCurrentIndex] = useState(-1);
  const isReplace = mode === "replace";
  const [docVersion, setDocVersion] = useState(0);
  const queryInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Subscribe to editor doc changes so matches stay in sync.
  useEffect(() => {
    const handler = () => setDocVersion((v) => v + 1);
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor]);

  const matches = useMemo<Match[]>(() => {
    void docVersion;
    if (!query) return [];
    return scanMatches(editor, query, false);
  }, [editor, query, docVersion]);

  // Re-select first match when query changes.
  useEffect(() => {
    if (matches.length > 0) {
      setCurrentIndex(0);
      selectMatch(editor, matches[0]);
    } else {
      setCurrentIndex(-1);
    }
  }, [matches, editor]);

  // Focus the appropriate input when mounted.
  useEffect(() => {
    const input = mode === "replace" ? replaceInputRef.current : queryInputRef.current;
    input?.focus();
    input?.select();
  }, [mode]);

  const goNext = useCallback(() => {
    if (matches.length === 0) return;
    const next = (currentIndex + 1) % matches.length;
    setCurrentIndex(next);
    selectMatch(editor, matches[next]);
  }, [matches, currentIndex, editor]);

  const goPrev = useCallback(() => {
    if (matches.length === 0) return;
    const prev = (currentIndex - 1 + matches.length) % matches.length;
    setCurrentIndex(prev);
    selectMatch(editor, matches[prev]);
  }, [matches, currentIndex, editor]);

  const replaceCurrent = useCallback(() => {
    if (matches.length === 0 || currentIndex < 0) return;
    const m = matches[currentIndex];
    if (!m) return;
    editor.chain().focus().deleteRange({ from: m.from, to: m.to }).insertContent(replacement).run();
    // matches will recompute via docVersion bump; pick the next one.
    const next = scanMatches(editor, query, false);
    if (next.length > 0) {
      const idx = Math.min(currentIndex, next.length - 1);
      setCurrentIndex(idx);
      selectMatch(editor, next[idx]);
    } else {
      setCurrentIndex(-1);
    }
  }, [matches, currentIndex, editor, query, replacement]);

  const replaceAll = useCallback(() => {
    if (matches.length === 0) return;
    // Replace from back to front to keep earlier positions valid.
    const sorted = [...matches].sort((a, b) => b.from - a.from);
    const tr = editor.state.tr;
    sorted.forEach((m) => {
      tr.delete(m.from, m.to);
      tr.insertText(replacement, m.from);
    });
    editor.view.dispatch(tr);
    setCurrentIndex(-1);
  }, [matches, editor, replacement]);

  const handleQueryKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const handleReplaceKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceCurrent();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const total = matches.length;

  return (
    <div className="flex flex-col gap-1.5 border-b border-border/65 bg-muted/40 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Input
          ref={queryInputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleQueryKeyDown}
          placeholder="查找..."
          className="h-7 flex-1 rounded-md text-[13px]"
        />
        <span className="min-w-[52px] text-center text-[11px] tabular-nums text-muted-foreground">
          {total > 0 ? `${currentIndex + 1}/${total}` : `${total}/${total}`}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={goPrev}
          disabled={total === 0}
          title="上一个 (Shift+Enter)"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={goNext}
          disabled={total === 0}
          title="下一个 (Enter)"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
          title="关闭 (Esc)"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {isReplace && (
        <div className="flex items-center gap-1.5">
          <Input
            ref={replaceInputRef}
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={handleReplaceKeyDown}
            placeholder="替换为..."
            className="h-7 flex-1 rounded-md text-[13px]"
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            onClick={replaceCurrent}
            disabled={total === 0}
            title="替换当前匹配 (Enter)"
          >
            替换
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            onClick={replaceAll}
            disabled={total === 0}
            title="替换全部匹配"
          >
            全部替换
          </Button>
        </div>
      )}
    </div>
  );
}

export interface FindBarState {
  open: boolean;
  mode: "find" | "replace";
}

export function useFindBarHotkey(onOpen: (mode: "find" | "replace") => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "f") {
        const target = e.target as HTMLElement;
        if (!target.closest?.("[data-note-editor]")) return;
        e.preventDefault();
        onOpen("find");
      } else if (k === "h") {
        const target = e.target as HTMLElement;
        if (!target.closest?.("[data-note-editor]")) return;
        e.preventDefault();
        onOpen("replace");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}
