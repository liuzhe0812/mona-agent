import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownUp,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronRight,
  Copy,
  Database,
  Download,
  FileCode2,
  FileText,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitFork,
  MoreHorizontal,
  Pencil,
  Plus,
  Printer,
  Search,
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
  pickNotesVaultDirectory,
  renameSyncWikiLinks,
  saveMarkdownFile,
  setNotesVaultPath,
} from "@/lib/tauri";
import { useLicense } from "@/hooks/useLicense";
import { useKbStore } from "@/stores/kb-store";

import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { ConfirmDialog, PromptDialog } from "./NotesDialogs";
import { NoteAgentPanel } from "./NoteAgentPanel";
import { BacklinksPanel } from "./BacklinksPanel";
import { GraphViewDialog } from "./GraphViewDialog";
import { RelatedNotesPanel } from "./RelatedNotesPanel";
import { NoteEditor } from "./NoteEditor";
import type { EditorMode } from "@/components/common/MarkdownEditor";
import { NoteList, type SortMode } from "./NoteList";
import { NoteTabBar } from "./NoteTabBar";
import { deriveNotePreview } from "./notes-ai";
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
  createNoteId,
  loadNotesState,
  saveNotesState,
} from "./notes-storage";

const AGENT_PANEL_MIN_WIDTH = 240;
const AGENT_PANEL_MAX_WIDTH = 480;
const AGENT_PANEL_DEFAULT_WIDTH = 306;

interface NotesViewProps {
  onSendToAgent?: (prompt: string) => void | Promise<void>;
}

