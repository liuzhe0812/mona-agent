import { describe, expect, it } from "vitest";

import {
  assistantOrdinalForMessage,
  filterVisibleSessions,
  mergeHistoryMessages,
  reconcileHistoryMessages,
  replaceHistoryRevision,
} from "@/hooks/useSessions";
import type { ChatSummary, UIMessage } from "@/lib/types";

function row(key: string, hidden?: boolean): ChatSummary {
  return {
    key: `websocket:${key}`,
    channel: "websocket",
    chatId: key,
    createdAt: null,
    updatedAt: null,
    preview: "",
    conversation:
      hidden == null
        ? undefined
        : { type: "room", title: key, agentIds: [], hidden },
  };
}

describe("filterVisibleSessions (stock hidden-room fallback)", () => {
  it("drops hidden conversations even when the server leaks them", () => {
    const rows = [row("plain"), row("room", false), row("stock_research", true)];

    expect(filterVisibleSessions(rows).map((s) => s.chatId)).toEqual([
      "plain",
      "room",
    ]);
  });
});

describe("assistantOrdinalForMessage", () => {
  it("uses global ordinals and increments from the last known value for live tail rows", () => {
    const messages: UIMessage[] = [
      { id: "old", role: "assistant", content: "old reply", createdAt: 1, assistantOrdinal: 148 },
      { id: "trace", role: "tool", content: "tool call", createdAt: 2, kind: "trace" },
      { id: "live", role: "assistant", content: "streaming reply", createdAt: 3 },
      { id: "next", role: "assistant", content: "later reply", createdAt: 4, assistantOrdinal: 150 },
    ];

    expect(assistantOrdinalForMessage(messages, "old")).toBe(148);
    expect(assistantOrdinalForMessage(messages, "live")).toBe(149);
    expect(assistantOrdinalForMessage(messages, "next")).toBe(150);
  });
});

describe("reconcileHistoryMessages", () => {
  it("replaces a live final answer with its canonical row without duplicating the turn", () => {
    const result = reconcileHistoryMessages(
      [
        { id: "prefix", role: "user", content: "question", createdAt: 1, historyPosition: 0 },
        { id: "live-final", role: "assistant", content: "final answer", createdAt: 9 },
      ],
      [
        { id: "canonical-final", role: "assistant", content: "final answer", createdAt: 2, taskId: "task-1", historyPosition: 1 },
      ],
    );

    expect(result.map((message) => message.id)).toEqual(["prefix", "canonical-final"]);
  });

  it("drops old canonical prefix rows when a new revision truncates the transcript", () => {
    const result = replaceHistoryRevision(
      [
        { id: "old-0", role: "user", content: "old 0", createdAt: 1, historyPosition: 0 },
        { id: "old-1", role: "assistant", content: "old 1", createdAt: 2, historyPosition: 1 },
        { id: "old-2", role: "user", content: "old 2", createdAt: 3, historyPosition: 2 },
      ],
      [
        { id: "new-0", role: "user", content: "new 0", createdAt: 4, historyPosition: 0 },
        { id: "new-1", role: "assistant", content: "new 1", createdAt: 5, historyPosition: 1 },
      ],
    );

    expect(result.map((message) => message.id)).toEqual(["new-0", "new-1"]);
  });

  it("clears ended rows on a missing transcript but retains a live task", () => {
    const result = reconcileHistoryMessages(
      [
        { id: "old", role: "assistant", content: "persisted", createdAt: 1, historyPosition: 0 },
        { id: "live", role: "assistant", content: "working", createdAt: 2, taskId: "task-2", isStreaming: true },
      ],
      [],
      { missing: true, isStreaming: true, currentTaskId: "task-2" },
    );

    expect(result.map((message) => message.id)).toEqual(["live"]);
  });

  it("keeps canonical rows before active live rows when replay timestamps are synthetic", () => {
    const merged = mergeHistoryMessages(
      [{ id: "live", role: "assistant", content: "current answer", createdAt: 9_999 }],
      [{ id: "canonical", role: "user", content: "earlier prompt", createdAt: 100, historyPosition: 4 }],
    );

    expect(merged.map((message) => message.id)).toEqual(["canonical", "live"]);
  });
});
