const DEFAULT_BINDINGS = [
  ["headYaw", "ParamAngleX", 30, 0],
  ["headPitch", "ParamAngleY", -30, 0],
  ["headRoll", "ParamAngleZ", 30, 0],
  ["bodyYaw", "ParamBodyAngleX", 10, 0],
  ["eyeX", "ParamEyeBallX", 1, 0],
  ["eyeY", "ParamEyeBallY", -1, 0],
  ["eyeOpen", "ParamEyeLOpen", 1, 0],
  ["eyeOpen", "ParamEyeROpen", 1, 0],
  ["browRaise", "ParamBrowLY", 1, 0],
  ["browRaise", "ParamBrowRY", 1, 0],
  ["mouthOpen", "ParamMouthOpenY", 1, 0],
  ["mouthForm", "ParamMouthForm", 1, 0],
  ["smile", "ParamEyeLSmile", 1, 0],
  ["smile", "ParamEyeRSmile", 1, 0],
  ["breath", "ParamBreath", 10, 0.5],
].map(([source, parameter, scale, offset]) => ({ source, parameter, scale, offset }));

export function resolveBindings(parameters, overrides = []) {
  const definitions = new Map(DEFAULT_BINDINGS.map((binding) => [binding.parameter, binding]));
  for (const binding of overrides) definitions.set(binding.parameter, binding);
  const existing = new Map(parameters.map((parameter) => [parameter.id, parameter]));
  const bindings = [];
  const missing = [];
  for (const definition of definitions.values()) {
    const parameter = existing.get(definition.parameter);
    if (!parameter) {
      missing.push(definition.parameter);
      continue;
    }
    bindings.push({ ...definition, index: parameter.index, min: parameter.min, max: parameter.max });
  }
  return { bindings, missing };
}

export function parameterValues(bindings, frame) {
  return bindings.map((binding) => {
    let source = frame[binding.source];
    if (!Number.isFinite(source)) throw new TypeError("Invalid character parameter");
    if (binding.source === "mouthForm") {
      if (!Number.isFinite(frame.smile)) throw new TypeError("Invalid character smile");
      source = Math.max(-1, Math.min(1, source + frame.smile * 0.6));
    }
    const value = binding.offset + source * binding.scale;
    return { index: binding.index, value: Math.max(binding.min, Math.min(binding.max, value)) };
  });
}
