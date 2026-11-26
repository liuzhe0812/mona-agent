import assert from "node:assert/strict";
import test from "node:test";
import { mountOfficeVoice } from "../mona_interaction/web/office-voice.js";

class Element extends EventTarget {
  constructor() { super(); this.textContent = ""; this.value = ""; this.disabled = false; this.hidden = false; }
  click() { this.dispatchEvent(new Event("click")); }
}

function environment({ initiallyMuted = true } = {}) {
  const names = ["window", "WebSocket", "location", "speechSynthesis", "SpeechSynthesisUtterance", "AudioContext"];
  const saved = Object.fromEntries(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const sockets = [], utterances = [], wakeClients = [], poseEvents = [], timers = new Map();
  let timerId = 0, cancelled = 0;
  globalThis.location = { protocol: "http:", host: "localhost:17880" };
  globalThis.speechSynthesis = {
    getVoices: () => [{ lang: "zh-CN" }],
    speak: (utterance) => utterances.push(utterance),
    cancel: () => { cancelled += 1; },
  };
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.AudioContext = class { constructor() { this.state = "running"; } close() { this.state = "closed"; } };
  let failStop = false;
  class Player {
    constructor(callbacks) { this.callbacks = callbacks; }
    begin() { return {}; }
    enqueue() { this.callbacks.onStart(); return {status: "queued"}; }
    finish(token) { this.callbacks.onEnd(token, "completed"); }
    interrupt(token) { if (failStop) throw new Error("cannot stop"); cancelled += 1; this.callbacks.onEnd(token, "interrupted"); }
    dispose() {}
  }
  const preferences = new Map(initiallyMuted ? [["mona-office-microphone-muted", "1"]] : []);
  globalThis.window = Object.assign(new EventTarget(), {
    localStorage: { getItem: (key) => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) },
    AudioContext: globalThis.AudioContext,
    speechSynthesis: globalThis.speechSynthesis, SpeechSynthesisUtterance: globalThis.SpeechSynthesisUtterance,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(value) { this.sent.push(JSON.parse(value)); }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; if (!this.url.endsWith("/tts")) this.onclose?.(); }
  };
  class Wake {
    constructor(handlers) { this.handlers = handlers; this.asrAvailable = true; this.audioContext = new AudioContext(); wakeClients.push(this); }
    async start() { return true; }
    rearm() { this.rearmed = true; return true; }
    async stop() { this.stopped = true; }
  }
  const ui = Object.fromEntries(["toggle", "stopSpeech", "status", "mode", "details", "partial", "text", "send", "review", "reply"]
    .map((name) => [name, new Element()]));
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  const poses = {
    listeningStarted(id) { poseEvents.push("listen"); return { id }; },
    listeningEnded() { poseEvents.push("stop-listening"); },
    playbackStarted(id) { poseEvents.push("play"); return { id }; },
    playbackEnded() { poseEvents.push("stop-playing"); },
  };
  const event = (type, payload, id = "one") => ({ version: 1, type, session_id: "s", message_id: id, payload });
  return {
    ui, storage, data, Wake, Player, sockets, utterances, wakeClients, poses, poseEvents, event, timers,
    startAudio() { const socket = sockets.findLast((s) => s.url.endsWith("/tts")); socket.open(); socket.onmessage({data: new Uint8Array([0, 0]).buffer}); return socket; },
    set failStop(value) { failStop = value; },
    get cancelled() { return cancelled; },
    restore() {
      for (const [name, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
      }
    },
  };
}

test("a live office listens without a click, remembers explicit mute after reopening, and uses its capture device for playback", async () => {
  const env = environment({ initiallyMuted: false });
  const mount = () => mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s",
    Wake: env.Wake, Player: env.Player, storage: env.storage });
  const ready = (ws) => ws.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
  try {
    const first = mount();
    const ws = env.sockets[0]; ws.open();
    assert.equal(env.wakeClients.length, 0);
    ready(ws); ready(ws); await Promise.resolve();
    assert.equal(env.wakeClients.length, 1);
    assert.match(env.ui.status.textContent, /Hey Mona/);
    env.wakeClients[0].handlers.onWake();
    ws.receive(env.event("reply.completed", { text: "我在。" }));
    env.startAudio();
    assert.ok(env.poseEvents.includes("play"));
    env.ui.toggle.click(); await Promise.resolve();
    assert.equal(env.wakeClients[0].stopped, true);
    first.dispose();
    const next = mount();
    const secondWs = env.sockets.at(-1); secondWs.open(); ready(secondWs);
    assert.equal(env.wakeClients.length, 1);
    assert.equal(env.ui.toggle.textContent, "取消静音");
    env.ui.toggle.click(); await Promise.resolve();
    assert.equal(env.wakeClients.length, 2);
    assert.match(env.ui.status.textContent, /Hey Mona/);
    next.dispose();
  } finally { env.restore(); }
});

