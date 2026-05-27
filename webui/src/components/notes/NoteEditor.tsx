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
  FileCode2,
  Heading2,
  Italic,
  Link2,
  ListChecks,
  ListOrdered,
  Quote,
  Redo2,
  Table2,
  Type,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { OperationNote } from "./notes-data";

interface NoteEditorProps {
  note: OperationNote;
  saveStatus?: "idle" | "saving" | "saved" | "error";
  onTitleChange: (title: string) => void;
  onContentChange: (next: {
    contentMarkdown: string;
    contentJson?: JSONContent;
    plainText: string;
  }) => void;
}

type EditorMode = "visual" | "markdown";

export function NoteEditor({
  note,
  saveStatus = "idle",
  onTitleChange,
  onContentChange,
}: NoteEditorProps) {
  const [mode, setMode] = useState<EditorMode>("visual");
  const settingContentRef = useRef(false);
  const currentNoteIdRef = useRef(note.id);
  const lastEditorMarkdownRef = useRef(note.contentMarkdown);
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [2, 3] },
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
      Placeholder.configure({
        placeholder: "记录想法、资料、处理过程或 Agent 输出...",
      }),
      Markdown.configure({
        indentation: { style: "space", size: 2 },
      }),
    ],
    [],
  );

  const editor = useEditor({
    extensions,
    content: note.contentMarkdown,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "notes-prosemirror",
      },
    },
    onUpdate: ({ editor }) => {
      if (settingContentRef.current) return;
      const contentMarkdown = editor.getMarkdown();
      lastEditorMarkdownRef.current = contentMarkdown;
      onContentChangeRef.current({
        contentMarkdown,
        contentJson: editor.getJSON(),
        plainText: editor.getText(),
      });
    },
  });

  const stats = useMemo(() => {
    const plainText = (note.plainText ?? "").trim();
    const markdownText = note.contentMarkdown
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[#>*_`|[\]-]/g, " ")
      .trim();
    const readableText = plainText || markdownText;
    const charCount = readableText.replace(/\s/g, "").length;
    const lineCount = note.contentMarkdown.split(/\r?\n/).length;

    return {
      charCount,
      lineCount,
    };
  }, [note.contentMarkdown, note.plainText]);

  useEffect(() => {
    if (!editor) return;
    const noteChanged = currentNoteIdRef.current !== note.id;
    const editorMarkdown = editor.getMarkdown();
    const externalChange =
      note.contentMarkdown !== lastEditorMarkdownRef.current &&
      note.contentMarkdown !== editorMarkdown;

    if (!noteChanged && !externalChange) return;

    settingContentRef.current = true;
    editor.commands.setContent(note.contentMarkdown, { contentType: "markdown" });
    settingContentRef.current = false;
    currentNoteIdRef.current = note.id;
    lastEditorMarkdownRef.current = note.contentMarkdown;
  }, [editor, note.id, note.contentMarkdown]);

  const handleMarkdownChange = (value: string) => {
    if (!editor) return;
    settingContentRef.current = true;
    editor.commands.setContent(value, { contentType: "markdown" });
    settingContentRef.current = false;
    lastEditorMarkdownRef.current = value;
    onContentChange({
      contentMarkdown: value,
      contentJson: editor.getJSON(),
      plainText: editor.getText(),
    });
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/65 px-3">
        <EditorToolbar editor={editor} />
        <div className="flex items-center rounded-lg border border-border/70 bg-muted/30 p-0.5">
          <button
            type="button"
            onClick={() => setMode("visual")}
            className={cn(
              "h-6 rounded-md px-2 text-[11px] font-medium transition-colors",
              mode === "visual"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            可视化
          </button>
          <button
            type="button"
            onClick={() => setMode("markdown")}
            className={cn(
              "h-6 rounded-md px-2 text-[11px] font-medium transition-colors",
              mode === "markdown"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            MD 源码
          </button>
        </div>
      </div>

      {mode === "visual" ? (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto w-full max-w-[700px] px-5 py-5">
            <NoteTitleBlock
              note={note}
              onTitleChange={onTitleChange}
            />
            <EditorContent
              editor={editor}
              className="mt-4 text-[13.5px] leading-6 text-foreground [&_.ProseMirror]:min-h-[380px] [&_.ProseMirror]:outline-none [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-border [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:bg-muted [&_.ProseMirror_code]:px-1 [&_.ProseMirror_h2]:mb-2 [&_.ProseMirror_h2]:mt-5 [&_.ProseMirror_h2]:text-[18px] [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h3]:mb-2 [&_.ProseMirror_h3]:mt-4 [&_.ProseMirror_h3]:text-[15px] [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_li]:my-0.5 [&_.ProseMirror_ol]:ml-5 [&_.ProseMirror_p]:my-1.5 [&_.ProseMirror_pre]:my-2.5 [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre]:border [&_.ProseMirror_pre]:border-border/70 [&_.ProseMirror_pre]:bg-muted/45 [&_.ProseMirror_pre]:p-2.5 [&_.ProseMirror_table]:my-2.5 [&_.ProseMirror_table]:w-full [&_.ProseMirror_table]:border-collapse [&_.ProseMirror_td]:border [&_.ProseMirror_td]:border-border [&_.ProseMirror_td]:px-2 [&_.ProseMirror_td]:py-1.5 [&_.ProseMirror_th]:border [&_.ProseMirror_th]:border-border [&_.ProseMirror_th]:bg-muted/45 [&_.ProseMirror_th]:px-2 [&_.ProseMirror_th]:py-1.5 [&_.ProseMirror_ul]:ml-5"
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto flex h-full w-full max-w-[700px] flex-col px-5 py-5">
            <NoteTitleBlock
              note={note}
              onTitleChange={onTitleChange}
            />
            <textarea
              value={note.contentMarkdown}
              onChange={(event) => handleMarkdownChange(event.target.value)}
              className="mt-4 min-h-[380px] flex-1 resize-none rounded-lg border border-border/70 bg-background px-3 py-2.5 font-mono text-[12.5px] leading-6 text-foreground outline-none scrollbar-thin focus:border-[#6aa7ff]/65"
              spellCheck={false}
            />
          </div>
        </div>
      )}

      <div className="flex h-7 shrink-0 items-center justify-between border-t border-border/65 px-3 text-[11px] text-muted-foreground">
        <span className={saveStatus === "error" ? "text-destructive" : undefined}>
          {saveStatus === "saving"
            ? "正在保存..."
            : saveStatus === "error"
              ? "保存失败"
              : "已自动保存"}
        </span>
        <span>
          {stats.charCount} 字 · {stats.lineCount} 行
        </span>
      </div>
    </section>
  );
}

function NoteTitleBlock({
  note,
  onTitleChange,
}: {
  note: OperationNote;
  onTitleChange: (title: string) => void;
}) {
  return (
    <div>
      <input
        value={note.title}
        onChange={(event) => onTitleChange(event.target.value)}
        className="w-full bg-transparent text-[22px] font-semibold leading-tight tracking-normal text-foreground outline-none placeholder:text-muted-foreground"
        placeholder="未命名笔记"
      />
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-md border border-border/70 bg-muted/35 px-2 py-1">
          {note.source.label}
        </span>
        <span className="rounded-md border border-border/70 bg-muted/35 px-2 py-1">
          Agent 可写入
        </span>
        <span className="rounded-md border border-border/70 bg-muted/35 px-2 py-1">
          Markdown
        </span>
      </div>
    </div>
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
        label="标题"
        active={editor?.isActive("heading", { level: 2 }) ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 className="h-3.5 w-3.5" />
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
      <ToolbarButton label="源码由 MD 保存" disabled>
        <FileCode2 className="h-3.5 w-3.5" />
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
