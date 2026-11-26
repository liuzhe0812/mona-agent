import assert from "node:assert/strict";
import test from "node:test";

import { AudioPlayback } from "../mona_interaction/web/audio-playback.js";
import { SpeechTimeline } from "../mona_interaction/web/speech-timeline.js";

class FakeContext extends EventTarget {
  constructor() {
    super();
    this.state = "running";
    this.currentTime = 0;
    this.outputTime = 0;
    this.destination = {};
    this.sources = [];
    this.gains = [];
  }
  getOutputTimestamp() { return { contextTime: this.outputTime, performanceTime: 1 }; }
  createGain() {
    const gain = { gain: { value: 1 }, connect() {}, disconnect() { this.disconnected = true; } };
    this.gains.push(gain);
    return gain;
  }
  createBuffer(channels, length, sampleRate) {
    assert.equal(channels, 1);
    const buffer = { duration: length / sampleRate, data: null,
      copyToChannel(data) { this.data = new Float32Array(data); } };
    return buffer;
  }
  createBufferSource() {
    const source = { onended: null, connect() {}, disconnect() { this.disconnected = true; },
      start(when) { this.when = when; }, stop() { this.stopped = true; } };
    this.sources.push(source);
    return source;
  }
  advance(renderTime, outputTime = renderTime) {
    this.currentTime = renderTime;
    this.outputTime = outputTime;
    for (const source of this.sources) {
      if (!source.finished && source.when !== undefined && source.when + source.buffer.duration <= renderTime + 1e-9) {
        source.finished = true;
        source.onended?.();
      }
    }
  }
}

const chunk = (seconds, rate = 16000) => ({ samples: new Int16Array(Math.round(seconds * rate)), sampleRate: rate });
const wait = () => new Promise((resolve) => setTimeout(resolve, 35));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test("PCM segments play in order and the mouth clock follows audible output", async () => {
  const context = new FakeContext();
  const events = [];
  const player = new AudioPlayback({ context, onStart: (token) => events.push(["start", token]),
    onEnd: (token, reason) => events.push([reason, token]), onError: (error) => { throw error; } });
  const timeline = new SpeechTimeline();
  const mouth = timeline.begin({ utteranceId: "reply", visemes: [{ at: 0.5, duration: 0.3, open: .8, form: 0 }] });
  const token = player.begin({ utteranceId: "reply" });
  assert.deepEqual(player.enqueue(token, chunk(.5)), { status: "queued" });
  context.advance(.2, .1);
  near(player.position(token), .1);
  assert.deepEqual(player.enqueue(token, chunk(.5)), { status: "queued" });
  assert.deepEqual(context.sources.map((source) => source.when), [0, .5]);
  context.advance(.9, .6);
  near(player.position(token), .6);
  assert.equal(timeline.sample(mouth, player.position(token)).mouthOpen, .8);
  assert.equal(player.finish(token), true);
  context.advance(1, .9);
  assert.deepEqual(events.map(([event]) => event), ["start"]);
  context.advance(1.1, 1);
  await wait();
  assert.deepEqual(events.map(([event]) => event), ["start", "completed"]);
  assert.equal(player.position(token), null);
  player.dispose();
});

test("network gaps do not advance the utterance clock", () => {
  const context = new FakeContext();
  const player = new AudioPlayback({ context, onError: (error) => { throw error; } });
  const token = player.begin({ utteranceId: "gap" });
  player.enqueue(token, chunk(.1));
  context.advance(.2, .1);
  near(player.position(token), .1);
  context.advance(5);
  player.enqueue(token, chunk(.1));
  assert.equal(context.sources[1].when, 5);
  near(player.position(token), .1);
  context.advance(5.05);
  near(player.position(token), .15);
  player.interrupt(token);
  player.dispose();
});

test("spoken PCM opens the mouth at output time and releases it during gaps and interruption", () => {
  const context = new FakeContext();
  const player = new AudioPlayback({ context, onError: (error) => { throw error; } });
  const token = player.begin({ utteranceId: "question" });
  const audio = chunk(.12);
  audio.samples.fill(7000, Math.round(.04 * audio.sampleRate));
  player.enqueue(token, audio);
  context.advance(.07, .02);
  assert.equal(player.mouthOpening(token), 0);
  context.advance(.10, .07);
  assert.ok(player.mouthOpening(token) > .6);
  context.advance(.2, .15);
  assert.equal(player.mouthOpening(token), 0);
  player.enqueue(token, audio);
  context.advance(.32, .26);
  assert.ok(player.mouthOpening(token) > .6);
  player.interrupt(token);
  assert.equal(player.mouthOpening(token), 0);
  player.dispose();
});