test("permission denial during automatic start is actionable and never requested again on a repeated snapshot", async () => {
  const env = environment({ initiallyMuted: false });
  const notices = [];
  class Denied extends env.Wake {
    async start() { throw Object.assign(new Error("请允许麦克风。"), { code: "permission_denied" }); }
  }
  try {
    const c = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s",
      Wake: Denied, storage: env.storage, showNotice: (...args) => notices.push(args) });
    const ws = env.sockets[0]; ws.open();
    const snapshot = env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] });
    ws.receive(snapshot); await Promise.resolve(); ws.receive(snapshot);
    assert.equal(env.wakeClients.length, 1);
    assert.equal(notices.length, 1);
    assert.equal(env.ui.toggle.textContent, "重试麦克风");
    assert.equal(env.ui.details.hidden, false);
    c.dispose();
  } finally { env.restore(); }
});

test("a completed identified utterance sends once when the session is ready", async () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.toggle.click(); await Promise.resolve();
    const wake = env.wakeClients[0]; wake.handlers.onWake();
    const result = { type: "asr.final", text: "你好", stream_id: "a", generation: 1, segment: 1 };
    wake.handlers.onTranscript(result); wake.handlers.onTranscript(result);
    assert.equal(env.sockets.length, 2);
    const writer = env.sockets[1]; writer.open();
    assert.equal(writer.sent.length, 1);
    assert.equal(writer.sent[0].payload.text, "你好");
    assert.equal(env.ui.details.open, false);
    controller.dispose();
  } finally { env.restore(); }
});

test("speech overlapping playback interrupts but remains a draft", async () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.toggle.click(); await Promise.resolve();
    const wake = env.wakeClients[0]; wake.handlers.onWake();
    observer.receive(env.event("reply.completed", { text: "欢迎回来" }, "previous"));
    env.startAudio();
    wake.handlers.onTranscript({ type: "asr.partial", text: "换一件事" });
    assert.equal(env.cancelled, 1);
    wake.handlers.onTranscript({ type: "asr.final", text: "换一件事", stream_id: "a", generation: 1, segment: 1 });
    assert.equal(env.ui.text.value, "换一件事");
    assert.equal(env.ui.details.open, true);
    assert.equal(env.sockets.length, 2); // Observer and TTS only; no task sent.
    assert.match(env.ui.status.textContent, /核对/);
    controller.dispose();
  } finally { env.restore(); }
});

test("speech remains an editable draft until explicit confirmation; busy speech is preserved", async () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    assert.equal(observer.sent[0].type, "session.observe");
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.toggle.click();
    await Promise.resolve();
    const wake = env.wakeClients[0];
    wake.handlers.onWake();
    assert.deepEqual(env.poseEvents, ["listen"]);
    wake.handlers.onTranscript({ type: "asr.partial", text: "你好" });
    assert.match(env.ui.partial.textContent, /你好/);
    wake.handlers.onTranscript({ type: "asr.final", text: "你好" });
    assert.equal(env.ui.text.value, "你好");
    assert.equal(env.sockets.length, 1);
    env.ui.text.value = "你好，Mona";
    env.ui.send.click();
    const writer = env.sockets[1]; writer.open();
    assert.equal(writer.sent.length, 1);
    assert.equal(writer.sent[0].type, "input.text");
    assert.equal(writer.sent[0].payload.text, "你好，Mona");
    const id = writer.sent[0].message_id;
    observer.receive(env.event("input.accepted", { text: "你好，Mona" }, id));
    wake.handlers.onTranscript({ type: "asr.final", text: "下一句话" });
    assert.equal(env.ui.text.value, "下一句话");
    assert.equal(env.ui.send.disabled, true);
    assert.match(env.ui.status.textContent, /保留/);
    observer.receive(env.event("reply.completed", { text: "真实回复" }, id));
    const audio = env.startAudio();
    assert.equal(audio.sent[0].text, "真实回复");
    wake.handlers.onTranscript({ type: "asr.partial", text: "可能的插话" });
    assert.equal(env.cancelled, 1);
    assert.equal(writer.sent.length, 1);
    env.ui.stopSpeech.click();
    assert.equal(env.cancelled, 1);
    assert.deepEqual(env.poseEvents, ["listen", "stop-listening", "play", "stop-playing", "listen"]);
    assert.equal(env.ui.send.disabled, true); // stopping speech does not cancel the task
    observer.receive(env.event("turn.state", { state: "idle" }, id));
    assert.equal(env.ui.send.disabled, false);
    assert.equal(env.ui.text.value, "下一句话");
    controller.dispose();
  } finally { env.restore(); }
});

