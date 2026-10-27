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

describe("filterVisibleSessions", () => {
  it("drops hidden conversations even when the server leaks them", () => {
    const rows = [row("plain"), row("room", false), row("system_room", true)];

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
  it("keeps a rejected input and its attachments when history contains the same text in the same task", () => {
    const rejected: UIMessage = {
      id: "rejected", role: "user", content: "try again", taskId: "task", sendState: "rejected", createdAt: 20,
      media: [{ kind: "file", name: "brief.pdf" }],
    };
    const incoming: UIMessage = {
      id: "canonical", role: "user", content: "try again", taskId: "task", createdAt: 10, historyPosition: 0,
    };
    expect(reconcileHistoryMessages([rejected], [incoming])).toEqual([incoming, rejected]);
    expect(replaceHistoryRevision([rejected], [incoming])).toEqual([incoming, rejected]);
  });

  it("replaces an optimistic discussion bubble when canonical history keeps its raw text and display label", () => {
    const displayContent = "Started topic: growth or profit? · Debate · 3 rounds · Analyst A, Analyst B";
    const result = reconcileHistoryMessages(
      [
        {
          id: "optimistic-discussion",
          role: "user",
          content: "growth or profit?",
          displayContent,
          taskId: "task-discussion",
          createdAt: 10,
        },
      ],
      [
        {
          id: "canonical-discussion",
          role: "user",
          content: "growth or profit?",
          displayContent,
          createdAt: 11,
          historyPosition: 0,
        },
      ],
      { isStreaming: true, currentTaskId: "task-discussion" },
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "canonical-discussion",
      content: "growth or profit?",
      displayContent,
    });
  });

  it("reconciles by matching task identity even when the canonical timestamp differs", () => {
    const result = reconcileHistoryMessages(
      [
        {
          id: "optimistic-discussion",
          role: "user",
          content: "growth or profit?",
          displayContent: "Started topic: growth or profit?",
          taskId: "task-discussion",
          createdAt: 10,
        },
      ],
      [
        {
          id: "canonical-discussion",
          role: "user",
          content: "growth or profit?",
          displayContent: "Started topic: growth or profit?",
          taskId: "task-discussion",
          createdAt: 11,
          historyPosition: 0,
        },
      ],
      { isStreaming: true, currentTaskId: "task-discussion" },
    );

    expect(result.map((message) => message.id)).toEqual(["canonical-discussion"]);
  });

  it("does not match identical text when both task identities differ", () => {
    const result = reconcileHistoryMessages(
      [
        {
          id: "optimistic-current",
          role: "user",
          content: "same topic",
          displayContent: "same topic label",
          taskId: "task-current",
          createdAt: 20,
        },
      ],
      [
        {
          id: "canonical-other-task",
          role: "user",
          content: "same topic",
          displayContent: "same topic label",
          taskId: "task-other",
          createdAt: 21,
          historyPosition: 0,
        },
      ],
      { isStreaming: true, currentTaskId: "task-current" },
    );

    expect(result.map((message) => message.id)).toEqual([
      "canonical-other-task",
      "optimistic-current",
    ]);
  });

  it("keeps two intentional identical user sends when the second canonical row arrives", () => {
    const result = reconcileHistoryMessages(
      [
        {
          id: "canonical-first",
          role: "user",
          content: "same topic",
          displayContent: "same topic",
          createdAt: 10,
          historyPosition: 0,
        },
        {
          id: "optimistic-second",
          role: "user",
          content: "same topic",
          displayContent: "same topic",
          taskId: "task-second",
          createdAt: 20,
        },
      ],
      [
        {
          id: "canonical-first",
          role: "user",
          content: "same topic",
          displayContent: "same topic",
          createdAt: 10,
          historyPosition: 0,
        },
        {
          id: "canonical-second",
          role: "user",
          content: "same topic",
          displayContent: "same topic",
          createdAt: 21,
          historyPosition: 1,
        },
      ],
      { isStreaming: true, currentTaskId: "task-second" },
    );

    expect(result.map((message) => message.id)).toEqual([
      "canonical-first",
      "canonical-second",
    ]);
  });

  it("does not treat an older same-text history row as the echo of the active send", () => {
    const previous = {
      id: "canonical-old",
      role: "user" as const,
      content: "same topic",
      displayContent: "same topic label",
      createdAt: 10,
      historyPosition: 4,
    };
    const optimistic = {
      id: "optimistic-current",
      role: "user" as const,
      content: "same topic",
      displayContent: "same topic label",
      taskId: "task-current",
      createdAt: 20,
    };
    const result = reconcileHistoryMessages(
      [previous, optimistic],
      [previous],
      { isStreaming: true, currentTaskId: "task-current" },
    );

    expect(result.map((message) => message.id)).toEqual([
      "canonical-old",
      "optimistic-current",
    ]);
  });

  it("does not match an older canonical row when no current history position is loaded", () => {
    const result = reconcileHistoryMessages(
      [
        {
          id: "optimistic-current",
          role: "user",
          content: "same topic",
          displayContent: "same topic label",
          taskId: "task-current",
          createdAt: 20,
        },
      ],
      [
        {
          id: "canonical-old",
          role: "user",
          content: "same topic",
          displayContent: "same topic label",
          createdAt: 10,
          historyPosition: 4,
        },
      ],
      { isStreaming: true, currentTaskId: "task-current" },
    );

    expect(result.map((message) => message.id)).toEqual([
      "canonical-old",
      "optimistic-current",
    ]);
  });

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

  it("does not collapse an active send into an older page with the same text", () => {
    const merged = mergeHistoryMessages(
      [
        {
          id: "optimistic-current",
          role: "user",
          content: "same topic",
          displayContent: "same topic label",
          taskId: "task-current",
          createdAt: 20,
        },
      ],
      [
        {
          id: "canonical-from-earlier-page",
          role: "user",
          content: "same topic",
          displayContent: "same topic label",
          createdAt: 20,
          historyPosition: 4,
        },
      ],
    );

    expect(merged.map((message) => message.id)).toEqual([
      "canonical-from-earlier-page",
      "optimistic-current",
    ]);
  });
});
