import { useEffect, useMemo, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  CheckSquare,
  Code2,
  ClipboardPaste,
  Copy,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  ListChecks,
  ListOrdered,
  Quote,
  Redo2,
  Scissors,
  Strikethrough,
  Table2,
  Type,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
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
  placeholder?: string;
  showToolbar?: boolean;
  showStats?: boolean;
  statsExtra?: React.ReactNode;
  className?: string;
  editorClassName?: string;
  children?: React.ReactNode;
}

export function MarkdownEditor({
  content,
  mode = "visual",
  onModeChange,
  onContentChange,
  placeholder = "记录想法、资料、处理过程或 Agent 输出...",
  showToolbar = true,
  showStats = true,
  statsExtra,
  className,
  editorClassName,
  children,
}: MarkdownEditorProps) {
  const settingContentRef = useRef(false);
  const lastMarkdownRef = useRef(content);
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
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
    },
    onUpdate: ({ editor }) => {
      if (settingContentRef.current) return;
      const contentMarkdown = editor.getMarkdown();
      lastMarkdownRef.current = contentMarkdown;
      onContentChangeRef.current({
        contentMarkdown,
        contentJson: editor.getJSON(),
        plainText: editor.getText(),
      });
    },
  });

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
  }, [editor, content]);

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
    <section className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-background", className)}>
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/65 px-3">
        {showToolbar ? <EditorToolbar editor={editor} /> : <div />}
        <div className="flex items-center gap-0.5 rounded-lg border border-border/70 bg-muted/30 p-0.5">
          <button
            type="button"
            title="可视化编辑"
            aria-label="可视化编辑"
            onClick={() => onModeChange?.("visual")}
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
            onClick={() => onModeChange?.("markdown")}
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
      </div>

      {mode === "visual" ? (
        <EditorContextMenu editor={editor}>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <div className={cn("mx-auto w-full max-w-[700px] px-5 py-5", editorClassName)}>
              {children}
              <EditorContent
                editor={editor}
                className="mt-4 text-[13.5px] leading-6 text-foreground [&_.ProseMirror]:min-h-[380px] [&_.ProseMirror]:outline-none [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-border [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:bg-muted [&_.ProseMirror_code]:px-1 [&_.ProseMirror_h1]:mb-2 [&_.ProseMirror_h1]:mt-5 [&_.ProseMirror_h1]:text-[22px] [&_.ProseMirror_h1]:font-bold [&_.ProseMirror_h2]:mb-2 [&_.ProseMirror_h2]:mt-5 [&_.ProseMirror_h2]:text-[18px] [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h3]:mb-2 [&_.ProseMirror_h3]:mt-4 [&_.ProseMirror_h3]:text-[15px] [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_h4]:mb-1.5 [&_.ProseMirror_h4]:mt-3 [&_.ProseMirror_h4]:text-[14px] [&_.ProseMirror_h4]:font-semibold [&_.ProseMirror_li]:my-0.5 [&_.ProseMirror_ol]:ml-5 [&_.ProseMirror_p]:my-1.5 [&_.ProseMirror_pre]:my-2.5 [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre]:border [&_.ProseMirror_pre]:border-border/70 [&_.ProseMirror_pre]:bg-muted/45 [&_.ProseMirror_pre]:p-2.5 [&_.ProseMirror_s]:line-through [&_.ProseMirror_s]:text-muted-foreground [&_.ProseMirror_table]:my-2.5 [&_.ProseMirror_table]:w-full [&_.ProseMirror_table]:border-collapse [&_.ProseMirror_td]:border [&_.ProseMirror_td]:border-border [&_.ProseMirror_td]:px-2 [&_.ProseMirror_td]:py-1.5 [&_.ProseMirror_th]:border [&_.ProseMirror_th]:border-border [&_.ProseMirror_th]:bg-muted/45 [&_.ProseMirror_th]:px-2 [&_.ProseMirror_th]:py-1.5 [&_.ProseMirror_ul]:ml-5"
              />
            </div>
          </div>
        </EditorContextMenu>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className={cn("mx-auto flex h-full w-full max-w-[700px] flex-col px-5 py-5", editorClassName)}>
            {children}
            <textarea
              value={content}
              onChange={(event) => handleMarkdownChange(event.target.value)}
              className="mt-4 min-h-[380px] flex-1 resize-none rounded-lg border border-border/70 bg-background px-3 py-2.5 font-mono text-[12.5px] leading-6 text-foreground outline-none scrollbar-thin focus:border-[#6aa7ff]/65"
              spellCheck={false}
            />
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

function EditorContextMenu({ editor, children }: { editor: Editor | null; children: React.ReactNode }) {
  const [hasSelection, setHasSelection] = useState(false);

  const updateSelection = () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    setHasSelection(from !== to);
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

  const handleAddLink = () => {
    if (!editor) return;
    const url = window.prompt("输入链接地址");
    if (!url) return;
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const handleRemoveLink = () => {
    editor?.chain().focus().unsetLink().run();
  };

  return (
    <ContextMenu onOpenChange={updateSelection}>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {hasSelection ? (
          <>
            <ContextMenuItem onSelect={handleCopy}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              复制
            </ContextMenuItem>
            <ContextMenuItem onSelect={handleCut}>
              <Scissors className="mr-2 h-3.5 w-3.5" />
              剪切
            </ContextMenuItem>
          </>
        ) : null}
        <ContextMenuItem onSelect={handlePaste}>
          <ClipboardPaste className="mr-2 h-3.5 w-3.5" />
          粘贴
        </ContextMenuItem>

        {hasSelection ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().toggleBold().run()}
            >
              <Bold className="mr-2 h-3.5 w-3.5" />
              加粗
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().toggleItalic().run()}
            >
              <Italic className="mr-2 h-3.5 w-3.5" />
              斜体
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().toggleStrike().run()}
            >
              <Strikethrough className="mr-2 h-3.5 w-3.5" />
              删除线
            </ContextMenuItem>

            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
            >
              <Heading1 className="mr-2 h-3.5 w-3.5" />
              标题 1
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            >
              <Heading2 className="mr-2 h-3.5 w-3.5" />
              标题 2
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
            >
              <Heading3 className="mr-2 h-3.5 w-3.5" />
              标题 3
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().setParagraph().run()}
            >
              <Type className="mr-2 h-3.5 w-3.5" />
              正文
            </ContextMenuItem>

            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().toggleBlockquote().run()}
            >
              <Quote className="mr-2 h-3.5 w-3.5" />
              引用
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().toggleCodeBlock().run()}
            >
              <Code2 className="mr-2 h-3.5 w-3.5" />
              代码块
            </ContextMenuItem>
            {editor?.isActive("link") ? (
              <ContextMenuItem onSelect={handleRemoveLink}>
                <Link2 className="mr-2 h-3.5 w-3.5" />
                移除链接
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onSelect={handleAddLink}>
                <Link2 className="mr-2 h-3.5 w-3.5" />
                添加链接
              </ContextMenuItem>
            )}
          </>
        ) : (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
            >
              <Heading1 className="mr-2 h-3.5 w-3.5" />
              标题 1
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            >
              <Heading2 className="mr-2 h-3.5 w-3.5" />
              标题 2
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
            >
              <Heading3 className="mr-2 h-3.5 w-3.5" />
              标题 3
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => editor?.chain().focus().setParagraph().run()}
            >
              <Type className="mr-2 h-3.5 w-3.5" />
              正文
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function EditorToolbar({ editor }: { editor: Editor | null }) {
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-thin">
      <ToolbarButton
        label="正文"
        active={editor?.isActive("paragraph") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().setParagraph().run()}
      >
        <Type className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="标题1"
        active={editor?.isActive("heading", { level: 1 }) ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="标题2"
        active={editor?.isActive("heading", { level: 2 }) ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="标题3"
        active={editor?.isActive("heading", { level: 3 }) ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 className="h-3.5 w-3.5" />
      </ToolbarButton>
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
