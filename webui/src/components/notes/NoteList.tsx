import { useState } from "react";
import { Bot, Copy, FilePlus2, FileText, FolderInput, Plus, Server, Tags, Trash2, Wrench, X } from "lucide-react";

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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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
  onEditTags?: (note: OperationNote, tags: string[]) => void;
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
  const [editingNote, setEditingNote] = useState<OperationNote | null>(null);

  const handleSaveTags = (tags: string[]) => {
    if (!editingNote || !onEditTags) return;
    onEditTags(editingNote, tags);
    setEditingNote(null);
  };

  if (notes.length === 0) {
    return (
      <>
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
        <TagEditDialog
          open={editingNote !== null}
          tags={editingNote?.tags ?? []}
          onSave={handleSaveTags}
          onOpenChange={(open) => { if (!open) setEditingNote(null); }}
        />
      </>
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
                  onEditTags={onEditTags ? () => setEditingNote(note) : undefined}
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
      <TagEditDialog
        open={editingNote !== null}
        tags={editingNote?.tags ?? []}
        onSave={handleSaveTags}
        onOpenChange={(open) => { if (!open) setEditingNote(null); }}
      />
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
  onEditTags?: () => void;
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
        <ContextMenuItem onSelect={() => onEditTags?.()}>
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

function TagEditDialog({
  open,
  tags: initialTags,
  onSave,
  onOpenChange,
}: {
  open: boolean;
  tags: string[];
  onSave: (tags: string[]) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [input, setInput] = useState("");

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setTags(initialTags);
      setInput("");
    }
    onOpenChange(nextOpen);
  };

  const addTag = () => {
    const newTags = input
      .split(/[\s,，、]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (newTags.length === 0) return;
    setTags((prev) => {
      const merged = Array.from(new Set([...prev, ...newTags]));
      return merged;
    });
    setInput("");
  };

  const removeTag = (tag: string) => {
    setTags((prev) => prev.filter((t) => t !== tag));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[360px] gap-0 rounded-xl border-border/70 p-0">
        <DialogHeader className="border-b border-border/65 px-4 py-3 text-left">
          <DialogTitle className="text-[14px]">编辑标签</DialogTitle>
        </DialogHeader>

        <div className="px-4 py-3">
          {tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full border border-border/65 bg-muted/25 px-2 py-0.5 text-[11.5px] text-muted-foreground"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="grid h-3.5 w-3.5 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground">暂无标签</p>
          )}

          <div className="mt-3 flex items-center gap-1.5">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入标签，回车添加"
              className="h-8 flex-1 rounded-lg border border-border/70 bg-background px-2.5 text-[12px] outline-none placeholder:text-muted-foreground focus:border-border"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2.5 text-[12px]"
              disabled={!input.trim()}
              onClick={addTag}
            >
              添加
            </Button>
          </div>
        </div>

        <DialogFooter className="border-t border-border/65 px-4 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-[12px]"
            onClick={() => onSave(tags)}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