test("closing voice stops active speech even if the microphone fails to stop", async () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.toggle.click(); await Promise.resolve();
    const wake = env.wakeClients[0]; wake.handlers.onWake();
    env.ui.text.value = "继续处理";
    env.ui.send.click();
    const writer = env.sockets[1]; writer.open();
    const id = writer.sent[0].message_id;
    observer.receive(env.event("input.accepted", { text: "继续处理" }, id));
    observer.receive(env.event("reply.completed", { text: "正在朗读" }, id));
    const audio = env.startAudio();
    wake.stop = async () => { throw new Error("device stop failed"); };

    env.ui.toggle.click();
    assert.equal(env.cancelled, 1); // Stop playback before waiting for the microphone.
    assert.equal(env.poseEvents.filter((event) => event === "stop-playing").length, 1);
    assert.equal(env.ui.stopSpeech.disabled, true);
    assert.equal(writer.readyState, WebSocket.OPEN);
    assert.equal(writer.sent.length, 1); // Closing voice does not cancel or resend the task.
    assert.equal(env.ui.text.disabled, true); // The task still owns its original turn.

    await Promise.resolve(); await Promise.resolve();
    assert.match(env.ui.status.textContent, /麦克风未能正常关闭/);
    assert.equal(env.ui.toggle.textContent, "取消静音");
    assert.equal(env.ui.reply.textContent, "正在朗读");
    audio.onmessage({data: JSON.stringify({type: "end"})}); // Late completion is ignored.
    assert.equal(env.poseEvents.filter((event) => event === "stop-playing").length, 1);
    observer.receive(env.event("turn.state", { state: "idle" }, id));
    assert.equal(writer.sent.length, 1);
    assert.equal(env.ui.text.disabled, false);
    controller.dispose();
  } finally { env.restore(); }
});

test("a playback stop failure still closes the microphone and preserves the active task", async () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.toggle.click(); await Promise.resolve();
    const wake = env.wakeClients[0]; wake.handlers.onWake();
    env.ui.text.value = "正在执行的任务";
    env.ui.send.click();
    const writer = env.sockets[1]; writer.open();
    const id = writer.sent[0].message_id;
    observer.receive(env.event("input.accepted", {}, id));
    observer.receive(env.event("reply.completed", { text: "正在朗读" }, id));
    const audio = env.startAudio();
    env.failStop = true;
    env.ui.toggle.click(); await Promise.resolve(); await Promise.resolve();
    assert.equal(wake.stopped, true);
    assert.match(env.ui.status.textContent, /输入已关闭.*朗读未能停止/);
    assert.equal(env.ui.stopSpeech.disabled, false);
    assert.equal(env.poseEvents.filter((event) => event === "stop-playing").length, 0);
    assert.equal(writer.readyState, WebSocket.OPEN);
    assert.equal(writer.sent.length, 1);
    env.failStop = false;
    env.ui.stopSpeech.click();
    assert.equal(env.cancelled, 1);
    assert.equal(env.poseEvents.filter((event) => event === "stop-playing").length, 1);
    audio.onmessage({data: JSON.stringify({type: "end"})});
    assert.equal(env.poseEvents.filter((event) => event === "stop-playing").length, 1);
    controller.dispose();
  } finally { env.restore(); }
});

