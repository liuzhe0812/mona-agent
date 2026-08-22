import { describe, expect, it } from "vitest";

import {
  DEFAULT_SIDEBAR_STATE,
  isSessionUnread,
  markAllSessionsRead,
  markSessionRead,
  normalizeSidebarState,
} from "@/hooks/useSidebarState";

describe("normalizeSidebarState (IM plan 12.4 schema v5)", () => {
  it("defaults to schema v5 with an empty last-read map", () => {
    expect(normalizeSidebarState(null)).toEqual(DEFAULT_SIDEBAR_STATE);
    expect(DEFAULT_SIDEBAR_STATE.schema_version).toBe(5);
    expect(DEFAULT_SIDEBAR_STATE.last_read_at_by_key).toEqual({});
  });

  it("keeps existing last-read markers and drops invalid entries", () => {
    const state = normalizeSidebarState({
      schema_version: 5,
      pinned_keys: ["websocket:a"],
      last_read_at_by_key: {
        "websocket:a": "2026-08-14T10:05:00+08:00",
        "": "2026-08-14T10:06:00+08:00",
        "websocket:b": "",
        "websocket:c": 123,
      },
    });
    expect(state.schema_version).toBe(5);
    expect(state.last_read_at_by_key).toEqual({
      "websocket:a": "2026-08-14T10:05:00+08:00",
    });
  });

  it("treats a v1 payload without markers as fully read until seeded by the server", () => {
    const state = normalizeSidebarState({
      schema_version: 1,
      pinned_keys: ["websocket:a"],
    });
    expect(state.schema_version).toBe(5);
    expect(state.pinned_keys).toEqual(["websocket:a"]);
    expect(state.last_read_at_by_key).toEqual({});
  });
});

describe("isSessionUnread (IM plan 11.1)", () => {
  const agentActivity = {
    previewAt: "2026-08-14T10:05:00+08:00",
    previewAuthorType: "agent" as const,
  };

  it("flags agent/system activity after the last-read marker as unread", () => {
    expect(isSessionUnread(agentActivity, "2026-08-14T10:00:00+08:00")).toBe(true);
    expect(isSessionUnread(agentActivity, "2026-08-14T10:05:00+08:00")).toBe(false);
    expect(isSessionUnread(agentActivity, "2026-08-14T10:06:00+08:00")).toBe(false);
  });

  it("never flags the user's own messages as unread", () => {
    expect(
      isSessionUnread(
        { previewAt: "2026-08-14T10:05:00+08:00", previewAuthorType: "user" },
        null,
      ),
    ).toBe(false);
  });

  it("treats a missing marker as unread for non-user activity", () => {
    expect(isSessionUnread(agentActivity, null)).toBe(true);
    expect(isSessionUnread(agentActivity, undefined)).toBe(true);
  });

  it("stays read when the session has no visible activity", () => {
    expect(
      isSessionUnread({ previewAt: null, previewAuthorType: "agent" }, null),
    ).toBe(false);
  });
});

describe("markSessionRead (IM plan 11.2)", () => {
  const base = {
    ...DEFAULT_SIDEBAR_STATE,
    last_read_at_by_key: { "websocket:a": "2026-08-14T10:00:00+08:00" },
  };

  it("advances the marker to the seen preview timestamp", () => {
    const next = markSessionRead(base, "websocket:a", "2026-08-14T10:05:00+08:00");
    expect(next.last_read_at_by_key["websocket:a"]).toBe("2026-08-14T10:05:00+08:00");
  });

  it("seeds a marker for a session read for the first time", () => {
    const next = markSessionRead(base, "websocket:b", "2026-08-14T10:05:00+08:00");
    expect(next.last_read_at_by_key["websocket:b"]).toBe("2026-08-14T10:05:00+08:00");
    expect(next.last_read_at_by_key["websocket:a"]).toBe("2026-08-14T10:00:00+08:00");
  });

  it("never moves the marker backwards", () => {
    const next = markSessionRead(base, "websocket:a", "2026-08-14T09:00:00+08:00");
    expect(next).toBe(base);
  });

  it("ignores sessions without a preview timestamp", () => {
    expect(markSessionRead(base, "websocket:a", null)).toBe(base);
    expect(markSessionRead(base, "websocket:a", undefined)).toBe(base);
  });

  it("keeps a read marker after state reconstruction", () => {
    const marked = markSessionRead(
      base,
      "websocket:restart",
      "2026-08-14T10:05:00+08:00",
    );
    const restored = normalizeSidebarState(JSON.parse(JSON.stringify(marked)));

    expect(isSessionUnread(
      { previewAt: "2026-08-14T10:05:00+08:00", previewAuthorType: "agent" },
      restored.last_read_at_by_key["websocket:restart"],
    )).toBe(false);
  });
});

describe("markAllSessionsRead", () => {
  it("advances every session marker to its latest visible activity", () => {
    const next = markAllSessionsRead(DEFAULT_SIDEBAR_STATE, [
      {
        key: "websocket:a",
        channel: "websocket",
        chatId: "a",
        createdAt: null,
        updatedAt: null,
        preview: "",
        previewAt: "2026-08-18T10:00:00Z",
      },
      {
        key: "websocket:b",
        channel: "websocket",
        chatId: "b",
        createdAt: null,
        updatedAt: null,
        preview: "",
        previewAt: "2026-08-18T11:00:00Z",
      },
    ]);

    expect(next.last_read_at_by_key).toEqual({
      "websocket:a": "2026-08-18T10:00:00Z",
      "websocket:b": "2026-08-18T11:00:00Z",
    });
  });
});
