import assert from "node:assert/strict";
import test from "node:test";

import { clockAngles, fitOfficeScene, mountOfficeScene, windowNightOpacity, windowTint } from "../mona_interaction/web/office-scene.js";

test("clock follows local time through noon and midnight", () => {
  const beforeNoon = clockAngles(new Date(2026, 10, 4, 11, 59, 59, 500));
  assert.ok(Math.abs(beforeNoon.hour - 359.99583333333334) < 1e-9);
  assert.ok(Math.abs(beforeNoon.minute - 359.95) < 1e-9);
  assert.equal(beforeNoon.second, 357);
  assert.deepEqual(clockAngles(new Date(2026, 10, 4, 12)), { hour: 0, minute: 0, second: 0 });
  assert.deepEqual(clockAngles(new Date(2026, 10, 5, 0)), { hour: 0, minute: 0, second: 0 });
  assert.deepEqual(clockAngles(new Date(2026, 10, 5, 1, 30)), { hour: 45, minute: 180, second: 0 });
});

test("window tint follows local time and transitions continuously over midnight", () => {
  assert.equal(windowTint(new Date(2026, 10, 4, 12)), "rgba(143, 196, 231, 0.100)");
  assert.equal(windowTint(new Date(2026, 10, 4, 19)), "rgba(224, 109, 73, 0.340)");
  assert.equal(windowTint(new Date(2026, 10, 4, 23, 59, 59)), "rgba(17, 25, 55, 0.660)");
  assert.equal(windowTint(new Date(2026, 10, 5, 0)), "rgba(17, 25, 55, 0.660)");
  assert.notEqual(windowTint(new Date(2026, 10, 4, 18)), windowTint(new Date(2026, 10, 4, 19)));
});

test("night image follows local time with smooth dawn and dusk fades", () => {
  const at = (hour, minute = 0) => windowNightOpacity(new Date(2026, 10, 4, hour, minute));
  assert.equal(at(0), 1);
  assert.equal(at(5), 1);
  assert.equal(at(6), 0.5);
  assert.equal(at(7), 0);
  assert.equal(at(12), 0);
  assert.equal(at(19), 0);
  assert.equal(at(20), 0.5);
  assert.equal(at(21), 1);
  assert.equal(at(23, 59), 1);
  assert.ok(at(19, 1) < at(19, 30));
});

test("scene and overlays share a contained canvas at different viewport sizes", () => {
  assert.deepEqual(fitOfficeScene(800, 800, 1600, 900), {
    width: 800, height: 450, left: 0, top: 175,
  });
  assert.deepEqual(fitOfficeScene(1920, 1080, 1600, 900), {
    width: 1920, height: 1080, left: 0, top: 0,
  });
});

class Element extends EventTarget {
  constructor(name) {
    super();
    this.name = name;
    this.attributes = new Map();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = { add() {} };
  }
  append(...children) {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key); }
  getBoundingClientRect() { return { width: 800, height: 800 }; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
}

