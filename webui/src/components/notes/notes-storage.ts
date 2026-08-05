import {
  isTauri,
  loadDesktopNotesState,
  saveDesktopNotesState,
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
import {
  createBlankDiagramDocument,
  type DiagramKind,
} from "./diagram/diagram-document";
import { serializeDiagramMarkdown } from "./diagram/diagram-serializer";

export interface NotesStorageState {
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

export function createBlankDiagramNote(
  notebookId: string,
  diagramKind: DiagramKind = "freeform",
): OperationNote {
  const doc = createBlankDiagramDocument(diagramKind);
  const md = serializeDiagramMarkdown("未命名图表", doc);
  return {
    id: createId("note"),
    notebookId,
    title: "未命名图表",
    preview: "图表",
    createdAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
    source: { kind: "manual", label: "手动记录" },
    contentMarkdown: md,
    appliedAgentMessageIds: [],
    contextLevel: "full",
    type: "diagram",
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
