import type { ReactNode } from "react";
import type { DevInput, DevMessage } from "@/lib/development-api";

export interface QueueItem extends DevInput {
  queueItemId: string;
  text: string;
  sourceCommandId: string;
  clientId: string;
  attachments?: DevMessage["media"];
  admittedAt: string;
  order: { admissionSeq: number };
  delivery: { admitted: "guide" | "queue" };
}

export interface QueueState {
  items: QueueItem[];
}

export interface UserInputRow {
  rowId: number;
  turnId: string;
  productTurnId: string;
  entityId: string;
  kind: "userInput";
  text: string;
  origin: "realUser";
  sourceCommandId: string;
  clientId: string;
  attachments?: DevMessage["media"];
  createdAt: string;
  createdAtSeq: number;
}

export interface ConversationRowRenderContext {
  renderUserInput: (row: UserInputRow, status: string) => ReactNode;
}
