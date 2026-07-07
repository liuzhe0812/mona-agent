import type { ReactNode } from "react";
import type { JSONContent } from "@tiptap/core";

import { MarkdownEditor, type EditorMode } from "@/components/common/MarkdownEditor";

import type { Notebook, OperationNote } from "./notes-data";

interface NoteEditorProps {
  note: OperationNote;
  notebook?: Notebook | null;
  saveStatus?: "idle" | "saving" | "saved" | "error";
  mode: EditorMode;
  noteTitles?: string[];
  onTitleChange: (title: string) => void;
  onContentChange: (next: {
    contentMarkdown: string;
    contentJson?: JSONContent;
    plainText: string;
  }) => void;
  onMoveSelectionToNote?: (selectedText: string) => void;
  toolbarExtra?: ReactNode;
}

export function NoteEditor({
  note,
  notebook: _notebook,
  saveStatus = "idle",
  mode,
  noteTitles,
  onTitleChange,
  onContentChange,
  onMoveSelectionToNote,
  toolbarExtra,
}: NoteEditorProps) {
  const saveLabel =
    saveStatus === "saving"
      ? "正在保存..."
      : saveStatus === "error"
        ? "保存失败"
        : "已自动保存";

  return (
    <MarkdownEditor
      content={note.contentMarkdown}
      mode={mode}
      noteTitles={noteTitles}
      onContentChange={onContentChange}
      onMoveSelectionToNote={onMoveSelectionToNote}
      toolbarExtra={toolbarExtra}
      statsExtra={
        <span className={saveStatus === "error" ? "text-destructive" : undefined}>
          {saveLabel}
        </span>
      }
    >
      <NoteTitleBlock
        note={note}
        onTitleChange={onTitleChange}
      />
    </MarkdownEditor>
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
    <input
      value={note.title}
      onChange={(event) => onTitleChange(event.target.value)}
      className="w-full bg-transparent text-[22px] font-semibold leading-tight tracking-normal text-foreground outline-none placeholder:text-muted-foreground"
      placeholder="未命名笔记"
    />
  );
}