test("unknown send results are held for user review and are never resent on reconnect", async () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.toggle.click(); await Promise.resolve();
    const wake = env.wakeClients[0]; wake.handlers.onWake();
    wake.handlers.onTranscript({ type: "asr.final", text: "需要核对的请求" });
    env.ui.send.click();
    const writer = env.sockets[1]; writer.open();
    assert.equal(writer.sent.length, 1);
    writer.close();
    assert.equal(env.ui.review.hidden, false);
    assert.equal(env.ui.send.disabled, true);
    assert.equal(env.ui.text.value, "需要核对的请求");
    observer.receive(env.event("error", { code: "connection_failed" }, writer.sent[0].message_id));
    assert.equal(env.ui.review.hidden, false);
    assert.equal(env.ui.send.disabled, true);
    assert.match(env.ui.status.textContent, /核对/);
    observer.close();
    const retry = [...env.timers.values()].find((item) => item.delay === 500);
    assert.ok(retry);
    retry.fn();
    const reconnected = env.sockets[2]; reconnected.open();
    reconnected.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    assert.deepEqual(reconnected.sent.map((item) => item.type), ["session.observe"]);
    assert.equal(env.ui.send.disabled, true);
    assert.equal(env.ui.text.value, "需要核对的请求");
    controller.dispose();
  } finally { env.restore(); }
});

test("explicit review resolves the exact unknown request only after the server acknowledges it", () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null,
      records: [{ message_id: "old", text: "整理文档", state: "unknown" }] }));
    env.ui.text.value = "保留的新草稿";
    assert.equal(env.ui.review.hidden, false);
    assert.match(env.ui.status.textContent, /整理文档/);
    env.ui.review.click();
    const resolver = env.sockets[1];
    env.ui.review.click();
    assert.equal(env.sockets.length, 2);
    assert.equal(env.ui.send.disabled, true);
    resolver.open();
    assert.equal(resolver.sent.length, 1);
    assert.equal(resolver.sent[0].type, "input.resolve");
    assert.equal(resolver.sent[0].session_id, "s");
    assert.deepEqual(resolver.sent[0].payload, { message_id: "old", acknowledged: true });
    assert.equal(env.ui.review.hidden, false); // Sending is not an acknowledgement.
    resolver.receive({ version: 1, type: "session.snapshot", session_id: "other", payload: { records: [
      { message_id: "old", state: "closed_unknown" },
    ] } });
    assert.equal(env.ui.review.hidden, false);
    resolver.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null,
      records: [{ message_id: "old", state: "closed_unknown" }] }));
    assert.equal(env.ui.review.hidden, true);
    assert.equal(env.ui.send.disabled, true); // Wait for the read-only session refresh.
    assert.equal(env.ui.text.value, "保留的新草稿");
    assert.match(env.ui.status.textContent, /原结果仍未确认/);
    assert.deepEqual(observer.sent.map((message) => message.type), ["session.observe", "session.observe"]);
    assert.deepEqual(resolver.sent.map((message) => message.type), ["input.resolve"]);
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null,
      records: [{ message_id: "old", state: "closed_unknown" }] }));
    assert.equal(env.ui.send.disabled, false);
    controller.dispose();
  } finally { env.restore(); }
});

test("lost review acknowledgement is not retried or treated as a confirmed result", () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    const unknown = { mode: "mona", state: "idle", pending_id: null,
      records: [{ message_id: "old", text: "整理文档", state: "unknown" }] };
    observer.receive(env.event("session.snapshot", unknown));
    env.ui.text.value = "新草稿";
    env.ui.review.click();
    const resolver = env.sockets[1]; resolver.open();
    resolver.close();
    assert.equal(env.ui.review.hidden, false);
    assert.equal(env.ui.send.disabled, true);
    assert.match(env.ui.status.textContent, /尚未确认/);
    assert.deepEqual(resolver.sent.map((message) => message.type), ["input.resolve"]);
    assert.deepEqual(observer.sent.map((message) => message.type), ["session.observe", "session.observe"]);
    observer.receive(env.event("session.snapshot", unknown));
    assert.equal(env.ui.review.hidden, false);
    assert.equal(env.ui.send.disabled, true);
    assert.equal(env.ui.text.value, "新草稿");
    assert.equal(env.sockets.length, 2); // No automatic acknowledgement retry.
    controller.dispose();
  } finally { env.restore(); }
});

test("each uncertain request must be acknowledged separately", () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null,
      records: [{ message_id: "a", text: "任务一", state: "unknown" }, { message_id: "b", text: "任务二", state: "unknown" }] }));
    assert.match(env.ui.status.textContent, /任务一/);
    env.ui.review.click();
    const first = env.sockets[1]; first.open();
    assert.equal(first.sent[0].payload.message_id, "a");
    first.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null,
      records: [{ message_id: "a", state: "closed_unknown" }, { message_id: "b", text: "任务二", state: "unknown" }] }));
    assert.equal(env.ui.review.hidden, false);
    assert.equal(env.ui.send.disabled, true);
    assert.match(env.ui.status.textContent, /任务二/);
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null,
      records: [{ message_id: "a", state: "closed_unknown" }, { message_id: "b", text: "任务二", state: "unknown" }] }));
    env.ui.review.click();
    const second = env.sockets[2]; second.open();
    assert.equal(second.sent[0].payload.message_id, "b");
    assert.deepEqual(first.sent.map((message) => message.type), ["input.resolve"]);
    assert.deepEqual(second.sent.map((message) => message.type), ["input.resolve"]);
    controller.dispose();
  } finally { env.restore(); }
});

