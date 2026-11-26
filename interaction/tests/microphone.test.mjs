import assert from "node:assert/strict";
import test from "node:test";
import { Pcm16Resampler } from "../mona_interaction/web/microphone-worklet.js";
import { MicrophoneCapture } from "../mona_interaction/web/microphone.js";

function resample(input, rate, lengths) {
  const frames = [];
  const converter = new Pcm16Resampler(rate, (frame) => frames.push(frame));
  let offset = 0;
  let index = 0;
  while (offset < input.length) {
    const end = Math.min(input.length, offset + lengths[index++ % lengths.length]);
    converter.push(input.subarray(offset, end));
    offset = end;
  }
  return frames;
}

test("continuous resampling gives identical 16 kHz PCM frames across chunk boundaries", () => {
  for (const rate of [8000, 16000, 44100, 48000]) {
    const input = Float32Array.from({ length: rate }, (_, i) => 0.7 * Math.sin(2 * Math.PI * 1000 * i / rate));
    const regular = resample(input, rate, [128]);
    const irregular = resample(input, rate, [1, 511, 39, 256]);
    assert.equal(regular.length, 49);
    assert.ok(regular.every((frame) => frame instanceof Int16Array && frame.length === 320));
    assert.deepEqual(regular, irregular);
    const frame = regular[10];
    assert.ok(Math.max(...frame) > 20000);
    assert.ok(Math.min(...frame) < -20000);
  }
});

test("downsampling attenuates frequencies above the output Nyquist frequency", () => {
  const rms = (frequency) => {
    const rate = 48000;
    const samples = Float32Array.from({ length: rate }, (_, i) => Math.sin(2 * Math.PI * frequency * i / rate));
    const values = resample(samples, rate, [128]).slice(1).flatMap((frame) => [...frame]);
    return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  };
  assert.ok(rms(12000) < rms(1000) * 0.1);
});

function mockAudio() {
  const globals = ["navigator", "AudioContext", "AudioWorkletNode"];
  const saved = Object.fromEntries(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const tracks = [];
  const contexts = [];
  const nodes = [];
  let calls = 0;
  let constraints;
  class Track extends EventTarget {
    stop() { this.stopped = true; }
  }
  const stream = () => {
    const track = new Track();
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  const media = { getUserMedia: async (value) => { calls += 1; constraints = value; return stream(); } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: media } });
  class AudioNode {
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  globalThis.AudioContext = class extends EventTarget {
    constructor() {
      super();
      this.state = "suspended";
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
      contexts.push(this);
    }
    createMediaStreamSource() { return new AudioNode(); }
    createGain() { const node = new AudioNode(); node.gain = { value: 1 }; return node; }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; }
  };
  globalThis.AudioWorkletNode = class extends AudioNode {
    constructor() { super(); this.port = {}; nodes.push(this); }
  };
  return {
    media, tracks, contexts, nodes, stream,
    get calls() { return calls; }, get constraints() { return constraints; },
    restore() {
      for (const [name, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

test("explicit start requests mono and echo suppression, then stop releases resources", async () => {
  const mock = mockAudio();
  try {
    const frames = [];
    const errors = [];
    const capture = new MicrophoneCapture({ onFrame: (frame) => frames.push(frame), onError: (error) => errors.push(error) });
    assert.equal(mock.calls, 0);
    assert.equal(await capture.start(), true);
    assert.equal(await capture.start(), true);
    assert.equal(mock.calls, 1);
    assert.deepEqual(mock.constraints.audio.channelCount, { ideal: 1 });
    assert.equal(mock.constraints.audio.echoCancellation, true);
    assert.equal(mock.constraints.audio.noiseSuppression, true);
    mock.nodes[0].port.onmessage({ data: new Int16Array(320) });
    assert.equal(frames.length, 1);
    assert.deepEqual(errors, []);
    await capture.stop();
    assert.equal(mock.tracks[0].stopped, true);
    assert.equal(mock.contexts[0].state, "closed");
    assert.equal(mock.nodes[0].port.onmessage, null);
    await capture.stop();
  } finally { mock.restore(); }
});

test("permission denial is surfaced and stopping while waiting closes a late stream", async () => {
  const mock = mockAudio();
  try {
    const errors = [];
    const capture = new MicrophoneCapture({ onFrame() {}, onError: (error) => errors.push(error) });
    mock.media.getUserMedia = async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); };
    await assert.rejects(capture.start(), { code: "permission_denied" });
    assert.equal(errors[0].code, "permission_denied");
    let grant;
    mock.media.getUserMedia = () => new Promise((resolve) => { grant = resolve; });
    const pending = capture.start();
    await capture.stop();
    grant(mock.stream());
    assert.equal(await pending, false);
    assert.equal(mock.tracks[0].stopped, true);
    assert.equal(mock.contexts.length, 0);
  } finally { mock.restore(); }
});

test("unexpected device loss reports failure and closes capture", async () => {
  const mock = mockAudio();
  try {
    const errors = [];
    const capture = new MicrophoneCapture({ onFrame() {}, onError: (error) => errors.push(error) });
    await capture.start();
    mock.tracks[0].dispatchEvent(new Event("ended"));
    assert.equal(errors[0].code, "device_unavailable");
    assert.equal(capture.running, false);
    assert.equal(mock.tracks[0].stopped, true);
    assert.equal(mock.contexts[0].state, "closed");
  } finally { mock.restore(); }
});

test("unexpected audio context suspension is reported instead of claiming capture continues", async () => {
  const mock = mockAudio();
  try {
    const errors = [];
    const capture = new MicrophoneCapture({ onFrame() {}, onError: (error) => errors.push(error) });
    await capture.start();
    mock.contexts[0].state = "suspended";
    mock.contexts[0].dispatchEvent(new Event("statechange"));
    assert.equal(errors[0].code, "capture_failed");
    assert.equal(capture.running, false);
    assert.equal(mock.tracks[0].stopped, true);
  } finally { mock.restore(); }
});
