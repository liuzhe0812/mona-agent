import { Bot, Copy, FilePlus2, FileText, FolderInput, Plus, Server, Tags, Trash2, Wrench } from "lucide-react";

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

import type { Notebook, NoteSourceKind, OperationNote } from "./notes-data";

interface NoteListProps {
  notes: OperationNote[];
  activeNoteId: string | null;
  totalCount?: number;
  emptyLabel?: string;
  onSelect: (id: string) => void;
  onCopyMarkdown?: (note: OperationNote) => void;
  onDuplicate?: (note: OperationNote) => void;
  onEditTags?: (note: OperationNote) => void;
  onMoveToNotebook?: (note: OperationNote, notebookId: string) => void;
  onDelete?: (note: OperationNote) => void;
  onCreateNote?: (sourceKind: NoteSourceKind) => void;
  notebooks?: Notebook[];
}

const SOURCE_ICON: Record<NoteSourceKind, typeof Bot> = {
  agent: Bot,
  manual: FileText,
  ssh: Server,
  windows: Wrench,
};

export function NoteList({
  notes,
  activeNoteId,
  totalCount = notes.length,
  emptyLabel = "当前笔记本还没有笔记。",
  onSelect,
  onCopyMarkdown,
  onDuplicate,
  onEditTags,
  onMoveToNotebook,
  onDelete,
  onCreateNote,
  notebooks = [],
}: NoteListProps) {
  if (notes.length === 0) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex h-full items-center justify-center px-6 text-center text-[12px] leading-5 text-muted-foreground">
            {emptyLabel}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onSelect={() => onCreateNote?.("manual")}>
            <Plus className="mr-2 h-3.5 w-3.5" />
            新建笔记
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCreateNote?.("ssh")}>
            <Server className="mr-2 h-3.5 w-3.5" />
            新建 SSH 记录
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 scrollbar-thin">
            <div className="space-y-0">
              {notes.map((note) => (
                <NoteRow
                  key={note.id}
                  note={note}
                  active={note.id === activeNoteId}
                  onSelect={() => onSelect(note.id)}
                  onCopyMarkdown={onCopyMarkdown}
                  onDuplicate={onDuplicate}
                  onEditTags={onEditTags}
                  onMoveToNotebook={onMoveToNotebook}
                  onDelete={onDelete}
                  notebooks={notebooks}
                />
              ))}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onSelect={() => onCreateNote?.("manual")}>
            <Plus className="mr-2 h-3.5 w-3.5" />
            新建笔记
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCreateNote?.("ssh")}>
            <Server className="mr-2 h-3.5 w-3.5" />
            新建 SSH 记录
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <div className="shrink-0 border-t border-border/65 px-3 py-2.5 text-[11px] text-muted-foreground">
        共 {totalCount} 条笔记
      </div>
    </div>
  );
}

function NoteRow({
  note,
  active,
  onSelect,
  onCopyMarkdown,
  onDuplicate,
  onEditTags,
  onMoveToNotebook,
  onDelete,
  notebooks,
}: {
  note: OperationNote;
  active: boolean;
  onSelect: () => void;
  onCopyMarkdown?: (note: OperationNote) => void;
  onDuplicate?: (note: OperationNote) => void;
  onEditTags?: (note: OperationNote) => void;
  onMoveToNotebook?: (note: OperationNote, notebookId: string) => void;
  onDelete?: (note: OperationNote) => void;
  notebooks: Notebook[];
}) {
  const SourceIcon = SOURCE_ICON[note.source.kind];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onSelect}
          onContextMenu={(e) => e.stopPropagation()}
          className={cn(
            "group flex min-h-[72px] w-full flex-col border-b border-border/55 px-2.5 py-2 text-left transition-colors first:rounded-t-lg last:rounded-b-lg last:border-b",
            active
              ? "border border-[#6aa7ff]/40 bg-[#6aa7ff]/8"
              : "border-x border-x-transparent hover:border-x-border/70 hover:bg-background",
          )}
        >
          <span className="flex items-center gap-2">
            <SourceIcon
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                active ? "text-[#3d82e7]" : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground/90">
              {note.title}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{note.updatedAt}</span>
          </span>
          <span className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
            {note.preview}
          </span>
          <span className="mt-2 flex min-w-0 items-center gap-1.5">
            {note.tags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-border/65 bg-background/70 px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={() => onCopyMarkdown?.(note)}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          复制 Markdown
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onDuplicate?.(note)}>
          <FilePlus2 className="mr-2 h-3.5 w-3.5" />
          复制笔记
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onEditTags?.(note)}>
          <Tags className="mr-2 h-3.5 w-3.5" />
          编辑标签
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger
            disabled={notebooks.length <= 1}
            className="text-[13px]"
          >
            <FolderInput className="mr-2 h-3.5 w-3.5" />
            移动到笔记本
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            {notebooks
              .filter((notebook) => notebook.id !== note.notebookId)
              .map((notebook) => (
                <ContextMenuItem
                  key={notebook.id}
                  onSelect={() => onMoveToNotebook?.(note, notebook.id)}
                  className="text-[13px]"
                >
                  {notebook.name}
                </ContextMenuItem>
              ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => onDelete?.(note)}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          删除笔记
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