test("an unknown request without a valid identifier cannot be guessed or cleared", () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null,
      records: [{ text: "无法定位的操作", state: "unknown" }] }));
    env.ui.text.value = "新草稿";
    env.ui.review.click();
    assert.equal(env.sockets.length, 1);
    assert.equal(env.ui.review.hidden, false);
    assert.equal(env.ui.send.disabled, true);
    assert.match(env.ui.status.textContent, /无法确定/);
    controller.dispose();
  } finally { env.restore(); }
});

test("a manually edited draft cannot consume a later recognized sentence", async () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.toggle.click(); await Promise.resolve();
    const wake = env.wakeClients[0]; wake.handlers.onWake();
    env.ui.text.value = "手工修改的内容";
    wake.handlers.onTranscript({ type: "asr.final", text: "新识别内容" });
    assert.equal(env.ui.text.value, "手工修改的内容");
    env.ui.send.click();
    const writer = env.sockets[1]; writer.open();
    const id = writer.sent[0].message_id;
    observer.receive(env.event("input.accepted", {}, id));
    assert.equal(env.ui.text.value, "新识别内容");
    assert.equal(env.ui.send.disabled, true);
    controller.dispose();
  } finally { env.restore(); }
});

test("missing recognition resources remain visible without pretending transcription works", async () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.toggle.click();
    const wake = env.wakeClients[0];
    wake.asrAvailable = false;
    await Promise.resolve();
    assert.match(env.ui.status.textContent, /识别暂不可用/);
    wake.handlers.onWake();
    assert.deepEqual(env.poseEvents, []);
    assert.match(env.ui.status.textContent, /识别暂不可用/);
    wake.handlers.onASRUnavailable(new Error("语音识别资源尚未配置。"));
    assert.match(env.ui.status.textContent, /资源尚未配置/);
    assert.equal(env.ui.toggle.textContent, "静音");
    wake.handlers.onWake();
    wake.handlers.onTranscript({ type: "asr.final", text: "不应被接收" });
    assert.match(env.ui.status.textContent, /资源尚未配置/);
    assert.deepEqual(env.poseEvents, []);
    assert.equal(env.ui.text.value, "");
    env.ui.toggle.click(); await Promise.resolve();
    env.ui.toggle.click(); await Promise.resolve();
    const recovered = env.wakeClients[1];
    assert.equal(recovered.asrAvailable, true);
    recovered.handlers.onWake();
    assert.deepEqual(env.poseEvents, ["listen"]);
    assert.match(env.ui.status.textContent, /正在聆听/);
    recovered.asrAvailable = false;
    recovered.handlers.onASRUnavailable(new Error("语音识别中断。"));
    recovered.handlers.onWake();
    assert.deepEqual(env.poseEvents, ["listen", "stop-listening"]);
    assert.match(env.ui.status.textContent, /识别中断/);
    controller.dispose();
  } finally { env.restore(); }
});

test("a failed snapshot arriving before the error keeps the original draft", () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.text.value = "请处理";
    env.ui.send.click();
    const writer = env.sockets[1]; writer.open();
    const id = writer.sent[0].message_id;
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null,
      records: [{ message_id: id, state: "failed" }] }));
    assert.equal(env.ui.text.value, "请处理");
    assert.equal(env.ui.send.disabled, false);
    assert.equal(env.ui.review.hidden, true);
    assert.equal(writer.readyState, 3);
    observer.receive(env.event("error", { code: "connection_failed" }, id));
    assert.equal(writer.sent.length, 1);
    assert.equal(env.sockets.length, 2);
    controller.dispose();
  } finally { env.restore(); }
});

