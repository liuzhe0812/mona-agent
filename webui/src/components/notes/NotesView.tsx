import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownUp,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronRight,
  Copy,
  Crosshair,
  Download,
  FileCode2,
  FileText,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitFork,
  ListChecks,
  LockKeyhole,
  Mic,
  MicOff,
  MoreHorizontal,
  Pencil,
  Plus,
  Printer,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { AgentLogo } from "@/components/AgentLogo";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  getNotesVaultPath,
  isTauri,
  openPathWithSystemApp,
  pickNotesVaultDirectory,
  renameSyncWikiLinks,
  revealItemInDir,
  saveMarkdownFile,
  setNotesVaultPath,
} from "@/lib/tauri";
import { useLicense } from "@/hooks/useLicense";

import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { ConfirmDialog, PromptDialog, TemplatePickerDialog } from "./NotesDialogs";
import { NoteAgentPanel } from "./NoteAgentPanel";
import { MaterialsSidebar, MaterialsPreview, type MaterialsSelection } from "./materials/MaterialsView";
import type { EditorMode } from "@/components/common/MarkdownEditor";
import { openActiveEditorFind, openActiveEditorReplace } from "@/components/common/FindReplaceBar";
import { NoteList, NoteRow, sortNotesByMode, type SortMode } from "./NoteList";
import { RightSidebar, type RightTab } from "./RightSidebar";
import { RightSidebarToggleIcon } from "./RightSidebarToggleIcon";
import { TasksPanel } from "./TasksPanel";
import { toggleTaskInMarkdown } from "./tasks-extract";
import { deriveNotePreview } from "./notes-ai";
import { useSpeechRecognition } from "./useSpeechRecognition";
import {
  Workspace,
  createInitialWorkspace,
  findLeafById,
  mapNode,
  sanitizeWorkspaceState,
  type WorkspaceState,
  type LeafPane,
} from "./Workspace";
import type {
  Notebook,
  NoteContextLevel,
  NoteSourceKind,
  NoteTransformation,
  OperationNote,
} from "./notes-data";
import { nowTimestamp } from "./notes-data";
import {
  createBlankNote,
  createCustomNotebook,
  createNoteFromTemplate,
  createNoteId,
  loadNotesState,
  saveNotesState,
} from "./notes-storage";

const AGENT_PANEL_MIN_WIDTH = 240;
const AGENT_PANEL_MAX_WIDTH = 480;
const AGENT_PANEL_DEFAULT_WIDTH = 306;

const RIGHT_SIDEBAR_MIN_WIDTH = 200;
const RIGHT_SIDEBAR_MAX_WIDTH = 420;
const RIGHT_SIDEBAR_DEFAULT_WIDTH = 260;

interface NotesViewProps {
  onSendToAgent?: (prompt: string) => void | Promise<void>;
  onOpenSubscribe?: () => void;
  initialNoteId?: string;
  createOnOpen?: boolean;
  onCreateOnOpenHandled?: () => void;
}

