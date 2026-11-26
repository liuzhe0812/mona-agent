// Streaming mono PCM playback. The caller owns and resumes the AudioContext.
// onStart means the first chunk entered the running audio graph; position()
// tracks output-device time where available. The Mona task is never controlled.
export class AudioPlaybackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AudioPlaybackError";
    this.code = code;
  }
}

const MAX_BUFFERED_SECONDS = 30;
const OUTPUT_CHECK_MS = 20;
const OUTPUT_TIMEOUT_MS = 5000;
const MOUTH_WINDOW = .02;

// Store a small loudness envelope next to the scheduled audio, so pauses and
// network buffering don't animate the lips before sound reaches the listener.
function mouthEnvelope(values, sampleRate) {
  const stride = Math.max(1, Math.round(sampleRate * MOUTH_WINDOW));
  const levels = new Float32Array(Math.ceil(values.length / stride));
  for (let block = 0; block < levels.length; block++) {
    const first = block * stride;
    const end = Math.min(first + stride, values.length);
    let energy = 0;
    for (let i = first; i < end; i++) energy += values[i] * values[i];
    const rms = Math.sqrt(energy / (end - first));
    levels[block] = Math.max(0, Math.min(1, (Math.sqrt(rms) - .09) * 2.8));
  }
  return { levels, step: stride / sampleRate };
}

export class AudioPlayback {
  constructor({ context, onStart = () => {}, onEnd = () => {}, onDrain = () => {}, onError } = {}) {
    if (!context || typeof context.createGain !== "function" || typeof context.createBuffer !== "function"
        || typeof context.createBufferSource !== "function" || !context.destination
        || ![onStart, onEnd, onDrain, onError].every((fn) => typeof fn === "function")) {
      throw new TypeError("Invalid audio playback configuration");
    }
    this.context = context;
    this.callbacks = { onStart, onEnd, onDrain, onError };
    this.current = null;
    this.generation = 0;
    this.disposed = false;
    this.stopFailed = false;
    this.onContextState = () => {
      const state = this.current;
      if (!state) return;
      if (context.state === "closed") {
        this.fail(state, new AudioPlaybackError("context_closed", "音频播放已中断。"));
      } else if (context.state === "running") {
        this.checkCompletion(state);
      } else {
        this.clearCompletionTimer(state);
        state.outputWaitStarted = null;
      }
    };
    context.addEventListener?.("statechange", this.onContextState);
  }

  begin({ utteranceId } = {}) {
    if (this.disposed || this.stopFailed) throw new AudioPlaybackError("unavailable", "音频播放暂不可用。");
    if (typeof utteranceId !== "string" || !utteranceId.trim()) throw new TypeError("Invalid utterance ID");
    if (this.context.state !== "running") {
      throw new AudioPlaybackError("context_not_running", "请先启用音频播放。");
    }
    if (this.generation >= Number.MAX_SAFE_INTEGER) throw new RangeError("Playback generation exhausted");
    if (this.current) this.interrupt(this.current.token);
    if (this.current) throw new AudioPlaybackError("busy", "上一段声音尚未停止。");
    const gain = this.context.createGain();
    try { gain.connect(this.context.destination); } catch (error) {
      try { gain.disconnect(); } catch {}
      throw error;
    }
    const token = Object.freeze({ utteranceId, generation: ++this.generation });
    this.current = {
      token, gain, sources: new Set(), segments: [], total: 0, nextStart: this.context.currentTime,
      position: 0, finished: false, started: false, timer: null, outputWaitStarted: null,
    };
    return token;
  }

  // Append in order. On backpressure the caller retains the chunk and retries
  // after onDrain; stale tokens can never enqueue into a replacement utterance.
  enqueue(token, { samples, sampleRate } = {}) {
    const state = this.current;
    if (!state || token !== state.token) return { status: "stale" };
    if (state.finished) throw new AudioPlaybackError("input_finished", "该段语音已结束接收。");
    if (this.context.state !== "running") throw new AudioPlaybackError("context_not_running", "音频播放已暂停。");
    if (!(samples instanceof Float32Array || samples instanceof Int16Array) || samples.length === 0
        || !Number.isInteger(sampleRate) || sampleRate < 3000 || sampleRate > 192000) {
      throw new TypeError("Invalid mono PCM chunk");
    }
    const duration = samples.length / sampleRate;
    if (duration > MAX_BUFFERED_SECONDS) throw new RangeError("Audio chunk exceeds playback capacity");
    if (Math.max(0, state.nextStart - this.context.currentTime) + duration > MAX_BUFFERED_SECONDS) {
      return { status: "backpressure" };
    }
    const values = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const value = samples instanceof Int16Array ? samples[i] / 32768 : samples[i];
      if (!Number.isFinite(value) || value < -1 || value > 1) throw new TypeError("Invalid PCM sample");
      values[i] = value;
    }
    const buffer = this.context.createBuffer(1, values.length, sampleRate);
    buffer.copyToChannel(values, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    try { source.connect(state.gain); } catch (error) {
      try { source.disconnect(); } catch {}
      throw error;
    }
    const start = Math.max(this.context.currentTime, state.nextStart);
    const segment = { start, end: start + duration, offset: state.total, duration,
      envelope: mouthEnvelope(values, sampleRate) };
    source.onended = () => {
      source.onended = null;
      try { source.disconnect(); } catch {}
      if (this.current !== state) return;
      state.sources.delete(source);
      this.position(state.token);
      if (!state.finished) {
        try { this.callbacks.onDrain(state.token); } catch {
          this.fail(state, new AudioPlaybackError("callback_failed", "声音播放中断，请重试。"));
          return;
        }
      }
      if (this.current === state) this.checkCompletion(state);
    };
    state.sources.add(source);
    try { source.start(start); } catch (error) {
      source.onended = null;
      state.sources.delete(source);
      try { source.disconnect(); } catch {}
      throw error;
    }
    state.segments.push(segment);
    state.total += duration;
    state.nextStart = segment.end;
    if (!state.started) {
      state.started = true;
      try { this.callbacks.onStart(state.token); } catch {
        const error = new AudioPlaybackError("callback_failed", "声音播放中断，请重试。");
        this.fail(state, error);
        throw error;
      }
    }
    return { status: "queued" };
  }