test("interrupt immediately silences queued audio and isolates late chunks and callbacks", () => {
  const context = new FakeContext();
  const events = [];
  const player = new AudioPlayback({ context, onEnd: (token, reason) => events.push([token, reason]),
    onDrain: (token) => events.push([token, "drain"]), onError: (error) => { throw error; } });
  const old = player.begin({ utteranceId: "same" });
  player.enqueue(old, chunk(1));
  player.enqueue(old, chunk(1));
  const late = context.sources[0].onended;
  assert.equal(player.interrupt(old), true);
  assert.equal(context.gains[0].gain.value, 0);
  assert.ok(context.gains[0].disconnected);
  assert.ok(context.sources.every((source) => source.stopped && source.disconnected));
  const next = player.begin({ utteranceId: "same" });
  assert.notEqual(next, old);
  assert.deepEqual(player.enqueue(old, chunk(.1)), { status: "stale" });
  assert.equal(player.finish(old), false);
  late();
  assert.deepEqual(events, [[old, "interrupted"]]);
  assert.deepEqual(player.enqueue(next, chunk(.1)), { status: "queued" });
  player.dispose();
});

test("bounded playback reports backpressure instead of silently dropping speech", () => {
  const context = new FakeContext();
  const drains = [];
  const player = new AudioPlayback({ context, onDrain: (token) => drains.push(token), onError: (error) => { throw error; } });
  const token = player.begin({ utteranceId: "long" });
  assert.deepEqual(player.enqueue(token, chunk(15)), { status: "queued" });
  assert.deepEqual(player.enqueue(token, chunk(15)), { status: "queued" });
  assert.deepEqual(player.enqueue(token, chunk(1)), { status: "backpressure" });
  context.advance(15);
  assert.deepEqual(drains, [token]);
  assert.deepEqual(player.enqueue(token, chunk(1)), { status: "queued" });
  assert.throws(() => player.enqueue(token, { samples: new Float32Array([NaN]), sampleRate: 16000 }), TypeError);
  player.dispose();
});

test("a closed audio context is reported and cannot restart playback", () => {
  const context = new FakeContext();
  const errors = [];
  const player = new AudioPlayback({ context, onError: (error) => errors.push(error.code) });
  const token = player.begin({ utteranceId: "closed" });
  player.enqueue(token, chunk(.1));
  context.state = "closed";
  context.dispatchEvent(new Event("statechange"));
  assert.deepEqual(errors, ["context_closed"]);
  assert.equal(player.position(token), null);
  assert.throws(() => player.begin({ utteranceId: "again" }), { code: "context_not_running" });
  player.dispose();
});

test("a failed audio stop reports uncertainty and refuses replacement audio", () => {
  const context = new FakeContext();
  const errors = [];
  const player = new AudioPlayback({ context, onError: (error) => errors.push(error.code) });
  const token = player.begin({ utteranceId: "uncertain" });
  player.enqueue(token, chunk(.1));
  Object.defineProperty(context.gains[0].gain, "value", { set() { throw new Error("mute failed"); } });
  context.gains[0].disconnect = () => { throw new Error("disconnect failed"); };
  context.sources[0].stop = () => { throw new Error("stop failed"); };
  context.sources[0].disconnect = () => { throw new Error("disconnect failed"); };
  assert.throws(() => player.interrupt(token), { code: "stop_failed" });
  assert.deepEqual(errors, ["stop_failed"]);
  assert.equal(player.position(token), null);
  assert.throws(() => player.begin({ utteranceId: "new" }), { code: "unavailable" });
  player.dispose();
});

test("a failed playback callback silences the source before reporting failure", () => {
  const context = new FakeContext();
  const errors = [];
  const player = new AudioPlayback({ context, onStart() { throw new Error("UI failed"); },
    onError: (error) => errors.push(error.code) });
  const token = player.begin({ utteranceId: "failed-callback" });
  assert.throws(() => player.enqueue(token, chunk(.1)), { code: "callback_failed" });
  assert.deepEqual(errors, ["callback_failed"]);
  assert.equal(context.gains[0].gain.value, 0);
  assert.equal(context.sources[0].stopped, true);
  assert.deepEqual(player.enqueue(token, chunk(.1)), { status: "stale" });
  player.dispose();
});