export function NotesView({
  onSendToAgent: _onSendToAgent,
  onOpenSubscribe,
  initialNoteId,
  createOnOpen = false,
  onCreateOnOpenHandled,
}: NotesViewProps) {
  const { licenseActive } = useLicense();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [activeNotebookId, setActiveNotebookId] = useState("");
  const [notes, setNotes] = useState<OperationNote[]>([]);
  const [transformations, setTransformations] = useState<NoteTransformation[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeType, setNoticeType] = useState<"info" | "error">("info");
  const [editorMode, setEditorMode] = useState<EditorMode>("visual");
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [moduleView, setModuleView] = useState<"notes" | "materials">("notes");
  const [materialsSelection, setMaterialsSelection] = useState<MaterialsSelection>(null);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(true);
  const [agentPanelWidth, setAgentPanelWidth] = useState(AGENT_PANEL_DEFAULT_WIDTH);
  const [agentStreaming, setAgentStreaming] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => createInitialWorkspace(null));
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(RIGHT_SIDEBAR_DEFAULT_WIDTH);
  const [rightActiveTab, setRightActiveTab] = useState<RightTab>("outline");
  const [tasksPanelOpen, setTasksPanelOpen] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const rightDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const lastSavedSnapshotRef = useRef<string | null>(null);
  const latestSnapshotRef = useRef<string | null>(null);

  // 录音转写状态。当前正在录音的笔记 id 和已确定的文字。
  // 用 ref 避免回调闭包陈旧问题，state 仅用于按钮 UI 反馈。
  // 录音内容会追加到当前活动笔记末尾（保留笔记原有内容），而非创建新笔记。
  const recordingNoteRef = useRef<string | null>(null);
  // 录音开始时笔记原有的正文（用于在写入时拼到前面，避免覆盖用户已有内容）
  const recordingBaseRef = useRef<string>("");
  const recordingFinalRef = useRef<string>("");
  const recordingInterimRef = useRef<string>("");
  const [recordingActive, setRecordingActive] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);

  // 把当前累积的文字写入对应笔记。final+interim 一起写，让用户实时看到进度。
  // 在录音开始时记下的 base 内容后追加，保留笔记原有内容。
  const flushRecordingToNote = useCallback(() => {
    const noteId = recordingNoteRef.current;
    if (!noteId) return;
    const base = recordingBaseRef.current;
    const finalText = recordingFinalRef.current;
    const interim = recordingInterimRef.current;
    const appended = `${finalText}${interim ? interim : ""}`;
    const markdown = base ? `${base.replace(/\s+$/, "")}\n\n${appended}` : appended;
    setNotes((current) =>
      current.map((n) =>
        n.id === noteId
          ? {
              ...n,
              contentMarkdown: markdown,
              plainText: markdown,
              preview: markdown.slice(0, 46) || "录音中…",
              updatedAt: nowTimestamp(),
            }
          : n,
      ),
    );
  }, []);

  const speech = useSpeechRecognition({
    lang: "zh-CN",
    onFinalChunk: (text) => {
      // final 结果追加到累积文字末尾，interim 清空（刚确认的就是 interim 的内容）
      recordingFinalRef.current = `${recordingFinalRef.current}${text}`.trimStart();
      recordingInterimRef.current = "";
      flushRecordingToNote();
    },
    onInterim: (text) => {
      recordingInterimRef.current = text;
      flushRecordingToNote();
    },
  });

  // 同步 hook 的 error 到本地 state（用于弹提示）
  useEffect(() => {
    if (speech.error) setRecordingError(speech.error);
  }, [speech.error]);


  // Dialog state for replacing browser native prompt/confirm
  type PromptState =
    | { kind: "createNotebook" }
    | { kind: "renameNotebook"; notebookId: string }
    | { kind: "renameNote"; noteId: string };
  type ConfirmState =
    | { kind: "deleteNotebook"; notebookId: string }
    | { kind: "deleteNote"; noteId: string }
    | { kind: "deleteNotes"; noteIds: string[] };
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [globalSearchInitialQuery, setGlobalSearchInitialQuery] = useState("");
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [expandedNotebookIds, setExpandedNotebookIds] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<SortMode>("updated-desc");
  const [viewMode, setViewMode] = useState<"all" | "favorite">("all");

  const deleteManyNotes = useCallback(
    (notesToDelete: OperationNote[]) => {
      if (notesToDelete.length === 0) return;
      setConfirmState({ kind: "deleteNotes", noteIds: notesToDelete.map((n) => n.id) });
    },
    [],
  );

  const activeNotebook = useMemo(
    () => notebooks.find((notebook) => notebook.id === activeNotebookId) ?? null,
    [activeNotebookId, notebooks],
  );

  const notebookNotes = useMemo(
    () => notes.filter((note) => note.notebookId === activeNotebookId),
    [activeNotebookId, notes],
  );

  const activeNote = useMemo(
    () => notes.find((note) => note.id === activeNoteId) ?? null,
    [activeNoteId, notes],
  );

  const activeLeafGraphOpen = useMemo(
    () => findLeafById(workspace.root, workspace.activeLeafId)?.graphOpen ?? false,
    [workspace],
  );

  // All note titles for [[wiki link]] autocomplete in the editor.
  const noteTitles = useMemo(() => notes.map((n) => n.title).filter(Boolean), [notes]);

  const notebookNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const nb of notebooks) {
      m.set(nb.id, nb.name);
    }
    return m;
  }, [notebooks]);

  const templateNotes = useMemo(
    () => notes.filter((n) => n.type === "template"),
    [notes],
  );

  const filterNotesByKeyword = useCallback(
    (list: OperationNote[], keyword: string) => {
      const trimmed = keyword.trim().toLowerCase();
      if (!trimmed) return list;
      return list.filter((note) => {
        const haystack = [
          note.title,
          note.preview,
          note.source.label,
          note.tags.join(" "),
          note.plainText,
          note.contentMarkdown,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(trimmed);
      });
    },
    [],
  );

  const updateLeaf = useCallback(
    (
      ws: WorkspaceState,
      leafId: string,
      updater: (leaf: LeafPane) => LeafPane,
    ): WorkspaceState => ({
      ...ws,
      root: mapNode(ws.root, (node) => {
        if (node.type === "leaf" && node.id === leafId) {
          return updater(node);
        }
        return node;
      }),
    }),
    [],
  );

  const toggleGraphInActiveLeaf = useCallback(() => {
    setWorkspace((prev) =>
      updateLeaf(prev, prev.activeLeafId, (leaf) => ({ ...leaf, graphOpen: !leaf.graphOpen })),
    );
  }, [updateLeaf]);

  const startRecording = useCallback(() => {
    if (!speech.supported) {
      setRecordingError("当前环境不支持语音识别（需 Edge / WebView2 内核）");
      return;
    }
    // 按钮只对当前活动笔记生效：没有打开笔记时直接退出。
    // 录音内容追加到当前笔记末尾，不创建新笔记。
    const note = activeNote;
    if (!note) {
      setRecordingError("请先打开一个笔记");
      return;
    }
    setRecordingError(null);
    recordingNoteRef.current = note.id;
    recordingBaseRef.current = note.contentMarkdown ?? "";
    recordingFinalRef.current = "";
    recordingInterimRef.current = "";
    setRecordingActive(true);
    speech.start();
  }, [speech, activeNote]);

  const stopRecording = useCallback(() => {
    speech.stop();
    setRecordingActive(false);
    // 录音结束后清理状态。转写文字已实时写入笔记，这里只清空 ref。
    // 如果没有识别到任何内容，回退到录音前的正文。
    const noteId = recordingNoteRef.current;
    const finalText = recordingFinalRef.current.trim();
    const base = recordingBaseRef.current;
    if (noteId && !finalText && base) {
      setNotes((current) =>
        current.map((n) =>
          n.id === noteId
            ? {
                ...n,
                contentMarkdown: base,
                plainText: base,
                preview: base.slice(0, 46) || "空白笔记",
                updatedAt: nowTimestamp(),
              }
            : n,
        ),
      );
    }
    recordingNoteRef.current = null;
    recordingBaseRef.current = "";
    recordingFinalRef.current = "";
    recordingInterimRef.current = "";
  }, [speech]);

  const selectNoteInWorkspace = useCallback(
    (noteId: string, leafId?: string) => {
      const targetLeafId = leafId ?? workspace.activeLeafId;
      const note = notes.find((n) => n.id === noteId);
      if (note && note.notebookId !== activeNotebookId) {
        setActiveNotebookId(note.notebookId);
        setExpandedNotebookIds((prev) => {
          const next = new Set(prev);
          next.add(note.notebookId);
          return next;
        });
      }
      setActiveNoteId(noteId);
      setWorkspace((prev) =>
        updateLeaf(prev, targetLeafId, (leaf) => {
          if (leaf.tabIds.includes(noteId)) {
            return { ...leaf, activeTabId: noteId, graphOpen: false };
          }
          const activeIdx = leaf.activeTabId ? leaf.tabIds.indexOf(leaf.activeTabId) : -1;
          if (activeIdx >= 0) {
            const nextTabIds = [...leaf.tabIds];
            nextTabIds[activeIdx] = noteId;
            return { ...leaf, tabIds: nextTabIds, activeTabId: noteId, graphOpen: false };
          }
          return {
            ...leaf,
            tabIds: [...leaf.tabIds, noteId],
            activeTabId: noteId,
            graphOpen: false,
          };
        }),
      );
    },
    [notes, activeNotebookId, workspace.activeLeafId, updateLeaf],
  );

  const selectNote = useCallback(
    (noteId: string) => {
      selectNoteInWorkspace(noteId);
    },
    [selectNoteInWorkspace],
  );

  const openNoteByTitle = useCallback(
    (title: string) => {
      const normalized = title.trim().toLowerCase();
      const match = notes.find(
        (n) => n.title.trim().toLowerCase() === normalized,
      );
      if (match) {
        selectNote(match.id);
      } else {
        // Obsidian behaviour: create the note in the vault root if it doesn't exist.
        const trimmed = title.trim();
        if (!trimmed) return;
        const nextNote = createBlankNote("", "manual");
        nextNote.title = trimmed;
        nextNote.preview = "";
        setNotes((current) => [nextNote, ...current]);
        selectNote(nextNote.id);
      }
    },
    [notes, selectNote],
  );

  const openInNewTab = useCallback(
    (noteId: string, leafId?: string) => {
      const targetLeafId = leafId ?? workspace.activeLeafId;
      const note = notes.find((n) => n.id === noteId);
      if (note && note.notebookId !== activeNotebookId) {
        setActiveNotebookId(note.notebookId);
        setExpandedNotebookIds((prev) => {
          const next = new Set(prev);
          next.add(note.notebookId);
          return next;
        });
      }
      setActiveNoteId(noteId);
      setWorkspace((prev) =>
        updateLeaf(prev, targetLeafId, (leaf) =>
          leaf.tabIds.includes(noteId)
            ? { ...leaf, activeTabId: noteId, graphOpen: false }
            : { ...leaf, tabIds: [...leaf.tabIds, noteId], activeTabId: noteId, graphOpen: false },
        ),
      );
    },
    [notes, activeNotebookId, workspace.activeLeafId, updateLeaf],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const path = await getNotesVaultPath();
        if (cancelled) return;
        setVaultPath(path);
        const nextState = await loadNotesState();
        if (cancelled) return;
        setNotebooks(nextState.notebooks);
        setNotes(nextState.notes);
        setTransformations(nextState.transformations ?? []);
        setActiveNotebookId(nextState.activeNotebookId);
        setActiveNoteId(nextState.activeNoteId);
        const noteIds = new Set(nextState.notes.map((n) => n.id));
        const restoredWorkspace = sanitizeWorkspaceState(nextState.workspace, noteIds, nextState.activeNoteId);
        setWorkspace(restoredWorkspace);
        setRightSidebarOpen(nextState.rightSidebarOpen ?? false);
        setRightSidebarWidth(clampRightSidebarWidth(nextState.rightSidebarWidth));
        setRightActiveTab(sanitizeRightActiveTab(nextState.rightActiveTab));
        if (nextState.activeNotebookId) {
          setExpandedNotebookIds((prev) => {
            const next = new Set(prev);
            next.add(nextState.activeNotebookId);
            return next;
          });
        }
        if (initialNoteId && noteIds.has(initialNoteId)) {
          const target = nextState.notes.find((n) => n.id === initialNoteId);
          if (target) {
            setActiveNoteId(initialNoteId);
            setActiveNotebookId(target.notebookId);
            setExpandedNotebookIds((prev) => {
              const next = new Set(prev);
              if (target.notebookId) next.add(target.notebookId);
              return next;
            });
            setWorkspace((prev) => {
              const leafId = prev.activeLeafId;
              return updateLeaf(prev, leafId, (leaf) =>
                leaf.tabIds.includes(initialNoteId)
                  ? { ...leaf, activeTabId: initialNoteId, graphOpen: false }
                  : {
                      ...leaf,
                      tabIds: [...leaf.tabIds, initialNoteId],
                      activeTabId: initialNoteId,
                      graphOpen: false,
                    },
              );
            });
          }
        }
        lastSavedSnapshotRef.current = serializeNotesState({
          ...nextState,
          workspace: restoredWorkspace,
          rightSidebarOpen: nextState.rightSidebarOpen ?? false,
          rightSidebarWidth: clampRightSidebarWidth(nextState.rightSidebarWidth),
          rightActiveTab: sanitizeRightActiveTab(nextState.rightActiveTab),
        });
        latestSnapshotRef.current = lastSavedSnapshotRef.current;
        setStorageError(null);
        setSaveStatus("saved");
      } catch (error) {
        if (!cancelled) {
          setStorageError(error instanceof Error ? error.message : "笔记存储加载失败");
        }
      } finally {
        if (!cancelled) setStorageReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialNoteId]);

  // Refresh notes state when the window regains focus.
  // This picks up notes created by the agent (via notes_create_from_chat)
  // without requiring the user to manually reload.
  useEffect(() => {
    if (!storageReady || storageError) return;
    let timer: number | undefined;
    const handleFocus = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const nextState = await loadNotesState();
          const existingIds = new Set(notes.map((n) => n.id));
          const hasNew = nextState.notes.some((n) => !existingIds.has(n.id));
          const hasRemoved = notes.some((n) => !nextState.notes.some((n2) => n2.id === n.id));
          if (!hasNew && !hasRemoved) return;
          // Preserve the currently active note's in-memory content to avoid
          // clobbering unsaved edits; only update the list.
          setNotebooks(nextState.notebooks);
          setNotes((current) => {
            const nextById = new Map(nextState.notes.map((n) => [n.id, n]));
            return current
              .map((n) => nextById.get(n.id) ?? n)
              .concat(nextState.notes.filter((n) => !current.some((c) => c.id === n.id)));
          });
          setTransformations(nextState.transformations ?? []);
        } catch {
          // Ignore refresh errors; the existing state is still valid.
        }
      }, 400);
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.clearTimeout(timer);
    };
  }, [storageReady, storageError, notes]);

  useEffect(() => {
    if (!storageReady || storageError || notebooks.length === 0) return;

    const state = {
      notebooks,
      notes,
      transformations,
      activeNotebookId,
      activeNoteId,
      workspace,
      rightSidebarOpen,
      rightSidebarWidth,
      rightActiveTab,
    };
    const snapshot = serializeNotesState(state);
    latestSnapshotRef.current = snapshot;
    if (snapshot === lastSavedSnapshotRef.current) return;

    setSaveStatus("saving");
    const timer = window.setTimeout(() => {
      void saveNotesState(state)
        .then(() => {
          lastSavedSnapshotRef.current = snapshot;
          if (latestSnapshotRef.current === snapshot) setSaveStatus("saved");
        })
        .catch((error) => {
          if (latestSnapshotRef.current === snapshot) setSaveStatus("error");
          const msg = error instanceof Error ? error.message : String(error);
          notifyError(`笔记保存失败：${msg}`);
        });
    }, 450);

    return () => window.clearTimeout(timer);
  }, [
    activeNoteId,
    activeNotebookId,
    notebooks,
    notes,
    rightActiveTab,
    rightSidebarOpen,
    rightSidebarWidth,
    storageError,
    storageReady,
    transformations,
    workspace,
  ]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const notifyError = useCallback((msg: string) => {
    setNoticeType("error");
    setNotice(msg);
  }, []);

  // Success messages are silent — only errors show a toast.

  // Global search shortcut: Ctrl/Cmd + K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setGlobalSearchInitialQuery("");
        setGlobalSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Delete key to remove selected notes (with confirmation)
  useEffect(() => {
    if (selectedNoteIds.size === 0) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement;
      // Don't hijack when typing in inputs/editors
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) {
        return;
      }
      e.preventDefault();
      const selectedNotes = notes.filter((n) => selectedNoteIds.has(n.id));
      if (selectedNotes.length > 0) {
        deleteManyNotes(selectedNotes);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedNoteIds, notes, deleteManyNotes]);

  const openNoteFromGlobalSearch = useCallback(
    (noteId: string, _notebookId?: string) => {
      const note = notes.find((item) => item.id === noteId);
      if (!note) {
        notifyError("笔记不存在");
        return;
      }
      selectNoteInWorkspace(note.id);
      setSearchQuery("");
    },
    [notes, selectNoteInWorkspace],
  );


  useEffect(() => {
    if (!activeNote && notebookNotes[0]) {
      const nextId = notebookNotes[0].id;
      setActiveNoteId(nextId);
      setWorkspace((prev) =>
        updateLeaf(prev, prev.activeLeafId, (leaf) =>
          leaf.tabIds.includes(nextId)
            ? { ...leaf, activeTabId: nextId }
            : { ...leaf, tabIds: [...leaf.tabIds, nextId], activeTabId: nextId },
        ),
      );
      return;
    }
    if (activeNote && activeNote.id !== activeNoteId) {
      setActiveNoteId(activeNote.id);
    }
  }, [activeNote, activeNoteId, notebookNotes, updateLeaf]);

  const updateActiveNote = useCallback(
    (patch: Partial<OperationNote>) => {
      if (!activeNote) return;
      setNotes((current) =>
        current.map((note) =>
          note.id === activeNote.id
            ? {
                ...note,
                ...patch,
                updatedAt: nowTimestamp(),
              }
            : note,
        ),
      );
    },
    [activeNote],
  );

  const createNote = useCallback(
    (sourceKind: NoteSourceKind = "manual", overrideNotebookId?: string) => {
      // 仅文件夹右键菜单显式传入 overrideNotebookId 时落到对应文件夹；
      // 其他所有路径默认落到 vault 根目录。
      const notebookId = overrideNotebookId !== undefined ? overrideNotebookId : "";
      let nextNote: OperationNote;
      try {
        nextNote = createBlankNote(notebookId, sourceKind);
      } catch (error) {
        notifyError(error instanceof Error ? error.message : "新建笔记失败");
        return;
      }
      setNotes((current) => [nextNote, ...current]);
      setActiveNoteId(nextNote.id);
      setWorkspace((prev) => {
        const leafId = prev.activeLeafId;
        return updateLeaf(prev, leafId, (leaf) => {
          const activeIdx = leaf.activeTabId ? leaf.tabIds.indexOf(leaf.activeTabId) : -1;
          if (activeIdx >= 0) {
            const nextTabIds = [...leaf.tabIds];
            nextTabIds[activeIdx] = nextNote.id;
            return { ...leaf, tabIds: nextTabIds, activeTabId: nextNote.id, graphOpen: false };
          }
          return {
            ...leaf,
            tabIds: [...leaf.tabIds, nextNote.id],
            activeTabId: nextNote.id,
            graphOpen: false,
          };
        });
      });
      setSearchQuery("");
    },
    [updateLeaf],
  );

  useEffect(() => {
    if (!createOnOpen || !storageReady) return;
    setActiveNotebookId("");
    createNote("manual", "");
    onCreateOnOpenHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createOnOpen, storageReady]);

  const createNoteFromTemplateAction = useCallback(
    (templateId: string, title: string) => {
      const template = notes.find((n) => n.id === templateId);
      if (!template) return;
      // 模板创建仅从顶部工具栏触发，统一落到 vault 根目录。
      const notebookId = "";
      const notebookName = "";
      let nextNote: OperationNote;
      try {
        nextNote = createNoteFromTemplate(template, notebookId, title, notebookName);
      } catch (error) {
        notifyError(error instanceof Error ? error.message : "从模板创建失败");
        return;
      }
      setNotes((current) => [nextNote, ...current]);
      setActiveNoteId(nextNote.id);
      setWorkspace((prev) => {
        const leafId = prev.activeLeafId;
        return updateLeaf(prev, leafId, (leaf) => ({
          ...leaf,
          tabIds: [...leaf.tabIds, nextNote.id],
          activeTabId: nextNote.id,
          graphOpen: false,
        }));
      });
      setSearchQuery("");
    },
    [notes, updateLeaf],
  );

  const toggleNoteTemplate = useCallback(
    (note: OperationNote) => {
      setNotes((current) =>
        current.map((n) =>
          n.id === note.id
            ? { ...n, type: n.type === "template" ? "note" : "template", updatedAt: nowTimestamp() }
            : n,
        ),
      );
    },
    [],
  );

  const moveSelectionToNote = useCallback(
    (selectedText: string) => {
      // 编辑器选区创建笔记，统一落到 vault 根目录。
      const notebookId = "";
      const title = selectedText.trim().split("\n")[0].slice(0, 40) || "从选区创建的笔记";
      const nextNote: OperationNote = {
        ...createBlankNote(notebookId, "manual"),
        title,
        contentMarkdown: selectedText,
        preview: selectedText.slice(0, 120),
      };
      setNotes((current) => [nextNote, ...current]);
      setActiveNoteId(nextNote.id);
    },
    [],
  );

  const createNotebook = useCallback(() => {
    setPromptState({ kind: "createNotebook" });
  }, []);

  const handleCreateNotebook = useCallback((name: string) => {
    let nextNotebook: Notebook;
    try {
      nextNotebook = createCustomNotebook(name);
    } catch (error) {
        notifyError(error instanceof Error ? error.message : "新建笔记本失败");
      return;
    }
    setNotebooks((current) => [...current, nextNotebook]);
    setActiveNotebookId(nextNotebook.id);
    setActiveNoteId(null);
    setSearchQuery("");
  }, []);

  const renameNotebook = useCallback((notebookId: string) => {
    if (notebookId === "") return;
    setPromptState({ kind: "renameNotebook", notebookId });
  }, []);

  const handleRenameNotebook = useCallback((notebookId: string, name: string) => {
    const target = notebooks.find((n) => n.id === notebookId);
    if (!target || name === target.name) return;
    // Rust scan_vault 用文件夹名作为 notebook id，重命名时必须同步更新 id
    // 和所有相关 note 的 notebookId，否则保存后会导致 notebook_id 不匹配。
    setNotebooks((current) =>
      current.map((notebook) =>
        notebook.id === notebookId ? { ...notebook, id: name, name } : notebook,
      ),
    );
    setNotes((current) =>
      current.map((note) =>
        note.notebookId === notebookId ? { ...note, notebookId: name } : note,
      ),
    );
    if (activeNotebookId === notebookId) {
      setActiveNotebookId(name);
    }
  }, [notebooks, activeNotebookId]);

  const deleteNotebook = useCallback((notebookId: string) => {
    if (notebookId === "") {
      notifyError("仓库根目录不允许删除");
      return;
    }
    setConfirmState({ kind: "deleteNotebook", notebookId });
  }, []);

  const handleDeleteNotebook = useCallback((notebookId: string) => {
    const target = notebooks.find((n) => n.id === notebookId);
    if (!target) return;
    const nextNotebooks = notebooks.filter((notebook) => notebook.id !== notebookId);
    setNotebooks(nextNotebooks);
    setNotes((current) => current.filter((note) => note.notebookId !== notebookId));
    // Fall back to root scope ("") when no notebooks remain; otherwise pick the first.
    const nextNotebookId = nextNotebooks[0]?.id ?? "";
    const nextActiveNote = notes.find((note) => note.notebookId === nextNotebookId) ?? null;
    setActiveNotebookId(nextNotebookId);
    setActiveNoteId(nextActiveNote?.id ?? null);
    setSearchQuery("");
    setExpandedNotebookIds((current) => {
      const next = new Set(current);
      next.delete(notebookId);
      return next;
    });
  }, [notebooks, notes]);

  const toggleNotebookExpanded = useCallback((notebookId: string) => {
    setExpandedNotebookIds((current) => {
      const next = new Set(current);
      if (next.has(notebookId)) {
        next.delete(notebookId);
      } else {
        next.add(notebookId);
      }
      return next;
    });
  }, []);

  const allNotebooksExpanded = useMemo(
    () => notebooks.length > 0 && notebooks.every((nb) => expandedNotebookIds.has(nb.id)),
    [notebooks, expandedNotebookIds],
  );

  const toggleExpandAll = useCallback(() => {
    if (allNotebooksExpanded) {
      setExpandedNotebookIds(new Set());
    } else {
      setExpandedNotebookIds(new Set(notebooks.map((nb) => nb.id)));
    }
  }, [allNotebooksExpanded, notebooks]);

  const openOrCreateVault = useCallback(async () => {
    setVaultBusy(true);
    try {
      const picked = await pickNotesVaultDirectory();
      if (!picked) return;
      await setNotesVaultPath(picked);
      setVaultPath(picked);
      const nextState = await loadNotesState();
      setNotebooks(nextState.notebooks);
      setNotes(nextState.notes);
      setTransformations(nextState.transformations ?? []);
      setActiveNotebookId(nextState.activeNotebookId);
      setActiveNoteId(nextState.activeNoteId);
      const noteIds = new Set(nextState.notes.map((n) => n.id));
      const restoredWorkspace = sanitizeWorkspaceState(nextState.workspace, noteIds, nextState.activeNoteId);
      setWorkspace(restoredWorkspace);
      setRightSidebarOpen(nextState.rightSidebarOpen ?? true);
      setRightSidebarWidth(clampRightSidebarWidth(nextState.rightSidebarWidth));
      setRightActiveTab(sanitizeRightActiveTab(nextState.rightActiveTab));
      lastSavedSnapshotRef.current = serializeNotesState({
        ...nextState,
        workspace: restoredWorkspace,
        rightSidebarOpen: nextState.rightSidebarOpen ?? true,
        rightSidebarWidth: clampRightSidebarWidth(nextState.rightSidebarWidth),
        rightActiveTab: sanitizeRightActiveTab(nextState.rightActiveTab),
      });
      latestSnapshotRef.current = lastSavedSnapshotRef.current;
      setStorageError(null);
      setSaveStatus("saved");
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "打开仓库失败");
    } finally {
      setVaultBusy(false);
    }
  }, []);

  const exportActiveNote = useCallback(async () => {
    if (!activeNote) return;
    try {
      await saveMarkdownFile(activeNote.title, activeNote.contentMarkdown);
    } catch {
      notifyError("导出失败");
    }
  }, [activeNote]);

  const exportActiveNotePdf = useCallback(() => {
    if (!activeNote) return;
    const printable = `<html><head><meta charset="utf-8"><title>${activeNote.title}</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}h1,h2,h3{line-height:1.3}pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto}code{font-family:monospace}blockquote{border-left:3px solid #ccc;margin:0;padding-left:16px;color:#666}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}img{max-width:100%}</style></head><body>${activeNote.contentMarkdown}</body></html>`;
    const existing = document.getElementById("__pdf_print_frame__");
    if (existing) existing.remove();
    const iframe = document.createElement("iframe");
    iframe.id = "__pdf_print_frame__";
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(printable);
    doc.close();
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch (e) {
        console.error("print failed", e);
      }
    };
  }, [activeNote]);

  const mergeNoteInto = useCallback(
    (sourceNote: OperationNote, targetNoteId: string) => {
      const target = notes.find((n) => n.id === targetNoteId);
      if (!target || target.id === sourceNote.id) return;
      const mergedContent = `${target.contentMarkdown}\n\n---\n\n${sourceNote.contentMarkdown}`;
      setNotes((current) =>
        current.map((n) =>
          n.id === target.id
            ? { ...n, contentMarkdown: mergedContent, preview: mergedContent.slice(0, 46), updatedAt: nowTimestamp() }
            : n,
        ),
      );
      setNotes((current) => current.filter((n) => n.id !== sourceNote.id));
      setWorkspace((prev) => ({
        ...prev,
        root: mapNode(prev.root, (node) => {
          if (node.type !== "leaf") return node;
          const tabIds = node.tabIds.filter((id) => id !== sourceNote.id);
          const activeTabId = node.activeTabId === sourceNote.id
            ? (tabIds[0] ?? null)
            : node.activeTabId;
          return { ...node, tabIds, activeTabId };
        }),
      }));
      setActiveNoteId(target.id);
      setWorkspace((prev) =>
        updateLeaf(prev, prev.activeLeafId, (leaf) =>
          leaf.tabIds.includes(target.id)
            ? { ...leaf, activeTabId: target.id, graphOpen: false }
            : { ...leaf, tabIds: [...leaf.tabIds, target.id], activeTabId: target.id, graphOpen: false },
        ),
      );
    },
    [notes],
  );

  const copyNoteMarkdown = useCallback(async (note: OperationNote) => {
    try {
      await navigator.clipboard.writeText(note.contentMarkdown);
    } catch {
      notifyError("复制失败");
    }
  }, []);

  const copyNotePath = useCallback(async (note: OperationNote) => {
    const notebook = notebooks.find((nb) => nb.id === note.notebookId);
    const path = notebook ? `${notebook.name}/${note.title || "未命名笔记"}` : note.title || "未命名笔记";
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      notifyError("复制失败");
    }
  }, [notebooks]);

  const duplicateNote = useCallback((note: OperationNote) => {
    let nextNoteId: string;
    try {
      nextNoteId = createNoteId();
    } catch (error) {
      notifyError(error instanceof Error ? error.message : "复制笔记失败");
      return;
    }

    const nextNote: OperationNote = {
      ...note,
      id: nextNoteId,
      title: `${note.title || "未命名笔记"} 副本`,
      updatedAt: nowTimestamp(),
      agentChatId: undefined,
      appliedAgentMessageIds: [],
    };
    setNotes((current) => [nextNote, ...current]);
    setActiveNoteId(nextNote.id);
    setSearchQuery("");
  }, []);

  const editNoteTags = useCallback((note: OperationNote, tags: string[]) => {
    setNotes((current) =>
      current.map((n) =>
        n.id === note.id ? { ...n, tags, updatedAt: "刚刚" } : n,
      ),
    );
  }, []);

  const renameNote = useCallback((note: OperationNote) => {
    setPromptState({ kind: "renameNote", noteId: note.id });
  }, []);

  const moveNote = useCallback(
    (note: OperationNote, targetNotebookId: string) => {
      if (targetNotebookId === note.notebookId) return;
      // Empty notebookId = vault root, which is always a valid target.
      if (targetNotebookId !== "") {
        const targetNotebook = notebooks.find((notebook) => notebook.id === targetNotebookId);
        if (!targetNotebook) return;
      }

      setNotes((current) =>
        current.map((n) =>
          n.id === note.id
            ? { ...n, notebookId: targetNotebookId, updatedAt: "刚刚" }
            : n,
        ),
      );
      setActiveNotebookId(targetNotebookId);
      setActiveNoteId(note.id);
      setSearchQuery("");
    },
    [notebooks],
  );

  const toggleFavorite = useCallback(
    (note: OperationNote) => {
      setNotes((current) =>
        current.map((n) =>
          n.id === note.id ? { ...n, favorite: !n.favorite } : n,
        ),
      );
    },
    [],
  );

  const toggleTaskInNote = useCallback(
    (noteId: string, line: number) => {
      setNotes((current) =>
        current.map((n) => {
          if (n.id !== noteId) return n;
          const nextMd = toggleTaskInMarkdown(n.contentMarkdown, noteId, line);
          return {
            ...n,
            contentMarkdown: nextMd,
            updatedAt: nowTimestamp(),
          };
        }),
      );
    },
    [],
  );

  const openNoteInNewWindow = useCallback(async (note: OperationNote) => {
    if (!isTauri()) {
      notifyError("仅桌面端支持新窗口打开");
      return;
    }
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const label = `note-${note.id}`;
      const url = new URL(window.location.href);
      url.searchParams.set("noteId", note.id);
      const webview = new WebviewWindow(label, {
        url: url.toString(),
        title: note.title || "未命名笔记",
        width: 1100,
        height: 720,
        minWidth: 640,
        minHeight: 420,
      });
      webview.once("tauri://error", (event) => {
        console.error("[note-window] failed to create:", event);
        notifyError("无法创建新窗口");
      });
    } catch (err) {
      console.error("[note-window] error:", err);
      notifyError("无法创建新窗口");
    }
  }, []);

  const computeNoteFilePath = useCallback(
    async (note: OperationNote): Promise<string | null> => {
      if (!vaultPath) return null;
      const safeTitle = note.title
        .replace(/[\\/:*?"<>|]/g, "")
        .trim()
        .slice(0, 80) || "untitled";
      const fileName = `${safeTitle}.md`;
      const { join } = await import("@tauri-apps/api/path");
      const notebook = notebooks.find((nb) => nb.id === note.notebookId);
      if (notebook) {
        return join(vaultPath, notebook.name, fileName);
      }
      return join(vaultPath, fileName);
    },
    [vaultPath, notebooks],
  );

  const openNoteWithDefaultApp = useCallback(
    async (note: OperationNote) => {
      const path = await computeNoteFilePath(note);
      if (!path) {
        notifyError("未找到笔记仓库路径");
        return;
      }
      void openPathWithSystemApp(path);
    },
    [computeNoteFilePath],
  );

  const revealNoteInExplorer = useCallback(
    async (note: OperationNote) => {
      const path = await computeNoteFilePath(note);
      if (!path) {
        notifyError("未找到笔记仓库路径");
        return;
      }
      void revealItemInDir(path);
    },
    [computeNoteFilePath],
  );

  const showNoteInFileList = useCallback(
    (note: OperationNote) => {
      if (note.notebookId) {
        setActiveNotebookId(note.notebookId);
        setExpandedNotebookIds((prev) => {
          const next = new Set(prev);
          next.add(note.notebookId);
          return next;
        });
      }
      if (searchQuery) setSearchQuery("");
      window.setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`[data-note-id="${note.id}"]`);
        el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }, 60);
    },
    [searchQuery],
  );

  const findInNote = useCallback((_note: OperationNote) => {
    openActiveEditorFind();
  }, []);

  const replaceInNote = useCallback((_note: OperationNote) => {
    openActiveEditorReplace();
  }, []);

  const tabMenuCallbacks = useMemo(
    () => ({
      onOpenInNewWindow: openNoteInNewWindow,
      onRename: renameNote,
      onMoveToNotebook: moveNote,
      onToggleFavorite: toggleFavorite,
      onMergeNote: mergeNoteInto,
      onFind: findInNote,
      onReplace: replaceInNote,
      onOpenWithDefaultApp: openNoteWithDefaultApp,
      onRevealInExplorer: revealNoteInExplorer,
      onShowInFileList: showNoteInFileList,
    }),
    [
      openNoteInNewWindow,
      renameNote,
      moveNote,
      toggleFavorite,
      mergeNoteInto,
      findInNote,
      replaceInNote,
      openNoteWithDefaultApp,
      revealNoteInExplorer,
      showNoteInFileList,
    ],
  );

  const dropNoteById = useCallback(
    (noteId: string, targetNotebookId: string) => {
      const note = notes.find((n) => n.id === noteId);
      if (note) moveNote(note, targetNotebookId);
    },
    [notes, moveNote],
  );

  // Drag over any blank area in the sidebar (between notebooks, below the list,
  // etc.) moves the note to the vault root.
  const sidebarDragCounterRef = useRef(0);
  const handleSidebarDragEnter = (e: React.DragEvent<HTMLElement>) => {
    if (!e.dataTransfer.types.includes("application/x-note-id")) return;
    sidebarDragCounterRef.current += 1;
  };
  const handleSidebarDragOver = (e: React.DragEvent<HTMLElement>) => {
    if (e.dataTransfer.types.includes("application/x-note-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };
  const handleSidebarDragLeave = () => {
    sidebarDragCounterRef.current = Math.max(0, sidebarDragCounterRef.current - 1);
  };
  const handleSidebarDrop = (e: React.DragEvent<HTMLElement>) => {
    const noteId = e.dataTransfer.getData("application/x-note-id") || e.dataTransfer.getData("text/plain");
    e.preventDefault();
    sidebarDragCounterRef.current = 0;
    if (noteId) dropNoteById(noteId, "");
  };

  const deleteNote = useCallback(
    (note: OperationNote) => {
      setConfirmState({ kind: "deleteNote", noteId: note.id });
    },
    [],
  );

  const handleDeleteManyNotes = useCallback(
    (noteIds: string[]) => {
      const idSet = new Set(noteIds);
      setNotes((current) => current.filter((n) => !idSet.has(n.id)));
      setSelectedNoteIds(new Set());
      setWorkspace((prev) => ({
        ...prev,
        root: mapNode(prev.root, (node) => {
          if (node.type !== "leaf") return node;
          const tabIds = node.tabIds.filter((id) => !idSet.has(id));
          const activeTabId = node.activeTabId && idSet.has(node.activeTabId)
            ? (tabIds[0] ?? null)
            : node.activeTabId;
          return { ...node, tabIds, activeTabId };
        }),
      }));
      if (activeNoteId && idSet.has(activeNoteId)) {
        const remaining = notes.filter((n) => !idSet.has(n.id));
        const nextActive = remaining[0]?.id ?? null;
        setActiveNoteId(nextActive);
        if (nextActive) {
          setWorkspace((prev) =>
            updateLeaf(prev, prev.activeLeafId, (leaf) =>
              leaf.tabIds.includes(nextActive)
                ? { ...leaf, activeTabId: nextActive }
                : { ...leaf, tabIds: [...leaf.tabIds, nextActive], activeTabId: nextActive },
            ),
          );
        }
      }
    },
    [activeNoteId, notes, updateLeaf],
  );

  const handleDeleteNote = useCallback(
    (noteId: string) => {
      const note = notes.find((n) => n.id === noteId);
      if (!note) return;
      const noteNotebookId = note.notebookId;
      const remainingNotes = notes.filter(
        (n) => n.notebookId === noteNotebookId && n.id !== noteId,
      );
      setNotes((current) => current.filter((n) => n.id !== noteId));
      setWorkspace((prev) => ({
        ...prev,
        root: mapNode(prev.root, (node) => {
          if (node.type !== "leaf") return node;
          const tabIds = node.tabIds.filter((id) => id !== noteId);
          const activeTabId = node.activeTabId === noteId
            ? (tabIds[0] ?? null)
            : node.activeTabId;
          return { ...node, tabIds, activeTabId };
        }),
      }));
      if (activeNoteId === noteId) {
        const nextActive = remainingNotes[0]?.id ?? null;
        setActiveNoteId(nextActive);
        if (nextActive) {
          setWorkspace((prev) =>
            updateLeaf(prev, prev.activeLeafId, (leaf) =>
              leaf.tabIds.includes(nextActive)
                ? { ...leaf, activeTabId: nextActive }
                : { ...leaf, tabIds: [...leaf.tabIds, nextActive], activeTabId: nextActive },
            ),
          );
        }
      }
    },
    [activeNoteId, notes, updateLeaf],
  );

  const applyAiResult = useCallback(
    (mode: "append" | "replace", markdown: string, messageId: string) => {
      if (!activeNote) return;
      const nextMarkdown =
        mode === "replace"
          ? markdown
          : `${activeNote.contentMarkdown.trimEnd()}\n\n${markdown.trim()}\n`;
      const appliedAgentMessageIds = Array.from(
        new Set([...(activeNote.appliedAgentMessageIds ?? []), messageId]),
      );

      updateActiveNote({
        contentMarkdown: nextMarkdown,
        preview: deriveNotePreview(nextMarkdown),
        appliedAgentMessageIds,
      });
    },
    [activeNote, updateActiveNote],
  );

  const saveAgentResultAsNote = useCallback(
    (markdown: string, title: string) => {
      // NoteAgentPanel 存为笔记，统一落到 vault 根目录。
      let nextNote: OperationNote;
      try {
        nextNote = createBlankNote("", "agent");
      } catch (error) {
        notifyError(error instanceof Error ? error.message : "新建笔记失败");
        return;
      }
      const trimmedMarkdown = markdown.trim();
      const previewText = trimmedMarkdown.replace(/[#*`_~>\-]/g, "").replace(/\s+/g, " ").trim();
      nextNote = {
        ...nextNote,
        title,
        contentMarkdown: trimmedMarkdown,
        preview: previewText.slice(0, 46) || "AI 生成笔记",
        source: { kind: "agent", label: "AI 助手" },
        tags: ["AI生成"],
      };
      setNotes((current) => [nextNote, ...current]);
      setActiveNoteId(nextNote.id);
      setSearchQuery("");
    },
    [],
  );

  const handleDragStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      dragRef.current = { startX: event.clientX, startWidth: agentPanelWidth };
      const handleMove = (e: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = dragRef.current.startX - e.clientX;
        const next = Math.min(
          AGENT_PANEL_MAX_WIDTH,
          Math.max(AGENT_PANEL_MIN_WIDTH, dragRef.current.startWidth + delta),
        );
        setAgentPanelWidth(next);
      };
      const handleUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
      };
      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
    },
    [agentPanelWidth],
  );

  const handleRightDragStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      rightDragRef.current = { startX: event.clientX, startWidth: rightSidebarWidth };
      const handleMove = (e: MouseEvent) => {
        if (!rightDragRef.current) return;
        const delta = e.clientX - rightDragRef.current.startX;
        const next = Math.min(
          RIGHT_SIDEBAR_MAX_WIDTH,
          Math.max(RIGHT_SIDEBAR_MIN_WIDTH, rightDragRef.current.startWidth + delta),
        );
        setRightSidebarWidth(next);
      };
      const handleUp = () => {
        rightDragRef.current = null;
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
      };
      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
    },
    [rightSidebarWidth],
  );

  // Prompt dialog computed values
  const promptTitle = useMemo(() => {
    if (!promptState) return "";
    switch (promptState.kind) {
      case "createNotebook": return "笔记本名称";
      case "renameNotebook": return "笔记本名称";
      case "renameNote": return "重命名笔记";
    }
  }, [promptState]);

  const promptDefaultValue = useMemo(() => {
    if (!promptState) return "";
    switch (promptState.kind) {
      case "createNotebook": return "新的笔记本";
      case "renameNotebook": {
        const notebook = notebooks.find((n) => n.id === promptState.notebookId);
        return notebook?.name ?? "";
      }
      case "renameNote": {
        const note = notes.find((n) => n.id === promptState.noteId);
        return note?.title ?? "";
      }
    }
  }, [promptState, notebooks, notes]);

  const promptPlaceholder = useMemo(() => {
    if (!promptState) return "";
    switch (promptState.kind) {
      case "createNotebook": return "输入笔记本名称";
      case "renameNotebook": return "输入新名称";
      case "renameNote": return "输入笔记标题";
    }
  }, [promptState]);

  const handlePromptConfirm = useCallback((value: string) => {
    if (!promptState) return;
    switch (promptState.kind) {
      case "createNotebook": handleCreateNotebook(value); break;
      case "renameNotebook": handleRenameNotebook(promptState.notebookId, value); break;
      case "renameNote": {
        const note = notes.find((n) => n.id === promptState.noteId);
        if (note && value.trim() && value.trim() !== note.title) {
          const oldTitle = note.title;
          const newTitle = value.trim();
          setNotes((current) =>
            current.map((n) =>
              n.id === note.id ? { ...n, title: newTitle, updatedAt: nowTimestamp() } : n,
            ),
          );
          // Sync [[wiki links]] across the vault (fire-and-forget).
          renameSyncWikiLinks(oldTitle, newTitle)
            .then((result) => {
              if (result.updatedLinks > 0) {
              }
            })
            .catch((err: unknown) => {
              console.warn("rename sync failed:", err);
            });
        }
        break;
      }
    }
    setPromptState(null);
  }, [promptState, handleCreateNotebook, handleRenameNotebook, notes]);

  // Confirm dialog computed values
  const confirmTitle = useMemo(() => {
    if (!confirmState) return "";
    switch (confirmState.kind) {
      case "deleteNotebook": {
        const notebook = notebooks.find((n) => n.id === confirmState.notebookId);
        return `删除「${notebook?.name ?? ""}」？`;
      }
      case "deleteNote": {
        const note = notes.find((n) => n.id === confirmState.noteId);
        return `删除「${note?.title || "未命名笔记"}」？`;
      }
      case "deleteNotes": return `删除选中的 ${confirmState.noteIds.length} 条笔记？`;
    }
  }, [confirmState, notebooks, notes]);

  const confirmMessage = useMemo(() => {
    if (!confirmState) return "";
    switch (confirmState.kind) {
      case "deleteNotebook": {
        const noteCount = notes.filter((n) => n.notebookId === confirmState.notebookId).length;
        return `这会同时删除里面的 ${noteCount} 条笔记。`;
      }
      case "deleteNote": return "删除后无法恢复。";
      case "deleteNotes": return "删除后无法恢复。";
    }
  }, [confirmState, notes]);

  const handleConfirmAction = useCallback(() => {
    if (!confirmState) return;
    switch (confirmState.kind) {
      case "deleteNotebook": handleDeleteNotebook(confirmState.notebookId); break;
      case "deleteNote": handleDeleteNote(confirmState.noteId); break;
      case "deleteNotes": handleDeleteManyNotes(confirmState.noteIds); break;
    }
    setConfirmState(null);
  }, [confirmState, handleDeleteNotebook, handleDeleteNote, handleDeleteManyNotes]);

  return (
    <div className="relative flex h-full min-h-0 bg-background">
      <section className="flex min-w-0 flex-1 flex-col">

        <div className="flex min-h-0 flex-1">
          {storageError ? (
            <div className="flex flex-1 items-center justify-center px-8 text-center text-[13px] text-destructive">
              {storageError}
            </div>
          ) : !storageReady ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              正在加载笔记...
            </div>
          ) : !vaultPath ? (
            <VaultBootstrap
              busy={vaultBusy}
              onOpenOrCreate={openOrCreateVault}
            />
          ) : (
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1">
              <aside
                className="relative hidden w-[260px] shrink-0 flex-col border-r border-border/70 bg-sidebar/35 md:flex"
                onDragEnter={handleSidebarDragEnter}
                onDragOver={handleSidebarDragOver}
                onDragLeave={handleSidebarDragLeave}
                onDrop={handleSidebarDrop}
              >
                {moduleView === "notes" ? (
                <>
                <div className="flex h-9 shrink-0 items-center justify-center gap-0.5 px-2">
                  <IconButton label="新建笔记" onClick={() => createNote("manual", "")}>
                    <Plus className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label="从模板创建"
                    disabled={templateNotes.length === 0}
                    onClick={() => setTemplatePickerOpen(true)}
                  >
                    <FileText className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton label="新建文件夹" onClick={createNotebook}>
                    <FolderPlus className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton label="全局搜索 (Ctrl+K)" onClick={() => { setGlobalSearchInitialQuery(""); setGlobalSearchOpen(true); }}>
                    <Search className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={viewMode === "favorite" ? "显示全部笔记" : "显示收藏笔记"}
                    onClick={() => setViewMode((m) => (m === "favorite" ? "all" : "favorite"))}
                  >
                    <Star
                      className={cn(
                        "h-3.5 w-3.5",
                        viewMode === "favorite" && "fill-current text-amber-500",
                      )}
                    />
                  </IconButton>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        title="排序"
                        className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <ArrowDownUp className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-48">
                      <DropdownMenuRadioGroup
                        value={sortMode}
                        onValueChange={(v) => setSortMode(v as SortMode)}
                      >
                        <DropdownMenuRadioItem value="title-asc">文件名 (A-Z)</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="title-desc">文件名 (Z-A)</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup
                        value={sortMode}
                        onValueChange={(v) => setSortMode(v as SortMode)}
                      >
                        <DropdownMenuRadioItem value="updated-desc">编辑时间（从新到旧）</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="updated-asc">编辑时间（从旧到新）</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup
                        value={sortMode}
                        onValueChange={(v) => setSortMode(v as SortMode)}
                      >
                        <DropdownMenuRadioItem value="created-desc">创建时间（从新到旧）</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="created-asc">创建时间（从旧到新）</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <IconButton
                    label="定位当前笔记"
                    onClick={() => {
                      if (!activeNoteId) return;
                      const target = notes.find((n) => n.id === activeNoteId);
                      if (!target) return;
                      setExpandedNotebookIds((prev) => {
                        const next = new Set(prev);
                        if (target.notebookId) next.add(target.notebookId);
                        return next;
                      });
                      if (searchQuery) setSearchQuery("");
                      window.setTimeout(() => {
                        const el = document.querySelector<HTMLElement>(
                          `[data-note-id="${activeNoteId}"]`,
                        );
                        el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
                      }, 60);
                    }}
                  >
                    <Crosshair className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton
                    label={allNotebooksExpanded ? "全部折叠" : "全部展开"}
                    onClick={toggleExpandAll}
                  >
                    {allNotebooksExpanded ? (
                      <ChevronsDownUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    )}
                  </IconButton>
                </div>
                <div className="flex h-8 shrink-0 items-center gap-1 px-3 pb-1">
                  <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="搜索笔记"
                    className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground"
                  />
                  {searchQuery ? (
                    <button
                      type="button"
                      aria-label="清空搜索"
                      title="清空搜索"
                      onClick={() => setSearchQuery("")}
                      className="grid h-5 w-5 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div
                      className="min-h-0 flex-1 overflow-y-auto py-1 scrollbar-thin"
                      onDragOver={(e) => {
                        if (e.dataTransfer.types.includes("application/x-note-id")) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }
                      }}
                    >
                      {viewMode === "favorite" ? (
                        <FavoriteNotesList
                          notes={filterNotesByKeyword(
                            notes.filter((n) => n.favorite),
                            searchQuery,
                          )}
                          activeNoteId={activeNoteId}
                          selectedIds={selectedNoteIds}
                          searchQuery={searchQuery}
                          sortMode={sortMode}
                          onSortChange={setSortMode}
                          onSelectNote={selectNote}
                          onOpenInNewTab={openInNewTab}
                          onSelectionChange={setSelectedNoteIds}
                          onCopyMarkdown={copyNoteMarkdown}
                          onCopyPath={copyNotePath}
                          onRevealInExplorer={revealNoteInExplorer}
                          onDuplicate={duplicateNote}
                          onEditTags={editNoteTags}
                          onRename={renameNote}
                          onMoveToNotebook={moveNote}
                          onMergeNote={mergeNoteInto}
                          onDelete={deleteNote}
                          onDeleteMany={deleteManyNotes}
                          onSetContextLevel={(note, level) => {
                            setNotes((current) =>
                              current.map((n) =>
                                n.id === note.id ? { ...n, contextLevel: level, updatedAt: nowTimestamp() } : n,
                              ),
                            );
                          }}
                          onToggleFavorite={toggleFavorite}
                          onCreateNote={createNote}
                          notebooks={notebooks}
                          allNotes={notes}
                        />
                      ) : (
                      <>
                      {notebooks.length === 0 && notes.length === 0 ? (
                        <div className="flex h-full items-center justify-center px-6 py-4 text-center text-[12px] leading-5 text-muted-foreground">
                          仓库为空，右键新建文件夹或笔记
                        </div>
                      ) : null}
                      {notebooks.map((notebook) => {
                        const isActive = notebook.id === activeNotebookId;
                        const isExpanded = expandedNotebookIds.has(notebook.id) || Boolean(searchQuery);
                        const notebookNotesAll = notes.filter((n) => n.notebookId === notebook.id);
                        const filteredNotes = filterNotesByKeyword(notebookNotesAll, searchQuery);
                        return (
                          <NotebookSection
                            key={notebook.id}
                            notebook={notebook}
                            isExpanded={isExpanded}
                            notes={filteredNotes}
                            totalCount={notebookNotesAll.length}
                            activeNoteId={activeNoteId}
                            selectedIds={isActive ? selectedNoteIds : undefined}
                            searchQuery={searchQuery}
                            sortMode={sortMode}
                            onSortChange={setSortMode}
                            onToggle={() => {
                              toggleNotebookExpanded(notebook.id);
                            }}
                            onSelectNote={selectNote}
                            onOpenInNewTab={openInNewTab}
                            onSelectionChange={setSelectedNoteIds}
                            onCopyMarkdown={copyNoteMarkdown}
                            onCopyPath={copyNotePath}
                            onRevealInExplorer={revealNoteInExplorer}
                            onDuplicate={duplicateNote}
                            onEditTags={editNoteTags}
                            onRename={renameNote}
                            onMoveToNotebook={moveNote}
                            onMergeNote={mergeNoteInto}
                            onDelete={deleteNote}
                            onDeleteMany={deleteManyNotes}
                            onSetContextLevel={(note, level) => {
                              setNotes((current) =>
                                current.map((n) =>
                                  n.id === note.id ? { ...n, contextLevel: level, updatedAt: nowTimestamp() } : n,
                                ),
                              );
                            }}
                            onToggleFavorite={toggleFavorite}
                            onCreateNote={createNote}
                            onCreateNotebook={createNotebook}
                            notebooks={notebooks}
                            allNotes={notes}
                            onDropNote={dropNoteById}
                            onRenameNotebook={renameNotebook}
                            onDeleteNotebook={deleteNotebook}
                          />
                        );
                      })}
                      <RootNotesList
                        notes={filterNotesByKeyword(
                          notes.filter((n) => n.notebookId === ""),
                          searchQuery,
                        )}
                        totalCount={notes.filter((n) => n.notebookId === "").length}
                        activeNoteId={activeNoteId}
                        selectedIds={activeNotebookId === "" ? selectedNoteIds : undefined}
                        searchQuery={searchQuery}
                        sortMode={sortMode}
                        onSortChange={setSortMode}
                        onSelectNote={selectNote}
                        onOpenInNewTab={openInNewTab}
                        onSelectionChange={setSelectedNoteIds}
                        onCopyMarkdown={copyNoteMarkdown}
                        onCopyPath={copyNotePath}
                        onRevealInExplorer={revealNoteInExplorer}
                        onDuplicate={duplicateNote}
                        onEditTags={editNoteTags}
                        onRename={renameNote}
                        onMoveToNotebook={moveNote}
                        onMergeNote={mergeNoteInto}
                        onDelete={deleteNote}
                        onDeleteMany={deleteManyNotes}
                        onSetContextLevel={(note, level) => {
                          setNotes((current) =>
                            current.map((n) =>
                              n.id === note.id ? { ...n, contextLevel: level, updatedAt: nowTimestamp() } : n,
                            ),
                          );
                        }}
                        onToggleFavorite={toggleFavorite}
                        onCreateNote={createNote}
                        notebooks={notebooks}
                        allNotes={notes}
                      />
                      </>
                      )}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onSelect={() => createNote("manual", "")}>
                      <FileText className="mr-2 h-3.5 w-3.5" />
                      新建笔记
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={createNotebook}>
                      <FolderPlus className="mr-2 h-3.5 w-3.5" />
                      新建文件夹
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
                </>
                ) : (
                  <MaterialsSidebar
                    selection={materialsSelection}
                    onSelect={setMaterialsSelection}
                  />
                )}
                <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border/55 px-2">
                  <div className="flex items-center rounded-lg bg-muted/50 p-0.5">
                    <button
                      type="button"
                      onClick={() => setModuleView("notes")}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                        moduleView === "notes"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      笔记
                    </button>
                    <button
                      type="button"
                      onClick={() => setModuleView("materials")}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                        moduleView === "materials"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      资料
                    </button>
                  </div>
                  <button
                    type="button"
                    title={`切换仓库${vaultPath ? `: ${vaultPath.split(/[\\/]/).pop()}` : ""}`}
                    onClick={openOrCreateVault}
                    className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </button>
                </div>
              </aside>
              {moduleView === "notes" && tasksPanelOpen ? (
                <div className="absolute left-[260px] top-0 bottom-0 z-30 w-[300px] border-r border-border/70 bg-background shadow-lg">
                  <TasksPanel
                    notes={notes}
                    notebookNameById={notebookNameById}
                    onToggleTask={toggleTaskInNote}
                    onNavigateToNote={(noteId) => {
                      selectNote(noteId);
                      setTasksPanelOpen(false);
                    }}
                    onClose={() => setTasksPanelOpen(false)}
                  />
                </div>
              ) : null}
              <div className="relative flex min-w-0 min-h-0 flex-1">
                {moduleView === "notes" ? <Workspace
                  workspace={workspace}
                  onChange={setWorkspace}
                  notes={notes}
                  notebooks={notebooks}
                  editorMode={editorMode}
                  noteTitles={noteTitles}
                  saveStatus={saveStatus}
                  tabMenuCallbacks={tabMenuCallbacks}
                  onTitleChange={(noteId, title) => {
                    setNotes((current) =>
                      current.map((n) =>
                        n.id === noteId ? { ...n, title, updatedAt: nowTimestamp() } : n,
                      ),
                    );
                  }}
                  onContentChange={(noteId, next) => {
                    setNotes((current) =>
                      current.map((n) =>
                        n.id === noteId
                          ? {
                              ...n,
                              contentMarkdown: next.contentMarkdown,
                              contentJson: next.contentJson,
                              plainText: next.plainText,
                              preview: next.plainText.slice(0, 46) || "空白笔记",
                              updatedAt: nowTimestamp(),
                            }
                          : n,
                      ),
                    );
                  }}
                  onMoveSelectionToNote={moveSelectionToNote}
                  onSelectNote={selectNoteInWorkspace}
                  onOpenNoteByTitle={openNoteByTitle}
                  toolbarTrailing={
                    <>
                      <button
                        type="button"
                        title={tasksPanelOpen ? "关闭任务面板" : "任务管理"}
                        aria-label="任务管理"
                        onClick={() => setTasksPanelOpen((v) => !v)}
                        className={cn(
                          "grid h-8 w-8 place-items-center hover:bg-accent hover:text-foreground",
                          tasksPanelOpen ? "bg-accent text-foreground" : "text-muted-foreground",
                        )}
                      >
                        <ListChecks className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title="关系图"
                        aria-label="关系图"
                        onClick={toggleGraphInActiveLeaf}
                        className={cn(
                          "grid h-8 w-8 place-items-center hover:bg-accent hover:text-foreground",
                          activeLeafGraphOpen ? "bg-accent text-foreground" : "text-muted-foreground",
                        )}
                      >
                        <GitFork className="h-4 w-4" />
                      </button>
                      {licenseActive ? (
                        <button
                          type="button"
                          title={agentPanelCollapsed ? "展开 Agent 联动" : "收起 Agent 联动"}
                          aria-label={agentPanelCollapsed ? "展开 Agent 联动" : "收起 Agent 联动"}
                          onClick={() => setAgentPanelCollapsed((current) => !current)}
                          className={cn(
                            "grid h-8 w-8 place-items-center hover:bg-accent hover:text-foreground",
                            !agentPanelCollapsed ? "bg-accent text-foreground" : "text-muted-foreground",
                          )}
                        >
                          <AgentLogo state={agentStreaming ? "working" : "idle"} className="h-5 w-5" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          title="升级 Pro 解锁笔记 AI"
                          aria-label="升级 Pro 解锁笔记 AI"
                          onClick={onOpenSubscribe}
                          className="grid h-8 w-8 place-items-center text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <LockKeyhole className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        title={rightSidebarOpen ? "收起右侧面板" : "展开右侧面板"}
                        aria-label={rightSidebarOpen ? "收起右侧面板" : "展开右侧面板"}
                        onClick={() => setRightSidebarOpen((v) => !v)}
                        className="grid h-8 w-8 place-items-center text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <RightSidebarToggleIcon open={rightSidebarOpen} className="h-4 w-4" />
                      </button>
                    </>
                  }
                  toolbarExtra={(noteId) => {
                    const note = notes.find((n) => n.id === noteId);
                    const isRecordingThis = recordingActive && recordingNoteRef.current === noteId;
                    return (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          title={
                            !speech.supported
                              ? "当前环境不支持语音识别（需 Edge / WebView2 内核）"
                              : isRecordingThis
                                ? "停止录音"
                                : "录音笔记"
                          }
                          aria-label="录音笔记"
                          disabled={!speech.supported || (recordingActive && !isRecordingThis)}
                          onClick={isRecordingThis ? stopRecording : startRecording}
                          className={cn(
                            "grid h-7 w-7 place-items-center rounded-md hover:bg-accent hover:text-foreground",
                            isRecordingThis
                              ? "bg-accent text-rose-500"
                              : recordingError
                                ? "text-amber-500"
                                : "text-muted-foreground",
                          )}
                        >
                          {isRecordingThis ? (
                            <MicOff className="h-4 w-4" />
                          ) : (
                            <Mic className="h-4 w-4" />
                          )}
                        </button>
                        <button
                          type="button"
                          title={editorMode === "visual" ? "切换为 MD 源码" : "切换为可视化编辑"}
                          aria-label={editorMode === "visual" ? "切换为 MD 源码" : "切换为可视化编辑"}
                          onClick={() => setEditorMode((mode) => (mode === "visual" ? "markdown" : "visual"))}
                          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          {editorMode === "visual" ? (
                            <FileCode2 className="h-4 w-4" />
                          ) : (
                            <Pencil className="h-4 w-4" />
                          )}
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              title="更多"
                              aria-label="更多"
                              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem
                              disabled={!note}
                              onClick={() => note && renameNote(note)}
                            >
                              <Pencil className="mr-2 h-3.5 w-3.5" />
                              重命名
                            </DropdownMenuItem>
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger
                                disabled={!note || notes.filter((n) => n.id !== note.id).length === 0}
                                className="text-[13px]"
                              >
                                <FolderInput className="mr-2 h-3.5 w-3.5" />
                                合并到其他笔记...
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="max-h-[300px] w-56 overflow-y-auto">
                                {notes
                                  .filter((n) => n.id !== note?.id)
                                  .map((targetNote) => (
                                    <DropdownMenuItem
                                      key={targetNote.id}
                                      onClick={() => note && mergeNoteInto(note, targetNote.id)}
                                      className="text-[13px]"
                                    >
                                      <span className="min-w-0 truncate">{targetNote.title || "未命名笔记"}</span>
                                    </DropdownMenuItem>
                                  ))}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            <DropdownMenuItem
                              disabled={!note}
                              onClick={() => note && copyNoteMarkdown(note)}
                            >
                              <Copy className="mr-2 h-3.5 w-3.5" />
                              复制 Markdown
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={!note}
                              onClick={() => note && exportActiveNote()}
                            >
                              <Download className="mr-2 h-3.5 w-3.5" />
                              导出 Markdown
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!note}
                              onClick={() => note && exportActiveNotePdf()}
                            >
                              <Printer className="mr-2 h-3.5 w-3.5" />
                              导出为 PDF
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={!note}
                              onClick={() => note && toggleNoteTemplate(note)}
                            >
                              <FileText className="mr-2 h-3.5 w-3.5" />
                              {note?.type === "template" ? "取消模板标记" : "标记为模板"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={!note}
                              onClick={() => note && deleteNote(note)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" />
                              删除笔记
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  }}
                /> : <MaterialsPreview selection={materialsSelection} />}
                {moduleView === "notes" && rightSidebarOpen && (
                  <>
                    <div
                      onMouseDown={handleRightDragStart}
                      className="w-[1px] shrink-0 cursor-col-resize bg-border"
                    />
                    <RightSidebar
                      width={rightSidebarWidth}
                      note={activeNote}
                      activeTab={rightActiveTab}
                      onTabChange={setRightActiveTab}
                      onSelectNote={selectNoteInWorkspace}
                      onOpenNoteByTitle={openNoteByTitle}
                      allNotes={notes}
                    />
                  </>
                )}
              </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {!agentPanelCollapsed && (
        <div
          onMouseDown={handleDragStart}
          className="w-[1px] shrink-0 cursor-col-resize bg-border"
        />
      )}

      <NoteAgentPanel
        note={activeNote}
        notebook={activeNotebook}
        transformations={transformations}
        collapsed={agentPanelCollapsed}
        width={agentPanelWidth}
        onAgentChatIdChange={(agentChatId) => updateActiveNote({ agentChatId })}
        onApplyResult={applyAiResult}
        onApplyTags={(tags) => activeNote && editNoteTags(activeNote, tags)}
        onSaveAsNote={saveAgentResultAsNote}
        onTransformationsChange={setTransformations}
        onClearChat={() => updateActiveNote({ agentChatId: undefined })}
        onStreamingChange={setAgentStreaming}
      />

      <PromptDialog
        open={promptState !== null}
        title={promptTitle}
        defaultValue={promptDefaultValue}
        placeholder={promptPlaceholder}
        onConfirm={handlePromptConfirm}
        onOpenChange={(open) => { if (!open) setPromptState(null); }}
      />
      <ConfirmDialog
        open={confirmState !== null}
        title={confirmTitle}
        message={confirmMessage}
        destructive
        onConfirm={handleConfirmAction}
        onOpenChange={(open) => { if (!open) setConfirmState(null); }}
      />
      <TemplatePickerDialog
        open={templatePickerOpen}
        templates={templateNotes}
        onConfirm={(templateId, title) => createNoteFromTemplateAction(templateId, title)}
        onOpenChange={setTemplatePickerOpen}
      />
      <GlobalSearchDialog
        open={globalSearchOpen}
        onOpenChange={setGlobalSearchOpen}
        onSelectNote={openNoteFromGlobalSearch}
        initialQuery={globalSearchInitialQuery}
      />
      {notice && noticeType === "error" ? (
        <div className="pointer-events-none absolute bottom-4 right-4 z-50">
          <div className="pointer-events-auto flex max-w-[320px] items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive shadow-lg backdrop-blur">
            <span className="min-w-0 flex-1 leading-5">{notice}</span>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => setNotice(null)}
              className="shrink-0 text-destructive/70 hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function VaultBootstrap({
  busy,
  onOpenOrCreate,
}: {
  busy: boolean;
  onOpenOrCreate: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-8">
      <div className="flex max-w-[420px] flex-col items-center gap-4 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl border border-border/70 bg-muted/30">
          <FolderOpen className="h-7 w-7 text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-[16px] font-semibold text-foreground">打开笔记仓库</h2>
          <p className="text-[12.5px] leading-5 text-muted-foreground">
            笔记以 Markdown 文件形式保存在你选择的仓库目录中，笔记本为文件夹，可直接用外部编辑器访问。选择一个已有仓库或新建一个空文件夹作为新仓库。
          </p>
        </div>
        <Button
          type="button"
          onClick={onOpenOrCreate}
          disabled={busy}
          className="h-9 gap-1.5 rounded-lg px-4 text-[13px]"
        >
          <FolderOpen className="h-4 w-4" />
          {busy ? "处理中..." : "选择仓库目录"}
        </Button>
      </div>
    </div>
  );
}

function IconButton({
  label,
  active = false,
  disabled = false,
  children,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </Button>
  );
}

interface RootNotesListProps {
  notes: OperationNote[];
  totalCount?: number;
  activeNoteId: string | null;
  selectedIds?: Set<string>;
  searchQuery: string;
  sortMode: SortMode;
  onSortChange: (mode: SortMode) => void;
  onSelectNote: (id: string) => void;
  onOpenInNewTab?: (id: string) => void;
  onSelectionChange?: (ids: Set<string>) => void;
  onCopyMarkdown?: (note: OperationNote) => void;
  onCopyPath?: (note: OperationNote) => void;
  onRevealInExplorer?: (note: OperationNote) => void;
  onDuplicate?: (note: OperationNote) => void;
  onEditTags?: (note: OperationNote, tags: string[]) => void;
  onRename?: (note: OperationNote) => void;
  onMoveToNotebook?: (note: OperationNote, notebookId: string) => void;
  onMergeNote?: (note: OperationNote, targetNoteId: string) => void;
  onDelete?: (note: OperationNote) => void;
  onDeleteMany?: (notes: OperationNote[]) => void;
  onSetContextLevel?: (note: OperationNote, level: NoteContextLevel) => void;
  onToggleFavorite?: (note: OperationNote) => void;
  onCreateNote?: (sourceKind: NoteSourceKind) => void;
  notebooks: Notebook[];
  allNotes?: OperationNote[];
}

function RootNotesList({
  notes,
  activeNoteId,
  selectedIds,
  sortMode,
  onSelectNote,
  onOpenInNewTab,
  onSelectionChange,
  onCopyMarkdown,
  onCopyPath,
  onRevealInExplorer,
  onDuplicate,
  onEditTags,
  onRename,
  onMoveToNotebook,
  onMergeNote,
  onDelete,
  onSetContextLevel,
  onToggleFavorite,
  notebooks,
  allNotes = [],
}: RootNotesListProps) {
  const handleRootDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("application/x-note-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const handleRootDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const noteId = e.dataTransfer.getData("application/x-note-id") || e.dataTransfer.getData("text/plain");
    e.preventDefault();
    if (noteId && onMoveToNotebook) {
      const draggedNote = allNotes.find((n) => n.id === noteId);
      if (draggedNote && draggedNote.notebookId !== "") {
        onMoveToNotebook(draggedNote, "");
      }
    }
  };

  const sortedNotes = useMemo(() => sortNotesByMode(notes, sortMode), [notes, sortMode]);
  const selection = selectedIds ?? new Set<string>();

  if (sortedNotes.length === 0) return null;

  return (
    <div className="py-1" onDragOver={handleRootDragOver} onDrop={handleRootDrop}>
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
                onSelectNote(note.id);
              }
            }}
            onOpenInNewTab={onOpenInNewTab ? () => onOpenInNewTab(note.id) : undefined}
            onCopyMarkdown={onCopyMarkdown}
            onCopyPath={onCopyPath}
            onRevealInExplorer={onRevealInExplorer}
            onDuplicate={onDuplicate}
            onEditTags={onEditTags ? () => onEditTags(note, note.tags) : undefined}
            onRename={onRename ? () => onRename(note) : undefined}
            onMoveToNotebook={onMoveToNotebook}
            onMergeNote={onMergeNote}
            onDelete={onDelete}
            notebooks={notebooks}
            allNotes={allNotes}
            onSetContextLevel={onSetContextLevel}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
      </div>
    </div>
  );
}

function FavoriteNotesList({
  notes,
  activeNoteId,
  selectedIds,
  sortMode,
  onSelectNote,
  onOpenInNewTab,
  onSelectionChange,
  onCopyMarkdown,
  onCopyPath,
  onRevealInExplorer,
  onDuplicate,
  onEditTags,
  onRename,
  onMoveToNotebook,
  onMergeNote,
  onDelete,
  onSetContextLevel,
  onToggleFavorite,
  notebooks,
  allNotes = [],
}: RootNotesListProps) {
  const sortedNotes = useMemo(() => sortNotesByMode(notes, sortMode), [notes, sortMode]);
  const selection = selectedIds ?? new Set<string>();

  if (sortedNotes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-4 text-center text-[12px] leading-5 text-muted-foreground">
        没有收藏笔记
      </div>
    );
  }

  return (
    <div className="py-1">
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
                onSelectNote(note.id);
              }
            }}
            onOpenInNewTab={onOpenInNewTab ? () => onOpenInNewTab(note.id) : undefined}
            onCopyMarkdown={onCopyMarkdown}
            onCopyPath={onCopyPath}
            onRevealInExplorer={onRevealInExplorer}
            onDuplicate={onDuplicate}
            onEditTags={onEditTags ? () => onEditTags(note, note.tags) : undefined}
            onRename={onRename ? () => onRename(note) : undefined}
            onMoveToNotebook={onMoveToNotebook}
            onMergeNote={onMergeNote}
            onDelete={onDelete}
            notebooks={notebooks}
            allNotes={allNotes}
            onSetContextLevel={onSetContextLevel}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
      </div>
    </div>
  );
}

