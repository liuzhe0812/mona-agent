import assert from "node:assert/strict";
import test from "node:test";
import { resolveBindings, parameterValues } from "../../mona_interaction/web/parameter-bindings.js";

test("rig mapping respects existing parameters, authored ranges and screen gaze direction", () => {
  const { bindings, missing } = resolveBindings([
    { id: "ParamAngleX", index: 0, min: -20, max: 20 },
    { id: "ParamEyeBallY", index: 1, min: -1, max: 1 },
    { id: "ParamMouthForm", index: 2, min: -1, max: 1 },
  ]);
  assert.ok(missing.includes("ParamEyeLOpen"));
  assert.deepEqual(parameterValues(bindings, { headYaw: 1, eyeY: 0.5, mouthForm: 0.9, smile: 1 }), [
    { index: 0, value: 20 }, { index: 1, value: -0.5 }, { index: 2, value: 1 },
  ]);
});

test("a character-specific binding can add a gesture and override its authored scale", () => {
  const { bindings } = resolveBindings([
    { id: "ParamAngleX", index: 0, min: -30, max: 30 },
    { id: "ParamMonaWave", index: 1, min: -1, max: 1 },
  ], [
    { source: "headYaw", parameter: "ParamAngleX", scale: 15, offset: 2 },
    { source: "armWave", parameter: "ParamMonaWave", scale: 1, offset: 0 },
  ]);
  assert.deepEqual(parameterValues(bindings, { headYaw: 0.5, armWave: -0.4 }), [
    { index: 0, value: 9.5 }, { index: 1, value: -0.4 },
  ]);
  assert.throws(() => parameterValues(bindings, { headYaw: NaN, armWave: 0 }), TypeError);
});
