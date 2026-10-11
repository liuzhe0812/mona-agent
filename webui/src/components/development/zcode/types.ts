/// <reference lib="es2023.array" />
import type { ReactNode } from "react";
import type { Activity } from "../DevelopmentActivity";

// Mona adapter for the row fields consumed by the copied ZCode flow builders.
interface Row { rowId: string; entityId?: string; createdAt?: number; content?: ReactNode }
export interface UserInputRow extends Row { kind: "userInput"; guided?: boolean }
export interface AssistantTextRow extends Row { kind: "assistantText" }
export interface WorkRow extends Row { kind: "toolCall" | "reasoning"; activity?: Activity; fullOutputContent?: ReactNode }
export interface TurnHeaderRow extends Row {
  kind: "turnHeader"; executionKind: "agent" | "controlOnly";
  startedAt: number; endedAt?: number; activeMs?: number;
  workSegments?: { triggerEntityId?: string; startedAt: number; endedAt?: number; activeMs?: number }[];
}
export type ConversationRow = UserInputRow | AssistantTextRow | WorkRow | TurnHeaderRow;
