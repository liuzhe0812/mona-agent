import assert from "node:assert/strict";
import test from "node:test";
import { WakeClient } from "../mona_interaction/web/wake-client.js";

function environment() {
  const names = ["navigator", "AudioContext", "AudioWorkletNode", "WebSocket", "location"];
  const saved = Object.fromEntries(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const sockets = [], nodes = [], tracks = [], contexts = [];
  let microphoneRequests = 0;
  class Track extends EventTarget { stop() { this.stopped = true; } }
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {
    async getUserMedia() {
      microphoneRequests += 1;
      const track = new Track(); tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    },
  } } });
  class Node { connect() {} disconnect() {} }
  globalThis.AudioContext = class extends EventTarget {
    constructor() {
      super(); this.state = "suspended"; this.destination = {};
      this.audioWorklet = { addModule: async () => {} }; contexts.push(this);
    }
    createMediaStreamSource() { return new Node(); }
    createGain() { const node = new Node(); node.gain = {}; return node; }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; }
  };
  globalThis.AudioWorkletNode = class extends Node { constructor() { super(); this.port = {}; nodes.push(this); } };
  globalThis.location = { protocol: "http:", host: "localhost:17880" };
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(data); }
    receive(data) { this.onmessage({ data: JSON.stringify(data) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  };
  return {
    sockets, nodes, tracks, contexts, get microphoneRequests() { return microphoneRequests; },
    restore() {
      for (const [name, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
      }
    },
  };
}

async function awaitSocket(env, index = 0) {
  for (let i = 0; i < 20 && env.sockets.length <= index; i += 1) await Promise.resolve();
  assert.ok(env.sockets.length > index);
  return env.sockets[index];
}

test("wake client starts only on request, sends PCM to local socket, and relays actual detections", async () => {
  const env = environment();
  try {
    const events = [], errors = [];
    const client = new WakeClient({ onWake: () => events.push("wake"), onError: (error) => errors.push(error) });
    assert.equal(env.microphoneRequests, 0);
    const pending = client.start();
    const socket = await awaitSocket(env);
    assert.equal(socket.url, "ws://localhost:17880/wake");
    env.nodes[0].port.onmessage({ data: new Int16Array(320) });
    assert.equal(socket.sent.length, 0);
    socket.receive({ type: "ready", sample_rate: 16000, frame_bytes: 640 });
    assert.equal(await pending, true);
    const frame = new Int16Array(320); frame[0] = -32768; frame[1] = 32767;
    env.nodes[0].port.onmessage({ data: frame });
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0].byteLength, 640);
    const data = new DataView(socket.sent[0]);
    assert.equal(data.getInt16(0, true), -32768);
    assert.equal(data.getInt16(2, true), 32767);
    socket.receive({ type: "wake.detected" });
    assert.deepEqual(events, ["wake"]);
    assert.deepEqual(errors, []);
    await client.stop();
    assert.equal(env.tracks[0].stopped, true);
    assert.equal(env.contexts[0].state, "closed");
    assert.equal(socket.readyState, 3);
  } finally { env.restore(); }
});

test("missing wake model is surfaced and capture is closed", async () => {
  const env = environment();
  try {
    const errors = [];
    const client = new WakeClient({ onWake() {}, onError: (error) => errors.push(error) });
    const pending = client.start();
    const socket = await awaitSocket(env);
    socket.receive({ type: "error", code: "not_configured", message: "请先配置语音唤醒资源。" });
    await assert.rejects(pending, { code: "not_configured" });
    assert.equal(errors.length, 1);
    assert.equal(env.tracks[0].stopped, true);
    assert.equal(env.contexts[0].state, "closed");
  } finally { env.restore(); }
});

test("stop during wake setup cancels the pending start and releases the microphone", async () => {
  const env = environment();
  try {
    const errors = [];
    const client = new WakeClient({ onWake() {}, onError: (error) => errors.push(error) });
    const pending = client.start();
    const socket = await awaitSocket(env);
    await client.stop();
    assert.equal(await pending, false);
    assert.equal(socket.readyState, 3);
    assert.equal(env.tracks[0].stopped, true);
    assert.equal(env.contexts[0].state, "closed");
    assert.deepEqual(errors, []);
  } finally { env.restore(); }
});

