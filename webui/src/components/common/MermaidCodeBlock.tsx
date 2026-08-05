import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { CodeBlock } from "@tiptap/extension-code-block";
import { TextSelection } from "@tiptap/pm/state";
import { Check, ChevronDown, Copy, Pencil } from "lucide-react";

import { MermaidDiagram } from "@/components/common/mermaid-diagram";

const LANGUAGES = [
  { value: "", label: "纯文本", short: "TXT" },
  { value: "plaintext", label: "Plain", short: "TXT" },
  { value: "bash", label: "Bash", short: "SH" },
  { value: "sh", label: "Shell", short: "SH" },
  { value: "javascript", label: "JavaScript", short: "JS" },
  { value: "typescript", label: "TypeScript", short: "TS" },
  { value: "jsx", label: "JSX", short: "JSX" },
  { value: "tsx", label: "TSX", short: "TSX" },
  { value: "python", label: "Python", short: "PY" },
  { value: "go", label: "Go", short: "GO" },
  { value: "rust", label: "Rust", short: "RS" },
  { value: "java", label: "Java", short: "JV" },
  { value: "kotlin", label: "Kotlin", short: "KT" },
  { value: "swift", label: "Swift", short: "SW" },
  { value: "c", label: "C", short: "C" },
  { value: "cpp", label: "C++", short: "C++" },
  { value: "csharp", label: "C#", short: "C#" },
  { value: "php", label: "PHP", short: "PHP" },
  { value: "ruby", label: "Ruby", short: "RB" },
  { value: "html", label: "HTML", short: "HTML" },
  { value: "css", label: "CSS", short: "CSS" },
  { value: "json", label: "JSON", short: "JSON" },
  { value: "yaml", label: "YAML", short: "YML" },
  { value: "toml", label: "TOML", short: "TOML" },
  { value: "sql", label: "SQL", short: "SQL" },
  { value: "markdown", label: "Markdown", short: "MD" },
  { value: "diff", label: "Diff", short: "DIFF" },
];

function findLanguageShort(value: string): string {
  const found = LANGUAGES.find((l) => l.value === value);
  if (found) return found.short;
  return value ? value.slice(0, 4).toUpperCase() : "TXT";
}

/**
 * TipTap CodeBlock extension that renders `language="mermaid"` blocks as SVG
 * diagrams (reusing the existing MermaidDiagram component), while leaving all
 * other code blocks unchanged. The original markdown serialization
 * (```mermaid ... ```) is preserved so .md files stay portable.
 *
 * Editing flow for mermaid blocks:
 *   1. Click the "edit" button (or double-click the diagram) → textarea opens
 *   2. Edit source; Ctrl+Enter commits, Escape cancels
 *   3. On blur the new text is written back to the ProseMirror node via a
 *      transaction that replaces the node's text content.
 *
 * For non-mermaid code blocks we delegate to the default rendering using
 * NodeViewContent, so the native contenteditable behaviour is preserved.
 */
export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MermaidCodeBlockView, {
      // Re-render only when the node reference changes; ProseMirror handles
      // text-only updates internally via the contentDOM.
      update: ({ oldNode, newNode, updateProps }) => {
        if (oldNode === newNode) return true;
        updateProps();
        return true;
      },
    });
  },
});

type MermaidCodeBlockViewProps = NodeViewProps;

