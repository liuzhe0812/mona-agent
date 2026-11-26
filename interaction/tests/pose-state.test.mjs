import assert from "node:assert/strict";
import test from "node:test";
import { PoseState } from "../mona_interaction/web/pose-state.js";

const message = (type, payload, messageId = "one", sessionId = "session") => ({
  version: 1, session_id: sessionId, message_id: messageId, type, payload,
});
const snapshot = (state = "idle", pending = null, records = []) =>
  message("session.snapshot", { mode: "mona", state, pending_id: pending, records });

function fakeTimers() {
  const tasks = new Map();
  let next = 0;
  return {
    schedule(fn, delay) { const id = ++next; tasks.set(id, { fn, delay }); return id; },
    cancel(id) { tasks.delete(id); },
    callback(delay) { return [...tasks.values()].find((task) => task.delay === delay)?.fn; },
    run(delay) {
      const entry = [...tasks.entries()].find(([, task]) => task.delay === delay);
      assert.ok(entry);
      tasks.delete(entry[0]);
      entry[1].fn();
    },
    count() { return tasks.size; },
  };
}

test("actual session messages select work and dialogue without inferring success", () => {
  const states = [];
  const clock = fakeTimers();
  const controller = new PoseState({ sessionId: "session", onChange: (state) => states.push(state),
    schedule: clock.schedule, cancel: clock.cancel });
  const token = controller.connected();
  assert.equal(controller.handle(token, message("input.accepted", {})), false);
  assert.equal(controller.handle(token, snapshot()), true);
  assert.equal(controller.state.pose, "rest");
  assert.equal(controller.handle(token, message("input.accepted", {})), true);
  assert.equal(controller.state.pose, "work");
  assert.equal(controller.handle(token, message("reply.completed", { text: "" })), true);
  assert.equal(controller.state.pose, "dialogue");
  assert.equal(controller.handle(token, message("turn.state", { state: "idle" })), true);
  assert.equal(controller.handle(token, message("turn.state", { state: "thinking" })), false);
  assert.equal(controller.state.pose, "dialogue");
  clock.run(1500);
  assert.equal(controller.state.pose, "rest");
  assert.equal("success" in controller.state, false);
  assert.ok(states.length > 0);
});

test("new tasks and reconnected sessions invalidate old reply timers", () => {
  const clock = fakeTimers();
  const controller = new PoseState({ sessionId: "session", schedule: clock.schedule, cancel: clock.cancel });
  const first = controller.connected();
  controller.handle(first, snapshot());
  controller.handle(first, message("input.accepted", {}, "one"));
  controller.handle(first, message("reply.completed", { text: "回复" }, "one"));
  const stale = clock.callback(1500);
  controller.handle(first, message("turn.state", { state: "idle" }, "one"));
  controller.handle(first, message("input.accepted", {}, "two"));
  assert.equal(controller.state.pose, "work");
  stale();
  assert.equal(controller.state.pose, "work");
  assert.equal(controller.handle(first, snapshot("thinking", "one")), false);
  assert.equal(controller.state.pose, "work");
  controller.handle(first, message("reply.completed", { text: "回复" }, "two"));
  const beforeReconnect = clock.callback(1500);
  controller.disconnected(first);
  const second = controller.connected();
  controller.handle(second, snapshot("thinking", "three"));
  beforeReconnect();
  assert.equal(controller.state.pose, "work");
  assert.equal(controller.handle(first, message("turn.state", { state: "idle" }, "three")), false);
  controller.dispose();
  assert.equal(clock.count(), 0);
});

test("audio continues dialogue after the reply hold; duplicate replies do not extend it", () => {
  const clock = fakeTimers();
  const controller = new PoseState({ sessionId: "session", schedule: clock.schedule, cancel: clock.cancel });
  const connection = controller.connected();
  controller.handle(connection, snapshot());
  controller.handle(connection, message("input.accepted", {}));
  controller.handle(connection, message("reply.completed", { text: "回复" }));
  assert.equal(controller.handle(connection, message("reply.completed", { text: "回复" })), false);
  const playing = controller.playbackStarted("speech");
  controller.handle(connection, message("turn.state", { state: "idle" }));
  clock.run(1500);
  assert.equal(controller.state.pose, "dialogue");
  controller.playbackEnded(playing);
  assert.equal(controller.state.pose, "rest");
  controller.dispose();
});

