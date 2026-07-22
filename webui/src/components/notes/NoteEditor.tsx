import { useRef, type ReactNode } from "react";
import type { JSONContent } from "@tiptap/core";

import { MarkdownEditor, type EditorMode } from "@/components/common/MarkdownEditor";

import type { Notebook, OperationNote } from "./notes-data";

const DEFAULT_TITLE = "未命名笔记";
const AUTO_TITLE_MAX_LEN = 40;

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
  onOpenNoteByTitle?: (title: string) => void;
  toolbarExtra?: ReactNode;
  toolbarLeadingExtra?: ReactNode;
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
  onOpenNoteByTitle,
  toolbarExtra,
  toolbarLeadingExtra,
}: NoteEditorProps) {
  const saveLabel =
    saveStatus === "saving"
      ? "正在保存..."
      : saveStatus === "error"
        ? "保存失败"
        : "已自动保存";

  // 跟踪上次内容是否包含换行，用于检测"首次产生第二行"（回车或粘贴多行）。
  // NoteEditor 通过 key={note.id} 重新挂载，切换笔记时 ref 会自动重置。
  const hadNewlineRef = useRef(note.contentMarkdown.includes("\n"));

  const handleContentChange = (next: {
    contentMarkdown: string;
    contentJson?: JSONContent;
    plainText: string;
  }) => {
    const plainText = next.plainText || "";
    const hasNewlineNow = plainText.includes("\n");

    // 从"无换行"转变为"有换行"时，若标题仍是默认占位（用户未手动改过），
    // 自动取第一行作为标题。正文保留不变（用户已确认保留）。
    if (!hadNewlineRef.current && hasNewlineNow && note.title === DEFAULT_TITLE) {
      const firstLine = plainText.split("\n")[0].trim();
      if (firstLine) {
        onTitleChange(firstLine.slice(0, AUTO_TITLE_MAX_LEN));
      }
    }
    hadNewlineRef.current = hasNewlineNow;

    onContentChange(next);
  };

  return (
    <MarkdownEditor
      content={note.contentMarkdown}
      mode={mode}
      noteTitles={noteTitles}
      onContentChange={handleContentChange}
      onMoveSelectionToNote={onMoveSelectionToNote}
      onOpenNoteByTitle={onOpenNoteByTitle}
      toolbarExtra={toolbarExtra}
      toolbarLeadingExtra={toolbarLeadingExtra}
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
