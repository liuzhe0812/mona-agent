import assert from "node:assert/strict";
import test from "node:test";
import { mountOfficeModels } from "../mona_interaction/web/office-models.js";

class Canvas extends EventTarget {
  constructor() { super(); this.style = {}; }
  setAttribute() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this); }
}
class Frame {
  constructor() { this.children = []; }
  append(element) { element.parent = this; this.children.push(element); }
}
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

test("unconfigured model is silent and keeps the existing artwork", async () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.document = { createElement: () => new Canvas() };
  globalThis.window = { requestAnimationFrame() { throw Error("unexpected frame"); }, cancelAnimationFrame() {} };
  try {
    const frame = new Frame();
    const events = [];
    const layer = mountOfficeModels(frame, [1672, 941], {
      onReady: () => events.push("ready"), onUnavailable: () => events.push("unavailable"), onError: () => events.push("error"),
    }, { lookup: async () => null });
    layer.setPose("rest");
    await flush();
    assert.deepEqual(events, ["unavailable"]);
    assert.equal(frame.children.length, 0);
    layer.dispose();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
});

test("only a missing or explicitly unavailable configuration is a silent fallback", async () => {
  const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.document = { createElement: () => new Canvas() };
  globalThis.window = { requestAnimationFrame() { throw Error("unexpected frame"); }, cancelAnimationFrame() {} };
  const cases = [
    { response: () => ({ status: 404, ok: false }), expected: "unavailable" },
    { response: () => ({ status: 200, ok: true, json: async () => ({ available: false }) }), expected: "unavailable" },
    { response: () => ({ status: 500, ok: false }), expected: "error" },
    { response: () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("bad JSON"); } }), expected: "error" },
    { response: () => ({ status: 200, ok: true, json: async () => ({ available: true }) }), expected: "error" },
    { response: () => { throw new TypeError("network"); }, expected: "error" },
  ];
  try {
    for (const sample of cases) {
      globalThis.fetch = async () => sample.response();
      const events = [];
      const layer = mountOfficeModels(new Frame(), [1672, 941], {
        onReady: () => events.push("ready"), onUnavailable: () => events.push("unavailable"), onError: () => events.push("error"),
      });
      layer.setPose("rest");
      await flush();
      assert.deepEqual(events, [sample.expected]);
      layer.dispose();
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
});

test("reconnection rechecks an unconfigured pose once and does not reload an active model", async () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  let nextFrame = 0;
  globalThis.document = { createElement: () => new Canvas() };
  globalThis.window = { requestAnimationFrame() { return ++nextFrame; }, cancelAnimationFrame() {} };
  try {
    let calls = 0;
    const events = [];
    const layer = mountOfficeModels(new Frame(), [1672, 941], {
      onReady: (pose) => events.push(["ready", pose]),
      onUnavailable: (pose) => events.push(["unavailable", pose]),
      onError: (pose) => events.push(["error", pose]),
    }, {
      lookup: async () => ++calls === 1 ? null : { core_url: "/core", model_url: "/model", bindings: [] },
      renderer: async () => ({ CubismCharacter: { async create() { return { render() {}, dispose() {} }; } } }),
      performance: { tick() { return {}; } },
    });
    layer.setPose("rest");
    await flush();
    assert.deepEqual(events, [["unavailable", "rest"]]);
    layer.setPose("rest");
    await flush();
    assert.equal(calls, 1, "the same pose does not poll");
    layer.serviceReconnected();
    await flush();
    assert.equal(calls, 2);
    assert.deepEqual(events, [["unavailable", "rest"], ["ready", "rest"]]);
    assert.equal(layer.isActive("rest"), true);
    layer.serviceReconnected();
    await flush();
    assert.equal(calls, 2, "a live model is not reloaded");
    layer.dispose();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
});

test("a reconnect during lookup retries a stale unavailable result at most once", async () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.document = { createElement: () => new Canvas() };
  globalThis.window = { requestAnimationFrame() { throw Error("unexpected frame"); }, cancelAnimationFrame() {} };
  try {
    let calls = 0;
    let resolveFirst;
    const events = [];
    const layer = mountOfficeModels(new Frame(), [1672, 941], {
      onReady: () => events.push("ready"), onUnavailable: () => events.push("unavailable"), onError: () => events.push("error"),
    }, { lookup: () => ++calls === 1 ? new Promise((resolve) => { resolveFirst = resolve; }) : Promise.resolve(null) });
    layer.setPose("rest");
    await flush();
    layer.serviceReconnected();
    resolveFirst(null);
    await flush();
    assert.equal(calls, 2);
    assert.deepEqual(events, ["unavailable"]);
    await flush();
    assert.equal(calls, 2, "the retry is bounded");
    layer.dispose();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
});

test("stale loading is released before the next model and context loss restores the fallback", async () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  const animations = new Map();
  let nextFrame = 0;
  globalThis.document = { createElement: () => new Canvas() };
  globalThis.window = {
    requestAnimationFrame(fn) { const id = ++nextFrame; animations.set(id, fn); return id; },
    cancelAnimationFrame(id) { animations.delete(id); },
  };
  try {
    const frame = new Frame();
    const pending = [];
    const created = [];
    const events = [];
    const layer = mountOfficeModels(frame, [1672, 941], {
      onReady(pose, canvas) { events.push(["ready", pose]); canvas.style.opacity = "1"; },
      onUnavailable: (pose) => events.push(["unavailable", pose]),
      onError: (pose) => events.push(["error", pose]),
    }, {
      lookup: async (pose) => ({ core_url: `/core/${pose}`, model_url: `/model/${pose}`, bindings: [] }),
      renderer: async () => ({ CubismCharacter: { create(canvas, config) {
        let resolve;
        const result = new Promise((done) => { resolve = done; });
        pending.push({ canvas, config, resolve });
        return result;
      } } }),
      performance: { tick() { return { eyeOpen: .2, mouthOpen: .9, mouthForm: 1 }; } },
    });
    const makeModel = (name) => {
      const model = { name, disposed: false, frames: [],
        render(values) { this.frames.push(values); }, dispose() { this.disposed = true; } };
      created.push(model);
      return model;
    };
    layer.setPose("rest");
    await flush();
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].config.expected_canvas, [1672, 941]);
    assert.equal(pending[0].config.projection, "registered");
    layer.beginTransition();
    layer.setPose("work");
    assert.equal(pending[0].config.signal.aborted, true);
    assert.equal(frame.children.length, 0);
    await flush();
    assert.equal(pending.length, 1, "do not create two models while the first load is pending");
    const stale = makeModel("rest");
    pending[0].resolve(stale);
    await flush();
    assert.equal(stale.disposed, true);
    assert.equal(pending.length, 2);
    const current = makeModel("work");
    pending[1].resolve(current);
    await flush();
    assert.deepEqual(events, [["ready", "work"]]);
    assert.equal(layer.isActive("work"), true);
    assert.equal(current.frames[0].eyeOpen, 1);
    assert.equal(current.frames[0].mouthOpen, 0);
    assert.equal(current.frames[0].mouthForm, 0);
    assert.equal(frame.children.length, 1);
    frame.children[0].dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    assert.equal(current.disposed, true);
    assert.equal(frame.children.length, 0);
    assert.deepEqual(events, [["ready", "work"], ["error", "work"]]);
    assert.equal(animations.size, 0);
    layer.dispose();
    assert.equal(created.length, 2);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
});
