import type { JSONContent } from "@tiptap/core";

export type NoteSourceKind = "agent" | "manual" | "ssh" | "windows";
export type NoteAiActionId = "summary" | "extractKnowledge" | "freeform" | "polish" | "translate" | "continue" | "generateHtml";

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
