import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { JSONContent } from "@tiptap/core";
import { X, GitFork } from "lucide-react";

import { cn } from "@/lib/utils";
import { NoteTabBar } from "./NoteTabBar";
import { NoteEditor } from "./NoteEditor";
import { GraphViewDialog } from "./GraphViewDialog";
import type { OperationNote, Notebook } from "./notes-data";
import type { EditorMode } from "@/components/common/MarkdownEditor";

export type SplitDirection = "horizontal" | "vertical";

export interface LeafPane {
  id: string;
  type: "leaf";
  tabIds: string[];
  activeTabId: string | null;
  // Special graph tab is represented as a virtual tab id prefixed with "__graph__".
  graphOpen: boolean;
}

export interface SplitPane {
  id: string;
  type: "split";
  direction: SplitDirection;
  sizes: number[];
  children: PaneNode[];
}

export type PaneNode = LeafPane | SplitPane;

export interface WorkspaceState {
  root: PaneNode;
  activeLeafId: string;
}

export function createInitialWorkspace(activeNoteId?: string | null): WorkspaceState {
  const leafId = crypto.randomUUID();
  return {
    root: {
      id: leafId,
      type: "leaf",
      tabIds: activeNoteId ? [activeNoteId] : [],
      activeTabId: activeNoteId ?? null,
      graphOpen: false,
    },
    activeLeafId: leafId,
  };
}

function generateId(): string {
  return crypto.randomUUID();
}

export function findLeafById(node: PaneNode, id: string): LeafPane | null {
  if (node.type === "leaf") return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findLeafById(child, id);
    if (found) return found;
  }
  return null;
}

export function mapNode(node: PaneNode, mapper: (n: PaneNode) => PaneNode): PaneNode {
  const mapped = mapper(node);
  if (mapped.type === "split") {
    return {
      ...mapped,
      children: mapped.children.map((c) => mapNode(c, mapper)),
    };
  }
  return mapped;
}

export function removeLeaf(root: PaneNode, leafId: string): PaneNode | null {
  if (root.type === "leaf") {
    return root.id === leafId ? null : root;
  }
  const newChildren = root.children
    .map((c) => removeLeaf(c, leafId))
    .filter((c): c is PaneNode => c !== null);
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) {
    return newChildren[0];
  }
  return { ...root, children: newChildren, sizes: normalizeSizes(root.sizes, newChildren.length) };
}

function normalizeSizes(sizes: number[], count: number): number[] {
  const base = sizes.slice(0, count);
  while (base.length < count) base.push(1);
  const sum = base.reduce((a, b) => a + b, 0);
  if (sum === 0) return Array(count).fill(1 / count);
  return base.map((s) => s / sum);
}

interface NoteTabMenuCallbacks {
  onOpenInNewWindow?: (note: OperationNote) => void;
  onRename?: (note: OperationNote) => void;
  onMoveToNotebook?: (note: OperationNote, notebookId: string) => void;
  onToggleFavorite?: (note: OperationNote) => void;
  onToggleBookmark?: (note: OperationNote) => void;
  onMergeNote?: (note: OperationNote, targetNoteId: string) => void;
  onFind?: (note: OperationNote) => void;
  onReplace?: (note: OperationNote) => void;
  onOpenWithDefaultApp?: (note: OperationNote) => void;
  onRevealInExplorer?: (note: OperationNote) => void;
  onShowInFileList?: (note: OperationNote) => void;
}

