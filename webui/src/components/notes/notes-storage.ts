import {
  isTauri,
  loadDesktopNotesState,
  saveDesktopNotesState,
  deleteDesktopNotes,
} from "@/lib/tauri";

import type { WorkspaceState } from "./Workspace";
import type { RightTab } from "./RightSidebar";
import type {
  Notebook,
  NoteSourceKind,
  NoteTransformation,
  OperationNote,
} from "./notes-data";
import { nowTimestamp } from "./notes-data";
import { applyTemplate, type TemplateContext } from "./template-engine";
import {
  createBlankFlowchartDocument,
  serializeFlowchartMarkdown,
} from "./flowchart/flowchart-document";

export interface NotesStorageState {
  vaultToken?: string;
  notebooks: Notebook[];
  notes: OperationNote[];
  activeNotebookId: string;
  activeNoteId: string | null;
  transformations: NoteTransformation[];
  workspace?: WorkspaceState | null;
  rightSidebarOpen?: boolean;
  rightSidebarWidth?: number;
  rightActiveTab?: RightTab;
}

export async function loadNotesState(): Promise<NotesStorageState> {
  ensureDesktopRuntime();
  return loadDesktopNotesState() as Promise<NotesStorageState>;
}

let saveQueue: Promise<unknown> = Promise.resolve();
const localWrites = new Map<string, { original: string | undefined; current: string }>();

export function saveNotesState(state: NotesStorageState): Promise<Record<string, string>> {
  ensureDesktopRuntime();
  state = structuredClone(state);
  const vault = state.vaultToken;
  if (!vault || !/^[a-f0-9]{64}$/.test(vault)) return Promise.reject(new Error("请重新打开笔记仓库后再保存。"));
  const pending = saveQueue.catch(() => undefined).then(async () => {
    const notes = state.notes.map((note) => {
      const own = localWrites.get(`${vault}:${note.id}`);
      return own && note.storageRevision === own.original ? { ...note, storageRevision: own.current } : note;
    });
    const result = await saveDesktopNotesState({ ...state, notes });
    if (!result || typeof result !== "object" || notes.some((n) => !/^[a-f0-9]{64}$/.test(result[n.id] ?? ""))) {
      throw new Error("笔记保存结果尚未确认，请稍后重试。");
    }
    for (const note of state.notes) {
      const own = localWrites.get(`${vault}:${note.id}`);
      localWrites.set(`${vault}:${note.id}`, { original: own && note.storageRevision === own.original ? own.original : note.storageRevision,
        current: result[note.id] });
    }
    for (const id of localWrites.keys()) {
      if (id.startsWith(`${vault}:`) && !state.notes.some((note) => `${vault}:${note.id}` === id)) localWrites.delete(id);
    }
    return result;
  });
  saveQueue = pending;
  return pending;
}

export function deleteNotesState(selected: OperationNote[], vault: string | undefined): Promise<void> {
  ensureDesktopRuntime();
  if (!vault || !/^[a-f0-9]{64}$/.test(vault)) return Promise.reject(new Error("请重新打开笔记仓库后再删除。"));
  selected = structuredClone(selected);
  const pending = saveQueue.catch(() => undefined).then(async () => {
    const expected = Object.fromEntries(selected.map((note) => {
      const own = localWrites.get(`${vault}:${note.id}`);
      return [note.id, (own && note.storageRevision === own.original ? own.current : note.storageRevision) ?? null];
    }));
    await deleteDesktopNotes(selected.map((note) => note.id), vault, expected);
    for (const note of selected) localWrites.delete(`${vault}:${note.id}`);
  });
  saveQueue = pending;
  return pending;
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
    createdAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
    source: isSsh
      ? { kind: "ssh", label: "SSH 记录" }
      : { kind: "manual", label: "手动记录" },
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

export function createBlankMindMapNote(
  notebookId: string,
): OperationNote {
  return {
    id: createId("note"),
    notebookId,
    title: "未命名思维导图",
    preview: "思维导图",
    createdAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
    source: { kind: "manual", label: "手动记录" },
    contentMarkdown: "# 未命名思维导图",
    appliedAgentMessageIds: [],
    contextLevel: "full",
    type: "mindmap",
  };
}

export function createBlankFlowchartNote(
  notebookId: string,
): OperationNote {
  // 流程图笔记：contentMarkdown 由 serializer 生成（标题 + 文本投影 + JSON 围栏）。
  // 这里直接构造一个最简文档（仅开始和结束节点），保证首次打开即可编辑。
  const doc = createBlankFlowchartDocument();
  const md = serializeFlowchartMarkdown("未命名流程图", doc);
  return {
    id: createId("note"),
    notebookId,
    title: "未命名流程图",
    preview: "流程图",
    createdAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
    source: { kind: "manual", label: "手动记录" },
    contentMarkdown: md,
    appliedAgentMessageIds: [],
    contextLevel: "full",
    type: "flowchart",
  };
}

export function createNoteFromTemplate(
  template: OperationNote,
  notebookId: string,
  title: string,
  notebookName: string,
): OperationNote {
  const ctx: TemplateContext = { title, notebookName };
  const content = applyTemplate(template.contentMarkdown, ctx);
  const preview = content.replace(/[#*`>\-\[\]]/g, "").trim().slice(0, 46) || "空白笔记";
  const now = nowTimestamp();
  return {
    id: createId("note"),
    notebookId,
    title,
    preview,
    createdAt: now,
    updatedAt: now,
    source: { kind: "manual", label: "从模板创建" },
    contentMarkdown: content,
    appliedAgentMessageIds: [],
    contextLevel: "full",
  };
}

export function createCustomNotebook(name: string): Notebook {
  // Rust scan_vault 用文件夹名作为 notebook id，前端必须保持一致，
  // 否则保存后重启加载会导致 notebook_id 不匹配。
  return {
    id: name,
    name,
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
