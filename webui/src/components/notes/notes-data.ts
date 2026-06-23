import type { JSONContent } from "@tiptap/core";

export type NoteSourceKind = "agent" | "manual" | "ssh" | "windows";
export type NoteAiActionId = "summary" | "extractKnowledge" | "freeform" | "polish" | "translate" | "continue" | "generateHtml";

/** Context level controls how a note participates in knowledge-base retrieval. */
export type NoteContextLevel = "full" | "summary" | "none";

export const NOTE_CONTEXT_LEVELS: NoteContextLevel[] = ["full", "summary", "none"];

export const NOTE_CONTEXT_LEVEL_LABELS: Record<NoteContextLevel, string> = {
  full: "完整内容",
  summary: "仅摘要",
  none: "不参与",
};

/**
 * A user-defined AI transformation template for notes.
 * The prompt template supports variables:
 * - {{note_title}}   - note title
 * - {{note_content}} - note markdown content
 * - {{note_tags}}    - comma-separated tags
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
  { token: "{{note_tags}}", label: "笔记标签", description: "笔记的标签，逗号分隔" },
  { token: "{{note_source}}", label: "笔记来源", description: "笔记的来源标签" },
];

/** Format an ISO timestamp or relative label into a human-readable relative time string. */
export function formatRelativeTime(timestamp: string): string {
  // If it's not an ISO date, return as-is (legacy labels like "刚刚")
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
  knowledgeBaseEnabled: boolean;
}

export interface OperationNote {
  id: string;
  notebookId: string;
  title: string;
  preview: string;
  updatedAt: string;
  source: {
    kind: NoteSourceKind;
    label: string;
  };
  tags: string[];
  contentMarkdown: string;
  contentJson?: JSONContent;
  plainText?: string;
  agentChatId?: string;
  appliedAgentMessageIds?: string[];
  /** Context level for knowledge-base retrieval. Defaults to "full". */
  contextLevel?: NoteContextLevel;
}

export interface KnowledgeCategory {
  id: string;
  name: string;
  parentId?: string | null;
}

export interface KnowledgeLinkedNote {
  noteId: string;
  noteTitle: string;
  description: string;
  linkedAt: string;
}

export interface KnowledgeItem {
  id: string;
  categoryId: string;
  title: string;
  summary: string;
  content: string;
  sourceNoteId: string;
  sourceNoteTitle: string;
  sourceDescription: string;
  updatedAt: string;
  tags: string[];
  linkedNotes?: KnowledgeLinkedNote[];
}
