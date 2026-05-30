import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  Download,
  Plus,
  Search,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { saveMarkdownFile } from "@/lib/tauri";
import { useLicense } from "@/hooks/useLicense";

import { KnowledgeView } from "./KnowledgeView";
import { NoteAgentPanel } from "./NoteAgentPanel";
import { NoteEditor } from "./NoteEditor";
import { NoteList } from "./NoteList";
import { NotebookSelect } from "./NotebookSelect";
import { deriveNotePreview, type ExtractedKnowledgeDraft } from "./notes-ai";
import type {
  KnowledgeCategory,
  KnowledgeItem,
  KnowledgeLinkedNote,
  Notebook,
  NoteSourceKind,
  OperationNote,
} from "./notes-data";
import {
  createBlankNote,
  createCustomNotebook,
  createKnowledgeCategory,
  createKnowledgeItemId,
  createNoteId,
  loadNotesState,
  saveNotesState,
} from "./notes-storage";

const AGENT_PANEL_MIN_WIDTH = 240;
const AGENT_PANEL_MAX_WIDTH = 480;
const AGENT_PANEL_DEFAULT_WIDTH = 306;

interface NotesViewProps {
  onSendToAgent?: (prompt: string) => void | Promise<void>;
  createNoteTrigger?: number;
}