test("recognition events require the current wake stream and continue after final sentences", async () => {
  const env = environment();
  try {
    const transcripts = [], wakes = [], problems = [];
    const client = new WakeClient({ onWake: () => wakes.push(true), onError() {},
      onTranscript: (event) => transcripts.push(event), onASRUnavailable: (error) => problems.push(error.code) });
    const pending = client.start();
    const socket = await awaitSocket(env);
    socket.receive({ type: "ready", sample_rate: 16000, frame_bytes: 640, asr_available: true, stream_id: "current" });
    assert.equal(await pending, true);
    socket.receive({ type: "asr.partial", stream_id: "current", generation: 1, segment: 1, text: "ignored" });
    socket.receive({ type: "wake.detected", stream_id: "current", generation: 1 });
    socket.receive({ type: "asr.final", stream_id: "old", generation: 1, segment: 1, text: "ignored" });
    socket.receive({ type: "asr.final", stream_id: "current", generation: 2, segment: 1, text: "ignored" });
    socket.receive({ type: "asr.partial", stream_id: "current", generation: 1, segment: 1, text: "你好" });
    socket.receive({ type: "asr.final", stream_id: "current", generation: 1, segment: 1, text: "你好" });
    socket.receive({ type: "asr.final", stream_id: "current", generation: 1, segment: 2, text: "下一句" });
    assert.equal(wakes.length, 1);
    assert.deepEqual(transcripts.map((event) => event.text), ["你好", "你好", "下一句"]);
    assert.equal(client.rearm(), true);
    assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: "wake.rearm", version: 1, stream_id: "current", generation: 1 });
    socket.receive({ type: "asr.final", stream_id: "current", generation: 1, segment: 3, text: "旧语音" });
    socket.receive({ type: "wake.standby", stream_id: "current", generation: 1 });
    socket.receive({ type: "wake.detected", stream_id: "current", generation: 1 });
    socket.receive({ type: "asr.final", stream_id: "current", generation: 1, segment: 4, text: "旧语音" });
    assert.equal(wakes.length, 1);
    assert.equal(transcripts.length, 3);
    socket.receive({ type: "wake.detected", stream_id: "current", generation: 2 });
    socket.receive({ type: "asr.final", stream_id: "current", generation: 2, segment: 1, text: "新一轮" });
    assert.equal(transcripts.at(-1).text, "新一轮");
    assert.equal(env.microphoneRequests, 1);
    socket.receive({ type: "asr.unavailable", code: "asr_not_configured", message: "不可用" });
    assert.deepEqual(problems, ["asr_not_configured"]);
    assert.equal(client.running, true);
    await client.stop();
  } finally { env.restore(); }
});

test("recognition availability follows the current connection and ignores stale wake events", async () => {
  const env = environment();
  try {
    const wakes = [], problems = [];
    const client = new WakeClient({ onWake: () => wakes.push(client.asrAvailable), onError() {},
      onASRUnavailable: (error) => problems.push(error.code) });
    const firstStart = client.start();
    const first = await awaitSocket(env);
    first.receive({ type: "ready", sample_rate: 16000, frame_bytes: 640, asr_available: false, stream_id: "old" });
    assert.equal(await firstStart, true);
    assert.equal(client.asrAvailable, false);
    first.receive({ type: "asr.unavailable", code: "asr_not_configured", message: "不可用" });
    first.receive({ type: "wake.detected" });
    assert.deepEqual(wakes, [false]);
    assert.deepEqual(problems, ["asr_not_configured"]);
    await client.stop();
    assert.equal(client.asrAvailable, null);

    const secondStart = client.start();
    const second = await awaitSocket(env, 1);
    second.receive({ type: "ready", sample_rate: 16000, frame_bytes: 640, asr_available: true, stream_id: "new" });
    assert.equal(await secondStart, true);
    first.receive({ type: "asr.unavailable", code: "stale", message: "旧连接" });
    first.receive({ type: "wake.detected" });
    second.receive({ type: "wake.detected", stream_id: "old", generation: 1 });
    assert.equal(client.asrAvailable, true);
    assert.deepEqual(wakes, [false]);
    assert.deepEqual(problems, ["asr_not_configured"]);
    second.receive({ type: "wake.detected", stream_id: "new", generation: 1 });
    assert.deepEqual(wakes, [false, true]);
    await client.stop();
  } finally { env.restore(); }
});
