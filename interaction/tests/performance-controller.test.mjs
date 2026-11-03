import assert from "node:assert/strict";
import test from "node:test";

import { PerformanceController } from "../mona_interaction/web/performance-controller.js";

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
  const controller = new PerformanceController();
  assert.deepEqual(controller.tick(0), {
    headYaw: 0, headPitch: 0, eyeX: 0, eyeY: 0, smile: 0, armWave: 0, breath: 0,
  });
  for (const dt of [NaN, Infinity, -Infinity, -1, undefined, "1"]) {
    assert.ok(Object.values(controller.tick(dt)).every(Number.isFinite));
  }
  assert.throws(() => controller.setDecision(decision({ smile: NaN })), TypeError);
  assert.ok(Object.values(controller.tick(0.1)).every(Number.isFinite));
});

test("long time steps are bounded", () => {
  const a = new PerformanceController();
  const b = new PerformanceController();
  a.setDecision(decision({ smile: 1 }));
  b.setDecision(decision({ smile: 1 }));
  assert.deepEqual(a.tick(1000), b.tick(0.1));
});

test("different frame rates yield similar values at the same time", () => {
  const fast = new PerformanceController();
  const slow = new PerformanceController();
  const value = decision({
    gaze: "left", smile: 0.7, gesture: { type: "small_wave", strength: 0.8 },
  });
  fast.setDecision(value);
  slow.setDecision(value);
  const a = advance(fast, 48, 1 / 60);
  const b = advance(slow, 24, 1 / 30);
  for (const key of Object.keys(a)) assert.ok(Math.abs(a[key] - b[key]) < 0.03, key);
});

test("gaze and smile smoothly approach their targets", () => {
  for (const [gaze, x, y] of [["user", 0, 0], ["left", -1, 0], ["right", 1, 0], ["down", 0, 1]]) {
    const controller = new PerformanceController();
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
    const strong = new PerformanceController();
    const weak = new PerformanceController();
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
  const controller = new PerformanceController();
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
