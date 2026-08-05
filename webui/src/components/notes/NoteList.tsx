import { useMemo, useState } from "react";
import {
  ArrowDownUp,
  BookOpen,
  ChevronDown,
  Clipboard,
  Copy,
  FilePlus2,
  FileText,
  FileType,
  FolderInput,
  FolderOpen,
  GitMerge,
  Network,
  Pencil,
  Plus,
  PlusSquare,
  Server,
  Star,
  Trash2,
  Workflow,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  onRevealInExplorer?: (note: OperationNote) => void;
  onDuplicate?: (note: OperationNote) => void;
  onRename?: (note: OperationNote) => void;
  onMoveToNotebook?: (note: OperationNote, notebookId: string) => void;
  onMergeNote?: (note: OperationNote, targetNoteId: string) => void;
  onDelete?: (note: OperationNote) => void;
  onDeleteMany?: (notes: OperationNote[]) => void;
  onSetContextLevel?: (note: OperationNote, level: NoteContextLevel) => void;
  onToggleFavorite?: (note: OperationNote) => void;
  onCreateNote?: (sourceKind: NoteSourceKind) => void;
  onExportDocx?: (note: OperationNote) => void;
  notebooks?: Notebook[];
  allNotes?: OperationNote[];
  /** 正在录音转写的笔记 id */
  recordingNoteId?: string | null;
  /** 正在被 AI 处理的笔记 id */
  aiProcessingNoteId?: string | null;
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

export function sortNotesByMode(notes: OperationNote[], sortMode: SortMode): OperationNote[] {
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
}

export function NoteList({
  notes,
  activeNoteId,
  selectedIds,
  totalCount = notes.length,
  emptyLabel = "当前笔记本还没有笔记。",
  showHeader = true,
  sortMode: controlledSortMode,
  onSortChange,
  onSelect,
  onOpenInNewTab,
  onSelectionChange,
  onCopyMarkdown,
  onCopyPath,
  onRevealInExplorer,
  onDuplicate,
  onRename,
  onMoveToNotebook,
  onMergeNote,
  onDelete,
  onDeleteMany,
  onSetContextLevel,
  onToggleFavorite,
  onCreateNote,
  onExportDocx,
  notebooks = [],
  allNotes = [],
  recordingNoteId,
  aiProcessingNoteId,
}: NoteListProps) {
  const [internalSortMode, setInternalSortMode] = useState<SortMode>("updated-desc");
  const sortMode = controlledSortMode ?? internalSortMode;
  const handleSortChange = onSortChange ?? setInternalSortMode;
  const selection = selectedIds ?? new Set<string>();

  const sortedNotes = useMemo(() => sortNotesByMode(notes, sortMode), [notes, sortMode]);

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
                  onRevealInExplorer={onRevealInExplorer}
                  onDuplicate={onDuplicate}
                  onRename={onRename ? () => onRename(note) : undefined}
                  onOpenInNewTab={onOpenInNewTab ? () => onOpenInNewTab(note.id) : undefined}
                  onMoveToNotebook={onMoveToNotebook}
                  onMergeNote={onMergeNote}
                  onDelete={onDelete}
                  notebooks={notebooks}
                  allNotes={allNotes}
                  onSetContextLevel={onSetContextLevel}
                  onToggleFavorite={onToggleFavorite}
                  onExportDocx={onExportDocx}
                  isRecording={recordingNoteId === note.id}
                  isAiProcessing={aiProcessingNoteId === note.id}
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

export function NoteRow({
  note,
  active,
  selected,
  onSelect,
  onCopyMarkdown,
  onCopyPath,
  onRevealInExplorer,
  onDuplicate,
  onRename,
  onOpenInNewTab,
  onMoveToNotebook,
  onMergeNote,
  onDelete,
  notebooks,
  allNotes = [],
  onSetContextLevel,
  onToggleFavorite,
  onExportDocx,
  isRecording = false,
  isAiProcessing = false,
}: {
  note: OperationNote;
  active: boolean;
  selected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onCopyMarkdown?: (note: OperationNote) => void;
  onCopyPath?: (note: OperationNote) => void;
  onRevealInExplorer?: (note: OperationNote) => void;
  onDuplicate?: (note: OperationNote) => void;
  onRename?: () => void;
  onOpenInNewTab?: () => void;
  onMoveToNotebook?: (note: OperationNote, notebookId: string) => void;
  onMergeNote?: (note: OperationNote, targetNoteId: string) => void;
  onDelete?: (note: OperationNote) => void;
  notebooks: Notebook[];
  allNotes?: OperationNote[];
  onSetContextLevel?: (note: OperationNote, level: NoteContextLevel) => void;
  onToggleFavorite?: (note: OperationNote) => void;
  onExportDocx?: (note: OperationNote) => void;
  /** 该笔记正在录音转写 */
  isRecording?: boolean;
  /** 该笔记正在被 AI 处理 */
  isAiProcessing?: boolean;
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
              ? "bg-primary/15 text-foreground"
              : selected
                ? "bg-primary/8 text-foreground"
                : "text-foreground/85 hover:bg-accent",
          )}
        >
          {note.type === "mindmap" ? (
            <Network className="shrink-0 h-3 w-3 text-muted-foreground" />
          ) : note.type === "flowchart" ? (
            <Workflow className="shrink-0 h-3 w-3 text-muted-foreground" />
          ) : (
            <FileText className="shrink-0 h-3 w-3 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-[12.5px] leading-none">
            {note.title || "未命名笔记"}
          </span>
          {note.favorite ? (
            <Star className="shrink-0 h-3 w-3 fill-current text-amber-500" />
          ) : null}
          {isRecording ? (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-rose-500/12 px-1.5 py-px text-[10px] tabular-nums leading-none text-rose-600 dark:text-rose-400">
              <span className="note-processing-dot inline-block h-1.5 w-1.5 rounded-full bg-rose-500" />
              录音中
            </span>
          ) : null}
          {isAiProcessing ? (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/12 px-1.5 py-px text-[10px] tabular-nums leading-none text-emerald-600 dark:text-emerald-400">
              <span className="note-processing-dot inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              AI 处理中
            </span>
          ) : null}
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
            {note.notebookId !== "" ? (
              <ContextMenuItem
                onSelect={() => onMoveToNotebook?.(note, "")}
                className="text-[13px]"
              >
                <FolderOpen className="mr-2 h-3.5 w-3.5" />
                根目录
              </ContextMenuItem>
            ) : null}
            {note.notebookId !== "" && notebooks.length > 0 ? (
              <ContextMenuSeparator />
            ) : null}
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
        {onMergeNote && note.type !== "mindmap" && note.type !== "flowchart" ? (
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
        {onToggleFavorite ? (
          <ContextMenuItem onSelect={() => onToggleFavorite(note)}>
            <Star className={cn("mr-2 h-3.5 w-3.5", note.favorite && "fill-current text-amber-500")} />
            {note.favorite ? "取消收藏" : "收藏"}
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onCopyMarkdown?.(note)}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          {note.type === "mindmap" || note.type === "flowchart" ? "复制大纲" : "复制 Markdown"}
        </ContextMenuItem>
        {onExportDocx && note.type !== "mindmap" && note.type !== "flowchart" ? (
          <ContextMenuItem onSelect={() => onExportDocx(note)}>
            <FileType className="mr-2 h-3.5 w-3.5" />
            导出为 Word
          </ContextMenuItem>
        ) : null}
        {onCopyPath ? (
          <ContextMenuItem onSelect={() => onCopyPath(note)}>
            <Clipboard className="mr-2 h-3.5 w-3.5" />
            复制路径
          </ContextMenuItem>
        ) : null}
        {onRevealInExplorer ? (
          <ContextMenuItem onSelect={() => onRevealInExplorer(note)}>
            <FolderOpen className="mr-2 h-3.5 w-3.5" />
            打开文件路径
          </ContextMenuItem>
        ) : null}
        {onSetContextLevel ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger className="text-[13px]">
                <BookOpen className="mr-2 h-3.5 w-3.5" />
                AI 上下文级别
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