test("a failed reply is shown once and keeps its draft without starting playback", () => {
  const env = environment();
  try {
    const notices = [];
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s",
      Wake: env.Wake, Player: env.Player, storage: env.storage, showNotice: (...args) => notices.push(args) });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.text.value = "你好"; env.ui.send.click();
    const writer = env.sockets[1]; writer.open();
    const id = writer.sent[0].message_id;
    writer.receive(env.event("input.accepted", {}, id));
    writer.receive(env.event("error", { code: "reply_failed" }, id));
    observer.receive(env.event("error", { code: "reply_failed" }, id));
    assert.equal(notices.length, 1);
    assert.match(notices[0][1], /无法生成回复/);
    assert.equal(env.ui.reply.textContent, "");
    assert.equal(env.ui.text.value, "你好");
    assert.equal(env.sockets.length, 2);
    controller.dispose();
  } finally { env.restore(); }
});

test("explicit connection failure before acceptance keeps the draft without requiring review", () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.text.value = "请处理";
    env.ui.send.click();
    const writer = env.sockets[1]; writer.open();
    const id = writer.sent[0].message_id;
    writer.receive(env.event("error", { code: "connection_failed", message: "连接失败" }, id));
    assert.equal(writer.readyState, 3);
    assert.equal(env.data.size, 0);
    assert.equal(env.ui.text.value, "请处理");
    assert.equal(env.ui.send.disabled, false);
    assert.equal(env.ui.review.hidden, true);
    assert.match(env.ui.status.textContent, /连接失败|未完成/);
    assert.doesNotMatch(env.ui.status.textContent, /已接收/);
    observer.receive(env.event("turn.state", { state: "idle" }, id));
    assert.equal(writer.sent.length, 1);
    assert.equal(env.sockets.length, 2);
    controller.dispose();
  } finally { env.restore(); }
});

test("explicit failure after acceptance restores the original before later speech without replaying it", async () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.toggle.click(); await Promise.resolve();
    const wake = env.wakeClients[0]; wake.handlers.onWake();
    wake.handlers.onTranscript({ type: "asr.final", text: "第一句话" });
    env.ui.send.click();
    const writer = env.sockets[1]; writer.open();
    const id = writer.sent[0].message_id;
    // The writer can receive acceptance before the observer does.
    writer.receive(env.event("input.accepted", { text: "第一句话" }, id));
    wake.handlers.onTranscript({ type: "asr.final", text: "第二句话" });
    writer.receive(env.event("error", { code: "connection_failed", message: "连接失败" }, id));
    assert.equal(writer.readyState, 3);
    assert.equal(env.data.size, 0);
    assert.equal(env.ui.text.value, "第一句话");
    assert.equal(env.ui.send.disabled, false);
    assert.equal(env.ui.review.hidden, true);
    assert.match(env.ui.status.textContent, /已接收.*失败/);
    // Delayed copies of the old events cannot put the session back into working mode.
    observer.receive(env.event("input.accepted", {}, id));
    observer.receive(env.event("error", { code: "connection_failed" }, id));
    observer.receive(env.event("turn.state", { state: "idle" }, id));
    assert.equal(env.ui.send.disabled, false);
    assert.equal(writer.sent.length, 1);
    assert.equal(env.sockets.length, 2);
    env.ui.send.click();
    const retry = env.sockets[2]; retry.open();
    observer.receive(env.event("input.accepted", {}, retry.sent[0].message_id));
    assert.equal(env.ui.text.value, "第二句话");
    controller.dispose();
  } finally { env.restore(); }
});

test("quiet wake rearms without reopening the microphone or dispatching room sound", async () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.toggle.click(); await Promise.resolve();
    const wake = env.wakeClients[0];
    wake.handlers.onWake();
    const deadline = [...env.timers.values()].find((item) => item.delay === 8000);
    assert.ok(deadline);
    assert.deepEqual(env.poseEvents, ["listen"]);
    deadline.fn();
    assert.deepEqual(env.poseEvents, ["listen", "stop-listening"]);
    assert.notEqual(wake.stopped, true);
    assert.equal(wake.rearmed, true);

    wake.handlers.onTranscript({ type: "asr.final", text: "房间里的无关谈话", stream_id: "s", generation: 1, segment: 1 });
    assert.equal(env.ui.text.value, "");
    assert.equal(env.sockets.length, 1);
    wake.handlers.onWake();
    wake.handlers.onTranscript({ type: "asr.final", text: "Hey Mona!", stream_id: "s", generation: 2, segment: 1 });
    assert.equal(env.ui.text.value, "");
    wake.handlers.onTranscript({ type: "asr.partial", text: "你好" });
    deadline.fn(); // An already-fired callback cannot stop the new utterance.
    assert.deepEqual(env.poseEvents.slice(-1), ["listen"]);
    wake.handlers.onTranscript({ type: "asr.final", text: "你好" });
    assert.deepEqual(env.poseEvents.slice(-2), ["listen", "stop-listening"]);
    assert.equal(env.ui.text.value, "你好");
    assert.equal(env.sockets.length, 1); // Recognition never dispatches a task.

    wake.handlers.onTranscript({ type: "asr.partial", text: "继续" });
    wake.handlers.onTranscript({ type: "asr.endpoint" });
    assert.deepEqual(env.poseEvents.slice(-2), ["listen", "stop-listening"]);
    observer.receive(env.event("input.accepted", {}, "task"));
    observer.receive(env.event("turn.state", { state: "idle" }, "task"));
    assert.deepEqual(env.poseEvents.slice(-2), ["listen", "stop-listening"]);
    controller.dispose();
  } finally { env.restore(); }
});

