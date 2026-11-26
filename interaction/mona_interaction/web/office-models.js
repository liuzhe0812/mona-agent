import { OfficeAttention, PerformanceController } from "./performance-controller.js";

const POSES = new Set(["rest", "work", "dialogue"]);
let coreLoading = null;

async function findCharacter(pose, signal) {
  const response = await fetch(`/office-character/${pose}`, {
    credentials: "same-origin", redirect: "error", signal,
  });
  // An older service does not expose the optional office model endpoint.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Character configuration unavailable");
  const config = await response.json();
  if (config?.available === false) return null;
  const prefix = `/office-character/${pose}/assets/`;
  if (config?.available !== true || typeof config.model_url !== "string"
      || !config.model_url.startsWith(prefix) || typeof config.core_url !== "string"
      || !config.core_url.startsWith(prefix) || !Array.isArray(config.bindings)) {
    throw new Error("Invalid character configuration");
  }
  return config;
}

function loadCore(url) {
  if (window.Live2DCubismCore) return Promise.resolve();
  if (coreLoading) return coreLoading;
  const pending = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => finish(false), 15000);
    let finished = false;
    function finish(ok) {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      if (ok && window.Live2DCubismCore) resolve();
      else { script.remove(); reject(new Error("Character runtime unavailable")); }
    }
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    script.src = url;
    document.head.append(script);
  });
  coreLoading = pending.catch((error) => { coreLoading = null; throw error; });
  return coreLoading;
}

async function loadRenderer(coreUrl) {
  await loadCore(coreUrl);
  return import("/vendor/cubism-runtime.js");
}

