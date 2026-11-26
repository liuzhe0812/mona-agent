import assert from "node:assert/strict";
import test from "node:test";

import { mountWorkbenchSurface, quadTransform } from "../mona_interaction/web/workbench-surface.js";

function mapPoint(matrix, x, y) {
  const denominator = matrix[3] * x + matrix[7] * y + matrix[15];
  return [
    (matrix[0] * x + matrix[4] * y + matrix[12]) / denominator,
    (matrix[1] * x + matrix[5] * y + matrix[13]) / denominator,
  ];
}

test("perspective maps all four corners to the physical screen", () => {
  const quad = [[41, 30], [523, 9], [508, 292], [29, 310]];
  const transform = quadTransform(1600, 900, quad);
  for (const [index, point] of [[0, 0], [1600, 0], [1600, 900], [0, 900]].entries()) {
    const mapped = mapPoint(transform, ...point);
    assert.ok(Math.abs(mapped[0] - quad[index][0]) < 1e-8);
    assert.ok(Math.abs(mapped[1] - quad[index][1]) < 1e-8);
  }
  assert.throws(() => quadTransform(1600, 900, [[0, 0], [1, 0], [0.5, 0.1], [0, 1]]), TypeError);
  assert.throws(() => quadTransform(0, 900, quad), TypeError);
});

class Element extends EventTarget {
  constructor(tagName, document) {
    super();
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.document = document;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.isConnected = false;
    this.connections = 0;
    this.inert = false;
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      child.setConnected(this.isConnected);
      this.children.push(child);
    }
  }
  setConnected(value) {
    if (value && !this.isConnected) this.connections += 1;
    this.isConnected = value;
    for (const child of this.children) child.setConnected(value);
  }
  contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getBoundingClientRect() { return this.bounds || { width: 1000, height: 600 }; }
  focus() { this.document.activeElement = this; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.setConnected(false);
  }
}

function makeEnvironment() {
  const saved = Object.fromEntries(["document", "ResizeObserver"].map((key) => [key, globalThis[key]]));
  const document = new EventTarget();
  document.createElement = (tagName) => new Element(tagName, document);
  const host = new Element("div", document);
  host.setConnected(true);
  let observer;
  globalThis.document = document;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  return {
    document, host, get observer() { return observer; },
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

const settings = {
  width: 1600, height: 900,
  screen: [[0.64, 0.28], [0.97, 0.25], [0.97, 0.62], [0.64, 0.62]],
};

function escapeKey() {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: "Escape" });
  return event;
}

test("expanding, resizing and closing preserve the mounted interface and focus", () => {
  const env = makeEnvironment();
  try {
    const nestedDocument = new EventTarget();
    const gui = new Element("iframe", env.document);
    gui.contentWindow = { document: nestedDocument };
    gui.src = "/real-workbench";
    gui.value = "unsent input";
    const surface = mountWorkbenchSurface(env.host, gui, settings);
    const root = env.host.children[0];
    const viewport = root.children[0];
    const content = viewport.children[0];
    const openButton = viewport.children[1];
    const closeButton = root.children[1];
    const originalTransform = viewport.style.transform;
    assert.equal(content.children[0], gui);
    assert.equal(gui.connections, 1);
    assert.equal(gui.inert, true);
    assert.equal(openButton.getAttribute?.("aria-label") ?? openButton.attributes.get("aria-label"), "打开工作台");

    openButton.focus();
    openButton.dispatchEvent(new Event("click"));
    assert.equal(gui.inert, false);
    assert.equal(env.document.activeElement, viewport);
    assert.equal(openButton.hidden, true);
    assert.equal(closeButton.hidden, false);
    assert.notEqual(viewport.style.transform, originalTransform);

    env.host.bounds = { width: 1200, height: 900 };
    env.observer.callback();
    nestedDocument.dispatchEvent(escapeKey());
    assert.equal(gui.inert, true);
    assert.equal(env.document.activeElement, openButton);
    assert.equal(openButton.hidden, false);
    assert.equal(closeButton.hidden, true);
    assert.equal(gui.connections, 1);
    assert.equal(gui.src, "/real-workbench");
    assert.equal(gui.value, "unsent input");

    surface.expand();
    closeButton.dispatchEvent(new Event("click"));
    assert.equal(gui.connections, 1);
    assert.equal(gui.inert, true);
    surface.dispose();
    surface.dispose();
    assert.equal(env.observer.disconnected, true);
    assert.equal(gui.inert, false);
    assert.equal(env.host.children.length, 0);
  } finally {
    env.restore();
  }
});

test("cross-origin iframe keeps the close button available", () => {
  const env = makeEnvironment();
  try {
    const gui = new Element("iframe", env.document);
    Object.defineProperty(gui, "contentWindow", {
      get() { throw new DOMException("Blocked", "SecurityError"); },
    });
    let reason;
    env.host.addEventListener("mona:workbench-escape-unavailable", (event) => { reason = event.detail.reason; });
    const surface = mountWorkbenchSurface(env.host, gui, settings);
    assert.equal(reason, "cross-origin");
    surface.expand();
    env.host.children[0].children[1].dispatchEvent(new Event("click"));
    assert.equal(gui.inert, true);
    surface.dispose();
  } finally {
    env.restore();
  }
});