interface WorkspaceProps {
  workspace: WorkspaceState;
  onChange: (workspace: WorkspaceState) => void;
  notes: OperationNote[];
  notebooks: Notebook[];
  editorMode: EditorMode;
  noteTitles: string[];
  saveStatus?: "idle" | "saving" | "saved" | "error";
  onTitleChange: (noteId: string, title: string) => void;
  onContentChange: (
    noteId: string,
    next: {
      contentMarkdown: string;
      contentJson?: JSONContent;
      plainText: string;
      /** 流程图专用：提交时的 baseRevision */
      baseRevision?: number;
    },
  ) => void;
  onMoveSelectionToNote?: (selectedText: string) => void;
  toolbarExtra?: (noteId: string) => ReactNode;
  toolbarLeadingExtra?: (noteId: string) => ReactNode;
  onSelectNote: (noteId: string, paneId?: string) => void;
  onOpenNoteByTitle: (title: string) => void;
  toolbarTrailing?: ReactNode;
  tabMenuCallbacks?: NoteTabMenuCallbacks;
  /** 流程图多标签页写者租约：noteId → writerInstanceId */
  flowchartWriterByNote?: Record<string, string>;
  /** 申请成为写者（用户点击"在此编辑"） */
  onFlowchartRequestLease?: (noteId: string, editorInstanceId: string) => void;
  /** 流程图 revision：noteId → revision（用于多标签页校验） */
  flowchartRevisionByNote?: Record<string, number>;
  /** 流程图强制同步计数器：noteId → counter（NotesView 拒绝提交时递增） */
  flowchartForceSyncByNote?: Record<string, number>;
  /** Resolve embed target content by title (`![[...]]`). Returns null if not found. */
  resolveEmbedContent?: (title: string) => string | null;
  /** Whether the embed target is a flowchart note. */
  isEmbedFlowchart?: (title: string) => boolean;
}

interface PaneLeafProps {
  leaf: LeafPane;
  notes: OperationNote[];
  notebooks: Notebook[];
  isActive: boolean;
  editorMode: EditorMode;
  noteTitles: string[];
  saveStatus?: "idle" | "saving" | "saved" | "error";
  onTitleChange: (noteId: string, title: string) => void;
  onContentChange: (
    noteId: string,
    next: {
      contentMarkdown: string;
      contentJson?: JSONContent;
      plainText: string;
      /** 流程图专用：提交时的 baseRevision */
      baseRevision?: number;
    },
  ) => void;
  onMoveSelectionToNote?: (selectedText: string) => void;
  toolbarExtra?: (noteId: string) => ReactNode;
  toolbarLeadingExtra?: (noteId: string) => ReactNode;
  onSelect: (noteId: string) => void;
  onOpenNoteByTitle: (title: string) => void;
  onCloseTab: (noteId: string) => void;
  onCloseOthers: (noteId: string) => void;
  onCloseAll: () => void;
  onSplit: (direction: SplitDirection) => void;
  onClosePane: () => void;
  onToggleGraph: () => void;
  onActivate: () => void;
  toolbarTrailing?: ReactNode;
  isPrimary?: boolean;
  tabMenuCallbacks?: NoteTabMenuCallbacks;
  /** 流程图多标签页写者租约：noteId → writerInstanceId */
  flowchartWriterByNote?: Record<string, string>;
  /** 申请成为写者（用户点击"在此编辑"） */
  onFlowchartRequestLease?: (noteId: string, editorInstanceId: string) => void;
  /** 流程图 revision：noteId → revision */
  flowchartRevisionByNote?: Record<string, number>;
  /** 流程图强制同步计数器：noteId → counter */
  flowchartForceSyncByNote?: Record<string, number>;
  /** Resolve embed target content by title (`![[...]]`). Returns null if not found. */
  resolveEmbedContent?: (title: string) => string | null;
  /** Whether the embed target is a flowchart note. */
  isEmbedFlowchart?: (title: string) => boolean;
}

