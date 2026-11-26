import assert from "node:assert/strict";
import test from "node:test";

import { OfficeAttention, PerformanceController } from "../mona_interaction/web/performance-controller.js";

const makeController = () => new PerformanceController({ random: () => 0.5 });

test("rest keeps its focus after a conversation and briefly looks back after working", () => {
  const a = new OfficeAttention(() => .8);
  const base = { headYaw: .03, headPitch: .02, eyeOpen: 1, breath: .015 };
  const sample = () => a.sample("rest", .1, base, false);
  a.orientTo("dialogue");
  a.orientTo("rest");
  for (let i = 0; i < 100; i++) {
    const frame = sample();
    assert.equal(frame.eyeX, 0);
    assert.equal(frame.headYaw, 0);
    assert.equal(frame.headPitch, 0);
    assert.equal(frame.breath, base.breath);
  }
  a.orientTo("work");
  a.orientTo("rest");
  const fromWork = sample();
  assert.ok(fromWork.eyeX > .3 && fromWork.eyeY > .3);
  assert.ok(fromWork.breath > base.breath);
  let frame;
  for (let i = 0; i < 30; i++) frame = sample();
  assert.ok(frame.eyeX < .01);
  assert.equal(frame.headYaw, 0);
  assert.equal(frame.breath, base.breath);
});

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function decision(overrides = {}) {
  return {
    tone: "neutral", smile: 0, gaze: "user", gesture: { type: "none", strength: 0 },
    ...overrides,
  };
}

function advance(controller, count, dt = 1 / 60) {
  let result;
  for (let i = 0; i < count; i += 1) result = controller.tick(dt);
  return result;
}

test("starts neutral and remains finite for invalid time steps", () => {
  const controller = makeController();
  assert.deepEqual(controller.tick(0), {
    headYaw: 0, headPitch: 0, headRoll: 0, bodyYaw: 0, eyeX: 0, eyeY: 0, eyeOpen: 1, browRaise: 0,
    smile: 0, armWave: 0, mouthOpen: 0, mouthForm: 0, breath: 0,
  });
  for (const dt of [NaN, Infinity, -Infinity, -1, undefined, "1"]) {
    assert.ok(Object.values(controller.tick(dt)).every(Number.isFinite));
  }
  assert.throws(() => controller.setDecision(decision({ smile: NaN })), TypeError);
  assert.ok(Object.values(controller.tick(0.1)).every(Number.isFinite));
});

test("long time steps are bounded", () => {
  const a = makeController();
  const b = makeController();
  a.setDecision(decision({ smile: 1 }));
  b.setDecision(decision({ smile: 1 }));
  assert.deepEqual(a.tick(1000), b.tick(0.1));
});

test("different frame rates yield similar values at the same time", () => {
  const fast = new PerformanceController({ random: randomSource(42) });
  const slow = new PerformanceController({ random: randomSource(42) });
  const value = decision({
    gaze: "left", smile: 0.7, gesture: { type: "small_wave", strength: 0.8 },
  });
  fast.setDecision(value);
  slow.setDecision(value);
  const a = advance(fast, 48, 1 / 60);
  const b = advance(slow, 24, 1 / 30);
  for (const key of Object.keys(a)) assert.ok(Math.abs(a[key] - b[key]) < 0.03, key);
  const laterA = advance(fast, 60 * 90, 1 / 60);
  const laterB = advance(slow, 30 * 90, 1 / 30);
  for (const key of Object.keys(laterA)) assert.ok(Math.abs(laterA[key] - laterB[key]) < 0.03, key);
});

test("gaze and smile smoothly approach their targets", () => {
  for (const [gaze, x, y] of [["user", 0, 0], ["left", -1, 0], ["right", 1, 0], ["down", 0, 1]]) {
    const controller = makeController();
    controller.setDecision(decision({ gaze, smile: 0.8 }));
    const first = controller.tick(1 / 60);
    assert.ok(first.smile > 0 && first.smile < 0.8);
    const settled = advance(controller, 120);
    assert.ok(Math.abs(settled.eyeX - x) < 0.001);
    assert.ok(Math.abs(settled.eyeY - y) < 0.001);
    assert.ok(Math.abs(settled.smile - 0.8) < 0.001);
  }
});

test("gestures respond to strength, reach a peak, and settle", () => {
  for (const [type, key] of [["nod", "headPitch"], ["shake_head", "headYaw"], ["small_wave", "armWave"]]) {
    const strong = makeController();
    const weak = makeController();
    strong.setDecision(decision({ gesture: { type, strength: 0.8 } }));
    weak.setDecision(decision({ gesture: { type, strength: 0.2 } }));
    let strongPeak = 0;
    let weakPeak = 0;
    let result;
    for (let i = 0; i < 180; i += 1) {
      result = strong.tick(1 / 60);
      strongPeak = Math.max(strongPeak, Math.abs(result[key]));
      weakPeak = Math.max(weakPeak, Math.abs(weak.tick(1 / 60)[key]));
    }
    assert.ok(strongPeak > 0.01, type);
    assert.ok(weakPeak < strongPeak * 0.4, type);
    assert.ok(Math.abs(result[key]) < 0.001, type);
  }
});

