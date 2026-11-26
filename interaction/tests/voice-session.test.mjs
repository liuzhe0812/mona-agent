import assert from "node:assert/strict";
import test from "node:test";
import { VoiceSession } from "../mona_interaction/web/voice-session.js";

function setup() {
  const events = [];
  const session = new VoiceSession({
    onWake: () => events.push(["wake"]),
    onInput: (message) => events.push(["input", message]),
    onStopPlayback: (token) => events.push(["stop", token]),
    onClose: () => events.push(["close"]),
  });
  return { session, events };
}

test("wake is idempotent; only finalized input starts a turn", () => {
  const { session, events } = setup();
  assert.equal(session.state.status, "sleeping");
  assert.equal(session.submit({ messageId: "one", text: "你好" }), false);
  assert.equal(session.wake(), true);
  assert.equal(session.wake(), false);
  assert.equal(session.state.status, "listening");
  assert.throws(() => session.submit({ messageId: "one", text: " " }), TypeError);
  assert.equal(session.submit({ messageId: "one", text: "你好" }), true);
  assert.equal(session.state.status, "executing");
  assert.equal(session.submit({ messageId: "two", text: "第二句" }), false);
  assert.equal(session.turnEnded("other"), false);
  assert.equal(session.state.turnId, "one");
  assert.equal(session.turnEnded("one"), true);
  assert.equal(session.state.status, "listening");
  assert.deepEqual(events, [["wake"], ["input", { messageId: "one", text: "你好" }]]);
});

test("interrupt stops only the active playback and preserves the business turn", () => {
  const { session, events } = setup();
  session.wake();
  session.submit({ messageId: "one", text: "执行" });
  const token = session.playbackStarted("speech");
  assert.equal(session.state.status, "playing");
  assert.equal(session.wake(), false);
  assert.equal(session.interrupt(), true);
  assert.deepEqual(session.state, { status: "executing", turnId: "one", playbackStatus: "interrupted" });
  assert.equal(session.interrupt(), false);
  assert.equal(session.submit({ messageId: "two", text: "插话" }), false);
  assert.equal(session.playbackEnded(token), false);
  assert.equal(session.turnEnded("one"), true);
  assert.equal(session.submit({ messageId: "two", text: "插话" }), true);
  assert.equal(events.filter(([name]) => name === "stop").length, 1);
  assert.equal(events.filter(([name]) => name === "input").length, 2);
});

test("late playback completion or failure cannot stop a newer utterance", () => {
  const { session } = setup();
  session.wake();
  const first = session.playbackStarted("same");
  assert.equal(session.interrupt(), true);
  const second = session.playbackStarted("same");
  assert.notEqual(second, first);
  assert.equal(session.playbackEnded(first, { failed: true }), false);
  assert.equal(session.playbackEnded({ ...second }), false);
  assert.equal(session.state.status, "playing");
  assert.equal(session.playbackEnded(second, { failed: true }), true);
  assert.equal(session.state.playbackStatus, "failed");
  assert.equal(session.state.status, "listening");
  const third = session.playbackStarted("next");
  assert.equal(session.playbackEnded(third), true);
  assert.equal(session.state.playbackStatus, "ended");
});

test("closing stops active audio once, without canceling or replaying a turn", () => {
  const { session, events } = setup();
  session.wake();
  session.submit({ messageId: "one", text: "任务" });
  const token = session.playbackStarted("speech");
  assert.equal(session.close(), true);
  assert.equal(session.close(), false);
  assert.equal(session.state.status, "closed");
  assert.equal(session.state.turnId, "one");
  assert.equal(session.wake(), false);
  assert.equal(session.playbackEnded(token), false);
  assert.equal(session.submit({ messageId: "two", text: "任务" }), false);
  assert.equal(session.turnEnded("one"), true);
  assert.deepEqual(events.map(([name]) => name), ["wake", "input", "stop", "close"]);
});

test("a dispatch callback failure does not permit automatic re-submission", () => {
  const session = new VoiceSession({ onWake() {}, onStopPlayback() {}, onInput() { throw Error("unknown"); } });
  session.wake();
  assert.throws(() => session.submit({ messageId: "one", text: "任务" }), /unknown/);
  assert.equal(session.state.turnId, "one");
  assert.equal(session.submit({ messageId: "one", text: "任务" }), false);
});

test("a failed stop does not pretend the playback has stopped", () => {
  const session = new VoiceSession({
    onWake() {}, onInput() {}, onStopPlayback() { throw Error("stop failed"); },
  });
  session.wake();
  const token = session.playbackStarted("speech");
  assert.throws(() => session.interrupt(), /stop failed/);
  assert.equal(session.state.status, "playback_unknown");
  assert.equal(session.playbackStarted("new"), null);
  assert.equal(session.playbackEnded(token, { failed: true }), true);
  assert.equal(session.state.playbackStatus, "failed");
});
