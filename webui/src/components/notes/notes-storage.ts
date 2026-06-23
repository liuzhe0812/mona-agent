import {
  isTauri,
  loadDesktopNotesState,
  saveDesktopNotesState,
} from "@/lib/tauri";

import type {
  KnowledgeCategory,
  KnowledgeItem,
  Notebook,
  NoteSourceKind,
  NoteTransformation,
  OperationNote,
} from "./notes-data";
import { nowTimestamp } from "./notes-data";

export interface NotesStorageState {
  notebooks: Notebook[];
  notes: OperationNote[];
  knowledgeCategories: KnowledgeCategory[];
  knowledgeItems: KnowledgeItem[];
  activeNotebookId: string;
  activeNoteId: string | null;
  activeKnowledgeCategoryId: string;
  transformations: NoteTransformation[];
}

export async function loadNotesState(): Promise<NotesStorageState> {
  ensureDesktopRuntime();
  return loadDesktopNotesState() as Promise<NotesStorageState>;
}

export async function saveNotesState(state: NotesStorageState): Promise<void> {
  ensureDesktopRuntime();
  await saveDesktopNotesState(state);
}

export function createBlankNote(
  notebookId: string,
  sourceKind: NoteSourceKind = "manual",
): OperationNote {
  const isSsh = sourceKind === "ssh";

  return {
    id: createId("note"),
    notebookId,
    title: isSsh ? "SSH 会话记录" : "未命名笔记",
    preview: isSsh ? "记录 SSH 命令、输出和处理思路。" : "新的笔记。",
    updatedAt: nowTimestamp(),
    source: isSsh
      ? { kind: "ssh", label: "SSH 记录" }
      : { kind: "manual", label: "手动记录" },
    tags: isSsh ? ["SSH", "草稿"] : ["草稿"],
    contentMarkdown: isSsh
      ? "## SSH 会话记录\n\n```bash\n# 在这里粘贴命令和输出\n```\n\n## 判断\n\n"
      : "",
    appliedAgentMessageIds: [],
    contextLevel: "full",
  };
}

export function createNoteId(): string {
  return createId("note");
}

export function createKnowledgeItemId(): string {
  return createId("knowledge");
}

export function createKnowledgeCategory(name: string, parentId: string | null = null): KnowledgeCategory {
  return {
    id: createId("knowledge-category"),
    name,
    parentId,
  };
}

export function createCustomNotebook(name: string): Notebook {
  return {
    id: createId("notebook"),
    name,
    knowledgeBaseEnabled: false,
  };
}

export function createTransformation(
  name: string,
  promptTemplate: string,
  description = "",
): NoteTransformation {
  const now = nowTimestamp();
  return {
    id: createId("transformation"),
    name,
    description,
    promptTemplate,
    createdAt: now,
    updatedAt: now,
  };
}

function ensureDesktopRuntime(): void {
  if (typeof window === "undefined" || !isTauri()) {
    throw new Error("笔记存储需要在桌面端运行");
  }
}

function createId(prefix: string): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("当前环境不支持安全 ID 生成");
  }
  return `${prefix}-${crypto.randomUUID()}`;
}