test("disconnect preserves the pose; only the new connection snapshot can reconcile it", () => {
  const controller = new PoseState({ sessionId: "session" });
  const first = controller.connected();
  controller.handle(first, snapshot("thinking", "one"));
  assert.equal(controller.state.pose, "work");
  controller.disconnected(first);
  assert.equal(controller.state.connection, "offline");
  assert.equal(controller.state.pose, "work");
  const second = controller.connected();
  assert.equal(controller.handle(first, message("reply.completed", {})), false);
  assert.equal(controller.disconnected(first), false);
  assert.equal(controller.handle(second, message("reply.completed", {})), false);
  assert.equal(controller.state.pose, "work");
  assert.equal(controller.handle(second, snapshot()), true);
  assert.deepEqual(controller.state, { pose: "rest", connection: "ready", mode: "mona" });
});

test("unrelated or stale turn events cannot change the active pose", () => {
  const controller = new PoseState({ sessionId: "session" });
  const token = controller.connected();
  controller.handle(token, snapshot("idle", null, [{ message_id: "old", state: "unknown" }]));
  assert.equal(controller.handle(token, message("input.accepted", {}, "old")), false);
  assert.equal(controller.handle(token, message("input.accepted", {}, "one", "other")), false);
  controller.handle(token, message("turn.state", { state: "thinking" }, "two"));
  assert.equal(controller.handle(token, message("reply.completed", {}, "one")), false);
  assert.equal(controller.handle(token, message("turn.state", { state: "idle" }, "one")), false);
  assert.equal(controller.state.pose, "work");
  assert.equal(controller.handle(token, message("turn.state", { state: "idle" }, "two")), true);
  assert.equal(controller.state.pose, "rest");
});

test("actual voice events control dialogue and cannot hide an ongoing turn after they end", () => {
  const controller = new PoseState({ sessionId: "session" });
  const connection = controller.connected();
  controller.handle(connection, snapshot());
  const listening = controller.listeningStarted("mic-1");
  assert.equal(controller.state.pose, "dialogue");
  assert.equal(controller.listeningStarted("mic-2"), null);
  controller.handle(connection, message("input.accepted", {}));
  assert.equal(controller.state.pose, "dialogue");
  assert.equal(controller.listeningEnded({ id: "mic-1" }), false);
  assert.equal(controller.listeningEnded(listening), true);
  assert.equal(controller.state.pose, "work");
  const playing = controller.playbackStarted("speech-1");
  assert.equal(controller.state.pose, "dialogue");
  controller.disconnected(connection);
  assert.equal(controller.playbackEnded(playing), true);
  assert.equal(controller.state.pose, "work");
  const next = controller.connected();
  controller.handle(next, snapshot("thinking", "one"));
  const playingAgain = controller.playbackStarted("speech-1");
  assert.equal(controller.playbackEnded(playing), false);
  assert.equal(controller.state.pose, "dialogue");
  controller.handle(next, message("turn.state", { state: "idle" }));
  assert.equal(controller.state.pose, "dialogue");
  assert.equal(controller.playbackEnded(playingAgain), true);
  assert.equal(controller.state.pose, "rest");
});

test("a failed turn becomes rest only when its authoritative idle event arrives", () => {
  const controller = new PoseState({ sessionId: "session" });
  const token = controller.connected();
  controller.handle(token, snapshot());
  controller.handle(token, message("input.accepted", {}));
  assert.equal(controller.handle(token, message("error", { code: "connection_failed" })), false);
  assert.equal(controller.state.pose, "work");
  controller.handle(token, message("turn.state", { state: "idle" }));
  assert.equal(controller.state.pose, "rest");
  assert.equal("success" in controller.state, false);
});

test("invalid snapshots do not permit events; demo mode remains explicit", () => {
  const controller = new PoseState({ sessionId: "session" });
  const token = controller.connected();
  assert.equal(controller.handle(token, snapshot("thinking", null)), false);
  assert.equal(controller.handle(token, message("turn.state", { state: "thinking" })), false);
  assert.equal(controller.handle(token, message("session.snapshot", {
    mode: "demo", state: "idle", pending_id: null, records: [],
  })), true);
  assert.equal(controller.state.mode, "demo");
  assert.equal(controller.handle(token, message("turn.state", { state: "thinking" })), true);
});