test("clearing a decision smoothly returns to neutral while breathing continues", () => {
  const controller = makeController();
  controller.setDecision(decision({
    tone: "cheerful", gaze: "right", smile: 1, gesture: { type: "small_wave", strength: 1 },
  }));
  const before = advance(controller, 25);
  controller.setDecision(null);
  const next = controller.tick(1 / 60);
  assert.ok(next.armWave > 0 && next.armWave < before.armWave);
  assert.ok(next.smile > 0 && next.smile < before.smile);
  const settled = advance(controller, 120);
  assert.equal(controller.tone, "neutral");
  for (const key of ["headYaw", "headPitch", "eyeX", "eyeY", "smile", "armWave"]) {
    assert.ok(Math.abs(settled[key]) < 0.001, key);
  }
  assert.ok(Number.isFinite(settled.breath) && Math.abs(settled.breath) <= 0.021);
  assert.notEqual(settled.breath, controller.tick(0.1).breath);
});

test("continuous motion and blinks stay bounded over a long session", () => {
  const controller = new PerformanceController({ random: randomSource(1234) });
  const blinkStarts = [];
  let previousEyeOpen = 1;
  let largestDrift = 0;
  for (let frame = 1; frame <= 9000; frame += 1) {
    const output = controller.tick(1 / 30);
    for (const value of Object.values(output)) assert.ok(Number.isFinite(value));
    for (const [key, minimum, maximum] of [
      ["headYaw", -1, 1], ["headPitch", -1, 1], ["headRoll", -1, 1], ["bodyYaw", -1, 1],
      ["eyeX", -1, 1], ["eyeY", -1, 1], ["eyeOpen", 0, 1], ["browRaise", -1, 1],
      ["smile", 0, 1], ["armWave", -1, 1], ["mouthOpen", 0, 1], ["mouthForm", -1, 1],
    ]) assert.ok(output[key] >= minimum && output[key] <= maximum, key);
    if (output.eyeOpen < 0.5 && previousEyeOpen >= 0.5) blinkStarts.push(frame);
    previousEyeOpen = output.eyeOpen;
    largestDrift = Math.max(largestDrift, Math.abs(output.headYaw), Math.abs(output.bodyYaw));
  }
  assert.ok(blinkStarts.length > 30);
  assert.notEqual(blinkStarts[1] - blinkStarts[0], blinkStarts[2] - blinkStarts[1]);
  assert.ok(largestDrift > 0.01);
});

test("attention and speech blend smoothly while automatic motion continues", () => {
  const controller = makeController();
  controller.setDecision(decision({ gaze: "left", smile: 0.4 }));
  controller.setAttention({ x: 0.8, y: 0.35 });
  const first = controller.tick(1 / 60, { mouthOpen: 0.8, mouthForm: -0.6 });
  assert.ok(first.eyeX > 0 && first.eyeX < 0.8);
  assert.ok(first.mouthOpen > 0 && first.mouthOpen < 0.8);
  assert.ok(first.mouthForm < 0 && first.mouthForm > -0.6);
  let output;
  for (let i = 0; i < 120; i += 1) {
    output = controller.tick(1 / 60, { mouthOpen: 0.8, mouthForm: -0.6 });
  }
  assert.ok(Math.abs(output.eyeX - 0.8) < 0.001);
  assert.ok(Math.abs(output.eyeY - 0.35) < 0.001);
  assert.ok(output.headYaw > 0 && output.bodyYaw > 0 && output.headPitch > 0);
  assert.ok(Math.abs(output.mouthOpen - 0.8) < 0.001);
  controller.setAttention(null);
  output = controller.tick(1 / 60);
  assert.ok(output.mouthOpen > 0 && output.mouthOpen < 0.8);
  for (let i = 0; i < 120; i += 1) output = controller.tick(1 / 60);
  assert.ok(Math.abs(output.eyeX + 1) < 0.001);
  assert.ok(output.mouthOpen < 0.001);
  assert.throws(() => controller.setAttention({ x: NaN, y: 0 }), TypeError);
  assert.throws(() => controller.setAttention({ x: 1.01, y: 0 }), TypeError);
  assert.throws(() => controller.tick(0.1, { mouthOpen: 1.01 }), TypeError);
  assert.throws(() => controller.tick(0.1, { mouthForm: NaN }), TypeError);
});

test("tone changes brows and head roll smoothly without overriding gaze or smile", () => {
  const controller = makeController();
  controller.setAttention({ x: 0.6, y: -0.25 });
  for (const tone of ["gentle", "cheerful", "serious", "curious"]) {
    controller.setDecision(decision({ tone, smile: 0.4 }));
    let output = controller.tick(1 / 60);
    const initial = { browRaise: output.browRaise, headRoll: output.headRoll };
    for (let i = 0; i < 120; i += 1) output = controller.tick(1 / 60);
    assert.ok(Math.abs(output.browRaise) <= 0.13 && Math.abs(output.headRoll) <= 0.08, tone);
    assert.ok(Number.isFinite(output.browRaise) && Number.isFinite(output.headRoll), tone);
    assert.ok(Math.abs(output.browRaise) > 0.01 || Math.abs(output.headRoll) > 0.01, tone);
    assert.ok(Math.abs(output.browRaise - initial.browRaise) > 0.001, tone);
    assert.ok(Math.abs(output.eyeX - 0.6) < 0.001);
    assert.ok(Math.abs(output.eyeY + 0.25) < 0.001);
    assert.ok(Math.abs(output.smile - 0.4) < 0.001);
  }
  controller.setDecision(null);
  const first = controller.tick(1 / 60);
  assert.ok(first.browRaise > 0 && first.browRaise < 0.13);
  assert.ok(first.headRoll > 0 && first.headRoll < 0.08);
  const neutral = advance(controller, 120);
  assert.ok(Math.abs(neutral.browRaise) < 0.001);
  assert.ok(Math.abs(neutral.headRoll) < 0.001);
});
