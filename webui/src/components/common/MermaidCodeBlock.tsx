import { useCallback, useEffect, useState, type MouseEvent } from "react";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { CodeBlock } from "@tiptap/extension-code-block";
import { TextSelection } from "@tiptap/pm/state";
import { Pencil } from "lucide-react";

import { MermaidDiagram } from "@/components/knowledge/mermaid-diagram";

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
}: MermaidCodeBlockViewProps) {
  const language = (node.attrs.language as string | null) ?? "";
  const isMermaid = language.toLowerCase() === "mermaid";
  const code = node.textContent;

  // Local edit state for mermaid blocks.
  const [editing, setEditing] = useState<boolean>(code.length === 0);
  const [draft, setDraft] = useState<string>(code);

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
    return (
      <NodeViewWrapper
        as="pre"
        className="my-2.5 overflow-x-auto rounded-lg border border-border/70 bg-muted/45 p-2.5"
      >
        <NodeViewContent<"code">
          as="code"
          className={language ? `language-${language}` : undefined}
        />
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