test("visibility and reduced motion resume with the actual system time", () => {
  const saved = Object.fromEntries(["Date", "document", "window", "ResizeObserver"].map((key) => [key, globalThis[key]]));
  const RealDate = Date;
  let now = new RealDate(2026, 10, 4, 23, 59, 59, 500).getTime();
  const frames = new Map();
  const timers = new Map();
  let nextId = 0;
  const media = new EventTarget();
  media.matches = false;
  const document = new EventTarget();
  document.hidden = false;
  document.createElement = (name) => new Element(name);
  document.createElementNS = (_, name) => new Element(name);
  let observer;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  globalThis.document = document;
  globalThis.window = {
    matchMedia: () => media,
    requestAnimationFrame(callback) { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback) { timers.set(++nextId, callback); return nextId; },
    clearTimeout(id) { timers.delete(id); },
  };
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
  };

  try {
    const host = new Element("host");
    let failed = false;
    host.addEventListener("mona:office-scene-error", () => { failed = true; });
    const scene = mountOfficeScene(host, {
      background_url: "/office.png", width: 1600, height: 900,
      night_background_url: "/night.png",
      clock: { x: 0.63, y: 0.15, diameter: 0.07 },
      window: [[0, 0], [0.3, 0], [0.3, 0.5], [0, 0.5]],
    });
    const clock = scene.frame.children[2];
    const atmosphere = scene.frame.children[1];
    const night = atmosphere.children[0];
    const sky = atmosphere.children[1];
    const clouds = atmosphere.children[2];
    const cityLights = atmosphere.children[4];
    assert.equal(night.src, "/night.png");
    assert.equal(night.style.opacity, "1");
    assert.equal(sky.style.opacity, "0");
    assert.equal(clouds.style.opacity, "0");
    assert.equal(cityLights.style.opacity, "1");
    assert.equal(cityLights.children.length, 3);
    assert.equal(clouds.style.width, "30%");
    assert.equal(cityLights.style.height, "50%");
    assert.equal(atmosphere.style.clipPath, "polygon(0% 0%, 30% 0%, 30% 50%, 0% 50%)");
    assert.equal(clock.getAttribute("aria-label"), "当前时间 23:59:59");
    assert.equal(sky.style.backgroundColor, "rgba(17, 25, 55, 0.660)");
    assert.equal(frames.size, 1);
    scene.frame.children[0].dispatchEvent(new Event("error"));
    assert.equal(failed, true);

    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(frames.size, 0);
    assert.equal(host.children[0].dataset.paused, "true");

    now = new RealDate(2026, 10, 5, 12, 0).getTime();
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(clock.getAttribute("aria-label"), "当前时间 12:00:00");
    assert.equal(sky.style.backgroundColor, "rgba(143, 196, 231, 0.100)");
    assert.equal(night.style.opacity, "0");
    assert.equal(sky.style.opacity, "1");
    assert.equal(clouds.style.opacity, "1");
    assert.equal(cityLights.style.opacity, "0");
    assert.equal(frames.size, 1);

    media.matches = true;
    media.dispatchEvent(new Event("change"));
    assert.equal(frames.size, 0);
    assert.equal(timers.size, 1);
    now = new RealDate(2026, 10, 5, 19, 0, 0).getTime();
    const [timerId, callback] = [...timers][0];
    timers.delete(timerId);
    callback();
    assert.equal(clock.getAttribute("aria-label"), "当前时间 19:00:00");
    assert.equal(sky.style.backgroundColor, "rgba(224, 109, 73, 0.340)");
    assert.equal(clouds.style.opacity, "1");
    assert.equal(cityLights.style.opacity, "0");
    assert.equal(timers.size, 1);
    now = new RealDate(2026, 10, 5, 21, 0).getTime();
    const [nightTimerId, nightCallback] = [...timers][0];
    timers.delete(nightTimerId);
    nightCallback();
    assert.equal(clock.getAttribute("aria-label"), "当前时间 21:00:00");
    assert.equal(clouds.style.opacity, "0");
    assert.equal(cityLights.style.opacity, "1");
    assert.equal(sky.style.opacity, "0");

    scene.dispose();
    scene.dispose();
    assert.equal(timers.size, 0);
    assert.equal(observer.disconnected, true);
    assert.equal(host.children.length, 0);

    now = new RealDate(2026, 10, 5, 12, 0).getTime();
    const layered = mountOfficeScene(host, {
      background_url: "/office.png", night_background_url: "/night.png",
      day_sky_url: "/day.png", cloud_artwork_url: "/cloud.png", width: 1600, height: 900,
      cloud_regions: [[[0, 0], [0.1, 0], [0.1, 0.2]], [[0.2, 0], [0.3, 0], [0.3, 0.2]]],
      clock: { x: 0.63, y: 0.15, diameter: 0.07 },
      window: [[0, 0], [0.3, 0], [0.3, 0.5], [0, 0.5]],
    });
    const atmosphereWithClouds = layered.frame.children[1];
    const cloudLayers = atmosphereWithClouds.children[0];
    const nightImage = atmosphereWithClouds.children[1];
    assert.equal(cloudLayers.className, "office-scene__cloud-layers");
    assert.equal(cloudLayers.style.visibility, "hidden");
    assert.equal(cloudLayers.children.length, 2);
    const cloudImages = cloudLayers.children.flatMap((pane) => pane.children);
    assert.deepEqual(cloudImages.map((image) => image.src), ["/day.png", "/cloud.png", "/day.png", "/cloud.png"]);
    for (const image of cloudImages) image.dispatchEvent(new Event("load"));
    assert.equal(cloudLayers.style.visibility, "visible");
    assert.equal(cloudImages[1].style.opacity, "1");
    assert.equal(nightImage.style.opacity, "0");
    now = new RealDate(2026, 10, 5, 21, 0).getTime();
    const [layeredTimerId, layeredTick] = [...timers][0];
    timers.delete(layeredTimerId);
    layeredTick();
    assert.equal(cloudImages[1].style.opacity, "0");
    assert.equal(nightImage.style.opacity, "1");
    failed = false;
    cloudImages[1].dispatchEvent(new Event("error"));
    assert.equal(cloudLayers.style.visibility, "hidden");
    assert.equal(failed, true);
    layered.dispose();

    const legacy = mountOfficeScene(host, {
      background_url: "/office.png", width: 1600, height: 900,
      clock: { x: 0.63, y: 0.15, diameter: 0.07 },
      window: [[0, 0], [0.3, 0], [0.3, 0.5], [0, 0.5]],
    });
    assert.equal(legacy.frame.children[1].children[0].className, "office-scene__sky");
    assert.equal(legacy.frame.children[1].children[0].style.opacity, "1");
    legacy.dispose();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