function PaneLeafView({
  leaf,
  notes,
  notebooks,
  isActive,
  editorMode,
  noteTitles,
  saveStatus,
  onTitleChange,
  onContentChange,
  onMoveSelectionToNote,
  toolbarExtra,
  toolbarLeadingExtra,
  onSelect,
  onOpenNoteByTitle,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
  onSplit,
  onClosePane: _onClosePane,
  onToggleGraph,
  onActivate,
  toolbarTrailing,
  isPrimary,
  tabMenuCallbacks,
  flowchartWriterByNote,
  onFlowchartRequestLease,
  flowchartRevisionByNote,
  flowchartForceSyncByNote,
  resolveEmbedContent,
  isEmbedFlowchart,
}: PaneLeafProps) {
  const tabs = useMemo(
    () => leaf.tabIds.map((id) => notes.find((n) => n.id === id)).filter((n): n is OperationNote => n != null),
    [leaf.tabIds, notes],
  );

  const activeNote = useMemo(
    () => (leaf.activeTabId ? notes.find((n) => n.id === leaf.activeTabId) ?? null : null),
    [leaf.activeTabId, notes],
  );

  return (
    <div
      className={cn("flex min-w-0 min-h-0 flex-col flex-1", isActive && "bg-background")}
      onMouseDownCapture={onActivate}
    >
      <div className="flex shrink-0 items-stretch border-b border-border/55">
        <div className="flex h-8 min-w-0 flex-1 items-stretch overflow-x-auto bg-background/50 scrollbar-thin">
          <NoteTabBar
            tabs={tabs}
            activeNoteId={leaf.graphOpen ? null : leaf.activeTabId}
            notebooks={notebooks}
            allNotes={notes}
            onSelect={onSelect}
            onClose={onCloseTab}
            onCloseOthers={onCloseOthers}
            onCloseAll={onCloseAll}
            onSplit={onSplit}
            {...tabMenuCallbacks}
          />
          {leaf.graphOpen && (
            <button
              type="button"
              title="关系图谱"
              aria-label="关系图谱"
              className="group relative flex h-full w-[140px] shrink-0 items-center gap-1.5 border-r border-border/40 bg-background px-3 text-[12px] text-foreground transition-colors"
            >
              <span className="absolute inset-x-0 top-0 h-[2px] bg-primary" />
              <GitFork className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left">关系图谱</span>
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleGraph();
                }}
                className="grid h-4 w-4 shrink-0 place-items-center rounded hover:bg-accent"
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          )}
        </div>
        {isPrimary && toolbarTrailing && (
          <div className="flex shrink-0 items-center">{toolbarTrailing}</div>
        )}
      </div>
      <div className="relative flex min-w-0 min-h-0 flex-1">
        {leaf.graphOpen ? (
          <GraphViewDialog
            open={true}
            onOpenChange={() => {}}
            activeNoteId={activeNote?.id}
            onSelectNote={(noteId) => {
              onSelect(noteId);
            }}
          />
        ) : activeNote ? (
          <NoteEditor
            key={activeNote.id}
            note={activeNote}
            saveStatus={saveStatus}
            mode={editorMode}
            noteTitles={noteTitles}
            onTitleChange={(title) => onTitleChange(activeNote.id, title)}
            onContentChange={(next) => onContentChange(activeNote.id, next)}
            onMoveSelectionToNote={onMoveSelectionToNote}
            onOpenNoteByTitle={onOpenNoteByTitle}
            toolbarExtra={toolbarExtra?.(activeNote.id)}
            toolbarLeadingExtra={toolbarLeadingExtra?.(activeNote.id)}
            flowchartWriterId={flowchartWriterByNote?.[activeNote.id]}
            onFlowchartRequestLease={
              onFlowchartRequestLease
                ? (editorInstanceId) => onFlowchartRequestLease(activeNote.id, editorInstanceId)
                : undefined
            }
            flowchartRevision={flowchartRevisionByNote?.[activeNote.id]}
            flowchartForceSync={flowchartForceSyncByNote?.[activeNote.id]}
            resolveEmbedContent={resolveEmbedContent}
            isEmbedFlowchart={isEmbedFlowchart}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
            <span className="text-[13px]">选择一篇笔记开始编辑</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface SplitViewProps {
  node: SplitPane;
  notes: OperationNote[];
  notebooks: Notebook[];
  activeLeafId: string;
  editorMode: EditorMode;
  noteTitles: string[];
  saveStatus?: "idle" | "saving" | "saved" | "error";
  onTitleChange: (noteId: string, title: string) => void;
  onContentChange: (
    noteId: string,
    next: {
      contentMarkdown: string;
      contentJson?: JSONContent;
      plainText: string;
      /** 流程图专用：提交时的 baseRevision */
      baseRevision?: number;
    },
  ) => void;
  onMoveSelectionToNote?: (selectedText: string) => void;
  toolbarExtra?: (noteId: string) => ReactNode;
  toolbarLeadingExtra?: (noteId: string) => ReactNode;
  onLeafChange: (leafId: string, updater: (leaf: LeafPane) => LeafPane) => void;
  onSplitLeaf: (leafId: string, direction: SplitDirection) => void;
  onCloseLeaf: (leafId: string) => void;
  onToggleGraphInLeaf: (leafId: string) => void;
  onSelectNote: (noteId: string, paneId?: string) => void;
  onOpenNoteByTitle: (title: string) => void;
  onSetActiveLeaf: (id: string) => void;
  onResize: (splitId: string, index: number, newSize: number) => void;
  toolbarTrailing?: ReactNode;
  primaryLeafId?: string | null;
  tabMenuCallbacks?: NoteTabMenuCallbacks;
  /** 流程图多标签页写者租约：noteId → writerInstanceId */
  flowchartWriterByNote?: Record<string, string>;
  /** 申请成为写者（用户点击"在此编辑"） */
  onFlowchartRequestLease?: (noteId: string, editorInstanceId: string) => void;
  /** 流程图 revision：noteId → revision */
  flowchartRevisionByNote?: Record<string, number>;
  /** 流程图强制同步计数器：noteId → counter */
  flowchartForceSyncByNote?: Record<string, number>;
  /** Resolve embed target content by title (`![[...]]`). Returns null if not found. */
  resolveEmbedContent?: (title: string) => string | null;
  /** Whether the embed target is a flowchart note. */
  isEmbedFlowchart?: (title: string) => boolean;
}

function SplitView({
  node,
  notes,
  notebooks,
  activeLeafId,
  editorMode,
  noteTitles,
  saveStatus,
  onTitleChange,
  onContentChange,
  onMoveSelectionToNote,
  toolbarExtra,
  toolbarLeadingExtra,
  onLeafChange,
  onSplitLeaf,
  onCloseLeaf,
  onToggleGraphInLeaf,
  onSelectNote,
  onOpenNoteByTitle,
  onSetActiveLeaf,
  onResize,
  toolbarTrailing,
  primaryLeafId,
  tabMenuCallbacks,
  flowchartWriterByNote,
  onFlowchartRequestLease,
  flowchartRevisionByNote,
  flowchartForceSyncByNote,
  resolveEmbedContent,
  isEmbedFlowchart,
}: SplitViewProps) {
  const isHorizontal = node.direction === "horizontal";
  const containerRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback(
    (index: number) => (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const total = isHorizontal ? rect.width : rect.height;
      if (total <= 0) return;

      const startPos = isHorizontal ? e.clientX : e.clientY;
      const startSizes = [...node.sizes];

      const handleMove = (ev: MouseEvent) => {
        const pos = isHorizontal ? ev.clientX : ev.clientY;
        const delta = (pos - startPos) / total;
        const newSizes = [...startSizes];
        const next = Math.max(0.1, Math.min(0.9, startSizes[index] + delta));
        const remaining = 1 - next;
        const otherTotal = startSizes.reduce((a, b, i) => (i === index ? a : a + b), 0);
        if (otherTotal <= 0) return;
        for (let i = 0; i < newSizes.length; i++) {
          if (i === index) {
            newSizes[i] = next;
          } else {
            newSizes[i] = (startSizes[i] / otherTotal) * remaining;
          }
        }
        onResize(node.id, index, newSizes[index]);
      };

      const handleUp = () => {
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
      };
      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
    },
    [node, isHorizontal, onResize],
  );

  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 min-w-0 flex-1", isHorizontal ? "flex-row" : "flex-col")}
    >
      {node.children.flatMap((child, index) => {
        const items: ReactNode[] = [
          <div
            key={child.id}
            className="flex min-w-0 min-h-0 flex-col overflow-hidden"
            style={{ flexGrow: 1, flexShrink: 1, flexBasis: `${node.sizes[index] * 100}%` }}
          >
            {child.type === "leaf" ? (
              <PaneLeafView
                leaf={child}
                notes={notes}
                notebooks={notebooks}
                isActive={child.id === activeLeafId}
                editorMode={editorMode}
                noteTitles={noteTitles}
                saveStatus={saveStatus}
                onTitleChange={onTitleChange}
                onContentChange={onContentChange}
                onMoveSelectionToNote={onMoveSelectionToNote}
                toolbarExtra={toolbarExtra}
                toolbarLeadingExtra={toolbarLeadingExtra}
                onSelect={(noteId) => onSelectNote(noteId, child.id)}
                onOpenNoteByTitle={onOpenNoteByTitle}
                onCloseTab={(noteId) =>
                  onLeafChange(child.id, (leaf) => {
                    const tabIds = leaf.tabIds.filter((id) => id !== noteId);
                    let activeTabId = leaf.activeTabId;
                    if (activeTabId === noteId) {
                      const idx = leaf.tabIds.indexOf(noteId);
                      activeTabId = tabIds[idx] ?? tabIds[idx - 1] ?? tabIds[0] ?? null;
                    }
                    return { ...leaf, tabIds, activeTabId };
                  })
                }
                onCloseOthers={(noteId) =>
                  onLeafChange(child.id, (leaf) => ({
                    ...leaf,
                    tabIds: [noteId],
                    activeTabId: noteId,
                  }))
                }
                onCloseAll={() =>
                  onLeafChange(child.id, (leaf) => ({
                    ...leaf,
                    tabIds: [],
                    activeTabId: null,
                    graphOpen: leaf.graphOpen ? false : leaf.graphOpen,
                  }))
                }
                onSplit={(direction) => onSplitLeaf(child.id, direction)}
              onClosePane={() => onCloseLeaf(child.id)}
              onToggleGraph={() => onToggleGraphInLeaf(child.id)}
              onActivate={() => onSetActiveLeaf(child.id)}
              toolbarTrailing={toolbarTrailing}
              isPrimary={child.id === primaryLeafId}
              tabMenuCallbacks={tabMenuCallbacks}
              flowchartWriterByNote={flowchartWriterByNote}
              onFlowchartRequestLease={onFlowchartRequestLease}
              flowchartRevisionByNote={flowchartRevisionByNote}
              flowchartForceSyncByNote={flowchartForceSyncByNote}
              resolveEmbedContent={resolveEmbedContent}
              isEmbedFlowchart={isEmbedFlowchart}
            />
            ) : (
              <SplitView
                node={child}
                notes={notes}
                notebooks={notebooks}
                activeLeafId={activeLeafId}
                editorMode={editorMode}
                noteTitles={noteTitles}
                saveStatus={saveStatus}
                onTitleChange={onTitleChange}
                onContentChange={onContentChange}
                onMoveSelectionToNote={onMoveSelectionToNote}
                toolbarExtra={toolbarExtra}
                toolbarLeadingExtra={toolbarLeadingExtra}
                onLeafChange={onLeafChange}
                onSplitLeaf={onSplitLeaf}
                onCloseLeaf={onCloseLeaf}
                onToggleGraphInLeaf={onToggleGraphInLeaf}
                onSelectNote={onSelectNote}
                onOpenNoteByTitle={onOpenNoteByTitle}
                onSetActiveLeaf={onSetActiveLeaf}
                onResize={onResize}
                toolbarTrailing={toolbarTrailing}
                primaryLeafId={primaryLeafId}
                tabMenuCallbacks={tabMenuCallbacks}
                flowchartWriterByNote={flowchartWriterByNote}
                onFlowchartRequestLease={onFlowchartRequestLease}
                flowchartRevisionByNote={flowchartRevisionByNote}
                flowchartForceSyncByNote={flowchartForceSyncByNote}
                resolveEmbedContent={resolveEmbedContent}
                isEmbedFlowchart={isEmbedFlowchart}
              />
            )}
          </div>,
        ];
        if (index < node.children.length - 1) {
          items.push(
            <div
              key={`handle-${child.id}`}
              className={cn(
                "shrink-0 bg-border/40 hover:bg-primary/40",
                isHorizontal ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
              )}
              onMouseDown={handleResizeStart(index)}
            />,
          );
        }
        return items;
      })}
    </div>
  );
}

export function Workspace({
  workspace,
  onChange,
  notes,
  notebooks,
  editorMode,
  noteTitles,
  saveStatus,
  onTitleChange,
  onContentChange,
  onMoveSelectionToNote,
  toolbarExtra,
  toolbarLeadingExtra,
  onSelectNote,
  onOpenNoteByTitle,
  toolbarTrailing,
  tabMenuCallbacks,
  flowchartWriterByNote,
  onFlowchartRequestLease,
  flowchartRevisionByNote,
  flowchartForceSyncByNote,
  resolveEmbedContent,
  isEmbedFlowchart,
}: WorkspaceProps) {
  const handleLeafChange = useCallback(
    (leafId: string, updater: (leaf: LeafPane) => LeafPane) => {
      onChange({
        ...workspace,
        root: mapNode(workspace.root, (node) => {
          if (node.type === "leaf" && node.id === leafId) {
            return updater(node);
          }
          return node;
        }),
      });
    },
    [workspace, onChange],
  );

  const handleSplitLeaf = useCallback(
    (leafId: string, direction: SplitDirection) => {
      const leaf = findLeafById(workspace.root, leafId);
      if (!leaf) return;
      const newLeafId = generateId();
      const activeNoteId = leaf.activeTabId;
      const newLeaf: LeafPane = {
        id: newLeafId,
        type: "leaf",
        tabIds: activeNoteId ? [activeNoteId] : [],
        activeTabId: activeNoteId,
        graphOpen: false,
      };

      const replaceLeaf = (node: PaneNode): PaneNode => {
        if (node.type === "leaf" && node.id === leafId) {
          // vertical (上下分屏): newLeaf 在上；horizontal (左右分屏): newLeaf 在右
          const children = direction === "vertical" ? [newLeaf, node] : [node, newLeaf];
          return {
            id: generateId(),
            type: "split",
            direction,
            sizes: [0.5, 0.5],
            children,
          };
        }
        if (node.type === "split") {
          return {
            ...node,
            children: node.children.map(replaceLeaf),
          };
        }
        return node;
      };

      onChange({
        ...workspace,
        root: replaceLeaf(workspace.root),
        activeLeafId: newLeafId,
      });
    },
    [workspace, onChange],
  );

  const handleCloseLeaf = useCallback(
    (leafId: string) => {
      const newRoot = removeLeaf(workspace.root, leafId);
      if (!newRoot) return;
      const firstLeaf = getFirstLeaf(newRoot);
      onChange({
        ...workspace,
        root: newRoot,
        activeLeafId: firstLeaf?.id ?? workspace.activeLeafId,
      });
    },
    [workspace, onChange],
  );

  const handleToggleGraph = useCallback(
    (leafId: string) => {
      handleLeafChange(leafId, (leaf) => ({ ...leaf, graphOpen: !leaf.graphOpen }));
    },
    [handleLeafChange],
  );

  const handleSetActiveLeaf = useCallback(
    (id: string) => {
      if (workspace.activeLeafId !== id) {
        onChange({ ...workspace, activeLeafId: id });
      }
    },
    [workspace, onChange],
  );

  const handleResize = useCallback(
    (splitId: string, index: number, newSize: number) => {
      onChange({
        ...workspace,
        root: mapNode(workspace.root, (node) => {
          if (node.type === "split" && node.id === splitId) {
            const sizes = [...node.sizes];
            const remaining = 1 - newSize;
            const otherTotal = sizes.reduce((a, b, i) => (i === index ? a : a + b), 0);
            for (let i = 0; i < sizes.length; i++) {
              if (i === index) {
                sizes[i] = newSize;
              } else if (otherTotal > 0) {
                sizes[i] = (sizes[i] / otherTotal) * remaining;
              }
            }
            return { ...node, sizes };
          }
          return node;
        }),
      });
    },
    [workspace, onChange],
  );

  // 标签全部关闭的 leaf 自动删除（保留唯一 leaf 作为空状态）
  useEffect(() => {
    const allLeaves = getAllLeafObjects(workspace.root);
    if (allLeaves.length <= 1) return;
    const emptyLeaves = allLeaves.filter((l) => l.tabIds.length === 0);
    if (emptyLeaves.length === 0) return;
    let newRoot: PaneNode = workspace.root;
    let changed = false;
    for (const emptyLeaf of emptyLeaves) {
      const after = removeLeaf(newRoot, emptyLeaf.id);
      if (after) {
        newRoot = after;
        changed = true;
      }
    }
    if (!changed) return;
    const validLeafIds = new Set(getAllLeafIds(newRoot));
    let nextActiveLeafId = workspace.activeLeafId;
    if (!validLeafIds.has(nextActiveLeafId)) {
      nextActiveLeafId = getFirstLeaf(newRoot)?.id ?? nextActiveLeafId;
    }
    onChange({ ...workspace, root: newRoot, activeLeafId: nextActiveLeafId });
  }, [workspace, onChange]);

  const leafProps = {
    notes,
    notebooks,
    editorMode,
    noteTitles,
    saveStatus,
    onTitleChange,
    onContentChange,
    onMoveSelectionToNote,
    toolbarExtra,
    toolbarLeadingExtra,
    onOpenNoteByTitle,
    toolbarTrailing,
    tabMenuCallbacks,
    flowchartWriterByNote,
    onFlowchartRequestLease,
    flowchartRevisionByNote,
    flowchartForceSyncByNote,
    resolveEmbedContent,
    isEmbedFlowchart,
  };

  // 主 leaf：视觉上最右最上的 leaf，用于固定显示工具栏按钮
  const primaryLeafId = useMemo(() => getTopRightLeaf(workspace.root)?.id ?? null, [workspace.root]);

  if (workspace.root.type === "leaf") {
    const leafId = workspace.root.id;
    return (
      <PaneLeafView
        {...leafProps}
        leaf={workspace.root}
        isActive
        isPrimary
        onSelect={(noteId) => onSelectNote(noteId, leafId)}
        onCloseTab={(noteId) =>
          handleLeafChange(leafId, (leaf) => {
            const tabIds = leaf.tabIds.filter((id) => id !== noteId);
            let activeTabId = leaf.activeTabId;
            if (activeTabId === noteId) {
              const idx = leaf.tabIds.indexOf(noteId);
              activeTabId = tabIds[idx] ?? tabIds[idx - 1] ?? tabIds[0] ?? null;
            }
            return { ...leaf, tabIds, activeTabId };
          })
        }
        onCloseOthers={(noteId) =>
          handleLeafChange(leafId, (leaf) => ({
            ...leaf,
            tabIds: [noteId],
            activeTabId: noteId,
          }))
        }
        onCloseAll={() =>
          handleLeafChange(leafId, (leaf) => ({
            ...leaf,
            tabIds: [],
            activeTabId: null,
            graphOpen: false,
          }))
        }
        onSplit={(direction) => handleSplitLeaf(leafId, direction)}
        onClosePane={() => handleCloseLeaf(leafId)}
        onToggleGraph={() => handleToggleGraph(leafId)}
        onActivate={() => handleSetActiveLeaf(leafId)}
      />
    );
  }

  return (
    <SplitView
      node={workspace.root}
      notes={notes}
      notebooks={notebooks}
      activeLeafId={workspace.activeLeafId}
      editorMode={editorMode}
      noteTitles={noteTitles}
      saveStatus={saveStatus}
      onTitleChange={onTitleChange}
      onContentChange={onContentChange}
      onMoveSelectionToNote={onMoveSelectionToNote}
      toolbarExtra={toolbarExtra}
      toolbarLeadingExtra={toolbarLeadingExtra}
      onLeafChange={handleLeafChange}
      onSplitLeaf={handleSplitLeaf}
      onCloseLeaf={handleCloseLeaf}
      onToggleGraphInLeaf={handleToggleGraph}
      onSelectNote={onSelectNote}
      onOpenNoteByTitle={onOpenNoteByTitle}
      onSetActiveLeaf={handleSetActiveLeaf}
      onResize={handleResize}
      toolbarTrailing={toolbarTrailing}
      primaryLeafId={primaryLeafId}
      tabMenuCallbacks={tabMenuCallbacks}
      flowchartWriterByNote={flowchartWriterByNote}
      onFlowchartRequestLease={onFlowchartRequestLease}
      flowchartRevisionByNote={flowchartRevisionByNote}
      flowchartForceSyncByNote={flowchartForceSyncByNote}
      resolveEmbedContent={resolveEmbedContent}
      isEmbedFlowchart={isEmbedFlowchart}
    />
  );
}

function getFirstLeaf(node: PaneNode): LeafPane | null {
  if (node.type === "leaf") return node;
  return node.children.length > 0 ? getFirstLeaf(node.children[0]) : null;
}

// 获取视觉上"最右最上"的 leaf：水平分屏取最后（右），垂直分屏取第一个（上）
function getTopRightLeaf(node: PaneNode): LeafPane | null {
  if (node.type === "leaf") return node;
  if (node.children.length === 0) return null;
  const idx = node.direction === "vertical" ? 0 : node.children.length - 1;
  return getTopRightLeaf(node.children[idx]);
}

function getAllLeafIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.id];
  return node.children.flatMap(getAllLeafIds);
}

