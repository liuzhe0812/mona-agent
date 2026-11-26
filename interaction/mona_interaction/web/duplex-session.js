// Coordinates confirmed voice events with actual playback. It does not make
// echo or speaker-identity decisions and never retries an uncertain request.
export class DuplexSession {
  constructor({ player, timeline, onInput, onPartial = () => {}, maxQueued = 8 } = {}) {
    if (!player || !timeline || typeof onInput !== 'function' || typeof onPartial !== 'function'
        || !Number.isInteger(maxQueued) || maxQueued < 1) throw new TypeError('Invalid duplex session');
    this.player = player;
    this.timeline = timeline;
    this.onInput = onInput;
    this.onPartial = onPartial;
    this.maxQueued = maxQueued;
    this.awake = false;
    this.closed = false;
    this.turn = null;
    this.unknown = false;
    this.playback = null;
    this.queue = [];
    this.ids = new Set();
  }

  wake() {
    if (this.closed || this.awake) return false;
    this.awake = true;
    return true;
  }

  // The adapter supplies this only after a reliable speech/echo decision.
  speechStarted({ confirmed = false } = {}) {
    if (this.closed || !this.awake || confirmed !== true) return false;
    if (this.playback) this.interrupt();
    return true;
  }

  partial(text) {
    if (this.closed || !this.awake || typeof text !== 'string') return false;
    this.onPartial(text);
    return true;
  }

  final({ messageId, text, confirmed = false } = {}) {
    if (typeof messageId !== 'string' || !messageId.trim() || typeof text !== 'string' || !text.trim()) {
      throw new TypeError('Invalid recognized utterance');
    }
    if (this.closed || !this.awake || confirmed !== true || this.ids.has(messageId)) return false;
    if (this.queue.length >= this.maxQueued) throw new RangeError('Voice input queue is full');
    // Stop the old audio before accepting the new utterance; on failure the
    // caller keeps the recognized text and can report the uncertain state.
    if (this.playback) this.interrupt();
    this.ids.add(messageId);
    this.queue.push({ messageId, text });
    if (this.ids.size > 256) {
      const protectedIds = new Set([this.turn, ...this.queue.map((item) => item.messageId)]);
      for (const id of this.ids) {
        if (!protectedIds.has(id)) { this.ids.delete(id); break; }
      }
    }
    this.dispatchNext();
    return true;
  }

  dispatchNext() {
    if (this.closed || this.turn || this.unknown || !this.queue.length) return;
    const item = this.queue.shift();
    this.turn = item.messageId;
    // A throwing callback may have already dispatched; retain the turn and
    // require explicit reconciliation rather than attempting it again.
    try { this.onInput(item); } catch (error) { this.unknown = true; throw error; }
  }

  turnEnded(messageId, { unknown = false } = {}) {
    if (messageId !== this.turn || typeof unknown !== 'boolean') return false;
    if (unknown) { this.unknown = true; return true; }
    this.turn = null;
    this.unknown = false;
    this.dispatchNext();
    return true;
  }

  acknowledgeUnknown(messageId) {
    if (!this.unknown || this.turn !== messageId) return false;
    this.turn = null;
    this.unknown = false;
    this.dispatchNext();
    return true;
  }

  beginPlayback({ utteranceId, visemes = [] } = {}) {
    if (this.closed || !this.awake || this.playback) return null;
    const audio = this.player.begin({ utteranceId });
    try {
      const mouth = this.timeline.begin({ utteranceId, visemes });
      const token = Object.freeze({});
      this.playback = { token, audio, mouth };
      return token;
    } catch (error) {
      this.player.interrupt(audio);
      throw error;
    }
  }

  enqueueAudio(token, chunk) {
    return this.playback?.token === token ? this.player.enqueue(this.playback.audio, chunk) : { status: 'stale' };
  }

  finishAudio(token) {
    return this.playback?.token === token && this.player.finish(this.playback.audio);
  }

  sampleMouth(token) {
    if (this.playback?.token !== token) return { mouthOpen: 0, mouthForm: 0 };
    const time = this.player.position(this.playback.audio);
    return time === null ? { mouthOpen: 0, mouthForm: 0 } : this.timeline.sample(this.playback.mouth, time);
  }

  playbackEnded(token) {
    if (this.playback?.token !== token) return false;
    this.timeline.interrupt(this.playback.mouth);
    this.playback = null;
    return true;
  }

  interrupt() {
    if (!this.playback) return false;
    const current = this.playback;
    // Never accept more audio if stopping fails; caller must surface the error.
    this.player.interrupt(current.audio);
    this.timeline.interrupt(current.mouth);
    this.playback = null;
    return true;
  }

  close() {
    if (this.closed) return false;
    this.closed = true;
    try { if (this.playback) this.interrupt(); } finally { this.queue.length = 0; }
    return true;
  }
}