test("a wake deadline cannot interrupt recognized speech or override task and playback", async () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.toggle.click(); await Promise.resolve();
    const wake = env.wakeClients[0];
    wake.handlers.onWake();
    const deadline = [...env.timers.values()].find((item) => item.delay === 8000);
    wake.handlers.onTranscript({ type: "asr.partial", text: "正在说话" });
    deadline.fn(); // A cleared wake deadline must not end real speech.
    observer.receive(env.event("input.accepted", {}, "task"));
    assert.deepEqual(env.poseEvents, ["listen"]);
    assert.equal([...env.timers.values()].some((t) => t.delay === 8000), false);
    observer.receive(env.event("reply.completed", { text: "回复" }, "task"));
    env.startAudio();
    wake.handlers.onTranscript({ type: "asr.endpoint" });
    observer.receive(env.event("turn.state", { state: "idle" }, "task"));
    assert.deepEqual(env.poseEvents, ["listen", "play", "stop-listening"]);
    assert.equal(env.cancelled, 0);
    assert.equal([...env.timers.values()].some((t) => t.delay === 8000), false);
    env.ui.stopSpeech.click();
    assert.deepEqual(env.poseEvents, ["listen", "play", "stop-listening", "stop-playing"]);
    const followup = [...env.timers.values()].find((t) => t.delay === 8000);
    assert.ok(followup);
    // Sherpa emits periodic empty endpoints during silence; none extends the window.
    wake.handlers.onTranscript({ type: "asr.endpoint" });
    followup.fn();
    assert.equal(wake.rearmed, true);
    controller.dispose();
  } finally { env.restore(); }
});

test("stale capture callbacks and deadlines cannot affect a restarted or disposed session", async () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "idle", pending_id: null, records: [] }));
    env.ui.toggle.click(); await Promise.resolve();
    const first = env.wakeClients[0];
    first.handlers.onWake();
    const staleDeadline = [...env.timers.values()].find((item) => item.delay === 8000);
    env.ui.toggle.click(); await Promise.resolve();
    assert.equal(first.stopped, true);
    env.ui.toggle.click(); await Promise.resolve();
    const second = env.wakeClients[1];
    second.handlers.onWake();
    const currentDeadline = [...env.timers.values()].find((item) => item.delay === 8000);
    const before = env.poseEvents.slice();
    staleDeadline.fn();
    first.handlers.onWake();
    first.handlers.onTranscript({ type: "asr.final", text: "旧内容" });
    first.handlers.onASRUnavailable(new Error("旧错误"));
    first.handlers.onError(new Error("旧错误"));
    assert.deepEqual(env.poseEvents, before);
    assert.equal(env.ui.text.value, "");
    assert.equal(env.ui.toggle.textContent, "静音");

    second.handlers.onError(new Error("麦克风中断"));
    assert.equal(env.poseEvents.at(-1), "stop-listening");
    const recovery = [...env.timers.values()].find((timer) => timer.delay === 1000);
    assert.ok(recovery);
    recovery.fn(); await Promise.resolve();
    const third = env.wakeClients[2];
    third.handlers.onWake();
    const afterRestart = env.poseEvents.slice();
    currentDeadline.fn();
    second.handlers.onError(new Error("过期错误"));
    second.handlers.onTranscript({ type: "asr.partial", text: "旧内容" });
    assert.deepEqual(env.poseEvents, afterRestart);
    assert.equal(env.ui.toggle.textContent, "静音");
    third.handlers.onTranscript({ type: "asr.final", text: "新内容" });
    assert.equal(env.ui.text.value, "新内容");
    controller.dispose();
    const afterDispose = env.poseEvents.slice();
    third.handlers.onWake();
    third.handlers.onTranscript({ type: "asr.partial", text: "过期内容" });
    assert.deepEqual(env.poseEvents, afterDispose);
  } finally { env.restore(); }
});