export function NotesView({ onSendToAgent: _onSendToAgent }: NotesViewProps) {
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
  const [editorMode, setEditorMode] = useState<EditorMode>("visual");
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(true);
  const [agentPanelWidth, setAgentPanelWidth] = useState(AGENT_PANEL_DEFAULT_WIDTH);
  const [backlinksCollapsed, setBacklinksCollapsed] = useState(false);
  const [agentStreaming, setAgentStreaming] = useState(false);
  const [graphViewOpen, setGraphViewOpen] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const lastSavedSnapshotRef = useRef<string | null>(null);
  const latestSnapshotRef = useRef<string | null>(null);

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
  const [expandedNotebookIds, setExpandedNotebookIds] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<SortMode>("updated-desc");
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);

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

  // All note titles for [[wiki link]] autocomplete in the editor.
  const noteTitles = useMemo(() => notes.map((n) => n.title).filter(Boolean), [notes]);

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

  const selectNote = useCallback(
    (noteId: string) => {
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
      setOpenTabIds((prev) => {
        if (prev.includes(noteId)) return prev;
        const activeIdx = activeNoteId ? prev.indexOf(activeNoteId) : -1;
        if (activeIdx >= 0) {
          const next = [...prev];
          next[activeIdx] = noteId;
          return next;
        }
        return [noteId];
      });
    },
    [notes, activeNotebookId, activeNoteId],
  );

  const openInNewTab = useCallback(
    (noteId: string) => {
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
      setOpenTabIds((prev) => (prev.includes(noteId) ? prev : [...prev, noteId]));
    },
    [notes, activeNotebookId],
  );

  const closeTab = useCallback(
    (noteId: string) => {
      setOpenTabIds((prev) => {
        const idx = prev.indexOf(noteId);
        if (idx === -1) return prev;
        const next = prev.filter((id) => id !== noteId);
        if (activeNoteId === noteId) {
          const nextActive = next[idx] ?? next[idx - 1] ?? next[0] ?? null;
          setActiveNoteId(nextActive);
        }
        return next;
      });
    },
    [activeNoteId],
  );

  const closeOtherTabs = useCallback(
    (noteId: string) => {
      setOpenTabIds([noteId]);
      setActiveNoteId(noteId);
    },
    [],
  );

  const closeAllTabs = useCallback(() => {
    setOpenTabIds([]);
    setActiveNoteId(null);
  }, []);

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
        if (nextState.activeNotebookId) {
          setExpandedNotebookIds((prev) => {
            const next = new Set(prev);
            next.add(nextState.activeNotebookId);
            return next;
          });
        }
        lastSavedSnapshotRef.current = serializeNotesState(nextState);
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
  }, []);

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
          setNotice(`笔记保存失败：${msg}`);
        });
    }, 450);

    return () => window.clearTimeout(timer);
  }, [
    activeNoteId,
    activeNotebookId,
    notebooks,
    notes,
    storageError,
    storageReady,
    transformations,
  ]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Global search shortcut: Ctrl/Cmd + K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
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
    (noteId: string, notebookId?: string) => {
      const note = notes.find((item) => item.id === noteId);
      if (!note) {
        setNotice("笔记不存在");
        return;
      }
      if (notebookId) {
        setActiveNotebookId(notebookId);
      } else {
        setActiveNotebookId(note.notebookId);
      }
      setActiveNoteId(note.id);
      setSearchQuery("");
    },
    [notes],
  );

  // Sync notebook knowledge bases to kb-store for chat selector
  const setNotebookKbList = useKbStore((s) => s.setNotebookKbList);
  useEffect(() => {
    const kbNotebooks = notebooks
      .filter((n) => n.knowledgeBaseEnabled)
      .map((n) => ({ id: n.id, name: n.name }));
    setNotebookKbList(kbNotebooks);
  }, [notebooks, setNotebookKbList]);

  useEffect(() => {
    if (!activeNote && notebookNotes[0]) {
      setActiveNoteId(notebookNotes[0].id);
      return;
    }
    if (activeNote && activeNote.id !== activeNoteId) {
      setActiveNoteId(activeNote.id);
    }
  }, [activeNote, activeNoteId, notebookNotes]);

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
    (sourceKind: NoteSourceKind = "manual") => {
      // activeNotebook may be null (vault root) — that's allowed.
      const notebookId = activeNotebook ? activeNotebook.id : "";
      let nextNote: OperationNote;
      try {
        nextNote = createBlankNote(notebookId, sourceKind);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "新建笔记失败");
        return;
      }
      setNotes((current) => [nextNote, ...current]);
      setActiveNoteId(nextNote.id);
      setOpenTabIds((prev) => {
        const activeIdx = activeNoteId ? prev.indexOf(activeNoteId) : -1;
        if (activeIdx >= 0) {
          const next = [...prev];
          next[activeIdx] = nextNote.id;
          return next;
        }
        return [nextNote.id];
      });
      setSearchQuery("");
      setNotice(sourceKind === "ssh" ? "已新建 SSH 记录" : "已新建笔记");
    },
    [activeNotebook, activeNoteId],
  );

  const moveSelectionToNote = useCallback(
    (selectedText: string) => {
      const notebookId = activeNotebook ? activeNotebook.id : "";
      const title = selectedText.trim().split("\n")[0].slice(0, 40) || "从选区创建的笔记";
      const nextNote: OperationNote = {
        ...createBlankNote(notebookId, "manual"),
        title,
        contentMarkdown: selectedText,
        preview: selectedText.slice(0, 120),
      };
      setNotes((current) => [nextNote, ...current]);
      setActiveNoteId(nextNote.id);
      setNotice("已将所选内容移动到新笔记");
    },
    [activeNotebook],
  );

  const createNotebook = useCallback(() => {
    setPromptState({ kind: "createNotebook" });
  }, []);

  const handleCreateNotebook = useCallback((name: string) => {
    let nextNotebook: Notebook;
    try {
      nextNotebook = createCustomNotebook(name);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "新建笔记本失败");
      return;
    }
    setNotebooks((current) => [...current, nextNotebook]);
    setActiveNotebookId(nextNotebook.id);
    setActiveNoteId(null);
    setSearchQuery("");
    setNotice("已新建笔记本");
  }, []);

  const renameNotebook = useCallback((notebookId: string) => {
    if (notebookId === "") return;
    setPromptState({ kind: "renameNotebook", notebookId });
  }, []);

  const handleRenameNotebook = useCallback((notebookId: string, name: string) => {
    const target = notebooks.find((n) => n.id === notebookId);
    if (!target || name === target.name) return;
    setNotebooks((current) =>
      current.map((notebook) =>
        notebook.id === notebookId ? { ...notebook, name } : notebook,
      ),
    );
    setNotice("笔记本已重命名");
  }, [notebooks]);

  const toggleNotebookKnowledgeBase = useCallback(
    (notebookId: string, knowledgeBaseEnabled: boolean) => {
      setNotebooks((current) =>
        current.map((notebook) =>
          notebook.id === notebookId
            ? { ...notebook, knowledgeBaseEnabled }
            : notebook,
        ),
      );
      setNotice(knowledgeBaseEnabled ? "已标记为知识库" : "已取消知识库标记");
    },
    [],
  );

  const deleteNotebook = useCallback((notebookId: string) => {
    if (notebookId === "") {
      setNotice("仓库根目录不允许删除");
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
    setNotice("笔记本已删除");
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
      lastSavedSnapshotRef.current = serializeNotesState(nextState);
      latestSnapshotRef.current = lastSavedSnapshotRef.current;
      setStorageError(null);
      setSaveStatus("saved");
      setNotice("已打开笔记仓库");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "打开仓库失败");
    } finally {
      setVaultBusy(false);
    }
  }, []);

  const exportActiveNote = useCallback(async () => {
    if (!activeNote) return;
    try {
      const saved = await saveMarkdownFile(activeNote.title, activeNote.contentMarkdown);
      if (saved) setNotice("已导出 Markdown");
    } catch {
      setNotice("导出失败");
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
      setOpenTabIds((prev) => prev.filter((id) => id !== sourceNote.id));
      setActiveNoteId(target.id);
      setOpenTabIds((prev) => (prev.includes(target.id) ? prev : [...prev, target.id]));
      setNotice(`已将「${sourceNote.title}」合并到「${target.title}」`);
    },
    [notes],
  );

  const copyNoteMarkdown = useCallback(async (note: OperationNote) => {
    try {
      await navigator.clipboard.writeText(note.contentMarkdown);
      setNotice("Markdown 已复制");
    } catch {
      setNotice("复制失败");
    }
  }, []);

  const copyNotePath = useCallback(async (note: OperationNote) => {
    const notebook = notebooks.find((nb) => nb.id === note.notebookId);
    const path = notebook ? `${notebook.name}/${note.title || "未命名笔记"}` : note.title || "未命名笔记";
    try {
      await navigator.clipboard.writeText(path);
      setNotice("路径已复制");
    } catch {
      setNotice("复制失败");
    }
  }, [notebooks]);

  const duplicateNote = useCallback((note: OperationNote) => {
    let nextNoteId: string;
    try {
      nextNoteId = createNoteId();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "复制笔记失败");
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
    setNotice("已复制一份笔记");
  }, []);

  const editNoteTags = useCallback((note: OperationNote, tags: string[]) => {
    setNotes((current) =>
      current.map((n) =>
        n.id === note.id ? { ...n, tags, updatedAt: "刚刚" } : n,
      ),
    );
    setNotice("标签已更新");
  }, []);

  const renameNote = useCallback((note: OperationNote) => {
    setPromptState({ kind: "renameNote", noteId: note.id });
  }, []);

  const moveNote = useCallback(
    (note: OperationNote, targetNotebookId: string) => {
      if (targetNotebookId === note.notebookId) return;
      const targetNotebook = notebooks.find((notebook) => notebook.id === targetNotebookId);
      if (!targetNotebook) return;

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
      setNotice(`已移动到 ${targetNotebook.name}`);
    },
    [notebooks],
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
      setOpenTabIds((prev) => prev.filter((id) => !idSet.has(id)));
      if (activeNoteId && idSet.has(activeNoteId)) {
        const remaining = notes.filter((n) => !idSet.has(n.id));
        const nextActive = remaining[0]?.id ?? null;
        setActiveNoteId(nextActive);
        if (nextActive) {
          setOpenTabIds((prev) => (prev.includes(nextActive) ? prev : [...prev, nextActive]));
        }
      }
      setNotice(`已删除 ${noteIds.length} 条笔记`);
    },
    [activeNoteId, notes],
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
      setOpenTabIds((prev) => prev.filter((id) => id !== noteId));
      if (activeNoteId === noteId) {
        const nextActive = remainingNotes[0]?.id ?? null;
        setActiveNoteId(nextActive);
        if (nextActive) {
          setOpenTabIds((prev) => (prev.includes(nextActive) ? prev : [...prev, nextActive]));
        }
      }
      setNotice("笔记已删除");
    },
    [activeNoteId, notes],
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
      setNotice(mode === "replace" ? "已替换笔记正文" : "已追加到笔记");
    },
    [activeNote, updateActiveNote],
  );

  const saveAgentResultAsNote = useCallback(
    (markdown: string, title: string) => {
      if (!activeNotebook) {
        setNotice("请先创建笔记本");
        return;
      }
      let nextNote: OperationNote;
      try {
        nextNote = createBlankNote(activeNotebook.id, "agent");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "新建笔记失败");
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
      setNotice("已保存为新笔记");
    },
    [activeNotebook],
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
          setNotice("已重命名");
          // Sync [[wiki links]] across the vault (fire-and-forget).
          renameSyncWikiLinks(oldTitle, newTitle)
            .then((result) => {
              if (result.updatedLinks > 0) {
                setNotice(`已同步 ${result.updatedLinks} 处双链`);
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
    <div className="flex h-full min-h-0 bg-background">
      <section className="flex min-w-0 flex-1 flex-col">
        {notice ? (
          <div className="flex h-7 shrink-0 items-center border-b border-border/70 bg-muted/30 px-3">
            <span className="rounded-full border border-border/70 bg-muted/35 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {notice}
            </span>
          </div>
        ) : null}

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
            <>
              <aside
                className="hidden w-[260px] shrink-0 flex-col border-r border-border/70 bg-sidebar/35 md:flex"
                onDragEnter={handleSidebarDragEnter}
                onDragOver={handleSidebarDragOver}
                onDragLeave={handleSidebarDragLeave}
                onDrop={handleSidebarDrop}
              >
                <div className="flex h-9 shrink-0 items-center justify-center gap-0.5 px-2">
                  <IconButton label="新建笔记" onClick={() => createNote()}>
                    <Plus className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton label="新建文件夹" onClick={createNotebook}>
                    <FolderPlus className="h-3.5 w-3.5" />
                  </IconButton>
                  <IconButton label="全局搜索 (Ctrl+K)" onClick={() => setGlobalSearchOpen(true)}>
                    <Search className="h-3.5 w-3.5" />
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
                      {notebooks.length === 0 && notes.length === 0 ? (
                        <div className="flex h-full items-center justify-center px-6 py-4 text-center text-[12px] leading-5 text-muted-foreground">
                          仓库为空，右键新建文件夹或笔记
                        </div>
                      ) : null}
                      <RootNotesSection
                        notes={filterNotesByKeyword(
                          notes.filter((n) => n.notebookId === ""),
                          searchQuery,
                        )}
                        totalCount={notes.filter((n) => n.notebookId === "").length}
                        isActive={activeNotebookId === ""}
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
                          setNotice("知识库上下文已更新");
                        }}
                        onCreateNote={createNote}
                        notebooks={notebooks}
                        allNotes={notes}
                      />
                      {notebooks.map((notebook) => {
                        const isActive = notebook.id === activeNotebookId;
                        const isExpanded = expandedNotebookIds.has(notebook.id) || Boolean(searchQuery);
                        const notebookNotesAll = notes.filter((n) => n.notebookId === notebook.id);
                        const filteredNotes = filterNotesByKeyword(notebookNotesAll, searchQuery);
                        return (
                          <NotebookSection
                            key={notebook.id}
                            notebook={notebook}
                            isActive={isActive}
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
                              setNotice("知识库上下文已更新");
                            }}
                            onCreateNote={createNote}
                            onCreateNotebook={createNotebook}
                            notebooks={notebooks}
                            allNotes={notes}
                            onDropNote={dropNoteById}
                            onRenameNotebook={renameNotebook}
                            onToggleKnowledgeBase={toggleNotebookKnowledgeBase}
                            onDeleteNotebook={deleteNotebook}
                          />
                        );
                      })}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onSelect={() => createNote("manual")}>
                      <FileText className="mr-2 h-3.5 w-3.5" />
                      新建笔记
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={createNotebook}>
                      <FolderPlus className="mr-2 h-3.5 w-3.5" />
                      新建文件夹
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
                <div className="flex h-9 shrink-0 items-center border-t border-border/55 px-2">
                  <button
                    type="button"
                    title="切换笔记仓库"
                    onClick={openOrCreateVault}
                    className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <ChevronUp className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold uppercase tracking-wide">
                      {vaultPath ? vaultPath.split(/[\\/]/).pop() : "笔记本"}
                    </span>
                    <span className="shrink-0 rounded-full bg-muted/50 px-1.5 py-px text-[10.5px]">
                      {notebooks.length}
                    </span>
                  </button>
                </div>
              </aside>
              <div className="relative flex min-w-0 flex-1 flex-col">
              <div className="flex shrink-0 items-stretch">
                <NoteTabBar
                  tabs={openTabIds
                    .map((id) => notes.find((n) => n.id === id))
                    .filter((n): n is OperationNote => n !== null)}
                  activeNoteId={activeNoteId}
                  onSelect={selectNote}
                  onClose={closeTab}
                  onCloseOthers={closeOtherTabs}
                  onCloseAll={closeAllTabs}
                />
                <button
                  type="button"
                  title="关系图"
                  aria-label="关系图"
                  onClick={() => setGraphViewOpen(true)}
                  className="grid h-8 w-8 shrink-0 place-items-center border-b border-border/55 border-l border-border/40 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <GitFork className="h-3.5 w-3.5" />
                </button>
              </div>
              {activeNote ? (
                <>
                  <NoteEditor
                    note={activeNote}
                    saveStatus={saveStatus}
                    mode={editorMode}
                    noteTitles={noteTitles}
                    onTitleChange={(title) => updateActiveNote({ title })}
                    onContentChange={(next) =>
                      updateActiveNote({
                        contentMarkdown: next.contentMarkdown,
                        contentJson: next.contentJson,
                        plainText: next.plainText,
                        preview: next.plainText.slice(0, 46) || "空白笔记",
                      })
                    }
                    onMoveSelectionToNote={moveSelectionToNote}
                    toolbarExtra={
                      <div className="flex items-center gap-1">
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
                              disabled={!activeNote}
                              onClick={() => activeNote && renameNote(activeNote)}
                            >
                              <Pencil className="mr-2 h-3.5 w-3.5" />
                              重命名
                            </DropdownMenuItem>
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger
                                disabled={!activeNote || notes.filter((n) => n.id !== activeNote?.id).length === 0}
                                className="text-[13px]"
                              >
                                <FolderInput className="mr-2 h-3.5 w-3.5" />
                                合并到其他笔记...
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="max-h-[300px] w-56 overflow-y-auto">
                                {notes
                                  .filter((n) => n.id !== activeNote?.id)
                                  .map((targetNote) => (
                                    <DropdownMenuItem
                                      key={targetNote.id}
                                      onClick={() => activeNote && mergeNoteInto(activeNote, targetNote.id)}
                                      className="text-[13px]"
                                    >
                                      <span className="min-w-0 truncate">{targetNote.title || "未命名笔记"}</span>
                                    </DropdownMenuItem>
                                  ))}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            <DropdownMenuItem
                              disabled={!activeNote}
                              onClick={() => activeNote && copyNoteMarkdown(activeNote)}
                            >
                              <Copy className="mr-2 h-3.5 w-3.5" />
                              复制 Markdown
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={!activeNote}
                              onClick={exportActiveNote}
                            >
                              <Download className="mr-2 h-3.5 w-3.5" />
                              导出 Markdown
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!activeNote}
                              onClick={exportActiveNotePdf}
                            >
                              <Printer className="mr-2 h-3.5 w-3.5" />
                              导出为 PDF
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={!activeNote}
                              onClick={() => activeNote && deleteNote(activeNote)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" />
                              删除笔记
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {licenseActive ? (
                          <IconButton
                            label={agentPanelCollapsed ? "展开 Agent 联动" : "收起 Agent 联动"}
                            active={!agentPanelCollapsed}
                            onClick={() => setAgentPanelCollapsed((current) => !current)}
                          >
                            <AgentLogo state={agentStreaming ? "working" : "idle"} className="h-5 w-5" />
                          </IconButton>
                        ) : null}
                      </div>
                    }
                  />
                  <div className="shrink-0 border-t border-border/60">
                    <button
                      type="button"
                      onClick={() => setBacklinksCollapsed((c) => !c)}
                      className="flex w-full items-center gap-1 px-3 py-1 text-[11px] text-muted-foreground hover:bg-accent/60"
                    >
                      <ChevronRight
                        className={cn(
                          "h-3 w-3 transition-transform",
                          !backlinksCollapsed && "rotate-90",
                        )}
                      />
                      <span>链接与提及</span>
                    </button>
                    {!backlinksCollapsed && (
                      <div className="max-h-[280px] overflow-y-auto px-2 pb-2">
                        <BacklinksPanel
                          noteId={activeNote.id}
                          onSelectNote={selectNote}
                        />
                        <RelatedNotesPanel
                          noteId={activeNote.id}
                          onSelectNote={selectNote}
                          className="mt-2"
                        />
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
                  当前笔记本还没有笔记。
                </div>
              )}
              <GraphViewDialog
                open={graphViewOpen}
                onOpenChange={setGraphViewOpen}
                activeNoteId={activeNoteId}
                onSelectNote={(noteId) => selectNote(noteId)}
              />
              </div>
            </>
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
      <GlobalSearchDialog
        open={globalSearchOpen}
        onOpenChange={setGlobalSearchOpen}
        onSelectNote={openNoteFromGlobalSearch}
      />
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

interface RootNotesSectionProps {
  notes: OperationNote[];
  totalCount: number;
  isActive: boolean;
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
  onDuplicate?: (note: OperationNote) => void;
  onEditTags?: (note: OperationNote, tags: string[]) => void;
  onRename?: (note: OperationNote) => void;
  onMoveToNotebook?: (note: OperationNote, notebookId: string) => void;
  onMergeNote?: (note: OperationNote, targetNoteId: string) => void;
  onDelete?: (note: OperationNote) => void;
  onDeleteMany?: (notes: OperationNote[]) => void;
  onSetContextLevel?: (note: OperationNote, level: NoteContextLevel) => void;
  onCreateNote?: (sourceKind: NoteSourceKind) => void;
  notebooks: Notebook[];
  allNotes?: OperationNote[];
}

function RootNotesSection({
  notes,
  totalCount,
  isActive,
  activeNoteId,
  selectedIds,
  searchQuery,
  sortMode,
  onSortChange,
  onSelectNote,
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
  notebooks,
  allNotes = [],
}: RootNotesSectionProps) {
  const [expanded, setExpanded] = useState(true);

  if (totalCount === 0 && !searchQuery) {
    return null;
  }

  const handleRootDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("application/x-note-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  return (
    <div className="mb-1" onDragOver={handleRootDragOver}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "group flex h-8 w-full items-center gap-1 rounded-md px-1.5 text-left transition-colors",
          isActive ? "bg-accent/60 text-foreground" : "text-foreground/85 hover:bg-accent/40",
        )}
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">笔记</span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/70">
          {totalCount}
        </span>
      </button>
      {expanded ? (
        <div className="ml-3 border-l border-border/40 pl-1">
          <NoteList
            notes={notes}
            activeNoteId={activeNoteId}
            selectedIds={selectedIds}
            onSelectionChange={onSelectionChange}
            totalCount={totalCount}
            emptyLabel={searchQuery ? "没有匹配的笔记。" : "还没有笔记。"}
            knowledgeBaseEnabled={false}
            showHeader={false}
            sortMode={sortMode}
            onSortChange={onSortChange}
            onSelect={onSelectNote}
            onOpenInNewTab={onOpenInNewTab}
            onCopyMarkdown={onCopyMarkdown}
            onCopyPath={onCopyPath}
            onDuplicate={onDuplicate}
            onEditTags={onEditTags}
            onRename={onRename}
            onMoveToNotebook={onMoveToNotebook}
            onMergeNote={onMergeNote}
            onDelete={onDelete}
            onDeleteMany={onDeleteMany}
            onSetContextLevel={onSetContextLevel}
            onCreateNote={onCreateNote}
            notebooks={notebooks}
            allNotes={allNotes}
          />
        </div>
      ) : null}
    </div>
  );
}

