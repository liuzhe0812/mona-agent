const FRAME_SAMPLES = 320;

export class MicrophoneError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MicrophoneError";
    this.code = code;
  }
}

function friendlyError(error) {
  if (error instanceof MicrophoneError) return error;
  if (["NotAllowedError", "SecurityError"].includes(error?.name)) {
    return new MicrophoneError("permission_denied", "请在此窗口的网站权限或系统设置中允许 Mona 使用麦克风，再点“重试麦克风”。");
  }
  if (["NotFoundError", "NotReadableError", "OverconstrainedError"].includes(error?.name)) {
    return new MicrophoneError("device_unavailable", "麦克风不可用，请检查设备连接和系统设置。");
  }
  return new MicrophoneError("capture_failed", "麦克风采集未能正常运行，请检查设备后重试。");
}

// Browser-only PCM capture. The consumer owns the frames; nothing is uploaded.
export class MicrophoneCapture {
  constructor({ onFrame, onError } = {}) {
    if (typeof onFrame !== "function" || typeof onError !== "function") {
      throw new TypeError("Microphone callbacks are required");
    }
    this.onFrame = onFrame;
    this.onError = onError;
    this.generation = 0;
    this.resources = null;
    this.pending = null;
    this.running = false;
  }

  get audioContext() {
    return this.running ? this.resources?.context : null;
  }

  start() {
    if (this.running) return Promise.resolve(true);
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    const pending = this.startCapture(generation).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  async startCapture(generation) {
    let resources = null;
    try {
      if (!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.AudioContext || !globalThis.AudioWorkletNode) {
        throw new MicrophoneError("unsupported", "当前环境不支持麦克风实时采集。");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true }, video: false,
      });
      if (generation !== this.generation) {
        for (const track of stream.getTracks()) track.stop();
        return false;
      }
      resources = { stream, context: null, source: null, node: null, gain: null, tracks: [], stateChanged: null };
      this.resources = resources;
      const context = new AudioContext();
      resources.context = context;
      await context.audioWorklet.addModule(new URL("./microphone-worklet.js", import.meta.url).href);
      if (generation !== this.generation) return false;
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "mona-microphone", { numberOfInputs: 1, numberOfOutputs: 1 });
      const gain = context.createGain();
      resources.source = source;
      resources.node = node;
      resources.gain = gain;
      gain.gain.value = 0;
      const fail = (error) => {
        if (generation !== this.generation) return;
        const reported = friendlyError(error);
        void this.stop().catch(() => {});
        this.onError(reported);
      };
      resources.stateChanged = () => {
        if (this.running && context.state !== "running") fail(new Error("Audio context interrupted"));
      };
      context.addEventListener("statechange", resources.stateChanged);
      node.port.onmessage = (event) => {
        if (generation !== this.generation || !this.running) return;
        if (!(event.data instanceof Int16Array) || event.data.length !== FRAME_SAMPLES) {
          fail(new Error("Invalid PCM frame"));
          return;
        }
        try { this.onFrame(event.data); } catch (error) { fail(error); }
      };
      node.onprocessorerror = () => fail(new Error("Audio processor failed"));
      node.port.onmessageerror = () => fail(new Error("Audio message failed"));
      for (const track of stream.getAudioTracks()) {
        const ended = () => fail(new MicrophoneError("device_unavailable", "麦克风连接已中断，请检查设备。"));
        track.addEventListener("ended", ended);
        resources.tracks.push({ track, ended });
      }
      if (!resources.tracks.length) throw new MicrophoneError("device_unavailable", "没有可用的麦克风。");
      source.connect(node);
      node.connect(gain);
      gain.connect(context.destination);
      // Chromium can resume Web Audio once microphone capture is active. If
      // the host still requires a gesture, release the track and allow retry.
      let timer;
      try {
        await Promise.race([context.resume(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new MicrophoneError("audio_blocked",
            "此窗口暂停了音频。请点“重试麦克风”恢复。")), 4000);
        })]);
      } finally { clearTimeout(timer); }
      if (generation !== this.generation) return false;
      if (context.state !== "running") throw new Error("Audio context did not start");
      this.running = true;
      return true;
    } catch (error) {
      if (resources && this.resources === resources) {
        this.resources = null;
        await this.release(resources);
      }
      if (generation !== this.generation) return false;
      const reported = friendlyError(error);
      this.onError(reported);
      throw reported;
    }
  }

  async stop() {
    ++this.generation;
    this.running = false;
    this.pending = null;
    const resources = this.resources;
    this.resources = null;
    if (resources) await this.release(resources);
  }

  async release(resources) {
    for (const { track, ended } of resources.tracks) track.removeEventListener("ended", ended);
    if (resources.context && resources.stateChanged) {
      resources.context.removeEventListener("statechange", resources.stateChanged);
    }
    if (resources.node) {
      resources.node.port.onmessage = null;
      resources.node.port.onmessageerror = null;
      resources.node.onprocessorerror = null;
    }
    for (const node of [resources.source, resources.node, resources.gain]) {
      try { node?.disconnect(); } catch { /* Continue releasing the microphone. */ }
    }
    for (const track of resources.stream.getTracks()) {
      try { track.stop(); } catch { /* Continue releasing other resources. */ }
    }
    if (resources.context && resources.context.state !== "closed") await resources.context.close();
  }
}
