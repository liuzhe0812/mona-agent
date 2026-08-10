import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import TiptapImage from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";

import { WikiLink } from "./WikiLinkExtension";
import { NoteEmbed } from "./NoteEmbedExtension";
import { MermaidCodeBlock } from "./MermaidCodeBlock";
import { FindReplaceBar, setActiveFindApi, useFindBarHotkey } from "./FindReplaceBar";
import { InlineMath, BlockMath } from "./editor-extensions/math-extension";
import { MermaidDiagram } from "./editor-extensions/mermaid-extension";
import { SlashCommand } from "./editor-extensions/slash-command";
import { SlashCommandPortal } from "./editor-extensions/slash-command/slash-command-portal";
import { TableBubbleMenu } from "./editor-extensions/table-bubble-menu";
import { ImageBubbleMenu } from "./editor-extensions/image-bubble-menu";
import { renderTableToMarkdown } from "./editor-extensions/table-markdown";
import {
  Bold,
  CheckSquare,
  Code2,
  Code,
  ClipboardPaste,
  Columns3,
  Combine,
  Copy,
  ExternalLink,
  FileCode2,
  FolderOpen,
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
  Rows3,
  Scissors,
  Search,
  Split,
  Strikethrough,
  Table2,
  TextSelect,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { SelectionAiToolbar } from "./SelectionAiToolbar";
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
  /** Content rendered after the mode switch buttons in the toolbar. */
  toolbarTrailingExtra?: React.ReactNode;
  /** Note titles for `[[wiki link]]` autocomplete in markdown mode. */
  noteTitles?: string[];
  /** Enable inline selection AI toolbar (润色/缩写/翻译). */
  enableSelectionAi?: boolean;
  /** Returns the current note title for selection AI context. */
  getNoteTitle?: () => string;
  /** Resolve embed target content by title (`![[...]]`). Returns null if not found. */
  resolveEmbedContent?: (title: string) => string | null;
  /** Whether the embed target is a flowchart note. */
  isEmbedFlowchart?: (title: string) => boolean;
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
  resize: {
    enabled: true,
    directions: ["top-left", "top-right", "bottom-left", "bottom-right", "left", "right"],
    minWidth: 80,
    minHeight: 80,
    alwaysPreserveAspectRatio: true,
  },
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
  toolbarTrailingExtra,
  noteTitles,
  enableSelectionAi = false,
  getNoteTitle,
  resolveEmbedContent,
  isEmbedFlowchart,
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
  const resolveEmbedContentRef = useRef(resolveEmbedContent);
  resolveEmbedContentRef.current = resolveEmbedContent;
  const isEmbedFlowchartRef = useRef(isEmbedFlowchart);
  isEmbedFlowchartRef.current = isEmbedFlowchart;
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
    // 收集所有需要 DPR 调整的图片（缺 width 且 src 是本地资源）
    const pending: { pos: number; url: string }[] = [];

    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== "image" || !node.attrs.src) return;
      const src = node.attrs.src as string;
      const isRelativeAsset =
        src.startsWith("assets/") ||
        (!src.startsWith("http") && !src.startsWith("data:") && !src.includes(":") &&
         !src.startsWith("tauri:") && !src.startsWith("blob:"));

      // 已有 width 的图片不需要 DPR 调整
      if (node.attrs.width) return;

      if (isRelativeAsset) {
        // assets/xxx.png → 转成 asset:// URL
        const fileName = src.startsWith("assets/") ? src.slice("assets/".length) : src;
        let url = assetUrlCacheRef.current.get(fileName);
        if (!url) {
          url = convertFileSrc(`${vaultPath}/assets/${fileName}`);
          assetUrlCacheRef.current.set(fileName, url);
        }
        if (src !== url) {
          tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            src: url,
            alt: node.attrs.alt || src,
            title: src,
          });
          modified = true;
        }
        pending.push({ pos, url });
      } else if (src.startsWith("http://asset.") || src.startsWith("asset://")) {
        // 已经是 asset URL（重新载入的情况），只需 DPR 调整
        pending.push({ pos, url: src });
      }
    });

    if (modified) {
      settingContentRef.current = true;
      editor.view.dispatch(tr);
      settingContentRef.current = false;
    }

    // HiDPI: 按系统缩放比缩小显示宽度。每张图片用独立的新鲜事务，
    // 避免批量事务在 await 期间过期被 ProseMirror 忽略。
    if (dpr <= 1 || pending.length === 0) return;

    for (const { pos, url } of pending) {
      const displayWidth = await new Promise<number | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
          resolve(img.naturalWidth > 0 ? Math.round(img.naturalWidth / dpr) : null);
        };
        img.onerror = () => resolve(null);
        img.src = url;
      });
      if (displayWidth == null) continue;
      // 每次都用当前最新 state 创建事务，避免过期
      const freshTr = editor.state.tr;
      let found = false;
      editor.state.doc.descendants((n, p) => {
        if (found) return false;
        if (p !== pos) return;
        if (n.type.name !== "image") return;
        // 已有 width 则跳过（可能被前一张图片的 dispatch 改变了）
        if (n.attrs.width) { found = true; return false; }
        freshTr.setNodeMarkup(p, undefined, {
          ...n.attrs,
          width: displayWidth,
        });
        found = true;
        return false;
      });
      if (found && freshTr.steps.length > 0) {
        settingContentRef.current = true;
        editor.view.dispatch(freshTr);
        settingContentRef.current = false;
      }
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
        codeBlock: false,
      }),
      MermaidCodeBlock,
      NoteImage,
      TaskList.configure({
        HTMLAttributes: {},
      }),
      TaskItem.configure({
        nested: true,
        HTMLAttributes: { "data-type": "taskItem" },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          class: "text-[#2f7fca] underline underline-offset-2",
        },
      }),
      Table.extend({
        renderMarkdown: (node, h) => renderTableToMarkdown(node, h),
      }).configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      // 文字对齐：支持段落、标题、表格单元格
      TextAlign.configure({
        types: ["paragraph", "heading", "tableCell"],
      }),
      // 文字颜色 / 高亮背景色：依赖 TextStyle 存储 color 属性
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Placeholder.configure({ placeholder }),
      Markdown.configure({
        indentation: { style: "space", size: 2 },
        markedOptions: { breaks: true },
      }),
      // 数学公式扩展（行内 + 块级），输入 $...$ 或 $$...$$ 自动识别
      InlineMath,
      BlockMath,
      // Mermaid 图表扩展（独立节点，支持流程图/时序图/类图等）
      MermaidDiagram,
      // SlashCommand（/ 命令面板）
      SlashCommand,
      // NoteEmbed 必须在 WikiLink 之前注册，因为 `![[...]]` 的 `[[` 会被
      // WikiLink 的 tokenizer 捕获。NoteEmbed 的 start 检测 `![[` 先匹配。
      NoteEmbed.configure({
        resolveContent: (title: string) => resolveEmbedContentRef.current?.(title) ?? null,
        isFlowchart: (title: string) => isEmbedFlowchartRef.current?.(title) ?? false,
        onOpen: (title: string) => onOpenNoteByTitleRef.current?.(title),
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
      handleDOMEvents: {
        contextmenu: (view, event: Event) => {
          // 右键点击图片时自动选中图片节点，使图片专属右键菜单生效
          const target = event.target as HTMLElement;
          if (!target || target.tagName !== "IMG") return false;
          const pos = view.posAtDOM(target, 0);
          if (pos == null) return false;
          try {
            const tr = view.state.tr;
            tr.setSelection(NodeSelection.create(view.state.doc, pos));
            view.dispatch(tr);
          } catch {}
          return false;
        },
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

  // 强制设置光标颜色：WebView2 对 caret-color 的 CSS 变量/currentColor 支持不稳定，
  // 直接用 JS 操作 DOM 读取计算后的 color 值再赋给 caretColor，确保可见。
  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom as HTMLElement;
    const applyCaretColor = () => {
      const computedColor = window.getComputedStyle(el).color;
      el.style.caretColor = computedColor;
    };
    applyCaretColor();
    // 主题切换时重新应用
    const observer = new MutationObserver(applyCaretColor);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [editor]);

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

  // In-editor find/replace bar state. Ctrl+F / Ctrl+H open it.
  const [findBarState, setFindBarState] = useState<{
    open: boolean;
    mode: "find" | "replace";
  } | null>(null);
  useFindBarHotkey((mode) => setFindBarState({ open: true, mode }));

  // Register this editor as the find/replace target. Re-register on focus so
  // the most recently focused editor wins when multiple tabs are open.
  useEffect(() => {
    if (!editor) return;
    const api = {
      openFind: () => setFindBarState({ open: true, mode: "find" as const }),
      openReplace: () => setFindBarState({ open: true, mode: "replace" as const }),
    };
    const dispose = setActiveFindApi(api);
    const handleFocus = () => setActiveFindApi(api);
    editor.on("focus", handleFocus);
    return () => {
      editor.off("focus", handleFocus);
      dispose();
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

  // 源码模式行号：与 textarea 行数一致，保证滚动同步
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const lineNumbers = useMemo(
    () => Array.from({ length: content.split(/\r?\n/).length }, (_, i) => i + 1),
    [content],
  );

  return (
    <section
      data-note-editor="true"
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-background", className)}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/65 px-3">
        {showToolbar ? <EditorToolbar editor={editor} leadingExtra={toolbarLeadingExtra} /> : <div />}
        {toolbarExtra ?? (
          <div className="flex items-center gap-1.5">
            {onModeChange ? (
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
            ) : null}
            {toolbarTrailingExtra}
          </div>
        )}
      </div>

      {mode === "visual" && findBarState?.open && editor ? (
        <FindReplaceBar
          editor={editor}
          mode={findBarState.mode}
          onClose={() => setFindBarState(null)}
        />
      ) : null}

      {mode === "visual" ? (
        <EditorContextMenu editor={editor} onMoveSelectionToNote={onMoveSelectionToNote}>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <style>{`
              .ProseMirror li[data-type="taskItem"] {
                display: flex !important;
                align-items: center !important;
                gap: 0.5rem !important;
                margin-bottom: 0.25rem !important;
                min-height: 1.5rem !important;
              }
              .ProseMirror li[data-type="taskItem"] > label {
                flex: 0 0 auto !important;
                margin-right: 0 !important;
                user-select: none !important;
                display: inline-flex !important;
                align-items: center !important;
                height: 1.5rem !important;
                line-height: 1.5rem !important;
              }
              .ProseMirror li[data-type="taskItem"] > label input[type="checkbox"] {
                cursor: pointer !important;
                margin: 0 !important;
                width: 1rem !important;
                height: 1rem !important;
                accent-color: hsl(var(--primary)) !important;
              }
              .ProseMirror li[data-type="taskItem"] > label span {
                display: none !important;
              }
              .ProseMirror li[data-type="taskItem"] > div {
                flex: 1 1 auto !important;
                min-width: 0 !important;
                display: flex !important;
                align-items: center !important;
                min-height: 1.5rem !important;
              }
              .ProseMirror li[data-type="taskItem"] > div > p {
                margin-top: 0 !important;
                margin-bottom: 0 !important;
                line-height: 1.5rem !important;
              }
              .ProseMirror li[data-type="taskItem"][data-checked="true"] > div {
                color: hsl(var(--muted-foreground)) !important;
              }
              .ProseMirror li[data-type="taskItem"][data-checked="true"] > div > p {
                text-decoration: line-through !important;
              }
              /* 表格斑马纹（对齐 notegen） */
              .ProseMirror .tableWrapper {
                margin: 1em 0;
                overflow-x: auto;
                max-width: 100%;
              }
              .ProseMirror table {
                border-collapse: collapse;
                width: max-content;
                min-width: 100%;
                max-width: none;
                margin: 0;
                table-layout: auto;
              }
              .ProseMirror table th,
              .ProseMirror table td {
                min-width: 100px;
                empty-cells: hide;
                white-space: normal;
                overflow-wrap: break-word;
                word-break: normal;
              }
              .ProseMirror table tbody tr:nth-child(2n) {
                background-color: hsl(var(--muted) / 0.15);
              }
              .ProseMirror table thead tr:first-child th {
                background-color: hsl(var(--muted) / 0.4);
              }
              .ProseMirror table th {
                font-weight: 600;
              }
              /* 选中单元格 */
              .ProseMirror .selectedCell {
                background-color: hsl(var(--primary) / 0.15) !important;
              }
              /* 列对齐 */
              .ProseMirror table td[data-align="center"],
              .ProseMirror table th[data-align="center"] {
                text-align: center;
              }
              .ProseMirror table td[data-align="right"],
              .ProseMirror table th[data-align="right"] {
                text-align: right;
              }
              .ProseMirror table td[data-align="left"],
              .ProseMirror table th[data-align="left"] {
                text-align: left;
              }
              /* 空单元格占位，防止塌陷 */
              .ProseMirror table td:has(p:empty)::before,
              .ProseMirror table th:has(p:empty)::before {
                content: " ";
                visibility: hidden;
              }
              /* 列宽调整手柄 */
              .ProseMirror .tableResizeHandle {
                position: absolute;
                right: -4px;
                top: 0;
                bottom: 0;
                width: 8px;
                cursor: col-resize;
                background-color: transparent;
              }
              .ProseMirror .tableResizeHandle:hover {
                background-color: hsl(var(--primary) / 0.5);
              }
              .ProseMirror .tableResizeHandle::before {
                content: '';
                position: absolute;
                left: 50%;
                top: 50%;
                transform: translate(-50%, -50%);
                width: 4px;
                height: 20px;
                background-color: hsl(var(--primary) / 0.3);
                border-radius: 2px;
              }
              /* 暗色模式表格适配 */
              .dark .ProseMirror table tbody tr:nth-child(2n) {
                background-color: hsl(var(--muted) / 0.1);
              }
              .dark .ProseMirror .selectedCell {
                background-color: hsl(var(--primary) / 0.25) !important;
              }
              /* 暗色模式代码块 */
              .dark .ProseMirror pre {
                background-color: hsl(var(--muted) / 0.3);
              }
              .dark .ProseMirror code {
                background-color: hsl(var(--muted) / 0.3);
              }
              /* 图片拖动缩放手柄（对齐 notegen） */
              .ProseMirror [data-resize-container] {
                display: inline-flex !important;
                position: relative;
                max-width: 100%;
                vertical-align: middle;
                line-height: 0;
              }
              .ProseMirror [data-resize-container].ProseMirror-selectednode {
                outline: none;
              }
              .ProseMirror [data-resize-wrapper] {
                position: relative;
                max-width: 100%;
                line-height: 0;
              }
              .ProseMirror [data-resize-wrapper] > img {
                display: block;
                margin: 0;
                max-width: 100%;
                border-radius: 8px;
              }
              /* 选中边框（wrapper::after 实现，跨在图片上） */
              .ProseMirror [data-resize-wrapper]::after {
                content: '';
                position: absolute;
                inset: 0;
                pointer-events: none;
                border: 2px solid hsl(var(--primary) / 0.35);
                border-radius: 8px;
                opacity: 0;
                transition: opacity 0.12s ease;
              }
              .ProseMirror [data-resize-container]:hover [data-resize-wrapper]::after,
              .ProseMirror [data-resize-container].ProseMirror-selectednode [data-resize-wrapper]::after,
              .ProseMirror [data-resize-container][data-resize-state="true"] [data-resize-wrapper]::after {
                opacity: 1;
              }
              /* 手柄默认隐藏 */
              .ProseMirror [data-resize-handle] {
                position: absolute;
                z-index: 2;
                opacity: 0;
                background-color: transparent;
                transition: opacity 0.12s ease;
              }
              .ProseMirror [data-resize-container]:hover [data-resize-handle],
              .ProseMirror [data-resize-container].ProseMirror-selectednode [data-resize-handle],
              .ProseMirror [data-resize-container][data-resize-state="true"] [data-resize-handle] {
                opacity: 1;
              }
              .ProseMirror [data-resize-handle]:hover {
                opacity: 1;
              }
              /* 左右：12px 宽竖条，用 ::after 画 2×28px 圆角竖线 */
              .ProseMirror [data-resize-handle="left"],
              .ProseMirror [data-resize-handle="right"] {
                width: 12px;
                cursor: ew-resize;
              }
              .ProseMirror [data-resize-handle="left"]::after,
              .ProseMirror [data-resize-handle="right"]::after {
                content: '';
                position: absolute;
                width: 2px;
                height: 28px;
                background-color: hsl(var(--primary) / 0.42);
                border-radius: 999px;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
              }
              .ProseMirror [data-resize-handle="left"] {
                transform: translateX(-50%);
              }
              .ProseMirror [data-resize-handle="right"] {
                transform: translateX(50%);
              }
              /* 上下：12px 高横条，用 ::after 画 28×2px 圆角横线 */
              .ProseMirror [data-resize-handle="top"],
              .ProseMirror [data-resize-handle="bottom"] {
                height: 12px;
                cursor: ns-resize;
              }
              .ProseMirror [data-resize-handle="top"]::after,
              .ProseMirror [data-resize-handle="bottom"]::after {
                content: '';
                position: absolute;
                width: 28px;
                height: 2px;
                background-color: hsl(var(--primary) / 0.42);
                border-radius: 999px;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
              }
              .ProseMirror [data-resize-handle="top"] {
                transform: translateY(-50%);
              }
              .ProseMirror [data-resize-handle="bottom"] {
                transform: translateY(50%);
              }
              /* 四角：9×9 圆点，2px primary 半透明边框 + 阴影 */
              .ProseMirror [data-resize-handle="top-left"],
              .ProseMirror [data-resize-handle="top-right"],
              .ProseMirror [data-resize-handle="bottom-left"],
              .ProseMirror [data-resize-handle="bottom-right"] {
                width: 9px;
                height: 9px;
                background-color: hsl(var(--background));
                border: 2px solid hsl(var(--primary) / 0.55);
                border-radius: 999px;
                box-shadow: 0 1px 3px hsl(var(--foreground) / 0.14);
              }
              .ProseMirror [data-resize-handle="top-left"]::after,
              .ProseMirror [data-resize-handle="top-right"]::after,
              .ProseMirror [data-resize-handle="bottom-left"]::after,
              .ProseMirror [data-resize-handle="bottom-right"]::after {
                display: none;
              }
              .ProseMirror [data-resize-handle="top-left"]:hover,
              .ProseMirror [data-resize-handle="top-right"]:hover,
              .ProseMirror [data-resize-handle="bottom-left"]:hover,
              .ProseMirror [data-resize-handle="bottom-right"]:hover {
                background-color: hsl(var(--primary));
                border-color: hsl(var(--primary));
              }
              .ProseMirror [data-resize-handle="top-left"] {
                cursor: nwse-resize;
                transform: translate(-50%, -50%);
              }
              .ProseMirror [data-resize-handle="top-right"] {
                cursor: nesw-resize;
                transform: translate(50%, -50%);
              }
              .ProseMirror [data-resize-handle="bottom-left"] {
                cursor: nesw-resize;
                transform: translate(-50%, 50%);
              }
              .ProseMirror [data-resize-handle="bottom-right"] {
                cursor: nwse-resize;
                transform: translate(50%, 50%);
              }
            `}</style>
            <div
              ref={visualEditorRef}
              className={cn(
                "relative mx-auto flex h-full w-full flex-col px-6 py-5",
                editorClassName,
              )}
            >
              {children}
              <EditorContent
                editor={editor}
                className="mt-4 flex min-h-0 flex-1 flex-col text-[13.5px] leading-6 text-foreground [&_.ProseMirror]:min-h-[380px] [&_.ProseMirror]:flex-1 [&_.ProseMirror]:outline-none [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-border [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:bg-muted/50 [&_.ProseMirror_code]:px-1 [&_.ProseMirror_code]:py-0.5 [&_.ProseMirror_code]:text-[0.9em] [&_.ProseMirror_h1]:mb-2 [&_.ProseMirror_h1]:mt-5 [&_.ProseMirror_h1]:text-[22px] [&_.ProseMirror_h1]:font-bold [&_.ProseMirror_h2]:mb-2 [&_.ProseMirror_h2]:mt-5 [&_.ProseMirror_h2]:text-[18px] [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h3]:mb-2 [&_.ProseMirror_h3]:mt-4 [&_.ProseMirror_h3]:text-[15px] [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_h4]:mb-1.5 [&_.ProseMirror_h4]:mt-3 [&_.ProseMirror_h4]:text-[14px] [&_.ProseMirror_h4]:font-semibold [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:h-auto [&_.ProseMirror_img]:rounded-lg [&_.ProseMirror_img]:my-2 [&_.ProseMirror_li]:my-0.5 [&_.ProseMirror_ol]:ml-5 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_p]:my-1.5 [&_.ProseMirror_pre_code]:bg-transparent [&_.ProseMirror_pre_code]:p-0 [&_.ProseMirror_pre_code]:text-[13px] [&_.ProseMirror_s]:line-through [&_.ProseMirror_s]:text-muted-foreground [&_.ProseMirror_table]:my-2.5 [&_.ProseMirror_table]:border-collapse [&_.ProseMirror_td]:border [&_.ProseMirror_td]:border-border [&_.ProseMirror_td]:px-3 [&_.ProseMirror_td]:py-2 [&_.ProseMirror_th]:border [&_.ProseMirror_th]:border-border [&_.ProseMirror_th]:bg-muted/30 [&_.ProseMirror_th]:px-3 [&_.ProseMirror_th]:py-2 [&_.ProseMirror_ul]:ml-5 [&_.ProseMirror_ul]:list-disc"
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
                          : "text-foreground/85 hover:bg-accent",
                      )}
                    >
                      <span className="truncate">{title}</span>
                    </button>
                  ))}
                </div>
              )}
              {enableSelectionAi && getNoteTitle ? (
                <SelectionAiToolbar
                  editor={editor}
                  getNoteTitle={getNoteTitle}
                  wrapperRef={visualEditorRef}
                />
              ) : null}
              {editor ? <ImageBubbleMenu editor={editor} /> : null}
              {editor ? <TableBubbleMenu editor={editor} wrapperRef={visualEditorRef} /> : null}
            </div>
          </div>
        </EditorContextMenu>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className={cn("mx-auto flex h-full w-full flex-col px-6 py-5", editorClassName)}>
            {children}
            <div className="relative mt-4 flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div
                  ref={lineNumbersRef}
                  aria-hidden="true"
                  className="select-none overflow-hidden whitespace-nowrap px-2 py-2.5 text-right font-mono text-[12.5px] leading-6 text-muted-foreground/50"
                >
                  {lineNumbers.map((n) => (
                    <div key={n}>{n}</div>
                  ))}
                </div>
                <textarea
                  ref={textareaRef}
                  value={content}
                  onChange={(event) => {
                    handleMarkdownChange(event.target.value);
                    const ta = event.target;
                    detectWikiLinkTrigger(ta.value, ta.selectionStart);
                  }}
                  onKeyDown={handleTextareaKeyDown}
                  onScroll={(e) => {
                    if (lineNumbersRef.current) {
                      lineNumbersRef.current.scrollTop = e.currentTarget.scrollTop;
                    }
                  }}
                  onBlur={() => setTimeout(() => setWikiLinkState(null), 200)}
                  className="block h-full w-full flex-1 resize-none border-0 bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-6 text-foreground outline-none scrollbar-thin"
                  spellCheck={false}
                />
              </div>
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
                          : "text-foreground/85 hover:bg-accent",
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
      {mode === "visual" && editor ? <SlashCommandPortal /> : null}
    </section>
  );
}