  // Seconds of actual audio rendered to the output, excluding buffer gaps.
  // getOutputTimestamp is preferred; browsers without it use the audio graph clock.
  position(token, now = this.outputTime()) {
    const state = this.current;
    if (!state || token !== state.token) return null;
    while (state.segments.length && now >= state.segments[0].end) {
      const segment = state.segments.shift();
      state.position = Math.max(state.position, segment.offset + segment.duration);
    }
    const segment = state.segments[0];
    if (segment && now > segment.start) {
      state.position = Math.max(state.position, segment.offset + Math.min(segment.duration, now - segment.start));
    }
    return Math.min(state.position, state.total);
  }

  mouthOpening(token) {
    const state = this.current;
    if (!state || state.token !== token || this.context.state !== "running") return 0;
    const now = this.outputTime();
    this.position(token, now);
    const segment = state.segments[0];
    if (!segment || now < segment.start) return 0;
    const { levels, step } = segment.envelope;
    const index = Math.min(levels.length - 1, Math.floor((now - segment.start) / step));
    return levels[index];
  }

  finish(token) {
    const state = this.current;
    if (!state || token !== state.token || state.finished) return false;
    state.finished = true;
    this.checkCompletion(state);
    return true;
  }

  interrupt(token) {
    const state = this.current;
    if (!state || token !== state.token) return false;
    this.current = null;
    const stopped = this.release(state);
    if (!stopped) {
      this.stopFailed = true;
      const error = new AudioPlaybackError("stop_failed", "声音未能停止，请检查音频设备。");
      this.callbacks.onError(error, state.token);
      throw error;
    }
    this.notifyEnd(state, "interrupted");
    return true;
  }

  outputTime() {
    const current = this.context.currentTime;
    try {
      const stamp = this.context.getOutputTimestamp?.();
      if (Number.isFinite(stamp?.contextTime) && stamp.contextTime >= 0
          && Number.isFinite(stamp.performanceTime) && stamp.performanceTime > 0
          && stamp.contextTime <= current) return stamp.contextTime;
    } catch {}
    return current;
  }

  clearCompletionTimer(state) {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
  }

  checkCompletion(state) {
    if (this.current !== state || !state.finished || state.sources.size) return;
    if (!state.started || this.outputTime() + 1e-6 >= state.nextStart) {
      this.current = null;
      this.release(state);
      this.notifyEnd(state, state.started ? "completed" : "empty");
      return;
    }
    if (this.context.state !== "running" || state.timer !== null) return;
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (state.outputWaitStarted === null) state.outputWaitStarted = now;
    if (now - state.outputWaitStarted >= OUTPUT_TIMEOUT_MS) {
      this.fail(state, new AudioPlaybackError("output_unconfirmed", "声音播放结果暂时无法确认。"));
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      this.checkCompletion(state);
    }, OUTPUT_CHECK_MS);
  }

  fail(state, error) {
    if (this.current !== state) return;
    this.current = null;
    if (!this.release(state)) this.stopFailed = true;
    this.callbacks.onError(error, state.token);
  }

  notifyEnd(state, reason) {
    try { this.callbacks.onEnd(state.token, reason); } catch {
      this.callbacks.onError(new AudioPlaybackError("callback_failed", "声音播放状态未能更新。"), state.token);
    }
  }

  release(state) {
    this.clearCompletionTimer(state);
    let muted = false;
    try { state.gain.gain.value = 0; muted = true; } catch {}
    try { state.gain.disconnect(); muted = true; } catch {}
    let sourcesStopped = true;
    for (const source of state.sources) {
      source.onended = null;
      let stopped = false;
      try { source.stop(); stopped = true; } catch {}
      try { source.disconnect(); stopped = true; } catch {}
      if (!stopped) sourcesStopped = false;
    }
    state.sources.clear();
    state.segments.length = 0;
    return muted || sourcesStopped;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { if (this.current) this.interrupt(this.current.token); }
    finally { this.context.removeEventListener?.("statechange", this.onContextState); }
  }
}
