import assert from "node:assert/strict";
import test from "node:test";

import { SpeechTimeline } from "../mona_interaction/web/speech-timeline.js";

const silent = { mouthOpen: 0, mouthForm: 0 };

test("visemes follow the actual playback position, including pauses and seeks", () => {
  const timeline = new SpeechTimeline();
  const visemes = [
    { at: 0.1, duration: 0.2, open: 0.8, form: -0.5 },
    { at: 0.3, duration: 0.2, open: 0.3, form: 0.7 },
    { at: 0.7, duration: 0.15, open: 0.5, form: 0 },
  ];
  const token = timeline.begin({ utteranceId: "first", visemes });
  visemes[0].open = 0;
  assert.deepEqual(timeline.sample(token, 0), silent);
  assert.deepEqual(timeline.sample(token, 0.1), { mouthOpen: 0.8, mouthForm: -0.5 });
  assert.deepEqual(timeline.sample(token, 0.3), { mouthOpen: 0.3, mouthForm: 0.7 });
  assert.deepEqual(timeline.sample(token, 0.6), silent);
  assert.deepEqual(timeline.sample(token, 0.72), { mouthOpen: 0.5, mouthForm: 0 });
  assert.deepEqual(timeline.sample(token, 0.9), silent);
  assert.deepEqual(timeline.sample(token, 0.2), { mouthOpen: 0.8, mouthForm: -0.5 });
});

test("generation tokens isolate replaced, interrupted and reused utterance IDs", () => {
  const timeline = new SpeechTimeline();
  const visemes = [{ at: 0, duration: 1, open: 0.7, form: -0.3 }];
  const first = timeline.begin({ utteranceId: "same-id", visemes });
  const second = timeline.begin({ utteranceId: "same-id", visemes });
  assert.ok(Object.isFrozen(first));
  assert.equal(second.generation, first.generation + 1);
  assert.deepEqual(timeline.sample(first, 0.5), silent);
  assert.equal(timeline.interrupt(first), false);
  assert.deepEqual(timeline.sample(second, 0.5), { mouthOpen: 0.7, mouthForm: -0.3 });
  assert.equal(timeline.interrupt(second), true);
  assert.deepEqual(timeline.sample(second, 0.5), silent);
  const third = timeline.begin({ utteranceId: "same-id", visemes });
  assert.deepEqual(timeline.sample(second, 0.5), silent);
  assert.deepEqual(timeline.sample(third, 0.5), { mouthOpen: 0.7, mouthForm: -0.3 });
  assert.deepEqual(timeline.sample({ ...third }, 0.5), silent);
  assert.throws(() => timeline.sample("same-id", 0.5), TypeError);
  assert.throws(() => timeline.interrupt("same-id"), TypeError);
});

test("invalid or overlapping cues and invalid playback clocks are rejected", () => {
  const timeline = new SpeechTimeline();
  const valid = { at: 0, duration: 1, open: 0.5, form: 0 };
  const token = timeline.begin({ utteranceId: "active", visemes: [valid] });
  for (const candidate of [
    { utteranceId: "", visemes: [] },
    { utteranceId: "invalid", visemes: null },
    { utteranceId: "invalid", visemes: [{ ...valid, at: -1 }] },
    { utteranceId: "invalid", visemes: [{ ...valid, duration: -1 }] },
    { utteranceId: "invalid", visemes: [{ ...valid, duration: Infinity }] },
    { utteranceId: "invalid", visemes: [{ ...valid, at: Number.MAX_VALUE, duration: Number.MAX_VALUE }] },
    { utteranceId: "invalid", visemes: [{ ...valid, open: 1.01 }] },
    { utteranceId: "invalid", visemes: [{ ...valid, form: NaN }] },
    { utteranceId: "invalid", visemes: [valid, { ...valid, at: 0.9 }] },
    { utteranceId: "invalid", visemes: [{ ...valid, at: 2, duration: 0 }, { ...valid, at: 1 }] },
  ]) {
    assert.throws(() => timeline.begin(candidate), TypeError);
    assert.deepEqual(timeline.sample(token, 0.5), { mouthOpen: 0.5, mouthForm: 0 });
  }
  for (const position of [-1, NaN, Infinity, undefined, "0.5"]) {
    assert.throws(() => timeline.sample(token, position), TypeError);
  }
});

test("many utterances can reuse the same ID without reviving old playback", () => {
  const timeline = new SpeechTimeline();
  const visemes = [{ at: 0, duration: 1, open: 0.5, form: 0 }];
  const first = timeline.begin({ utteranceId: "same", visemes });
  let current = first;
  for (let i = 0; i < 10000; i += 1) {
    current = timeline.begin({ utteranceId: "same", visemes });
  }
  assert.deepEqual(timeline.sample(first, 0.5), silent);
  assert.deepEqual(timeline.sample(current, 0.5), { mouthOpen: 0.5, mouthForm: 0 });
  assert.equal(current.generation, 10001);
});
