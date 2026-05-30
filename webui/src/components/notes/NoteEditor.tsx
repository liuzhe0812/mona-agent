import { useState } from "react";
import type { JSONContent } from "@tiptap/core";
import { ArrowLeft } from "lucide-react";

import { MarkdownEditor, type EditorMode } from "@/components/common/MarkdownEditor";

import type { OperationNote } from "./notes-data";

interface NoteEditorProps {
  note: OperationNote;
  saveStatus?: "idle" | "saving" | "saved" | "error";
  knowledgeReturnTitle?: string;
  onReturnToKnowledge?: () => void;
  onTitleChange: (title: string) => void;
  onContentChange: (next: {
    contentMarkdown: string;
    contentJson?: JSONContent;
    plainText: string;
  }) => void;
}

export function NoteEditor({
  note,
  saveStatus = "idle",
  knowledgeReturnTitle,
  onReturnToKnowledge,
  onTitleChange,
  onContentChange,
}: NoteEditorProps) {
  const [mode, setMode] = useState<EditorMode>("visual");

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
      onModeChange={setMode}
      onContentChange={onContentChange}
      statsExtra={
        <span className={saveStatus === "error" ? "text-destructive" : undefined}>
          {saveLabel}
        </span>
      }
    >
      {knowledgeReturnTitle && onReturnToKnowledge ? (
        <KnowledgeReturnBanner
          title={knowledgeReturnTitle}
          onReturn={onReturnToKnowledge}
        />
      ) : null}
      <NoteTitleBlock
        note={note}
        onTitleChange={onTitleChange}
      />
    </MarkdownEditor>
  );
}

function KnowledgeReturnBanner({
  title,
  onReturn,
}: {
  title: string;
  onReturn: () => void;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/25 px-3 py-2 text-[12px] text-muted-foreground">
      <span className="min-w-0 truncate">正在查看关联笔记：{title}</span>
      <button
        type="button"
        onClick={onReturn}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 font-medium hover:bg-accent hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回知识点
      </button>
    </div>
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
