import { useCallback, useRef, forwardRef, useImperativeHandle, type ReactNode } from "react";
import type { JSONContent } from "@tiptap/core";

import { MarkdownEditor, type EditorMode } from "@/components/common/MarkdownEditor";
import { MindMapDocumentEditor, type MindMapDocumentEditorHandle } from "./mindmap/MindMapDocumentEditor";
import { FlowchartDocumentEditor } from "./flowchart/FlowchartDocumentEditor";
import { DiagramDocumentEditor } from "./diagram/DiagramDocumentEditor";

import type { OperationNote } from "./notes-data";

const DEFAULT_TITLE = "未命名笔记";
const AUTO_TITLE_MAX_LEN = 40;

// 剥离常见 Markdown 语法，用于从第一行生成干净的标题。
function stripMarkdownForTitle(text: string): string {
  let s = text.trim();
  s = s.replace(/^#{1,6}\s+/, ""); // heading
  s = s.replace(/^([-*+]|\d+\.)\s+/, ""); // list
  s = s.replace(/^>\s*/, ""); // blockquote
  s = s.replace(/^!\[([^\]]*)\]\([^)]*\).*/, "$1"); // leading image → alt
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // link → text
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1"); // bold
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1"); // italic
  s = s.replace(/_([^_]+)_/g, "$1");
  s = s.replace(/~~([^~]+)~~/g, "$1"); // strikethrough
  s = s.replace(/`([^`]+)`/g, "$1"); // inline code
  return s.trim();
}

interface NoteEditorProps {
  note: OperationNote;
  saveStatus?: "idle" | "saving" | "saved" | "error";
  mode: EditorMode;
  noteTitles?: string[];
  onTitleChange: (title: string) => void;
  onContentChange: (next: {
    contentMarkdown: string;
    contentJson?: JSONContent;
    plainText: string;
    /** 流程图专用：提交时的 baseRevision */
    baseRevision?: number;
  }) => void;
  onMoveSelectionToNote?: (selectedText: string) => void;
  onOpenNoteByTitle?: (title: string) => void;
  toolbarExtra?: ReactNode;
  toolbarLeadingExtra?: ReactNode;
  /** 流程图多标签页写者租约：当前 note 的 writerInstanceId */
  flowchartWriterId?: string;
  /** 申请成为写者（用户点击"在此编辑"） */
  onFlowchartRequestLease?: (editorInstanceId: string) => void;
  /** 流程图当前 revision（来自 NotesView） */
  flowchartRevision?: number;
  /** NotesView 拒绝提交时的强制同步计数器 */
  flowchartForceSync?: number;
  /** Resolve embed target content by title (`![[...]]`). Returns null if not found. */
  resolveEmbedContent?: (title: string) => string | null;
  /** Whether the embed target is a flowchart note. */
  isEmbedFlowchart?: (title: string) => boolean;
}

export interface NoteEditorHandle {
  /** 选中并居中到思维导图节点（仅 mindmap 类型有效） */
  selectMindMapNode?: (nodeId: string) => void;
}

export const NoteEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(function NoteEditor({
  note,
  saveStatus = "idle",
  mode,
  noteTitles,
  onTitleChange,
  onContentChange,
  onMoveSelectionToNote,
  onOpenNoteByTitle,
  toolbarExtra,
  toolbarLeadingExtra,
  flowchartWriterId,
  onFlowchartRequestLease,
  flowchartRevision,
  flowchartForceSync,
  resolveEmbedContent,
  isEmbedFlowchart,
}, ref) {
  const saveLabel =
    saveStatus === "saving"
      ? "正在保存..."
      : saveStatus === "error"
        ? "保存失败"
        : "已自动保存";

  // 跟踪上次内容是否包含换行，用于检测"首次产生第二行"（回车或粘贴多行）。
  // NoteEditor 通过 key={note.id} 重新挂载，切换笔记时 ref 会自动重置。
  const hadNewlineRef = useRef(note.contentMarkdown.includes("\n"));
  const noteTitleRef = useRef(note.title);
  noteTitleRef.current = note.title;
  const getNoteTitle = useCallback(() => noteTitleRef.current, []);

  // 思维导图实例 ref，透传给父组件用于右侧大纲面板定位节点
  const mindMapRef = useRef<MindMapDocumentEditorHandle>(null);
  useImperativeHandle(ref, () => ({
    selectMindMapNode: (nodeId: string) => mindMapRef.current?.selectNode(nodeId),
  }), []);

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
      const firstLine = stripMarkdownForTitle(plainText.split("\n")[0]);
      if (firstLine) {
        onTitleChange(firstLine.slice(0, AUTO_TITLE_MAX_LEN));
      }
    }
    hadNewlineRef.current = hasNewlineNow;

    onContentChange(next);
  };

  if (note.type === "mindmap") {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <MindMapDocumentEditor
          ref={mindMapRef}
          note={note}
          onContentChange={handleContentChange}
          toolbarExtra={toolbarExtra}
        />
      </div>
    );
  }

  if (note.type === "flowchart") {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <FlowchartDocumentEditor
          note={note}
          onContentChange={handleContentChange}
          toolbarExtra={toolbarExtra}
          writerInstanceId={flowchartWriterId}
          onRequestWriteLease={onFlowchartRequestLease}
          revision={flowchartRevision}
          forceSync={flowchartForceSync}
        />
      </div>
    );
  }

  if (note.type === "diagram") {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <DiagramDocumentEditor
          note={note}
          onContentChange={handleContentChange}
          toolbarExtra={toolbarExtra}
        />
      </div>
    );
  }

  return (
    <MarkdownEditor
      content={note.contentMarkdown}
      mode={mode}
      editorClassName="note-editor-cursor"
      noteTitles={noteTitles}
      onContentChange={handleContentChange}
      onMoveSelectionToNote={onMoveSelectionToNote}
      onOpenNoteByTitle={onOpenNoteByTitle}
      toolbarExtra={toolbarExtra}
      toolbarLeadingExtra={toolbarLeadingExtra}
      enableSelectionAi
      getNoteTitle={getNoteTitle}
      resolveEmbedContent={resolveEmbedContent}
      isEmbedFlowchart={isEmbedFlowchart}
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
});

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