// Owns at most one created or loading WebGL model. The still/APNG is kept by
// the caller until a registered model has loaded and drawn its first frame.
export function mountOfficeModels(frame, expectedCanvas, callbacks, services = {}) {
  if (!Array.isArray(expectedCanvas) || expectedCanvas.length !== 2
      || !expectedCanvas.every((value) => Number.isFinite(value) && value > 0)
      || !callbacks || typeof callbacks.onReady !== "function"
      || typeof callbacks.onUnavailable !== "function" || typeof callbacks.onError !== "function") {
    throw new TypeError("Invalid office model configuration");
  }
  const lookup = services.lookup || findCharacter;
  const renderer = services.renderer || loadRenderer;
  const performance = services.performance || new PerformanceController();
  const attention = new OfficeAttention();
  const cache = new Map();
  let disposed = false;
  let desired = null;
  let active = null;
  let loading = false;
  let generation = 0;
  let request = null;
  let pendingCanvas = null;
  let animation = null;
  let previous = null;
  let reconnectEpoch = 0;
  let mouthSource = null;

  function valuesFor(pose, delta) {
    const speaking = pose === "dialogue" && mouthSource !== null;
    const values = attention.sample(pose, delta,
      performance.tick(delta, { mouthOpen: speaking ? mouthSource() : 0 }), speaking);
    const blink = values.eyeOpen ?? 1;
    // These two registered face rigs use a painted closed lid. Spend the
    // transition on the open/closed drawings rather than their ghosted blend.
    const eyelid = blink > .56 ? .85 + .15 * (blink - .56) / .44
      : blink < .48 ? .55 * blink / .48 : .55 + .3 * (blink - .48) / .08;
    return { ...values, eyeOpen: pose === "work" ? 1 : eyelid,
      mouthOpen: speaking ? values.mouthOpen : 0, mouthForm: 0 };
  }

  function current(pose, token) {
    return !disposed && desired === pose && generation === token;
  }

  function clearActive() {
    if (animation !== null) window.cancelAnimationFrame(animation);
    animation = null;
    previous = null;
    const old = active;
    active = null;
    if (!old) return;
    old.canvas.removeEventListener("webglcontextlost", old.lost);
    try { old.model.dispose(); } catch {} finally { old.canvas.remove(); }
  }

  function abandonPending() {
    request?.abort();
    pendingCanvas?.remove();
  }

  function failActive() {
    if (!active) return;
    const pose = active.pose;
    clearActive();
    if (!disposed && desired === pose) callbacks.onError(pose);
  }

  function paint(timestamp) {
    animation = null;
    if (!active || disposed) return;
    const delta = previous === null ? 0 : Math.max(0, (timestamp - previous) / 1000);
    previous = timestamp;
    try {
      active.model.render(valuesFor(active.pose, delta), delta);
      animation = window.requestAnimationFrame(paint);
    } catch {
      failActive();
    }
  }

  async function pump() {
    if (loading || disposed || !desired) return;
    const pose = desired;
    const token = generation;
    const startedEpoch = reconnectEpoch;
    const aborter = new AbortController();
    request = aborter;
    loading = true;
    let canvas = null;
    let model = null;
    let lost = null;
    let contextLost = false;
    let result = null;
    try {
      let config;
      if (cache.has(pose)) config = cache.get(pose);
      else {
        config = await lookup(pose, aborter.signal);
        if (!current(pose, token)) return;
      }
      if (!current(pose, token)) return;
      if (config === null) { result = "unavailable"; return; }
      if (!config || typeof config !== "object") throw new Error("Invalid character configuration");
      cache.set(pose, config);
      const { CubismCharacter } = await renderer(config.core_url);
      if (!current(pose, token)) return;
      canvas = document.createElement("canvas");
      canvas.className = "office-character-art office-character-art--model";
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.opacity = "0";
      const targetCanvas = canvas;
      lost = (event) => {
        event.preventDefault();
        contextLost = true;
        if (active?.canvas === targetCanvas) failActive();
      };
      canvas.addEventListener("webglcontextlost", lost);
      frame.append(canvas);
      pendingCanvas = canvas;
      model = await CubismCharacter.create(canvas, {
        ...config, projection: "registered", expected_canvas: expectedCanvas, signal: aborter.signal,
      });
      if (!current(pose, token)) return;
      if (contextLost) throw new Error("Character context lost");
      model.render(valuesFor(pose, 0), 0);
      active = { pose, canvas, model, lost };
      pendingCanvas = null;
      model = null;
      canvas = null;
      if (callbacks.onReady(pose, active.canvas) === false) {
        clearActive();
        return;
      }
      animation = window.requestAnimationFrame(paint);
    } catch {
      if (active?.pose === pose) clearActive();
      if (current(pose, token)) result = "error";
    } finally {
      if (model) { try { model.dispose(); } catch {} }
      if (canvas) {
        if (lost) canvas.removeEventListener("webglcontextlost", lost);
        canvas.remove();
      }
      if (request === aborter) request = null;
      if (pendingCanvas === canvas) pendingCanvas = null;
      loading = false;
      const retryAfterReconnect = current(pose, token) && result !== null && reconnectEpoch !== startedEpoch;
      if (!retryAfterReconnect && current(pose, token) && result === "error") callbacks.onError(pose);
      else if (!retryAfterReconnect && current(pose, token) && result === "unavailable") callbacks.onUnavailable(pose);
      // A newer pose waits for the abandoned create() to release its model.
      if (!disposed && desired && (generation !== token || retryAfterReconnect)) void pump();
    }
  }

  return {
    setMouthSource(read) {
      mouthSource = typeof read === "function" ? read : null;
    },
    setPose(pose, focus = pose) {
      if (disposed) return;
      if (pose !== null && !POSES.has(pose)) throw new TypeError("Invalid pose");
      if (focus !== null) attention.orientTo(focus);
      if (desired === pose) return;
      desired = pose;
      generation += 1;
      abandonPending();
      if (active?.pose === pose) {
        active.canvas.style.opacity = "1";
        return;
      }
      clearActive();
      if (pose) void pump();
    },
    beginTransition() {
      if (disposed) return;
      desired = null;
      generation += 1;
      abandonPending();
      if (active) active.canvas.style.opacity = "0";
    },
    isActive(pose) { return Boolean(active && active.pose === pose); },
    isLoading(pose) { return Boolean(loading && desired === pose); },
    serviceReconnected() {
      if (disposed) return;
      reconnectEpoch += 1;
      if (desired && !active && !loading) void pump();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      desired = null;
      generation += 1;
      abandonPending();
      clearActive();
    },
  };
}