function getAllLeafObjects(node: PaneNode): LeafPane[] {
  if (node.type === "leaf") return [node];
  return node.children.flatMap(getAllLeafObjects);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeNode(node: unknown, noteIds: Set<string>): PaneNode | null {
  if (!isPlainObject(node)) return null;
  const type = node.type;
  if (type === "leaf") {
    const rawTabIds = Array.isArray(node.tabIds) ? node.tabIds : [];
    const tabIds = rawTabIds.filter((id): id is string => typeof id === "string" && noteIds.has(id));
    let activeTabId: string | null = null;
    if (typeof node.activeTabId === "string" && tabIds.includes(node.activeTabId)) {
      activeTabId = node.activeTabId;
    } else if (tabIds.length > 0) {
      activeTabId = tabIds[0];
    }
    const id = typeof node.id === "string" && node.id ? node.id : generateId();
    return {
      id,
      type: "leaf",
      tabIds,
      activeTabId,
      graphOpen: node.graphOpen === true,
    };
  }
  if (type === "split") {
    const direction = node.direction === "vertical" ? "vertical" : "horizontal";
    const rawChildren = Array.isArray(node.children) ? node.children : [];
    const children: PaneNode[] = [];
    for (const child of rawChildren) {
      const sanitized = sanitizeNode(child, noteIds);
      if (sanitized) children.push(sanitized);
    }
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    const id = typeof node.id === "string" && node.id ? node.id : generateId();
    const sizes = normalizeSizes(Array.isArray(node.sizes) ? node.sizes.map((s) => Number(s)) : [], children.length);
    return { id, type: "split", direction, sizes, children };
  }
  return null;
}

export function sanitizeWorkspaceState(
  workspace: unknown,
  noteIds: Set<string>,
  fallbackActiveNoteId?: string | null,
): WorkspaceState {
  let root: PaneNode | null = null;
  let activeLeafId: string | null = null;
  if (isPlainObject(workspace)) {
    root = sanitizeNode(workspace.root, noteIds);
    if (typeof workspace.activeLeafId === "string" && workspace.activeLeafId) {
      activeLeafId = workspace.activeLeafId;
    }
  }
  if (!root) {
    return createInitialWorkspace(fallbackActiveNoteId);
  }
  const validLeafIds = new Set(getAllLeafIds(root));
  if (!activeLeafId || !validLeafIds.has(activeLeafId)) {
    activeLeafId = getFirstLeaf(root)?.id ?? null;
  }
  if (!activeLeafId) {
    return createInitialWorkspace(fallbackActiveNoteId);
  }
  return { root, activeLeafId };
}