interface NotebookSectionProps {
  notebook: Notebook;
  isExpanded: boolean;
  notes: OperationNote[];
  totalCount: number;
  activeNoteId: string | null;
  selectedIds?: Set<string>;
  searchQuery: string;
  sortMode: SortMode;
  onSortChange: (mode: SortMode) => void;
  onToggle: () => void;
  onSelectNote: (id: string) => void;
  onOpenInNewTab?: (id: string) => void;
  onSelectionChange?: (ids: Set<string>) => void;
  onCopyMarkdown?: (note: OperationNote) => void;
  onCopyPath?: (note: OperationNote) => void;
  onRevealInExplorer?: (note: OperationNote) => void;
  onDuplicate?: (note: OperationNote) => void;
  onEditTags?: (note: OperationNote, tags: string[]) => void;
  onRename?: (note: OperationNote) => void;
  onMoveToNotebook?: (note: OperationNote, notebookId: string) => void;
  onMergeNote?: (note: OperationNote, targetNoteId: string) => void;
  onDelete?: (note: OperationNote) => void;
  onDeleteMany?: (notes: OperationNote[]) => void;
  onSetContextLevel?: (note: OperationNote, level: NoteContextLevel) => void;
  onToggleFavorite?: (note: OperationNote) => void;
  onCreateNote?: (sourceKind: NoteSourceKind, notebookId?: string) => void;
  onCreateNotebook?: () => void;
  notebooks: Notebook[];
  allNotes?: OperationNote[];
  onDropNote?: (noteId: string, notebookId: string) => void;
  onRenameNotebook: (notebookId: string) => void;
  onDeleteNotebook: (notebookId: string) => void;
}