function EditorContextMenu({ editor, children, onMoveSelectionToNote }: { editor: Editor | null; children: React.ReactNode; onMoveSelectionToNote?: (selectedText: string) => void; }) {
  const [hasSelection, setHasSelection] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [isImageSelected, setIsImageSelected] = useState(false);
  const [imageNodePos, setImageNodePos] = useState<number | null>(null);
  const [imageFileName, setImageFileName] = useState<string | null>(null);
  // 表格状态：光标是否在表格内 / 是否可合并 / 是否可拆分
  const [isInTable, setIsInTable] = useState(false);
  const [canMergeCells, setCanMergeCells] = useState(false);
  const [canSplitCell, setCanSplitCell] = useState(false);
  // 右键打开前保存的选区，用于在表格多选时恢复
  const savedSelectionRef = useRef<{ from: number; to: number } | null>(null);

  useEffect(() => {
    if (!editor) return;
    const editorElement = editor.view.dom;

    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const inTable = target.closest("table") !== null || editor.isActive("table");
      if (!inTable) return;
      const { from, to } = editor.state.selection;
      if (from !== to) {
        savedSelectionRef.current = { from, to };
      }
    };

    editorElement.addEventListener("contextmenu", handleContextMenu);
    return () => editorElement.removeEventListener("contextmenu", handleContextMenu);
  }, [editor]);

  const updateSelection = () => {
    if (!editor) return;
    // 如果右键前保存了表格多选选区，先恢复它
    if (savedSelectionRef.current) {
      editor.chain().focus().setTextSelection(savedSelectionRef.current).run();
      savedSelectionRef.current = null;
    }
    const selection = editor.state.selection;
    const { from, to } = selection;
    const hasSel = from !== to;
    setHasSelection(hasSel);
    if (hasSel) {
      setSelectedText(editor.state.doc.textBetween(from, to, "\n"));
    }
    // 检测是否选中了图片节点
    const isNodeSel = selection instanceof NodeSelection;
    const selNode = isNodeSel ? (selection as NodeSelection).node : null;
    const isImg = !!selNode && selNode.type.name === "image";
    setIsImageSelected(isImg);
    if (isImg && selNode) {
      // 找到图片在文档中的位置
      let pos: number | null = null;
      editor.state.doc.descendants((n, p) => {
        if (pos !== null) return false;
        if (n === selNode) { pos = p; return false; }
        return;
      });
      setImageNodePos(pos);
      // title 存的是 assets/xxx.png
      const title = selNode.attrs.title as string | undefined;
      const alt = selNode.attrs.alt as string | undefined;
      const rawRef = title || alt || "";
      const fileName = rawRef.startsWith("assets/") ? rawRef.slice("assets/".length) : rawRef;
      setImageFileName(fileName || null);
    } else {
      setImageNodePos(null);
      setImageFileName(null);
    }
    // 表格状态检测：光标是否在表格内、是否可合并/拆分单元格
    const inTable = editor.isActive("table");
    setIsInTable(inTable);
    if (inTable) {
      try { setCanMergeCells(editor.can().mergeCells()); } catch { setCanMergeCells(false); }
      try { setCanSplitCell(editor.can().splitCell()); } catch { setCanSplitCell(false); }
    } else {
      setCanMergeCells(false);
      setCanSplitCell(false);
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

  // —— 图片专属操作 ——

  const handleCopyImage = async () => {
    if (!editor || imageNodePos === null) return;
    const node = editor.state.doc.nodeAt(imageNodePos);
    if (!node) return;
    const src = node.attrs.src as string;
    if (!src) return;
    try {
      // 通过 fetch 读取图片字节并写入剪贴板
      const res = await fetch(src);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
    } catch (err) {
      // 降级：复制图片 URL
      try { await navigator.clipboard.writeText(src); } catch {}
    }
  };

  const handleCopyImagePath = async () => {
    if (!editor || imageNodePos === null) return;
    const node = editor.state.doc.nodeAt(imageNodePos);
    if (!node) return;
    // title 存的是 assets/xxx.png（Markdown 源路径）
    const path = (node.attrs.title as string) || (node.attrs.alt as string) || "";
    if (path) {
      try { await navigator.clipboard.writeText(path); } catch {}
    }
  };

  const handleOpenWithDefaultApp = async () => {
    if (!editor || imageNodePos === null || !imageFileName) return;
    try {
      const { getNotesVaultPath, openPathWithSystemApp } = await import("@/lib/tauri");
      const vaultPath = await getNotesVaultPath();
      if (!vaultPath) return;
      const absPath = `${vaultPath}/assets/${imageFileName}`;
      await openPathWithSystemApp(absPath);
    } catch {}
  };

  const handleRevealInExplorer = async () => {
    if (!editor || imageNodePos === null || !imageFileName) return;
    try {
      const { getNotesVaultPath, revealItemInDir } = await import("@/lib/tauri");
      const vaultPath = await getNotesVaultPath();
      if (!vaultPath) return;
      const absPath = `${vaultPath}/assets/${imageFileName}`;
      await revealItemInDir(absPath);
    } catch {}
  };

  const handleDeleteImage = async () => {
    if (!editor || imageNodePos === null) return;
    const pos = imageNodePos;
    // 先从文档删除节点
    editor.chain().focus().deleteRange({ from: pos, to: pos + 1 }).run();
    // 再尝试删除磁盘文件
    if (imageFileName) {
      try {
        const { getNotesVaultPath } = await import("@/lib/tauri");
        const { remove } = await import("@tauri-apps/plugin-fs");
        const vaultPath = await getNotesVaultPath();
        if (vaultPath) {
          await remove(`${vaultPath}/assets/${imageFileName}`);
        }
      } catch {}
    }
  };

  return (
    <ContextMenu onOpenChange={(open) => { if (open) updateSelection(); }}>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {isImageSelected ? (
          <>
            <ContextMenuItem onSelect={handleCopyImage}>
              <ImageIcon className="mr-2 h-3.5 w-3.5" />
              复制图片
            </ContextMenuItem>
            <ContextMenuItem onSelect={handleCopyImagePath}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              复制路径
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={handleOpenWithDefaultApp}>
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              使用默认应用打开
            </ContextMenuItem>
            <ContextMenuItem onSelect={handleRevealInExplorer}>
              <FolderOpen className="mr-2 h-3.5 w-3.5" />
              在资源管理器中显示
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={handleDeleteImage} className="text-destructive focus:text-destructive">
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              删除图片
            </ContextMenuItem>
          </>
        ) : (
          <>
        {hasSelection && !isInTable ? (
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

        {hasSelection && !isInTable ? <ContextMenuSeparator /> : null}
        {/* 段落设置 submenu（表格内不显示） */}
        {!isInTable ? (
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
        ) : null}

        {hasSelection && !isInTable ? (
          /* 文本格式 submenu（表格内不显示） */
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

        {/* 插入 submenu（表格内不显示） */}
        {!isInTable ? (
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
        ) : null}

        {/* 表格操作 submenu：仅在光标位于表格内时显示 */}
        {isInTable ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger className="text-[13px]">
              <Table2 className="mr-2 h-3.5 w-3.5" />
              表格操作
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-44">
              <ContextMenuItem onSelect={() => editor?.chain().focus().addRowBefore().run()}>
                <Rows3 className="mr-2 h-3.5 w-3.5" />
                在上方插入行
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => editor?.chain().focus().addRowAfter().run()}>
                <Rows3 className="mr-2 h-3.5 w-3.5" />
                在下方插入行
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => editor?.chain().focus().addColumnBefore().run()}>
                <Columns3 className="mr-2 h-3.5 w-3.5" />
                在左侧插入列
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => editor?.chain().focus().addColumnAfter().run()}>
                <Columns3 className="mr-2 h-3.5 w-3.5" />
                在右侧插入列
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => editor?.chain().focus().deleteRow().run()}>
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                删除行
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => editor?.chain().focus().deleteColumn().run()}>
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                删除列
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => editor?.chain().focus().mergeCells().run()}
                disabled={!canMergeCells}
              >
                <Combine className="mr-2 h-3.5 w-3.5" />
                合并单元格
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => editor?.chain().focus().splitCell().run()}
                disabled={!canSplitCell}
              >
                <Split className="mr-2 h-3.5 w-3.5" />
                拆分单元格
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => editor?.chain().focus().toggleHeaderRow().run()}>
                <Rows3 className="mr-2 h-3.5 w-3.5" />
                切换表头行
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => editor?.chain().focus().toggleHeaderColumn().run()}>
                <Columns3 className="mr-2 h-3.5 w-3.5" />
                切换表头列
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => editor?.chain().focus().deleteTable().run()}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                删除表格
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}

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
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
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