interface NotebookSectionProps {
  notebook: Notebook;
  isActive: boolean;
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
  onDuplicate?: (note: OperationNote) => void;
  onEditTags?: (note: OperationNote, tags: string[]) => void;
  onRename?: (note: OperationNote) => void;
  onMoveToNotebook?: (note: OperationNote, notebookId: string) => void;
  onMergeNote?: (note: OperationNote, targetNoteId: string) => void;
  onDelete?: (note: OperationNote) => void;
  onDeleteMany?: (notes: OperationNote[]) => void;
  onSetContextLevel?: (note: OperationNote, level: NoteContextLevel) => void;
  onCreateNote?: (sourceKind: NoteSourceKind) => void;
  onCreateNotebook?: () => void;
  notebooks: Notebook[];
  allNotes?: OperationNote[];
  onDropNote?: (noteId: string, notebookId: string) => void;
  onRenameNotebook: (notebookId: string) => void;
  onToggleKnowledgeBase: (notebookId: string, enabled: boolean) => void;
  onDeleteNotebook: (notebookId: string) => void;
}

function NotebookSection({
  notebook,
  isActive,
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
  onDuplicate,
  onEditTags,
  onRename,
  onMoveToNotebook,
  onMergeNote,
  onDelete,
  onDeleteMany,
  onSetContextLevel,
  onCreateNote,
  onCreateNotebook,
  notebooks,
  allNotes = [],
  onDropNote,
  onRenameNotebook,
  onToggleKnowledgeBase,
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
            className={cn(
              "group flex h-8 w-full items-center gap-1 rounded-md px-1.5 text-left transition-colors",
              isActive
                ? "bg-accent/60 text-foreground"
                : "text-foreground/85 hover:bg-accent/40",
            )}
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
            {notebook.knowledgeBaseEnabled ? (
              <Database className="h-3 w-3 shrink-0 text-muted-foreground/70" />
            ) : null}
            <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/70">
              {totalCount}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onSelect={() => onCreateNote?.("manual")}>
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
          <ContextMenuItem
            onSelect={() => onToggleKnowledgeBase(notebook.id, !notebook.knowledgeBaseEnabled)}
          >
            <Database className="mr-2 h-3.5 w-3.5" />
            {notebook.knowledgeBaseEnabled ? "取消知识库" : "建为知识库"}
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
            knowledgeBaseEnabled={notebook.knowledgeBaseEnabled}
            showHeader={false}
            sortMode={sortMode}
            onSortChange={onSortChange}
            onSelect={onSelectNote}
            onOpenInNewTab={onOpenInNewTab}
            onCopyMarkdown={onCopyMarkdown}
            onCopyPath={onCopyPath}
            onDuplicate={onDuplicate}
            onEditTags={onEditTags}
            onRename={onRename}
            onMoveToNotebook={onMoveToNotebook}
            onMergeNote={onMergeNote}
            onDelete={onDelete}
            onDeleteMany={onDeleteMany}
            onSetContextLevel={onSetContextLevel}
            onCreateNote={onCreateNote}
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
}): string {
  return JSON.stringify(state);
}
