// Cubism mesh coordinates are in model units, with +Y upwards. CanvasInfo's
// origin and size are in source pixels measured from the top-left.
export function registeredCanvasMatrix(info, expected) {
  const { CanvasWidth: width, CanvasHeight: height, CanvasOriginX: x,
    CanvasOriginY: y, PixelsPerUnit: unit } = info || {};
  if (![width, height, x, y, unit].every(Number.isFinite) || width <= 0 || height <= 0 || unit <= 0) {
    throw new TypeError("Invalid model canvas information");
  }
  if (!Array.isArray(expected) || expected.length !== 2 || expected[0] !== width || expected[1] !== height) {
    throw new TypeError("Model canvas does not match the registered scene");
  }
  const values = [2 * unit / width, 0, 0, 0, 0, 2 * unit / height, 0, 0,
    0, 0, 1, 0, 2 * x / width - 1, 1 - 2 * y / height, 0, 1];
  if (!values.every(Number.isFinite)) throw new TypeError("Invalid model canvas projection");
  return new Float32Array(values);
}
