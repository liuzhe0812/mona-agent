// Continuous, windowed-sinc resampling keeps time and filter state across
// AudioWorklet render quanta. It emits complete 20 ms PCM16 mono frames only.
export class Pcm16Resampler {
  constructor(inputRate, onFrame, { outputRate = 16000, frameSize = 320 } = {}) {
    if (!Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(outputRate) || outputRate <= 0
        || !Number.isInteger(frameSize) || frameSize <= 0 || typeof onFrame !== "function") {
      throw new TypeError("Invalid audio resampler configuration");
    }
    this.rate = inputRate;
    this.step = inputRate / outputRate;
    this.cutoff = 0.94 * Math.min(1, outputRate / inputRate);
    this.half = 24;
    this.buffer = [];
    this.base = 0;
    this.position = 0;
    this.frame = new Int16Array(frameSize);
    this.frameOffset = 0;
    this.onFrame = onFrame;
  }

  push(input) {
    for (const sample of input) this.buffer.push(Number.isFinite(sample) ? sample : 0);
    const available = this.base + this.buffer.length;
    while (this.position + this.half < available) {
      const center = this.position;
      const start = Math.floor(center) - this.half + 1;
      const end = Math.floor(center) + this.half;
      let sum = 0;
      let normalization = 0;
      for (let index = start; index <= end; index += 1) {
        const distance = index - center;
        const x = Math.PI * distance * this.cutoff;
        const sinc = Math.abs(x) < 1e-10 ? 1 : Math.sin(x) / x;
        const weight = this.cutoff * sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / this.half));
        const sample = index < 0 ? 0 : this.buffer[index - this.base];
        sum += sample * weight;
        normalization += weight;
      }
      const normalized = normalization ? sum / normalization : 0;
      const clipped = Math.max(-1, Math.min(1, normalized));
      this.frame[this.frameOffset++] = Math.round(clipped < 0 ? clipped * 32768 : clipped * 32767);
      if (this.frameOffset === this.frame.length) {
        const frame = this.frame;
        this.frame = new Int16Array(frame.length);
        this.frameOffset = 0;
        this.onFrame(frame);
      }
      this.position += this.step;
    }
    const discard = Math.max(0, Math.min(this.buffer.length, Math.floor(this.position) - this.half - this.base));
    if (discard) {
      this.buffer.splice(0, discard);
      this.base += discard;
    }
  }
}

if (typeof globalThis.registerProcessor === "function") {
  class MicrophoneProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.resampler = new Pcm16Resampler(sampleRate, (frame) => this.port.postMessage(frame, [frame.buffer]));
    }

    process(inputs) {
      const channels = inputs[0];
      if (!channels?.length || !channels[0]?.length) return true;
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels) {
        for (let i = 0; i < mono.length; i += 1) mono[i] += (channel[i] || 0) / channels.length;
      }
      this.resampler.push(mono);
      return true;
    }
  }
  registerProcessor("mona-microphone", MicrophoneProcessor);
}
