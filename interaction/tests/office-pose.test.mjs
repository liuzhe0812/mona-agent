import assert from "node:assert/strict";
import test from "node:test";
import { mountOfficePoses } from "../mona_interaction/web/office-pose.js";

class Element extends EventTarget {
  constructor() { super(); this.style = {}; this.children = []; this.attributes = {}; this.dataset = {}; }
  append(element) { this.children.push(element); element.parent = this; }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { if (name === "src") delete this.src; else delete this.attributes[name]; }
}

test("a drawn real model replaces its idle frame without a fade gap", () => {
  const names = ["window", "document", "location", "WebSocket"];
  const saved = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const timers = new Map();
  let next = 0;
  let socket;
  const doc = new EventTarget();
  doc.hidden = false;
  doc.createElement = () => new Element();
  const media = new EventTarget();
  media.matches = false;
  globalThis.document = doc;
  globalThis.location = { protocol: "http:", host: "localhost:17880" };
  globalThis.window = {
    matchMedia: () => media,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() { this.readyState = 0; socket = this; }
    open() { this.readyState = 1; this.onopen(); }
    send() {}
    receive(value) { this.onmessage({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose(); }
  };
  let callbacks;
  let activePose = null;
  let canvas;
  let transitionAtFade;
  const createModels = (_frame, _size, handlers) => {
    callbacks = handlers;
    return {
      setPose() {},
      isActive(pose) { return pose === activePose; },
      isLoading() { return false; },
      beginTransition() {
        if (canvas) {
          transitionAtFade = canvas.style.transition;
          canvas.style.opacity = "0";
        }
        activePose = null;
      },
      serviceReconnected() {},
      dispose() { canvas?.remove(); },
    };
  };
  try {
    const frame = new Element();
    const poses = mountOfficePoses(frame, {
      rest: "/rest.png", work: "/work.png", idle: { rest: "/rest-idle.png" }, realtime: [1672, 941],
    }, "session", () => {}, () => {}, () => {}, createModels);
    const [rest, work] = frame.children;
    rest.dispatchEvent(new Event("load"));
    work.dispatchEvent(new Event("load"));
    const idle = frame.children[2];
    idle.dispatchEvent(new Event("load"));
    assert.equal(idle.style.opacity, "1");

    canvas = new Element();
    canvas.style.opacity = "0";
    frame.append(canvas);
    let committed = false;
    Object.defineProperty(canvas, "offsetWidth", { get() {
      assert.equal(canvas.style.transition, "none");
      assert.equal(canvas.style.opacity, "1");
      assert.ok(frame.children.includes(idle), "fallback remains until the model is visible");
      assert.equal(idle.style.opacity, "1");
      committed = true;
      return 800;
    } });
    activePose = "rest";
    assert.equal(callbacks.onReady("rest", canvas), true);
    assert.equal(committed, true);
    assert.equal(frame.children.includes(idle), false);
    assert.equal(canvas.style.opacity, "1");
    assert.equal(canvas.style.transition, "", "later pose changes use the normal transition");

    socket.open();
    const event = (type, payload = {}) => ({
      version: 1, type, session_id: "session", message_id: "turn", payload,
    });
    socket.receive(event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    socket.receive(event("input.accepted"));
    assert.equal(transitionAtFade, "");
    assert.equal(canvas.style.opacity, "0");
    assert.equal(callbacks.onReady("rest", new Element()), false, "stale loads cannot replace the transition");
    const fade = [...timers.entries()].find(([, timer]) => timer.delay === 140);
    assert.ok(fade);
    timers.delete(fade[0]);
    fade[1].fn();
    assert.equal(work.style.opacity, "1");
    media.matches = true;
    assert.equal(callbacks.onReady("work", new Element()), false, "reduced motion keeps the fallback");
    poses.dispose();
    assert.equal(callbacks.onReady("work", new Element()), false, "disposed views ignore late loads");
    assert.equal(timers.size, 0);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
});

test("office preloads poses and observes a session without submitting or replaying input", () => {
  const names = ["window", "document", "location", "WebSocket"];
  const saved = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const timers = new Map();
  const sockets = [];
  let next = 0;
  const document = new EventTarget();
  document.hidden = false;
  document.createElement = () => new Element();
  const media = new EventTarget();
  media.matches = false;
  globalThis.document = document;
  globalThis.location = { protocol: "http:", host: "localhost:17880" };
  globalThis.window = {
    matchMedia: () => media,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen(); }
    send(value) { this.sent.push(JSON.parse(value)); }
    receive(value) { this.onmessage({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose(); }
  };
  const event = (type, payload = {}, messageId = "one") => ({
    version: 1, type, session_id: "same-session", message_id: messageId, payload,
  });
  const run = (delay) => {
    const entry = [...timers.entries()].find(([, value]) => value.delay === delay);
    assert.ok(entry);
    timers.delete(entry[0]);
    entry[1].fn();
  };
  try {
    const frame = new Element();
    const poses = mountOfficePoses(frame, { dialogue: "/talk.png", work: "/work.png" }, "same-session", () => {});
    const [talk, work] = frame.children;
    talk.dispatchEvent(new Event("load"));
    assert.equal(talk.style.opacity, "1");
    assert.equal(sockets.length, 0);
    work.dispatchEvent(new Event("load"));
    assert.equal(sockets.length, 1);
    const first = sockets[0];
    first.open();
    assert.equal(first.sent[0].type, "session.observe");
    assert.equal(first.sent[0].session_id, "same-session");
    first.receive(event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    first.receive(event("input.accepted"));
    assert.equal(talk.style.opacity, "0");
    assert.equal(work.style.opacity, "1", "incoming still is visible during transition");
    run(140);
    assert.equal(work.style.opacity, "1");
    first.receive(event("reply.completed", { text: "已回复" }));
    first.receive(event("turn.state", { state: "idle" }));
    assert.equal(work.style.opacity, "0");
    assert.equal(talk.style.opacity, "1");
    run(140);
    assert.equal(talk.style.opacity, "1");
    run(1500);
    assert.equal(talk.style.opacity, "1");
    first.close();
    run(500);
    const second = sockets[1];
    second.open();
    assert.deepEqual(second.sent.map((item) => item.type), ["session.observe"]);
    second.receive(event("session.snapshot", { mode: "mona", state: "thinking", pending_id: "two", records: [] }));
    run(140);
    assert.equal(work.style.opacity, "1");
    run(5000);
    assert.deepEqual(second.sent.map((item) => item.type), ["session.observe", "session.observe"]);
    poses.dispose();
    assert.equal(frame.children.length, 0);
    assert.equal(timers.size, 0);
    const single = mountOfficePoses(frame, { dialogue: "/talk.png" }, "same-session", () => {});
    frame.children[0].dispatchEvent(new Event("load"));
    assert.equal(frame.children[0].style.opacity, "1");
    assert.equal(sockets.length, 2);
    single.dispose();
    let errors = 0;
    const fallback = mountOfficePoses(frame, { dialogue: "/talk.png", work: "/work.png" },
      "same-session", () => { errors += 1; });
    frame.children[0].dispatchEvent(new Event("error"));
    frame.children[1].dispatchEvent(new Event("load"));
    assert.equal(errors, 1);
    assert.equal(frame.children[1].style.opacity, "1");
    assert.equal(sockets.length, 2);
    fallback.dispose();

    const three = mountOfficePoses(frame, { rest: "/rest.png", dialogue: "/talk.png", work: "/work.png" },
      "same-session", () => {});
    const [rest, dialogue, working] = frame.children;
    working.dispatchEvent(new Event("load"));
    dialogue.dispatchEvent(new Event("load"));
    assert.equal(working.style.opacity, "0", "loading other images first must not fake a return from work");
    assert.equal(dialogue.style.opacity, "0");
    rest.dispatchEvent(new Event("load"));
    assert.equal(rest.style.opacity, "1");
    assert.equal(frame.dataset.pose, "rest");
    const third = sockets[2];
    third.open();
    third.receive(event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    third.receive(event("input.accepted"));
    assert.equal(frame.dataset.pose, "work");
    run(140);
    assert.equal(working.style.opacity, "1");
    assert.equal(frame.dataset.pose, "work");
    const playback = three.playbackStarted("speech");
    assert.equal(frame.dataset.pose, "dialogue");
    run(140);
    assert.equal(dialogue.style.opacity, "1");
    assert.equal(frame.dataset.pose, "dialogue");
    third.receive(event("session.snapshot", { mode: "mona", state: "thinking", pending_id: "one", records: [] }));
    assert.ok([...timers.values()].some((value) => value.delay === 5000));
    three.playbackEnded(playback);
    run(140);
    assert.equal(working.style.opacity, "1");
    assert.equal(frame.dataset.pose, "work");
    third.receive(event("turn.state", { state: "idle" }));
    assert.equal(frame.dataset.pose, "rest");
    run(140);
    assert.equal(rest.style.opacity, "1");
    assert.equal(frame.dataset.pose, "rest");
    three.dispose();
    assert.equal(timers.size, 0);

    const preview = mountOfficePoses(frame, {
      rest: "/rest.png", dialogue: "/talk.png", work: "/work.png",
      idle: { rest: "/rest-idle.png", dialogue: "/talk-idle.png", work: "/work-idle.png" },
    }, "same-session", () => {});
    const [restStill, dialogueStill, workStill] = frame.children;
    for (const image of [restStill, dialogueStill, workStill]) image.dispatchEvent(new Event("load"));
    const restIdle = frame.children[3];
    assert.equal(restIdle.src, "/rest-idle.png");
    assert.equal(restStill.style.opacity, "1");
    restIdle.dispatchEvent(new Event("load"));
    assert.equal(restStill.style.opacity, "0");
    assert.equal(restIdle.style.opacity, "1");
    const fourth = sockets[3];
    fourth.open();
    fourth.receive(event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    fourth.receive(event("input.accepted"));
    assert.equal(frame.children.length, 3);
    assert.equal(restIdle.src, undefined);
    run(140);
    let currentIdle = frame.children[3];
    assert.equal(currentIdle.src, "/work-idle.png");
    assert.equal(workStill.style.opacity, "1");
    restIdle.dispatchEvent(new Event("load"));
    assert.equal(frame.children.length, 4);
    currentIdle.dispatchEvent(new Event("error"));
    assert.equal(frame.children.length, 3);
    assert.equal(workStill.style.opacity, "1");
    const speech = preview.playbackStarted("speech");
    run(140);
    currentIdle = frame.children[3];
    assert.equal(currentIdle.src, "/talk-idle.png");
    currentIdle.dispatchEvent(new Event("load"));
    const sentBeforeHide = fourth.sent.length;
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(frame.children.length, 3);
    assert.equal(dialogueStill.style.opacity, "1");
    assert.equal(fourth.sent.length, sentBeforeHide);
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(frame.children[3].src, "/talk-idle.png");
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    assert.equal(frame.children.length, 3);
    assert.equal(dialogueStill.style.opacity, "1");
    preview.playbackEnded(speech);
    assert.equal(workStill.style.opacity, "1");
    fourth.receive(event("turn.state", { state: "idle" }));
    assert.equal(restStill.style.opacity, "1");
    media.matches = false;
    media.dispatchEvent(new Event("change"));
    assert.equal(frame.children[3].src, "/rest-idle.png");
    preview.dispose();
    assert.equal(frame.children.length, 0);
    assert.equal(timers.size, 0);

    let genericErrors = 0;
    let idleWarnings = 0;
    const retry = mountOfficePoses(frame, { rest: "/rest.png", idle: { rest: "/rest-idle.png" } },
      "same-session", () => { genericErrors += 1; }, () => { idleWarnings += 1; });
    const restFallback = frame.children[0];
    restFallback.dispatchEvent(new Event("load"));
    let animation = frame.children[1];
    animation.dispatchEvent(new Event("error"));
    assert.equal(restFallback.style.opacity, "1");
    assert.equal(idleWarnings, 0);
    run(2000);
    animation = frame.children[1];
    animation.dispatchEvent(new Event("error"));
    assert.equal(idleWarnings, 1);
    assert.equal(genericErrors, 0);
    assert.equal(timers.size, 0);

    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    animation = frame.children[1];
    animation.dispatchEvent(new Event("error"));
    run(2000);
    frame.children[1].dispatchEvent(new Event("error"));
    assert.equal(idleWarnings, 1);
    assert.equal(timers.size, 0);

    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    frame.children[1].dispatchEvent(new Event("load"));
    assert.equal(restFallback.style.opacity, "0");
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    frame.children[1].dispatchEvent(new Event("error"));
    run(2000);
    frame.children[1].dispatchEvent(new Event("error"));
    assert.equal(idleWarnings, 2);
    retry.dispose();
    assert.equal(frame.children.length, 0);
    assert.equal(timers.size, 0);

    let retryWarnings = 0;
    const switchRetry = mountOfficePoses(frame, {
      rest: "/rest.png", work: "/work.png", idle: { rest: "/rest-idle.png", work: "/work-idle.png" },
    }, "same-session", () => {}, () => { retryWarnings += 1; });
    const [restForSwitch, workForSwitch] = frame.children;
    restForSwitch.dispatchEvent(new Event("load"));
    workForSwitch.dispatchEvent(new Event("load"));
    const fifth = sockets[4];
    fifth.open();
    fifth.receive(event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    frame.children[2].dispatchEvent(new Event("error"));
    run(2000);
    frame.children[2].dispatchEvent(new Event("error"));
    assert.equal(retryWarnings, 1);
    fifth.receive(event("input.accepted"));
    run(140);
    assert.equal(workForSwitch.style.opacity, "1");
    assert.equal(frame.children[2].src, "/work-idle.png");
    frame.children[2].dispatchEvent(new Event("load"));
    fifth.receive(event("turn.state", { state: "idle" }));
    run(140);
    assert.equal(frame.children[2].src, "/rest-idle.png");
    frame.children[2].dispatchEvent(new Event("error"));
    run(2000);
    frame.children[2].dispatchEvent(new Event("error"));
    assert.equal(retryWarnings, 1);
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    frame.children[2].dispatchEvent(new Event("load"));
    assert.equal(restForSwitch.style.opacity, "0");
    assert.deepEqual(fifth.sent.map((item) => item.type), ["session.observe"]);
    switchRetry.dispose();
    assert.equal(frame.children.length, 0);
    assert.equal(timers.size, 0);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("a configured unavailable idle warns once when its pose is shown", () => {
  const names = ["window", "document", "location", "WebSocket"];
  const saved = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const timers = new Map();
  let next = 0;
  let socket;
  const document = new EventTarget();
  document.hidden = true;
  document.createElement = () => new Element();
  const media = new EventTarget();
  media.matches = false;
  globalThis.document = document;
  globalThis.location = { protocol: "http:", host: "localhost:17880" };
  globalThis.window = {
    matchMedia: () => media,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() { this.readyState = 0; socket = this; }
    open() { this.readyState = 1; this.onopen(); }
    send() {}
    receive(value) { this.onmessage({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose(); }
  };
  const event = (type, payload = {}) => ({
    version: 1, type, session_id: "session", message_id: "turn", payload,
  });
  const runFade = () => {
    const entry = [...timers.entries()].find(([, timer]) => timer.delay === 140);
    assert.ok(entry);
    timers.delete(entry[0]);
    entry[1].fn();
  };
  try {
    const frame = new Element();
    let warnings = 0;
    const poses = mountOfficePoses(frame, {
      rest: "/rest.png", work: "/work.png", idle: { work: "/work-idle.png" },
      idleUnavailable: ["rest"],
    }, "session", () => {}, () => { warnings += 1; });
    const [rest, work] = frame.children;
    rest.dispatchEvent(new Event("load"));
    work.dispatchEvent(new Event("load"));
    assert.equal(warnings, 0);
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(warnings, 1);
    assert.equal(rest.style.opacity, "1");
    assert.equal(frame.children.length, 2);
    socket.open();
    socket.receive(event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    socket.receive(event("input.accepted"));
    runFade();
    assert.equal(frame.dataset.pose, "work");
    frame.children[2].dispatchEvent(new Event("load"));
    socket.receive(event("turn.state", { state: "idle" }));
    runFade();
    assert.equal(frame.dataset.pose, "rest");
    assert.equal(rest.style.opacity, "1");
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(warnings, 1);
    poses.dispose();
    assert.equal(timers.size, 0);

    const unconfigured = mountOfficePoses(frame, { rest: "/rest.png" }, "session", () => {}, () => { warnings += 1; });
    frame.children[0].dispatchEvent(new Event("load"));
    assert.equal(warnings, 1);
    unconfigured.dispose();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("only a real session reconnection rechecks an unconfigured current model", async () => {
  const names = ["window", "document", "location", "WebSocket", "fetch"];
  const saved = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const timers = new Map();
  const sockets = [];
  let next = 0;
  let lookups = 0;
  const doc = new EventTarget();
  doc.hidden = false;
  doc.createElement = () => new Element();
  const media = new EventTarget();
  media.matches = false;
  globalThis.document = doc;
  globalThis.location = { protocol: "http:", host: "localhost:17880" };
  globalThis.fetch = async () => { lookups += 1; return { status: 404, ok: false }; };
  globalThis.window = {
    matchMedia: () => media,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame() { throw Error("unexpected frame"); }, cancelAnimationFrame() {},
  };
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen(); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose(); }
  };
  const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
  try {
    const frame = new Element();
    const poses = mountOfficePoses(frame, { rest: "/rest.png", work: "/work.png", realtime: [1672, 941] },
      "session", () => {});
    const [rest, work] = frame.children;
    rest.dispatchEvent(new Event("load"));
    work.dispatchEvent(new Event("load"));
    await flush();
    assert.equal(lookups, 1);
    sockets[0].open();
    await flush();
    assert.equal(lookups, 1, "the first connection does not duplicate lookup");
    sockets[0].close();
    const retry = [...timers.entries()].find(([, value]) => value.delay === 500);
    assert.ok(retry);
    timers.delete(retry[0]);
    retry[1].fn();
    sockets[1].open();
    await flush();
    assert.equal(lookups, 2);
    assert.deepEqual(sockets[1].sent.map((message) => message.type), ["session.observe"]);
    poses.dispose();
    assert.equal(timers.size, 0);

    const earlyFailure = mountOfficePoses(frame, { rest: "/rest.png", work: "/work.png", realtime: [1672, 941] },
      "session", () => {});
    frame.children[0].dispatchEvent(new Event("load"));
    frame.children[1].dispatchEvent(new Event("load"));
    await flush();
    assert.equal(lookups, 3);
    sockets[2].close(); // The first connection failed before opening.
    const earlyRetry = [...timers.entries()].find(([, value]) => value.delay === 500);
    assert.ok(earlyRetry);
    timers.delete(earlyRetry[0]);
    earlyRetry[1].fn();
    sockets[3].open();
    await flush();
    assert.equal(lookups, 4, "recovery after an initial connection failure also rechecks");
    assert.deepEqual(sockets[3].sent.map((message) => message.type), ["session.observe"]);
    earlyFailure.dispose();
    assert.equal(timers.size, 0);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
});
