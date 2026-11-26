import { MicrophoneCapture } from "./microphone.js";

export class WakeError extends Error {
  constructor(code, message) { super(message); this.name = "WakeError"; this.code = code; }
}

// PCM goes only to the local wake endpoint. Capture owns the shared audio device.
export class WakeClient {
  constructor({ onWake, onError, onTranscript = () => {}, onASRUnavailable = onError } = {}) {
    if (![onWake, onError, onTranscript, onASRUnavailable].every((callback) => typeof callback === "function")) {
      throw new TypeError("Wake callbacks are required");
    }
    this.onWake = onWake;
    this.onError = onError;
    this.onTranscript = onTranscript;
    this.onASRUnavailable = onASRUnavailable;
    this.generation = 0;
    this.pending = null;
    this.socket = null;
    this.microphone = null;
    this.cancelReady = null;
    this.ready = false;
    this.running = false;
    this.asrAvailable = null;
    this.cycle = null;
    this.standbyTimeout = null;
  }

  start() {
    if (this.running) return Promise.resolve(true);
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    const pending = this.startWake(generation).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  get audioContext() {
    return this.microphone?.audioContext ?? null;
  }

  async startWake(generation) {
    let reported = false;
    const fail = (error) => {
      if (generation !== this.generation || reported) return;
      reported = true;
      try { this.onError(error); } finally { void this.stop().catch(() => {}); }
    };
    try {
      const mic = new MicrophoneCapture({
        onError: fail,
        onFrame: (frame) => {
          const ws = this.socket;
          if (!this.ready || !ws || ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > 32000) {
            fail(new WakeError("audio_backpressure", "麦克风处理跟不上，语音唤醒已停止。"));
            return;
          }
          const bytes = new ArrayBuffer(frame.length * 2);
          const data = new DataView(bytes);
          for (let i = 0; i < frame.length; i += 1) data.setInt16(i * 2, frame[i], true);
          try { ws.send(bytes); } catch { fail(new WakeError("connection_failed", "语音唤醒连接中断。")); }
        },
      });
      this.microphone = mic;
      if (!await mic.start() || generation !== this.generation) return false;
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/wake`);
      this.socket = ws;
      await new Promise((resolve, reject) => {
        let waiting = true;
        let streamId = null;
        let lastWake = 0;
        const finish = (error) => {
          if (!waiting) return;
          waiting = false;
          clearTimeout(timeout);
          this.cancelReady = null;
          if (error) reject(error); else resolve();
        };
        const timeout = setTimeout(() => finish(new WakeError("timeout", "语音唤醒启动超时。")), 30000);
        this.cancelReady = () => finish(new WakeError("cancelled", "语音唤醒已停止。"));
        ws.onmessage = (event) => {
          if (generation !== this.generation) return;
          let message;
          try { message = JSON.parse(event.data); } catch {
            const error = new WakeError("invalid_response", "语音唤醒返回了无效消息。");
            if (waiting) finish(error); else fail(error);
            return;
          }
          if (message.type === "ready" && waiting && message.sample_rate === 16000 && message.frame_bytes === 640) {
            streamId = typeof message.stream_id === "string" ? message.stream_id : null;
            if (message.asr_available === true && !streamId) {
              finish(new WakeError("invalid_response", "语音识别连接信息无效。"));
              return;
            }
            this.asrAvailable = message.asr_available === true;
            finish();
          } else if (message.type === "error") {
            const error = new WakeError(message.code || "wake_failed", message.message || "语音唤醒暂时不可用。");
            if (waiting) finish(error); else fail(error);
          } else if (message.type === "asr.unavailable") {
            this.asrAvailable = false;
            this.cycle = null;
            this.onASRUnavailable(new WakeError(message.code || "asr_unavailable", message.message || "语音识别暂不可用。"));
          } else if (message.type === "wake.standby" && message.stream_id === streamId && message.generation === lastWake) {
            clearTimeout(this.standbyTimeout);
            this.standbyTimeout = null;
          } else if (message.type === "wake.detected" && this.running) {
            if (this.asrAvailable) {
              if (message.stream_id !== streamId || !streamId || !Number.isSafeInteger(message.generation)
                  || message.generation <= lastWake || this.standbyTimeout !== null) return;
              lastWake = message.generation;
              this.cycle = { stream_id: streamId, generation: lastWake };
            }
            this.onWake();
          } else if (["asr.partial", "asr.final", "asr.endpoint"].includes(message.type) && this.running) {
            if (!this.asrAvailable || !this.cycle || message.stream_id !== this.cycle.stream_id
                || message.generation !== this.cycle.generation) return;
            if (!Number.isSafeInteger(message.segment) || message.segment < 1
                || (message.type !== "asr.endpoint" && typeof message.text !== "string")) {
              fail(new WakeError("invalid_response", "语音识别返回了无效消息。"));
              return;
            }
            this.onTranscript(message);
          }
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
          const error = new WakeError("connection_failed", "语音唤醒连接中断。");
          if (waiting) finish(error); else fail(error);
        };
      });
      if (generation !== this.generation) return false;
      this.ready = true;
      this.running = true;
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      try { if (!reported) this.onError(error); } finally { await this.stop(); }
      throw error;
    }
  }

  rearm() {
    const cycle = this.cycle;
    if (!cycle || !this.running) return false;
    this.cycle = null; // Drop even late ASR events already in flight.
    const ws = this.socket;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ type: "wake.rearm", version: 1, ...cycle }));
      this.standbyTimeout = setTimeout(() => ws.close(), 5000);
      return true;
    } catch {
      ws.close();
      return false;
    }
  }

  async stop() {
    ++this.generation;
    this.running = false;
    this.ready = false;
    this.asrAvailable = null;
    this.cycle = null;
    clearTimeout(this.standbyTimeout);
    this.standbyTimeout = null;
    this.pending = null;
    this.cancelReady?.();
    const ws = this.socket;
    this.socket = null;
    if (ws) ws.close();
    const mic = this.microphone;
    this.microphone = null;
    if (mic) await mic.stop();
  }
}