function NotebookSection({
  notebook,
  isExpanded,
  notes,
  totalCount,
  activeNoteId,
  selectedIds,
  searchQuery,
  sortMode,
  onSortChange,
  onToggle,
  onSelectNote,
  onOpenInNewTab,
  onSelectionChange,
  onCopyMarkdown,
  onCopyPath,
  onRevealInExplorer,
  onDuplicate,
  onEditTags,
  onRename,
  onMoveToNotebook,
  onMergeNote,
  onDelete,
  onDeleteMany,
  onSetContextLevel,
  onToggleFavorite,
  onCreateNote,
  onCreateNotebook,
  notebooks,
  allNotes = [],
  onDropNote,
  onRenameNotebook,
  onDeleteNotebook,
}: NotebookSectionProps) {
  const handleDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
    if (!onDropNote) return;
    if (e.dataTransfer.types.includes("application/x-note-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLButtonElement>) => {
    if (!onDropNote) return;
    const noteId = e.dataTransfer.getData("application/x-note-id") || e.dataTransfer.getData("text/plain");
    e.preventDefault();
    e.stopPropagation();
    if (noteId) onDropNote(noteId, notebook.id);
  };

  const handleSectionDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("application/x-note-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  return (
    <div className="px-1" onDragOver={handleSectionDragOver}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className="group flex h-8 w-full items-center gap-1 rounded-md px-1.5 text-left text-foreground/85 transition-colors hover:bg-accent/40"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                isExpanded && "rotate-90",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
              {notebook.name}
            </span>
            <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/70">
              {totalCount}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onSelect={() => onCreateNote?.("manual", notebook.id)}>
            <FileText className="mr-2 h-3.5 w-3.5" />
            新建笔记
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCreateNotebook?.()}>
            <FolderPlus className="mr-2 h-3.5 w-3.5" />
            新建文件夹
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => onRenameNotebook(notebook.id)}
            disabled={notebook.id === ""}
            className="data-[disabled]:opacity-50 data-[disabled]:text-muted-foreground"
          >
            <Pencil className="mr-2 h-3.5 w-3.5" />
            重命名
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => onDeleteNotebook(notebook.id)}
            disabled={notebook.id === ""}
            className="text-destructive focus:text-destructive data-[disabled]:opacity-50 data-[disabled]:text-muted-foreground"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            删除文件夹
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isExpanded ? (
        <div className="ml-3 border-l border-border/40 pl-1">
          <NoteList
            notes={notes}
            activeNoteId={activeNoteId}
            selectedIds={selectedIds}
            onSelectionChange={onSelectionChange}
            totalCount={totalCount}
            emptyLabel={searchQuery ? "没有匹配的笔记。" : "还没有笔记。"}
            showHeader={false}
            sortMode={sortMode}
            onSortChange={onSortChange}
            onSelect={onSelectNote}
            onOpenInNewTab={onOpenInNewTab}
            onCopyMarkdown={onCopyMarkdown}
            onCopyPath={onCopyPath}
            onRevealInExplorer={onRevealInExplorer}
            onDuplicate={onDuplicate}
            onEditTags={onEditTags}
            onRename={onRename}
            onMoveToNotebook={onMoveToNotebook}
            onMergeNote={onMergeNote}
            onDelete={onDelete}
            onDeleteMany={onDeleteMany}
            onSetContextLevel={onSetContextLevel}
            onToggleFavorite={onToggleFavorite}
            onCreateNote={(sourceKind) => onCreateNote?.(sourceKind, notebook.id)}
            notebooks={notebooks}
            allNotes={allNotes}
          />
        </div>
      ) : null}
    </div>
  );
}

function serializeNotesState(state: {
  notebooks: Notebook[];
  notes: OperationNote[];
  transformations: NoteTransformation[];
  activeNotebookId: string;
  activeNoteId: string | null;
  workspace: WorkspaceState;
  rightSidebarOpen: boolean;
  rightSidebarWidth: number;
  rightActiveTab: RightTab;
}): string {
  return JSON.stringify(state);
}

function clampRightSidebarWidth(width: unknown): number {
  const num = typeof width === "number" ? width : RIGHT_SIDEBAR_DEFAULT_WIDTH;
  return Math.min(Math.max(num, RIGHT_SIDEBAR_MIN_WIDTH), RIGHT_SIDEBAR_MAX_WIDTH);
}

function sanitizeRightActiveTab(tab: unknown): RightTab {
  return tab === "links" || tab === "tags" ? tab : "outline";
}
