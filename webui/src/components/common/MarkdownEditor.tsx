import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import TiptapImage from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";

import { WikiLink } from "./WikiLinkExtension";
import {
  Bold,
  CheckSquare,
  ChevronDown,
  Code2,
  Code,
  ClipboardPaste,
  Copy,
  ExternalLink,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Image as ImageIcon,
  Italic,
  Link2,
  ListChecks,
  ListOrdered,
  MoveRight,
  Quote,
  Redo2,
  Scissors,
  Search,
  Strikethrough,
  Table2,
  TextSelect,
  Type,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type EditorMode = "visual" | "markdown";

export interface MarkdownEditorProps {
  content: string;
  mode?: EditorMode;
  onModeChange?: (mode: EditorMode) => void;
  onContentChange: (next: {
    contentMarkdown: string;
    contentJson?: JSONContent;
    plainText: string;
  }) => void;
  onMoveSelectionToNote?: (selectedText: string) => void;
  /** Open the note whose title matches the clicked wiki link. */
  onOpenNoteByTitle?: (title: string) => void;
  placeholder?: string;
  showToolbar?: boolean;
  showStats?: boolean;
  statsExtra?: React.ReactNode;
  className?: string;
  editorClassName?: string;
  children?: React.ReactNode;
  toolbarExtra?: React.ReactNode;
  /** Content rendered at the start of the editor toolbar (e.g. history buttons). */
  toolbarLeadingExtra?: React.ReactNode;
  /** Note titles for `[[wiki link]]` autocomplete in markdown mode. */
  noteTitles?: string[];
}

// Custom Image extension that serializes `assets/xxx.png` from title/alt instead of data URL
const NoteImage = TiptapImage.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("width") },
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize: {
          image(state: any, node: any) {
            // Use title (stores assets/xxx.png) as the Markdown src
            const src = node.attrs.title || node.attrs.alt || node.attrs.src;
            const alt = node.attrs.alt || "";
            state.write(`![${alt}](${src})`);
          },
        },
      },
    };
  },
}).configure({
  inline: false,
  allowBase64: false,
  HTMLAttributes: {
    class: "max-w-full h-auto rounded-lg my-2",
  },
});