test("an observed pending task is rechecked until its terminal snapshot", () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    env.ui.text.value = "后续内容";
    observer.receive(env.event("session.snapshot", {
      mode: "mona", state: "thinking", pending_id: "existing", records: [{ message_id: "existing", state: "accepted" }],
    }));
    assert.equal(env.ui.send.disabled, true);
    const first = [...env.timers.entries()].find(([, timer]) => timer.delay === 5000);
    assert.ok(first);
    env.timers.delete(first[0]); first[1].fn();
    assert.deepEqual(observer.sent.map((message) => message.type), ["session.observe", "session.observe"]);
    observer.receive(env.event("session.snapshot", {
      mode: "mona", state: "thinking", pending_id: "existing", records: [{ message_id: "existing", state: "accepted" }],
    }));
    const next = [...env.timers.values()].find((timer) => timer.delay === 5000);
    assert.ok(next);
    observer.receive(env.event("session.snapshot", {
      mode: "mona", state: "idle", pending_id: null, records: [{ message_id: "existing", state: "completed" }],
    }));
    assert.equal(env.ui.send.disabled, false);
    assert.equal([...env.timers.values()].some((timer) => timer.delay === 5000), false);
    next.fn(); // A cancelled poll cannot issue another observation.
    assert.deepEqual(observer.sent.map((message) => message.type), ["session.observe", "session.observe"]);
    assert.equal(env.sockets.length, 1); // Recovery never sends input.
    controller.dispose();
  } finally { env.restore(); }
});

test("observation retries share one timer and cannot survive disconnect or disposal", () => {
  const env = environment();
  try {
    const controller = mountOfficeVoice({ ui: env.ui, poses: env.poses, sessionId: "s", Wake: env.Wake, Player: env.Player, storage: env.storage });
    const observer = env.sockets[0]; observer.open();
    observer.receive(env.event("session.snapshot", { mode: "mona", state: "thinking", pending_id: "existing", records: [] }));
    const oldPoll = [...env.timers.values()].find((timer) => timer.delay === 5000);
    observer.receive(env.event("error", { code: "sync_failed" }));
    assert.equal([...env.timers.values()].some((timer) => timer.delay === 5000), false);
    const retry = [...env.timers.values()].find((timer) => timer.delay === 3000);
    assert.ok(retry);
    observer.receive(env.event("turn.state", { state: "idle" }, "existing"));
    assert.equal([...env.timers.values()].includes(retry), true); // The failed sync still requires a retry.
    oldPoll.fn();
    assert.deepEqual(observer.sent.map((message) => message.type), ["session.observe"]);
    observer.close();
    assert.equal([...env.timers.values()].some((timer) => timer.delay === 3000), false);
    retry.fn();
    const reconnect = [...env.timers.entries()].find(([, timer]) => timer.delay === 500);
    assert.ok(reconnect);
    env.timers.delete(reconnect[0]); reconnect[1].fn();
    const restored = env.sockets[1]; restored.open();
    retry.fn(); // An old socket's callback must not send on the new socket.
    assert.deepEqual(restored.sent.map((message) => message.type), ["session.observe"]);
    restored.receive(env.event("session.snapshot", { mode: "mona", state: "thinking", pending_id: "existing", records: [] }));
    const terminalPoll = [...env.timers.values()].find((timer) => timer.delay === 5000);
    assert.ok(terminalPoll);
    restored.receive(env.event("turn.state", { state: "idle" }, "existing"));
    assert.equal([...env.timers.values()].some((timer) => timer.delay === 5000), false);
    terminalPoll.fn();
    assert.deepEqual(restored.sent.map((message) => message.type), ["session.observe"]);
    restored.receive(env.event("session.snapshot", { mode: "mona", state: "thinking", pending_id: "another", records: [] }));
    const pending = [...env.timers.values()].find((timer) => timer.delay === 5000);
    assert.ok(pending);
    controller.dispose();
    assert.equal([...env.timers.values()].some((timer) => timer.delay === 5000), false);
    pending.fn();
    assert.deepEqual(restored.sent.map((message) => message.type), ["session.observe"]);
  } finally { env.restore(); }
});
