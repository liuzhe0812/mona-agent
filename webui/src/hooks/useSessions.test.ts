import { describe, expect, it } from "vitest";

import { filterVisibleSessions } from "@/hooks/useSessions";
import type { ChatSummary } from "@/lib/types";

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
