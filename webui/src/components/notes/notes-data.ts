import type { JSONContent } from "@tiptap/core";

export type NoteSourceKind = "agent" | "manual" | "ssh" | "windows";
export type NoteAiActionId = "summary" | "extractKnowledge" | "freeform" | "polish" | "translate" | "continue" | "generateHtml";

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
