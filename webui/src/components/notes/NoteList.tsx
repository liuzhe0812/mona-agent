import { useMemo, useState } from "react";
import {
  ArrowDownUp,
  BookOpen,
  ChevronDown,
  Clipboard,
  Copy,
  FilePlus2,
  FolderInput,
  GitMerge,
  Pencil,
  Plus,
  PlusSquare,
  Server,
  Tags,
  Trash2,
  X,
} from "lucide-react";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { Notebook, NoteContextLevel, NoteSourceKind, OperationNote } from "./notes-data";
import { NOTE_CONTEXT_LEVEL_LABELS, formatRelativeTime } from "./notes-data";

export type SortMode =
  | "title-asc"
  | "title-desc"
  | "updated-desc"
  | "updated-asc"
  | "created-desc"
  | "created-asc";

interface NoteListProps {
  notes: OperationNote[];
  activeNoteId: string | null;
  selectedIds?: Set<string>;
  totalCount?: number;
  emptyLabel?: string;
  knowledgeBaseEnabled?: boolean;
  /** Show the embedded toolbar header (sort + new note). Default true. */
  showHeader?: boolean;
  /** Controlled sort mode. If provided, overrides internal state. */
  sortMode?: SortMode;
  onSortChange?: (mode: SortMode) => void;
  onSelect: (id: string) => void;
  onOpenInNewTab?: (id: string) => void;
  onSelectionChange?: (ids: Set<string>) => void;
  onCopyMarkdown?: (note: OperationNote) => void;
  onCopyPath?: (note: OperationNote) => void;
  onDuplicate?: (note: OperationNote) => void;
  onEditTags?: (note: OperationNote, tags: string[]) => void;
  onRename?: (note: OperationNote) => void;
  onMoveToNotebook?: (note: OperationNote, notebookId: string) => void;
  onMergeNote?: (note: OperationNote, targetNoteId: string) => void;
  onDelete?: (note: OperationNote) => void;
  onDeleteMany?: (notes: OperationNote[]) => void;
  onSetContextLevel?: (note: OperationNote, level: NoteContextLevel) => void;
  onCreateNote?: (sourceKind: NoteSourceKind) => void;
  notebooks?: Notebook[];
  allNotes?: OperationNote[];
}

const CONTEXT_LEVEL_ORDER: NoteContextLevel[] = ["full", "summary", "none"];

const SORT_LABELS: Record<SortMode, string> = {
  "title-asc": "文件名 (A-Z)",
  "title-desc": "文件名 (Z-A)",
  "updated-desc": "编辑时间（从新到旧）",
  "updated-asc": "编辑时间（从旧到新）",
  "created-desc": "创建时间（从新到旧）",
  "created-asc": "创建时间（从旧到新）",
};

