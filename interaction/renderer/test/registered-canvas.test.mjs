import assert from 'node:assert/strict';
import test from 'node:test';
import { registeredCanvasMatrix } from '../src/registered-canvas.js';

test('registered projection maps the model canvas into the whole viewport', () => {
  const m = registeredCanvasMatrix({ CanvasWidth: 1672, CanvasHeight: 941,
    CanvasOriginX: 836, CanvasOriginY: 470.5, PixelsPerUnit: 1672 }, [1672, 941]);
  const project = (x, y) => [m[0] * x + m[12], m[5] * y + m[13]];
  const topLeft = project(-836 / 1672, 470.5 / 1672);
  const bottomRight = project(836 / 1672, -470.5 / 1672);
  assert.ok(Math.abs(topLeft[0] + 1) < 1e-6 && Math.abs(topLeft[1] - 1) < 1e-6);
  assert.ok(Math.abs(bottomRight[0] - 1) < 1e-6 && Math.abs(bottomRight[1] + 1) < 1e-6);
  const shifted = registeredCanvasMatrix({ CanvasWidth: 100, CanvasHeight: 100,
    CanvasOriginX: 25, CanvasOriginY: 75, PixelsPerUnit: 100 }, [100, 100]);
  assert.equal(shifted[12], -0.5);
  assert.equal(shifted[13], -0.5);
});

test('registered projection rejects missing and invalid native canvas metadata', () => {
  for (const value of [undefined, {}, { CanvasWidth: 0, CanvasHeight: 1, CanvasOriginX: 0,
    CanvasOriginY: 0, PixelsPerUnit: 1 }, { CanvasWidth: 1, CanvasHeight: 1,
    CanvasOriginX: NaN, CanvasOriginY: 0, PixelsPerUnit: 1 }]) {
    assert.throws(() => registeredCanvasMatrix(value, [1, 1]), TypeError);
  }
  const valid = { CanvasWidth: 10, CanvasHeight: 20, CanvasOriginX: 5, CanvasOriginY: 10, PixelsPerUnit: 10 };
  assert.throws(() => registeredCanvasMatrix(valid, [10, 21]), TypeError);
  assert.throws(() => registeredCanvasMatrix(valid), TypeError);
});