function MermaidCodeBlockView({
  node,
  selected,
  getPos,
  view,
  updateAttributes,
}: MermaidCodeBlockViewProps) {
  const language = (node.attrs.language as string | null) ?? "";
  const isMermaid = language.toLowerCase() === "mermaid";
  const code = node.textContent;

  // Local edit state for mermaid blocks.
  const [editing, setEditing] = useState<boolean>(code.length === 0);
  const [draft, setDraft] = useState<string>(code);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [langFilter, setLangFilter] = useState("");
  const langMenuRef = useRef<HTMLDivElement>(null);

  const changeLanguage = useCallback(
    (next: string) => {
      updateAttributes({ language: next });
      setLangMenuOpen(false);
      setLangFilter("");
    },
    [updateAttributes],
  );

  useEffect(() => {
    if (!langMenuOpen) return;
    const handleClickOutside = (e: globalThis.MouseEvent) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setLangMenuOpen(false);
        setLangFilter("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [langMenuOpen]);

  // Keep draft in sync when the node text changes externally (e.g. AI edit,
  // undo/redo) and we are not actively editing.
  useEffect(() => {
    if (editing) return;
    setDraft(code);
  }, [code, editing]);

  // Auto-enter edit mode when a freshly created (empty) mermaid block mounts.
  useEffect(() => {
    if (isMermaid && code.length === 0 && !editing) {
      setEditing(true);
    }
    // Only run on mount; subsequent emptiness is handled by the commit flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = useCallback(() => {
    const pos = getPos();
    if (typeof pos !== "number") {
      setEditing(false);
      return;
    }
    const start = pos + 1; // inside the node, past the opening tag
    const end = pos + node.nodeSize - 1; // before the closing tag
    const next = draft;

    if (next === code) {
      setEditing(false);
      return;
    }

    const tr = view.state.tr;
    if (next.length === 0) {
      tr.delete(start, end);
    } else {
      tr.replaceWith(start, end, view.state.schema.text(next));
    }
    // Place the cursor at the end of the (possibly empty) text so the user
    // can continue typing or press Enter to exit the code block.
    const cursorPos = Math.min(start + next.length, tr.doc.content.size);
    tr.setSelection(TextSelection.create(tr.doc, cursorPos));
    view.dispatch(tr);
    setEditing(false);
  }, [code, draft, getPos, node.nodeSize, view]);

  const cancelEdit = useCallback(() => {
    setDraft(code);
    setEditing(false);
  }, [code]);

  if (!isMermaid) {
    // Default code block rendering: keep native contenteditable behaviour.
    const filteredLangs = langFilter
      ? LANGUAGES.filter(
          (l) =>
            l.label.toLowerCase().includes(langFilter.toLowerCase()) ||
            l.value.toLowerCase().includes(langFilter.toLowerCase()),
        )
      : LANGUAGES;
    return (
      <NodeViewWrapper
        as="div"
        className="code-block-wrapper relative my-2.5"
        data-selected={selected ? "" : undefined}
      >
        <div
          contentEditable={false}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-2 top-2 z-[1] flex items-center gap-1.5"
        >
          <div ref={langMenuRef} className="relative">
            <button
              type="button"
              title="选择语言"
              onClick={() => setLangMenuOpen((v) => !v)}
              onMouseDown={(e) => e.preventDefault()}
              className="inline-flex h-[26px] min-w-[58px] items-center justify-between gap-1 rounded-md border border-border/70 bg-background/80 px-1.5 font-mono text-[11px] leading-none text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            >
              <span className="truncate">{findLanguageShort(language)}</span>
              <ChevronDown className="h-3 w-3 opacity-70" />
            </button>
            {langMenuOpen ? (
              <div className="absolute right-0 top-full z-50 mt-1 flex max-h-72 w-56 flex-col rounded-md border border-border/70 bg-popover shadow-lg">
                <input
                  type="text"
                  autoFocus
                  value={langFilter}
                  onChange={(e) => setLangFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setLangMenuOpen(false);
                      setLangFilter("");
                    } else if (e.key === "Enter") {
                      const first = filteredLangs[0];
                      if (first) changeLanguage(first.value);
                    }
                  }}
                  placeholder="搜索语言..."
                  className="m-1 h-7 rounded border border-border/60 bg-background px-2 text-[11.5px] outline-none focus:border-primary"
                />
                <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin py-0.5">
                  {filteredLangs.length === 0 ? (
                    <div className="px-2 py-1.5 text-[11.5px] text-muted-foreground">无匹配</div>
                  ) : (
                    filteredLangs.map((l) => {
                      const active = l.value === language;
                      return (
                        <button
                          key={l.value || "plain"}
                          type="button"
                          onClick={() => changeLanguage(l.value)}
                          onMouseDown={(e) => e.preventDefault()}
                          className={
                            active
                              ? "flex w-full items-center gap-2 bg-accent px-2 py-1.5 text-left text-[12px] text-foreground"
                              : "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px] text-foreground/85 hover:bg-accent hover:text-foreground"
                          }
                        >
                          <span className="w-10 shrink-0 font-mono text-[10.5px] text-muted-foreground">
                            {l.short}
                          </span>
                          <span className="truncate">{l.label}</span>
                          {active ? <Check className="ml-auto h-3 w-3" /> : null}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            ) : null}
          </div>
          <CopyButton getText={() => node.textContent} />
        </div>
        <pre className="my-0 block overflow-x-auto rounded-lg bg-muted/50 p-4 pt-10">
          <NodeViewContent<"code">
            as="code"
            className={`block font-mono text-[13px] leading-6 ${language ? `language-${language}` : ""}`}
          />
        </pre>
      </NodeViewWrapper>
    );
  }

  // Mermaid block
  if (editing) {
    return (
      <NodeViewWrapper
        as="div"
        className="group/mermaid-edit my-2.5 rounded-lg border border-primary/40 bg-muted/45 p-2.5"
        data-selected={selected ? "" : undefined}
      >
        <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="font-mono">mermaid</span>
          <span>Esc 取消 · Ctrl+Enter 保存</span>
        </div>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
              return;
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="min-h-[120px] w-full resize-y rounded bg-background p-2 font-mono text-[12.5px] leading-6 text-foreground outline-none focus:ring-1 focus:ring-primary/40"
          spellCheck={false}
          placeholder={"graph TD\n    A --> B"}
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="div"
      className="group/mermaid relative my-2.5"
      data-selected={selected ? "" : undefined}
      onDoubleClick={(e: MouseEvent<HTMLDivElement>) => {
        // Double-click anywhere on the diagram opens the editor.
        e.preventDefault();
        setEditing(true);
      }}
    >
      <MermaidDiagram code={code} />
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setEditing(true);
        }}
        className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded-md bg-background/85 px-1.5 py-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/mermaid:opacity-100"
        title="编辑源码"
      >
        <Pencil className="h-3 w-3" />
        编辑
      </button>
    </NodeViewWrapper>
  );
}

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(getText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  }, [getText]);
  return (
    <button
      type="button"
      title={copied ? "已复制" : "复制代码"}
      aria-label={copied ? "已复制代码" : "复制代码"}
      onMouseDown={(e) => e.preventDefault()}
      onClick={handleCopy}
      className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border border-border/70 bg-background/80 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