export function NoteList({
  notes,
  activeNoteId,
  selectedIds,
  totalCount = notes.length,
  emptyLabel = "当前笔记本还没有笔记。",
  knowledgeBaseEnabled = false,
  showHeader = true,
  sortMode: controlledSortMode,
  onSortChange,
  onSelect,
  onOpenInNewTab,
  onSelectionChange,
  onCopyMarkdown,
  onCopyPath,
  onDuplicate,
  onEditTags,
  onRename,
  onMoveToNotebook,
  onMergeNote,
  onDelete,
  onDeleteMany,
  onSetContextLevel,
  onCreateNote,
  notebooks = [],
  allNotes = [],
}: NoteListProps) {
  const [editingNote, setEditingNote] = useState<OperationNote | null>(null);
  const [internalSortMode, setInternalSortMode] = useState<SortMode>("updated-desc");
  const sortMode = controlledSortMode ?? internalSortMode;
  const handleSortChange = onSortChange ?? setInternalSortMode;
  const selection = selectedIds ?? new Set<string>();

  const sortedNotes = useMemo(() => {
    const list = [...notes];
    if (sortMode === "title-asc") {
      list.sort((a, b) =>
        (a.title || "未命名笔记").localeCompare(b.title || "未命名笔记", "zh-Hans-CN"),
      );
    } else if (sortMode === "title-desc") {
      list.sort((a, b) =>
        (b.title || "未命名笔记").localeCompare(a.title || "未命名笔记", "zh-Hans-CN"),
      );
    } else if (sortMode === "updated-asc") {
      list.sort((a, b) => {
        const ta = new Date(a.updatedAt).getTime() || 0;
        const tb = new Date(b.updatedAt).getTime() || 0;
        return ta - tb;
      });
    } else if (sortMode === "updated-desc") {
      list.sort((a, b) => {
        const ta = new Date(a.updatedAt).getTime() || 0;
        const tb = new Date(b.updatedAt).getTime() || 0;
        return tb - ta;
      });
    } else if (sortMode === "created-asc") {
      list.sort((a, b) => {
        const ta = new Date(a.createdAt).getTime() || 0;
        const tb = new Date(b.createdAt).getTime() || 0;
        return ta - tb;
      });
    } else {
      // created-desc
      list.sort((a, b) => {
        const ta = new Date(a.createdAt).getTime() || 0;
        const tb = new Date(b.createdAt).getTime() || 0;
        return tb - ta;
      });
    }
    return list;
  }, [notes, sortMode]);

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
            <div className="flex h-full flex-col">
              {showHeader ? (
                <ListHeader
                  count={0}
                  sortMode={sortMode}
                  onSortChange={handleSortChange}
                  onCreateNote={onCreateNote}
                />
              ) : null}
              <div className="flex flex-1 items-center justify-center px-6 py-4 text-center text-[12px] leading-5 text-muted-foreground">
                {emptyLabel}
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
      {showHeader ? (
        <ListHeader
          count={totalCount}
          sortMode={sortMode}
          onSortChange={handleSortChange}
          onCreateNote={onCreateNote}
          selectionSize={selection.size}
          onClearSelection={() => onSelectionChange?.(new Set())}
        />
      ) : null}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="min-h-0 flex-1 overflow-y-auto py-1 scrollbar-thin">
            <div className="space-y-px px-1">
              {sortedNotes.map((note) => (
                <NoteRow
                  key={note.id}
                  note={note}
                  active={note.id === activeNoteId}
                  selected={selection.has(note.id)}
                  onSelect={(e) => {
                    if (onSelectionChange && (e.ctrlKey || e.metaKey || e.shiftKey)) {
                      const next = new Set(selection);
                      if (next.has(note.id)) {
                        next.delete(note.id);
                      } else {
                        next.add(note.id);
                      }
                      onSelectionChange(next);
                    } else {
                      if (onSelectionChange && selection.size > 0) {
                        onSelectionChange(new Set());
                      }
                      onSelect(note.id);
                    }
                  }}
                  onCopyMarkdown={onCopyMarkdown}
                  onCopyPath={onCopyPath}
                  onDuplicate={onDuplicate}
                  onEditTags={onEditTags ? () => setEditingNote(note) : undefined}
                  onRename={onRename ? () => onRename(note) : undefined}
                  onOpenInNewTab={onOpenInNewTab ? () => onOpenInNewTab(note.id) : undefined}
                  onMoveToNotebook={onMoveToNotebook}
                  onMergeNote={onMergeNote}
                  onDelete={onDelete}
                  notebooks={notebooks}
                  allNotes={allNotes}
                  knowledgeBaseEnabled={knowledgeBaseEnabled}
                  onSetContextLevel={onSetContextLevel}
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
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={selection.size === 0 || !onDeleteMany}
            onSelect={() => {
              const selectedNotes = notes.filter((n) => selection.has(n.id));
              if (selectedNotes.length > 0 && onDeleteMany) {
                onDeleteMany(selectedNotes);
              }
            }}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            删除选中（{selection.size}）
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <TagEditDialog
        open={editingNote !== null}
        tags={editingNote?.tags ?? []}
        onSave={handleSaveTags}
        onOpenChange={(open) => { if (!open) setEditingNote(null); }}
      />
    </div>
  );
}

function ListHeader({
  count,
  sortMode,
  onSortChange,
  onCreateNote,
  selectionSize = 0,
  onClearSelection,
}: {
  count: number;
  sortMode: SortMode;
  onSortChange: (mode: SortMode) => void;
  onCreateNote?: (sourceKind: NoteSourceKind) => void;
  selectionSize?: number;
  onClearSelection?: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/55 px-2">
      <div className="flex min-w-0 items-center gap-1.5 px-1">
        <span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
          笔记
        </span>
        <span className="rounded-full bg-muted/50 px-1.5 py-px text-[10.5px] text-muted-foreground">
          {count}
        </span>
        {selectionSize > 0 ? (
          <>
            <span className="mx-1 text-muted-foreground/40">·</span>
            <span className="text-[11.5px] text-primary">已选 {selectionSize}</span>
            <button
              type="button"
              onClick={onClearSelection}
              className="grid h-4 w-4 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              title="取消选择"
            >
              <X className="h-3 w-3" />
            </button>
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={`排序：${SORT_LABELS[sortMode]}`}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ArrowDownUp className="h-3 w-3" />
              <span className="hidden sm:inline">{SORT_LABELS[sortMode]}</span>
              <ChevronDown className="h-2.5 w-2.5 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuRadioGroup
              value={sortMode}
              onValueChange={(v) => onSortChange(v as SortMode)}
            >
              <DropdownMenuRadioItem value="title-asc">文件名 (A-Z)</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="title-desc">文件名 (Z-A)</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={sortMode}
              onValueChange={(v) => onSortChange(v as SortMode)}
            >
              <DropdownMenuRadioItem value="updated-desc">编辑时间（从新到旧）</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="updated-asc">编辑时间（从旧到新）</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={sortMode}
              onValueChange={(v) => onSortChange(v as SortMode)}
            >
              <DropdownMenuRadioItem value="created-desc">创建时间（从新到旧）</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="created-asc">创建时间（从旧到新）</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          title="新建笔记"
          onClick={() => onCreateNote?.("manual")}
          className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function NoteRow({
  note,
  active,
  selected,
  onSelect,
  onCopyMarkdown,
  onCopyPath,
  onDuplicate,
  onEditTags,
  onRename,
  onOpenInNewTab,
  onMoveToNotebook,
  onMergeNote,
  onDelete,
  notebooks,
  allNotes = [],
  knowledgeBaseEnabled,
  onSetContextLevel,
}: {
  note: OperationNote;
  active: boolean;
  selected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onCopyMarkdown?: (note: OperationNote) => void;
  onCopyPath?: (note: OperationNote) => void;
  onDuplicate?: (note: OperationNote) => void;
  onEditTags?: () => void;
  onRename?: () => void;
  onOpenInNewTab?: () => void;
  onMoveToNotebook?: (note: OperationNote, notebookId: string) => void;
  onMergeNote?: (note: OperationNote, targetNoteId: string) => void;
  onDelete?: (note: OperationNote) => void;
  notebooks: Notebook[];
  allNotes?: OperationNote[];
  knowledgeBaseEnabled: boolean;
  onSetContextLevel?: (note: OperationNote, level: NoteContextLevel) => void;
}) {
  const currentLevel: NoteContextLevel = note.contextLevel ?? "full";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          data-note-id={note.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", note.id);
            e.dataTransfer.setData("application/x-note-id", note.id);
          }}
          onClick={onSelect}
          onContextMenu={(e) => e.stopPropagation()}
          className={cn(
            "group flex h-[30px] w-full items-center gap-1.5 rounded-md px-2 text-left transition-colors",
            active
              ? "bg-[#6aa7ff]/12 text-foreground"
              : selected
                ? "bg-[#6aa7ff]/6 text-foreground"
                : "text-foreground/85 hover:bg-accent/60",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-[12.5px] leading-none">
            {note.title || "未命名笔记"}
          </span>
          <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/70">
            {formatRelativeTime(note.updatedAt)}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {onOpenInNewTab ? (
          <ContextMenuItem onSelect={() => onOpenInNewTab()}>
            <PlusSquare className="mr-2 h-3.5 w-3.5" />
            在新标签页中打开
          </ContextMenuItem>
        ) : null}
        {onOpenInNewTab ? <ContextMenuSeparator /> : null}
        <ContextMenuItem onSelect={() => onDuplicate?.(note)}>
          <FilePlus2 className="mr-2 h-3.5 w-3.5" />
          创建副本
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger
            disabled={notebooks.length <= 1}
            className="text-[13px]"
          >
            <FolderInput className="mr-2 h-3.5 w-3.5" />
            将文件移动到...
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
        {onMergeNote ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger
              disabled={allNotes.filter((n) => n.id !== note.id).length === 0}
              className="text-[13px]"
            >
              <GitMerge className="mr-2 h-3.5 w-3.5" />
              将该笔记合并到...
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="max-h-[260px] w-52 overflow-y-auto">
              {allNotes
                .filter((n) => n.id !== note.id)
                .map((target) => (
                  <ContextMenuItem
                    key={target.id}
                    onSelect={() => onMergeNote(note, target.id)}
                    className="text-[13px]"
                  >
                    <span className="min-w-0 truncate">{target.title || "未命名笔记"}</span>
                  </ContextMenuItem>
                ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : null}
        <ContextMenuItem onSelect={() => onEditTags?.()}>
          <Tags className="mr-2 h-3.5 w-3.5" />
          编辑标签
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onCopyMarkdown?.(note)}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          复制 Markdown
        </ContextMenuItem>
        {onCopyPath ? (
          <ContextMenuItem onSelect={() => onCopyPath(note)}>
            <Clipboard className="mr-2 h-3.5 w-3.5" />
            复制路径
          </ContextMenuItem>
        ) : null}
        {knowledgeBaseEnabled && onSetContextLevel ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger className="text-[13px]">
                <BookOpen className="mr-2 h-3.5 w-3.5" />
                知识库上下文
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-44">
                {CONTEXT_LEVEL_ORDER.map((level) => (
                  <ContextMenuItem
                    key={level}
                    onSelect={() => onSetContextLevel(note, level)}
                    className="text-[13px]"
                  >
                    <span className="flex items-center gap-2">
                      {currentLevel === level ? (
                        <span className="text-[#3d82e7]">✓</span>
                      ) : (
                        <span className="inline-block w-[14px]" />
                      )}
                      {NOTE_CONTEXT_LEVEL_LABELS[level]}
                    </span>
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onRename?.()}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          重命名
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => onDelete?.(note)}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          删除
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
