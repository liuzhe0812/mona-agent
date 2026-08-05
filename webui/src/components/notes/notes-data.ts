import type { JSONContent } from "@tiptap/core";

export type NoteSourceKind = "agent" | "manual" | "ssh" | "windows";
export type NoteAiActionId = "summary" | "freeform" | "translate" | "generateHtml";

/** Context level controls how a note participates in knowledge-base retrieval. */
export type NoteContextLevel = "full" | "summary" | "none";

export const NOTE_CONTEXT_LEVELS: NoteContextLevel[] = ["full", "summary", "none"];

export const NOTE_CONTEXT_LEVEL_LABELS: Record<NoteContextLevel, string> = {
  full: "完整内容",
  summary: "仅摘要",
  none: "不参与",
};

/** Note type controls the role of a note in the vault. */
export type NoteType =
  | "note"
  | "mindmap"
  | "flowchart"
  | "diagram"
  | "moc"
  | "daily"
  | "template"
  | "agent-experience";

export const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  note: "笔记",
  mindmap: "思维导图",
  flowchart: "流程图",
  diagram: "图表",
  moc: "MOC 索引",
  daily: "每日笔记",
  template: "模板",
  "agent-experience": "Agent 经验",
};

/**
 * A user-defined AI transformation template for notes.
 * The prompt template supports variables:
 * - {{note_title}}   - note title
 * - {{note_content}} - note markdown content
 * - {{note_source}}  - source label
 */
export interface NoteTransformation {
  id: string;
  name: string;
  description: string;
  promptTemplate: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
}

/** Variables that can be inserted into a transformation prompt template. */
export const TRANSFORMATION_VARIABLES: Array<{ token: string; label: string; description: string }> = [
  { token: "{{note_title}}", label: "笔记标题", description: "当前笔记的标题" },
  { token: "{{note_content}}", label: "笔记内容", description: "笔记的 Markdown 全文" },
  { token: "{{note_source}}", label: "笔记来源", description: "笔记的来源标签" },
];

/** Format an ISO timestamp into a human-readable relative time string. */
export function formatRelativeTime(timestamp: string): string {
  // Defensive: if timestamp is not a parseable ISO string, return as-is.
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return timestamp;

  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** Return current time as ISO string for updatedAt fields. */
export function nowTimestamp(): string {
  return new Date().toISOString();
}

export interface Notebook {
  id: string;
  name: string;
}

export interface OperationNote {
  id: string;
  notebookId: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  source: {
    kind: NoteSourceKind;
    label: string;
  };
  contentMarkdown: string;
  contentJson?: JSONContent;
  plainText?: string;
  agentChatId?: string;
  appliedAgentMessageIds?: string[];
  /** Context level for knowledge-base retrieval. Defaults to "full". */
  contextLevel?: NoteContextLevel;
  /** Note type. Defaults to "note". MOC notes are index notes that organize other notes via [[links]]. */
  type?: NoteType;
  /** Aliases used for [[wiki link]] matching besides the title. */
  aliases?: string[];
  /** Whether the note is starred/favorited by the user. */
  favorite?: boolean;
}

// ---------------------------------------------------------------------------
// Bidirectional links / graph data
// ---------------------------------------------------------------------------

export interface LinkNode {
  id: string;
  title: string;
  path: string;
  aliases: string[];
  noteType: string;
}

export interface LinkEdge {
  source: string;
  targetTitle: string;
  resolvedTarget: string | null;
  kind: "link" | "embed";
  anchor: string | null;
}

export interface LinkGraph {
  nodes: LinkNode[];
  edges: LinkEdge[];
  lastScanAt: string;
}

export interface BacklinkItem {
  noteId: string;
  title: string;
  path: string;
  snippet: string;
  line: number;
}

export interface MentionItem {
  noteId: string;
  title: string;
  path: string;
  snippet: string;
  line: number;
}

export interface RenameResult {
  updatedFiles: number;
  updatedLinks: number;
}

export interface MocItem {
  id: string;
  title: string;
  path: string;
  outgoingCount: number;
  incomingCount: number;
}