export function MarkdownEditor({
  content,
  mode = "visual",
  onModeChange,
  onContentChange,
  onMoveSelectionToNote,
  onOpenNoteByTitle,
  placeholder = "记录想法、资料、处理过程或 Agent 输出...",
  showToolbar = true,
  showStats = true,
  statsExtra,
  className,
  editorClassName,
  children,
  toolbarExtra,
  toolbarLeadingExtra,
  noteTitles,
}: MarkdownEditorProps) {
  const settingContentRef = useRef(false);
  const lastMarkdownRef = useRef(content);
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  // Wiki-link autocomplete state (markdown mode only).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [wikiLinkState, setWikiLinkState] = useState<{
    open: boolean;
    query: string;
    startPos: number;
    cursorPos: number;
    selectedIndex: number;
  } | null>(null);

  const modeRef = useRef(mode);
  const wikiLinkStateRef = useRef(wikiLinkState);
  const wikiLinkSuggestionsRef = useRef<string[]>([]);
  const insertWikiLinkRef = useRef<(title: string) => void>(() => {});
  const onOpenNoteByTitleRef = useRef(onOpenNoteByTitle);
  onOpenNoteByTitleRef.current = onOpenNoteByTitle;
  const visualEditorRef = useRef<HTMLDivElement | null>(null);
  const [visualPopupPos, setVisualPopupPos] = useState<{ top: number; left: number } | null>(
    null,
  );

  const wikiLinkSuggestions = useMemo(() => {
    if (!wikiLinkState?.open || !noteTitles?.length) return [];
    const q = wikiLinkState.query.toLowerCase();
    if (!q) return noteTitles.slice(0, 10);
    return noteTitles
      .filter((t) => t.toLowerCase().includes(q))
      .slice(0, 10);
  }, [wikiLinkState, noteTitles]);

  const detectWikiLinkTrigger = useCallback((value: string, caret: number) => {
    // Look backwards from caret for an unclosed `[[`.
    const before = value.slice(0, caret);
    const lastOpen = before.lastIndexOf("[[");
    if (lastOpen === -1) {
      setWikiLinkState(null);
      return;
    }
    // Must be the start of a link (not inside `[[[...]]`).
    if (lastOpen > 0 && before[lastOpen - 1] === "[") {
      setWikiLinkState(null);
      return;
    }
    // Closing `]]` must not exist after the open.
    const afterOpen = before.slice(lastOpen + 2);
    if (afterOpen.includes("]]")) {
      setWikiLinkState(null);
      return;
    }
    // No newlines inside the link.
    if (afterOpen.includes("\n")) {
      setWikiLinkState(null);
      return;
    }
    setWikiLinkState({
      open: true,
      query: afterOpen,
      startPos: lastOpen,
      cursorPos: caret,
      selectedIndex: 0,
    });
  }, []);

  const findWikiLinkOpenPos = useCallback((editor: Editor) => {
    const { from } = editor.state.selection;
    for (let pos = from - 2; pos >= 1; pos--) {
      const text = editor.state.doc.textBetween(pos, pos + 2, "\n");
      if (text === "[[") return pos;
    }
    return null;
  }, []);

  const detectWikiLinkTriggerVisual = useCallback((editor: Editor) => {
    const { from } = editor.state.selection;
    const openPos = findWikiLinkOpenPos(editor);
    if (openPos === null) {
      setWikiLinkState(null);
      return;
    }
    const inner = editor.state.doc.textBetween(openPos + 2, from, "\n");
    if (inner.includes("]]") || inner.includes("\n")) {
      setWikiLinkState(null);
      return;
    }
    if (openPos > 1) {
      const charBefore = editor.state.doc.textBetween(openPos - 1, openPos, "\n");
      if (charBefore === "[") {
        setWikiLinkState(null);
        return;
      }
    }
    setWikiLinkState({
      open: true,
      query: inner,
      startPos: openPos,
      cursorPos: from,
      selectedIndex: 0,
    });
  }, [findWikiLinkOpenPos]);

  const expandWikiLinkAtCursor = useCallback((editor: Editor) => {
    // When the cursor is placed right after a wiki link, expand the link back
    // into plain `[[title]]` text so subsequent typing stays outside the link.
    const { selection, doc, schema } = editor.state;
    if (!selection.empty) return;

    let targetPos = -1;
    let targetNode: any = null;
    doc.descendants((node, pos) => {
      if (targetPos >= 0 || node.type.name !== "wikiLink") return;
      const end = pos + node.nodeSize;
      if (selection.from === end) {
        targetPos = pos;
        targetNode = node;
      }
    });

    if (targetPos < 0 || !targetNode) return;

    const title = targetNode.attrs?.title || targetNode.textContent || "";
    const text = `[[${title}]]`;
    const endPos = targetPos + targetNode.nodeSize;

    const tr = editor.state.tr;
    tr.replaceWith(targetPos, endPos, schema.text(text));
    tr.setSelection(TextSelection.create(tr.doc, targetPos + text.length));
    editor.view.dispatch(tr);
    editor.view.focus();
  }, []);

  const insertWikiLink = useCallback((title: string) => {
    const ed = editorRef.current;
    if (!ed || !wikiLinkState) return;
    setWikiLinkState(null);

    if (modeRef.current === "markdown") {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const value = textarea.value;
      const before = value.slice(0, wikiLinkState.startPos);
      const after = value.slice(wikiLinkState.cursorPos);
      const inserted = `[[${title}]]`;
      const next = before + inserted + after;
      settingContentRef.current = true;
      ed.commands.setContent(next, { contentType: "markdown" });
      settingContentRef.current = false;
      lastMarkdownRef.current = next;
      onContentChangeRef.current({
        contentMarkdown: next,
        contentJson: ed.getJSON(),
        plainText: ed.getText() ?? next,
      });
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        const pos = before.length + inserted.length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      });
    } else {
      // visual mode: replace the unclosed `[[query` (and trailing `]]`) with a wikiLink node.
      // The autocomplete leaves `[[]]` in the doc; when the user types a query the
      // cursor sits between the brackets, so `]]` is right after the cursor.
      let endPos = wikiLinkState.cursorPos;
      const afterText = ed.state.doc.textBetween(
        wikiLinkState.cursorPos,
        wikiLinkState.cursorPos + 2,
        "\n",
      );
      if (afterText === "]]") {
        endPos = wikiLinkState.cursorPos + 2;
      }
      ed.chain()
        .focus()
        .deleteRange({ from: wikiLinkState.startPos, to: endPos })
        .insertContent({
          type: "wikiLink",
          attrs: { title },
        })
        .run();
    }
  }, [wikiLinkState]);

  const handleTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!wikiLinkState?.open || wikiLinkSuggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setWikiLinkState((s) => s ? { ...s, selectedIndex: (s.selectedIndex + 1) % wikiLinkSuggestions.length } : s);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setWikiLinkState((s) => s ? { ...s, selectedIndex: (s.selectedIndex - 1 + wikiLinkSuggestions.length) % wikiLinkSuggestions.length } : s);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const selected = wikiLinkSuggestions[wikiLinkState.selectedIndex];
      if (selected) insertWikiLink(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setWikiLinkState(null);
    }
  }, [wikiLinkState, wikiLinkSuggestions, insertWikiLink]);

  // Keep refs in sync so editor event handlers (created once by Tiptap) can read
  // the latest state without being recreated.
  modeRef.current = mode;
  wikiLinkStateRef.current = wikiLinkState;
  wikiLinkSuggestionsRef.current = wikiLinkSuggestions;
  insertWikiLinkRef.current = insertWikiLink;

  // Cache: fileName -> asset URL (convertFileSrc result). The URL is stable for
  // a given vault path, so we can safely cache it for the editor's lifetime.
  const assetUrlCacheRef = useRef<Map<string, string>>(new Map());
  const vaultPathRef = useRef<string | null>(null);

  // Convert assets/ relative paths to asset-protocol URLs for rendering.
  const convertAssetsPaths = useCallback(async (editor: Editor) => {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const { getNotesVaultPath } = await import("@/lib/tauri");

    if (vaultPathRef.current === null) {
      vaultPathRef.current = await getNotesVaultPath();
    }
    const vaultPath = vaultPathRef.current;
    if (!vaultPath) return;

    const dpr = window.devicePixelRatio || 1;
    const tr = editor.state.tr;
    let modified = false;
    const pending: { pos: number; node: any; fileName: string; url: string }[] = [];

    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== "image" || !node.attrs.src) return;
      const src = node.attrs.src as string;
      const isRelativeAsset =
        src.startsWith("assets/") ||
        (!src.startsWith("http") && !src.startsWith("data:") && !src.includes(":") &&
         !src.startsWith("tauri:") && !src.startsWith("blob:"));
      if (!isRelativeAsset) return;

      const fileName = src.startsWith("assets/") ? src.slice("assets/".length) : src;
      let url = assetUrlCacheRef.current.get(fileName);
      if (!url) {
        url = convertFileSrc(`${vaultPath}/assets/${fileName}`);
        assetUrlCacheRef.current.set(fileName, url);
      }

      // If src is already the asset URL, no rewrite needed.
      if (src === url) return;

      // Sync rewrite for cached URL (no DPI detection needed — CSS handles it)
      tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        src: url,
        alt: node.attrs.alt || src,
        title: src,
      });
      modified = true;
      pending.push({ pos, node, fileName, url });
    });

    if (modified) {
      settingContentRef.current = true;
      editor.view.dispatch(tr);
      settingContentRef.current = false;
    }

    // Optional: detect natural dimensions for HiDPI scaling. Skipped on dpr<=1
    // since CSS max-width:100% already constrains the image.
    if (dpr <= 1 || pending.length === 0) return;

    const tr2 = editor.state.tr;
    let modified2 = false;
    await Promise.all(pending.map(async ({ pos, url }) => {
      const displayWidth = await new Promise<number | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
          resolve(img.naturalWidth > 0 ? Math.round(img.naturalWidth / dpr) : null);
        };
        img.onerror = () => resolve(null);
        img.src = url;
      });
      if (displayWidth == null) return;
      // Re-find the node at pos — it may have moved after the first dispatch.
      let found = false;
      editor.state.doc.descendants((n, p) => {
        if (found) return false;
        if (p !== pos) return;
        if (n.type.name !== "image") return;
        tr2.setNodeMarkup(p, undefined, {
          ...n.attrs,
          width: displayWidth,
        });
        modified2 = true;
        found = true;
        return false;
      });
    }));
    if (modified2) {
      settingContentRef.current = true;
      editor.view.dispatch(tr2);
      settingContentRef.current = false;
    }
  }, []);

  const insertImageFile = useCallback(async (file: File, view: any) => {
    const ext = file.name.split(".").pop() || "png";
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const fileName = `${id}.${ext}`;
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    try {
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      const { getNotesVaultPath } = await import("@/lib/tauri");

      if (vaultPathRef.current === null) {
        vaultPathRef.current = await getNotesVaultPath();
      }
      const vaultPath = vaultPathRef.current;
      if (!vaultPath) {
        console.warn("[MarkdownEditor] No vault path configured");
        return;
      }

      const absPath = `${vaultPath}/assets/${fileName}`;
      await writeFile(absPath, bytes);
      const url = convertFileSrc(absPath);
      assetUrlCacheRef.current.set(fileName, url);
      const markdownSrc = `assets/${fileName}`;

      const displayWidth = await new Promise<number | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
          const dpr = window.devicePixelRatio || 1;
          if (dpr > 1 && img.naturalWidth > 0) {
            resolve(Math.round(img.naturalWidth / dpr));
          } else {
            resolve(null);
          }
        };
        img.onerror = () => resolve(null);
        img.src = url;
      });

      view.dispatch(
        view.state.tr.replaceSelectionWith(
          view.state.schema.nodes.image.create({
            src: url,
            alt: markdownSrc,
            title: markdownSrc,
            ...(displayWidth != null ? { width: displayWidth } : {}),
          }),
        ),
      );
    } catch (err) {
      console.warn("[MarkdownEditor] Failed to save image:", err);
    }
  }, []);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
      }),
      NoteImage,
      TaskList.configure({
        HTMLAttributes: { class: "list-none pl-0 m-0" },
      }),
      TaskItem.configure({
        nested: true,
        HTMLAttributes: { class: "flex flex-row items-start gap-1.5" },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          class: "text-[#2f7fca] underline underline-offset-2",
        },
      }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder }),
      Markdown.configure({
        indentation: { style: "space", size: 2 },
      }),
      WikiLink.configure({
        onOpenNote: (title: string) => onOpenNoteByTitleRef.current?.(title),
      }),
    ],
    [placeholder],
  );

  const editor = useEditor({
    extensions,
    content,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "notes-prosemirror",
      },
      handleKeyDown: (view, event) => {
        // Auto-complete: typing a second `[` turns `[[` into `[[]]` with the
        // cursor placed between the brackets (mirrors Obsidian's behaviour).
        if (event.key === "[") {
          const { state } = view;
          const { from } = state.selection;
          if (from > 0) {
            const before = state.doc.textBetween(from - 1, from, "\n");
            if (before === "[") {
              // Avoid turning `[[[` into `[[[]]`.
              if (from > 1 && state.doc.textBetween(from - 2, from - 1, "\n") === "[") {
                return false;
              }
              event.preventDefault();
              // The second `[` was prevented, so the doc only has one `[`.
              // Insert `[]]` to produce `[[]]`, cursor at `from + 1` (between
              // `[[` and `]]` so typing immediately enters the link query).
              const tr = state.tr.insertText("[]]", from);
              tr.setSelection(TextSelection.create(tr.doc, from + 1));
              view.dispatch(tr);
              return true;
            }
          }
        }

        const state = wikiLinkStateRef.current;
        const suggestions = wikiLinkSuggestionsRef.current;
        if (!state?.open || suggestions.length === 0) return false;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setWikiLinkState((s) =>
            s ? { ...s, selectedIndex: (s.selectedIndex + 1) % suggestions.length } : s,
          );
          return true;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setWikiLinkState((s) =>
            s
              ? {
                  ...s,
                  selectedIndex:
                    (s.selectedIndex - 1 + suggestions.length) % suggestions.length,
                }
              : s,
          );
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const selected = suggestions[state.selectedIndex];
          if (selected) insertWikiLinkRef.current(selected);
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setWikiLinkState(null);
          return true;
        }
        return false;
      },
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            event.preventDefault();
            const file = item.getAsFile();
            if (file) insertImageFile(file, view);
            return true;
          }
        }
        return false;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        for (const file of files) {
          if (file.type.startsWith("image/")) {
            event.preventDefault();
            insertImageFile(file, view);
            return true;
          }
        }
        return false;
      },
    },
    onCreate: async ({ editor }) => {
      await convertAssetsPaths(editor);
    },
    onUpdate: ({ editor }) => {
      if (settingContentRef.current) return;
      if (modeRef.current === "visual") {
        detectWikiLinkTriggerVisual(editor);
      }
      const contentMarkdown = editor.getMarkdown();
      lastMarkdownRef.current = contentMarkdown;
      // Defer the parent setState to a microtask so it never fires
      // synchronously during React's render phase (avoids the
      // "Cannot update a component while rendering a different component" warning).
      const snapshot = {
        contentMarkdown,
        contentJson: editor.getJSON(),
        plainText: editor.getText(),
      };
      queueMicrotask(() => onContentChangeRef.current(snapshot));
    },
    onSelectionUpdate: ({ editor }) => {
      // Wiki-link autocomplete is intentionally triggered only by content
      // changes (onUpdate), not by selection changes, so clicking into an
      // existing link does not reopen the popup.
      // However, when the cursor lands right after a wiki link (e.g. by
      // clicking the right edge or pressing ArrowRight), expand the link into
      // plain text so the user can keep typing as normal text.
      expandWikiLinkAtCursor(editor);
    },
  });

  // Keep editorRef in sync so wiki-link callbacks can access the editor
  // without being in its useCallback dependency array (avoids TDZ).
  editorRef.current = editor;

  // Compute visual-mode wiki-link popup position relative to the editor wrapper.
  useEffect(() => {
    if (!wikiLinkState?.open || mode !== "visual") {
      setVisualPopupPos(null);
      return;
    }
    const ed = editorRef.current;
    const wrapper = visualEditorRef.current;
    if (!ed || !wrapper) return;
    const coords = ed.view.coordsAtPos(wikiLinkState.cursorPos);
    const rect = wrapper.getBoundingClientRect();
    setVisualPopupPos({
      top: coords.bottom - rect.top,
      left: coords.left - rect.left,
    });
  }, [wikiLinkState, mode]);

  // Close wiki-link popup when the visual editor loses focus.
  useEffect(() => {
    if (!editor) return;
    const handleBlur = () => setWikiLinkState(null);
    editor.on("blur", handleBlur);
    return () => {
      editor.off("blur", handleBlur);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const editorMarkdown = editor.getMarkdown();
    const externalChange =
      content !== lastMarkdownRef.current &&
      content !== editorMarkdown;
    if (!externalChange) return;

    settingContentRef.current = true;
    editor.commands.setContent(content, { contentType: "markdown" });
    settingContentRef.current = false;
    lastMarkdownRef.current = content;

    // Convert assets/ paths to data URLs after setting content
    convertAssetsPaths(editor);
  }, [editor, content, convertAssetsPaths]);

  const handleMarkdownChange = (value: string) => {
    if (!editor) return;
    settingContentRef.current = true;
    editor.commands.setContent(value, { contentType: "markdown" });
    settingContentRef.current = false;
    lastMarkdownRef.current = value;
    onContentChange({
      contentMarkdown: value,
      contentJson: editor.getJSON(),
      plainText: editor.getText(),
    });
  };

  const charCount = content.replace(/\s/g, "").length;
  const lineCount = content.split(/\r?\n/).length;

  return (
    <section
      data-note-editor="true"
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-background", className)}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/65 px-3">
        {showToolbar ? <EditorToolbar editor={editor} leadingExtra={toolbarLeadingExtra} /> : <div />}
        {toolbarExtra ?? (onModeChange ? (
          <div className="flex items-center gap-0.5 rounded-lg border border-border/70 bg-muted/30 p-0.5">
            <button
              type="button"
              title="可视化编辑"
              aria-label="可视化编辑"
              onClick={() => onModeChange("visual")}
              className={cn(
                "grid h-6 w-6 place-items-center rounded-md transition-colors",
                mode === "visual"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Type className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="MD 源码"
              aria-label="MD 源码"
              onClick={() => onModeChange("markdown")}
              className={cn(
                "grid h-6 w-6 place-items-center rounded-md transition-colors",
                mode === "markdown"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <FileCode2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null)}
      </div>

      {mode === "visual" ? (
        <EditorContextMenu editor={editor} onMoveSelectionToNote={onMoveSelectionToNote}>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <div
              ref={visualEditorRef}
              className={cn(
                "relative mx-auto w-full max-w-[700px] px-5 py-5",
                editorClassName,
              )}
            >
              {children}
              <EditorContent
                editor={editor}
                className="mt-4 text-[13.5px] leading-6 text-foreground [&_.ProseMirror]:min-h-[380px] [&_.ProseMirror]:outline-none [&_.ProseMirror]:caret-[--foreground] [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-border [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:bg-muted [&_.ProseMirror_code]:px-1 [&_.ProseMirror_h1]:mb-2 [&_.ProseMirror_h1]:mt-5 [&_.ProseMirror_h1]:text-[22px] [&_.ProseMirror_h1]:font-bold [&_.ProseMirror_h2]:mb-2 [&_.ProseMirror_h2]:mt-5 [&_.ProseMirror_h2]:text-[18px] [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h3]:mb-2 [&_.ProseMirror_h3]:mt-4 [&_.ProseMirror_h3]:text-[15px] [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_h4]:mb-1.5 [&_.ProseMirror_h4]:mt-3 [&_.ProseMirror_h4]:text-[14px] [&_.ProseMirror_h4]:font-semibold [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:h-auto [&_.ProseMirror_img]:rounded-lg [&_.ProseMirror_img]:my-2 [&_.ProseMirror_li]:my-0.5 [&_.ProseMirror_ol]:ml-5 [&_.ProseMirror_p]:my-1.5 [&_.ProseMirror_pre]:my-2.5 [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre]:border [&_.ProseMirror_pre]:border-border/70 [&_.ProseMirror_pre]:bg-muted/45 [&_.ProseMirror_pre]:p-2.5 [&_.ProseMirror_s]:line-through [&_.ProseMirror_s]:text-muted-foreground [&_.ProseMirror_table]:my-2.5 [&_.ProseMirror_table]:w-full [&_.ProseMirror_table]:border-collapse [&_.ProseMirror_td]:border [&_.ProseMirror_td]:border-border [&_.ProseMirror_td]:px-2 [&_.ProseMirror_td]:py-1.5 [&_.ProseMirror_th]:border [&_.ProseMirror_th]:border-border [&_.ProseMirror_th]:bg-muted/45 [&_.ProseMirror_th]:px-2 [&_.ProseMirror_th]:py-1.5 [&_.ProseMirror_ul]:ml-5"
              />
              {wikiLinkState?.open && wikiLinkSuggestions.length > 0 && visualPopupPos && (
                <div
                  style={{ top: visualPopupPos.top, left: visualPopupPos.left }}
                  className="absolute z-50 min-w-[200px] max-w-[320px] rounded-md border border-border/70 bg-popover py-1 shadow-lg"
                >
                  {wikiLinkSuggestions.map((title, idx) => (
                    <button
                      key={title}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertWikiLink(title);
                      }}
                      className={cn(
                        "flex w-full items-center px-2.5 py-1 text-left text-[12px]",
                        idx === wikiLinkState.selectedIndex
                          ? "bg-accent text-foreground"
                          : "text-foreground/85 hover:bg-accent/60",
                      )}
                    >
                      <span className="truncate">{title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </EditorContextMenu>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className={cn("mx-auto flex h-full w-full max-w-[700px] flex-col px-5 py-5", editorClassName)}>
            {children}
            <div className="relative mt-4 flex-1">
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(event) => {
                  handleMarkdownChange(event.target.value);
                  const ta = event.target;
                  detectWikiLinkTrigger(ta.value, ta.selectionStart);
                }}
                onKeyDown={handleTextareaKeyDown}
                onBlur={() => setTimeout(() => setWikiLinkState(null), 200)}
                className="min-h-[380px] w-full flex-1 resize-none rounded-lg border border-border/70 bg-background px-3 py-2.5 font-mono text-[12.5px] leading-6 text-foreground outline-none scrollbar-thin focus:border-[#6aa7ff]/65"
                spellCheck={false}
              />
              {wikiLinkState?.open && wikiLinkSuggestions.length > 0 && (
                <div className="absolute z-50 min-w-[200px] max-w-[320px] rounded-md border border-border/70 bg-popover py-1 shadow-lg">
                  {wikiLinkSuggestions.map((title, idx) => (
                    <button
                      key={title}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertWikiLink(title);
                      }}
                      className={cn(
                        "flex w-full items-center px-2.5 py-1 text-left text-[12px]",
                        idx === wikiLinkState.selectedIndex
                          ? "bg-accent text-foreground"
                          : "text-foreground/85 hover:bg-accent/60",
                      )}
                    >
                      <span className="truncate">{title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showStats ? (
        <div className="flex h-7 shrink-0 items-center justify-between border-t border-border/65 px-3 text-[11px] text-muted-foreground">
          <span>{statsExtra}</span>
          <span>
            {charCount} 字 · {lineCount} 行
          </span>
        </div>
      ) : null}
    </section>
  );
}

function EditorContextMenu({ editor, children, onMoveSelectionToNote }: { editor: Editor | null; children: React.ReactNode; onMoveSelectionToNote?: (selectedText: string) => void; }) {
  const [hasSelection, setHasSelection] = useState(false);
  const [selectedText, setSelectedText] = useState("");

  const updateSelection = () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const hasSel = from !== to;
    setHasSelection(hasSel);
    if (hasSel) {
      setSelectedText(editor.state.doc.textBetween(from, to, "\n"));
    }
  };

  const handleCopy = async () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = editor.state.doc.textBetween(from, to, "\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  };

  const handleCut = async () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = editor.state.doc.textBetween(from, to, "\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
    editor.chain().focus().deleteSelection().run();
  };

  const handlePaste = async () => {
    if (!editor) return;
    try {
      const text = await navigator.clipboard.readText();
      editor.chain().focus().insertContent(text).run();
    } catch {}
  };

  const handlePasteAsPlainText = async () => {
    if (!editor) return;
    try {
      const text = await navigator.clipboard.readText();
      editor.chain().focus().insertContent(text).run();
    } catch {}
  };

  const handleSelectAll = () => {
    editor?.chain().focus().selectAll().run();
  };

  const handleAddInternalLink = () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = editor.state.doc.textBetween(from, to, "\n");
    editor.chain().focus().deleteSelection().insertContent(`[[${text}]]`).run();
  };

  const handleAddExternalLink = () => {
    if (!editor) return;
    const url = window.prompt("输入链接地址");
    if (!url) return;
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const handleRemoveLink = () => {
    editor?.chain().focus().unsetLink().run();
  };

  const handleFind = () => {
    if (!selectedText) return;
    try {
      (window as any).find(selectedText, false, false, true);
    } catch {}
  };

  const handleMoveToNote = () => {
    if (!editor || !onMoveSelectionToNote) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = editor.state.doc.textBetween(from, to, "\n");
    onMoveSelectionToNote(text);
    editor.chain().focus().deleteSelection().run();
  };

  return (
    <ContextMenu onOpenChange={updateSelection}>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {hasSelection ? (
          <>
            <ContextMenuItem onSelect={handleAddInternalLink}>
              <Link2 className="mr-2 h-3.5 w-3.5" />
              新增链接
            </ContextMenuItem>
            <ContextMenuItem onSelect={handleAddExternalLink}>
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              新增外部链接
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={handleFind}>
              <Search className="mr-2 h-3.5 w-3.5" />
              查找“{selectedText.length > 12 ? `${selectedText.slice(0, 12)}…` : selectedText}”
            </ContextMenuItem>
            {onMoveSelectionToNote ? (
              <ContextMenuItem onSelect={handleMoveToNote}>
                <MoveRight className="mr-2 h-3.5 w-3.5" />
                移动到其他笔记
              </ContextMenuItem>
            ) : null}
          </>
        ) : null}

        {hasSelection ? <ContextMenuSeparator /> : null}
        {/* 段落设置 submenu */}
        <ContextMenuSub>
          <ContextMenuSubTrigger className="text-[13px]">
            <Type className="mr-2 h-3.5 w-3.5" />
            段落设置
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            <ContextMenuItem onSelect={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
              <Heading1 className="mr-2 h-3.5 w-3.5" />
              标题 1
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
              <Heading2 className="mr-2 h-3.5 w-3.5" />
              标题 2
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>
              <Heading3 className="mr-2 h-3.5 w-3.5" />
              标题 3
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => editor?.chain().focus().toggleHeading({ level: 4 }).run()}>
              <Heading4 className="mr-2 h-3.5 w-3.5" />
              标题 4
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => editor?.chain().focus().setParagraph().run()}>
              <Type className="mr-2 h-3.5 w-3.5" />
              正文
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => editor?.chain().focus().toggleBlockquote().run()}>
              <Quote className="mr-2 h-3.5 w-3.5" />
              引用
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => editor?.chain().focus().toggleCodeBlock().run()}>
              <Code2 className="mr-2 h-3.5 w-3.5" />
              代码块
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>

        {hasSelection ? (
          /* 文本格式 submenu */
          <ContextMenuSub>
            <ContextMenuSubTrigger className="text-[13px]">
              <Bold className="mr-2 h-3.5 w-3.5" />
              文本格式
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-40">
              <ContextMenuItem onSelect={() => editor?.chain().focus().toggleBold().run()}>
                <Bold className="mr-2 h-3.5 w-3.5" />
                加粗
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => editor?.chain().focus().toggleItalic().run()}>
                <Italic className="mr-2 h-3.5 w-3.5" />
                斜体
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => editor?.chain().focus().toggleStrike().run()}>
                <Strikethrough className="mr-2 h-3.5 w-3.5" />
                删除线
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => editor?.chain().focus().toggleCode().run()}>
                <Code className="mr-2 h-3.5 w-3.5" />
                行内代码
              </ContextMenuItem>
              <ContextMenuSeparator />
              {editor?.isActive("link") ? (
                <ContextMenuItem onSelect={handleRemoveLink}>
                  <Link2 className="mr-2 h-3.5 w-3.5" />
                  移除链接
                </ContextMenuItem>
              ) : (
                <ContextMenuItem onSelect={handleAddExternalLink}>
                  <Link2 className="mr-2 h-3.5 w-3.5" />
                  添加链接
                </ContextMenuItem>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}

        {/* 插入 submenu */}
        <ContextMenuSub>
          <ContextMenuSubTrigger className="text-[13px]">
            <ListChecks className="mr-2 h-3.5 w-3.5" />
            插入
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            <ContextMenuItem onSelect={() => editor?.chain().focus().toggleTaskList().run()}>
              <CheckSquare className="mr-2 h-3.5 w-3.5" />
              任务清单
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => editor?.chain().focus().toggleBulletList().run()}>
              <ListChecks className="mr-2 h-3.5 w-3.5" />
              项目列表
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => editor?.chain().focus().toggleOrderedList().run()}>
              <ListOrdered className="mr-2 h-3.5 w-3.5" />
              编号列表
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
              <Table2 className="mr-2 h-3.5 w-3.5" />
              表格
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSeparator />
        {hasSelection ? (
          <>
            <ContextMenuItem onSelect={handleCut}>
              <Scissors className="mr-2 h-3.5 w-3.5" />
              剪切
            </ContextMenuItem>
            <ContextMenuItem onSelect={handleCopy}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              复制
            </ContextMenuItem>
          </>
        ) : null}
        <ContextMenuItem onSelect={handlePaste}>
          <ClipboardPaste className="mr-2 h-3.5 w-3.5" />
          粘贴
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlePasteAsPlainText}>
          <ClipboardPaste className="mr-2 h-3.5 w-3.5" />
          以纯文本形式粘贴
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handleSelectAll}>
          <TextSelect className="mr-2 h-3.5 w-3.5" />
          全选
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

type HeadingLevel = 1 | 2 | 3 | 4;

const HEADING_OPTIONS: { value: "paragraph" | `heading${HeadingLevel}`; label: string }[] = [
  { value: "paragraph", label: "正文" },
  { value: "heading1", label: "标题 1" },
  { value: "heading2", label: "标题 2" },
  { value: "heading3", label: "标题 3" },
  { value: "heading4", label: "标题 4" },
];

function getCurrentStyle(editor: Editor | null): "paragraph" | `heading${HeadingLevel}` {
  if (!editor) return "paragraph";
  if (editor.isActive("heading", { level: 1 })) return "heading1";
  if (editor.isActive("heading", { level: 2 })) return "heading2";
  if (editor.isActive("heading", { level: 3 })) return "heading3";
  if (editor.isActive("heading", { level: 4 })) return "heading4";
  return "paragraph";
}

function HeadingStyleDropdown({ editor }: { editor: Editor | null }) {
  const currentStyle = getCurrentStyle(editor);
  const currentLabel = HEADING_OPTIONS.find((o) => o.value === currentStyle)?.label ?? "正文";

  const handleSelect = (value: string) => {
    if (!editor) return;
    if (value === "paragraph") {
      editor.chain().focus().setParagraph().run();
      return;
    }
    const level = Number(value.replace("heading", "")) as HeadingLevel;
    editor.chain().focus().toggleHeading({ level }).run();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!editor}
          className="h-[26px] gap-1 px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <span className="min-w-[3.5em] text-left">{currentLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-28">
        <DropdownMenuRadioGroup value={currentStyle} onValueChange={handleSelect}>
          {HEADING_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="text-[13px]">
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EditorToolbar({
  editor,
  leadingExtra,
}: {
  editor: Editor | null;
  leadingExtra?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-thin">
      {leadingExtra ? <>{leadingExtra}</> : null}
      <HeadingStyleDropdown editor={editor} />
      <ToolbarButton
        label="加粗"
        active={editor?.isActive("bold") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        <Bold className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="斜体"
        active={editor?.isActive("italic") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        <Italic className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="任务清单"
        active={editor?.isActive("taskList") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleTaskList().run()}
      >
        <CheckSquare className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="项目列表"
        active={editor?.isActive("bulletList") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <ListChecks className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="编号列表"
        active={editor?.isActive("orderedList") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="引用"
        active={editor?.isActive("blockquote") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleBlockquote().run()}
      >
        <Quote className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="代码块"
        active={editor?.isActive("codeBlock") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
      >
        <Code2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="表格"
        disabled={!editor}
        onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        <Table2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="链接"
        active={editor?.isActive("link") ?? false}
        disabled={!editor}
        onClick={() => {
          const url = window.prompt("输入链接地址");
          if (!url) return;
          editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
        }}
      >
        <Link2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="图片"
        disabled={!editor}
        onClick={async () => {
          try {
            const { open } = await import("@tauri-apps/plugin-dialog");
            const selected = await open({
              multiple: false,
              filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"] }],
            });
            if (!selected) return;
            const filePath = selected;
            if (!filePath) return;
            const { copyFile } = await import("@tauri-apps/plugin-fs");
            const { convertFileSrc } = await import("@tauri-apps/api/core");
            const { getNotesVaultPath } = await import("@/lib/tauri");
            const vaultPath = await getNotesVaultPath();
            if (!vaultPath) return;
            const ext = filePath.split(".").pop() || "png";
            const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
            const fileName = `${id}.${ext}`;
            const absPath = `${vaultPath}/assets/${fileName}`;
            await copyFile(filePath, absPath);
            const url = convertFileSrc(absPath);
            const markdownSrc = `assets/${fileName}`;
            const dpr = window.devicePixelRatio || 1;
            const displayWidth = await new Promise<number | null>((resolve) => {
              if (dpr <= 1) { resolve(null); return; }
              const img = new Image();
              img.onload = () => {
                resolve(img.naturalWidth > 0 ? Math.round(img.naturalWidth / dpr) : null);
              };
              img.onerror = () => resolve(null);
              img.src = url;
            });
            editor?.chain().focus().setImage({
              src: url,
              alt: markdownSrc,
              title: markdownSrc,
              ...(displayWidth != null ? { width: displayWidth } : {}),
            }).run();
          } catch (err) {
            console.warn("[MarkdownEditor] Failed to insert image:", err);
          }
        }}
      >
        <ImageIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border/70" />
      <ToolbarButton
        label="撤销"
        disabled={!editor || !editor.can().chain().focus().undo().run()}
        onClick={() => editor?.chain().focus().undo().run()}
      >
        <Undo2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="重做"
        disabled={!editor || !editor.can().chain().focus().redo().run()}
        onClick={() => editor?.chain().focus().redo().run()}
      >
        <Redo2 className="h-3.5 w-3.5" />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  label,
  active = false,
  disabled = false,
  children,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-[26px] w-[26px] rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </Button>
  );
}