export function NotesView({ onSendToAgent: _onSendToAgent, createNoteTrigger }: NotesViewProps) {
  const { licenseActive } = useLicense();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [activeNotebookId, setActiveNotebookId] = useState("");
  const [notes, setNotes] = useState<OperationNote[]>([]);
  const [knowledgeCategories, setKnowledgeCategories] = useState<KnowledgeCategory[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [activeKnowledgeCategoryId, setActiveKnowledgeCategoryId] = useState("");
  const [activeKnowledgeItemId, setActiveKnowledgeItemId] = useState<string | null>(null);
  const [knowledgeReturnItemId, setKnowledgeReturnItemId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"notes" | "knowledge">("notes");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(true);
  const [agentPanelWidth, setAgentPanelWidth] = useState(AGENT_PANEL_DEFAULT_WIDTH);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const lastSavedSnapshotRef = useRef<string | null>(null);
  const latestSnapshotRef = useRef<string | null>(null);

  const activeNotebook = useMemo(
    () => notebooks.find((notebook) => notebook.id === activeNotebookId) ?? notebooks[0] ?? null,
    [activeNotebookId, notebooks],
  );

  const notebookNotes = useMemo(
    () => activeNotebook ? notes.filter((note) => note.notebookId === activeNotebook.id) : [],
    [activeNotebook, notes],
  );

  const visibleNotes = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    if (!keyword) return notebookNotes;

    return notebookNotes.filter((note) => {
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
      return haystack.includes(keyword);
    });
  }, [notebookNotes, searchQuery]);

  const activeNote = useMemo(
    () => notebookNotes.find((note) => note.id === activeNoteId) ?? notebookNotes[0] ?? null,
    [activeNoteId, notebookNotes],
  );

  const knowledgeReturnItem = useMemo(
    () =>
      knowledgeReturnItemId
        ? knowledgeItems.find((item) => item.id === knowledgeReturnItemId) ?? null
        : null,
    [knowledgeItems, knowledgeReturnItemId],
  );

  const knowledgeTags = useMemo(
    () => Array.from(new Set(knowledgeItems.flatMap((item) => item.tags))).sort((a, b) =>
      a.localeCompare(b, "zh-Hans-CN"),
    ),
    [knowledgeItems],
  );

  const shouldShowKnowledgeReturn =
    Boolean(activeNote && knowledgeReturnItem) &&
    isKnowledgeItemLinkedToNote(knowledgeReturnItem, activeNote?.id ?? "");

  useEffect(() => {
    let cancelled = false;

    void loadNotesState()
      .then((nextState) => {
        if (cancelled) return;
        setNotebooks(nextState.notebooks);
        setNotes(nextState.notes);
        setKnowledgeCategories(nextState.knowledgeCategories);
        setKnowledgeItems(nextState.knowledgeItems);
        setActiveNotebookId(nextState.activeNotebookId);
        setActiveNoteId(nextState.activeNoteId);
        setActiveKnowledgeCategoryId(nextState.activeKnowledgeCategoryId);
        lastSavedSnapshotRef.current = serializeNotesState(nextState);
        latestSnapshotRef.current = lastSavedSnapshotRef.current;
        setStorageError(null);
        setSaveStatus("saved");
      })
      .catch((error) => {
        if (!cancelled) {
          setStorageError(error instanceof Error ? error.message : "笔记存储加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setStorageReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady || storageError || notebooks.length === 0 || !activeNotebookId) return;

    const state = {
      notebooks,
      notes,
      knowledgeCategories,
      knowledgeItems,
      activeNotebookId,
      activeNoteId,
      activeKnowledgeCategoryId,
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
        .catch(() => {
          if (latestSnapshotRef.current === snapshot) setSaveStatus("error");
          setNotice("笔记保存失败");
        });
    }, 450);

    return () => window.clearTimeout(timer);
  }, [
    activeKnowledgeCategoryId,
    activeNoteId,
    activeNotebookId,
    knowledgeCategories,
    knowledgeItems,
    notebooks,
    notes,
    storageError,
    storageReady,
  ]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!activeNote && notebookNotes[0]) {
      setActiveNoteId(notebookNotes[0].id);
      return;
    }
    if (activeNote && activeNote.id !== activeNoteId) {
      setActiveNoteId(activeNote.id);
    }
  }, [activeNote, activeNoteId, notebookNotes]);

  const selectNotebook = useCallback(
    (notebookId: string) => {
      const nextNotes = notes.filter((note) => note.notebookId === notebookId);
      setActiveNotebookId(notebookId);
      setActiveNoteId(nextNotes[0]?.id ?? null);
      setSearchQuery("");
    },
    [notes],
  );

  const updateActiveNote = useCallback(
    (patch: Partial<OperationNote>) => {
      if (!activeNote) return;
      setNotes((current) =>
        current.map((note) =>
          note.id === activeNote.id
            ? {
                ...note,
                ...patch,
                updatedAt: "刚刚",
              }
            : note,
        ),
      );
    },
    [activeNote],
  );

  const createNote = useCallback(
    (sourceKind: NoteSourceKind = "manual") => {
      if (!activeNotebook) {
        setNotice("请先创建笔记本");
        return;
      }
      let nextNote: OperationNote;
      try {
        nextNote = createBlankNote(activeNotebook.id, sourceKind);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "新建笔记失败");
        return;
      }
      setNotes((current) => [nextNote, ...current]);
      setActiveNoteId(nextNote.id);
      setSearchQuery("");
      setNotice(sourceKind === "ssh" ? "已新建 SSH 记录" : "已新建笔记");
    },
    [activeNotebook],
  );

  useEffect(() => {
    if (createNoteTrigger && createNoteTrigger > 0) {
      createNote();
    }
  }, [createNoteTrigger, createNote]);

  const createNotebook = useCallback(() => {
    const name = window.prompt("笔记本名称", "新的笔记本")?.trim();
    if (!name) return;

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

  const renameActiveNotebook = useCallback(() => {
    if (!activeNotebook) return;
    const name = window.prompt("笔记本名称", activeNotebook.name)?.trim();
    if (!name || name === activeNotebook.name) return;

    setNotebooks((current) =>
      current.map((notebook) =>
        notebook.id === activeNotebook.id ? { ...notebook, name } : notebook,
      ),
    );
    setNotice("笔记本已重命名");
  }, [activeNotebook]);

  const editActiveNotebookDescription = useCallback(() => {
    if (!activeNotebook) return;
    const description = window.prompt("笔记本描述", activeNotebook.description)?.trim();
    if (description === undefined || description === activeNotebook.description) return;

    setNotebooks((current) =>
      current.map((notebook) =>
        notebook.id === activeNotebook.id ? { ...notebook, description } : notebook,
      ),
    );
    setNotice("笔记本描述已更新");
  }, [activeNotebook]);

  const toggleActiveNotebookKnowledgeBase = useCallback(
    (knowledgeBaseEnabled: boolean) => {
      if (!activeNotebook) return;
      setNotebooks((current) =>
        current.map((notebook) =>
          notebook.id === activeNotebook.id
            ? { ...notebook, knowledgeBaseEnabled }
            : notebook,
        ),
      );
      setNotice(knowledgeBaseEnabled ? "已标记为知识库" : "已取消知识库标记");
    },
    [activeNotebook],
  );

  const deleteActiveNotebook = useCallback(() => {
    if (!activeNotebook) return;
    if (notebooks.length <= 1) {
      setNotice("至少保留一个笔记本");
      return;
    }

    const noteCount = notes.filter((note) => note.notebookId === activeNotebook.id).length;
    const confirmed = window.confirm(
      `删除「${activeNotebook.name}」？这会同时删除里面的 ${noteCount} 条笔记。`,
    );
    if (!confirmed) return;

    const nextNotebooks = notebooks.filter((notebook) => notebook.id !== activeNotebook.id);
    const nextNotebook = nextNotebooks[0];
    const nextActiveNote = notes.find((note) => note.notebookId === nextNotebook.id) ?? null;

    setNotebooks(nextNotebooks);
    setNotes((current) => current.filter((note) => note.notebookId !== activeNotebook.id));
    setActiveNotebookId(nextNotebook.id);
    setActiveNoteId(nextActiveNote?.id ?? null);
    setSearchQuery("");
    setNotice("笔记本已删除");
  }, [activeNotebook, notebooks, notes]);

  const exportActiveNote = useCallback(async () => {
    if (!activeNote) return;
    try {
      const saved = await saveMarkdownFile(activeNote.title, activeNote.contentMarkdown);
      if (saved) setNotice("已导出 Markdown");
    } catch {
      setNotice("导出失败");
    }
  }, [activeNote]);

  const copyNoteMarkdown = useCallback(async (note: OperationNote) => {
    try {
      await navigator.clipboard.writeText(note.contentMarkdown);
      setNotice("Markdown 已复制");
    } catch {
      setNotice("复制失败");
    }
  }, []);

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
      updatedAt: "刚刚",
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

  const deleteNote = useCallback(
    (note: OperationNote) => {
      const confirmed = window.confirm(`删除「${note.title || "未命名笔记"}」？`);
      if (!confirmed) return;

      const noteNotebookId = note.notebookId;
      const remainingNotes = notes.filter(
        (n) => n.notebookId === noteNotebookId && n.id !== note.id,
      );
      setNotes((current) => current.filter((n) => n.id !== note.id));
      if (activeNoteId === note.id) {
        setActiveNoteId(remainingNotes[0]?.id ?? null);
      }
      setNotice("笔记已删除");
    },
    [activeNoteId, notes],
  );

  const saveKnowledgeFromAgent = useCallback(
    (draft: ExtractedKnowledgeDraft) => {
      if (!activeNote) return false;
      const tags = normalizeKnowledgeTags(draft.tags);
      if (tags.length === 0) {
        setNotice("知识点标签不能为空");
        return false;
      }

      let categoriesAfterEnsure = knowledgeCategories;
      let category: KnowledgeCategory;
      try {
        const result = ensureKnowledgeCategoryPath(knowledgeCategories, draft.categoryName);
        categoriesAfterEnsure = result.categories;
        category = result.category;
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "创建知识分类失败");
        return false;
      }
      if (categoriesAfterEnsure !== knowledgeCategories) {
        setKnowledgeCategories(categoriesAfterEnsure);
      }

      const linkedNote = createKnowledgeLinkedNote(activeNote, draft.sourceDescription);
      const existingItem = knowledgeItems.find(
        (item) =>
          item.categoryId === category.id &&
          normalizeKnowledgeTitle(item.title) === normalizeKnowledgeTitle(draft.title),
      );

      if (existingItem) {
        setKnowledgeItems((current) =>
          current.map((item) =>
            item.id === existingItem.id
              ? {
                  ...item,
                  tags: mergeTags(item.tags, tags),
                  linkedNotes: mergeKnowledgeLinkedNotes(item, linkedNote),
                  updatedAt: "刚刚",
                }
              : item,
          ),
        );
        setActiveKnowledgeCategoryId(category.id);
        setActiveKnowledgeItemId(existingItem.id);
        setViewMode("knowledge");
        setNotice("已关联到已有知识点");
        return true;
      }

      let itemId: string;
      try {
        itemId = createKnowledgeItemId();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "保存知识点失败");
        return false;
      }

      const nextItem: KnowledgeItem = {
        id: itemId,
        categoryId: category.id,
        title: draft.title,
        summary: draft.summary,
        content: draft.content,
        sourceNoteId: activeNote.id,
        sourceNoteTitle: activeNote.title || "未命名笔记",
        sourceDescription: draft.sourceDescription,
        updatedAt: "刚刚",
        tags,
        linkedNotes: [linkedNote],
      };

      setKnowledgeItems((current) => [nextItem, ...current]);
      setActiveKnowledgeCategoryId(category.id);
      setActiveKnowledgeItemId(nextItem.id);
      setViewMode("knowledge");
      setNotice("知识点已保存");
      return true;
    },
    [activeNote, knowledgeCategories, knowledgeItems],
  );

  const createKnowledgeCategoryManually = useCallback((parentId: string | null = null) => {
    const parentCategory = parentId
      ? knowledgeCategories.find((category) => category.id === parentId)
      : null;
    const name = window.prompt(
      parentCategory ? `在「${parentCategory.name}」下新建分类` : "知识分类名称",
      "新的分类",
    )?.trim();
    if (!name) return;
    if (
      hasSiblingCategoryName(knowledgeCategories, name, parentCategory?.id ?? null)
    ) {
      setNotice("知识分类已存在");
      return;
    }

    let nextCategory: KnowledgeCategory;
    try {
      nextCategory = createKnowledgeCategory(name, parentCategory?.id ?? null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建知识分类失败");
      return;
    }

    setKnowledgeCategories((current) => [...current, nextCategory]);
    setActiveKnowledgeCategoryId(nextCategory.id);
    setViewMode("knowledge");
    setNotice("知识分类已创建");
  }, [knowledgeCategories]);

  const renameKnowledgeCategory = useCallback(
    (categoryId: string) => {
      const category = knowledgeCategories.find((item) => item.id === categoryId);
      if (!category) return;

      const name = window.prompt("知识分类名称", category.name)?.trim();
      if (!name || name === category.name) return;
      if (
        hasSiblingCategoryName(
          knowledgeCategories,
          name,
          category.parentId ?? null,
          categoryId,
        )
      ) {
        setNotice("知识分类已存在");
        return;
      }

      setKnowledgeCategories((current) =>
        current.map((item) =>
          item.id === categoryId ? { ...item, name } : item,
        ),
      );
      setNotice("知识分类已重命名");
    },
    [knowledgeCategories],
  );

  const deleteKnowledgeCategory = useCallback(
    (categoryId: string) => {
      const category = knowledgeCategories.find((item) => item.id === categoryId);
      if (!category) return;
      if (knowledgeCategories.length <= 1) {
        setNotice("至少保留一个知识分类");
        return;
      }

      const remainingCategories = knowledgeCategories
        .filter((item) => item.id !== categoryId)
        .map((item) =>
          item.parentId === categoryId ? { ...item, parentId: category.parentId ?? null } : item,
        );
      const targetCategory =
        (category.parentId
          ? remainingCategories.find((item) => item.id === category.parentId)
          : null) ?? remainingCategories[0];
      const itemCount = knowledgeItems.filter((item) => item.categoryId === categoryId).length;
      const childCount = knowledgeCategories.filter((item) => item.parentId === categoryId).length;
      const details = [
        itemCount > 0 ? `${itemCount} 条知识点会移动到「${targetCategory.name}」` : "",
        childCount > 0 ? `${childCount} 个子分类会向上移动` : "",
      ].filter(Boolean);
      const confirmed = window.confirm(
        details.length > 0
          ? `删除「${category.name}」？${details.join("，")}。`
          : `删除「${category.name}」？`,
      );
      if (!confirmed) return;

      setKnowledgeCategories(remainingCategories);
      setKnowledgeItems((current) =>
        current.map((item) =>
          item.categoryId === categoryId
            ? { ...item, categoryId: targetCategory.id, updatedAt: "刚刚" }
            : item,
        ),
      );
      if (activeKnowledgeCategoryId === categoryId) {
        setActiveKnowledgeCategoryId(targetCategory.id);
      }
      setNotice("知识分类已删除");
    },
    [activeKnowledgeCategoryId, knowledgeCategories, knowledgeItems],
  );

  const moveKnowledgeItem = useCallback(
    (itemId: string, categoryId: string) => {
      if (!knowledgeCategories.some((category) => category.id === categoryId)) {
        setNotice("目标知识分类不存在");
        return;
      }

      setKnowledgeItems((current) =>
        current.map((item) =>
          item.id === itemId && item.categoryId !== categoryId
            ? { ...item, categoryId, updatedAt: "刚刚" }
            : item,
        ),
      );
      setActiveKnowledgeCategoryId(categoryId);
      setNotice("知识点分类已更新");
    },
    [knowledgeCategories],
  );

  const updateKnowledgeItem = useCallback(
    (
      itemId: string,
      patch: Pick<
        KnowledgeItem,
        "title" | "summary" | "content" | "sourceDescription" | "tags"
      >,
    ) => {
      setKnowledgeItems((current) =>
        current.map((item) =>
          item.id === itemId ? { ...item, ...patch, updatedAt: "刚刚" } : item,
        ),
      );
      setNotice("知识点已更新");
    },
    [],
  );

  const deleteKnowledgeItem = useCallback(
    (itemId: string) => {
      const item = knowledgeItems.find((entry) => entry.id === itemId);
      if (!item) return;
      const confirmed = window.confirm(`删除知识点「${item.title}」？`);
      if (!confirmed) return;

      setKnowledgeItems((current) => current.filter((entry) => entry.id !== itemId));
      if (activeKnowledgeItemId === itemId) {
        setActiveKnowledgeItemId(null);
      }
      if (knowledgeReturnItemId === itemId) {
        setKnowledgeReturnItemId(null);
      }
      setNotice("知识点已删除");
    },
    [activeKnowledgeItemId, knowledgeItems, knowledgeReturnItemId],
  );

  const openSourceNote = useCallback(
    (noteId: string, knowledgeItemId?: string) => {
      const note = notes.find((item) => item.id === noteId);
      if (!note) {
        setNotice("原始笔记不存在");
        return;
      }
      setKnowledgeReturnItemId(knowledgeItemId ?? null);
      setActiveNotebookId(note.notebookId);
      setActiveNoteId(note.id);
      setSearchQuery("");
      setViewMode("notes");
    },
    [notes],
  );

  const returnToKnowledgeItem = useCallback(() => {
    if (!knowledgeReturnItem) return;
    setActiveKnowledgeCategoryId(knowledgeReturnItem.categoryId);
    setActiveKnowledgeItemId(knowledgeReturnItem.id);
    setKnowledgeReturnItemId(null);
    setViewMode("knowledge");
  }, [knowledgeReturnItem]);

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

  return (
    <div className="flex h-full min-h-0 bg-background">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 bg-background px-3">
          <div className="flex min-w-0 items-center gap-2">
            {activeNotebook ? (
              <NotebookSelect
                notebooks={notebooks}
                activeNotebook={activeNotebook}
                onSelect={selectNotebook}
                onCreateNotebook={createNotebook}
                onRenameNotebook={renameActiveNotebook}
                onEditNotebookDescription={editActiveNotebookDescription}
                onToggleKnowledgeBase={toggleActiveNotebookKnowledgeBase}
                onDeleteNotebook={deleteActiveNotebook}
              />
            ) : null}
            <div className="flex items-center rounded-lg border border-border/70 bg-muted/30 p-0.5">
              <ModeButton active={viewMode === "notes"} onClick={() => setViewMode("notes")}>
                笔记
              </ModeButton>
              <ModeButton active={viewMode === "knowledge"} onClick={() => setViewMode("knowledge")}>
                知识
              </ModeButton>
            </div>
            {notice ? (
              <span className="hidden rounded-full border border-border/70 bg-muted/35 px-2 py-1 text-[11px] font-medium text-muted-foreground lg:inline-flex">
                {notice}
              </span>
            ) : null}
            {searchOpen ? (
              <div className="hidden h-8 min-w-[160px] max-w-[220px] items-center gap-1 rounded-lg border border-border/70 bg-background px-2 md:flex">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  autoFocus
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
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <IconButton label="新建笔记" onClick={() => createNote()}>
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton
              label="搜索笔记"
              active={searchOpen}
              onClick={() => setSearchOpen((current) => !current)}
            >
              <Search className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label="导出 Markdown" disabled={!activeNote} onClick={exportActiveNote}>
              <Download className="h-3.5 w-3.5" />
            </IconButton>
            {licenseActive && (
              <IconButton
                label={agentPanelCollapsed ? "展开 Agent 联动" : "收起 Agent 联动"}
                active={!agentPanelCollapsed}
                onClick={() => setAgentPanelCollapsed((current) => !current)}
              >
                <Bot className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {storageError ? (
            <div className="flex flex-1 items-center justify-center px-8 text-center text-[13px] text-destructive">
              {storageError}
            </div>
          ) : !storageReady ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              正在加载笔记...
            </div>
          ) : viewMode === "knowledge" ? (
            <KnowledgeView
              categories={knowledgeCategories}
              items={knowledgeItems}
              activeCategoryId={activeKnowledgeCategoryId}
              notes={notes}
              onSelectCategory={setActiveKnowledgeCategoryId}
              onOpenSourceNote={openSourceNote}
              onMoveItem={moveKnowledgeItem}
              onUpdateItem={updateKnowledgeItem}
              onDeleteItem={deleteKnowledgeItem}
              onCreateCategory={createKnowledgeCategoryManually}
              onRenameCategory={renameKnowledgeCategory}
              onDeleteCategory={deleteKnowledgeCategory}
            />
          ) : (
            <>
              <aside className="hidden w-[224px] shrink-0 border-r border-border/70 bg-sidebar/35 md:block">
                <NoteList
                  notes={visibleNotes}
                  activeNoteId={activeNote?.id ?? null}
                  totalCount={notebookNotes.length}
                  emptyLabel={searchQuery ? "没有匹配的笔记。" : "当前笔记本还没有笔记。"}
                  onSelect={setActiveNoteId}
                  onCopyMarkdown={copyNoteMarkdown}
                  onDuplicate={duplicateNote}
                  onEditTags={editNoteTags}
                  onMoveToNotebook={moveNote}
                  onDelete={deleteNote}
                  onCreateNote={createNote}
                  notebooks={notebooks}
                />
              </aside>
              {activeNote ? (
                <NoteEditor
                  note={activeNote}
                  saveStatus={saveStatus}
                  knowledgeReturnTitle={
                    shouldShowKnowledgeReturn ? knowledgeReturnItem?.title : undefined
                  }
                  onReturnToKnowledge={
                    shouldShowKnowledgeReturn ? returnToKnowledgeItem : undefined
                  }
                  onTitleChange={(title) => updateActiveNote({ title })}
                  onContentChange={(next) =>
                    updateActiveNote({
                      contentMarkdown: next.contentMarkdown,
                      contentJson: next.contentJson,
                      plainText: next.plainText,
                      preview: next.plainText.slice(0, 46) || "空白笔记",
                    })
                  }
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
                  当前笔记本还没有笔记。
                </div>
              )}
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
        knowledgeCategories={knowledgeCategories}
        knowledgeTags={knowledgeTags}
        collapsed={agentPanelCollapsed}
        width={agentPanelWidth}
        onAgentChatIdChange={(agentChatId) => updateActiveNote({ agentChatId })}
        onApplyResult={applyAiResult}
        onSaveKnowledge={saveKnowledgeFromAgent}
        onAutoTag={(tags) => {
          if (!activeNote) return;
          const merged = Array.from(new Set([...activeNote.tags, ...tags]));
          updateActiveNote({ tags: merged });
        }}
        onClearChat={() => updateActiveNote({ agentChatId: undefined })}
      />
    </div>
  );
}

function ModeButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
      )}
    >
      {children}
    </button>
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
        "h-8 w-8 rounded-lg border border-border/70 bg-background text-muted-foreground shadow-none hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </Button>
  );
}

function ensureKnowledgeCategoryPath(
  categories: KnowledgeCategory[],
  categoryName: string,
): { categories: KnowledgeCategory[]; category: KnowledgeCategory } {
  const path = normalizeKnowledgeCategoryPath(categoryName);
  let nextCategories = categories;
  let parentId: string | null = null;
  let category: KnowledgeCategory | null = null;

  for (const name of path) {
    category =
      nextCategories.find(
        (item) =>
          (item.parentId ?? null) === parentId &&
          item.name.trim().toLowerCase() === name.toLowerCase(),
      ) ?? null;

    if (!category) {
      category = createKnowledgeCategory(name, parentId);
      nextCategories = [...nextCategories, category];
    }
    parentId = category.id;
  }

  if (!category) {
    throw new Error("知识分类名称无效");
  }

  return { categories: nextCategories, category };
}

function normalizeKnowledgeCategoryPath(categoryName: string): string[] {
  const path = categoryName
    .split(/[/>｜|]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 6);

  if (path.length === 0) {
    throw new Error("知识分类名称无效");
  }

  return path;
}

function hasSiblingCategoryName(
  categories: KnowledgeCategory[],
  name: string,
  parentId: string | null,
  excludeCategoryId?: string,
): boolean {
  const normalizedName = name.trim().toLowerCase();
  return categories.some(
    (category) =>
      category.id !== excludeCategoryId &&
      (category.parentId ?? null) === parentId &&
      category.name.trim().toLowerCase() === normalizedName,
  );
}

function createKnowledgeLinkedNote(
  note: OperationNote,
  description: string,
): KnowledgeLinkedNote {
  return {
    noteId: note.id,
    noteTitle: note.title || "未命名笔记",
    description: description.trim() || "来自当前笔记",
    linkedAt: "刚刚",
  };
}

function getKnowledgeLinkedNotes(item: KnowledgeItem): KnowledgeLinkedNote[] {
  const result: KnowledgeLinkedNote[] = [];
  const upsert = (linkedNote: KnowledgeLinkedNote) => {
    if (!linkedNote.noteId) return;
    const existingIndex = result.findIndex((item) => item.noteId === linkedNote.noteId);
    if (existingIndex >= 0) {
      result[existingIndex] = linkedNote;
      return;
    }
    result.push(linkedNote);
  };

  upsert({
    noteId: item.sourceNoteId,
    noteTitle: item.sourceNoteTitle || "未命名笔记",
    description: item.sourceDescription || "原始笔记",
    linkedAt: item.updatedAt,
  });
  for (const linkedNote of item.linkedNotes ?? []) {
    upsert(linkedNote);
  }

  return result;
}

function mergeKnowledgeLinkedNotes(
  item: KnowledgeItem,
  nextLinkedNote: KnowledgeLinkedNote,
): KnowledgeLinkedNote[] {
  const byNoteId = new Map<string, KnowledgeLinkedNote>();
  for (const linkedNote of getKnowledgeLinkedNotes(item)) {
    byNoteId.set(linkedNote.noteId, linkedNote);
  }
  byNoteId.set(nextLinkedNote.noteId, nextLinkedNote);
  return Array.from(byNoteId.values());
}

function mergeTags(current: string[], next: string[]): string[] {
  return normalizeKnowledgeTags([...current, ...next]);
}

function normalizeKnowledgeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 4);
}

function normalizeKnowledgeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function isKnowledgeItemLinkedToNote(item: KnowledgeItem | null, noteId: string): boolean {
  if (!item || !noteId) return false;
  return getKnowledgeLinkedNotes(item).some((linkedNote) => linkedNote.noteId === noteId);
}

function serializeNotesState(state: {
  notebooks: Notebook[];
  notes: OperationNote[];
  knowledgeCategories: KnowledgeCategory[];
  knowledgeItems: KnowledgeItem[];
  activeNotebookId: string;
  activeNoteId: string | null;
  activeKnowledgeCategoryId: string;
}): string {
  return JSON.stringify(state);
}
