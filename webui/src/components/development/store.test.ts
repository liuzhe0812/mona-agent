import { beforeEach, describe, expect, it } from "vitest";
import type { DevSnapshot } from "@/lib/development-api";
import { EMPTY_VIEW, fileKey, migrateDevelopmentViews, useDevelopmentStore } from "./store";

beforeEach(() => { localStorage.clear(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true); });

function snapshot(from: number, to: number): DevSnapshot {
  return { session: { id: "dev_a", projectId: "project_a", executor: "mona", title: "A", model: null, readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "" },
    messages: Array.from({ length: to - from }, (_, i) => ({ id: `m${from + i}`, role: "user", content: String(from + i), toolCalls: [], queued: false, truncated: false })),
    before: from || null, messageCount: to, runs: [], events: [], eventCursor: 0, pendingInputs: [], live: null };
}

describe("development view state", () => {
  it("retains operation starts across long streams instead of dropping the first 256 events", () => {
    const s = useDevelopmentStore.getState();
    const initial = snapshot(0, 1);
    initial.events = [{ id: "start", sequence: 1, type: "command.started", runId: "run", payload: { id: "command", command: "npm test" } }];
    initial.eventCursor = 1;
    s.setSnapshot("dev_a", initial);
    const next = { ...initial, eventCursor: 301, events: Array.from({ length: 300 }, (_, i) => ({ id: `delta-${i}`, sequence: i + 2, type: "command.output", runId: "run", payload: { itemId: "command", delta: "." } })) };
    s.setSnapshot("dev_a", next);
    const events = useDevelopmentStore.getState().snapshots.dev_a.events;
    expect(events).toHaveLength(301);
    expect(events[0]).toBe(initial.events[0]);
  });
  it("switches the single active conversation without losing other sessions or drafts", () => {
    const s = useDevelopmentStore.getState();
    s.openSession("project_a", "dev_a"); s.setDraft("dev_a", "A draft");
    s.openSession("project_a", "dev_b"); s.setDraft("dev_b", "B draft");
    expect(useDevelopmentStore.getState().views.project_a).toEqual({ sessionId: "dev_b" });
    s.openSession("project_b", "dev_c");
    expect(useDevelopmentStore.getState().projectId).toBe("project_b");
    expect(useDevelopmentStore.getState().views.project_a.sessionId).toBe("dev_b");
    expect(useDevelopmentStore.getState().drafts).toEqual({ dev_a: "A draft", dev_b: "B draft" });
    expect(EMPTY_VIEW).toEqual({ sessionId: null });
  });
  it("recovers the former focused view without deleting task drafts", () => {
    const migrated = migrateDevelopmentViews({ views: { project_a: { layout: 4, focus: 2, panes: ["dev_a", "dev_b", "dev_c", "dev_d"] } }, drafts: { dev_a: "keep" }, sides: { dev_c: { tab: "terminal", expanded: true, maximized: false } } });
    expect(migrated.views?.project_a).toEqual({ sessionId: "dev_c" });
    expect(migrated.drafts?.dev_a).toBe("keep");
    expect(migrated.sides?.dev_c.openTabs).toEqual(["terminal"]);
  });
  it("opens only requested tools and closing tabs leaves terminal and task state alive", () => {
    const s = useDevelopmentStore.getState();
    s.setTerminal("dev_a", { id: "shell_a", status: "ready" });
    s.setSide("dev_a", { tab: "terminal", expanded: true });
    s.setSide("dev_a", { tab: "workspace", expanded: true });
    s.setSide("dev_a", { tab: "terminal", expanded: true });
    expect(useDevelopmentStore.getState().sides.dev_a.openTabs).toEqual(["terminal", "workspace"]);
    s.closeSideTab("dev_a", "terminal");
    expect(useDevelopmentStore.getState().sides.dev_a.tab).toBe("overview");
    expect(useDevelopmentStore.getState().terminals.dev_a.id).toBe("shell_a");
  });
  it("collapses after the overview and last tool close, preserves work state, and reopens the overview", () => {
    const s = useDevelopmentStore.getState();
    s.setDraft("dev_a", "unsent task draft");
    s.setTerminal("dev_a", { id: "shell_a", status: "ready" });
    s.setSide("dev_a", { tab: "terminal", expanded: true, maximized: true });

    s.closeSideTab("dev_a", "overview");
    expect(useDevelopmentStore.getState().sides.dev_a).toMatchObject({ overviewOpen: false, expanded: true, tab: "terminal" });

    s.closeSideTab("dev_a", "terminal");
    expect(useDevelopmentStore.getState().sides.dev_a).toMatchObject({ overviewOpen: false, expanded: false, maximized: false, tab: "overview", openTabs: [] });
    expect(useDevelopmentStore.getState().terminals.dev_a).toEqual({ id: "shell_a", status: "ready" });
    expect(useDevelopmentStore.getState().drafts.dev_a).toBe("unsent task draft");

    s.setSide("dev_a", { expanded: true });
    expect(useDevelopmentStore.getState().sides.dev_a).toMatchObject({ overviewOpen: true, expanded: true, tab: "overview", openTabs: [] });
  });
  it("keeps equal-path file buffers and side panels scoped to the session", () => {
    const s = useDevelopmentStore.getState();
    const file = { path: "src/a.ts", content: "original", sha256: "hash", bom: false };
    s.loadFile("dev_a", file); s.loadFile("dev_b", file); s.editFile("dev_a", file.path, "manual edit");
    s.setSide("dev_a", { tab: "workspace", expanded: true });
    expect(useDevelopmentStore.getState().files[fileKey("dev_b", file.path)].draft).toBe("original");
    expect(useDevelopmentStore.getState().sides.dev_b).toBeUndefined();
  });
  it("does not accept a response belonging to another session", () => {
    useDevelopmentStore.getState().setSnapshot("dev_b", snapshot(0, 1));
    expect(useDevelopmentStore.getState().snapshots.dev_b).toBeUndefined();
  });
  it("preserves explicitly loaded history on the next live refresh without duplicate messages", () => {
    const s = useDevelopmentStore.getState();
    s.setSnapshot("dev_a", snapshot(100, 200));
    s.setSnapshot("dev_a", snapshot(0, 100), true);
    s.setSnapshot("dev_a", snapshot(100, 200));
    const value = useDevelopmentStore.getState().snapshots.dev_a;
    expect(value.messages).toHaveLength(200); expect(new Set(value.messages.map((m) => m.id)).size).toBe(200);
    expect(value.messages[0].id).toBe("m0"); expect(value.before).toBeNull();
  });
  it("keeps completed message references stable while only the streamed text changes", () => {
    const s = useDevelopmentStore.getState(); const initial = snapshot(0, 2);
    initial.events = [{ id: "e1", type: "run.started", sequence: 1, runId: "run_a", payload: {} }]; initial.eventCursor = 1;
    s.setSnapshot("dev_a", initial);
    const previous = useDevelopmentStore.getState().snapshots.dev_a;
    const next = JSON.parse(JSON.stringify(initial)); next.live = { runId: "run_a", content: "growing text" };
    s.setSnapshot("dev_a", next);
    const current = useDevelopmentStore.getState().snapshots.dev_a;
    expect(current.messages).toBe(previous.messages); expect(current.events).toBe(previous.events);
    expect(current.live?.content).toBe("growing text");
    const changed = JSON.parse(JSON.stringify(next)); changed.messages[1].content = "updated result";
    s.setSnapshot("dev_a", changed);
    expect(useDevelopmentStore.getState().snapshots.dev_a.messages[0]).toBe(previous.messages[0]);
    expect(useDevelopmentStore.getState().snapshots.dev_a.messages[1].content).toBe("updated result");
  });
  it("rejects late live snapshots without rolling back newer messages, routing or events", () => {
    const s = useDevelopmentStore.getState(); const initial = snapshot(0, 3);
    initial.eventCursor = 4; initial.session.revision = 2;
    s.setSnapshot("dev_a", initial); const current = useDevelopmentStore.getState().snapshots.dev_a;
    s.setSnapshot("dev_a", { ...initial, messageCount: 2 });
    s.setSnapshot("dev_a", { ...initial, eventCursor: 3 });
    s.setSnapshot("dev_a", { ...initial, session: { ...initial.session, revision: 1 } });
    expect(useDevelopmentStore.getState().snapshots.dev_a).toBe(current);
  });
  it("persists view drafts but not native runtime objects or live snapshots", () => {
    const s = useDevelopmentStore.getState(); s.selectProject("project_a"); s.setDraft("dev_a", "unsent");
    s.setSnapshot("dev_a", snapshot(0, 1)); s.setTerminal("dev_a", { id: "native_terminal", status: "ready" });
    const value = JSON.parse(localStorage.getItem("mona.development.workbench.v1")!).state;
    expect(value.drafts.dev_a).toBe("unsent"); expect(value.snapshots).toBeUndefined(); expect(value.terminals).toBeUndefined();
  });
});
